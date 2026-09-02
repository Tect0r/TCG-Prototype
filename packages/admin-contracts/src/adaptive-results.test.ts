import { describe, expect, it } from 'vitest';

import {
  ADAPTIVE_RESULT_DOCUMENTS,
  ADAPTIVE_RESULT_TABLE_NAMES,
  MAX_ADAPTIVE_EXPERIMENT_ID,
  adaptiveExperimentIdSchema,
  adaptiveResultTableSchema,
  adaptiveRunSummarySchema,
} from './adaptive-results.js';
import { PAGE_SIZE_MAX } from './pagination.js';
import { MAX_RESULT_COLUMNS } from './results.js';

/**
 * The directory-keyed adaptive result transport (M08.19B), checked for the
 * same two things `results.test.ts` checks its job-keyed sibling for: that it
 * can carry a run's numbers without deciding what any of them mean, and that
 * nothing it carries can be a filesystem location.
 */

function summary(overrides: Record<string, unknown> = {}): unknown {
  return {
    experimentId: 'goblin-counter',
    configHash: 'abcdef0123456789',
    source: { document: 'adaptive-result.json', schemaVersion: 2 },
    readings: [{ key: 'seriesIncumbentWins', label: 'Series — incumbent side', value: 1, kind: 'count' }],
    tables: [{ table: 'series', rows: 1 }],
    limitations: ['This reading carries no calibration standing.'],
    ...overrides,
  };
}

function table(overrides: Record<string, unknown> = {}): unknown {
  return {
    experimentId: 'goblin-counter',
    table: 'series',
    source: { document: 'adaptive-result.json', schemaVersion: 2 },
    columns: [
      { key: 'block', label: 'Block', kind: 'count', bounds: null },
      {
        key: 'score',
        label: 'Score',
        kind: 'interval',
        bounds: { low: 'scoreLow', high: 'scoreHigh' },
      },
    ],
    rows: [{ block: 0, score: 0.5, scoreLow: 0.3, scoreHigh: 0.7 }],
    page: { returned: 1, limit: 50, nextCursor: null, total: 1 },
    ...overrides,
  };
}

describe('an adaptive experiment ID', () => {
  it('is a lowercase, hyphen/underscore-safe slug, matching the simulator’s own bound', () => {
    expect(adaptiveExperimentIdSchema.parse('goblin_counter-v2')).toBe('goblin_counter-v2');
    expect(adaptiveExperimentIdSchema.safeParse('Goblin_Counter').success).toBe(false);
    expect(adaptiveExperimentIdSchema.safeParse('9start_with_digit').success).toBe(false);
    expect(adaptiveExperimentIdSchema.safeParse('a'.repeat(MAX_ADAPTIVE_EXPERIMENT_ID + 1)).success).toBe(
      false,
    );
  });
});

describe('an adaptive result table', () => {
  it('round-trips a page of rows with their interval bounds', () => {
    const parsed = adaptiveResultTableSchema.parse(table());
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.columns[1]?.bounds?.low).toBe('scoreLow');
  });

  it('refuses a cell that belongs to no declared column', () => {
    expect(
      adaptiveResultTableSchema.safeParse(
        table({ rows: [{ block: 0, score: 0.5, scoreLow: 0.3, scoreHigh: 0.7, sneaky: 1 }] }),
      ).success,
    ).toBe(false);
  });

  it('refuses a page that miscounts its own rows', () => {
    expect(
      adaptiveResultTableSchema.safeParse(
        table({ page: { returned: 4, limit: 50, nextCursor: null, total: 4 } }),
      ).success,
    ).toBe(false);
  });

  it('cannot carry more rows than a page holds, or more columns than the bound', () => {
    const rows = Array.from({ length: PAGE_SIZE_MAX + 1 }, () => ({ block: 0 }));
    expect(
      adaptiveResultTableSchema.safeParse(
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
      adaptiveResultTableSchema.safeParse(
        table({ columns, rows: [], page: { returned: 0, limit: 50, nextCursor: null, total: 0 } }),
      ).success,
    ).toBe(false);
  });

  it('names only the tables this build can serve', () => {
    expect([...ADAPTIVE_RESULT_TABLE_NAMES]).toEqual([
      'series',
      'revisions',
      'screening_candidates',
      'deck_diff',
      'cycles',
      'reference_field',
      'validation',
    ]);
    expect(adaptiveResultTableSchema.safeParse(table({ table: 'decks' })).success).toBe(false);
  });

  it('reads only the two documents an adaptive run actually writes', () => {
    expect([...ADAPTIVE_RESULT_DOCUMENTS]).toEqual(['adaptive-checkpoint.json', 'adaptive-result.json']);
    expect(
      adaptiveResultTableSchema.safeParse(
        table({ source: { document: 'summary.json', schemaVersion: 1 } }),
      ).success,
    ).toBe(false);
  });
});

describe('an adaptive run summary', () => {
  it('round-trips a real-shaped reading', () => {
    const parsed = adaptiveRunSummarySchema.parse(summary());
    expect(parsed.configHash).toBe('abcdef0123456789');
    expect(parsed.readings[0]?.key).toBe('seriesIncumbentWins');
  });

  it('has nowhere to put a location, a job ID or a calibration standing at all', () => {
    // Deliberately thinner than `resultSummarySchema` (`./results.ts`):
    // a directory-keyed run has no `JobId` and writes no calibration
    // standing, so neither field has anywhere honest to come from.
    const shape = JSON.stringify(summary());
    expect(shape).not.toContain('rootId');
    expect(shape).not.toContain('directory');
    expect(
      adaptiveRunSummarySchema.safeParse({
        ...(summary() as Record<string, unknown>),
        jobId: 'job_abc123',
      }).success,
    ).toBe(false);
    expect(
      adaptiveRunSummarySchema.safeParse({
        ...(summary() as Record<string, unknown>),
        calibration: 'balance',
      }).success,
    ).toBe(false);
  });

  it('refuses a limitation that carries a filesystem path', () => {
    expect(
      adaptiveRunSummarySchema.safeParse(
        summary({ limitations: ['See D:/results/goblin-counter for detail.'] }),
      ).success,
    ).toBe(false);
  });

  it('refuses a source document this build does not read', () => {
    expect(
      adaptiveRunSummarySchema.safeParse(
        summary({ source: { document: 'report.md', schemaVersion: 1 } }),
      ).success,
    ).toBe(false);
  });
});
