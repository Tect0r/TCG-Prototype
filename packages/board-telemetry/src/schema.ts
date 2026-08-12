import { z } from 'zod';
import { cardIdSchema } from '@tcg/card-data';
import { playerIdSchema } from '@tcg/rules-engine';
import {
  DEFAULT_STALL_DEFINITION,
  stallClassificationSchema,
  stallDefinitionSchema,
} from './stall.js';

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
 * - **Policy invented here.** Since M04.3 there is exactly one verdict in this
 *   document — `attackOpportunity.classification` — and it is not this schema's
 *   opinion: it is `@tcg/board-telemetry/stall`'s configured rule, recorded
 *   beside the answer as `stallDefinition` so no number can be read without the
 *   definition that produced it. Everything else remains a count, including the
 *   raw streak the verdict was cut from, so a different threshold can be applied
 *   to a finished document without re-simulating the match.
 */

/**
 * Version 2: attack opportunity (M04.2).
 *
 * Version 1 could say nobody attacked and nothing about whether anybody could,
 * so a quiet round was unreadable — a ruleset holding a fresh board back and a
 * table of players declining looked the same. Version 2 adds the
 * `attackOpportunity` block and per-seat opportunity counts, all raw.
 *
 * It is carried inside the document rather than only by the artefacts that embed
 * it, because a board-telemetry block is routinely lifted out of its replay or
 * its match record and aggregated somewhere else, at which point the surrounding
 * version is gone. Consumers state the version policy for their own artefact —
 * see `SPECTATOR_REPLAY_VERSION` and `TELEMETRY_SCHEMA_VERSION`.
 *
 * Version 3: the configured stall definition (M04.3, answering Q43).
 *
 * A version 2 document holds `classification: 'undetermined'` and no
 * `stallDefinition`, and it cannot be upgraded by re-reading it: eligibility is
 * decided per round from `livingSeats`, which version 2 never recorded, so the
 * seats a round *should* have asked are unknown for any match that lost a player.
 * Refused rather than migrated, on the same terms as versions 2 and 3 of the
 * artefacts that carry it.
 */
export const BOARD_TELEMETRY_VERSION = 3;

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
   * Times this seat was asked to declare attackers, and what it could do with
   * each of those turns (M04.2).
   *
   * Per seat as well as per round because the round series cannot say *who*
   * declined: on a four-seat table one player sandbagging behind a wide board and
   * three players with nothing to attack with produce the same quiet round, and
   * they are opposite findings about an unbounded battlefield. `able + unable`
   * equals `attackSteps` exactly; `declined` is a subset of `able`.
   */
  attackSteps: z.number().int().min(0),
  /** Attack steps where this seat had a legal attacker and a legal defender. */
  attackStepsAble: z.number().int().min(0),
  /** Attack steps where it could not attack at all, for any reason. */
  attackStepsUnable: z.number().int().min(0),
  /** Attack steps where it could attack and declared nothing. */
  attackStepsDeclined: z.number().int().min(0),
  /** Total attackers this seat declared, across every attack step. */
  attackersDeclared: z.number().int().min(0),
  /**
   * Ready Steps of this seat's permanents that an effect rewrote (M02.4).
   *
   * The "combat was prevented by an effect" evidence, counted from
   * `ready_prevented` rather than inferred from a Unit being Exhausted, because a
   * Unit that attacked last turn and a Unit somebody paid to keep Exhausted are
   * the same board and different findings.
   */
  readyPreventions: z.number().int().min(0),
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

/**
 * One round's attack opportunity, as the engine reported it (M04.2).
 *
 * Every field is a count of `attack_opportunity` events, which the engine emits
 * from the board a seat was looking at when it declared. The five outcome
 * counters partition `seatsAsked` exactly — able, no Units, all Exhausted, held
 * by Newly Deployed, no defender — so a reader can tell which of M04.2's four
 * situations a quiet round was without re-deriving any rule, and a round that
 * does not add up is a defect rather than a judgement call.
 *
 * A seat that never reached its attack step is not counted at all. A turn that
 * ended in combat before the declaration, a seat eliminated mid-turn and a match
 * that ended in Main Phase 1 all leave no census, which is correct: no decision
 * was taken, so there is nothing to attribute.
 */
