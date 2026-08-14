import {
  entitySelectorOf,
  type PlayerSelector,
  type TargetDefinition,
  type TargetSelector,
} from '@tcg/card-data';
import type { MatchContext, ReadContext } from './context.js';
import {
  clockwiseFrom,
  definitionOf,
  findInstance,
  hasKeyword,
  isAlive,
  livingOpponents,
  matchesCardFilter,
  playerOf,
} from './derive.js';
import { nextInt } from './rng.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';

/**
 * Whether an instance is attacking or blocking in the current combat.
 *
 * Read from `state.combat` rather than stored on the instance: combat
 * membership belongs to the combat, and a stored flag would need clearing at
 * four different places.
 */
export function combatRoleOf(
  ctx: ReadContext,
  instanceId: InstanceId,
): { attacking: boolean; blocking: boolean } {
  return {
    attacking: ctx.state.combat.attacks.some((attack) => attack.attackerInstanceId === instanceId),
    blocking: ctx.state.combat.blocks.some((block) => block.blockerInstanceId === instanceId),
  };
}

export interface TargetScope {
  /** Player the effect belongs to: resolves `self` / `opponent`. */
  readonly controllerId: PlayerId;
  /** The instance whose text this is, for `source` and `excludeSource`. */
  readonly sourceInstanceId: InstanceId | null;
  /** The card a triggered ability fired about, for `trigger_subject` targets. */
  readonly triggerSubjectInstanceId?: InstanceId | null;
  /**
   * Whether the preceding instruction changed the match, for an "if you do"
   * gate. Nothing in targeting reads it; it rides along because the same scope
   * object is handed to the condition evaluator.
   */
  readonly previousStepActed?: boolean;
}

/**
 * Instances in a zone for one player, in a stable order: battlefield by slot
 * index then relic order, every other zone by list order. Deterministic
 * ordering matters because `automatic` and `random` selection both depend on it
 * (CLAUDE.md §4).
 */
function instancesInZone(
  ctx: MatchContext,
  playerId: PlayerId,
  zone: TargetSelector['zone'],
): InstanceId[] {
  const player = playerOf(ctx.state, playerId);
  switch (zone) {
    case 'battlefield':
      return [...player.units, ...player.relics];
    case 'hand':
      return [...player.hand];
    case 'deck':
      return [...player.deck];
    case 'discard':
      return [...player.discard];
    case 'commander_zone':
      return [player.commanderInstanceId];
    case 'recovery':
      // Nothing ever enters the recovery zone. A defeated Commander goes
      // straight back to its Command Zone (rule adjustment §2), so the only
      // thing this zone would have held now has a home.
      return [];
    case 'removed':
      // Terminal by definition. Nothing may target it (CLAUDE.md §12).
      return [];
    default:
      return [];
  }
}

/**
 * Which players a `PlayerSelector` names, from the controller's point of view.
 *
 * Returns `null` when the answer is genuinely ambiguous — `opponent` with more
 * than one living opponent — so the caller raises a choice instead of the
 * engine silently picking a seat (CLAUDE.md §12).
 */
export function resolvePlayerSelector(
  ctx: MatchContext,
  selector: PlayerSelector,
  controllerId: PlayerId,
): PlayerId[] | null {
  switch (selector) {
    case 'self':
      return isAlive(ctx.state, controllerId) ? [controllerId] : [];
    case 'opponent': {
      const opponents = livingOpponents(ctx.state, controllerId);
      if (opponents.length <= 1) return opponents;
      return null;
    }
    case 'each_opponent':
      return livingOpponents(ctx.state, controllerId);
    case 'all_players':
      // Controller first, then clockwise — one ordering rule for every
      // multi-player effect (open-questions.md Q33).
      return clockwiseFrom(ctx.state, controllerId, { includeSelf: true });
    default:
      return null;
  }
}

/** The living opponents a `player`/`players` target could legally name. */
export function playerCandidates(
  ctx: MatchContext,
  target: Extract<TargetDefinition, { kind: 'player' | 'players' }>,
  controllerId: PlayerId,
): PlayerId[] {
  if (target.kind === 'players') {
    return resolvePlayerSelector(ctx, target.relation, controllerId) ?? [];
  }
  if (target.relation === 'self') {
    return isAlive(ctx.state, controllerId) ? [controllerId] : [];
  }
  return livingOpponents(ctx.state, controllerId);
}

/**
 * Every instance an *entity* target could legally apply to right now.
 *
 * This is the single source of truth for legality: the engine hands the result
 * to the client as `validEntityIds`, and re-derives it when a choice comes back
 * so a stale or forged selection cannot slip through (CLAUDE.md §9).
 */
