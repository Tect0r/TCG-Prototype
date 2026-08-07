import {
  CardDatabase,
  cardDefinitionSchema,
  loadBundledCardData,
  type CardDefinitionInput,
  type CardId,
  type ZoneId,
} from '@tcg/card-data';
import { isErr, unwrap } from '@tcg/shared';
import { DEFAULT_RULES_CONFIG, type RulesConfig } from './config.js';
import { applyAction, type ApplyContext } from './engine.js';
import { createMatch, type MatchDeck } from './setup.js';
import type { EngineError } from './errors.js';
import type { ActionInput } from './schema/action.js';
import type { InstanceId, MatchPhase, PlayerId } from './schema/primitives.js';
import type { CardInstance, MatchState } from './schema/state.js';

/**
 * Deterministic scaffolding for engine tests.
 *
 * Scenario tests need an exact board, not a shuffled one, so these helpers write
 * directly into a cloned `MatchState`. They keep every zone list and instance
 * field consistent — anything that bypasses them would test a state the engine
 * can never actually produce.
 */

let cached: CardDatabase | undefined;

export function testDatabase(): CardDatabase {
  cached ??= loadBundledCardData().database;
  return cached;
}

export function testContext(config: RulesConfig = DEFAULT_RULES_CONFIG): ApplyContext {
  return { database: testDatabase(), config };
}

/** A 30-card deck of one filler card unless a list is supplied. */
export function makeDeck(
  commanderId: CardId = 'prototype_commander_blue',
  cardIds: readonly CardId[] = ['prototype_drone'],
  size = 30,
): MatchDeck {
  const counts = new Map<CardId, number>();
  for (let i = 0; i < size; i += 1) {
    const cardId = cardIds[i % cardIds.length];
    if (cardId === undefined) break;
    counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  }
  return { commanderId, cards: [...counts].map(([cardId, quantity]) => ({ cardId, quantity })) };
}

/**
 * A database with extra, test-only cards bolted on. Two of the required v0.2
 * effects (`ready`, `move_card`) are not used by any bundled card, and shipping
 * a card just to exercise them would be a card-design decision — so the tests
 * bring their own.
 */
export function databaseWith(extra: readonly CardDefinitionInput[]): CardDatabase {
  const parsed = extra.map((card) => cardDefinitionSchema.parse(card));
  return new CardDatabase([...testDatabase().all(), ...parsed]);
}

export interface StartOptions {
  readonly seed?: string;
  readonly decks?: readonly [MatchDeck, MatchDeck];
  readonly config?: RulesConfig;
  readonly database?: CardDatabase;
}

export function startMatch(options: StartOptions = {}): MatchState {
  const decks = options.decks ?? [makeDeck(), makeDeck('prototype_commander_red')];
  return unwrap(
    createMatch({
      matchId: 'test_match',
      seed: options.seed ?? 'test-seed',
      database: options.database ?? testDatabase(),
      config: options.config ?? DEFAULT_RULES_CONFIG,
      seats: [
        { playerId: 'player_1', name: 'One', deck: decks[0] },
        { playerId: 'player_2', name: 'Two', deck: decks[1] },
      ],
    }),
    'Test match setup failed',
  ).state;
}

/** Applies an action and fails loudly if the engine rejects it. */
export function apply(
  state: MatchState,
  action: ActionInput,
  context: ApplyContext = testContext(),
): MatchState {
  const result = applyAction(state, action, context);
  if (isErr(result)) {
    throw new Error(
      `Expected ${action.type} to be legal but got ${result.error.code}: ${result.error.message}`,
    );
  }
  return result.value.state;
}

/** Applies an action expecting rejection, and returns the structured error. */
export function expectRejected(
  state: MatchState,
  action: ActionInput,
  context: ApplyContext = testContext(),
): EngineError {
  const result = applyAction(state, action, context);
  if (!isErr(result)) {
    throw new Error(`Expected ${action.type} to be rejected but it succeeded.`);
  }
  return result.error;
}

/** Both seats keep their opening hand, taking the match to turn 1. */
export function keepBothHands(
  state: MatchState,
  context: ApplyContext = testContext(),
): MatchState {
  let next = state;
  for (const playerId of state.playerOrder) {
    next = apply(next, { type: 'mulligan', playerId, returnInstanceIds: [] }, context);
  }
  return next;
}

/* -------------------------------------------------------- board manipulation */

function clone(state: MatchState): MatchState {
  return structuredClone(state);
}

