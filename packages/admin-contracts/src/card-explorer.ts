import { z } from 'zod';

import { contentIdSchema } from './content.js';
import { jobIdSchema } from './identity.js';
import { liveMatchDeckHashSchema } from './player-meta.js';
import { resultRowSchema } from './results.js';
import {
  cardExplorerRefSchema,
  deckExplorerRefSchema,
  experimentExplorerEvidenceSchema,
  explorerMatchIdSchema,
  liveMatchExplorerEvidenceSchema,
  matchExplorerRefSchema,
} from './explorers.js';

/**
 * M08.26C — the Card Explorer.
 *
 * The milestone's own line asks for "eligible inclusion by source and
 * Commander, draw/play/dead-hand evidence, partners and replacements,
 * contributing decks and matches, and explicit insufficient-data states."
 *
 * ## Two different systems, never merged into one shape
 *
 * "Eligible inclusion by source and Commander" and "partners" are
 * `apps/simulator/src/analysis/live-card-evidence.ts`'s
 * `aggregateLiveCardEvidence` read over live matches — the same partitioning
 * (`(source, contentVersion, rulesVersion)`) and the same
 * `'played' | 'held' | 'unusable'` eligibility rule `player-meta-results.ts`
 * already reduces for its `'cards'`/`'pairs'` tables, filtered here to the one
 * named card. `cardExplorerInclusionSchema.observedIn` and
 * `cardExplorerPartnerSchema.observedIn` are `liveMatchExplorerEvidenceSchema`
 * (`./explorers.ts`), because this evidence is traced to a live match, not a
 * job.
 *
 * "Draw/play/dead-hand evidence" has no live-match equivalent at all —
 * `deadInHandShare`, `mechanicallyUnusableShare` and `strategicallyUnusedShare`
 * only exist in a search or adaptive job's own `'cards'` result table
 * (`apps/admin-server/src/service/results.ts`'s `case 'cards':`), because only
 * a job replays full games with an eligibility reading. Rather than restate
 * that table's eighteen fields as a second, parallel schema that could drift
 * from the first, `cardExplorerExperimentEvidenceSchema.row` reuses
 * `resultRowSchema` verbatim — the exact row `resultTableSchema` already
 * carries for `definitionId === cardId`, `null` when the named job's `'cards'`
 * table has no row for this card (a card never included in any deck that job
 * built is a real "checked, not found" state, not a failed read).
 * `.observedIn` is `experimentExplorerEvidenceSchema` (`./explorers.ts`) —
 * exactly the shape that file's own doc comment anticipated for this evidence.
 *
 * `experimentEvidence` on the view is `null` when no `jobId` was named
 * (nothing was checked), never a symptom of a job with no matching row — the
 * same `null`-versus-checked-and-empty discipline `deck-explorer.ts` already
 * applies to `knownRevisions`, extended to a single-object answer here rather
 * than an array.
 *
 * ## Replacement evidence (M08.R2)
 *
 * `apps/simulator/src/analysis/replacement.ts` already computes controlled
 * replacement-impact comparisons (`ReplacementImpact`) and `experiment.ts`
 * already writes every one of them into a run's `summary.json`, structured
 * and `.strictObject`-validated, under a top-level `replacements` key — the
 * gap M08.26C's own doc comment recorded was never that this evidence was
 * unstructured, only that no `ResultTableName` let a reader page through it.
 * M08.R2 closes that gap the same way M08.26C closed the draw/play/dead-hand
 * one: `'replacements'` joined `RESULT_TABLE_NAMES` (`./results.ts`), and
 * `cardExplorerReplacementEvidenceSchema.rows` reuses `resultRowSchema`
 * verbatim, filtered to `subjectCardId === cardId`, for the same reason
 * `experimentEvidence.row` does — a second, parallel restatement of
 * `ReplacementImpact`'s seventeen fields is exactly the drift this package's
 * own rule (see file header) forbids.
 *
 * Unlike `experimentEvidence`, this is a bounded *array* of rows rather than
 * one nullable row: one subject card can be the removal/insertion target of
 * several distinct base/variant deck comparisons in the same run (different
 * decks, different replacement cards, different directions), and collapsing
 * them to a single row would silently keep only one. `.observedIn` is the
 * same `experimentExplorerEvidenceSchema` `experimentEvidence` already uses.
 *
 * This is comparative, observational-of-a-controlled-experiment evidence,
 * never a causal claim and never a recommendation — `replacementImpact()`'s
 * own `insufficientData` flag (carried in each row) is the client's signal
 * to say so rather than to imply a verdict the sample cannot support.
 *
 * `null` versus `rows: []` follows the same "checked, not found" discipline
 * `experimentEvidence` established: `replacementEvidence` is `null` when no
 * `jobId` was named (nothing was checked), and a present value with
 * `rows: []` when the named job's `'replacements'` table has no row naming
 * this card — a run that never compared this specific card is a real result,
 * not a failed read.
 *
 * One match contributing both seats' worth of the same card was the
 * collapsing failure mode this slice's acceptance text named explicitly —
 * it does not arise here, because a `'replacements'` row is never a
 * per-match or per-seat reading at all (only aggregate `baseMatches`/
 * `variantMatches`/`pairedGames` counts over the whole paired comparison),
 * so there is no match/seat pair for two rows to collapse into one.
 *
 * ## Contributing decks and matches
 *
 * Read the same way `deck-explorer.ts` reads one deck's identity — a scan of
 * `readLiveMatchEnvelopes`, here filtered to seats whose deck included the
 * named card rather than to one deck hash — never a second aggregate
 * function. `cardExplorerContributingDeckSchema` is one distinct
 * `(deckHash, commanderId)` observed at least once, anchored to its
 * lowest-`matchId` occurrence exactly as `deck-explorer.ts`'s own narrow
 * anchor rule does; `cardExplorerContributingMatchSchema` is one match
 * occurrence. Both are bounded lists, not an unpaginated index — a card
 * played in more matches than the bound is a truncation the view says so
 * about, not a silently partial answer.
 *
 * ## Cross-navigation (M08.26E)
 *
 * `cardExplorerPartnerSchema.ref` is a `cardExplorerRefSchema` for the
 * partner card itself, `cardExplorerContributingDeckSchema.ref` is a
 * `deckExplorerRefSchema` for its deck hash, and
 * `cardExplorerContributingMatchSchema.ref` is a `matchExplorerRefSchema` for
 * its match — each restates a field the entry already carries
 * (`partnerCardId`, `deckHash`, `matchId`) as the typed reference every
 * explorer agrees on, never a second identifier.
 */

