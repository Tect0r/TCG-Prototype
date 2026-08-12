import type {
  ConditionDefinition,
  CountQuery,
  SignedValueExpression,
  StatField,
  StatSubject,
  ValueExpression,
} from '@tcg/card-data';
import type { ReadContext } from './context.js';
import {
  clockwiseFrom,
  currentAttack,
  currentHealth,
  definitionOf,
  findInstance,
  isNewlyDeployed,
  matchesCardFilter,
  playerOf,
} from './derive.js';
import { combatRoleOf } from './targeting.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';
import type { TurnEventEntry } from './schema/state.js';

/**
 * Counting, conditions and computed values (ruleset update §15).
 *
 * One evaluator for all three, because they are the same question — *how many
 * things match?* — asked three ways. A condition compares the answer to a
 * number; a value scales it into an amount; a count is the answer itself.
 *
 * Everything here is a pure read of current state. Nothing is cached: a
 * condition is re-checked at the moment the thing it guards would happen, so a
 * trigger whose "if" stopped being true between queueing and resolution does
 * not fire.
 */

/** Who an ability's counting question is asked on behalf of. */
export interface CountScope {
  readonly controllerId: PlayerId;
  /** The card the ability is printed on, for `excludeSource`. */
  readonly sourceInstanceId: InstanceId | null;
  /**
   * The card a triggered ability fired about, for a value read from
   * `trigger_subject`.
   */
  readonly triggerSubjectInstanceId?: InstanceId | null;
  /**
   * The card the instruction is acting on *right now*, for a value read from
   * `effect_target` (M02.3).
   *
   * Supplied per recipient rather than per instruction: "each friendly Unit
   * gains Health equal to its ATK" reads a different statline for each unit, so
   * an instruction that resolves against three targets builds three scopes.
   */
  readonly targetInstanceId?: InstanceId | null;
  /**
   * Whether the instruction before this one changed the match, for "if you do".
   *
   * Absent when there is no preceding instruction to ask about — an
   * ability-level gate, or a condition evaluated outside a resolution item.
   */
  readonly previousStepActed?: boolean;
  /**
   * How many entities the instruction before this one resolved with, for a
   * `previous_targets` amount — "for each Unit sacrificed" (M02.5).
   *
   * Absent for the same reason `previousStepActed` is: outside a resolution item
   * there is no preceding instruction, and the card schema already refuses the
   * one authoring form that could ask here without one.
   */
  readonly previousTargetCount?: number;
}

/** Seats a `controller` relation covers, relative to the asking player. */
function seatsFor(ctx: ReadContext, query: CountQuery, scope: CountScope): PlayerId[] {
  switch (query.controller) {
    case 'self':
      return [scope.controllerId];
    case 'opponent':
      // Every opponent, living or not: a question about what happened this turn
      // must still be answerable after the seat that did it was eliminated.
      return ctx.state.seatOrder.filter((id) => id !== scope.controllerId);
    default:
      return [...ctx.state.seatOrder];
  }
}

/** Whether a card that is still in play satisfies the query. */
function instanceMatches(
  ctx: ReadContext,
  instanceId: InstanceId,
  query: CountQuery,
  scope: CountScope,
): boolean {
  if (query.excludeSource && instanceId === scope.sourceInstanceId) return false;
  const instance = findInstance(ctx.state, instanceId);
  if (!instance) return false;
  if (!query.filter) return true;
  return matchesCardFilter(
    definitionOf(ctx.database, instance),
    instance,
    query.filter,
    combatRoleOf(ctx, instanceId),
  );
}

/** Whether a card that has already left play satisfies the query. */
function entryMatches(ctx: ReadContext, entry: TurnEventEntry, query: CountQuery): boolean {
  if (!query.filter) return true;
  const definition = ctx.database.get(entry.definitionId);
  if (!definition) return false;
  // No instance: the card is gone, so `damaged`/`exhausted` predicates simply do
  // not apply rather than being guessed at.
  return matchesCardFilter(definition, null, query.filter);
}

