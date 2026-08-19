import { z } from 'zod';
import { cardIdSchema } from '@tcg/card-data';
import { seedBundleSchema } from './seed.js';
import { isAbnormal, type MatchRecord } from './telemetry/schema.js';
import type { ResolvedPrecon } from './deck-source.js';
import type { SimDeck } from '@tcg/deck-generator';

/**
 * The ordered matchup matrix (M03.4).
 *
 * A batch that asks for it schedules every ordered pair of its decks — `n²`
 * cells, mirrors on the diagonal — and this module turns the resulting records
 * into an artifact a reader can check cell by cell: which deck sat in which
 * seat, which seed the game was derived from, who won, how the match ended,
 * whether anything went wrong, and where the replay is.
 *
 * **It is a robustness artifact, not a balance measurement.** What it is capable
 * of demonstrating is that every ordered pair of the shipped decks terminates
 * deterministically with no illegal action, no loop and no crash. What it cannot
 * demonstrate is that any deck is better than any other: the pilots are
 * transparent heuristics, the cells hold a handful of games each, and nothing
 * here is corrected for anything. M05 is where the pilots become trustworthy
 * enough for the second question to be asked at all, so every rendering of this
 * matrix says so in its own words rather than leaving it to the reader.
 *
 * Two facts are recorded rather than assumed. `complete` says whether all `n²`
 * cells were actually played, and `missing` names the ones that were not, so a
 * run that lost a match to a crash cannot present a partial grid as the whole
 * matrix. And every game carries its own seed path, because "deterministic" is
 * only a checkable claim if the derivation that produced the game is written
 * down beside its result.
 */

/**
 * Version 2 (M04.3): every game carries a compact `board` block — the widest
 * board either seat held, the longest turn, the largest combat, the busiest turn
 * and the stall verdict with the streak behind it.
 *
 * A matrix is where an unbounded battlefield is easiest to see going wrong,
 * because every ordered pair of the shipped decks appears exactly once: a cell
 * that consistently stalls or consistently produces sixty-attacker combats is a
 * property of that pairing rather than of one seed. The block is a projection of
 * the record's own board telemetry, never a second measurement.
 */
export const MATCHUP_MATRIX_SCHEMA_VERSION = 2;

/** The per-game board summary a matrix cell carries (M04.3). */
export const matchupBoardSchema = z.strictObject({
  /** Widest board either seat held at any point in the game. */
  peakUnits: z.number().int().min(0),
  /** Largest group of identical Tokens one seat held — one visual stack. */
  peakTokenStack: z.number().int().min(0),
  /** Accepted actions in the game's longest turn. */
  longestTurnActions: z.number().int().min(0),
  largestCombatAttackers: z.number().int().min(0),
  busiestTurnTriggers: z.number().int().min(0),
  /** The verdict, exactly as the record carries it. Never re-derived here. */
  stallClassification: z.string().min(1),
  /** Rounds every living seat could have attacked in and none did. */
  stallStreak: z.number().int().min(0),
});
export type MatchupBoard = z.infer<typeof matchupBoardSchema>;

/** One seat of one game, in seat order. */
export const matchupSeatSchema = z.strictObject({
  playerId: z.string().min(1),
  seatIndex: z.number().int().min(0),
  deckId: z.string().min(1),
  deckHash: z.string().min(1),
  commanderId: cardIdSchema,
  pilotId: z.string().min(1),
  pilotVersion: z.string().min(1),
  pilotSeed: z.string().min(1),
  won: z.boolean(),
});
export type MatchupSeat = z.infer<typeof matchupSeatSchema>;

export const matchupGameSchema = z.strictObject({
  matchId: z.string().min(1),
  gameIndex: z.number().int().min(0),
  orientation: z.number().int().min(0),
  /** Seats in seat order: index 0 is the first seat of this ordered pair. */
  seats: z.array(matchupSeatSchema),
  startingPlayerId: z.string().min(1),
  /** The full seed hierarchy this game was derived from (CLAUDE.md §13.4). */
  seeds: seedBundleSchema,
  termination: z.string().min(1),
  outcome: z.string().min(1),
  winnerId: z.string().nullable(),
  /** The winning seat's deck, so a cell reads without cross-referencing seats. */
  winnerDeckId: z.string().nullable(),
  endReason: z.string().nullable(),
  turns: z.number().int().min(0),
  /**
   * Everything that would disqualify this game as a clean termination.
   *
   * An abnormal termination, an engine or safeguard diagnostic, and a pilot
   * failure are all listed here with a prefix naming which of the three it was.
   * An empty array is the claim the acceptance criterion is about.
   */
  invariantFailures: z.array(z.string()),
  replayPath: z.string().nullable(),
  /** What the unbounded battlefield did in this game (M04.3). */
  board: matchupBoardSchema,
});
export type MatchupGame = z.infer<typeof matchupGameSchema>;

