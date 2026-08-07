import type { CardId, ZoneId } from '@tcg/card-data';
import { emit, type MatchContext } from './context.js';
import { instanceOf, playerOf } from './derive.js';
import { shuffle } from './rng.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';
import type { CardInstance } from './schema/state.js';

/** Zones whose contents are a flat ordered list on the owning player. */
type ListZone = 'deck' | 'hand' | 'discard';

const LIST_ZONES = new Set<ZoneId>(['deck', 'hand', 'discard']);

function isListZone(zone: ZoneId): zone is ListZone {
  return LIST_ZONES.has(zone);
}

export function nextInstanceId(ctx: MatchContext): InstanceId {
  const ordinal = ctx.state.nextInstanceOrdinal;
  ctx.state.nextInstanceOrdinal += 1;
  return `inst_${String(ordinal).padStart(4, '0')}`;
}

/**
 * Registers a brand-new physical card in the match. Definition identity is
 * permanent; the instance ID is match-local and unique (CLAUDE.md §10).
 */
export function createInstance(
  ctx: MatchContext,
  definitionId: CardId,
  owner: PlayerId,
  zone: ZoneId,
  options: { readonly isToken?: boolean; readonly slot?: number | null } = {},
): CardInstance {
  const instanceId = nextInstanceId(ctx);
  const instance: CardInstance = {
    instanceId,
    definitionId,
    ordinal: ctx.state.nextInstanceOrdinal - 1,
    owner,
    controller: owner,
    zone,
    slot: options.slot ?? null,
    markedDamage: 0,
    exhausted: false,
    enteredZoneOnTurn: ctx.state.turn,
    statModifiers: [],
    grantedKeywords: [],
    removedKeywords: [],
    damageShields: [],
    counters: {},
    isToken: options.isToken ?? false,
  };
  ctx.state.instances[instanceId] = instance;
  return instance;
}

function detach(ctx: MatchContext, instance: CardInstance): void {
  const controller = playerOf(ctx.state, instance.controller);
  const owner = playerOf(ctx.state, instance.owner);

  if (instance.zone === 'battlefield') {
    const index = controller.units.indexOf(instance.instanceId);
    if (index >= 0) controller.units[index] = null;
    const relicIndex = controller.relics.indexOf(instance.instanceId);
    if (relicIndex >= 0) controller.relics.splice(relicIndex, 1);
    instance.slot = null;
    return;
  }

  if (isListZone(instance.zone)) {
    const list = owner[instance.zone];
    const index = list.indexOf(instance.instanceId);
    if (index >= 0) list.splice(index, 1);
  }
}

/** Everything a card sheds when it stops being the permanent it was. */
function resetPermanentState(instance: CardInstance): void {
  instance.markedDamage = 0;
  instance.exhausted = false;
  instance.statModifiers = [];
  instance.grantedKeywords = [];
  instance.removedKeywords = [];
  instance.damageShields = [];
  instance.counters = {};
  instance.slot = null;
}

export interface MoveOptions {
  /** Deck insertions default to the bottom; set for "put on top". */
  readonly toTop?: boolean;
  /** Battlefield unit slot. Ignored for other zones. */
  readonly slot?: number;
  /** Suppress the `card_moved` event when a more specific event is emitted. */
  readonly silent?: boolean;
}

/**
 * Moves a card between zones, keeping every zone list and the instance's own
 * `zone`/`slot` fields consistent. Tokens cease to exist rather than moving to
 * a non-battlefield zone.
 */
export function moveToZone(
  ctx: MatchContext,
  instanceId: InstanceId,
  toZone: ZoneId,
  options: MoveOptions = {},
): void {
  const instance = instanceOf(ctx.state, instanceId);
  const fromZone = instance.zone;
  if (fromZone === toZone && toZone !== 'battlefield') return;

  detach(ctx, instance);

  if (instance.isToken && toZone !== 'battlefield') {
    // A token that leaves the battlefield ceases to exist. Emit the move first
    // so the log still shows where it went before it disappears.
    if (!options.silent) {
      emit(ctx, {
        type: 'card_moved',
        instanceId,
        definitionId: instance.definitionId,
        playerId: instance.owner,
        fromZone,
        toZone,
      });
    }
    delete ctx.state.instances[instanceId];
    return;
  }

  const owner = playerOf(ctx.state, instance.owner);
  instance.zone = toZone;
  instance.enteredZoneOnTurn = ctx.state.turn;

  if (toZone === 'battlefield') {
    const controller = playerOf(ctx.state, instance.controller);
    if (options.slot === undefined) {
      controller.relics.push(instanceId);
    } else {
      controller.units[options.slot] = instanceId;
      instance.slot = options.slot;
    }
  } else {
    resetPermanentState(instance);
    instance.controller = instance.owner;
    if (isListZone(toZone)) {
      if (toZone === 'deck' && options.toTop) owner.deck.unshift(instanceId);
      else owner[toZone].push(instanceId);
    }
  }

  if (!options.silent) {
    emit(ctx, {
      type: 'card_moved',
      instanceId,
      definitionId: instance.definitionId,
      playerId: instance.owner,
      fromZone,
      toZone,
    });
  }
}

export function shuffleDeck(ctx: MatchContext, playerId: PlayerId): void {
  const player = playerOf(ctx.state, playerId);
  const result = shuffle(ctx.state.rng, player.deck);
  player.deck = result.items;
  ctx.state.rng = result.state;
  emit(ctx, { type: 'deck_shuffled', playerId, deckSize: player.deck.length });
}

/**
 * Draws one card. Returns false when the deck was empty, in which case the
 * player is marked as lost — resolved into a match result by the next
 * state-based check. Multi-card draws call this once per card so an empty deck
 * mid-draw ends the match at the right instruction (CLAUDE.md §4).
 */
export function drawOne(ctx: MatchContext, playerId: PlayerId): boolean {
  const player = playerOf(ctx.state, playerId);
  const top = player.deck[0];

  if (top === undefined) {
    if (ctx.config.emptyDeckDrawLoses && !player.lost) {
      player.lost = true;
      player.lossReason = 'empty_deck';
      emit(ctx, { type: 'player_lost', playerId, reason: 'empty_deck' });
    }
    return false;
  }

  player.deck.shift();
  const instance = instanceOf(ctx.state, top);
  instance.zone = 'hand';
  instance.enteredZoneOnTurn = ctx.state.turn;
  player.hand.push(top);

  emit(ctx, {
    type: 'card_drawn',
    playerId,
    instanceId: top,
    definitionId: instance.definitionId,
    deckRemaining: player.deck.length,
  });
  return true;
}

export function drawCards(ctx: MatchContext, playerId: PlayerId, amount: number): void {
  for (let i = 0; i < amount; i += 1) {
    if (!drawOne(ctx, playerId)) return;
  }
}

export function discardCard(ctx: MatchContext, playerId: PlayerId, instanceId: InstanceId): void {
  const instance = instanceOf(ctx.state, instanceId);
  moveToZone(ctx, instanceId, 'discard', { silent: true });
  emit(ctx, {
    type: 'card_discarded',
    playerId,
    instanceId,
    definitionId: instance.definitionId,
  });
}
