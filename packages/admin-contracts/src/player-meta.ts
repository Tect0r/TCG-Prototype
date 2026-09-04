import { z } from 'zod';

import { contentIdSchema } from './content.js';
import { valueSet } from './filters.js';

/**
 * M08.25A — the filter half of the Player Meta query surface.
 *
 * `apps/simulator/src/analysis/live-match-aggregate.ts`'s own doc comment
 * names this tranche as "the tranche that turns this into a query surface":
 * `partitionLiveMatches`/`aggregateLiveMatches` (M08.24A/C) are a pure
 * reduction over whatever `readonly LiveMatchEnvelope[]` they are handed, and
 * this file is the client-facing shape of *which* matches get handed to them.
 * The matching service-side primitive — `LiveMatchFilter` and
 * `filterLiveMatches` in `apps/simulator/src/analysis/live-match-filter.ts` —
 * narrows the input array before it ever reaches partitioning, so filtering
 * cannot touch, widen or collapse the partition-keyed evidence class
 * (`source`) or the match-weighted/unique-deck-weighted denominators M08.24C
 * already computes: it only changes which matches are counted, never how.
 *
 * `LiveMatchSource`, `LiveMatchTerminationOrigin` and the deck-hash shape are
 * restated here rather than imported, for the reason `adaptive-results.ts`
 * already gives for `adaptiveExperimentIdSchema`: a `@tcg/match-telemetry`-
 * owned shape is a word this package names, never an import that would put
 * `@tcg/match-telemetry` on `@tcg/admin-contracts`'s dependency graph
 * (ADR 0001, enforced by `boundary.test.ts`'s "exactly zod and the shared
 * issue vocabulary" check). `identity.test.ts`/`player-meta.test.ts` pin the
 * restated literal values so a future change to the source schema is caught
 * as a failing test here rather than a silent drift.
 *
 * ## Narrowed scope: two named filter dimensions are deferred, not silently dropped
 *
 * M08.25's own prose asks for filters by "content version, date, source,
 * Commander, deck cluster, termination and private test label." Two of those
 * seven have no backing field anywhere in the live-match telemetry contract
 * today: `liveMatchEnvelopeSchema` (`packages/match-telemetry/src/schema.ts`)
 * carries no timestamp of any kind (by original design — nothing written
 * during M08.21's scope needed one), and no concept of a "private" or
 * "staff-only" test match exists anywhere in the schema, the live-match
 * store, or any earlier milestone record. Per CLAUDE.md's "do not silently
 * invent unresolved rules," this slice ships contracts for the five
 * dimensions that are real (content version, source, Commander, deck
 * cluster, termination) rather than inventing a field to satisfy the other
 * two. The date and private-test-label gap is recorded as the next unscoped
 * design question in `IMPLEMENTATION_PLAN.md`.
 *
 * ## "Deck cluster" is filtered by deck hash, not by a cluster identifier
 *
 * `clusterDecks()` (`apps/simulator/src/analysis/clusters.ts`) assigns each
 * cluster an id (`cluster_01`, `cluster_02`, ...) by its sorted position
 * within *one* clustering call — not a persistent, cross-call identity two
 * different requests could agree names the same group of decks. A filter
 * field spelled `clusterIds` would therefore filter by a number that means a
 * different group of decks every time the underlying match set changes,
 * which is not an honest filter. `deckHashes` is the stable primitive
 * underneath a cluster (`Cluster.deckHashes`, already exported by
 * `clusters.ts`): a caller that wants "this cluster" reads its member hashes
 * off an already-fetched `LiveMatchClusterView` and passes those hashes back
 * here. Filtering by a real, persistent cluster identity stays a smaller,
 * related, unscoped question for whichever slice gives clusters one.
 */

/** Restates `LIVE_MATCH_SOURCES` (`packages/match-telemetry/src/schema.ts`). See file doc comment. */
export const LIVE_MATCH_SOURCES = ['human_human', 'human_ai', 'ai_ai'] as const;
export const liveMatchSourceSchema = z.enum(LIVE_MATCH_SOURCES);
export type LiveMatchSource = z.infer<typeof liveMatchSourceSchema>;

/** Restates `LIVE_MATCH_TERMINATION_ORIGINS` (`packages/match-telemetry/src/schema.ts`). See file doc comment. */
export const LIVE_MATCH_TERMINATION_ORIGINS = [
  'concede_action',
  'concede_leave',
  'disconnect_timeout',
  'rules_victory',
  'server_failure',
  'abandoned_unrecordable',
] as const;
export const liveMatchTerminationOriginSchema = z.enum(LIVE_MATCH_TERMINATION_ORIGINS);
export type LiveMatchTerminationOrigin = z.infer<typeof liveMatchTerminationOriginSchema>;

/** Restates `liveMatchProvenanceSchema.contentVersion`'s bound (`packages/match-telemetry/src/schema.ts`). */
export const liveMatchContentVersionSchema = z.number().int().min(1);
export type LiveMatchContentVersion = z.infer<typeof liveMatchContentVersionSchema>;

/**
 * Restates `DECK_FINGERPRINT_LENGTH` (`packages/deck/src/fingerprint.ts`) and the
 * lowercase-hex alphabet `deckFingerprint` produces, the same "restate the regex
 * too" requirement `adaptiveExperimentIdSchema`'s doc comment states: a bound
 * alone would wave a malformed hash through this filter's outgoing validation.
 */
export const LIVE_MATCH_DECK_HASH_LENGTH = 16;
export const liveMatchDeckHashSchema = z
  .string()
  .length(LIVE_MATCH_DECK_HASH_LENGTH)
  .regex(/^[0-9a-f]+$/, 'A deck hash is lowercase hexadecimal.');
export type LiveMatchDeckHash = z.infer<typeof liveMatchDeckHashSchema>;

/**
 * How a Player Meta query is narrowed.
 *
 * Same semantics as `catalogFilterSchema` (`./filters.ts`): OR within a
 * field, AND across fields, and an absent field does not filter — `{}` is
 * the unfiltered query. `commanderIds` reuses `contentIdSchema` (`./content.ts`)
 * rather than a third spelling of the same shallow identifier bound
 * `catalogFilterSchema.commanderIds` already uses.
 */
export const playerMetaFilterSchema = z.strictObject({
  /** Any of these content versions. */
  contentVersions: valueSet(liveMatchContentVersionSchema),
  /** Any of these sources (`human_human`/`human_ai`/`ai_ai`). Never pooled downstream regardless of how many are named. */
  sources: valueSet(liveMatchSourceSchema),
  /** Matches where either seat's deck was led by one of these Commanders. */
  commanderIds: valueSet(contentIdSchema),
  /** Matches where either seat played one of these exact decks. See file doc comment on "deck cluster." */
  deckHashes: valueSet(liveMatchDeckHashSchema),
  /** Any of these termination origins. */
  terminations: valueSet(liveMatchTerminationOriginSchema),
});
export type PlayerMetaFilter = z.infer<typeof playerMetaFilterSchema>;
export type PlayerMetaFilterInput = z.input<typeof playerMetaFilterSchema>;

/** The filter that excludes nothing, for a caller that would rather not spell `{}`. */
export const NO_PLAYER_META_FILTER: PlayerMetaFilter = playerMetaFilterSchema.parse({});