export const matchupCellSchema = z.strictObject({
  firstSeatDeckId: z.string().min(1),
  secondSeatDeckId: z.string().min(1),
  firstSeatDeckHash: z.string().min(1),
  secondSeatDeckHash: z.string().min(1),
  /** The diagonal: a deck against a copy of itself. */
  mirror: z.boolean(),
  games: z.array(matchupGameSchema),
  firstSeatWins: z.number().int().min(0),
  secondSeatWins: z.number().int().min(0),
  draws: z.number().int().min(0),
  /** Games that ended abnormally or reported an invariant failure. */
  unclean: z.number().int().min(0),
});
export type MatchupCell = z.infer<typeof matchupCellSchema>;

export const matchupDeckSchema = z.strictObject({
  deckId: z.string().min(1),
  deckHash: z.string().min(1),
  commanderId: cardIdSchema,
  label: z.string(),
  /** The precon this deck was resolved from, when a precon source named it. */
  preconId: z.string().nullable(),
});
export type MatchupDeck = z.infer<typeof matchupDeckSchema>;

export const matchupMatrixSchema = z.strictObject({
  schemaVersion: z.literal(MATCHUP_MATRIX_SCHEMA_VERSION),
  experimentId: z.string().min(1),
  /** Root seed the whole hierarchy in every game below descends from. */
  seed: z.string().min(1),
  configHash: z.string().min(1),
  environmentId: z.string().min(1),
  environmentHash: z.string().min(1),
  formatId: z.string(),
  pilots: z.array(z.strictObject({ id: z.string(), version: z.string() })),
  decks: z.array(matchupDeckSchema),
  cells: z.array(matchupCellSchema),
  /** `decks.length²`: every deck in the first seat against every deck in the second. */
  expectedCells: z.number().int().min(0),
  playedCells: z.number().int().min(0),
  complete: z.boolean(),
  /** Ordered pairs with no recorded game, as `first -> second`. */
  missing: z.array(z.string()),
  games: z.number().int().min(0),
  /** Games with no invariant failure of any kind. The acceptance criterion. */
  cleanGames: z.number().int().min(0),
  /** Every invariant failure in the run, with the match it came from. */
  invariantFailures: z.array(
    z.strictObject({
      matchId: z.string(),
      firstSeatDeckId: z.string(),
      secondSeatDeckId: z.string(),
      detail: z.string(),
      replayPath: z.string().nullable(),
    }),
  ),
});
export type MatchupMatrix = z.infer<typeof matchupMatrixSchema>;

export interface BuildMatchupMatrixInputs {
  readonly experimentId: string;
  readonly seed: string;
  readonly configHash: string;
  readonly environmentId: string;
  readonly environmentHash: string;
  readonly formatId: string;
  readonly decks: readonly SimDeck[];
  readonly precons: readonly ResolvedPrecon[];
  readonly records: readonly MatchRecord[];
}

/**
 * The record's board telemetry, projected to what a matrix cell shows (M04.3).
 *
 * A projection and not a re-measurement: every figure is copied from the block
 * the collector produced, so a cell cannot disagree with the record or the
 * replay beside it. `peakUnits` is the widest board *either* seat held, because
 * the question a cell answers is what this pairing did to the battlefield.
 */
function boardOf(record: MatchRecord): MatchupBoard {
  let peakUnits = 0;
  let peakTokenStack = 0;
  for (const seat of record.board.seats) {
    if (seat.peakUnits > peakUnits) peakUnits = seat.peakUnits;
    if (seat.peakTokenStack > peakTokenStack) peakTokenStack = seat.peakTokenStack;
  }
  return {
    peakUnits,
    peakTokenStack,
    longestTurnActions: record.board.longestTurn.actions,
    largestCombatAttackers: record.board.largestCombat.attackers,
    busiestTurnTriggers: record.board.busiestTurn.triggers,
    stallClassification: record.board.attackOpportunity.classification,
    stallStreak: record.board.attackOpportunity.longestUnanimousDeclinedStreak,
  };
}