function countTurnEntries(
  ctx: ReadContext,
  entries: readonly TurnEventEntry[],
  query: CountQuery,
  scope: CountScope,
): number {
  const seats = new Set(seatsFor(ctx, query, scope));
  return entries.filter((entry) => {
    if (!seats.has(entry.controller)) return false;
    if (query.excludeSource && entry.instanceId === scope.sourceInstanceId) return false;
    return entryMatches(ctx, entry, query);
  }).length;
}

/** Answers one counting question against the current state. */
export function evaluateCount(ctx: ReadContext, query: CountQuery, scope: CountScope): number {
  const { turnEvents, combat } = ctx.state;

  switch (query.subject) {
    case 'units': {
      let total = 0;
      for (const playerId of seatsFor(ctx, query, scope)) {
        for (const instanceId of playerOf(ctx.state, playerId).units) {
          if (instanceMatches(ctx, instanceId, query, scope)) total += 1;
        }
      }
      return total;
    }

    case 'cards_in_hand': {
      // Deliberately does not apply a card filter to another seat's hand: the
      // engine may know what is in it, but an ability that could read it would
      // leak hidden information into a number a player can see (CLAUDE.md §10).
      let total = 0;
      for (const playerId of seatsFor(ctx, query, scope)) {
        const hand = playerOf(ctx.state, playerId).hand;
        total +=
          playerId === scope.controllerId && query.filter
            ? hand.filter((id) => instanceMatches(ctx, id, query, scope)).length
            : hand.length;
      }
      return total;
    }

    case 'attacking_units': {
      const seats = new Set(seatsFor(ctx, query, scope));
      return combat.attacks.filter((attack) => {
        const instance = findInstance(ctx.state, attack.attackerInstanceId);
        if (!instance || !seats.has(instance.controller)) return false;
        return instanceMatches(ctx, attack.attackerInstanceId, query, scope);
      }).length;
    }

    case 'blocking_units': {
      const seats = new Set(seatsFor(ctx, query, scope));
      return combat.blocks.filter((block) => {
        const instance = findInstance(ctx.state, block.blockerInstanceId);
        if (!instance || !seats.has(instance.controller)) return false;
        return instanceMatches(ctx, block.blockerInstanceId, query, scope);
      }).length;
    }

    case 'units_defeated_this_turn':
      return countTurnEntries(ctx, turnEvents.defeated, query, scope);
    case 'units_sacrificed_this_turn':
      return countTurnEntries(ctx, turnEvents.sacrificed, query, scope);
    case 'units_deployed_this_turn':
      return countTurnEntries(ctx, turnEvents.deployed, query, scope);
    case 'tokens_created_this_turn':
      return countTurnEntries(ctx, turnEvents.tokensCreated, query, scope);
    case 'units_survived_as_blocker_this_turn':
      return countTurnEntries(ctx, turnEvents.survivedAsBlocker, query, scope);

    default: {
      // Exhaustive: a new subject fails type-check here until it is answered,
      // rather than silently counting zero.
      const never: never = query.subject;
      void never;
      return 0;
    }
  }
}

/** Whether a gate on a trigger or an instruction is satisfied right now. */
export function evaluateCondition(
  ctx: ReadContext,
  condition: ConditionDefinition,
  scope: CountScope,
): boolean {
  if (condition.kind === 'active_turn') {
    return (ctx.state.activePlayerId === scope.controllerId) === condition.expected;
  }

  if (condition.kind === 'previous_step') {
    // Absent means there was no preceding instruction — an ability-level gate,
    // where "if you do" has nothing to refer to. False rather than true: a gate
    // that cannot be evaluated must not wave the instruction through.
    return (scope.previousStepActed ?? false) === condition.expected;
  }

  if (condition.kind === 'source_state') {
    const source = scope.sourceInstanceId
      ? findInstance(ctx.state, scope.sourceInstanceId)
      : undefined;
    // A source that has left play has no state to ask about, so the condition is
    // false rather than defaulting to true and letting a dead card act.
    if (!source) return false;
    const actual =
      condition.state === 'ready'
        ? !source.exhausted
        : condition.state === 'exhausted'
          ? source.exhausted
          : isNewlyDeployed(source);
    return actual === condition.expected;
  }

  const total = evaluateCount(ctx, condition.count, scope);
  switch (condition.comparison) {
    case 'at_least':
      return total >= condition.value;
    case 'at_most':
      return total <= condition.value;
    case 'exactly':
      return total === condition.value;
    default: {
      const never: never = condition.comparison;
      void never;
      return false;
    }
  }
}