/* ------------------------------------------------------------- inclusion */

/** Restates `CardEligibilityStatus` (`apps/simulator/src/analysis/live-card-evidence.ts`). */
export const CARD_EXPLORER_ELIGIBILITY_STATUSES = ['played', 'held', 'unusable'] as const;
export const cardExplorerEligibilityStatusSchema = z.enum(CARD_EXPLORER_ELIGIBILITY_STATUSES);
export type CardExplorerEligibilityStatus = z.infer<typeof cardExplorerEligibilityStatusSchema>;

/**
 * One `(partition, Commander)` cell of this card's eligible-inclusion
 * evidence. `inclusion`/`inclusionByUniqueDeck` are `null` exactly when
 * `status` is `'unusable'` — a structurally off-colour card has no honest
 * selection rate, never a fabricated `0`, per `live-card-evidence.ts`'s own
 * rule.
 */
export const cardExplorerInclusionSchema = z.strictObject({
  commanderId: contentIdSchema,
  status: cardExplorerEligibilityStatusSchema,
  commanderMatches: z.number().int().min(0),
  matchesIncluding: z.number().int().min(0),
  inclusion: z.number().min(0).max(1).nullable(),
  uniqueDecks: z.number().int().min(0),
  decksIncluding: z.number().int().min(0),
  inclusionByUniqueDeck: z.number().min(0).max(1).nullable(),
  observedIn: liveMatchExplorerEvidenceSchema,
});
export type CardExplorerInclusion = z.infer<typeof cardExplorerInclusionSchema>;

/** Most `(partition, Commander)` inclusion cells one card's view carries. */
export const CARD_EXPLORER_MAX_INCLUSIONS = 128;

/* --------------------------------------------------------------- partners */

/** One other card this card co-occurred with, under one Commander in one partition. */
export const cardExplorerPartnerSchema = z.strictObject({
  commanderId: contentIdSchema,
  partnerCardId: contentIdSchema,
  matchesIncludingBoth: z.number().int().min(0),
  support: z.number().min(0).max(1),
  decksIncludingBoth: z.number().int().min(0),
  supportByUniqueDeck: z.number().min(0).max(1),
  observedIn: liveMatchExplorerEvidenceSchema,
  ref: cardExplorerRefSchema,
});
export type CardExplorerPartner = z.infer<typeof cardExplorerPartnerSchema>;

/** Most partner cells one card's view carries. */
export const CARD_EXPLORER_MAX_PARTNERS = 64;

/* ------------------------------------------------------ unavailable partitions */

