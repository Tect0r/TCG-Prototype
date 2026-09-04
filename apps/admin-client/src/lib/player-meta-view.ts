import type {
  PlayerMetaResultTable,
  PlayerMetaResultTableName,
  ResultColumn,
  ResultRow,
} from '@tcg/admin-contracts';

import { formatRate, type RateReading } from './dashboard-view.js';

/**
 * Reading a `PlayerMetaResultTable`'s rows into what M08.25C's dashboard
 * draws, mirroring `adaptive-view.ts` exactly for a table that has neither a
 * `jobId` nor an `experimentId` (`player-meta-results.ts`'s own note on why).
 * Nothing here recomputes a rate the simulator did not already report —
 * `readPlayerMetaRate` only finds the columns a screen needs by the same
 * `interval(key, …)` naming convention
 * `apps/admin-server/src/service/player-meta-results.ts` uses.
 *
 * Deliberately narrower than `adaptive-view.ts`: no series tally (a Player
 * Meta table has no generation/block concept to tally over).
 * `sortPlayerMetaRowsByWeight` is M08.25C's one addition — a plain
 * descending sort by whichever already-declared count column the caller
 * picked, never a number the server did not already compute (CLAUDE.md:
 * automated signals are evidence, never a verdict).
 *
 * `playerMetaRowDrillTarget` (M08.25E) is the drill-down every Player Meta
 * table shares, mirroring `adaptive-view.ts`'s own `adaptiveRowDrillTarget`:
 * it reaches the exact row a bar or cell summarizes, never a match or a
 * replay — the same boundary `ResultDashboard.tsx`'s `rowDrillTarget` and
 * `adaptive-view.ts`'s `adaptiveRowDrillTarget` both draw, for the reason
 * their doc comments give: individual matches and replays are a directory
 * listing this app deliberately does not serve yet (M08.26's Match
 * Explorer).
 */

/** Reads an interval reading out of a Player Meta table row, by the column's own declared bounds. */
export function readPlayerMetaRate(
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
export function isPlayerMetaTruncated(table: PlayerMetaResultTable): boolean {
  return table.page.nextCursor !== null;
}

/** What a screen says about a truncated Player Meta table, or `null` when it read every row. */
export function playerMetaTruncationNote(
  table: PlayerMetaResultTable,
  noun: string,
): string | null {
  if (!isPlayerMetaTruncated(table)) return null;
  return `Showing the first ${String(table.page.returned)} of ${String(table.page.total)} ${noun} — this view is incomplete.`;
}

/** A cell's exact display text: an interval reads as `formatRate`, anything else as its literal value. */
export function formatPlayerMetaCell(
  table: { readonly columns: readonly ResultColumn[] },
  row: ResultRow,
  column: ResultColumn,
): string {
  if (column.kind === 'interval') return formatRate(readPlayerMetaRate(table, row, column.key));
  const value = row[column.key];
  return value === null ? 'Not measured' : String(value);
}

/** What a row's drill-down opens: the title a caller gave it, plus every displayed column's exact fact. */
export interface PlayerMetaDrillTarget {
  readonly title: string;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
}

/** The exact row a table cell was drawn from — an interval folded into one rate fact, per `displayColumns`. */
export function playerMetaRowDrillTarget(
  table: PlayerMetaResultTable,
  row: ResultRow,
  title: string,
): PlayerMetaDrillTarget {
  const facts = displayColumns(table).map((column) => {
    if (column.kind === 'interval') {
      return {
        label: column.label,
        value: formatRate(readPlayerMetaRate(table, row, column.key)),
      };
    }
    const value = row[column.key];
    return { label: column.label, value: value === null ? 'Not measured' : String(value) };
  });
  return { title, facts };
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

/** Every table `PLAYER_META_RESULT_TABLE_NAMES` names, in that order. */
export const PLAYER_META_DASHBOARD_TABLES: readonly PlayerMetaResultTableName[] = [
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
];

/** Match-weighted or unique-deck-weighted — the only two denominators M08.24/25 ever computes (`PLAYER_META_RUN_LIMITATIONS`). */
export type PlayerMetaWeighting = 'matches' | 'unique';

interface PlayerMetaWeightColumns {
  readonly matches: string;
  readonly unique: string;
}

/**
 * Which two already-declared columns a weighting toggle switches between,
 * for the only two tables whose rows aggregate over more than one deck and
 * do not already show both weightings as separate always-visible columns
 * (`cards`/`pairs` already do, so they carry no entry here).
 */
export const PLAYER_META_WEIGHT_COLUMNS: Readonly<
  Partial<Record<PlayerMetaResultTableName, PlayerMetaWeightColumns>>
> = {
  commanders: { matches: 'matches', unique: 'uniqueDecks' },
  clusters: { matches: 'matches', unique: 'deckCount' },
};

/** Whether this table offers a match/unique-deck weighting toggle at all. */
export function hasPlayerMetaWeighting(table: PlayerMetaResultTableName): boolean {
  return table in PLAYER_META_WEIGHT_COLUMNS;
}

/**
 * Rows sorted by the chosen weighting's already-declared count column,
 * highest first. A no-op for a table with no weighting column — the
 * server's own row order stands.
 */
export function sortPlayerMetaRowsByWeight(
  table: PlayerMetaResultTableName,
  rows: readonly ResultRow[],
  weighting: PlayerMetaWeighting,
): readonly ResultRow[] {
  const columns = PLAYER_META_WEIGHT_COLUMNS[table];
  if (columns === undefined) return rows;
  const key = columns[weighting];
  return [...rows].sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0));
}
