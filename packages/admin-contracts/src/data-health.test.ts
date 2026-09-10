import { describe, expect, it } from 'vitest';

import {
  catalogDataHealthReportSchema,
  catalogRecoveredRecordSchema,
  catalogReplicateDisagreementEntrySchema,
  dataHealthFlagBucketSchema,
  dataHealthFlagEntrySchema,
  dataHealthIdentitySchema,
  dataHealthReplayStatusSchema,
  dataHealthTerminationBucketSchema,
  playerMetaDataHealthReportSchema,
  playerMetaMatchRecordSchema,
} from './data-health.js';
import type { PlayerMetaPartition } from './player-meta-results.js';

function partition(overrides: Partial<PlayerMetaPartition> = {}): PlayerMetaPartition {
  return { source: 'human_human', contentVersion: 5, rulesVersion: '1.0.0', ...overrides };
}

function emptyBucket(): { count: number; entries: never[]; unavailableReason: null } {
  return { count: 0, entries: [], unavailableReason: null };
}

function emptyTermination(): { count: number; byKind: Record<string, number>; unavailableReason: null } {
  return { count: 0, byKind: {}, unavailableReason: null };
}

function unavailableReplay(): {
  matchesChecked: number;
  withReplay: number;
  withoutReplay: number;
  unavailableReason: string;
} {
  return { matchesChecked: 0, withReplay: 0, withoutReplay: 0, unavailableReason: 'no reader exists' };
}