/** A partition `aggregateLiveCardEvidence` could not compute at all — no card database for its content version. See file doc comment on `'unusable'` never standing in for this. */
export const cardExplorerUnavailablePartitionSchema = z.strictObject({
  observedIn: liveMatchExplorerEvidenceSchema,
  reason: z.string().min(1).max(500),
});
export type CardExplorerUnavailablePartition = z.infer<
  typeof cardExplorerUnavailablePartitionSchema
>;

/** Most unavailable-partition entries one card's view carries. */
export const CARD_EXPLORER_MAX_UNAVAILABLE_PARTITIONS = 32;

/* ------------------------------------------------------- experiment evidence */

/**
 * Draw/play/dead-hand evidence for this card, read from one named job's
 * `'cards'` result table. See file doc comment for why `row` reuses
 * `resultRowSchema` rather than restating its fields.
 */
export const cardExplorerExperimentEvidenceSchema = z.strictObject({
  jobId: jobIdSchema,
  /** `null` when the named job's `'cards'` table has no row for this card — checked, not found. */
  row: resultRowSchema.nullable(),
  observedIn: experimentExplorerEvidenceSchema,
});
export type CardExplorerExperimentEvidence = z.infer<typeof cardExplorerExperimentEvidenceSchema>;

/* ------------------------------------------------------ replacement evidence */

/** Most replacement-comparison rows one card's view carries. See file doc comment on why this is an array, unlike `experimentEvidence`. */
export const CARD_EXPLORER_MAX_REPLACEMENTS = 64;

/**
 * Controlled replacement-comparison evidence for this card, read from one
 * named job's `'replacements'` result table. See file doc comment for why
 * `rows` reuses `resultRowSchema` rather than restating `ReplacementImpact`'s
 * fields, and why it is a bounded array rather than one nullable row.
 */
export const cardExplorerReplacementEvidenceSchema = z.strictObject({
  jobId: jobIdSchema,
  rows: z.array(resultRowSchema).max(CARD_EXPLORER_MAX_REPLACEMENTS),
  observedIn: experimentExplorerEvidenceSchema,
});
export type CardExplorerReplacementEvidence = z.infer<typeof cardExplorerReplacementEvidenceSchema>;

/* ----------------------------------------------------- contributing decks/matches */

export const cardExplorerContributingDeckSchema = z.strictObject({
  deckHash: liveMatchDeckHashSchema,
  commanderId: contentIdSchema,
  observedIn: liveMatchExplorerEvidenceSchema,
  ref: deckExplorerRefSchema,
});
export type CardExplorerContributingDeck = z.infer<typeof cardExplorerContributingDeckSchema>;

export const cardExplorerContributingMatchSchema = z.strictObject({
  matchId: explorerMatchIdSchema,
  deckHash: liveMatchDeckHashSchema,
  commanderId: contentIdSchema,
  observedIn: liveMatchExplorerEvidenceSchema,
  ref: matchExplorerRefSchema,
});
export type CardExplorerContributingMatch = z.infer<typeof cardExplorerContributingMatchSchema>;

/** Most contributing-deck / contributing-match entries one card's view carries, each bounded separately. */
export const CARD_EXPLORER_MAX_CONTRIBUTING_DECKS = 64;
export const CARD_EXPLORER_MAX_CONTRIBUTING_MATCHES = 64;

/* -------------------------------------------------------------- the view */

export const cardExplorerViewSchema = z.strictObject({
  cardId: contentIdSchema,
  inclusions: z.array(cardExplorerInclusionSchema).max(CARD_EXPLORER_MAX_INCLUSIONS),
  partners: z.array(cardExplorerPartnerSchema).max(CARD_EXPLORER_MAX_PARTNERS),
  unavailablePartitions: z
    .array(cardExplorerUnavailablePartitionSchema)
    .max(CARD_EXPLORER_MAX_UNAVAILABLE_PARTITIONS),
  /** `null` versus a present-but-possibly-`row: null` value — see file doc comment. */
  experimentEvidence: cardExplorerExperimentEvidenceSchema.nullable(),
  /** `null` versus a present-but-possibly-`rows: []` value — see file doc comment. */
  replacementEvidence: cardExplorerReplacementEvidenceSchema.nullable(),
  contributingDecks: z
    .array(cardExplorerContributingDeckSchema)
    .max(CARD_EXPLORER_MAX_CONTRIBUTING_DECKS),
  contributingMatches: z
    .array(cardExplorerContributingMatchSchema)
    .max(CARD_EXPLORER_MAX_CONTRIBUTING_MATCHES),
});
export type CardExplorerView = z.infer<typeof cardExplorerViewSchema>;
