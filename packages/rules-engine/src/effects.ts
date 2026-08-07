import type { EffectDefinition, PlayerSelector, TargetSelector, ZoneId } from '@tcg/card-data';
import { emit, type MatchContext } from './context.js';
import { addDamageShield, damageUnit, healUnit } from './damage.js';
import {
  definitionOf,
  findInstance,
  freeUnitSlots,
  hasKeyword,
  matchesCardFilter,
  opponentOf,
  playerOf,
} from './derive.js';
import { autoSelect, legalTargets, requestedCount, type TargetScope } from './targeting.js';
import { createInstance, discardCard, drawCards, moveToZone, shuffleDeck } from './zones.js';
import type { ChoiceReason, ChoiceType, PendingChoice } from './schema/choice.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';
import type { ResolutionItem } from './schema/state.js';

/**
 * The outcome of one atomic instruction.
 *
 * `awaiting_choice` pauses the whole resolution queue: nothing else resolves
 * until the expected player answers (CLAUDE.md §9).
 */
export type EffectOutcome =
  | { readonly kind: 'resolved' }
  | { readonly kind: 'fizzled'; readonly reason: 'no_legal_target' | 'unsupported' }
  | { readonly kind: 'awaiting_choice'; readonly choice: PendingChoice };

const RESOLVED: EffectOutcome = { kind: 'resolved' };

function scopeOf(item: ResolutionItem): TargetScope {
  return { controllerId: item.controllerId, sourceInstanceId: item.sourceInstanceId };
}

export function nextChoiceId(ctx: MatchContext): string {
  const id = `choice_${String(ctx.state.nextChoiceOrdinal).padStart(4, '0')}`;
  ctx.state.nextChoiceOrdinal += 1;
  return id;
}

function buildChoice(
  ctx: MatchContext,
  item: ResolutionItem,
  effectIndex: number,
  options: {
    readonly playerId: PlayerId;
    readonly type: ChoiceType;
    readonly reason: ChoiceReason;
    readonly zone: ZoneId | null;
    readonly minimum: number;
    readonly maximum: number;
    readonly validEntityIds: readonly string[];
    readonly ordered?: boolean;
  },
): PendingChoice {
  return {
    id: nextChoiceId(ctx),
    playerId: options.playerId,
    type: options.type,
    reason: options.reason,
    zone: options.zone,
    minimum: options.minimum,
    maximum: options.maximum,
    validEntityIds: [...options.validEntityIds],
    ordered: options.ordered ?? false,
    sourceInstanceId: item.sourceInstanceId,
    continuation: { kind: 'resolution', itemId: item.id, effectIndex },
  };
}

/** Who a `PlayerSelector` refers to, from the point of view of the effect's controller. */
export function resolvePlayers(
  ctx: MatchContext,
  selector: PlayerSelector,
  controllerId: PlayerId,
): PlayerId[] | null {
  switch (selector) {
    case 'self':
      return [controllerId];
    case 'opponent':
    case 'each_opponent':
      return [opponentOf(ctx.state, controllerId)];
    case 'all':
      return [...ctx.state.playerOrder];
    case 'target_player':
      // Player targeting has no expression in the Phase 1 target schema (a
      // TargetSelector always names a zone). Unsupported rather than guessed.
      return null;
    default:
      return null;
  }
}

/** Which player answers a target choice. */
function chooserFor(ctx: MatchContext, selector: TargetSelector, controllerId: PlayerId): PlayerId {
  const players = resolvePlayers(ctx, selector.chooser, controllerId);
  return players?.[0] ?? controllerId;
}

type TargetResolution =
  | { readonly kind: 'targets'; readonly ids: InstanceId[] }
  | { readonly kind: 'choice'; readonly choice: PendingChoice }
  | { readonly kind: 'fizzle' };

/**
 * Turns a target selector into concrete instances, asking the right player when
 * the selector calls for a choice.
 *
 * On resume, previously chosen targets are re-checked against the current legal
 * set: a target that has become invalid is dropped and the rest of the
 * instruction still resolves (CLAUDE.md §4).
 */
