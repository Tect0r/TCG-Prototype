import type {
  ConditionDefinition,
  CountQuery,
  SignedValueExpression,
  ValueExpression,
} from '@tcg/card-data';
import type { MatchContext } from './context.js';
import {
  clockwiseFrom,
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
}

/** Seats a `controller` relation covers, relative to the asking player. */
function seatsFor(ctx: MatchContext, query: CountQuery, scope: CountScope): PlayerId[] {
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
  ctx: MatchContext,
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
function entryMatches(ctx: MatchContext, entry: TurnEventEntry, query: CountQuery): boolean {
  if (!query.filter) return true;
  const definition = ctx.database.get(entry.definitionId);
  if (!definition) return false;
  // No instance: the card is gone, so `damaged`/`exhausted` predicates simply do
  // not apply rather than being guessed at.
  return matchesCardFilter(definition, null, query.filter);
}

function countTurnEntries(
  ctx: MatchContext,
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
export function evaluateCount(ctx: MatchContext, query: CountQuery, scope: CountScope): number {
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
  ctx: MatchContext,
  condition: ConditionDefinition,
  scope: CountScope,
): boolean {
  if (condition.kind === 'active_turn') {
    return (ctx.state.activePlayerId === scope.controllerId) === condition.expected;
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
 * Resolves an amount, which may be a printed number or a count of the board.
 *
 * `per` divides and rounds **down**: "for every three other Goblins" is worth
 * one at three Goblins and one at four, which is what a player reads it as.
 */
export function evaluateValue(
  ctx: MatchContext,
  value: ValueExpression,
  scope: CountScope,
): number {
  if (typeof value === 'number') return value;
  const raw = Math.floor(evaluateCount(ctx, value.count, scope) / value.per) + value.plus;
  const capped = value.maximum === undefined ? raw : Math.min(raw, value.maximum);
  // Never negative: an amount of damage or a number of tokens has no meaning
  // below zero, and the floor is applied after the cap so a `maximum` cannot
  // push the result under the `minimum`.
  return Math.max(value.minimum, capped, 0);
}

/** Same, for a value that is allowed to be negative — a stat penalty. */
export function evaluateSignedValue(
  ctx: MatchContext,
  value: SignedValueExpression,
  scope: CountScope,
): number {
  if (typeof value === 'number') return value;
  const raw =
    value.sign * Math.floor(evaluateCount(ctx, value.count, scope) / value.per) + value.plus;
  const capped = value.maximum === undefined ? raw : Math.min(raw, value.maximum);
  return Math.max(value.minimum, capped);
}

/**
 * Living opponents of a seat, for effects that need one.
 *
 * Re-exported here so a caller that already imports the value evaluator does
 * not need a second import purely to walk seats.
 */
export function opponentsOf(ctx: MatchContext, playerId: PlayerId): PlayerId[] {
  return clockwiseFrom(ctx.state, playerId);
}
