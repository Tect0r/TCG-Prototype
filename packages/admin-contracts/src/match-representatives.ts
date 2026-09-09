import { z } from 'zod';

import { adaptiveExperimentIdSchema } from './adaptive-results.js';
import { matchExplorerRefSchema, liveMatchExplorerEvidenceSchema } from './explorers.js';
import { pageOf } from './pagination.js';

/**
 * M08.26E — representative match selection and cross-navigation.
 *
 * The milestone's own line asks to "select closest, upset, shortest, longest,
 * one-sided, pre-adaptation, deterministic ordinary and every abnormal match
 * reproducibly." This file is the closed vocabulary for the seven singular
 * categories plus the one list category, read over exactly the evidence
 * `match-explorer.ts` already reads — a fourth read of `readLiveMatchEnvelopes`
 * (after Deck, Card and Match Explorer), never a fifth aggregate function.
 *
 * ## No per-match margin field exists — so "closest"/"upset"/"one-sided" are a documented proxy
 *
 * `packages/match-telemetry/src/schema.ts`'s live-match envelope carries
 * `actionCount`, `terminationOrigin` and `outcome` (winner, loser, reason,
 * final turn/sequence) — never a Health delta, score margin, or any other
 * per-match closeness signal. Inventing one would be fabricating data no
 * telemetry writer ever recorded, which `CLAUDE.md`'s "do not silently invent
 * unresolved rules" forbids as surely as leaving the category unbuilt would.
 *
 * The chosen proxy: within the filtered match set, compute each Commander's
 * overall decisive win rate with `proportion()` (`@tcg/simulator`'s Wilson-
 * interval helper, already this codebase's one vocabulary for a win-rate
 * point estimate — `apps/simulator/src/analysis/live-match-aggregate.ts`'s
 * `CommanderSelectionEntry.winRate` uses the same function for the same
 * reason). For one decisive match, `skew` is the winning Commander's overall
 * point estimate minus the losing Commander's. A match where the nominally
 * weaker Commander won has negative skew (an **upset**); a match between two
 * Commanders whose overall rates are nearly equal has skew near zero (the
 * **closest** call this filter produced); a match where the stronger
 * Commander won by the largest overall-rate gap is the **most one-sided**.
 * This is a *matchup-strength* proxy, not an in-game margin — the reason
 * string on every selection says so explicitly, so a reader never mistakes
 * "the favourite was heavily favoured" for "the game itself was a blowout."
 *
 * ## Shortest / longest need no proxy
 *
 * `actionCount` is a real, recorded field. Both categories are read over
 * matches with a real `outcome` (win or draw) — an `abandoned_unrecordable`
 * match's `actionCount` describes a stall, not a game length, and is already
 * covered by the abnormal-match list below rather than double-counted here.
 *
 * ## Pre-adaptation change needs a named experiment, exactly like Card Explorer's job evidence
 *
 * An Adaptive Counter lineage's revision history — `generation`,
 * `parentRevisionId`, which revision superseded which — exists only inside a
 * named experiment's own `'revisions'` result table
 * (`apps/admin-server/src/service/adaptive-results.ts`), never on a live-match
 * envelope itself. `adaptiveExperimentId` on the request defaults to `null`,
 * meaning "do not check lineage at all," never "checked, found nothing" — the
 * same discipline `deckExplorerRequestSchema.adaptiveExperimentId` and
 * `cardExplorerRequestSchema.jobId` already established. When named, the
 * category selects the last live match played with a deck revision before
 * that lineage advanced past it — the one match a reviewer would open to see
 * "the board state right before the counter-adaptation changed the deck."
 *
 * ## Deterministic ordinary sample
 *
 * Seeded by `seededIndex` (`@tcg/simulator`'s `seed.ts`, CLAUDE.md §13.4) over
 * the sorted match IDs of the eligible pool (real outcome, not abnormal) — the
 * same "deterministic but looks random" pattern `apply/evaluate.ts`'s
 * `selectReferenceField` already uses. Seeding from the pool's own sorted
 * content, rather than from the request's filter shape, means the pick stays
 * stable across requests that resolve to the same match set and changes only
 * when that set actually changes — never when a filter is merely re-encoded.
 *
 * ## Abnormal matches: a restated subset of `LIVE_MATCH_TERMINATION_ORIGINS`
 *
 * `packages/match-telemetry/src/schema.ts`'s own doc comment already draws
 * this line for `terminationOrigin`: `rules_victory`, `concede_action` and
 * `concede_leave` are ordinary, player- or rules-driven endings;
 * `disconnect_timeout`, `server_failure` and `abandoned_unrecordable` are the
 * three origins nobody chose and the rules never concluded. That existing
 * three-way split is "every abnormal match" verbatim — no new classification
 * is invented here, only named as a bounded list rather than left implicit.
 *
 * ## Cross-navigation: refs, not raw identifiers
 *
 * Every representative and every abnormal-match entry carries
 * `matchExplorerRefSchema` (`./explorers.ts`) rather than a bare `matchId`
 * string, so a client can route it through the one cross-navigation shape
 * every explorer already agrees on, and `observedIn` rather than any filename
 * or path — ADR 0023 §5's hidden-information boundary applies here exactly as
 * it does to every other explorer row.
 */