function resolveTargets(
  ctx: MatchContext,
  item: ResolutionItem,
  effectIndex: number,
  selector: TargetSelector,
): TargetResolution {
  const candidates = legalTargets(ctx, selector, scopeOf(item));
  const stored = item.selections[String(effectIndex)];

  if (stored !== undefined) {
    return { kind: 'targets', ids: stored.filter((id) => candidates.includes(id)) };
  }

  if (candidates.length === 0) {
    return selector.optional ? { kind: 'targets', ids: [] } : { kind: 'fizzle' };
  }

  if (selector.selection === 'player_choice') {
    const maximum = requestedCount(selector, candidates.length);
    return {
      kind: 'choice',
      choice: buildChoice(ctx, item, effectIndex, {
        playerId: chooserFor(ctx, selector, item.controllerId),
        type: selector.zone === 'battlefield' ? 'select_units' : 'select_cards',
        reason: 'effect_target',
        zone: selector.zone,
        minimum: selector.optional ? 0 : maximum,
        maximum,
        validEntityIds: candidates,
      }),
    };
  }

  return { kind: 'targets', ids: autoSelect(ctx, selector, candidates) };
}

/**
 * Executes one instruction. Never loops, never resolves more than a single
 * atomic step, and never advances the queue: the caller owns sequencing.
 */