/**
 * Reads one number off a card's statline (M02.3).
 *
 * **Derived**, not printed: `currentAttack`/`currentHealth` include every
 * applied modifier and the continuous layer, so "gains Health equal to its ATK"
 * on a unit standing next to a lord uses the ATK a player can see. Read at the
 * moment the instruction resolves, like every other value — a buff that lands
 * between the trigger firing and the ability resolving is counted.
 *
 * Returns `null` when the named card is not there: an ability whose subject has
 * left play, or an `effect_target` on an instruction acting on a player. The
 * caller turns that into zero, which is what an unresolvable amount has always
 * meant here; the schema rejects the *structurally* unresolvable cases at load
 * time, so this covers only the ones that depend on the board.
 */
function readStat(
  ctx: ReadContext,
  of: StatSubject,
  stat: StatField,
  scope: CountScope,
): number | null {
  const instanceId =
    of === 'source'
      ? scope.sourceInstanceId
      : of === 'trigger_subject'
        ? (scope.triggerSubjectInstanceId ?? null)
        : (scope.targetInstanceId ?? null);
  if (!instanceId) return null;
  const instance = findInstance(ctx.state, instanceId);
  if (!instance) return null;
  const definition = definitionOf(ctx.database, instance);
  return stat === 'attack'
    ? currentAttack(instance, definition)
    : currentHealth(instance, definition);
}

/**
 * Resolves an amount, which may be a printed number, a count of the board, or a
 * number read off a card's statline.
 *
 * `per` divides and rounds **down**: "for every three other Goblins" is worth
 * one at three Goblins and one at four, which is what a player reads it as.
 */
export function evaluateValue(ctx: ReadContext, value: ValueExpression, scope: CountScope): number {
  if (typeof value === 'number') return value;
  const raw =
    value.kind === 'stat'
      ? (readStat(ctx, value.of, value.stat, scope) ?? 0) + value.plus
      : value.kind === 'previous_targets'
        ? // Zero when the step before acted on nothing, which is a legal outcome
          // of an "up to N" that took none — not a missing answer.
          (scope.previousTargetCount ?? 0) + value.plus
        : Math.floor(evaluateCount(ctx, value.count, scope) / value.per) + value.plus;
  const capped = value.maximum === undefined ? raw : Math.min(raw, value.maximum);
  // Never negative: an amount of damage or a number of tokens has no meaning
  // below zero, and the floor is applied after the cap so a `maximum` cannot
  // push the result under the `minimum`.
  return Math.max(value.minimum, capped, 0);
}

/** Same, for a value that is allowed to be negative — a stat penalty. */
export function evaluateSignedValue(
  ctx: ReadContext,
  value: SignedValueExpression,
  scope: CountScope,
): number {
  if (typeof value === 'number') return value;
  const raw =
    value.kind === 'stat'
      ? value.sign * (readStat(ctx, value.of, value.stat, scope) ?? 0) + value.plus
      : value.sign * Math.floor(evaluateCount(ctx, value.count, scope) / value.per) + value.plus;
  const capped = value.maximum === undefined ? raw : Math.min(raw, value.maximum);
  return Math.max(value.minimum, capped);
}

/**
 * Living opponents of a seat, for effects that need one.
 *
 * Re-exported here so a caller that already imports the value evaluator does
 * not need a second import purely to walk seats.
 */
export function opponentsOf(ctx: ReadContext, playerId: PlayerId): PlayerId[] {
  return clockwiseFrom(ctx.state, playerId);
}
