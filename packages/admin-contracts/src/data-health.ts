import { z } from 'zod';

import { jobIdSchema } from './identity.js';
import { playerMetaPartitionSchema } from './player-meta-results.js';

/**
 * M08.27D (model half) — the Data Health transport.
 *
 * A coverage report (`./coverage.ts`) answers "how much of the vocabulary did
 * this run exercise." This file answers a different question: *can this run's
 * numbers be trusted, and where the answer is no, why not.* Both files share
 * `./coverage.ts`'s two-domain split (never merged) and its three-part honesty
 * discipline — a category is either measured (a real count, possibly zero) or
 * `unavailableReason` names why it could not be, never a fabricated number.
 *
 * **Nine named categories, drawn from evidence this build already computes —
 * nothing here is a new statistical analysis.**
 *
 * - `recoveredRecords` ("corrupt/skipped records") — catalog reads
 *   `manifest.json`'s `recoveredLines` (`MatchStore.recovered`, a damaged
 *   `matches.jsonl` line tolerated rather than failing the run); Player Meta
 *   reads `readLiveMatchEnvelopes`'s `skipped` list (a live-match directory
 *   the tolerant reader could not parse).
 * - `failures` / `stalled` — catalog splits `denominators.abnormalByKind`
 *   (`./results.ts`) along `@tcg/simulator`'s own `ABNORMAL_TERMINATIONS` line:
 *   `engine_error`/`pilot_error`/`illegal_bot_action` are failures nobody
 *   chose, `turn_limit`/`action_limit`/`no_progress` are stalls that ran out of
 *   budget rather than erroring. Player Meta has no engine-kind taxonomy, so it
 *   splits `LIVE_MATCH_TERMINATION_ORIGINS`' own abnormal subset the same way:
 *   `server_failure` is a failure, `disconnect_timeout`/`abandoned_unrecordable`
 *   are stalls nobody concluded.
 * - `exclusions` — catalog reads `flags` at `level: 'insufficient_data'`: a
 *   card, pair or matchup this run could not evaluate and therefore excluded
 *   from a review verdict. Player Meta has no flag system over live play, so it
 *   reads its own documented exclusion instead (`player-meta-results.ts`'s
 *   `PLAYER_META_RUN_LIMITATIONS`): matches with no recorded outcome, already
 *   excluded from every win-rate and duration figure that domain reports.
 * - `replicateDisagreement` — catalog reads `summary.json`'s `displacement`
 *   entries at `status: 'insufficient_evidence'` (between-replicate variance
 *   too high to call a share change real). Structurally `unavailable` for
 *   Player Meta: a live match is a singleton human game, never one of a
 *   `definitionId`'s named replicates.
 * - `seatBias` / `pilotSensitivity` / `unsupportedMechanics` — catalog reads
 *   `flags` at `reason: 'seat_sensitivity'` / `'pilot_sensitivity'` /
 *   `'unsupported_mechanics'` respectively. All three are structurally
 *   `unavailable` for Player Meta: `computeFlags` runs only over a catalog
 *   batch's own aggregate, pairs and support reading, never over live-match
 *   telemetry — the same domain gap `./coverage.ts`'s doc comment already
 *   names for `target` (a real limit, not an oversight).
 * - `replayStatus` — Player Meta reads presence with `readLiveMatchReplay`
 *   (already `match-explorer.ts`'s own per-match artifact check) over this
 *   partition's abnormal-origin matches, since a live match's replay is
 *   configuration-gated per deployment rather than guaranteed. Catalog is
 *   structurally `unavailable`: `RESULT_TABLE_NAMES` (`./results.ts`) has no
 *   per-match table, and `@tcg/simulator`'s public surface exposes no reader
 *   for a catalog run's own `replays/<matchId>.json` presence — a real gap in
 *   this build, not a run that happens to lack replays.
 *
 * **This slice ships the model only.** No HTTP address, no admin-client
 * session method, no UI component — those are the model slice's declared
 * follow-up (M08.27's page slice), matching the split `./coverage.ts` and its
 * own page slice already drew.
 */

/* -------------------------------------------------------------- identity */

export const dataHealthIdentitySchema = z.discriminatedUnion('domain', [
  z.strictObject({ domain: z.literal('catalog'), jobId: jobIdSchema }),
  z.strictObject({ domain: z.literal('player_meta'), partition: playerMetaPartitionSchema }),
]);
export type DataHealthIdentity = z.infer<typeof dataHealthIdentitySchema>;

/* ---------------------------------------------------------- shared pieces */

/** One `Flag` (`@tcg/simulator`'s `flags.ts`), restated as plain strings — this package carries no dependency on `@tcg/simulator` (ADR 0001), the same choice `./coverage.ts` makes for `MECHANIC_SUPPORT_LIST`. */
export const dataHealthFlagEntrySchema = z.strictObject({
  level: z.string().min(1),
  reason: z.string().min(1),
  /** A card ID, a deck hash, a cluster ID, or the run — restates `Flag.subject`. */
  subject: z.string(),
  message: z.string(),
  sampleSize: z.number().int().min(0),
});
export type DataHealthFlagEntry = z.infer<typeof dataHealthFlagEntrySchema>;

/** A flag-sourced category: `count` and `entries` agree by construction (`entries.length === count`); `unavailableReason` is set only when the category's whole underlying analysis does not run in this domain, never when it ran and found nothing. */
export const dataHealthFlagBucketSchema = z.strictObject({
  count: z.number().int().min(0),
  entries: z.array(dataHealthFlagEntrySchema),
  unavailableReason: z.string().nullable(),
});
export type DataHealthFlagBucket = z.infer<typeof dataHealthFlagBucketSchema>;