describe('dataHealthIdentitySchema', () => {
  it('accepts a catalog identity', () => {
    const result = dataHealthIdentitySchema.safeParse({
      domain: 'catalog',
      jobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a Player Meta identity', () => {
    const result = dataHealthIdentitySchema.safeParse({ domain: 'player_meta', partition: partition() });
    expect(result.success).toBe(true);
  });

  it('rejects a catalog identity carrying a partition', () => {
    const result = dataHealthIdentitySchema.safeParse({
      domain: 'catalog',
      jobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      partition: partition(),
    });
    expect(result.success).toBe(false);
  });
});

describe('dataHealthFlagEntrySchema and dataHealthFlagBucketSchema', () => {
  it('accepts a well-formed flag entry', () => {
    const result = dataHealthFlagEntrySchema.safeParse({
      level: 'review_recommended',
      reason: 'seat_sensitivity',
      subject: 'deck_abc',
      message: 'Win rate diverges by seat.',
      sampleSize: 40,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a negative sampleSize', () => {
    const result = dataHealthFlagEntrySchema.safeParse({
      level: 'review_recommended',
      reason: 'seat_sensitivity',
      subject: 'deck_abc',
      message: 'Win rate diverges by seat.',
      sampleSize: -1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts an empty bucket with a null unavailableReason', () => {
    expect(dataHealthFlagBucketSchema.safeParse(emptyBucket()).success).toBe(true);
  });

  it('accepts an unavailable bucket with a reason and no entries', () => {
    const result = dataHealthFlagBucketSchema.safeParse({
      count: 0,
      entries: [],
      unavailableReason: 'computeFlags never runs over live-match telemetry.',
    });
    expect(result.success).toBe(true);
  });
});

describe('dataHealthTerminationBucketSchema', () => {
  it('accepts a populated byKind breakdown', () => {
    const result = dataHealthTerminationBucketSchema.safeParse({
      count: 5,
      byKind: { engine_error: 2, pilot_error: 3 },
      unavailableReason: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a negative byKind count', () => {
    const result = dataHealthTerminationBucketSchema.safeParse({
      count: 5,
      byKind: { engine_error: -1 },
      unavailableReason: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('dataHealthReplayStatusSchema', () => {
  it('accepts a measured status', () => {
    const result = dataHealthReplayStatusSchema.safeParse({
      matchesChecked: 4,
      withReplay: 3,
      withoutReplay: 1,
      unavailableReason: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a structurally unavailable status', () => {
    expect(dataHealthReplayStatusSchema.safeParse(unavailableReplay()).success).toBe(true);
  });
});

describe('catalogDataHealthReportSchema', () => {
  function report(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      identity: { domain: 'catalog', jobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      recoveredRecords: { count: 0, entries: [] },
      failures: emptyTermination(),
      stalled: emptyTermination(),
      exclusions: emptyBucket(),
      replicateDisagreement: emptyBucket(),
      seatBias: emptyBucket(),
      pilotSensitivity: emptyBucket(),
      unsupportedMechanics: emptyBucket(),
      replayStatus: unavailableReplay(),
      unavailableReason: null,
      ...overrides,
    };
  }

  it('accepts a fully populated report', () => {
    expect(catalogDataHealthReportSchema.safeParse(report()).success).toBe(true);
  });

  it('accepts a recovered record entry', () => {
    const result = catalogDataHealthReportSchema.safeParse(
      report({
        recoveredRecords: {
          count: 1,
          entries: [{ line: 42, reason: 'unparseable JSON' }],
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a replicate disagreement entry', () => {
    const result = catalogDataHealthReportSchema.safeParse(
      report({
        replicateDisagreement: {
          count: 1,
          entries: [
            { definitionId: 'card_forest', betweenReplicateVariation: 0.08, replicates: 3, shareDelta: -0.02 },
          ],
          unavailableReason: null,
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a Player Meta identity', () => {
    const result = catalogDataHealthReportSchema.safeParse(
      report({ identity: { domain: 'player_meta', partition: partition() } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an unknown extra field', () => {
    const result = catalogDataHealthReportSchema.safeParse(report({ target: 'reached' }));
    expect(result.success).toBe(false);
  });
});

describe('playerMetaDataHealthReportSchema', () => {
  function report(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      identity: { domain: 'player_meta', partition: partition() },
      recoveredRecords: { count: 0, entries: [] },
      failures: emptyTermination(),
      stalled: emptyTermination(),
      exclusions: { count: 0, entries: [] },
      replicateDisagreement: {
        count: 0,
        entries: [],
        unavailableReason: 'no replicate concept for human play',
      },
      seatBias: {
        count: 0,
        entries: [],
        unavailableReason: 'computeFlags never runs over live-match telemetry',
      },
      pilotSensitivity: {
        count: 0,
        entries: [],
        unavailableReason: 'computeFlags never runs over live-match telemetry',
      },
      unsupportedMechanics: {
        count: 0,
        entries: [],
        unavailableReason: 'computeFlags never runs over live-match telemetry',
      },
      replayStatus: {
        matchesChecked: 2,
        withReplay: 1,
        withoutReplay: 1,
        unavailableReason: null,
      },
      unavailableReason: null,
      ...overrides,
    };
  }

  it('accepts a fully populated report', () => {
    expect(playerMetaDataHealthReportSchema.safeParse(report()).success).toBe(true);
  });

  it('accepts a skipped/excluded match record', () => {
    const record = { matchId: 'live_match_1', reason: 'no envelope.json found' };
    expect(playerMetaMatchRecordSchema.safeParse(record).success).toBe(true);
    const result = playerMetaDataHealthReportSchema.safeParse(
      report({ recoveredRecords: { count: 1, entries: [record] } }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a catalog identity', () => {
    const result = playerMetaDataHealthReportSchema.safeParse(
      report({ identity: { domain: 'catalog', jobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an unknown extra field', () => {
    const result = playerMetaDataHealthReportSchema.safeParse(report({ target: 'reached' }));
    expect(result.success).toBe(false);
  });
});

describe('catalogRecoveredRecordSchema and catalogReplicateDisagreementEntrySchema', () => {
  it('rejects a negative line number', () => {
    const result = catalogRecoveredRecordSchema.safeParse({ line: -1, reason: 'bad' });
    expect(result.success).toBe(false);
  });

  it('rejects a negative replicate count', () => {
    const result = catalogReplicateDisagreementEntrySchema.safeParse({
      definitionId: 'card_forest',
      betweenReplicateVariation: 0.1,
      replicates: -1,
      shareDelta: 0,
    });
    expect(result.success).toBe(false);
  });
});
