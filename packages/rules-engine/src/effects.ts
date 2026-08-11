import type {
  EffectDefinition,
  PlayerSelector,
  SignedValueExpression,
  TargetDefinition,
  TargetSelector,
  ValueExpression,
  ZoneId,
} from '@tcg/card-data';
import { emit, type MatchContext } from './context.js';
import { addDamageShield, damagePlayer, damageUnit, healPlayer, healUnit } from './damage.js';
import {
  commanderDeployCost,
  definitionOf,
  findInstance,
  hasKeyword,
  matchesCardFilter,
  playerOf,
} from './derive.js';
import {
  autoSelect,
  expandTokenGroup,
  legalTargets,
  playerCandidates,
  requestedCount,
  resolvePlayerSelector,
  type TargetScope,
} from './targeting.js';
import { counterTarget } from './reactions.js';
import { enqueue } from './triggers.js';
import { evaluateCondition, evaluateSignedValue, evaluateValue } from './values.js';
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
  | {
      readonly kind: 'fizzled';
      readonly reason: 'no_legal_target' | 'unsupported' | 'condition_unmet' | 'declined';
    }
  | { readonly kind: 'awaiting_choice'; readonly choice: PendingChoice };

const RESOLVED: EffectOutcome = { kind: 'resolved' };

function scopeOf(item: ResolutionItem): TargetScope {
  return {
    controllerId: item.controllerId,
    sourceInstanceId: item.sourceInstanceId,
    triggerSubjectInstanceId: item.triggerSubjectInstanceId,
    previousStepActed: item.previousStepActed,
  };
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

/**
 * Whether an instruction has anything at all to act on, without asking anyone.
 *
 * Only used to decide whether a "you may" is worth offering, so it is a pure
 * read: it must not build a choice, and must not touch `nextChoiceOrdinal`.
 * Instructions with no target are always worth offering — a draw or a token
 * always has a recipient.
 */
function hasRecipient(ctx: MatchContext, item: ResolutionItem, effect: EffectDefinition): boolean {
  if (!('target' in effect)) return true;
  const target = effect.target;
  if (target.kind === 'player' || target.kind === 'players') {
    return playerCandidates(ctx, target, item.controllerId).length > 0;
  }
  // An optional selector already means "you may pick nothing", so the set being
  // empty is a legal outcome rather than a reason to skip the question.
  if (target.kind === 'entity' && target.selector.optional) return true;
  return legalTargets(ctx, target, scopeOf(item)).length > 0;
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
  // A Token-group target reaches every Token sharing the chosen one's
  // definition and controller. Expanded here, after the choice, because the
  // group is a consequence of naming one Token rather than a wider option set
  // (rule adjustment §8).
  const group = (ids: readonly InstanceId[]): InstanceId[] =>
    target.kind === 'entity' ? expandTokenGroup(ctx, target.selector, ids) : [...ids];

  if (stored !== undefined) {
    return { kind: 'entities', ids: group(stored.filter((id) => candidates.includes(id))) };
  }
  if (target.kind === 'source' || target.kind === 'trigger_subject') {
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

  return { kind: 'entities', ids: group(autoSelect(ctx, selector, candidates)) };
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
  const scope = scopeOf(item);

  // An instruction's own `if` is checked here, at resolution, not when its card
  // was played (ruleset update §15). A skipped instruction is not a failure: the
  // rest of the card still resolves, which is what "Draw a card. If …, draw
  // another" means.
  if (effect.condition && !evaluateCondition(ctx, effect.condition, scope)) {
    return { kind: 'fizzled', reason: 'condition_unmet' };
  }

  // "You may …". Asked after the condition, so a step whose `if` already failed
  // is never put to a player as a decision they might make (ruleset update
  // §15).
  if (effect.optional) {
    const mayKey = `${effectIndex}:may`;
    const answer = item.selections[mayKey];
    if (answer === undefined) {
      // Nothing to act on means nothing to decide. The same instinct that keeps
      // a Reaction window shut when nobody can use it: an offer with one
      // possible outcome is a pause, not a choice.
      if (!hasRecipient(ctx, item, effect)) return { kind: 'fizzled', reason: 'no_legal_target' };
      return {
        kind: 'awaiting_choice',
        choice: buildChoice(ctx, item, effectIndex, {
          playerId: item.controllerId,
          type: 'confirm',
          reason: 'optional_effect',
          zone: null,
          minimum: 1,
          maximum: 1,
          validEntityIds: ['yes', 'no'],
          selectionKey: mayKey,
        }),
      };
    }
    if (answer[0] !== 'yes') return { kind: 'fizzled', reason: 'declined' };
  }

  /** Resolves an amount that may be a count of the board rather than a number. */
  const value = (expression: ValueExpression): number => evaluateValue(ctx, expression, scope);
  const signed = (expression: SignedValueExpression): number =>
    evaluateSignedValue(ctx, expression, scope);

  switch (effect.type) {
    case 'draw': {
      const players = resolveEffectPlayers(ctx, item, effectIndex, effect.player);
      if (players.kind === 'choice') return { kind: 'awaiting_choice', choice: players.choice };
      for (const playerId of players.ids) drawCards(ctx, playerId, value(effect.amount));
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
        const amount = Math.min(value(effect.amount), hand.length);
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
          damagePlayer(ctx, playerId, value(effect.amount), {
            sourceInstanceId: item.sourceInstanceId,
          });
        }
        return RESOLVED;
      }

      const source = item.sourceInstanceId
        ? findInstance(ctx.state, item.sourceInstanceId)
        : undefined;
      const lethal =
        source !== undefined && hasKeyword(source, definitionOf(ctx.database, source), 'venom');

      for (const targetId of resolution.ids) {
        damageUnit(ctx, targetId, value(effect.amount), {
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
        for (const playerId of resolution.ids) healPlayer(ctx, playerId, value(effect.amount));
        return RESOLVED;
      }
      for (const targetId of resolution.ids) healUnit(ctx, targetId, value(effect.amount));
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
          attack: signed(effect.attack),
          health: signed(effect.health),
          duration: effect.duration,
          sourceInstanceId: item.sourceInstanceId,
          appliedOnTurn: ctx.state.turn,
        });
        emit(ctx, {
          type: 'stats_modified',
          instanceId: targetId,
          attack: signed(effect.attack),
          health: signed(effect.health),
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

      const tokenCount = value(effect.amount);
      for (const playerId of players.ids) {
        const created: InstanceId[] = [];
        for (let i = 0; i < tokenCount; i += 1) {
          const player = playerOf(ctx.state, playerId);
          // Every requested token is created. There is no battlefield limit to
          // run out of, so the old "not created at all" outcome is gone
          // (ruleset update §7).
          const token = createInstance(ctx, definition.id, playerId, 'battlefield', {
            isToken: true,
          });
          player.units.push(token.instanceId);
          created.push(token.instanceId);
          emit(ctx, {
            type: 'token_created',
            playerId,
            instanceId: token.instanceId,
            definitionId: definition.id,
          });
          // A token arrives on the battlefield without being deployed: it was
          // never played and never paid for, so it fires the entry event and not
          // the deployment one (rule adjustment §7).
          emit(ctx, {
            type: 'unit_entered_battlefield',
            playerId,
            instanceId: token.instanceId,
            definitionId: definition.id,
            method: 'token_created',
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

        // One event for the whole batch, after every token has arrived. "Whenever
        // you create one or more Tokens" fires once for a five-token instruction,
        // not five times, and the ability that reacts sees the finished board
        // rather than a partly-built one (ruleset update §13).
        if (created.length > 0) {
          emit(ctx, {
            type: 'tokens_created',
            playerId,
            definitionId: definition.id,
            instanceIds: created,
            count: created.length,
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

    case 'counter': {
      const entry = counterTarget(ctx);
      // Nothing left to counter: everything above this Reaction already
      // resolved, and there was nothing underneath it. The Reaction still goes
      // to the discard — a countered card and a card that found no target both
      // cost their controller the card.
      if (!entry || entry.instanceId === item.sourceInstanceId) {
        return { kind: 'fizzled', reason: 'no_legal_target' };
      }

      if (effect.unlessPays > 0) {
        const stored = item.selections[key];
        const controller = playerOf(ctx.state, entry.controllerId);

        if (stored === undefined) {
          // A controller who cannot pay is never asked: the offer would have
          // exactly one legal answer, and pausing the queue for it would be a
          // choice in name only.
          if (controller.energy >= effect.unlessPays) {
            return {
              kind: 'awaiting_choice',
              choice: buildChoice(ctx, item, effectIndex, {
                playerId: entry.controllerId,
                type: 'confirm',
                reason: 'pay_additional_cost',
                zone: null,
                minimum: 1,
                maximum: 1,
                validEntityIds: ['yes', 'no'],
              }),
            };
          }
        } else if (stored[0] === 'yes' && controller.energy >= effect.unlessPays) {
          controller.energy -= effect.unlessPays;
          return RESOLVED;
        }
      }

      entry.countered = true;
      entry.counteredByInstanceId = item.sourceInstanceId;
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
          addDamageShield(
            ctx,
            { playerId },
            value(effect.amount),
            effect.duration,
            item.sourceInstanceId,
          );
        }
        return RESOLVED;
      }
      for (const targetId of resolution.ids) {
        addDamageShield(
          ctx,
          { instanceId: targetId },
          value(effect.amount),
          effect.duration,
          item.sourceInstanceId,
        );
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

      // The window the search sees: the whole zone, or only the top few cards
      // when the card says "look at the top N" (ruleset update §16).
      const window = zoneContents(ctx, searcher, effect.zone);
      const looked = effect.fromTop === undefined ? window : window.slice(0, effect.fromTop);

      /**
       * Puts the cards that were looked at but not taken on the bottom, in the
       * order they were in.
       *
       * Deliberately not followed by a shuffle. A full-zone search shuffles
       * because it reordered a hidden zone by rummaging through it; a
       * look-at-the-top effect has *told* the player what is now on the bottom,
       * and shuffling it away would make the card say something it does not do.
       */
      const settleRemainder = (taken: readonly InstanceId[]): void => {
        // A look-at-the-top effect never shuffles, whatever the remainder rule
        // says. Shuffling exists because a full-zone search rummaged through a
        // hidden zone; looking at three cards told the player what is there, and
        // hiding it again would make the card say something it does not do.
        if (effect.fromTop !== undefined) {
          if (effect.remainder !== 'bottom') return;
          for (const instanceId of looked) {
            if (taken.includes(instanceId)) continue;
            // Already in the deck: move it within the zone, to the bottom.
            const player = playerOf(ctx.state, searcher);
            const index = player.deck.indexOf(instanceId);
            if (index >= 0) {
              player.deck.splice(index, 1);
              player.deck.push(instanceId);
            }
          }
          return;
        }
        // Searching a hidden zone reorders it, so it is shuffled afterwards.
        if (effect.zone === 'deck') shuffleDeck(ctx, searcher);
      };

      const stored = item.selections[key];
      if (stored !== undefined) {
        for (const instanceId of stored) {
          // "Put one on the bottom" keeps the card in the zone it came from, so
          // there is no zone change for `moveToZone` to make — it would see
          // deck-to-deck and return without doing anything. Reordering within
          // the zone is the whole effect here, so it is done directly.
          if (effect.destination === effect.zone && effect.zone === 'deck') {
            const player = playerOf(ctx.state, searcher);
            const index = player.deck.indexOf(instanceId);
            if (index >= 0) {
              player.deck.splice(index, 1);
              player.deck.push(instanceId);
            }
            continue;
          }
          moveToZone(ctx, instanceId, effect.destination);
        }
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
        settleRemainder(stored);
        return RESOLVED;
      }

      const candidates = looked.filter((instanceId) => {
        if (!effect.filter) return true;
        const instance = findInstance(ctx.state, instanceId);
        if (!instance) return false;
        return matchesCardFilter(definitionOf(ctx.database, instance), instance, effect.filter);
      });

      if (candidates.length === 0) {
        // Nothing matched, but the cards were still looked at, so the remainder
        // clause still applies.
        settleRemainder([]);
        return RESOLVED;
      }

      const maximum = Math.min(effect.amount, candidates.length);
      // Searching a *public* zone is mandatory when a legal result exists; a
      // hidden zone may always legally find nothing (CLAUDE.md §17 Q25). A
      // look-at-the-top effect counts as public for this purpose: the cards were
      // shown to the chooser, so "put one on the bottom" with no "may" is a
      // decision they can and must make.
      const revealedByLooking = effect.fromTop !== undefined;
      const mandatory = (PUBLIC_ZONES.has(effect.zone) || revealedByLooking) && !effect.upTo;

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
  restDefeated(ctx, instanceId);
}

/**
 * Puts a defeated permanent wherever it belongs.
 *
 * Ordinary cards go to the discard pile. A Commander goes back to its **Command
 * Zone** instead, its defeat count goes up by one, and its next deployment
 * therefore costs more (rule adjustment §2). That is the whole of the Commander
 * lifecycle: there is no Recovery Zone, no replay tax beyond the cost, and no
 * Commander-defeat loss condition.
 *
 * One function rather than a branch at each defeat site, because there are four
 * routes to a defeat — lethal damage, a state-based zero-Health check, `destroy`
 * and `sacrifice` — and a Commander that came back from three of them would be
 * worse than one that came back from none.
 */
export function restDefeated(ctx: MatchContext, instanceId: InstanceId): void {
  const instance = findInstance(ctx.state, instanceId);
  if (!instance) return;

  const owner = playerOf(ctx.state, instance.owner);
  if (owner.commanderInstanceId !== instanceId) {
    moveToZone(ctx, instanceId, 'discard', { silent: true });
    return;
  }

  owner.commanderDefeats += 1;
  moveToZone(ctx, instanceId, 'commander_zone', { silent: true });

  const definition = ctx.database.get(instance.definitionId);
  emit(ctx, {
    type: 'commander_returned',
    playerId: instance.owner,
    instanceId,
    definitionId: instance.definitionId,
    defeatCount: owner.commanderDefeats,
    deploymentCost: definition ? (commanderDeployCost(owner, definition, ctx.config) ?? 0) : 0,
  });
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
      return [...player.units, ...player.relics];
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
