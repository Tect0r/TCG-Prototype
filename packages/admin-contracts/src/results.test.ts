import { describe, expect, it } from 'vitest';

import {
  MAX_RESULT_COLUMNS,
  RESULT_TABLE_NAMES,
  evidenceStandingSchema,
  resultCellSchema,
  resultDenominatorsSchema,
  resultKeySchema,
  resultSummarySchema,
  resultTableSchema,
} from './results.js';
import { PAGE_SIZE_MAX } from './pagination.js';

/**
 * The result transport, checked for the two things it exists to guarantee: that
 * it can carry a run's numbers without deciding what any of them mean, and that
 * nothing it carries can be a filesystem location or an invented denominator.
 */

const IDENTITY = {
  experimentId: 'precon-standard',
  kind: 'batch' as const,
  seed: 'seed-1',
  configHash: 'abcdef12',
  environments: [
    {
      environmentId: 'wave_1',
      hashes: {
        mechanicsHash: 'aa11bb22',
        pilotInputHash: 'bb22cc33',
        presentationHash: 'cc33dd44',
        fullContentHash: 'dd44ee55',
      },
    },
  ],
  manifestSchemaVersion: 8,
  softwareCommit: null,
};

const DENOMINATORS = {
  matches: 16,
  usableMatches: 15,
  abnormalMatches: 1,
  failedMatches: 0,
  resumedMatches: 0,
  abnormalByKind: { turn_limit: 1 },
};

const EVIDENCE = {
  standing: 'calibration',
  reasons: ['No pilot in this build carries a final balance conclusion.'],
  promotionRequires: 'A run stops being calibration only when every class that flew it carries it.',
  analysisVersion: 1,
};

function summary(overrides: Record<string, unknown> = {}): unknown {
  return {
    jobId: 'job_abc123',
    kind: 'batch',
    configHash: 'abcdef12',
    identity: IDENTITY,
    source: { document: 'summary.json', schemaVersion: 7 },
    denominators: DENOMINATORS,
    evidence: EVIDENCE,
    readings: [{ key: 'draws', label: 'Draws', value: 2, kind: 'count' }],
    tables: [{ table: 'decks', rows: 4 }],
    limitations: ['One game per seat order is a termination check, not a measurement.'],
    ...overrides,
  };
}

function table(overrides: Record<string, unknown> = {}): unknown {
  return {
    jobId: 'job_abc123',
    table: 'decks',
    source: { document: 'summary.json', schemaVersion: 7 },
    columns: [
      { key: 'deckId', label: 'Deck', kind: 'identifier', bounds: null },
      {
        key: 'winRate',
        label: 'Win rate',
        kind: 'interval',
        bounds: { low: 'winRateLow', high: 'winRateHigh' },
      },
    ],
    rows: [{ deckId: 'aurora', winRate: 0.5, winRateLow: 0.3, winRateHigh: 0.7 }],
    page: { returned: 1, limit: 50, nextCursor: null, total: 1 },
    ...overrides,
  };
}

