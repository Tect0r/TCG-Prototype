import {
  adminError,
  catalogDataHealthReportSchema,
  playerMetaDataHealthReportSchema,
  type AdminError,
  type CatalogDataHealthReport,
  type CatalogReplicateDisagreementEntry,
  type DataHealthFlagEntry,
  type JobId,
  type PlayerMetaDataHealthReport,
  type PlayerMetaPartition,
} from '@tcg/admin-contracts';
import { err, isErr, ok, type Result } from '@tcg/shared';

import type { PlayerMetaResultReader } from './player-meta-results.js';
import type { ResultReader } from './results.js';

/**
 * M08.27D (model half) — computing the reports
 * `packages/admin-contracts/src/data-health.ts` transports. See that file's
 * doc comment for the nine-category-to-evidence mapping this module carries
 * out rather than re-deciding.
 *
 * Both domains read their evidence through a reader's own narrow method
 * (`ResultReader.readDataHealthEvidence`, `PlayerMetaResultReader.readDataHealthEvidence`)
 * rather than opening `summary.json`/`manifest.json`/a live-match root a
 * second, private way — the same rule `./coverage.ts`'s own doc comment states.
 */

const CATALOG_FAILURE_KINDS = ['engine_error', 'pilot_error', 'illegal_bot_action'] as const;
const CATALOG_STALL_KINDS = ['turn_limit', 'action_limit', 'no_progress'] as const;

function builtBadly(view: string, context: Readonly<Record<string, unknown>>): AdminError {
  return adminError(
    'admin/schema',
    'This service built a Data Health report it could not validate against its own contract, so it was ' +
      'not sent. This is a defect in the build rather than a problem with the run.',
    { context: { ...context, view } },
  );
}

function terminationBucket(
  byKind: Readonly<Record<string, number>>,
  kinds: readonly string[],
): { count: number; byKind: Record<string, number>; unavailableReason: null } {
  const picked: Record<string, number> = {};
  let count = 0;
  for (const kind of kinds) {
    const value = byKind[kind];
    if (value === undefined || value === 0) continue;
    picked[kind] = value;
    count += value;
  }
  return { count, byKind: picked, unavailableReason: null };
}

function flagBucket(
  flags: readonly DataHealthFlagEntry[],
  predicate: (flag: DataHealthFlagEntry) => boolean,
): { count: number; entries: DataHealthFlagEntry[]; unavailableReason: null } {
  const entries = flags.filter(predicate);
  return { count: entries.length, entries, unavailableReason: null };
}

const UNAVAILABLE_CATALOG_REPLAY: CatalogDataHealthReport['replayStatus'] = {
  matchesChecked: 0,
  withReplay: 0,
  withoutReplay: 0,
  unavailableReason:
    'This build has no per-match replay table or reader for catalog runs — `RESULT_TABLE_NAMES` names ' +
    'no per-match table, and `@tcg/simulator` exposes no catalog-run replay-presence reader. This is a ' +
    'gap in this build, not a run that happens to lack replays.',
};

/** A fully zeroed, wholly `unavailable` catalog report — this run's evidence could not be read at all. */
function unavailableCatalogReport(jobId: JobId, reason: string): CatalogDataHealthReport {
  return {
    identity: { domain: 'catalog', jobId },
    recoveredRecords: { count: 0, entries: [] },
    failures: { count: 0, byKind: {}, unavailableReason: null },
    stalled: { count: 0, byKind: {}, unavailableReason: null },
    exclusions: { count: 0, entries: [], unavailableReason: null },
    replicateDisagreement: { count: 0, entries: [], unavailableReason: null },
    seatBias: { count: 0, entries: [], unavailableReason: null },
    pilotSensitivity: { count: 0, entries: [], unavailableReason: null },
    unsupportedMechanics: { count: 0, entries: [], unavailableReason: null },
    replayStatus: UNAVAILABLE_CATALOG_REPLAY,
    unavailableReason: reason,
  };
}

