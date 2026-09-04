import { describe, expect, it } from 'vitest';

import type { PlayerMetaResultTable, ResultColumn, ResultRow } from '@tcg/admin-contracts';

import {
  PLAYER_META_DASHBOARD_TABLES,
  displayColumns,
  formatPlayerMetaCell,
  hasPlayerMetaWeighting,
  playerMetaRowDrillTarget,
  playerMetaTruncationNote,
  readPlayerMetaRate,
  sortPlayerMetaRowsByWeight,
} from './player-meta-view.js';

const RATE_COLUMN: ResultColumn = {
  key: 'rate',
  label: 'Win rate',
  kind: 'interval',
  bounds: { low: 'rateLow', high: 'rateHigh' },
};
const RATE_GAMES_COLUMN: ResultColumn = {
  key: 'rateGames',
  label: 'Win rate games',
  kind: 'count',
  bounds: null,
};
const COMMANDER_ID_COLUMN: ResultColumn = {
  key: 'commanderId',
  label: 'Commander',
  kind: 'identifier',
  bounds: null,
};
const RATE_COLUMNS: readonly ResultColumn[] = [RATE_COLUMN, RATE_GAMES_COLUMN, COMMANDER_ID_COLUMN];

describe('reading an interval cell', () => {
  it('reads the point, bounds and sample count by the column’s own key convention', () => {
    const row: ResultRow = {
      rate: 0.6,
      rateLow: 0.5,
      rateHigh: 0.7,
      rateGames: 40,
      commanderId: 'commander_1',
    };
    expect(readPlayerMetaRate({ columns: RATE_COLUMNS }, row, 'rate')).toEqual({
      point: 0.6,
      low: 0.5,
      high: 0.7,
      total: 40,
    });
  });

  it('reads null for a column that carries no bounds', () => {
    const row: ResultRow = { commanderId: 'commander_1' };
    expect(readPlayerMetaRate({ columns: RATE_COLUMNS }, row, 'commanderId')).toBeNull();
  });
});

describe('displayColumns', () => {
  it('folds an interval’s bound and count columns into its own one cell', () => {
    const shown = displayColumns({ columns: RATE_COLUMNS });
    expect(shown.map((column) => column.key)).toEqual(['rate', 'commanderId']);
  });
});

describe('formatPlayerMetaCell', () => {
  it('formats an interval cell as a rate, and a plain cell as its literal value', () => {
    const row: ResultRow = {
      rate: 0.6,
      rateLow: 0.5,
      rateHigh: 0.7,
      rateGames: 40,
      commanderId: 'commander_1',
    };
    const table = { columns: RATE_COLUMNS };
    expect(formatPlayerMetaCell(table, row, RATE_COLUMN)).toMatch(/%/);
    expect(formatPlayerMetaCell(table, row, COMMANDER_ID_COLUMN)).toBe('commander_1');
  });

  it('prints "Not measured" for a null cell rather than the literal word "null"', () => {
    const row: ResultRow = { commanderId: null };
    expect(formatPlayerMetaCell({ columns: RATE_COLUMNS }, row, COMMANDER_ID_COLUMN)).toBe(
      'Not measured',
    );
  });
});

describe('PLAYER_META_DASHBOARD_TABLES', () => {
  it('names every table the summary can report rows for', () => {
    expect([...PLAYER_META_DASHBOARD_TABLES]).toEqual([
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
  });
});

describe('hasPlayerMetaWeighting', () => {
  it('offers a weighting toggle only for commanders and clusters', () => {
    expect(hasPlayerMetaWeighting('commanders')).toBe(true);
    expect(hasPlayerMetaWeighting('clusters')).toBe(true);
    expect(hasPlayerMetaWeighting('decks')).toBe(false);
    expect(hasPlayerMetaWeighting('cards')).toBe(false);
  });
});

describe('sortPlayerMetaRowsByWeight', () => {
  const rows: readonly ResultRow[] = [
    { commanderId: 'a', matches: 10, uniqueDecks: 5 },
    { commanderId: 'b', matches: 30, uniqueDecks: 2 },
    { commanderId: 'c', matches: 20, uniqueDecks: 8 },
  ];

  it('sorts by matches, highest first, when that weighting is chosen', () => {
    const sorted = sortPlayerMetaRowsByWeight('commanders', rows, 'matches');
    expect(sorted.map((row) => row.commanderId)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by the unique-deck column, highest first, when that weighting is chosen', () => {
    const sorted = sortPlayerMetaRowsByWeight('commanders', rows, 'unique');
    expect(sorted.map((row) => row.commanderId)).toEqual(['c', 'a', 'b']);
  });

  it('leaves row order untouched for a table with no weighting column', () => {
    const sorted = sortPlayerMetaRowsByWeight('decks', rows, 'matches');
    expect(sorted).toEqual(rows);
  });
});

describe('playerMetaRowDrillTarget', () => {
  it('reaches every displayed column of the exact row, an interval folded into one rate fact', () => {
    const table: PlayerMetaResultTable = {
      table: 'commanders',
      source: { recordsRead: 40, recordsSkipped: 0 },
      columns: [...RATE_COLUMNS],
      rows: [],
      page: { returned: 0, limit: 50, nextCursor: null, total: 0 },
    };
    const row: ResultRow = {
      rate: 0.6,
      rateLow: 0.5,
      rateHigh: 0.7,
      rateGames: 40,
      commanderId: 'commander_1',
    };
    const target = playerMetaRowDrillTarget(table, row, 'commander_1 — Commander row');
    expect(target.title).toBe('commander_1 — Commander row');
    expect(target.facts).toEqual([
      { label: 'Win rate', value: expect.stringMatching(/%/) },
      { label: 'Commander', value: 'commander_1' },
    ]);
  });

  it('reads a null cell as "Not measured", never the literal word "null"', () => {
    const table: PlayerMetaResultTable = {
      table: 'commanders',
      source: { recordsRead: 0, recordsSkipped: 0 },
      columns: [COMMANDER_ID_COLUMN],
      rows: [],
      page: { returned: 0, limit: 50, nextCursor: null, total: 0 },
    };
    const target = playerMetaRowDrillTarget(table, { commanderId: null }, 'exact row');
    expect(target.facts).toEqual([{ label: 'Commander', value: 'Not measured' }]);
  });
});

describe('playerMetaTruncationNote', () => {
  const baseTable: PlayerMetaResultTable = {
    table: 'commanders',
    source: { recordsRead: 5, recordsSkipped: 0 },
    columns: [COMMANDER_ID_COLUMN],
    rows: [],
    page: { returned: 0, limit: 50, nextCursor: null, total: 0 },
  };

  it('reads null when a page holds the whole table', () => {
    expect(playerMetaTruncationNote(baseTable, 'rows')).toBeNull();
  });

  it('names how many of how many rows a truncated page shows', () => {
    const truncated: PlayerMetaResultTable = {
      ...baseTable,
      rows: [{ commanderId: 'a' }],
      page: { returned: 1, limit: 1, nextCursor: 'more', total: 3 },
    };
    expect(playerMetaTruncationNote(truncated, 'rows')).toBe(
      'Showing the first 1 of 3 rows — this view is incomplete.',
    );
  });
});
