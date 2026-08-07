import type { CardDatabase, CardId } from '@tcg/card-data';
import { err, ok, type Result } from '@tcg/shared';
import { DEFAULT_RULES_CONFIG, type RulesConfig } from './config.js';
import { createContext, emit, type MatchContext } from './context.js';
import { engineError, type EngineError } from './errors.js';
import { createRngState, nextInt } from './rng.js';
import { MATCH_SCHEMA_VERSION } from './schema/primitives.js';
import type { GameEvent } from './schema/event.js';
import type { MatchState, PlayerState } from './schema/state.js';
import { createInstance, drawCards, shuffleDeck } from './zones.js';

/**
 * A decklist as the engine needs it. Structurally compatible with `SavedDeck`
 * from `@tcg/deck`, but declared here so the engine does not depend on the deck
 * package — legality is the server's job, played-with-what is the engine's.
 */
export interface MatchDeck {
  readonly commanderId: CardId;
  readonly cards: readonly { readonly cardId: CardId; readonly quantity: number }[];
}

export interface MatchSeat {
  readonly playerId: string;
  readonly name: string;
  readonly deck: MatchDeck;
}

export interface CreateMatchOptions {
  readonly matchId: string;
  /** Any string. The same seed and the same actions reproduce the match exactly. */
  readonly seed: string;
  readonly seats: readonly [MatchSeat, MatchSeat];
  readonly database: CardDatabase;
  readonly config?: RulesConfig;
}

export interface MatchStart {
  readonly state: MatchState;
  readonly events: readonly GameEvent[];
}

function emptyPlayer(seat: MatchSeat, config: RulesConfig, unitSlots: number): PlayerState {
  return {
    playerId: seat.playerId,
    name: seat.name,
    health: config.startingHealth,
    energy: 0,
    // The first turn-start adds `energyGainPerTurn`, so the opening maximum is
    // one gain below the configured starting maximum.
    maxEnergy: Math.max(0, config.startingMaxEnergy - config.energyGainPerTurn),
    deck: [],
    hand: [],
    discard: [],
    units: Array.from({ length: unitSlots }, () => null),
    relics: [],
    commanderInstanceId: '',
    mulligan: { status: 'pending', returnedInstanceIds: [], redrawsUsed: 0 },
    costModifiers: [],
    damageShields: [],
    skipNextDraw: false,
    lost: false,
    lossReason: null,
  };
}

function verifyDeck(database: CardDatabase, seat: MatchSeat): EngineError | null {
  const commander = database.get(seat.deck.commanderId);
  if (!commander) {
    return engineError(
      'engine/unknown_card_definition',
      `Commander "${seat.deck.commanderId}" is not in the card database.`,
      { playerId: seat.playerId, cardId: seat.deck.commanderId },
    );
  }
  for (const entry of seat.deck.cards) {
    if (!database.has(entry.cardId)) {
      return engineError(
        'engine/unknown_card_definition',
        `Card "${entry.cardId}" is not in the card database.`,
        { playerId: seat.playerId, cardId: entry.cardId },
      );
    }
  }
  return null;
}

/**
 * Builds a match: instantiate both decks, seed the generator, pick the starting
 * player, deal opening hands and stop for mulligan decisions.
 *
 * The match is *not* validated for deck legality here. The server does that
 * with `@tcg/deck` before calling this, so the engine has exactly one job.
 */
export function createMatch(options: CreateMatchOptions): Result<MatchStart, EngineError> {
  const config = options.config ?? DEFAULT_RULES_CONFIG;
  const { database } = options;

  for (const seat of options.seats) {
    const problem = verifyDeck(database, seat);
    if (problem) return err(problem);
  }

  const [first, second] = options.seats;
  const skeleton: MatchState = {
    schemaVersion: MATCH_SCHEMA_VERSION,
    rulesVersion: config.version,
    matchId: options.matchId,
    mode: '1v1',
    seed: options.seed,
    rng: createRngState(options.seed),
    status: 'mulligan',
    playerOrder: [first.playerId, second.playerId],
    players: {
      [first.playerId]: emptyPlayer(first, config, config.unitSlots),
      [second.playerId]: emptyPlayer(second, config, config.unitSlots),
    },
    instances: {},
    nextInstanceOrdinal: 0,
    turn: 0,
    activePlayerId: first.playerId,
    phase: 'setup',
    queue: [],
    nextResolutionOrdinal: 0,
    pendingChoice: null,
    nextChoiceOrdinal: 0,
    combat: {
      attackerInstanceIds: [],
      blocks: [],
      combatantInstanceIds: [],
      damageResolved: false,
    },
    result: null,
    sequence: 0,
    log: [],
    actionLog: [],
    resolutionSteps: 0,
    stepsSinceInput: 0,
    recentFingerprints: [],
  };

  const ctx = createContext(skeleton, database, config, { actionType: 'create_match' });

  // Instantiate both decks in decklist order first, so the only randomness that
  // matters is the shuffle and the starting-player roll.
  for (const seat of options.seats) {
    const player = ctx.state.players[seat.playerId];
    if (!player) continue;

    const commander = createInstance(ctx, seat.deck.commanderId, seat.playerId, 'commander_zone');
    player.commanderInstanceId = commander.instanceId;

    for (const entry of seat.deck.cards) {
      for (let copy = 0; copy < entry.quantity; copy += 1) {
        const instance = createInstance(ctx, entry.cardId, seat.playerId, 'deck');
        player.deck.push(instance.instanceId);
      }
    }
  }

  // Starting player comes from the match's own seeded generator (CLAUDE.md §4).
  const roll = nextInt(ctx.state.rng, ctx.state.playerOrder.length);
  ctx.state.rng = roll.state;
  const startingPlayerId = ctx.state.playerOrder[roll.value];
  if (startingPlayerId === undefined) return err(engineError('engine/invalid_action', 'No seats.'));
  ctx.state.playerOrder = [
    startingPlayerId,
    ...ctx.state.playerOrder.filter((id) => id !== startingPlayerId),
  ];
  ctx.state.activePlayerId = startingPlayerId;

  emit(ctx, {
    type: 'match_started',
    playerIds: [...ctx.state.playerOrder],
    startingPlayerId,
    rulesVersion: config.version,
  });

  for (const playerId of ctx.state.playerOrder) {
    shuffleDeck(ctx, playerId);
    drawCards(ctx, playerId, config.openingHandSize);
  }

  if (config.firstPlayerSkipsFirstDraw) {
    const starter = ctx.state.players[startingPlayerId];
    if (starter) starter.skipNextDraw = true;
  }

  ctx.state.phase = 'mulligan';
  ctx.state.status = 'mulligan';

  return ok({ state: ctx.state, events: ctx.events });
}

/** Exposed for tests and tools that need a context without applying an action. */
export function contextFor(
  state: MatchState,
  database: CardDatabase,
  config: RulesConfig,
): MatchContext {
  return createContext(state, database, config);
}
