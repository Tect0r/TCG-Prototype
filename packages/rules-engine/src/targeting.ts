import type { TargetSelector } from '@tcg/card-data';
import type { MatchContext } from './context.js';
import { definitionOf, findInstance, matchesCardFilter, opponentOf, playerOf } from './derive.js';
import { nextInt } from './rng.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';

export interface TargetScope {
  /** Player the effect belongs to: resolves `self` / `opponent`. */
  readonly controllerId: PlayerId;
  /** The instance whose text this is, for `targetsSource` and `excludeSource`. */
  readonly sourceInstanceId: InstanceId | null;
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
      return [...player.units.filter((id): id is InstanceId => id !== null), ...player.relics];
    case 'hand':
      return [...player.hand];
    case 'deck':
      return [...player.deck];
    case 'discard':
      return [...player.discard];
    case 'commander_zone':
      return [player.commanderInstanceId];
    case 'recovery':
      // The recovery zone exists in the schema but nothing enters it in v0.2:
      // Commander defeat and recovery are explicitly deferred (CLAUDE.md §4).
      return [];
    default:
      return [];
  }
}

function playersFor(
  ctx: MatchContext,
  scope: TargetScope,
  controller: TargetSelector['controller'],
): PlayerId[] {
  const self = scope.controllerId;
  const opponent = opponentOf(ctx.state, self);
  if (controller === 'self') return [self];
  if (controller === 'opponent') return [opponent];
  return [self, opponent];
}

/**
 * Every instance a selector could legally apply to right now.
 *
 * This is the single source of truth for legality: the engine hands the result
 * to the client as `validEntityIds`, and re-derives it when a choice comes back
 * so a stale or forged selection cannot slip through (CLAUDE.md §9).
 */
export function legalTargets(
  ctx: MatchContext,
  selector: TargetSelector,
  scope: TargetScope,
): InstanceId[] {
  if (selector.targetsSource) {
    const source = scope.sourceInstanceId
      ? findInstance(ctx.state, scope.sourceInstanceId)
      : undefined;
    return source ? [source.instanceId] : [];
  }

  const candidates: InstanceId[] = [];
  for (const playerId of playersFor(ctx, scope, selector.controller)) {
    for (const instanceId of instancesInZone(ctx, playerId, selector.zone)) {
      if (selector.excludeSource && instanceId === scope.sourceInstanceId) continue;
      const instance = findInstance(ctx.state, instanceId);
      if (!instance) continue;
      if (selector.filter) {
        const definition = definitionOf(ctx.database, instance);
        if (!matchesCardFilter(definition, instance, selector.filter)) continue;
      }
      candidates.push(instanceId);
    }
  }
  return candidates;
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
