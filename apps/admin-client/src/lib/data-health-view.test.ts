import { describe, expect, it } from 'vitest';

import type { DataHealthFlagBucket, DataHealthTerminationBucket } from '@tcg/admin-contracts';

import {
  catalogDataHealthFacts,
  flagBucketFact,
  flagEntryLabel,
  playerMetaDataHealthFacts,
  replayStatusFact,
  replicateDisagreementFact,
  terminationBucketFact,
} from './data-health-view.js';

function terminationBucket(
  overrides: Partial<DataHealthTerminationBucket> = {},
): DataHealthTerminationBucket {
  return { count: 0, byKind: {}, unavailableReason: null, ...overrides };
}

function flagBucket(overrides: Partial<DataHealthFlagBucket> = {}): DataHealthFlagBucket {
  return { count: 0, entries: [], unavailableReason: null, ...overrides };
}

describe('terminationBucketFact', () => {
  it('summarizes a measured bucket by kind', () => {
    expect(
      terminationBucketFact(
        'Failures',
        terminationBucket({ count: 3, byKind: { engine_error: 2, pilot_error: 1 } }),
      ),
    ).toEqual({ label: 'Failures', value: '3 (engine_error: 2, pilot_error: 1)' });
  });

  it('names every kind as none when the bucket is empty', () => {
    expect(terminationBucketFact('Stalled', terminationBucket())).toEqual({
      label: 'Stalled',
      value: '0 (none by kind)',
    });
  });

  it('reports unavailable with its reason rather than a zero', () => {
    expect(
      terminationBucketFact('Failures', terminationBucket({ unavailableReason: 'no reader' })),
    ).toEqual({ label: 'Failures', value: 'Unavailable', note: 'no reader' });
  });
});

describe('flagBucketFact', () => {
  it('reports a measured count', () => {
    expect(flagBucketFact('Seat bias', flagBucket({ count: 2 }))).toEqual({
      label: 'Seat bias',
      value: '2',
    });
  });

  it('reports unavailable with its reason', () => {
    expect(flagBucketFact('Seat bias', flagBucket({ unavailableReason: 'no telemetry' }))).toEqual({
      label: 'Seat bias',
      value: 'Unavailable',
      note: 'no telemetry',
    });
  });
});

describe('replicateDisagreementFact', () => {
  it('reports a measured count', () => {
    expect(replicateDisagreementFact({ count: 1, unavailableReason: null })).toEqual({
      label: 'Replicate disagreement',
      value: '1',
    });
  });

  it('reports unavailable with its reason', () => {
    expect(
      replicateDisagreementFact({ count: 0, unavailableReason: 'no replicate concept' }),
    ).toEqual({
      label: 'Replicate disagreement',
      value: 'Unavailable',
      note: 'no replicate concept',
    });
  });
});

describe('replayStatusFact', () => {
  it('reports a measured reading', () => {
    expect(
      replayStatusFact({
        matchesChecked: 4,
        withReplay: 3,
        withoutReplay: 1,
        unavailableReason: null,
      }),
    ).toEqual({ label: 'Deterministic replay', value: '3 of 4 checked kept a replay' });
  });

  it('reports unavailable with its reason', () => {
    expect(
      replayStatusFact({
        matchesChecked: 0,
        withReplay: 0,
        withoutReplay: 0,
        unavailableReason: 'no reader exists',
      }),
    ).toEqual({ label: 'Deterministic replay', value: 'Unavailable', note: 'no reader exists' });
  });
});

describe('flagEntryLabel', () => {
  it('renders subject, message and sample size', () => {
    expect(
      flagEntryLabel({
        level: 'insufficient_data',
        reason: 'seat_sensitivity',
        subject: 'card_arcane_snare',
        message: 'too few replicates',
        sampleSize: 5,
      }),
    ).toBe('card_arcane_snare — too few replicates (n=5)');
  });
});

describe('catalogDataHealthFacts', () => {
  it('names all nine categories in order', () => {
    const facts = catalogDataHealthFacts({
      identity: { domain: 'catalog', jobId: 'job_test' },
      recoveredRecords: { count: 0, entries: [] },
      failures: terminationBucket(),
      stalled: terminationBucket(),
      exclusions: flagBucket(),
      replicateDisagreement: { count: 0, entries: [], unavailableReason: null },
      seatBias: flagBucket(),
      pilotSensitivity: flagBucket(),
      unsupportedMechanics: flagBucket(),
      replayStatus: { matchesChecked: 0, withReplay: 0, withoutReplay: 0, unavailableReason: null },
      unavailableReason: null,
    });
    expect(facts.map((fact) => fact.label)).toEqual([
      'Recovered records',
      'Failures',
      'Stalled',
      'Exclusions',
      'Replicate disagreement',
      'Seat bias',
      'Pilot sensitivity',
      'Unsupported mechanics',
      'Deterministic replay',
    ]);
  });
});

describe('playerMetaDataHealthFacts', () => {
  it('names all nine categories, with exclusions as a plain count', () => {
    const facts = playerMetaDataHealthFacts({
      identity: {
        domain: 'player_meta',
        partition: { source: 'ai_ai', contentVersion: 1, rulesVersion: '1.0.0' },
      },
      recoveredRecords: { count: 0, entries: [] },
      failures: terminationBucket(),
      stalled: terminationBucket(),
      exclusions: { count: 2, entries: [] },
      replicateDisagreement: { count: 0, entries: [], unavailableReason: 'no replicate concept' },
      seatBias: flagBucket({ unavailableReason: 'no telemetry' }),
      pilotSensitivity: flagBucket({ unavailableReason: 'no telemetry' }),
      unsupportedMechanics: flagBucket({ unavailableReason: 'no telemetry' }),
      replayStatus: { matchesChecked: 0, withReplay: 0, withoutReplay: 0, unavailableReason: null },
      unavailableReason: null,
    });
    expect(facts.find((fact) => fact.label === 'Exclusions')).toEqual({
      label: 'Exclusions',
      value: '2',
    });
    expect(facts.find((fact) => fact.label === 'Seat bias')).toEqual({
      label: 'Seat bias',
      value: 'Unavailable',
      note: 'no telemetry',
    });
  });
});
