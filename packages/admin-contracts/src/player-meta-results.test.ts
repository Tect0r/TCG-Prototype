import { describe, expect, it } from 'vitest';

import {
  MAX_PLAYER_META_PARTITIONS,
  PLAYER_META_RESULT_TABLE_NAMES,
  playerMetaPartitionSchema,
  playerMetaPartitionSummarySchema,
  playerMetaResultTableSchema,
  playerMetaRunSummarySchema,
} from './player-meta-results.js';
import { PAGE_SIZE_MAX } from './pagination.js';
import { MAX_RESULT_COLUMNS } from './results.js';

/**
 * M08.25B — the directory-keyed Player Meta result transport: a table that
 * spans every partition a filtered query found, and a summary with no
 * `JobId` or calibration standing to report.
 */

function partition(overrides: Record<string, unknown> = {}): unknown {
  return { source: 'human_human', contentVersion: 5, rulesVersion: '1.0.0', ...overrides };
}

function table(overrides: Record<string, unknown> = {}): unknown {
  return {
    table: 'commanders',
    source: { recordsRead: 10, recordsSkipped: 0 },
    columns: [
      { key: 'source', label: 'Source', kind: 'identifier', bounds: null },
      { key: 'commanderId', label: 'Commander', kind: 'identifier', bounds: null },
      {
        key: 'winRate',
        label: 'Win rate',
        kind: 'interval',
        bounds: { low: 'winRateLow', high: 'winRateHigh' },
      },
    ],
    rows: [
      {
        source: 'human_human',
        commanderId: 'cmd_a',
        winRate: 0.5,
        winRateLow: 0.3,
        winRateHigh: 0.7,
      },
    ],
    page: { returned: 1, limit: 50, nextCursor: null, total: 1 },
    ...overrides,
  };
}

function summary(overrides: Record<string, unknown> = {}): unknown {
  return {
    source: { recordsRead: 10, recordsSkipped: 0 },
    partitions: [{ partition: partition(), matches: 10, uniqueDecks: 4, decisiveMatches: 9 }],
    tables: [{ table: 'commanders', rows: 1 }],
    limitations: ['Popularity is reported two ways.'],
    ...overrides,
  };
}

describe('a Player Meta partition', () => {
  it('restates `liveMatchProvenanceSchema.rulesVersion`’s bound exactly: any non-empty string', () => {
    expect(playerMetaPartitionSchema.safeParse(partition({ rulesVersion: '1.0.0' })).success).toBe(
      true,
    );
    expect(playerMetaPartitionSchema.safeParse(partition({ rulesVersion: '' })).success).toBe(
      false,
    );
  });

  it('refuses an unknown field', () => {
    expect(playerMetaPartitionSchema.safeParse(partition({ extra: true })).success).toBe(false);
  });
});

describe('a Player Meta result table', () => {
  it('round-trips a page of rows spanning their own partition columns', () => {
    const parsed = playerMetaResultTableSchema.parse(table());
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.source).toBe('human_human');
  });

  it('refuses a cell that belongs to no declared column', () => {
    expect(
      playerMetaResultTableSchema.safeParse(
        table({
          rows: [
            {
              source: 'human_human',
              commanderId: 'cmd_a',
              winRate: 0.5,
              winRateLow: 0.3,
              winRateHigh: 0.7,
              sneaky: 1,
            },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('refuses a page that miscounts its own rows', () => {
    expect(
      playerMetaResultTableSchema.safeParse(
        table({ page: { returned: 4, limit: 50, nextCursor: null, total: 4 } }),
      ).success,
    ).toBe(false);
  });

  it('cannot carry more rows than a page holds, or more columns than the bound', () => {
    const rows = Array.from({ length: PAGE_SIZE_MAX + 1 }, () => ({ source: 'human_human' }));
    expect(
      playerMetaResultTableSchema.safeParse(
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
      playerMetaResultTableSchema.safeParse(
        table({ columns, rows: [], page: { returned: 0, limit: 50, nextCursor: null, total: 0 } }),
      ).success,
    ).toBe(false);
  });

  it('names only the tables this build can serve', () => {
    expect([...PLAYER_META_RESULT_TABLE_NAMES]).toEqual([
      'commanders',
      'decks',
      'deck_matchups',
      'clusters',
      'cluster_matchups',
      'cards',
      'pairs',
      'duration',
      'terminations',
      'surrender_turns',
      'surrender_phases',
      'surrender_state',
      'surrender_exposure_cards',
      'surrender_exposure_events',
    ]);
    expect(playerMetaResultTableSchema.safeParse(table({ table: 'not_a_table' })).success).toBe(
      false,
    );
  });
});

describe('a Player Meta partition summary', () => {
  it('round-trips match-weighted and unique-deck-weighted counts side by side', () => {
    const parsed = playerMetaPartitionSummarySchema.parse({
      partition: partition(),
      matches: 10,
      uniqueDecks: 4,
      decisiveMatches: 9,
    });
    expect(parsed.matches).toBe(10);
    expect(parsed.uniqueDecks).toBe(4);
  });

  it('has no player-weighted count field at all', () => {
    expect(Object.keys(playerMetaPartitionSummarySchema.shape)).not.toContain('players');
  });
});

describe('a Player Meta run summary', () => {
  it('round-trips a real-shaped reading', () => {
    const parsed = playerMetaRunSummarySchema.parse(summary());
    expect(parsed.partitions).toHaveLength(1);
    expect(parsed.source).toEqual({ recordsRead: 10, recordsSkipped: 0 });
  });

  it('has nowhere to put a job ID, an experiment ID or a calibration standing at all', () => {
    const shape = JSON.stringify(summary());
    expect(shape).not.toContain('jobId');
    expect(shape).not.toContain('experimentId');
    expect(
      playerMetaRunSummarySchema.safeParse({
        ...(summary() as Record<string, unknown>),
        jobId: 'job_abc123',
      }).success,
    ).toBe(false);
    expect(
      playerMetaRunSummarySchema.safeParse({
        ...(summary() as Record<string, unknown>),
        evidenceStanding: 'balance',
      }).success,
    ).toBe(false);
  });

  it('refuses a limitation that carries a filesystem path', () => {
    expect(
      playerMetaRunSummarySchema.safeParse(
        summary({ limitations: ['See D:/results/player-meta for detail.'] }),
      ).success,
    ).toBe(false);
  });

  it('cannot carry more partitions than the bound', () => {
    const partitions = Array.from({ length: MAX_PLAYER_META_PARTITIONS + 1 }, (_unused, index) => ({
      partition: partition({ contentVersion: index + 1 }),
      matches: 1,
      uniqueDecks: 1,
      decisiveMatches: 1,
    }));
    expect(playerMetaRunSummarySchema.safeParse(summary({ partitions })).success).toBe(false);
  });
});