export function executeEffect(
  ctx: MatchContext,
  item: ResolutionItem,
  effect: EffectDefinition,
  effectIndex: number,
): EffectOutcome {
  const key = String(effectIndex);

  switch (effect.type) {
    case 'draw': {
      const players = resolvePlayers(ctx, effect.player, item.controllerId);
      if (!players) return { kind: 'fizzled', reason: 'unsupported' };
      for (const playerId of players) drawCards(ctx, playerId, effect.amount);
      return RESOLVED;
    }

    case 'discard': {
      const players = resolvePlayers(ctx, effect.player, item.controllerId);
      if (!players) return { kind: 'fizzled', reason: 'unsupported' };

      const stored = item.selections[key];
      if (stored !== undefined) {
        for (const instanceId of stored) {
          const instance = findInstance(ctx.state, instanceId);
          if (instance && instance.zone === 'hand') discardCard(ctx, instance.owner, instanceId);
        }
        return RESOLVED;
      }

      // Only the controller's own discard can pause for a choice in v0.2; a
      // multi-player discard would need one choice per player, which no card
      // in the set requires.
      const chooser = players[0];
      if (chooser === undefined) return RESOLVED;
      const hand = playerOf(ctx.state, chooser).hand;
      if (hand.length === 0) return RESOLVED;
      const amount = Math.min(effect.amount, hand.length);
      if (amount === 0) return RESOLVED;

      if (effect.selection === 'player_choice') {
        return {
          kind: 'awaiting_choice',
          choice: buildChoice(ctx, item, effectIndex, {
            playerId: chooser,
            type: 'select_cards',
            reason: 'discard_effect',
            zone: 'hand',
            minimum: amount,
            maximum: amount,
            validEntityIds: hand,
          }),
        };
      }

      const picked =
        effect.selection === 'random'
          ? autoSelect(ctx, { ...DEFAULT_AUTO_SELECTOR, count: amount, selection: 'random' }, hand)
          : hand.slice(0, amount);
      for (const instanceId of picked) discardCard(ctx, chooser, instanceId);
      return RESOLVED;
    }

    case 'deal_damage': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind === 'fizzle') return { kind: 'fizzled', reason: 'no_legal_target' };

      const source = item.sourceInstanceId
        ? findInstance(ctx.state, item.sourceInstanceId)
        : undefined;
      const lethal =
        source !== undefined && hasKeyword(source, definitionOf(ctx.database, source), 'venom');

      for (const targetId of resolution.ids) {
        damageUnit(ctx, targetId, effect.amount, {
          sourceInstanceId: item.sourceInstanceId,
          lethal,
        });
      }
      return RESOLVED;
    }

    case 'heal': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind === 'fizzle') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) healUnit(ctx, targetId, effect.amount);
      return RESOLVED;
    }

    case 'modify_stats': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind === 'fizzle') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) {
        const instance = findInstance(ctx.state, targetId);
        if (!instance) continue;
        instance.statModifiers.push({
          attack: effect.attack,
          health: effect.health,
          duration: effect.duration,
          sourceInstanceId: item.sourceInstanceId,
          appliedOnTurn: ctx.state.turn,
        });
        emit(ctx, {
          type: 'stats_modified',
          instanceId: targetId,
          attack: effect.attack,
          health: effect.health,
          duration: effect.duration,
        });
      }
      return RESOLVED;
    }

    case 'grant_keyword':
    case 'remove_keyword': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind === 'fizzle') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) {
        const instance = findInstance(ctx.state, targetId);
        if (!instance) continue;
        const modifier = {
          keyword: effect.keyword,
          duration: effect.duration,
          sourceInstanceId: item.sourceInstanceId,
          appliedOnTurn: ctx.state.turn,
        };
        if (effect.type === 'grant_keyword') {
          instance.grantedKeywords.push(modifier);
          emit(ctx, {
            type: 'keyword_granted',
            instanceId: targetId,
            keyword: effect.keyword,
            duration: effect.duration,
          });
        } else {
          instance.removedKeywords.push(modifier);
          emit(ctx, {
            type: 'keyword_removed',
            instanceId: targetId,
            keyword: effect.keyword,
            duration: effect.duration,
          });
        }
      }
      return RESOLVED;
    }

    case 'create_token': {
      const players = resolvePlayers(ctx, effect.controller, item.controllerId);
      if (!players) return { kind: 'fizzled', reason: 'unsupported' };
      const definition = ctx.database.get(effect.tokenCardId);
      if (!definition) return { kind: 'fizzled', reason: 'unsupported' };

      for (const playerId of players) {
        for (let i = 0; i < effect.amount; i += 1) {
          const player = playerOf(ctx.state, playerId);
          const slot = freeUnitSlots(player)[0];
          if (slot === undefined) {
            // The battlefield is full: the token is simply never created.
            emit(ctx, {
              type: 'token_creation_failed',
              playerId,
              definitionId: definition.id,
              reason: 'no_free_slot',
            });
            break;
          }
          const token = createInstance(ctx, definition.id, playerId, 'battlefield', {
            isToken: true,
            slot,
          });
          player.units[slot] = token.instanceId;
          emit(ctx, {
            type: 'token_created',
            playerId,
            instanceId: token.instanceId,
            definitionId: definition.id,
            slot,
          });
        }
      }
      return RESOLVED;
    }

    case 'destroy':
    case 'sacrifice': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind === 'fizzle') return { kind: 'fizzled', reason: 'no_legal_target' };

      for (const targetId of resolution.ids) {
        const instance = findInstance(ctx.state, targetId);
        if (!instance || instance.zone !== 'battlefield') continue;
        emit(ctx, {
          type: 'unit_defeated',
          instanceId: targetId,
          definitionId: instance.definitionId,
          controllerId: instance.controller,
          reason: effect.type === 'destroy' ? 'destroyed' : 'sacrificed',
        });
        moveToZone(ctx, targetId, 'discard', { silent: true });
      }
      return RESOLVED;
    }

    case 'return_to_hand': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind === 'fizzle') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) moveToZone(ctx, targetId, 'hand');
      return RESOLVED;
    }

    case 'move_card': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind === 'fizzle') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) moveToZone(ctx, targetId, effect.toZone);
      return RESOLVED;
    }

    case 'exhaust':
    case 'ready': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind === 'fizzle') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) {
        const instance = findInstance(ctx.state, targetId);
        if (!instance) continue;
        const shouldExhaust = effect.type === 'exhaust';
        if (instance.exhausted === shouldExhaust) continue;
        instance.exhausted = shouldExhaust;
        emit(ctx, {
          type: shouldExhaust ? 'unit_exhausted' : 'unit_readied',
          instanceId: targetId,
        });
      }
      return RESOLVED;
    }

    case 'prevent_damage': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind === 'fizzle') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) {
        addDamageShield(ctx, { instanceId: targetId }, effect.amount, effect.duration);
      }
      return RESOLVED;
    }

    case 'modify_cost': {
      const players = resolvePlayers(ctx, effect.player, item.controllerId);
      if (!players) return { kind: 'fizzled', reason: 'unsupported' };
      for (const playerId of players) {
        playerOf(ctx.state, playerId).costModifiers.push({
          delta: effect.delta,
          filter: effect.filter ?? null,
          duration: effect.duration,
          appliedOnTurn: ctx.state.turn,
          sourceInstanceId: item.sourceInstanceId,
        });
        emit(ctx, {
          type: 'cost_modified',
          playerId,
          delta: effect.delta,
          duration: effect.duration,
        });
      }
      return RESOLVED;
    }

    case 'search_zone': {
      const players = resolvePlayers(ctx, effect.player, item.controllerId);
      if (!players) return { kind: 'fizzled', reason: 'unsupported' };
      const searcher = players[0];
      if (searcher === undefined) return RESOLVED;

      const stored = item.selections[key];
      if (stored !== undefined) {
        for (const instanceId of stored) moveToZone(ctx, instanceId, effect.destination);
        if (effect.reveal && stored.length > 0) {
          emit(ctx, {
            type: 'cards_revealed',
            playerId: searcher,
            instanceIds: stored,
            definitionIds: stored.map(
              (id) => findInstance(ctx.state, id)?.definitionId ?? 'unknown_card',
            ),
          });
        }
        // Searching a hidden zone reorders it, so it is shuffled afterwards.
        if (effect.zone === 'deck') shuffleDeck(ctx, searcher);
        return RESOLVED;
      }

      const candidates = zoneContents(ctx, searcher, effect.zone).filter((instanceId) => {
        if (!effect.filter) return true;
        const instance = findInstance(ctx.state, instanceId);
        if (!instance) return false;
        return matchesCardFilter(definitionOf(ctx.database, instance), instance, effect.filter);
      });

      if (candidates.length === 0) {
        if (effect.zone === 'deck') shuffleDeck(ctx, searcher);
        return RESOLVED;
      }

      return {
        kind: 'awaiting_choice',
        choice: buildChoice(ctx, item, effectIndex, {
          playerId: searcher,
          type: 'select_cards',
          reason: 'search_zone',
          zone: effect.zone,
          // A search may legally find nothing; forcing a pick would be a rules
          // decision nobody has made. See open-questions.md.
          minimum: 0,
          maximum: Math.min(effect.amount, candidates.length),
          validEntityIds: candidates,
        }),
      };
    }

    case 'reorder_zone': {
      const players = resolvePlayers(ctx, effect.player, item.controllerId);
      if (!players) return { kind: 'fizzled', reason: 'unsupported' };
      const playerId = players[0];
      if (playerId === undefined) return RESOLVED;

      const contents = zoneContents(ctx, playerId, effect.zone);
      const window = contents.slice(0, effect.amount);
      if (window.length <= 1) return RESOLVED;

      const stored = item.selections[key];
      if (stored !== undefined) {
        const player = playerOf(ctx.state, playerId);
        if (effect.zone === 'deck') {
          player.deck = [...stored, ...player.deck.slice(window.length)];
        }
        emit(ctx, {
          type: 'zone_reordered',
          playerId,
          zone: effect.zone,
          count: stored.length,
        });
        return RESOLVED;
      }

      return {
        kind: 'awaiting_choice',
        choice: buildChoice(ctx, item, effectIndex, {
          playerId,
          type: 'order_cards',
          reason: 'reorder_zone',
          zone: effect.zone,
          minimum: window.length,
          maximum: window.length,
          validEntityIds: window,
          ordered: true,
        }),
      };
    }

    default: {
      // Exhaustiveness guard: a new effect type must be handled explicitly.
      const _never: never = effect;
      void _never;
      return { kind: 'fizzled', reason: 'unsupported' };
    }
  }
}

function zoneContents(ctx: MatchContext, playerId: PlayerId, zone: ZoneId): InstanceId[] {
  const player = playerOf(ctx.state, playerId);
  switch (zone) {
    case 'deck':
      return [...player.deck];
    case 'hand':
      return [...player.hand];
    case 'discard':
      return [...player.discard];
    case 'battlefield':
      return [...player.units.filter((id): id is InstanceId => id !== null), ...player.relics];
    case 'commander_zone':
      return [player.commanderInstanceId];
    default:
      return [];
  }
}

/** Selector shape used when a non-target effect needs `autoSelect`'s randomness. */
const DEFAULT_AUTO_SELECTOR: TargetSelector = {
  zone: 'hand',
  controller: 'self',
  count: 1,
  selection: 'random',
  chooser: 'self',
  optional: false,
  excludeSource: false,
  targetsSource: false,
};