/** What disqualifies a game from being a clean, deterministic termination. */
function invariantFailuresOf(record: MatchRecord): string[] {
  const failures: string[] = [];
  if (isAbnormal(record.termination)) failures.push(`termination:${record.termination}`);
  for (const diagnostic of record.diagnostics) failures.push(`diagnostic:${diagnostic}`);
  for (const failure of record.botFailures) {
    failures.push(
      `bot_${failure.kind}:${failure.botId} (${failure.playerId}) at decision ` +
        `${failure.decisionIndex}: ${failure.message}`,
    );
  }
  return failures;
}

export function buildMatchupMatrix(inputs: BuildMatchupMatrixInputs): MatchupMatrix {
  const preconByDeckHash = new Map(
    inputs.precons.map((precon) => [precon.deckHash, precon.preconId] as const),
  );

  // The axis is sorted by deck ID so the grid is byte-stable however the deck
  // source happened to order its decks, and readable: a precon deck's ID is its
  // permanent precon ID.
  const decks: MatchupDeck[] = [...inputs.decks]
    .map((deck) => ({
      deckId: deck.id,
      deckHash: deck.hash,
      commanderId: deck.commanderId,
      label: deck.label,
      preconId: preconByDeckHash.get(deck.hash) ?? null,
    }))
    .sort(
      (left, right) =>
        left.deckId.localeCompare(right.deckId) || left.deckHash.localeCompare(right.deckHash),
    );

  const deckIdByHash = new Map(decks.map((deck) => [deck.deckHash, deck.deckId] as const));

  const games = new Map<string, MatchupGame[]>();
  const key = (first: string, second: string): string => `${first} ${second}`;

  for (const record of inputs.records) {
    const seats = [...record.seats].sort((left, right) => left.seatIndex - right.seatIndex);
    const first = seats[0];
    const second = seats[1];
    // A matrix is defined over ordered *pairs*; a table with any other number of
    // seats is not a cell of one and is left out rather than folded in.
    if (!first || !second || seats.length !== 2) continue;
    const firstDeckId = deckIdByHash.get(first.deckHash);
    const secondDeckId = deckIdByHash.get(second.deckHash);
    if (firstDeckId === undefined || secondDeckId === undefined) continue;

    const winnerSeat = seats.find((seat) => seat.playerId === record.winnerId) ?? null;
    const game: MatchupGame = {
      matchId: record.matchId,
      gameIndex: record.gameIndex,
      orientation: record.orientation,
      seats: seats.map((seat) => ({
        playerId: seat.playerId,
        seatIndex: seat.seatIndex,
        deckId: seat.deckId,
        deckHash: seat.deckHash,
        commanderId: seat.commanderId,
        pilotId: seat.pilotId,
        pilotVersion: seat.pilotVersion,
        pilotSeed: seat.pilotSeed,
        won: seat.won,
      })),
      startingPlayerId: record.startingPlayerId,
      seeds: record.seeds,
      termination: record.termination,
      outcome: record.outcome,
      winnerId: record.winnerId,
      winnerDeckId: winnerSeat ? (deckIdByHash.get(winnerSeat.deckHash) ?? null) : null,
      endReason: record.endReason,
      turns: record.turns,
      invariantFailures: invariantFailuresOf(record),
      replayPath: record.replayPath,
      board: boardOf(record),
    };

    const cellKey = key(firstDeckId, secondDeckId);
    games.set(cellKey, [...(games.get(cellKey) ?? []), game]);
  }

  const cells: MatchupCell[] = [];
  const missing: string[] = [];

  for (const first of decks) {
    for (const second of decks) {
      // Sorted here rather than trusted from the caller, so the artifact is
      // independent of the order results arrived in — the same property that
      // makes the aggregates worker-count invariant, held by this file itself.
      const played = [...(games.get(key(first.deckId, second.deckId)) ?? [])].sort(
        (left, right) =>
          left.gameIndex - right.gameIndex || left.matchId.localeCompare(right.matchId),
      );
      if (played.length === 0) {
        missing.push(`${first.deckId} -> ${second.deckId}`);
        continue;
      }
      cells.push({
        firstSeatDeckId: first.deckId,
        secondSeatDeckId: second.deckId,
        firstSeatDeckHash: first.deckHash,
        secondSeatDeckHash: second.deckHash,
        mirror: first.deckHash === second.deckHash,
        games: played,
        // A mirror's "first seat won" is a statement about the seat, not the
        // deck, which is the only thing a mirror can be evidence about at all.
        firstSeatWins: played.filter((game) => game.seats[0]?.won === true).length,
        secondSeatWins: played.filter((game) => game.seats[1]?.won === true).length,
        draws: played.filter((game) => game.outcome === 'draw').length,
        unclean: played.filter((game) => game.invariantFailures.length > 0).length,
      });
    }
  }

  const allGames = cells.flatMap((cell) => cell.games);

  return {
    schemaVersion: MATCHUP_MATRIX_SCHEMA_VERSION,
    experimentId: inputs.experimentId,
    seed: inputs.seed,
    configHash: inputs.configHash,
    environmentId: inputs.environmentId,
    environmentHash: inputs.environmentHash,
    formatId: inputs.formatId,
    pilots: pilotsOf(inputs.records),
    decks,
    cells,
    expectedCells: decks.length * decks.length,
    playedCells: cells.length,
    complete: missing.length === 0,
    missing,
    games: allGames.length,
    cleanGames: allGames.filter((game) => game.invariantFailures.length === 0).length,
    invariantFailures: cells.flatMap((cell) =>
      cell.games.flatMap((game) =>
        game.invariantFailures.map((detail) => ({
          matchId: game.matchId,
          firstSeatDeckId: cell.firstSeatDeckId,
          secondSeatDeckId: cell.secondSeatDeckId,
          detail,
          replayPath: game.replayPath,
        })),
      ),
    ),
  };
}

