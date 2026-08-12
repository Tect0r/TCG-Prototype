import { z } from 'zod';
import { cardIdSchema } from '@tcg/card-data';
import { playerIdSchema } from '@tcg/rules-engine';

/**
 * The one definition of "what an unlimited battlefield did in this match"
 * (M04.1).
 *
 * Before this schema existed the numbers lived in `@tcg/spectator`, which meant
 * only a watched match produced them: a simulator batch could play ten thousand
 * games and answer nothing about board size, and the two paths had no shared
 * definition to disagree about because only one of them had a definition at all.
 * That is the wrong shape for the question M04 exists to settle, which is
 * whether the unbounded battlefield (`CLAUDE.md`, "The battlefield has no Unit
 * limit") produces clutter, long turns or trigger overload — a claim that has to
 * be measured over a batch and reproduced in a match a human can watch.
 *
 * Everything here is **raw observation derived from the authoritative event
 * stream**, never from the final board. "How many Units did this seat ever hold"
 * and "how many does it hold now" are different questions, and the first is the
 * one an unbounded battlefield has to be judged on. Deriving it from the log is
 * also what makes it impossible for these numbers to disagree with the replay
 * they ship beside.
 *
 * Two things are deliberately absent:
 *
 * - **Playback timing.** A delay a viewer chose must never reach a number that
 *   describes the match, so "longest turn" is counted in accepted actions and
 *   "combat resolution" in emitted events. There is nowhere in this shape for a
 *   millisecond to land.
 * - **Policy.** Nothing here is a verdict. `longestStallRounds` and
 *   `attackersByRound` are counts; whether a run of quiet rounds is a *stall* is
 *   Q43, is not answered here, and is M04.2/M04.3's work.
 */

/**
 * Version 1: the first shared schema.
 *
 * It is carried inside the document rather than only by the artefacts that embed
 * it, because a board-telemetry block is routinely lifted out of its replay or
 * its match record and aggregated somewhere else, at which point the surrounding
 * version is gone. Consumers state the version policy for their own artefact —
 * see `SPECTATOR_REPLAY_VERSION` and `TELEMETRY_SCHEMA_VERSION`.
 */
export const BOARD_TELEMETRY_VERSION = 1;

/** A per-seat count keyed by an engine reason string, e.g. `destroyed`. */
const reasonCountsSchema = z.record(z.string(), z.number().int().min(0));

export const boardSeatTelemetrySchema = z.strictObject({
  playerId: playerIdSchema,
  seatIndex: z.number().int().min(0),
  /** Unit count at the end of each round, index 0 being round 1. */
  unitsByRound: z.array(z.number().int().min(0)),
  peakUnits: z.number().int().min(0),
  peakNonTokenUnits: z.number().int().min(0),
  peakTokens: z.number().int().min(0),
  /**
   * The largest group of identical Tokens this seat ever controlled — what a
   * client would render as one visual stack.
   *
   * Measured from definition identity rather than from anything the UI does,
   * because the number has to mean the same thing whether or not grouping is
   * switched on (M06/Q42 does not get to move it).
   */
  peakTokenStack: z.number().int().min(0),
  peakTokensByDefinition: z.record(cardIdSchema, z.number().int().min(0)),
  /**
   * Units this seat lost since it was last at its own peak, and by what route.
   *
   * The peak-board reduction evidence: a wide board that was answered and a wide
   * board that was never challenged look identical in `peakUnits` alone. Reset
   * when the peak moves, so it always describes the *largest* board this seat
   * held rather than an earlier, smaller high-water mark.
   */
  unitsLostAfterPeak: z.number().int().min(0),
  lossReasonsAfterPeak: reasonCountsSchema,
  commanderDefeats: z.number().int().min(0),
  maxCommanderDeploymentCost: z.number().int().min(0),
  reactionsPlayed: z.number().int().min(0),
  /**
   * 1 for the first seat eliminated, 2 for the next, `null` for a survivor.
   *
   * Raw exit order rather than a placement: ranking seats is a presentation
   * decision (a spectator table shows a leaderboard, a batch record does not),
   * and the two must not be able to disagree about who went out first.
   */
  eliminatedAtSequence: z.number().int().min(1).nullable(),
});
export type BoardSeatTelemetry = z.infer<typeof boardSeatTelemetrySchema>;

