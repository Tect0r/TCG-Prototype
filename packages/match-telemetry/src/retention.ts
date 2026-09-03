import { z } from 'zod';
import { gameEventSchema, loggedActionSchema } from '@tcg/rules-engine';
import type { LiveMatchTerminationOrigin } from './schema.js';

/**
 * Retention and artifact contracts (M08.21C): what a deployment may keep
 * beyond the mandatory summary envelope (`./schema.ts`'s
 * `liveMatchEnvelopeSchema`, M08.21A/B), and the exact versioned shape of
 * what it keeps. Contracts only — versioned schemas and a pure retention
 * decision, never a writer, a sink or a storage path. Wiring a real server to
 * actually persist any of this is M08.22's job.
 *
 * Three tiers, in increasing detail:
 * - **summary** — the envelope itself. Always produced; not configurable, so
 *   it carries no field in `liveMatchRetentionConfigSchema` below.
 * - **raw-event** — `liveMatchRawEventArtifactSchema`. The full authoritative
 *   event and action stream, for analysis without re-running anything.
 * - **replay** — `liveMatchReplayArtifactSchema`. Just the `seed` and
 *   `actionLog`, per `MatchState`'s own "every accepted action, in order, so
 *   a match can be re-derived from the seed" contract
 *   (`packages/rules-engine/src/schema/state.ts`) — enough to feed back
 *   through `createMatch`/`applyAction` and reconstruct the match exactly,
 *   without restating the format or deck identity the envelope already
 *   carries.
 *
 * Each artifact is independently versioned, the same readable-refusal
 * treatment `describeLiveMatchEnvelopeVersionProblem` set for the envelope:
 * a raw-event or replay artifact can be read much later by a different build
 * than the one that wrote it, and each tier can move at its own pace.
 */

export const LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION = 1;

/** Whether `found` is a readable schema version this build is simply too new or old to read. */
export function isReadableLiveMatchRawEventVersion(found: unknown): found is number {
  return (
    typeof found === 'number' &&
    Number.isInteger(found) &&
    found === LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION
  );
}

/** The readable refusal for a raw-event artifact's declared `schemaVersion`. `null` when readable. */
export function describeLiveMatchRawEventVersionProblem(found: unknown): string | null {
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    return 'This raw-event record does not declare a readable schema version, so it cannot be read.';
  }
  if (found > LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION) {
    return (
      `This raw-event record was written by a newer build (schema version ${String(found)}; ` +
      `this build reads up to ${String(LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION)}). Update the application.`
    );
  }
  if (found < LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION) {
    return (
      `This raw-event record was written by an older build (schema version ${String(found)}; ` +
      `this build reads version ${String(LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION)}) and there is no ` +
      'migration for it, so it was left where it is rather than guessed at.'
    );
  }
  return null;
}

/** Throws the readable refusal above when `found` is not a version this build reads. */
export function assertReadableLiveMatchRawEventVersion(found: unknown): void {
  const problem = describeLiveMatchRawEventVersionProblem(found);
  if (problem !== null) throw new Error(problem);
}

export const liveMatchRawEventArtifactSchema = z.strictObject({
  schemaVersion: z.literal(LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION),
  /** The same opaque identifier as the match's summary envelope. */
  matchId: z.string().min(1).max(128),
  /** Full authoritative event log, `MatchState.log` verbatim. */
  log: z.array(gameEventSchema),
  /** Every accepted action, in order, `MatchState.actionLog` verbatim. */
  actionLog: z.array(loggedActionSchema),
});
export type LiveMatchRawEventArtifact = z.infer<typeof liveMatchRawEventArtifactSchema>;

/** Parses a raw-event artifact, refusing an unreadable schema version before the strict shape check runs. */
export function parseLiveMatchRawEventArtifact(input: unknown): LiveMatchRawEventArtifact {
  if (input !== null && typeof input === 'object') {
    assertReadableLiveMatchRawEventVersion((input as { schemaVersion?: unknown }).schemaVersion);
  }
  return liveMatchRawEventArtifactSchema.parse(input);
}

export const LIVE_MATCH_REPLAY_SCHEMA_VERSION = 1;

/** Whether `found` is a readable schema version this build is simply too new or old to read. */
export function isReadableLiveMatchReplayVersion(found: unknown): found is number {
  return (
    typeof found === 'number' &&
    Number.isInteger(found) &&
    found === LIVE_MATCH_REPLAY_SCHEMA_VERSION
  );
}