/* ------------------------------------------------------------------ kinds */

export const REPRESENTATIVE_MATCH_KINDS = [
  'closest',
  'largest_upset',
  'most_one_sided',
  'shortest',
  'longest',
  'pre_adaptation',
  'random_ordinary',
] as const;
export const representativeMatchKindSchema = z.enum(REPRESENTATIVE_MATCH_KINDS);
export type RepresentativeMatchKind = z.infer<typeof representativeMatchKindSchema>;

/* ------------------------------------------------------------ one selection */

export const representativeMatchSchema = z.strictObject({
  kind: representativeMatchKindSchema,
  ref: matchExplorerRefSchema,
  observedIn: liveMatchExplorerEvidenceSchema,
  /** A short, human-readable account of why this exact match was chosen — see file doc comment on the matchup-strength proxy. */
  reason: z.string().min(1).max(400),
});
export type RepresentativeMatch = z.infer<typeof representativeMatchSchema>;

/**
 * One entry per `REPRESENTATIVE_MATCH_KINDS` member, always present, `match`
 * `null` exactly when the filtered set had no eligible candidate for that
 * kind (e.g. no decisive match ever produced an upset, or no
 * `adaptiveExperimentId` was named) — the same `null`-versus-absent discipline
 * every other explorer view in this package already follows, extended here to
 * "checked this kind, found none" rather than "did not check."
 */
export const representativeMatchEntrySchema = z.strictObject({
  kind: representativeMatchKindSchema,
  match: representativeMatchSchema.nullable(),
});
export type RepresentativeMatchEntry = z.infer<typeof representativeMatchEntrySchema>;

/** Exactly one entry per kind, in `REPRESENTATIVE_MATCH_KINDS` order — never a partial or reordered list. */
export const REPRESENTATIVE_MATCH_ENTRY_COUNT = REPRESENTATIVE_MATCH_KINDS.length;

/* -------------------------------------------------------------- abnormal list */

export const abnormalMatchEntrySchema = z.strictObject({
  ref: matchExplorerRefSchema,
  observedIn: liveMatchExplorerEvidenceSchema,
  reason: z.string().min(1).max(200),
});
export type AbnormalMatchEntry = z.infer<typeof abnormalMatchEntrySchema>;

export const abnormalMatchListSchema = pageOf(abnormalMatchEntrySchema);
export type AbnormalMatchList = z.infer<typeof abnormalMatchListSchema>;

/* -------------------------------------------------------------------- the view */

export const matchRepresentativesViewSchema = z.strictObject({
  /** Echoes the request's `adaptiveExperimentId` — `null` means pre-adaptation selection was never attempted, not that it found nothing. */
  adaptiveExperimentId: adaptiveExperimentIdSchema.nullable(),
  representatives: z.array(representativeMatchEntrySchema).length(REPRESENTATIVE_MATCH_ENTRY_COUNT),
  abnormalMatches: abnormalMatchListSchema,
});
export type MatchRepresentativesView = z.infer<typeof matchRepresentativesViewSchema>;
