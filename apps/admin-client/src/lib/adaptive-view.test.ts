import { describe, expect, it } from 'vitest';

import type { ResultColumn, ResultRow } from '@tcg/admin-contracts';

import {
  cumulativeSeriesTally,
  displayColumns,
  formatAdaptiveCell,
  readAdaptiveRate,
  rollingSeriesTally,
} from './adaptive-view.js';

const SCORE_COLUMN: ResultColumn = {
  key: 'score',
  label: 'Promotion score',
  kind: 'interval',
  bounds: { low: 'scoreLow', high: 'scoreHigh' },
};
const SCORE_GAMES_COLUMN: ResultColumn = {
  key: 'scoreGames',
  label: 'Promotion score games',
  kind: 'count',
  bounds: null,
};
const REVISION_ID_COLUMN: ResultColumn = {
  key: 'revisionId',
  label: 'Candidate revision',
  kind: 'identifier',
  bounds: null,
};
const SCORE_COLUMNS: readonly ResultColumn[] = [
  SCORE_COLUMN,
  SCORE_GAMES_COLUMN,
  REVISION_ID_COLUMN,
];

describe('reading an interval cell', () => {
  it('reads the point, bounds and sample count by the column’s own key convention', () => {
    const row: ResultRow = {
      score: 0.6,
      scoreLow: 0.5,
      scoreHigh: 0.7,
      scoreGames: 40,
      revisionId: 'rev_1',
    };
    expect(readAdaptiveRate({ columns: SCORE_COLUMNS }, row, 'score')).toEqual({
      point: 0.6,
      low: 0.5,
      high: 0.7,
      total: 40,
    });
  });

  it('reads null for a column that carries no bounds', () => {
    const row: ResultRow = { revisionId: 'rev_1' };
    expect(readAdaptiveRate({ columns: SCORE_COLUMNS }, row, 'revisionId')).toBeNull();
  });
});

describe('displayColumns', () => {
  it('folds an interval’s bound and count columns into its own one cell', () => {
    const shown = displayColumns({ columns: SCORE_COLUMNS });
    expect(shown.map((column) => column.key)).toEqual(['score', 'revisionId']);
  });
});

describe('formatAdaptiveCell', () => {
  it('formats an interval cell as a rate, and a plain cell as its literal value', () => {
    const row: ResultRow = {
      score: 0.6,
      scoreLow: 0.5,
      scoreHigh: 0.7,
      scoreGames: 40,
      revisionId: 'rev_1',
    };
    const table = { columns: SCORE_COLUMNS };
    expect(formatAdaptiveCell(table, row, SCORE_COLUMN)).toMatch(/%/);
    expect(formatAdaptiveCell(table, row, REVISION_ID_COLUMN)).toBe('rev_1');
  });

  it('prints "Not measured" for a null cell rather than the literal word "null"', () => {
    const row: ResultRow = { revisionId: null };
    expect(formatAdaptiveCell({ columns: SCORE_COLUMNS }, row, REVISION_ID_COLUMN)).toBe(
      'Not measured',
    );
  });
});

describe('series tallies', () => {
  const rows: readonly ResultRow[] = [
    { decisionKind: 'win', decisionLoser: 'opponent' },
    { decisionKind: 'win', decisionLoser: 'incumbent' },
    { decisionKind: 'tie', decisionLoser: null },
    { decisionKind: 'no_decision', decisionLoser: null },
  ];

  it('accumulates a running count over every decided block seen so far', () => {
    const points = cumulativeSeriesTally(rows);
    expect(points).toHaveLength(4);
    expect(points[0]).toMatchObject({ incumbentWins: 1, opponentWins: 0, ties: 0, noDecisions: 0 });
    expect(points[3]).toMatchObject({ incumbentWins: 1, opponentWins: 1, ties: 1, noDecisions: 1 });
  });

  it('counts only the trailing window, not the whole history', () => {
    const points = rollingSeriesTally(rows, 2);
    // The last point's window is rows[2..3]: one tie, one no-decision, no wins.
    expect(points[3]).toMatchObject({ incumbentWins: 0, opponentWins: 0, ties: 1, noDecisions: 1 });
  });
});