/** The readable refusal for a replay artifact's declared `schemaVersion`. `null` when readable. */
export function describeLiveMatchReplayVersionProblem(found: unknown): string | null {
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    return 'This replay record does not declare a readable schema version, so it cannot be read.';
  }
  if (found > LIVE_MATCH_REPLAY_SCHEMA_VERSION) {
    return (
      `This replay record was written by a newer build (schema version ${String(found)}; ` +
      `this build reads up to ${String(LIVE_MATCH_REPLAY_SCHEMA_VERSION)}). Update the application.`
    );
  }
  if (found < LIVE_MATCH_REPLAY_SCHEMA_VERSION) {
    return (
      `This replay record was written by an older build (schema version ${String(found)}; ` +
      `this build reads version ${String(LIVE_MATCH_REPLAY_SCHEMA_VERSION)}) and there is no ` +
      'migration for it, so it was left where it is rather than guessed at.'
    );
  }
  return null;
}

/** Throws the readable refusal above when `found` is not a version this build reads. */
export function assertReadableLiveMatchReplayVersion(found: unknown): void {
  const problem = describeLiveMatchReplayVersionProblem(found);
  if (problem !== null) throw new Error(problem);
}

export const liveMatchReplayArtifactSchema = z.strictObject({
  schemaVersion: z.literal(LIVE_MATCH_REPLAY_SCHEMA_VERSION),
  /** The same opaque identifier as the match's summary envelope. */
  matchId: z.string().min(1).max(128),
  /** `MatchState.seed` verbatim — same seed, same actions, same match. */
  seed: z.string().min(1).max(128),
  /** `MatchState.actionLog` verbatim; with `seed` this is sufficient to re-derive the match exactly. */
  actionLog: z.array(loggedActionSchema),
});
export type LiveMatchReplayArtifact = z.infer<typeof liveMatchReplayArtifactSchema>;

/** Parses a replay artifact, refusing an unreadable schema version before the strict shape check runs. */
export function parseLiveMatchReplayArtifact(input: unknown): LiveMatchReplayArtifact {
  if (input !== null && typeof input === 'object') {
    assertReadableLiveMatchReplayVersion((input as { schemaVersion?: unknown }).schemaVersion);
  }
  return liveMatchReplayArtifactSchema.parse(input);
}

/**
 * What a deployment is configured to keep beyond the mandatory summary. Two
 * independent dials, not a sample rate: unlike the simulator's batch runs
 * (`apps/simulator/src/config.ts`'s `retentionSchema`), there is no
 * population of matches to sample across here — every live match is itself,
 * so the only question per tier is whether to keep it at all.
 */
export const liveMatchRetentionConfigSchema = z.strictObject({
  /** Keep `liveMatchRawEventArtifactSchema` for a completed or abandoned match. */
  rawEvent: z.boolean().default(false),
  /** Keep `liveMatchReplayArtifactSchema` for a completed or abandoned match. */
  replay: z.boolean().default(false),
});
export type LiveMatchRetentionConfig = z.infer<typeof liveMatchRetentionConfigSchema>;

/**
 * Termination origins whose raw-event stream is kept regardless of the
 * configured policy — mirroring the simulator's own "abnormal matches are
 * always kept regardless of these settings" rule
 * (`apps/simulator/src/config.ts`'s `retentionSchema` doc comment). These are
 * exactly the matches an operator needs the raw stream from to diagnose what
 * happened, so opting out of raw-event retention in general cannot also
 * silently discard the one case where it matters most.
 *
 * Replay stays configuration-only for every origin, including these two:
 * `abandoned_unrecordable` names a match with no `MatchResult`, but the
 * engine may still hold a valid, reconstructable `seed`/`actionLog` up to the
 * point it stalled — an operator who wants replay evidence for abnormal
 * matches opts in via `replay` like for any other match, rather than having
 * it forced.
 */
export const LIVE_MATCH_FORCED_RAW_EVENT_ORIGINS: readonly LiveMatchTerminationOrigin[] = [
  'server_failure',
  'abandoned_unrecordable',
];

/** Whether `origin` forces raw-event retention regardless of the configured policy. */
export function isForcedLiveMatchRawEventOrigin(origin: LiveMatchTerminationOrigin): boolean {
  return LIVE_MATCH_FORCED_RAW_EVENT_ORIGINS.includes(origin);
}

export const liveMatchRetentionDecisionSchema = z.strictObject({
  rawEvent: z.boolean(),
  replay: z.boolean(),
});
export type LiveMatchRetentionDecision = z.infer<typeof liveMatchRetentionDecisionSchema>;

/**
 * What should actually be retained for one match, given its termination
 * origin and the deployment's configured policy.
 */
export function decideLiveMatchRetention(
  origin: LiveMatchTerminationOrigin,
  config: LiveMatchRetentionConfig,
): LiveMatchRetentionDecision {
  return {
    rawEvent: config.rawEvent || isForcedLiveMatchRawEventOrigin(origin),
    replay: config.replay,
  };
}
