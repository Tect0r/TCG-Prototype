import { z } from 'zod';

import { contentIdSchema } from './content.js';
import { jobIdSchema } from './identity.js';
import { liveMatchDeckHashSchema } from './player-meta.js';
import { resultRowSchema } from './results.js';
import {
  experimentExplorerEvidenceSchema,
  explorerMatchIdSchema,
  liveMatchExplorerEvidenceSchema,
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
 * ## Replacements: named by the milestone, not built by this slice
 *
 * `apps/simulator/src/analysis/replacement.ts`/`counters.ts` compute
 * replacement-impact and counter-breadth evidence, but only as Markdown prose
 * assembled by `reporting/report.ts` — there is no structured, queryable,
 * persisted form anywhere a result reader could page through, unlike every
 * other evidence category this file draws from. Wiring that as structured
 * data across the schema/engine/reporting boundary is materially larger than
 * one work slice and was not asked for by name anywhere else in M08.26.
 * Per `CLAUDE.md`'s "do not silently invent unresolved rules," this is
 * recorded as a deliberately deferred gap rather than a shape invented to
 * fill it — `cardExplorerViewSchema` carries no `replacements` field, and
 * `.claude/current-work.md`'s M08.26C entry names this as the exact next
 * question for whichever slice picks it up.
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

/* ----------------------------------------------------- contributing decks/matches */

export const cardExplorerContributingDeckSchema = z.strictObject({
  deckHash: liveMatchDeckHashSchema,
  commanderId: contentIdSchema,
  observedIn: liveMatchExplorerEvidenceSchema,
});
export type CardExplorerContributingDeck = z.infer<typeof cardExplorerContributingDeckSchema>;

export const cardExplorerContributingMatchSchema = z.strictObject({
  matchId: explorerMatchIdSchema,
  deckHash: liveMatchDeckHashSchema,
  commanderId: contentIdSchema,
  observedIn: liveMatchExplorerEvidenceSchema,
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
  contributingDecks: z.array(cardExplorerContributingDeckSchema).max(CARD_EXPLORER_MAX_CONTRIBUTING_DECKS),
  contributingMatches: z
    .array(cardExplorerContributingMatchSchema)
    .max(CARD_EXPLORER_MAX_CONTRIBUTING_MATCHES),
});
export type CardExplorerView = z.infer<typeof cardExplorerViewSchema>;