/** `failures`/`stalled`: an abnormal-termination count split by kind or origin name — never a single opaque total, mirroring `./results.ts`'s own `resultDenominatorsSchema.abnormalByKind`. */
export const dataHealthTerminationBucketSchema = z.strictObject({
  count: z.number().int().min(0),
  byKind: z.record(z.string().min(1).max(64), z.number().int().min(0)),
  unavailableReason: z.string().nullable(),
});
export type DataHealthTerminationBucket = z.infer<typeof dataHealthTerminationBucketSchema>;

/** Deterministic-replay status: how many of the matches this build could check actually kept one. `unavailableReason` set, with every count 0, exactly when this domain has no reader that can answer the question at all — see file doc comment. */
export const dataHealthReplayStatusSchema = z.strictObject({
  matchesChecked: z.number().int().min(0),
  withReplay: z.number().int().min(0),
  withoutReplay: z.number().int().min(0),
  unavailableReason: z.string().nullable(),
});
export type DataHealthReplayStatus = z.infer<typeof dataHealthReplayStatusSchema>;

/* ------------------------------------------------------------- catalog domain */

/** One `manifest.json` `recoveredLines` entry (`MatchStore.RecoveredLine`) — a damaged `matches.jsonl` line, tolerated rather than failing the run. */
export const catalogRecoveredRecordSchema = z.strictObject({
  line: z.number().int().min(0),
  reason: z.string(),
});
export type CatalogRecoveredRecord = z.infer<typeof catalogRecoveredRecordSchema>;

/** One `summary.json` `displacement` entry at `status: 'insufficient_evidence'` (`@tcg/simulator`'s `Displacement`) — restated narrowly, never the whole analysis shape. */
export const catalogReplicateDisagreementEntrySchema = z.strictObject({
  definitionId: z.string(),
  betweenReplicateVariation: z.number(),
  replicates: z.number().int().min(0),
  /** Candidate mean minus baseline mean, in share points — context for why the variance matters here. */
  shareDelta: z.number(),
});
export type CatalogReplicateDisagreementEntry = z.infer<
  typeof catalogReplicateDisagreementEntrySchema
>;

export const catalogDataHealthReportSchema = z.strictObject({
  identity: z.strictObject({ domain: z.literal('catalog'), jobId: jobIdSchema }),
  recoveredRecords: z.strictObject({
    count: z.number().int().min(0),
    entries: z.array(catalogRecoveredRecordSchema),
  }),
  failures: dataHealthTerminationBucketSchema,
  stalled: dataHealthTerminationBucketSchema,
  exclusions: dataHealthFlagBucketSchema,
  replicateDisagreement: z.strictObject({
    count: z.number().int().min(0),
    entries: z.array(catalogReplicateDisagreementEntrySchema),
    unavailableReason: z.string().nullable(),
  }),
  seatBias: dataHealthFlagBucketSchema,
  pilotSensitivity: dataHealthFlagBucketSchema,
  unsupportedMechanics: dataHealthFlagBucketSchema,
  replayStatus: dataHealthReplayStatusSchema,
  /** Set, with every category zeroed and reasoned, exactly when this run's summary or manifest could not be read at all — mirrors `CatalogCoverageReport.unavailableReason`. */
  unavailableReason: z.string().nullable(),
});
export type CatalogDataHealthReport = z.infer<typeof catalogDataHealthReportSchema>;

/* --------------------------------------------------------- player_meta domain */

/** One skipped or excluded live-match record, named by `matchId` rather than a `manifest.json` line number — the Player Meta domain has no such file. */
export const playerMetaMatchRecordSchema = z.strictObject({
  matchId: z.string(),
  reason: z.string(),
});
export type PlayerMetaMatchRecord = z.infer<typeof playerMetaMatchRecordSchema>;

export const playerMetaDataHealthReportSchema = z.strictObject({
  identity: z.strictObject({ domain: z.literal('player_meta'), partition: playerMetaPartitionSchema }),
  recoveredRecords: z.strictObject({
    count: z.number().int().min(0),
    entries: z.array(playerMetaMatchRecordSchema),
  }),
  failures: dataHealthTerminationBucketSchema,
  stalled: dataHealthTerminationBucketSchema,
  /** Matches with no recorded outcome — already excluded from every win-rate/duration figure `player-meta-results.ts` reports (`PLAYER_META_RUN_LIMITATIONS`), read here rather than re-derived. */
  exclusions: z.strictObject({
    count: z.number().int().min(0),
    entries: z.array(playerMetaMatchRecordSchema),
  }),
  /** Always `unavailable` — see file doc comment. `entries` stays typed against the catalog shape so a client never needs two row renderers. */
  replicateDisagreement: z.strictObject({
    count: z.number().int().min(0),
    entries: z.array(catalogReplicateDisagreementEntrySchema),
    unavailableReason: z.string().nullable(),
  }),
  /** Always `unavailable` — see file doc comment. */
  seatBias: dataHealthFlagBucketSchema,
  /** Always `unavailable` — see file doc comment. */
  pilotSensitivity: dataHealthFlagBucketSchema,
  /** Always `unavailable` — see file doc comment. */
  unsupportedMechanics: dataHealthFlagBucketSchema,
  replayStatus: dataHealthReplayStatusSchema,
  /** Set, with every category zeroed and reasoned, exactly when no live match in this Player Meta root matches this partition — mirrors `PlayerMetaCoverageReport.unavailableReason`. */
  unavailableReason: z.string().nullable(),
});
export type PlayerMetaDataHealthReport = z.infer<typeof playerMetaDataHealthReportSchema>;
