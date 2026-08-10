import type {
  CardDefinition,
  ContinuousScope,
  KeywordId,
  StaticAbilityDefinition,
} from '@tcg/card-data';
import type { MatchContext } from './context.js';
import { definitionOf, findInstance, matchesCardFilter, playerOf } from './derive.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';
import type { CardInstance, ContinuousLayer, MatchState } from './schema/state.js';

/**
 * The continuous-effects layer (CLAUDE.md §17 Q2).
 *
 * Static abilities are never *applied* to anything. The whole layer is thrown
 * away and rebuilt from the current board, so:
 *
 *  - a unit that arrives after the lord still gets the bonus;
 *  - the bonus disappears the instant the lord leaves play;
 *  - nothing accumulates, so recalculating twice is identical to once.
 *
 * `recalculate` is called from `settle`, which runs after every atomic
 * instruction and every state-based check, so the derived values a rule reads
 * are never more than one instruction stale.
 */

const EMPTY: ContinuousLayer = { attack: 0, health: 0, grantedKeywords: [], removedKeywords: [] };

function isEmpty(layer: ContinuousLayer): boolean {
  return (
    layer.attack === 0 &&
    layer.health === 0 &&
    layer.grantedKeywords.length === 0 &&
    layer.removedKeywords.length === 0
  );
}

function sameLayer(left: ContinuousLayer, right: ContinuousLayer): boolean {
  return (
    left.attack === right.attack &&
    left.health === right.health &&
    left.grantedKeywords.join(',') === right.grantedKeywords.join(',') &&
    left.removedKeywords.join(',') === right.removedKeywords.join(',')
  );
}

/** Instances a scope covers for one controller, in deterministic order. */
function scopeContents(
  state: MatchState,
  playerId: PlayerId,
  scope: ContinuousScope,
): InstanceId[] {
  const player = playerOf(state, playerId);
  switch (scope.zone) {
    case 'battlefield':
      return [...player.units, ...player.relics];
    case 'hand':
      return [...player.hand];
    case 'discard':
      return [...player.discard];
    case 'commander_zone':
      return [player.commanderInstanceId];
    default:
      // Deck order is hidden and `removed` is terminal: neither is a legal
      // continuous scope, and silently covering them would leak information.
      return [];
  }
}

function playersInScope(state: MatchState, controllerId: PlayerId, scope: ContinuousScope) {
  switch (scope.controller) {
    case 'self':
      return [controllerId];
    case 'opponent':
      return state.seatOrder.filter((id) => id !== controllerId);
    default:
      return [...state.seatOrder];
  }
}

/** Sources whose static abilities are active right now. */
function activeSources(
  ctx: MatchContext,
): { instance: CardInstance; definition: CardDefinition }[] {
  const sources: { instance: CardInstance; definition: CardDefinition }[] = [];
  // Iterated in instance-creation order so two lords granting conflicting
  // things resolve the same way on every machine and in every replay.
  const instances = Object.values(ctx.state.instances).sort((a, b) => a.ordinal - b.ordinal);

  for (const instance of instances) {
    const definition = ctx.database.get(instance.definitionId);
    if (!definition || definition.staticAbilities.length === 0) continue;
    // An eliminated player's permanents stop contributing immediately, before
    // the elimination cleanup has finished removing them (CLAUDE.md §12 step 3).
    if (playerOf(ctx.state, instance.controller).lost) continue;
    sources.push({ instance, definition });
  }
  return sources;
}

/**
 * Whether a static ability is switched on right now.
 *
 * Two gates, both facts about the source itself: the zone it has to be in, and
 * optionally the state it has to be in ("while this Unit is Ready"). Exported
 * because the Reaction discount is read at cost time rather than accumulated
 * into the continuous layer, and it must answer this question the same way.
 */
export function staticAbilityActive(
  source: CardInstance,
  ability: StaticAbilityDefinition,
): boolean {
  if (source.zone !== ability.activeZone) return false;
  switch (ability.sourceState) {
    case undefined:
      return true;
    case 'ready':
      return !source.exhausted;
    case 'exhausted':
      return source.exhausted;
    case 'newly_deployed':
      return source.newlyDeployed;
  }
}

function applyAbility(
  ctx: MatchContext,
  source: CardInstance,
  ability: StaticAbilityDefinition,
  into: Map<InstanceId, ContinuousLayer>,
): void {
  if (!staticAbilityActive(source, ability)) return;
  // A Reaction discount is a fact about its controller's next Reaction, not a
  // modifier on any card, so it contributes nothing here. `reactions.ts` reads
  // it directly at the moment a cost is computed.
  if (ability.effect.type === 'reaction_discount') return;

  for (const playerId of playersInScope(ctx.state, source.controller, ability.affects)) {
    for (const instanceId of scopeContents(ctx.state, playerId, ability.affects)) {
      if (ability.affects.excludeSource && instanceId === source.instanceId) continue;
      const target = findInstance(ctx.state, instanceId);
      if (!target) continue;

      if (ability.affects.filter) {
        const definition = definitionOf(ctx.database, target);
        // Filters read *printed* values plus already-accumulated continuous
        // ones would be circular, so a static filter matches on the state
        // without this pass's own contributions.
        if (!matchesCardFilter(definition, target, ability.affects.filter)) continue;
      }

      const current = into.get(instanceId) ?? {
        ...EMPTY,
        grantedKeywords: [],
        removedKeywords: [],
      };
      if (ability.effect.type === 'modify_stats') {
        current.attack += ability.effect.attack;
        current.health += ability.effect.health;
      } else if (ability.effect.type === 'grant_keyword') {
        const keyword: KeywordId = ability.effect.keyword;
        if (!current.grantedKeywords.includes(keyword)) current.grantedKeywords.push(keyword);
      }
      into.set(instanceId, current);
    }
  }
}

/**
 * Rebuilds every instance's continuous layer from scratch.
 *
 * Returns true when anything changed, so callers can run a state-based check
 * only when it can matter — losing a Health-granting lord can be lethal.
 */
export function recalculateContinuous(ctx: MatchContext): boolean {
  const computed = new Map<InstanceId, ContinuousLayer>();

  for (const { instance, definition } of activeSources(ctx)) {
    for (const ability of definition.staticAbilities) {
      applyAbility(ctx, instance, ability, computed);
    }
  }

  let changed = false;
  for (const instance of Object.values(ctx.state.instances)) {
    const next = computed.get(instance.instanceId) ?? EMPTY;
    if (sameLayer(instance.continuous, next)) continue;
    instance.continuous = isEmpty(next)
      ? { ...EMPTY, grantedKeywords: [], removedKeywords: [] }
      : {
          attack: next.attack,
          health: next.health,
          grantedKeywords: [...next.grantedKeywords].sort(),
          removedKeywords: [...next.removedKeywords].sort(),
        };
    changed = true;
  }
  return changed;
}