function newInstance(
  state: MatchState,
  definitionId: CardId,
  owner: PlayerId,
  zone: ZoneId,
  slot: number | null,
): CardInstance {
  const ordinal = state.nextInstanceOrdinal;
  state.nextInstanceOrdinal += 1;
  const instanceId = `inst_t${String(ordinal).padStart(4, '0')}`;
  const instance: CardInstance = {
    instanceId,
    definitionId,
    ordinal,
    owner,
    controller: owner,
    zone,
    slot,
    markedDamage: 0,
    exhausted: false,
    enteredZoneOnTurn: 0,
    statModifiers: [],
    grantedKeywords: [],
    removedKeywords: [],
    damageShields: [],
    counters: {},
    isToken: false,
  };
  state.instances[instanceId] = instance;
  return instance;
}

export interface Placement {
  readonly state: MatchState;
  readonly instanceId: InstanceId;
}

/** Creates a card directly in a player's hand. */
export function giveCard(state: MatchState, playerId: PlayerId, definitionId: CardId): Placement {
  const next = clone(state);
  const player = next.players[playerId];
  if (!player) throw new Error(`No player ${playerId}`);
  const instance = newInstance(next, definitionId, playerId, 'hand', null);
  player.hand.push(instance.instanceId);
  return { state: next, instanceId: instance.instanceId };
}

/** Puts a unit onto the battlefield, ready and past summoning sickness. */
export function deployUnit(
  state: MatchState,
  playerId: PlayerId,
  definitionId: CardId,
  options: {
    readonly slot?: number;
    readonly exhausted?: boolean;
    readonly summoningSick?: boolean;
  } = {},
): Placement {
  const next = clone(state);
  const player = next.players[playerId];
  if (!player) throw new Error(`No player ${playerId}`);

  const slot = options.slot ?? player.units.findIndex((occupant) => occupant === null);
  if (slot < 0 || player.units[slot] !== null) {
    throw new Error(`Unit slot ${slot} is not free for ${playerId}`);
  }

  const instance = newInstance(next, definitionId, playerId, 'battlefield', slot);
  instance.exhausted = options.exhausted ?? false;
  // Entering "last turn" is the default so the unit can attack immediately.
  instance.enteredZoneOnTurn = options.summoningSick ? next.turn : Math.max(0, next.turn - 1);
  player.units[slot] = instance.instanceId;
  return { state: next, instanceId: instance.instanceId };
}

export function deployRelic(
  state: MatchState,
  playerId: PlayerId,
  definitionId: CardId,
): Placement {
  const next = clone(state);
  const player = next.players[playerId];
  if (!player) throw new Error(`No player ${playerId}`);
  const instance = newInstance(next, definitionId, playerId, 'battlefield', null);
  instance.enteredZoneOnTurn = Math.max(0, next.turn - 1);
  player.relics.push(instance.instanceId);
  return { state: next, instanceId: instance.instanceId };
}

/** Replaces the top of a deck with an exact list of cards, in order. */
export function stackDeck(
  state: MatchState,
  playerId: PlayerId,
  definitionIds: readonly CardId[],
): MatchState {
  const next = clone(state);
  const player = next.players[playerId];
  if (!player) throw new Error(`No player ${playerId}`);
  const added = definitionIds.map(
    (definitionId) => newInstance(next, definitionId, playerId, 'deck', null).instanceId,
  );
  player.deck = [...added, ...player.deck];
  return next;
}

export function setDeckSize(state: MatchState, playerId: PlayerId, size: number): MatchState {
  const next = clone(state);
  const player = next.players[playerId];
  if (!player) throw new Error(`No player ${playerId}`);
  player.deck = player.deck.slice(0, size);
  return next;
}

export function setHealth(state: MatchState, playerId: PlayerId, health: number): MatchState {
  const next = clone(state);
  const player = next.players[playerId];
  if (!player) throw new Error(`No player ${playerId}`);
  player.health = health;
  return next;
}

export function setEnergy(state: MatchState, playerId: PlayerId, energy: number): MatchState {
  const next = clone(state);
  const player = next.players[playerId];
  if (!player) throw new Error(`No player ${playerId}`);
  player.energy = energy;
  player.maxEnergy = Math.max(player.maxEnergy, energy);
  return next;
}

/**
 * Forces the phase without running the transition. Only safe for phases that
 * wait for input, which is all the tests need.
 */
export function forcePhase(state: MatchState, phase: MatchPhase): MatchState {
  const next = clone(state);
  next.phase = phase;
  return next;
}

export function instanceIn(state: MatchState, instanceId: InstanceId): CardInstance {
  const instance = state.instances[instanceId];
  if (!instance) throw new Error(`No instance ${instanceId}`);
  return instance;
}

export function eventsOfType<T extends MatchState['log'][number]['type']>(
  state: MatchState,
  type: T,
): Extract<MatchState['log'][number], { type: T }>[] {
  return state.log.filter(
    (event): event is Extract<MatchState['log'][number], { type: T }> => event.type === type,
  );
}

/** Advances to the active player's first Main Phase from a fresh match. */
export function toMainPhase(state: MatchState, context: ApplyContext = testContext()): MatchState {
  return keepBothHands(state, context);
}
