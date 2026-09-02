import { z } from 'zod';

import { experimentKindSchema, experimentPurposeSchema, stageIdSchema } from './identity.js';

/**
 * How much work a configuration schedules, said in a shape a screen can render
 * without doing arithmetic of its own.
 *
 * This file holds the **answer's shape**, never the answer. The number itself is
 * produced in `apps/admin-server` by building the real schedule with
 * `buildSchedule` and counting it, which is what
 * [ADR 0023](../../../docs/architecture/0023-admin-lab-boundary.md) §2 requires:
 * *the match-count estimator M08.3 needs is derived from `buildSchedule` — the
 * function that produces the real schedule — rather than from a formula written
 * a second time next to it.* Nothing here multiplies anything, and a client that
 * imported this package could not compute an estimate if it wanted to — there is
 * no scheduler in it, and the simulator is server-only.
 *
 * Three things the milestone asks for are properties of this shape rather than
 * of the code that fills it:
 *
 * - **Games are reported per seat order.** `seatOrders` is a breakdown by
 *   orientation and not a single conflated total, because "40 matches" and
 *   "20 matches in each of two seat orders" are different facts about a run and
 *   only the second one says whether a seat advantage could be measured.
 * - **A bound is labelled a bound.** `basis` is on every stage and on the total,
 *   and the combination rule is `combineBases` below rather than an assumption
 *   at each call site.
 * - **A forced-inclusion floor is reported per Commander.** It is read from
 *   `poolReportFor` and never recomputed; this schema is its transport.
 */

/* ------------------------------------------------------------------- basis */

/**
 * What the number in front of it actually claims.
 *
 * Three values rather than a boolean, because "we could not count all of it" and
 * "we counted an over-estimate" are opposite errors and a reader acts differently
 * on each. A precon benchmark is `exact` — its schedule is a pure function of a
 * configuration whose decks are known before anything runs. A search is
 * `upper_bound`: its opponent field is drawn from an archive that overlaps the
 * population, so some of the pairings the schedule allows for will collapse. A
 * replacement is `at_least`: the number of variants depends on which comparable
 * cards the builder finds, and every one of them adds matches.
 */
export const ESTIMATE_BASES = ['exact', 'upper_bound', 'at_least'] as const;
export const estimateBasisSchema = z.enum(ESTIMATE_BASES);
export type EstimateBasis = z.infer<typeof estimateBasisSchema>;

/**
 * The basis of a total made of stages with these bases.
 *
 * `at_least` wins over everything, including `upper_bound`: a total containing
 * one part that could grow without limit cannot be an upper bound on the whole,
 * whatever the other parts are. This is the rule a screen would otherwise have
 * to re-derive, and getting it backwards is exactly how an honest bound turns
 * into a confident wrong number.
 */
export function combineBases(bases: readonly EstimateBasis[]): EstimateBasis {
  if (bases.includes('at_least')) return 'at_least';
  if (bases.includes('upper_bound')) return 'upper_bound';
  return 'exact';
}

/** The sentence a screen puts in front of a bound, so every screen uses one wording. */
export const BASIS_WORDING: Readonly<Record<EstimateBasis, string>> = Object.freeze({
  exact: 'exactly',
  upper_bound: 'no more than',
  at_least: 'at least',
});

/* -------------------------------------------------------------- seat orders */

/**
 * Matches in one seat orientation.
 *
 * `orientation` is the rotation index `buildSchedule` stamps on every match, so
 * this breakdown is a count of the real schedule grouped by a real field, not a
 * division of a total by the number of seats. They differ whenever the schedule
 * contains a mirror matchup: rotating a deck against a copy of itself gives the
 * same table back, so a mirror contributes to orientation 0 alone.
 */
export const seatOrderCountSchema = z.strictObject({
  orientation: z.number().int().min(0).max(3),
  matches: z.number().int().min(0).max(100_000_000),
});
export type SeatOrderCount = z.infer<typeof seatOrderCountSchema>;

/* ------------------------------------------------------------- deck counts */