/** Pilots as they actually played, read off the records rather than the config. */
function pilotsOf(records: readonly MatchRecord[]): { id: string; version: string }[] {
  const versions = new Map<string, string>();
  for (const record of records) {
    for (const seat of record.seats) {
      if (!versions.has(seat.pilotId)) versions.set(seat.pilotId, seat.pilotVersion);
    }
  }
  return [...versions.entries()]
    .map(([id, version]) => ({ id, version }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** One row per game: the flat export the CSVs elsewhere in a run are written for. */
export interface MatchupMatrixRow {
  readonly firstSeatDeckId: string;
  readonly secondSeatDeckId: string;
  readonly mirror: boolean;
  readonly matchId: string;
  readonly gameIndex: number;
  readonly orientation: number;
  readonly startingPlayerId: string;
  readonly seedPath: string;
  readonly matchSeed: string;
  readonly winnerDeckId: string | null;
  readonly winnerSeatIndex: number | null;
  readonly termination: string;
  readonly outcome: string;
  readonly turns: number;
  readonly invariantFailures: string;
  readonly replayPath: string | null;
  /* --------------------------------------------- unlimited board (M04.3) */
  readonly peakUnits: number;
  readonly peakTokenStack: number;
  readonly longestTurnActions: number;
  readonly largestCombatAttackers: number;
  readonly busiestTurnTriggers: number;
  readonly stallClassification: string;
  readonly stallStreak: number;
}

export function matchupMatrixRows(matrix: MatchupMatrix): MatchupMatrixRow[] {
  return matrix.cells.flatMap((cell) =>
    cell.games.map((game) => {
      const winnerSeat = game.seats.find((seat) => seat.won);
      return {
        firstSeatDeckId: cell.firstSeatDeckId,
        secondSeatDeckId: cell.secondSeatDeckId,
        mirror: cell.mirror,
        matchId: game.matchId,
        gameIndex: game.gameIndex,
        orientation: game.orientation,
        startingPlayerId: game.startingPlayerId,
        seedPath: game.seeds.path,
        matchSeed: game.seeds.matchSeed,
        winnerDeckId: game.winnerDeckId,
        winnerSeatIndex: winnerSeat ? winnerSeat.seatIndex : null,
        termination: game.termination,
        outcome: game.outcome,
        turns: game.turns,
        invariantFailures: game.invariantFailures.join(' | '),
        replayPath: game.replayPath,
        peakUnits: game.board.peakUnits,
        peakTokenStack: game.board.peakTokenStack,
        longestTurnActions: game.board.longestTurnActions,
        largestCombatAttackers: game.board.largestCombatAttackers,
        busiestTurnTriggers: game.board.busiestTurnTriggers,
        stallClassification: game.board.stallClassification,
        stallStreak: game.board.stallStreak,
      };
    }),
  );
}
