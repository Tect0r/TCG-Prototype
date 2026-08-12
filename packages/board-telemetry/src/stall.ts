import { z } from 'zod';

/**
 * The configured stall definition (M04.3, answering Q43).
 *
 * Q43 asked what counts as a board stall, and its own framing is the constraint
 * this module exists to satisfy: it must be "one explicit, configurable,
 * versioned number rather than a judgement made in the reporting layer". So the
 * rule lives here, beside the evidence it reads, and every document that carries
 * a verdict carries the definition that produced it. A report renders the answer;
 * it never decides it.
 *
 * The answer is the **strict** reading. A round counts toward a stall only when
 * every living seat reached its attack step, every one of them could legally have
 * attacked, and none of them did. Three consecutive such rounds is a stall.
 *
 * Four things follow from that, and each was chosen rather than inherited:
 *
 * - **It is about ability, not silence.** The baseline counted rounds with no
 *   declared attacker, which added "nobody could" to "nobody would" and called
 *   the sum a stall. `seatsAble === seatsAsked` is the opposite test: the board
 *   was capable of combat and combat did not happen.
 * - **The opening excludes itself.** There is no round-index special case. An
 *   empty board is never able and a board that all arrived this turn is held by
 *   `Newly Deployed`, so round 1 fails eligibility for the same reason any other
 *   round would. The traces in `docs/open-questions.md` are what settled this:
 *   round 1 scored zero able seats in both of them.
 * - **A single attacker breaks it.** `attackers > 0` ends the streak, one Token
 *   included. "Quiet" stays a fact about the event stream rather than a second
 *   threshold with its own rationale to defend.
 * - **It almost never fires on a wide table**, which is the point. Four seats all
 *   able and all declining, three rounds running, is a strong claim; the traced
 *   precon matches never got past one such round and ended in 53- and 64-attacker
 *   combats. A metric that cannot say "no" is not evidence.
 */

/**
 * The eligibility rule, versioned separately from the number it applies to.
 *
 * `thresholdRounds` is configuration and may differ between runs; the rule that
 * decides *which rounds are counted at all* is not, because changing it changes
 * what the number means. A build that re-cuts eligibility bumps this and every
 * artefact carrying a verdict says which rule produced it.
 */
export const STALL_DEFINITION_VERSION = 1;

/** Every living seat was asked, every one could attack, and none did. */
export const STALL_ELIGIBILITY = 'every_living_seat_able';

export const stallDefinitionSchema = z.strictObject({
  version: z.literal(STALL_DEFINITION_VERSION),
  eligibility: z.literal(STALL_ELIGIBILITY),
  /** Consecutive eligible rounds that make a stall. */
  thresholdRounds: z.number().int().min(1),
});
export type StallDefinition = z.infer<typeof stallDefinitionSchema>;

/** The shipped rule: strict eligibility, three rounds (Q43, 2026-08-12). */
export const DEFAULT_STALL_DEFINITION: StallDefinition = Object.freeze({
  version: STALL_DEFINITION_VERSION,
  eligibility: STALL_ELIGIBILITY,
  thresholdRounds: 3,
});

/**
 * The verdict.
 *
 * Two values and no third. `'undetermined'` was M04.2's placeholder and is gone:
 * the rule exists now, so every match gets an answer, and a consumer that finds
 * one can read the `stallDefinition` beside it to see what was asked.
 */
export const STALL_CLASSIFICATIONS = ['stalled', 'not_stalled'] as const;
export const stallClassificationSchema = z.enum(STALL_CLASSIFICATIONS);
export type StallClassification = z.infer<typeof stallClassificationSchema>;

/** The four counts eligibility is decided from. A structural subset of a round. */
export interface StallRoundInput {
  /** Seats that reached an attack step this round. */
  readonly seatsAsked: number;
  /** Of those, seats with a legal attacker and a legal defender. */
  readonly seatsAble: number;
  /** Seats not yet eliminated when the round began. */
  readonly livingSeats: number;
  /** Attackers declared this round, by anybody. */
  readonly attackers: number;
}

/**
 * Whether this round counts toward the stall streak.
 *
 * A round that fails any clause is not neutral — it **breaks** the streak, the
 * same way a round somebody attacked in does. "Three consecutive rounds" is a
 * claim about an uninterrupted run, and a round that was interrupted by an
 * elimination, by a seat that never reached its attack step, or by a seat that
 * could not have attacked is an interruption whatever else it was.
 */
export function roundIsStallEligible(round: StallRoundInput): boolean {
  // One declared attacker, Token included, and the board was not quiet.
  if (round.attackers > 0) return false;
  // Nobody was asked: the match ended in this round, or never reached combat.
  // There is no decision to attribute, so there is nothing to call a stall.
  if (round.seatsAsked === 0) return false;
  // A seat that was alive and did not reach its attack step means the round did
  // not put the question to the whole table.
  if (round.seatsAsked !== round.livingSeats) return false;
  // The strict clause: every seat that was asked could have attacked.
  return round.seatsAble === round.seatsAsked;
}

/**
 * The longest run of consecutive eligible rounds, in round order.
 *
 * Separated from `classifyStall` so the raw streak is stored beside the verdict
 * and a reader can re-apply a different threshold without re-simulating.
 */
export function longestStallStreak(rounds: readonly StallRoundInput[]): number {
  let longest = 0;
  let current = 0;
  for (const round of rounds) {
    if (roundIsStallEligible(round)) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

/** The verdict, from the raw streak and the configured number. */
export function classifyStall(
  streak: number,
  definition: StallDefinition = DEFAULT_STALL_DEFINITION,
): StallClassification {
  return streak >= definition.thresholdRounds ? 'stalled' : 'not_stalled';
}

/** One line naming the rule, for a report or a CLI that prints a verdict. */
export function describeStallDefinition(definition: StallDefinition): string {
  return (
    `${definition.thresholdRounds} consecutive round(s) in which every living seat reached ` +
    'its attack step, every one of them could legally have attacked, and none did ' +
    `(rule ${definition.eligibility}, v${definition.version})`
  );
}
