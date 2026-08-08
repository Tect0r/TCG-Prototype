import type { CardDatabase, CardId } from '@tcg/card-data';
import { err, ok, type Result } from '@tcg/shared';
import { DEFAULT_RULES_CONFIG, type RulesConfig } from './config.js';
import { createContext, emit, type MatchContext } from './context.js';
import { engineError, type EngineError } from './errors.js';
import { createRngState, nextInt, shuffle } from './rng.js';
import { MATCH_SCHEMA_VERSION, MAX_PLAYERS, MIN_PLAYERS } from './schema/primitives.js';
import type { GameEvent } from './schema/event.js';
import { EMPTY_COMBAT, type MatchState, type PlayerState } from './schema/state.js';
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
  /** Two to four seats. Two is 1v1; three and four are free-for-all. */
  readonly seats: readonly MatchSeat[];
  readonly database: CardDatabase;
  readonly config?: RulesConfig;
  /**
   * Keep the supplied seat order instead of shuffling it.
   *
   * Seat order is shuffled from the match seed by default, so joining a lobby
   * first cannot buy a permanently better position at a three- or four-player
   * table (open-questions.md Q31). Tests that need a known table set this.
   */
  readonly preserveSeatOrder?: boolean;
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
    removed: [],
    units: Array.from({ length: unitSlots }, () => null),
    relics: [],
    commanderInstanceId: '',
    mulligan: { status: 'pending', returnedInstanceIds: [], redrawsUsed: 0 },
    costModifiers: [],
    damageShields: [],
    skipNextDraw: false,
    lost: false,
    lossReason: null,
    eliminatedOnTurn: null,
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

  if (options.seats.length < MIN_PLAYERS || options.seats.length > MAX_PLAYERS) {
    return err(
      engineError(
        'engine/invalid_action',
        `A match needs between ${MIN_PLAYERS} and ${MAX_PLAYERS} seats; ${options.seats.length} were supplied.`,
        { seats: options.seats.length },
      ),
    );
  }
  const uniqueIds = new Set(options.seats.map((seat) => seat.playerId));
  if (uniqueIds.size !== options.seats.length) {
    return err(engineError('engine/invalid_action', 'Every seat needs a distinct player ID.'));
  }

  for (const seat of options.seats) {
    const problem = verifyDeck(database, seat);
    if (problem) return err(problem);
  }

  const players: Record<string, PlayerState> = {};
  for (const seat of options.seats) {
    players[seat.playerId] = emptyPlayer(seat, config, config.unitSlots);
  }

  const firstSeat = options.seats[0];
  if (!firstSeat) return err(engineError('engine/invalid_action', 'No seats.'));

  const declaredOrder = options.seats.map((seat) => seat.playerId);
  const skeleton: MatchState = {
    schemaVersion: MATCH_SCHEMA_VERSION,
    rulesVersion: config.version,
    matchId: options.matchId,
    mode: options.seats.length === 2 ? '1v1' : 'ffa',
    seed: options.seed,
    rng: createRngState(options.seed),
    status: 'mulligan',
    seatOrder: declaredOrder,
    playerOrder: declaredOrder,
    players,
    instances: {},
    nextInstanceOrdinal: 0,
    turn: 0,
    activePlayerId: firstSeat.playerId,
    phase: 'setup',
    queue: [],
    nextResolutionOrdinal: 0,
    pendingChoice: null,
    nextChoiceOrdinal: 0,
    combat: { ...EMPTY_COMBAT },
    result: null,
    sequence: 0,
    log: [],
    actionLog: [],
    resolutionSteps: 0,
    stepsSinceInput: 0,
    recentFingerprints: [],
  };

  const ctx = createContext(skeleton, database, config, { actionType: 'create_match' });

  // Seat order comes from the match seed, not from who joined first: at three
  // or four seats the table position a player gets is a real advantage, and
  // join order would hand it to the host (open-questions.md Q31).
  if (options.preserveSeatOrder !== true && ctx.state.seatOrder.length > 2) {
    const shuffled = shuffle(ctx.state.rng, ctx.state.seatOrder);
    ctx.state.rng = shuffled.state;
    ctx.state.seatOrder = shuffled.items;
    ctx.state.playerOrder = [...shuffled.items];
  }

  // Instantiate every deck in decklist order first, so the only randomness that
  // matters is the seat shuffle, the deck shuffles and the starting-player roll.
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
  const roll = nextInt(ctx.state.rng, ctx.state.seatOrder.length);
  ctx.state.rng = roll.state;
  const startingPlayerId = ctx.state.seatOrder[roll.value];
  if (startingPlayerId === undefined) return err(engineError('engine/invalid_action', 'No seats.'));

  // Turn order is the seat circle *rotated* to start with them, never a
  // reordering: seat adjacency is what `each_opponent` and the trigger
  // tiebreak walk, and it must survive every elimination (CLAUDE.md §12).
  const startIndex = ctx.state.seatOrder.indexOf(startingPlayerId);
  ctx.state.playerOrder = ctx.state.seatOrder.map(
    (_, index) => ctx.state.seatOrder[(startIndex + index) % ctx.state.seatOrder.length] as string,
  );
  ctx.state.activePlayerId = startingPlayerId;

  emit(ctx, {
    type: 'match_started',
    playerIds: [...ctx.state.playerOrder],
    seatOrder: [...ctx.state.seatOrder],
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