/** How a stage's deck count was arrived at, because some of them are not knowable. */
export const DECK_COUNT_SOURCES = [
  /** Named precons, resolved against the environment the run will use. */
  'resolved_precons',
  /** Decks written into the configuration and validated. */
  'resolved_inline',
  /** Decks the run will generate. The request is known; the yield is not. */
  'requested_generation',
  /** Deck files the configuration names. Not resolvable from the admin surface. */
  'declared_files',
  /** A population the search breeds, described by its configured size. */
  'search_population',
] as const;
export const deckCountSourceSchema = z.enum(DECK_COUNT_SOURCES);
export type DeckCountSource = z.infer<typeof deckCountSourceSchema>;

export const deckCountSchema = z.strictObject({
  count: z.number().int().min(0).max(100_000),
  source: deckCountSourceSchema,
  basis: estimateBasisSchema,
  /** Decks the source named and the environment refused. Never silently dropped. */
  rejected: z.array(z.string().min(1).max(200)).max(64).default([]),
});
export type DeckCount = z.infer<typeof deckCountSchema>;

/* ----------------------------------------------------------------- a stage */

/**
 * One declared part of the work, counted.
 *
 * A stage is a unit of the **plan** rather than of the schedule: a search
 * replicate is one stage covering all of its generations, not one stage per
 * generation, because a job with five hundred stages is a list nobody reads and
 * the generations are the same shape on different seed families. `repeats` says
 * how many times the counted schedule runs, and `matches` is already multiplied
 * out — a screen never has to.
 */
export const estimateStageSchema = z
  .strictObject({
    stageId: stageIdSchema,
    label: z.string().min(1).max(160),
    kind: experimentKindSchema,
    /**
     * Whether this stage's games are the ones that *chose* what it measures.
     *
     * The locked interpretation keeps discovery and validation apart, and a
     * stage is the smallest thing that can honestly carry the distinction: a
     * Commander Search's search stages are `exploration` and its championship is
     * `validation`, and they belong to one job.
     */
    purpose: experimentPurposeSchema,
    matches: z.number().int().min(0).max(100_000_000),
    basis: estimateBasisSchema,
    /** Why the count is a bound. Required when it is one; empty when it is exact. */
    reason: z.string().max(400).default(''),
    seatOrders: z.array(seatOrderCountSchema).max(4).default([]),
    /** Games per deck tuple, per pilot tuple, per seat order — `buildSchedule`'s own unit. */
    gamesPerSeatOrder: z.number().int().min(0).max(10_000),
    decks: deckCountSchema,
    /** Pilot tuples the pairing mode produces. One row of the schedule per tuple. */
    pilotTuples: z.number().int().min(0).max(100_000),
    /** How many times the counted schedule runs: generations, replicates, profiles. */
    repeats: z.number().int().min(0).max(100_000),
  })
  .refine(
    (stage) => stage.basis === 'exact' || stage.reason.length > 0,
    'A stage whose count is a bound has to say why it is one.',
  )
  .refine(
    (stage) =>
      stage.seatOrders.length === 0 ||
      stage.seatOrders.reduce((sum, entry) => sum + entry.matches, 0) === stage.matches,
    'The seat-order breakdown has to add up to the stage total.',
  )
  .refine(
    (stage) =>
      new Set(stage.seatOrders.map((entry) => entry.orientation)).size === stage.seatOrders.length,
    'Each seat orientation appears at most once.',
  );
export type EstimateStage = z.infer<typeof estimateStageSchema>;

/* ------------------------------------------------------- forced inclusion */

/**
 * What the format left one Commander to work with.
 *
 * Every field is copied from `poolReportFor` in `@tcg/deck-generator`, which is
 * where the arithmetic lives and where it stays: this is the transport, and the
 * admin-server test asserts the two agree field for field. The floor matters
 * because Wave 1's Commander-legal pools are 41–42 cards for a 40-card singleton
 * deck, so two legal decks under one Commander share at least 38 of their 40
 * cards whatever either of them was trying to do.
 */
export const forcedInclusionFloorSchema = z.strictObject({
  commanderId: z.string().min(1).max(64),
  /** Distinct cards the format leaves legal under this Commander. */
  legalPoolSize: z.number().int().min(0).max(100_000),
  /** Total copies those cards can supply, after copy limits. */
  poolCapacity: z.number().int().min(0).max(1_000_000),
  deckSize: z.number().int().min(1).max(1000),
  /** Copies a deck may leave out. */
  slack: z.number().int().min(0).max(1_000_000),
  /** Copies any two legal decks under this Commander must have in common. */
  forcedInclusionFloor: z.number().int().min(0).max(1_000_000),
});
export type ForcedInclusionFloor = z.infer<typeof forcedInclusionFloorSchema>;

