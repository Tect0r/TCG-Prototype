import type {
  EffectDefinition,
  PlayerSelector,
  TargetDefinition,
  TargetSelector,
  ZoneId,
} from '@tcg/card-data';
import { emit, type MatchContext } from './context.js';
import { addDamageShield, damagePlayer, damageUnit, healPlayer, healUnit } from './damage.js';
import {
  definitionOf,
  findInstance,
  freeUnitSlots,
  hasKeyword,
  matchesCardFilter,
  playerOf,
} from './derive.js';
import {
  autoSelect,
  legalTargets,
  playerCandidates,
  requestedCount,
  resolvePlayerSelector,
  type TargetScope,
} from './targeting.js';
import { enqueue } from './triggers.js';
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
    /** Defaults to the effect index; set when one instruction asks twice. */
    readonly selectionKey?: string;
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
    continuation: {
      kind: 'resolution',
      itemId: item.id,
      effectIndex,
      selectionKey: options.selectionKey ?? String(effectIndex),
    },
  };
}

/** Selection key for the answer one specific player gave to one instruction. */
function perPlayerKey(effectIndex: number, playerId: PlayerId): string {
  return `${effectIndex}:${playerId}`;
}

type PlayerResolution =
  | { readonly kind: 'players'; readonly ids: PlayerId[] }
  | { readonly kind: 'choice'; readonly choice: PendingChoice };

/**
 * Turns a `PlayerSelector` into concrete seats, asking the controller to pick
 * when `opponent` is ambiguous.
 *
 * With two seats "your opponent" has exactly one answer and nothing pauses;
 * with three or four the controller must say who they mean, because the engine
 * is not allowed to choose a victim on their behalf (CLAUDE.md §12).
 */
function resolveEffectPlayers(
  ctx: MatchContext,
  item: ResolutionItem,
  effectIndex: number,
  selector: PlayerSelector,
): PlayerResolution {
  const key = `${effectIndex}:player`;
  const stored = item.selections[key];
  if (stored !== undefined) {
    return { kind: 'players', ids: stored.filter((id) => ctx.state.players[id] !== undefined) };
  }

  const direct = resolvePlayerSelector(ctx, selector, item.controllerId);
  if (direct !== null) return { kind: 'players', ids: direct };

  const candidates = playerCandidates(
    ctx,
    { kind: 'player', relation: 'opponent', selection: 'player_choice' },
    item.controllerId,
  );
  return {
    kind: 'choice',
    choice: buildChoice(ctx, item, effectIndex, {
      playerId: item.controllerId,
      type: 'select_players',
      reason: 'select_opponent',
      zone: null,
      minimum: 1,
      maximum: 1,
      validEntityIds: candidates,
      selectionKey: key,
    }),
  };
}

/** Which player answers a target choice. Falls back to the controller. */
function chooserFor(ctx: MatchContext, selector: TargetSelector, controllerId: PlayerId): PlayerId {
  const players = resolvePlayerSelector(ctx, selector.chooser, controllerId);
  return players?.[0] ?? controllerId;
}

type TargetResolution =
  | { readonly kind: 'entities'; readonly ids: InstanceId[] }
  | { readonly kind: 'players'; readonly ids: PlayerId[] }
  | { readonly kind: 'choice'; readonly choice: PendingChoice }
  | { readonly kind: 'fizzle' };

/**
 * Turns a target definition into concrete recipients, asking the right player
 * when the definition calls for a choice.
 *
 * On resume, previously chosen targets are re-checked against the current legal
 * set: a target that has become invalid is dropped and the rest of the
 * instruction still resolves (CLAUDE.md §4). That is also what removes a player
 * who was eliminated between choosing and resolving.
 */