export function legalTargets(
  ctx: MatchContext,
  target: TargetDefinition,
  scope: TargetScope,
): InstanceId[] {
  if (target.kind === 'trigger_subject') {
    // The subject may have left play — a defeat trigger's subject always has —
    // so it is only a legal target while it is still somewhere the effect can
    // reach. Nothing is invented when it is gone: the instruction fizzles.
    const subject = scope.triggerSubjectInstanceId
      ? findInstance(ctx.state, scope.triggerSubjectInstanceId)
      : undefined;
    return subject && subject.zone === 'battlefield' ? [subject.instanceId] : [];
  }

  if (target.kind === 'source') {
    const source = scope.sourceInstanceId
      ? findInstance(ctx.state, scope.sourceInstanceId)
      : undefined;
    return source ? [source.instanceId] : [];
  }

  if (target.kind === 'blocked_by_source') {
    // Read from the public block assignments at the moment the instruction
    // resolves. Outside a combat the source blocked in, the list is empty and
    // the instruction fizzles rather than inventing a target (M02.4).
    if (scope.sourceInstanceId === null || scope.sourceInstanceId === undefined) return [];
    const sourceId = scope.sourceInstanceId;
    return ctx.state.combat.blocks
      .filter((block) => block.blockerInstanceId === sourceId)
      .map((block) => block.attackerInstanceId)
      .filter((attackerId) => findInstance(ctx.state, attackerId)?.zone === 'battlefield');
  }

  // `previous_target` is not a query over the board: it is a record of what the
  // step before resolved with, which only the executing instruction knows. It is
  // answered in `resolveTargets` and never reaches this function.
  //
  // `entity_or_player` falls through: this function answers the *entity* half of
  // it, exactly as if it were an `entity`, and the player half is added by the
  // one caller that knows how to allocate across both (`divideDamage`).
  const selector = entitySelectorOf(target);
  if (selector === null) return [];

  const candidates: InstanceId[] = [];
  for (const playerId of playersFor(ctx, scope, selector.controller)) {
    for (const instanceId of instancesInZone(ctx, playerId, selector.zone)) {
      if (selector.excludeSource && instanceId === scope.sourceInstanceId) continue;
      const instance = findInstance(ctx.state, instanceId);
      if (!instance) continue;
      const definition = definitionOf(ctx.database, instance);

      // "Untargetable by opponents" removes the unit from any legal set being
      // computed *for* someone who does not control it. It is applied here, in
      // the one place legality is decided, so it covers spells, abilities and
      // pending choices alike — and only here, so non-targeting effects
      // ("every unit", combat, sweepers) are untouched (ruleset update §9).
      if (
        instance.controller !== scope.controllerId &&
        hasKeyword(instance, definition, 'untargetable_by_opponents')
      ) {
        continue;
      }

      if (
        selector.filter &&
        !matchesCardFilter(
          definition,
          instance,
          selector.filter,
          combatRoleOf(ctx, instance.instanceId),
        )
      ) {
        continue;
      }
      candidates.push(instanceId);
    }
  }
  return candidates;
}

/**
 * Whose zones an entity selector searches. `opponent` and `any` widen to every
 * living opponent, so a three-player "destroy target enemy unit" sees all of
 * them (CLAUDE.md §12).
 */
function playersFor(
  ctx: MatchContext,
  scope: TargetScope,
  controller: TargetSelector['controller'],
): PlayerId[] {
  const self = scope.controllerId;
  const opponents = livingOpponents(ctx.state, self);
  if (controller === 'self') return [self];
  if (controller === 'opponent') return opponents;
  return [self, ...opponents];
}

/**
 * Expands each chosen Token into every Token of the same definition controlled
 * by the same player (rule adjustment §8).
 *
 * Applied after selection rather than inside `legalTargets`, and that ordering
 * is the rule: the player targets **one** Token — which is what identifies the
 * player and the definition — and the group is a consequence of the choice, not
 * a larger option set. Doing it the other way round would let the chooser pick a
 * member of a group they never named.
 *
 * Non-Token units pass through untouched. The result is identical whether or not
 * a client stacks Tokens visually, which is the whole requirement.
 */
export function expandTokenGroup(
  ctx: MatchContext,
  selector: TargetSelector,
  chosen: readonly InstanceId[],
): InstanceId[] {
  if (selector.groupByTokenDefinition !== true) return [...chosen];

  const expanded: InstanceId[] = [];
  const seen = new Set<InstanceId>();

  for (const instanceId of chosen) {
    const instance = findInstance(ctx.state, instanceId);
    if (!instance) continue;
    if (!instance.isToken) {
      if (!seen.has(instanceId)) {
        seen.add(instanceId);
        expanded.push(instanceId);
      }
      continue;
    }
    // Walked in the controller's arrival order so the group is deterministic,
    // which matters for anything that resolves per member.
    for (const siblingId of instancesInZone(ctx, instance.controller, selector.zone)) {
      const sibling = findInstance(ctx.state, siblingId);
      if (!sibling || !sibling.isToken) continue;
      if (sibling.definitionId !== instance.definitionId) continue;
      if (sibling.controller !== instance.controller) continue;
      if (seen.has(siblingId)) continue;
      seen.add(siblingId);
      expanded.push(siblingId);
    }
  }
  return expanded;
}

/** How many entities a selector wants, given what is actually available. */
export function requestedCount(selector: TargetSelector, available: number): number {
  return selector.count === 'all' ? available : Math.min(selector.count, available);
}

/**
 * Picks targets without asking a player: `automatic` takes the first N in the
 * deterministic order above, `random` draws from the seeded generator so a
 * replay reproduces the same picks.
 */
export function autoSelect(
  ctx: MatchContext,
  selector: TargetSelector,
  candidates: readonly InstanceId[],
): InstanceId[] {
  const wanted = requestedCount(selector, candidates.length);
  if (wanted >= candidates.length) return [...candidates];

  if (selector.selection === 'random') {
    const pool = [...candidates];
    const picked: InstanceId[] = [];
    for (let i = 0; i < wanted; i += 1) {
      const step = nextInt(ctx.state.rng, pool.length);
      ctx.state.rng = step.state;
      picked.push(pool.splice(step.value, 1)[0] as InstanceId);
    }
    return picked;
  }

  return candidates.slice(0, wanted);
}