export const roundAttackOpportunitySchema = z.strictObject({
  /** 1-based, matching `attackersByRound`'s index 0. */
  round: z.number().int().min(1),
  /**
   * Seats not yet eliminated when this round began (M04.3).
   *
   * Recorded because stall eligibility asks whether the round put the question to
   * the *whole table*, which `seatsAsked` alone cannot answer: three seats asked
   * is unanimous on a three-seat table and a missing seat on a four-seat one.
   * Taken at the start of the round rather than the end, so a seat that was
   * eliminated after taking its turn still counts as one the round asked.
   *
   * Declared before `seatsAsked` because the collector builds the object in that
   * order, and `strictObject` emits keys in schema order: a record that has been
   * round-tripped through this schema must serialize byte-identically to the one
   * the collector produced, or the worker-count and on-disk determinism checks
   * fail on key order alone.
   */
  livingSeats: z.number().int().min(0),
  /** Seats that reached an attack step this round. */
  seatsAsked: z.number().int().min(0),
  /** Seats with at least one legal attacker and at least one legal defender. */
  seatsAble: z.number().int().min(0),
  /**
   * Seats that were able to attack and declared nothing.
   *
   * The one case the baseline could not see. A round with `seatsDeclining > 0` is
   * a round somebody chose to be quiet in.
   */
  seatsDeclining: z.number().int().min(0),
  /** Seats asked while controlling no Unit at all: early development. */
  seatsWithoutUnits: z.number().int().min(0),
  /** Seats whose Units were all Exhausted. */
  seatsAllExhausted: z.number().int().min(0),
  /** Seats whose only Ready Units were held by `Newly Deployed` without Rush. */
  seatsNewlyDeployed: z.number().int().min(0),
  /** Seats with a legal attacker and no living opponent left to attack. */
  seatsWithoutDefender: z.number().int().min(0),
  /** Ready Steps an effect rewrote this round, across every seat. */
  readyPreventions: z.number().int().min(0),
  /** Attackers declared this round. Equals `attackersByRound[round - 1]`. */
  attackers: z.number().int().min(0),
  /**
   * Whether this round counted toward the stall streak (M04.3).
   *
   * Derived from the counts above by `roundIsStallEligible` and stored rather
   * than left to the reader, so the verdict is auditable round by round: a match
   * classified `'stalled'` names the rounds that made it one, and a match that
   * was not can be checked for near misses without re-deriving the rule.
   */
  stallEligible: z.boolean(),
});
export type RoundAttackOpportunity = z.infer<typeof roundAttackOpportunitySchema>;

export { stallClassificationSchema };

/**
 * Attack opportunity across the whole match (M04.2).
 *
 * This block replaces "three rounds without attackers is a stall", which was a
 * threshold over silence and could not tell M04.2's four situations apart. The
 * streaks here are still raw: each is the longest run of *quiet* rounds of one
 * kind, and none of them is compared with anything.
 */
export const attackOpportunitySchema = z.strictObject({
  /** Attack steps observed across every seat. */
  steps: z.number().int().min(0),
  /** Steps where a seat could have attacked. */
  able: z.number().int().min(0),
  /** Steps where a seat that could have attacked declared nothing. */
  declined: z.number().int().min(0),
  /** Steps where a seat could not attack at all. */
  unable: z.number().int().min(0),
  /** Ready Steps an effect rewrote in the whole match. */
  readyPreventions: z.number().int().min(0),
  byRound: z.array(roundAttackOpportunitySchema),
  /**
   * The longest run of quiet rounds in which at least one asked seat could have
   * attacked.
   *
   * The permissive reading of "somebody declined", and **not** the one Q43 chose.
   * Kept because it is the wider series the strict streak below is a subset of,
   * and because a match where one seat repeatedly declines behind a wide board is
   * a finding worth seeing even when the rest of the table could not have
   * attacked anyway.
   */
  longestDeclinedStreak: z.number().int().min(0),
  /**
   * The longest run of quiet rounds in which no asked seat could attack.
   *
   * Kept separate from the declined streak because the two are opposite findings
   * that the baseline's single number added together: this one is the ruleset or
   * an effect working, not a board nobody wanted to commit.
   */
  longestUnableStreak: z.number().int().min(0),
  /**
   * The longest run of rounds that satisfied the configured stall rule (M04.3).
   *
   * The series `classification` is cut from, stored raw so a reader can apply a
   * different `thresholdRounds` to a finished document without re-simulating. It
   * is a subset of `longestDeclinedStreak` by construction: every round where
   * *every* asked seat was able is a round where at least one was.
   */
  longestUnanimousDeclinedStreak: z.number().int().min(0),
  /**
   * The rule that produced `classification`, carried with the answer (M04.3).
   *
   * Q43 required the threshold to be explicit, configurable and versioned rather
   * than a judgement made in the reporting layer. A verdict travelling without
   * its definition would be exactly that judgement, one artefact later.
   */
  stallDefinition: stallDefinitionSchema,
  /** The verdict. See `stall.ts`; `not_stalled` is a real answer, not a default. */
  classification: stallClassificationSchema,
});
export type AttackOpportunity = z.infer<typeof attackOpportunitySchema>;

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
   * as quiet merely because one seat had nothing to attack with. **Still not a
   * stall**, and since M04.3 that is a statement about a rule that exists rather
   * than one that is pending: the verdict reads
   * `attackOpportunity.longestUnanimousDeclinedStreak`, which counts only the
   * rounds the whole living table could have attacked in. Kept beside `attackOpportunity` rather than
   * replaced by it, because it is the one number every earlier measurement was
   * expressed in. It is *not* the sum of the two streaks below: a quiet round no
   * seat was asked in counts here and belongs to neither of them.
   */
  longestStallRounds: z.number().int().min(0),
  /**
   * Why the quiet rounds were quiet (M04.2).
   *
   * The evidence `longestStallRounds` could not carry. See
   * `attackOpportunitySchema`.
   */
  attackOpportunity: attackOpportunitySchema,
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
    attackOpportunity: {
      steps: 0,
      able: 0,
      declined: 0,
      unable: 0,
      readyPreventions: 0,
      byRound: [],
      longestDeclinedStreak: 0,
      longestUnableStreak: 0,
      longestUnanimousDeclinedStreak: 0,
      stallDefinition: { ...DEFAULT_STALL_DEFINITION },
      // A match that was never played did not stall. The verdict is `not_stalled`
      // rather than absent because the schema has no absent, and a zero streak
      // against any threshold is genuinely that answer.
      classification: 'not_stalled',
    },
    largestBoardAnswer: null,
  };
}