/** One run's Data Health — nine categories, every one measured or honestly `unavailable`. */
export async function computeCatalogDataHealth(
  reader: ResultReader,
  jobId: JobId,
): Promise<Result<CatalogDataHealthReport, readonly AdminError[]>> {
  const evidence = await reader.readDataHealthEvidence(jobId);
  if (isErr(evidence)) {
    const report = unavailableCatalogReport(
      jobId,
      'This run has no readable summary or manifest, so its data health could not be measured: ' +
        evidence.error.map((problem) => problem.message).join(' '),
    );
    const validated = catalogDataHealthReportSchema.safeParse(report);
    if (!validated.success) return err([builtBadly('catalog_data_health', { jobId })]);
    return ok(validated.data);
  }

  const flags: DataHealthFlagEntry[] = evidence.value.flags.map((flag) => ({
    level: flag.level,
    reason: flag.reason,
    subject: flag.subject,
    message: flag.message,
    sampleSize: flag.sampleSize,
  }));

  const replicateDisagreement: CatalogReplicateDisagreementEntry[] = evidence.value.displacement
    .filter((entry) => entry.status === 'insufficient_evidence')
    .map((entry) => ({
      definitionId: entry.definitionId,
      betweenReplicateVariation: entry.betweenReplicateVariation,
      replicates: entry.replicates,
      shareDelta: entry.shareDelta,
    }));

  const report: CatalogDataHealthReport = {
    identity: { domain: 'catalog', jobId },
    recoveredRecords: {
      count: evidence.value.recoveredLines.length,
      entries: evidence.value.recoveredLines.map((entry) => ({
        line: entry.line,
        reason: entry.reason,
      })),
    },
    failures: terminationBucket(evidence.value.denominators.abnormalByKind, CATALOG_FAILURE_KINDS),
    stalled: terminationBucket(evidence.value.denominators.abnormalByKind, CATALOG_STALL_KINDS),
    exclusions: flagBucket(flags, (flag) => flag.level === 'insufficient_data'),
    replicateDisagreement: {
      count: replicateDisagreement.length,
      entries: replicateDisagreement,
      unavailableReason: null,
    },
    seatBias: flagBucket(flags, (flag) => flag.reason === 'seat_sensitivity'),
    pilotSensitivity: flagBucket(flags, (flag) => flag.reason === 'pilot_sensitivity'),
    unsupportedMechanics: flagBucket(flags, (flag) => flag.reason === 'unsupported_mechanics'),
    replayStatus: UNAVAILABLE_CATALOG_REPLAY,
    unavailableReason: null,
  };

  const validated = catalogDataHealthReportSchema.safeParse(report);
  if (!validated.success) return err([builtBadly('catalog_data_health', { jobId })]);
  return ok(validated.data);
}

const PLAYER_META_FAILURE_ORIGINS = ['server_failure'] as const;
const PLAYER_META_STALL_ORIGINS = ['disconnect_timeout', 'abandoned_unrecordable'] as const;

const UNAVAILABLE_PLAYER_META_ANALYSIS_REASON =
  "`computeFlags` runs only over a catalog batch's own aggregate, pairs and support reading, never over " +
  "live-match telemetry — the same domain gap `./coverage.ts`'s own doc comment names for `target`.";

/** A fully zeroed, wholly `unavailable` Player Meta report — this partition's evidence could not be read at all. */
function unavailablePlayerMetaReport(
  partition: PlayerMetaPartition,
  reason: string,
): PlayerMetaDataHealthReport {
  return {
    identity: { domain: 'player_meta', partition },
    recoveredRecords: { count: 0, entries: [] },
    failures: { count: 0, byKind: {}, unavailableReason: null },
    stalled: { count: 0, byKind: {}, unavailableReason: null },
    exclusions: { count: 0, entries: [] },
    replicateDisagreement: {
      count: 0,
      entries: [],
      unavailableReason:
        'No replicate concept for human play — each live match is a singleton game, never one of a ' +
        "definitionId's named replicates.",
    },
    seatBias: { count: 0, entries: [], unavailableReason: UNAVAILABLE_PLAYER_META_ANALYSIS_REASON },
    pilotSensitivity: {
      count: 0,
      entries: [],
      unavailableReason: UNAVAILABLE_PLAYER_META_ANALYSIS_REASON,
    },
    unsupportedMechanics: {
      count: 0,
      entries: [],
      unavailableReason: UNAVAILABLE_PLAYER_META_ANALYSIS_REASON,
    },
    replayStatus: { matchesChecked: 0, withReplay: 0, withoutReplay: 0, unavailableReason: null },
    unavailableReason: reason,
  };
}