/** One combat, measured from its declaration to the phase leaving it. */
export const combatTelemetrySchema = z.strictObject({
  turn: z.number().int().min(0),
  attackers: z.number().int().min(0),
  blockers: z.number().int().min(0),
  /**
   * Engine events emitted between the attack declaration and the end of that
   * combat, inclusive of the declaration.
   *
   * "Combat resolution" measured in the engine's own work rather than in wall
   * clock: a combat with forty attackers, Reaction windows and a queue of
   * on-defeat triggers is expensive in exactly this unit, and it is identical on
   * every machine.
   */
  resolutionEvents: z.number().int().min(0),
});
export type CombatTelemetry = z.infer<typeof combatTelemetrySchema>;

export const boardTelemetrySchema = z.strictObject({
  schemaVersion: z.literal(BOARD_TELEMETRY_VERSION),
  seats: z.array(boardSeatTelemetrySchema),
  turns: z.number().int().min(0),
  /** Complete cycles of the seat order, for the per-round unit counts. */
  rounds: z.number().int().min(0),
  /** Accepted actions observed. */
  actions: z.number().int().min(0),
  /** Events observed, including the ones match creation emitted. */
  events: z.number().int().min(0),
  /** Turn number with the most accepted actions, and how many. */
  longestTurn: z.strictObject({
    turn: z.number().int().min(0),
    actions: z.number().int().min(0),
  }),
  /** The combat with the most declared attackers. */
  largestCombat: combatTelemetrySchema,
  /** The combat that cost the engine the most events to resolve. */
  longestCombatResolution: combatTelemetrySchema,
  /** The turn with the most triggers, and the choices raised on that turn. */
  busiestTurn: z.strictObject({
    turn: z.number().int().min(0),
    triggers: z.number().int().min(0),
    choices: z.number().int().min(0),
  }),
  reactionWindows: z.number().int().min(0),
  reactionsPlayed: z.number().int().min(0),
  cardsCountered: z.number().int().min(0),
  /**
   * Attackers declared in each round, index 0 being round 1.
   *
   * The raw series `longestStallRounds` is derived from. Kept because a derived
   * streak cannot be re-cut once Q43 settles what eligibility means, and the
   * series can.
   */
  attackersByRound: z.array(z.number().int().min(0)),
  /**
   * The longest run of consecutive rounds in which nobody declared an attacker.
   *
   * Counted in rounds rather than turns so a three-seat table is not described
   * as quiet merely because one seat had nothing to attack with. **Not a
   * stall**: silence and inability are different, telling them apart is M04.2,
   * and the threshold that would make either a verdict is Q43.
   */
  longestStallRounds: z.number().int().min(0),
  /**
   * How the largest board any seat held was reduced, if it was.
   *
   * A summary of the widest seat's own `unitsLostAfterPeak` /
   * `lossReasonsAfterPeak`, kept alongside them so a reader does not have to
   * re-derive "who got widest" to answer the headline question.
   */
  largestBoardAnswer: z
    .strictObject({
      playerId: playerIdSchema,
      peakUnits: z.number().int().min(0),
      unitsLostAfterPeak: z.number().int().min(0),
      /** Defeat reasons, most common first, ties broken alphabetically. */
      reasons: z.array(z.string()),
    })
    .nullable(),
});
export type BoardTelemetry = z.infer<typeof boardTelemetrySchema>;

const EMPTY_COMBAT: CombatTelemetry = Object.freeze({
  turn: 0,
  attackers: 0,
  blockers: 0,
  resolutionEvents: 0,
});

/**
 * The telemetry of a match that was never played.
 *
 * Exists so a fixture or a synthetic record can satisfy the schema without
 * inventing board numbers that would then be indistinguishable from measured
 * ones — every count is zero and `largestBoardAnswer` is `null`.
 */
export function emptyBoardTelemetry(): BoardTelemetry {
  return {
    schemaVersion: BOARD_TELEMETRY_VERSION,
    seats: [],
    turns: 0,
    rounds: 0,
    actions: 0,
    events: 0,
    longestTurn: { turn: 0, actions: 0 },
    largestCombat: { ...EMPTY_COMBAT },
    longestCombatResolution: { ...EMPTY_COMBAT },
    busiestTurn: { turn: 0, triggers: 0, choices: 0 },
    reactionWindows: 0,
    reactionsPlayed: 0,
    cardsCountered: 0,
    attackersByRound: [],
    longestStallRounds: 0,
    largestBoardAnswer: null,
  };
}