function resolveTargets(
  ctx: MatchContext,
  item: ResolutionItem,
  effectIndex: number,
  target: TargetDefinition,
): TargetResolution {
  if (target.kind === 'player' || target.kind === 'players') {
    const candidates = playerCandidates(ctx, target, item.controllerId);
    const stored = item.selections[String(effectIndex)];
    if (stored !== undefined) {
      return { kind: 'players', ids: stored.filter((id) => candidates.includes(id)) };
    }
    if (candidates.length === 0) return { kind: 'fizzle' };
    if (target.kind === 'players') return { kind: 'players', ids: candidates };
    if (candidates.length === 1) return { kind: 'players', ids: candidates };

    return {
      kind: 'choice',
      choice: buildChoice(ctx, item, effectIndex, {
        playerId: item.controllerId,
        type: 'select_players',
        reason: 'select_opponent',
        zone: null,
        minimum: 1,
        maximum: 1,
        validEntityIds: candidates,
      }),
    };
  }

  const candidates = legalTargets(ctx, target, scopeOf(item));
  const stored = item.selections[String(effectIndex)];

  if (stored !== undefined) {
    return { kind: 'entities', ids: stored.filter((id) => candidates.includes(id)) };
  }
  if (target.kind === 'source') {
    return candidates.length > 0 ? { kind: 'entities', ids: candidates } : { kind: 'fizzle' };
  }

  const selector = target.selector;
  if (candidates.length === 0) {
    return selector.optional ? { kind: 'entities', ids: [] } : { kind: 'fizzle' };
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

  return { kind: 'entities', ids: autoSelect(ctx, selector, candidates) };
}

/**
 * Executes one instruction. Never loops, never resolves more than a single
 * atomic step, and never advances the queue: the caller owns sequencing.
 *
 * A multi-recipient instruction (`each_opponent`, `all_players`) resolves every
 * recipient inside this one call, so simultaneous loss is a draw rather than a
 * race decided by iteration order (CLAUDE.md §12).
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
      const players = resolveEffectPlayers(ctx, item, effectIndex, effect.player);
      if (players.kind === 'choice') return { kind: 'awaiting_choice', choice: players.choice };
      for (const playerId of players.ids) drawCards(ctx, playerId, effect.amount);
      return RESOLVED;
    }

    case 'discard': {
      const players = resolveEffectPlayers(ctx, item, effectIndex, effect.player);
      if (players.kind === 'choice') return { kind: 'awaiting_choice', choice: players.choice };

      // Each discarding player answers separately, in the order the selector
      // produced them (clockwise for `each_opponent`), and the answers are
      // filed under per-player keys so a reconnect resumes at the right one.
      for (const playerId of players.ids) {
        const playerKey = perPlayerKey(effectIndex, playerId);
        const stored = item.selections[playerKey];
        if (stored !== undefined) {
          for (const instanceId of stored) {
            const instance = findInstance(ctx.state, instanceId);
            if (instance && instance.zone === 'hand') discardCard(ctx, instance.owner, instanceId);
          }
          continue;
        }

        const hand = playerOf(ctx.state, playerId).hand;
        const amount = Math.min(effect.amount, hand.length);
        if (amount === 0) {
          item.selections[playerKey] = [];
          continue;
        }

        if (effect.selection === 'player_choice') {
          return {
            kind: 'awaiting_choice',
            choice: buildChoice(ctx, item, effectIndex, {
              playerId,
              type: 'select_cards',
              reason: 'discard_effect',
              zone: 'hand',
              minimum: amount,
              maximum: amount,
              validEntityIds: hand,
              selectionKey: playerKey,
            }),
          };
        }

        const picked =
          effect.selection === 'random'
            ? autoSelect(ctx, { ...AUTO_SELECTOR, count: amount, selection: 'random' }, hand)
            : hand.slice(0, amount);
        for (const instanceId of picked) discardCard(ctx, playerId, instanceId);
        item.selections[playerKey] = [];
      }
      return RESOLVED;
    }

    case 'deal_damage': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind === 'fizzle') return { kind: 'fizzled', reason: 'no_legal_target' };

      if (resolution.kind === 'players') {
        for (const playerId of resolution.ids) {
          damagePlayer(ctx, playerId, effect.amount, { sourceInstanceId: item.sourceInstanceId });
        }
        return RESOLVED;
      }

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
      if (resolution.kind === 'players') {
        for (const playerId of resolution.ids) healPlayer(ctx, playerId, effect.amount);
        return RESOLVED;
      }
      for (const targetId of resolution.ids) healUnit(ctx, targetId, effect.amount);
      return RESOLVED;
    }

    case 'modify_stats': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind !== 'entities') return { kind: 'fizzled', reason: 'no_legal_target' };
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
      if (resolution.kind !== 'entities') return { kind: 'fizzled', reason: 'no_legal_target' };
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
      const players = resolveEffectPlayers(ctx, item, effectIndex, effect.controller);
      if (players.kind === 'choice') return { kind: 'awaiting_choice', choice: players.choice };
      const definition = ctx.database.get(effect.tokenCardId);
      if (!definition) return { kind: 'fizzled', reason: 'unsupported' };

      for (const playerId of players.ids) {
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

          // A token entering play resolves its own deploy effects, exactly as a
          // played unit does — one authoring form for deploy behaviour
          // (CLAUDE.md §17 Q1). Appended, so the rest of this instruction
          // finishes first (Q28).
          if (definition.effects.length > 0) {
            enqueue(ctx, {
              kind: 'card_effects',
              sourceInstanceId: token.instanceId,
              sourceDefinitionId: definition.id,
              controllerId: playerId,
              abilityId: null,
              effects: [...definition.effects],
              causeSequence: ctx.state.sequence,
              completesSpell: false,
            });
          }
        }
      }
      return RESOLVED;
    }

    case 'destroy':
    case 'sacrifice': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind !== 'entities') return { kind: 'fizzled', reason: 'no_legal_target' };

      for (const targetId of resolution.ids) defeatUnit(ctx, targetId, effect.type);
      return RESOLVED;
    }

    case 'return_to_hand': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind !== 'entities') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) moveToZone(ctx, targetId, 'hand');
      return RESOLVED;
    }

    case 'move_card': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind !== 'entities') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) moveToZone(ctx, targetId, effect.toZone);
      return RESOLVED;
    }

    case 'exhaust':
    case 'ready': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind !== 'entities') return { kind: 'fizzled', reason: 'no_legal_target' };
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
      if (resolution.kind === 'players') {
        for (const playerId of resolution.ids) {
          addDamageShield(ctx, { playerId }, effect.amount, effect.duration);
        }
        return RESOLVED;
      }
      for (const targetId of resolution.ids) {
        addDamageShield(ctx, { instanceId: targetId }, effect.amount, effect.duration);
      }
      return RESOLVED;
    }

    case 'modify_cost': {
      const players = resolveEffectPlayers(ctx, item, effectIndex, effect.player);
      if (players.kind === 'choice') return { kind: 'awaiting_choice', choice: players.choice };
      for (const playerId of players.ids) {
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
      const players = resolveEffectPlayers(ctx, item, effectIndex, effect.player);
      if (players.kind === 'choice') return { kind: 'awaiting_choice', choice: players.choice };
      const searcher = players.ids[0];
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

      const maximum = Math.min(effect.amount, candidates.length);
      // Searching a *public* zone is mandatory when a legal result exists;
      // a hidden zone may always legally find nothing (CLAUDE.md §17 Q25).
      const mandatory = PUBLIC_ZONES.has(effect.zone) && !effect.upTo;

      return {
        kind: 'awaiting_choice',
        choice: buildChoice(ctx, item, effectIndex, {
          playerId: searcher,
          type: 'select_cards',
          reason: 'search_zone',
          zone: effect.zone,
          minimum: mandatory ? maximum : 0,
          maximum,
          validEntityIds: candidates,
        }),
      };
    }

    case 'reorder_zone': {
      const players = resolveEffectPlayers(ctx, item, effectIndex, effect.player);
      if (players.kind === 'choice') return { kind: 'awaiting_choice', choice: players.choice };
      const playerId = players.ids[0];
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

/**
 * Removes a unit from play as a destroy or a sacrifice.
 *
 * A sacrificed unit counts as defeated and fires both `on_sacrifice` and
 * `on_defeated`; the `reason` is retained so a future card can tell them apart
 * (CLAUDE.md §17 Q24). Shared with activation-cost payment, where sacrifice is
 * a cost rather than an effect (Q3).
 */
export function defeatUnit(
  ctx: MatchContext,
  instanceId: InstanceId,
  cause: 'destroy' | 'sacrifice',
): void {
  const instance = findInstance(ctx.state, instanceId);
  if (!instance || instance.zone !== 'battlefield') return;
  emit(ctx, {
    type: 'unit_defeated',
    instanceId,
    definitionId: instance.definitionId,
    controllerId: instance.controller,
    reason: cause === 'destroy' ? 'destroyed' : 'sacrificed',
  });
  moveToZone(ctx, instanceId, 'discard', { silent: true });
}

/** Zones every player can already see, where a search cannot be declined. */
const PUBLIC_ZONES = new Set<ZoneId>(['discard', 'battlefield', 'commander_zone']);

export function zoneContents(ctx: MatchContext, playerId: PlayerId, zone: ZoneId): InstanceId[] {
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
const AUTO_SELECTOR: TargetSelector = {
  zone: 'hand',
  controller: 'self',
  count: 1,
  selection: 'random',
  chooser: 'self',
  optional: false,
  excludeSource: false,
};