/**
 * The one sentence every view that shows a selection statistic puts beside it.
 *
 * A constant rather than prose each screen writes for itself, because the
 * milestone's locked interpretation is a rule about what a number may be read to
 * mean — *search reports must display the forced-inclusion floor and must not
 * read near-universal card inclusion as preference* — and a rule restated in six
 * places is a rule that will be worded five ways.
 */
export const FORCED_INCLUSION_CAVEAT =
  'A card that appears in nearly every deck under a Commander may be there because the ' +
  'legal pool is barely larger than a legal deck, not because anything chose it. Read ' +
  'inclusion against the forced-inclusion floor, never on its own.';

/* -------------------------------------------------------------- the answer */

export const matchCountEstimateSchema = z
  .strictObject({
    /** Matches the whole configuration schedules, already summed over stages. */
    totalMatches: z.number().int().min(0).max(100_000_000),
    basis: estimateBasisSchema,
    stages: z.array(estimateStageSchema).min(1).max(256),
    /**
     * One row per Commander the configuration can put on the table.
     *
     * Empty is legal and means the configuration does not fix its Commanders —
     * an unconstrained search chooses them as it goes — which is itself worth
     * showing rather than hiding behind a zero.
     */
    forcedInclusion: z.array(forcedInclusionFloorSchema).max(256).default([]),
    /** What this estimate cannot promise, in the words the reader should get. */
    limitations: z.array(z.string().min(1).max(400)).max(32).default([]),
  })
  .refine(
    (estimate) =>
      estimate.totalMatches === estimate.stages.reduce((sum, stage) => sum + stage.matches, 0),
    'The total has to be the sum of the stages it is made of.',
  )
  .refine(
    (estimate) => estimate.basis === combineBases(estimate.stages.map((stage) => stage.basis)),
    'The total’s basis has to be the combination of its stages’ bases.',
  );
export type MatchCountEstimate = z.infer<typeof matchCountEstimateSchema>;

/**
 * What an `adaptive_counter` choice would spend, said in `AdaptiveBudgetPlan`'s
 * own terms rather than `matchCountEstimateSchema`'s.
 *
 * An adaptive run has no stage list to count a schedule from — its games are
 * spent block by block as evaluation decides each one, not scheduled up
 * front — so `totalMatches`/`stages`/`forcedInclusion` do not apply. What is
 * knowable before anything runs is `planAdaptiveBudget`'s own answer: how
 * many whole blocks the declared `totalLearningBudget` affords, and the
 * explained leftover when it does not divide evenly. This is that answer's
 * transport, plus the separately-budgeted final validation stage the
 * milestone asks a builder to show workload for.
 */
export const adaptiveWorkloadEstimateSchema = z
  .strictObject({
    /** Games one mirrored evaluation block spends: `blockSize x (mirrorSeats ? 2 : 1)`. */
    gamesPerBlock: z.number().int().min(0).max(1_000_000),
    /** Whole blocks `totalLearningBudget` affords. */
    blocksScheduled: z.number().int().min(0).max(1_000_000),
    gamesScheduled: z.number().int().min(0).max(1_000_000_000),
    /** Games left over when the budget does not divide evenly into whole blocks. */
    gamesUnspent: z.number().int().min(0).max(1_000_000),
    /** Why `gamesUnspent` is nonzero. Empty when the budget divides evenly. */
    shortfallReason: z.string().max(600).default(''),
    /** Games per pairing in the frozen fresh-seed final validation stage, reported separately from the learning budget above. */
    finalValidationGames: z.number().int().min(1).max(100_000),
    limitations: z.array(z.string().min(1).max(400)).max(32).default([]),
  })
  .refine(
    (estimate) => (estimate.gamesUnspent === 0) === (estimate.shortfallReason.length === 0),
    '`shortfallReason` is required exactly when `gamesUnspent` is nonzero.',
  );
export type AdaptiveWorkloadEstimate = z.infer<typeof adaptiveWorkloadEstimateSchema>;