/** One Player Meta partition's Data Health. */
export function computePlayerMetaDataHealth(
  reader: PlayerMetaResultReader,
  partition: PlayerMetaPartition,
): Result<PlayerMetaDataHealthReport, readonly AdminError[]> {
  const evidence = reader.readDataHealthEvidence(partition);
  if (isErr(evidence)) {
    const report = unavailablePlayerMetaReport(
      partition,
      'This partition could not be read, so its data health could not be measured: ' +
        evidence.error.map((problem) => problem.message).join(' '),
    );
    const validated = playerMetaDataHealthReportSchema.safeParse(report);
    if (!validated.success) return err([builtBadly('player_meta_data_health', {})]);
    return ok(validated.data);
  }

  const { matches, skipped, replayStatus } = evidence.value;
  if (matches.length === 0) {
    const report = unavailablePlayerMetaReport(
      partition,
      'No live match in this Player Meta root matches this partition, so there is nothing to measure.',
    );
    const validated = playerMetaDataHealthReportSchema.safeParse(report);
    if (!validated.success) return err([builtBadly('player_meta_data_health', {})]);
    return ok(validated.data);
  }

  function originBucket(origins: readonly string[]): {
    count: number;
    byKind: Record<string, number>;
    unavailableReason: null;
  } {
    const byKind: Record<string, number> = {};
    let count = 0;
    for (const origin of origins) {
      const matching = matches.filter((match) => match.terminationOrigin === origin).length;
      if (matching === 0) continue;
      byKind[origin] = matching;
      count += matching;
    }
    return { count, byKind, unavailableReason: null };
  }

  const excluded = matches.filter((match) => match.outcome === null);

  const report: PlayerMetaDataHealthReport = {
    identity: { domain: 'player_meta', partition },
    recoveredRecords: {
      count: skipped.length,
      entries: skipped.map((entry) => ({ matchId: entry.matchId, reason: entry.reason })),
    },
    failures: originBucket(PLAYER_META_FAILURE_ORIGINS),
    stalled: originBucket(PLAYER_META_STALL_ORIGINS),
    exclusions: {
      count: excluded.length,
      entries: excluded.map((match) => ({
        matchId: match.matchId,
        reason:
          'No recorded outcome for this match — excluded from every win-rate and duration figure this ' +
          'domain reports.',
      })),
    },
    replicateDisagreement: {
      count: 0,
      entries: [],
      unavailableReason:
        'No replicate concept for human play — each live match is a singleton game, never one of a ' +
        "definitionId's named replicates.",
    },
    seatBias: { count: 0, entries: [], unavailableReason: UNAVAILABLE_PLAYER_META_ANALYSIS_REASON },
    pilotSensitivity: {
      count: 0,
      entries: [],
      unavailableReason: UNAVAILABLE_PLAYER_META_ANALYSIS_REASON,
    },
    unsupportedMechanics: {
      count: 0,
      entries: [],
      unavailableReason: UNAVAILABLE_PLAYER_META_ANALYSIS_REASON,
    },
    replayStatus: { ...replayStatus, unavailableReason: null },
    unavailableReason: null,
  };

  const validated = playerMetaDataHealthReportSchema.safeParse(report);
  if (!validated.success) return err([builtBadly('player_meta_data_health', {})]);
  return ok(validated.data);
}
