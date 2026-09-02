import type {
  AdaptiveResultTable,
  AdaptiveResultTableName,
  ResultColumn,
  ResultRow,
} from '@tcg/admin-contracts';

import { formatRate, type RateReading } from './dashboard-view.js';

/**
 * Reading an `AdaptiveResultTable`'s rows into what M08.19C's dashboard draws,
 * mirroring `dashboard-view.ts` exactly for a table that has no `jobId`
 * (M08.19B's own note on why `AdaptiveResultTable` is a sibling shape rather
 * than `ResultTable` itself). Nothing here recomputes a rate the simulator did
 * not already report — `readAdaptiveRate` only finds the columns a screen
 * needs by the same `interval(key, …)` naming convention
 * `apps/admin-server/src/service/adaptive-results.ts` uses.
 *
 * `cumulativeSeriesTally`/`rollingSeriesTally` are the one place this module
 * computes anything at all, and both stay inside the rule CLAUDE.md states for
 * every automated signal: they are pure prefix/window *counts* over the
 * `series` table's own already-decided `decisionKind`/`decisionLoser` cells —
 * never a confidence interval, a trend line or a "converging" verdict the
 * simulator itself never computed.
 */

/** Reads an interval reading out of an adaptive table row, by the column's own declared bounds. */
export function readAdaptiveRate(
  table: { readonly columns: readonly ResultColumn[] },
  row: ResultRow,
  key: string,
): RateReading | null {
  const column = table.columns.find((entry) => entry.key === key);
  if (column === undefined || column.bounds === null) return null;
  const point = row[key];
  const low = row[column.bounds.low];
  const high = row[column.bounds.high];
  const total = row[`${key}Games`];
  if (typeof point !== 'number' || typeof low !== 'number' || typeof high !== 'number') {
    return null;
  }
  return { point, low, high, total: typeof total === 'number' ? total : 0 };
}

/** Whether a page of this table is not the whole of it — mirrors `dashboard-view.ts`'s `isTruncated`. */
export function isAdaptiveTruncated(table: AdaptiveResultTable): boolean {
  return table.page.nextCursor !== null;
}

/** What a screen says about a truncated adaptive table, or `null` when it read every row. */
export function adaptiveTruncationNote(table: AdaptiveResultTable, noun: string): string | null {
  if (!isAdaptiveTruncated(table)) return null;
  return `Showing the first ${String(table.page.returned)} of ${String(table.page.total)} ${noun} — this view is incomplete.`;
}

/** A cell's exact display text: an interval reads as `formatRate`, anything else as its literal value. */
export function formatAdaptiveCell(
  table: { readonly columns: readonly ResultColumn[] },
  row: ResultRow,
  column: ResultColumn,
): string {
  if (column.kind === 'interval') return formatRate(readAdaptiveRate(table, row, column.key));
  const value = row[column.key];
  return value === null ? 'Not measured' : String(value);
}

/** The columns a generic exact-table view should print — an interval's own bound/count columns are folded into its one cell. */
export function displayColumns(table: {
  readonly columns: readonly ResultColumn[];
}): readonly ResultColumn[] {
  const consumed = new Set<string>();
  for (const column of table.columns) {
    if (column.kind === 'interval' && column.bounds !== null) {
      consumed.add(column.bounds.low);
      consumed.add(column.bounds.high);
      consumed.add(`${column.key}Games`);
    }
  }
  return table.columns.filter((column) => !consumed.has(column.key));
}

/* ------------------------------------------------------------------ the series tallies */

export interface SeriesTallyPoint {
  readonly generation: number;
  readonly block: number;
  readonly decisionKind: string;
  readonly incumbentWins: number;
  readonly opponentWins: number;
  readonly ties: number;
  readonly noDecisions: number;
}

function tallyOf(rows: readonly ResultRow[]): {
  incumbentWins: number;
  opponentWins: number;
  ties: number;
  noDecisions: number;
} {
  let incumbentWins = 0;
  let opponentWins = 0;
  let ties = 0;
  let noDecisions = 0;
  for (const row of rows) {
    const kind = String(row.decisionKind ?? '');
    if (kind === 'win') {
      if (row.decisionLoser === 'incumbent') opponentWins += 1;
      else if (row.decisionLoser === 'opponent') incumbentWins += 1;
    } else if (kind === 'tie') {
      ties += 1;
    } else if (kind === 'no_decision') {
      noDecisions += 1;
    }
  }
  return { incumbentWins, opponentWins, ties, noDecisions };
}

/**
 * The series score after each decided block, in the table's own row order —
 * a running total, not a rate: `AdaptiveBlockDecision`'s `kind`/`loser` cells
 * are categorical facts the simulator already decided, and a prefix count
 * over them stays exactly as certain as the row it was summed from.
 */
export function cumulativeSeriesTally(rows: readonly ResultRow[]): readonly SeriesTallyPoint[] {
  return rows.map((row, index) => {
    const { incumbentWins, opponentWins, ties, noDecisions } = tallyOf(rows.slice(0, index + 1));
    return {
      generation: Number(row.generation ?? 0),
      block: Number(row.block ?? 0),
      decisionKind: String(row.decisionKind ?? ''),
      incumbentWins,
      opponentWins,
      ties,
      noDecisions,
    };
  });
}

/** How many decided blocks a rolling window counts, by default. */
export const ADAPTIVE_ROLLING_WINDOW = 10;

/** The series score over the trailing `windowSize` blocks, at each row. */
export function rollingSeriesTally(
  rows: readonly ResultRow[],
  windowSize: number = ADAPTIVE_ROLLING_WINDOW,
): readonly SeriesTallyPoint[] {
  return rows.map((row, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const { incumbentWins, opponentWins, ties, noDecisions } = tallyOf(
      rows.slice(start, index + 1),
    );
    return {
      generation: Number(row.generation ?? 0),
      block: Number(row.block ?? 0),
      decisionKind: String(row.decisionKind ?? ''),
      incumbentWins,
      opponentWins,
      ties,
      noDecisions,
    };
  });
}

/** The five tables M08.19C shows. `cycles` and `validation` are M08.19D's. */
export const ADAPTIVE_DASHBOARD_TABLES: readonly AdaptiveResultTableName[] = [
  'series',
  'revisions',
  'screening_candidates',
  'deck_diff',
  'reference_field',
];