describe('a result cell', () => {
  it('can say “not measured” without saying “zero”', () => {
    // The milestone makes this a defect when it is got wrong: *zero observations
    // are not a zero win rate*. A transport with no `null` could not express the
    // difference at all, whatever the projection above it decided.
    expect(resultCellSchema.parse(null)).toBeNull();
    expect(resultCellSchema.parse(0)).toBe(0);
  });

  it('refuses a value long enough to be a payload', () => {
    expect(resultCellSchema.safeParse('x'.repeat(201)).success).toBe(false);
  });

  it('refuses a non-finite number, so an empty average cannot travel as NaN', () => {
    expect(resultCellSchema.safeParse(Number.NaN).success).toBe(false);
    expect(resultCellSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });
});

describe('a result key', () => {
  it('names a field and never a file', () => {
    expect(resultKeySchema.parse('winRate')).toBe('winRate');
    expect(resultKeySchema.parse('deck.commanderId')).toBe('deck.commanderId');
    for (const bad of ['../secret', 'a/b', 'a\\b', 'C:name', '~home']) {
      expect(`${bad}: ${String(resultKeySchema.safeParse(bad).success)}`).toBe(`${bad}: false`);
    }
  });
});

describe('a result table', () => {
  it('round-trips a page of rows with their interval bounds', () => {
    const parsed = resultTableSchema.parse(table());
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.columns[1]?.bounds?.low).toBe('winRateLow');
  });

  it('refuses a cell that belongs to no declared column', () => {
    const bad = resultTableSchema.safeParse(
      table({
        rows: [{ deckId: 'aurora', winRate: 0.5, winRateLow: 0.3, winRateHigh: 0.7, sneaky: 1 }],
      }),
    );
    expect(bad.success).toBe(false);
  });

  it('refuses a page that miscounts its own rows', () => {
    expect(
      resultTableSchema.safeParse(
        table({ page: { returned: 4, limit: 50, nextCursor: null, total: 4 } }),
      ).success,
    ).toBe(false);
  });

  it('cannot carry more rows than a page holds, or more columns than the bound', () => {
    const rows = Array.from({ length: PAGE_SIZE_MAX + 1 }, () => ({ deckId: 'aurora' }));
    expect(
      resultTableSchema.safeParse(
        table({ rows, page: { returned: rows.length, limit: 50, nextCursor: null, total: null } }),
      ).success,
    ).toBe(false);

    const columns = Array.from({ length: MAX_RESULT_COLUMNS + 1 }, (_unused, index) => ({
      key: `c${String(index)}`,
      label: `C${String(index)}`,
      kind: 'count',
      bounds: null,
    }));
    expect(
      resultTableSchema.safeParse(
        table({ columns, rows: [], page: { returned: 0, limit: 50, nextCursor: null, total: 0 } }),
      ).success,
    ).toBe(false);
  });

  it('names only the tables this build can serve', () => {
    expect([...RESULT_TABLE_NAMES]).toEqual([
      'decks',
      'matchups',
      'cards',
      'seats',
      'pilots',
      'agent_classes',
      'terminations',
      'commanders',
      'commander_matchups',
      'commander_generations',
      'search_generations',
    ]);
    expect(resultTableSchema.safeParse(table({ table: 'replays' })).success).toBe(false);
  });
});

describe('the denominators', () => {
  it('must account for every record played', () => {
    // A summary whose usable and abnormal counts do not add up to the records it
    // says exist is a summary that has silently dropped evidence, and it is
    // exactly the shape a hand-built response would produce.
    expect(
      resultDenominatorsSchema.safeParse({ ...DENOMINATORS, abnormalMatches: 2 }).success,
    ).toBe(false);
    expect(resultDenominatorsSchema.parse(DENOMINATORS).usableMatches).toBe(15);
  });

  it('splits the abnormal records by kind, so “excluded” is never one number', () => {
    expect(Object.keys(resultDenominatorsSchema.parse(DENOMINATORS).abnormalByKind)).toEqual([
      'turn_limit',
    ]);
  });
});

describe('the evidence standing', () => {
  it('never travels without the sentence saying what would change it', () => {
    expect(evidenceStandingSchema.safeParse({ ...EVIDENCE, promotionRequires: '' }).success).toBe(
      false,
    );
  });

  it('does not restate the simulator’s taxonomy, so the two cannot disagree', () => {
    // `standing` is a bounded string rather than an enum: `EVIDENCE_STANDINGS`
    // belongs to `@tcg/simulator`, and a copy here would be a second list that
    // can go stale the day a third standing exists.
    expect(evidenceStandingSchema.parse({ ...EVIDENCE, standing: 'balance' }).standing).toBe(
      'balance',
    );
  });
});

describe('a result summary', () => {
  it('round-trips a real-shaped reading', () => {
    const parsed = resultSummarySchema.parse(summary());
    expect(parsed.evidence.standing).toBe('calibration');
    expect(parsed.identity.manifestSchemaVersion).toBe(8);
  });

  it('refuses a limitation that carries a filesystem path', () => {
    // The one place ADR 0023 §5 is easiest to forget: these sentences come from a
    // registry and from the simulator's own analysis, and one of them quoting a
    // directory would put it on a browser's screen.
    expect(
      resultSummarySchema.safeParse(summary({ limitations: ['See D:/results/run-1 for detail.'] }))
        .success,
    ).toBe(false);
  });

  it('has nowhere to put a location at all', () => {
    const shape = JSON.stringify(summary());
    expect(shape).not.toContain('rootId');
    expect(shape).not.toContain('directory');
    expect(
      resultSummarySchema.safeParse({
        ...(summary() as Record<string, unknown>),
        location: { rootId: 'default', directory: 'run-1' },
      }).success,
    ).toBe(false);
  });

  it('refuses a source document this build does not read', () => {
    expect(
      resultSummarySchema.safeParse(
        summary({ source: { document: 'report.md', schemaVersion: 1 } }),
      ).success,
    ).toBe(false);
  });
});
