import type {
  CatalogDataHealthReport,
  DataHealthFlagBucket,
  DataHealthFlagEntry,
  DataHealthReplayStatus,
  DataHealthTerminationBucket,
  PlayerMetaDataHealthReport,
} from '@tcg/admin-contracts';

import type { Fact } from '../components/FactTable.js';

/**
 * M08.27D — the Data Health panel's pure helpers, the same split every other
 * explorer's `*-view.ts` draws between formatting/derivation and the
 * component that renders it.
 *
 * `data-health.ts`'s own report is never a fabricated number: every category
 * is either measured (a count, possibly zero) or carries `unavailableReason`
 * naming why it could not be measured at all. Every helper here keeps that
 * distinction visible rather than collapsing an unavailable category into a
 * bare zero.
 */

function byKindSummary(byKind: Readonly<Record<string, number>>): string {
  const entries = Object.entries(byKind).filter(([, count]) => count > 0);
  if (entries.length === 0) return 'none by kind';
  return entries.map(([kind, count]) => `${kind}: ${count}`).join(', ');
}

/** A `failures`/`stalled` termination bucket, as one summary `Fact`. */
export function terminationBucketFact(label: string, bucket: DataHealthTerminationBucket): Fact {
  if (bucket.unavailableReason !== null) {
    return { label, value: 'Unavailable', note: bucket.unavailableReason };
  }
  return { label, value: `${bucket.count} (${byKindSummary(bucket.byKind)})` };
}

/** A flag-sourced bucket (`exclusions`/`seatBias`/`pilotSensitivity`/`unsupportedMechanics`), as one summary `Fact`. */
export function flagBucketFact(label: string, bucket: DataHealthFlagBucket): Fact {
  if (bucket.unavailableReason !== null) {
    return { label, value: 'Unavailable', note: bucket.unavailableReason };
  }
  return { label, value: `${bucket.count}` };
}

/** `replicateDisagreement`, as one summary `Fact` — shared shape across both domains. */
export function replicateDisagreementFact(bucket: {
  readonly count: number;
  readonly unavailableReason: string | null;
}): Fact {
  if (bucket.unavailableReason !== null) {
    return {
      label: 'Replicate disagreement',
      value: 'Unavailable',
      note: bucket.unavailableReason,
    };
  }
  return { label: 'Replicate disagreement', value: `${bucket.count}` };
}

/** `replayStatus`, as one summary `Fact`. */
export function replayStatusFact(status: DataHealthReplayStatus): Fact {
  if (status.unavailableReason !== null) {
    return { label: 'Deterministic replay', value: 'Unavailable', note: status.unavailableReason };
  }
  return {
    label: 'Deterministic replay',
    value: `${status.withReplay} of ${status.matchesChecked} checked kept a replay`,
  };
}

/** One flag entry (`DataHealthFlagEntry`), in words for a table cell. */
export function flagEntryLabel(entry: DataHealthFlagEntry): string {
  return `${entry.subject} — ${entry.message} (n=${entry.sampleSize})`;
}

/** Every one of a catalog run's nine Data Health categories, as one overview `FactTable`'s facts. */
export function catalogDataHealthFacts(report: CatalogDataHealthReport): Fact[] {
  return [
    { label: 'Recovered records', value: `${report.recoveredRecords.count}` },
    terminationBucketFact('Failures', report.failures),
    terminationBucketFact('Stalled', report.stalled),
    flagBucketFact('Exclusions', report.exclusions),
    replicateDisagreementFact(report.replicateDisagreement),
    flagBucketFact('Seat bias', report.seatBias),
    flagBucketFact('Pilot sensitivity', report.pilotSensitivity),
    flagBucketFact('Unsupported mechanics', report.unsupportedMechanics),
    replayStatusFact(report.replayStatus),
  ];
}

/** Every one of a Player Meta partition's nine Data Health categories, as one overview `FactTable`'s facts. */
export function playerMetaDataHealthFacts(report: PlayerMetaDataHealthReport): Fact[] {
  return [
    { label: 'Recovered records', value: `${report.recoveredRecords.count}` },
    terminationBucketFact('Failures', report.failures),
    terminationBucketFact('Stalled', report.stalled),
    { label: 'Exclusions', value: `${report.exclusions.count}` },
    replicateDisagreementFact(report.replicateDisagreement),
    flagBucketFact('Seat bias', report.seatBias),
    flagBucketFact('Pilot sensitivity', report.pilotSensitivity),
    flagBucketFact('Unsupported mechanics', report.unsupportedMechanics),
    replayStatusFact(report.replayStatus),
  ];
}
