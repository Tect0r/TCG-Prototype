import type { CatalogJobView, ResultRow, ResultTable, ResultTableName } from '@tcg/admin-contracts';

/**
 * Reading a result table's rows into what M08.11's views actually draw, without
 * this module acquiring an opinion about what any number means.
 *
 * `ResultTable` is transport: a column is a key, a label and a display kind, a
 * row is scalars under those keys (`packages/admin-contracts/src/results.ts`).
 * Nothing here recomputes a rate or invents a threshold the simulator did not
 * already report — it only finds the columns a screen needs by the naming
 * convention `apps/admin-server/src/service/results.ts` already uses
 * (`interval(key, …)` names `${key}Low`/`${key}High`, and every call site next
 * to it adds a `${key}Games` count column beside it) and reads them out.
 */

/** One proportion, exactly as the simulator reported it. `null` means *not measured*. */
export interface RateReading {
  readonly point: number;
  readonly low: number;
  readonly high: number;
  readonly total: number;
}

/**
 * Reads an interval reading out of a row, by the column's own declared bounds.
 *
 * Returns `null` when the point cell is `null` (not measured) or when the row
 * carries no such column — both are *insufficient data*, and a caller must not
 * draw a zero-width bar for either.
 */
export function readRate(table: ResultTable, row: ResultRow, key: string): RateReading | null {
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

/** A rate reading with the total games it rests on, or none. Insufficient when `total` is 0. */
export function isInsufficient(rate: RateReading | null): boolean {
  return rate === null || rate.total === 0;
}

/**
 * Whether a page of this table is not the whole of it.
 *
 * `resultTableSchema.page.nextCursor` is the contract's own answer to *is
 * there more* (`packages/admin-contracts/src/pagination.ts`); a dashboard that
 * fetched one page and stayed silent about a non-null cursor would be the
 * exact defect the milestone's own rules forbid in the other direction —
 * *zero observations are not a zero win rate* — read backwards: an
 * unread row is not a confirmed absence.
 */
export function isTruncated(table: ResultTable): boolean {
  return table.page.nextCursor !== null;
}

/** What a screen says about a truncated table, or `null` when it read every row. */
export function truncationNote(table: ResultTable, noun: string): string | null {
  if (!isTruncated(table)) return null;
  return `Showing the first ${String(table.page.returned)} of ${String(table.page.total)} ${noun} — this view is incomplete.`;
}

/**
 * Appends a short discriminator to a label that repeats.
 *
 * A precon benchmark's `commanderId` is one-to-one with a deck, so labelling a
 * row by its precon name is unambiguous there — but a search run's population
 * can carry many decks under one Commander, and two rows or two heatmap axes
 * reading the same word are indistinguishable to anyone, sighted or not.
 */
export function disambiguateLabels<T extends { readonly key: string; readonly label: string }>(
  items: readonly T[],
): readonly T[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  return items.map((item) =>
    (counts.get(item.label) ?? 0) > 1
      ? { ...item, label: `${item.label} (${item.key.slice(-6)})` }
      : item,
  );
}

export interface RateBarItem {
  readonly key: string;
  readonly label: string;
  readonly rate: RateReading | null;
}

/** Rows sorted by their rate's point estimate, richest first. Insufficient rows sort last. */
export function orderedByRate(items: readonly RateBarItem[]): readonly RateBarItem[] {
  return [...items].sort((left, right) => {
    if (isInsufficient(left.rate) && isInsufficient(right.rate)) return 0;
    if (isInsufficient(left.rate)) return 1;
    if (isInsufficient(right.rate)) return -1;
    return (right.rate?.point ?? 0) - (left.rate?.point ?? 0);
  });
}

/* --------------------------------------------------------------- the heatmap */

export interface HeatmapAxis {
  readonly key: string;
  readonly label: string;
}

export interface HeatmapCell {
  readonly rowKey: string;
  readonly columnKey: string;
  readonly rate: RateReading | null;
  /** Whether this pair had a row in the fetched page of `matchups` at all. */
  readonly found: boolean;
}

export interface HeatmapMatrix {
  readonly rows: readonly HeatmapAxis[];
  readonly columns: readonly HeatmapAxis[];
  readonly cellAt: (rowKey: string, columnKey: string) => HeatmapCell;
  /** Whether the `decks` table this matrix's axes came from was truncated. */
  readonly decksTruncated: boolean;
  /** Whether the `matchups` table this matrix's cells came from was truncated. */
  readonly matchupsTruncated: boolean;
}

/**
 * A `decks` table plus a `matchups` table, folded into an ordered square
 * matrix keyed by deck content address.
 *
 * Ordered by each deck's own win rate, richest first on both axes, so the
 * strongest deck's row and column sit together — the "ordered" the checklist
 * asks for. A pair the matchups table never named reads back `found: false`
 * rather than a fabricated 0% — but *never named* is only *never played* when
 * `matchupsTruncated` is also false: one page of a table that has more pages
 * has nothing to say about a pair sitting on a page it never read, and a
 * caller must tell those two apart rather than reporting both as "no games".
 */
export function buildMatchupMatrix(
  decksTable: ResultTable,
  matchupsTable: ResultTable,
  labelForCommander: (commanderId: string) => string = (commanderId) => commanderId,
): HeatmapMatrix {
  const decksByRate = orderedByRate(
    decksTable.rows.map((row) => ({
      key: String(row.deckHash ?? ''),
      label: labelForCommander(String(row.commanderId ?? row.deckHash ?? '')),
      rate: readRate(decksTable, row, 'winRate'),
    })),
  );
  const axes: readonly HeatmapAxis[] = disambiguateLabels(
    decksByRate.map((item) => ({ key: item.key, label: item.label })),
  );

  const cells = new Map<string, RateReading | null>();
  for (const row of matchupsTable.rows) {
    const deckHash = String(row.deckHash ?? '');
    const opponentHash = String(row.opponentHash ?? '');
    cells.set(`${deckHash} ${opponentHash}`, readRate(matchupsTable, row, 'rate'));
  }

  return {
    rows: axes,
    columns: axes,
    decksTruncated: isTruncated(decksTable),
    matchupsTruncated: isTruncated(matchupsTable),
    cellAt: (rowKey, columnKey) => {
      const found = cells.has(`${rowKey} ${columnKey}`);
      return {
        rowKey,
        columnKey,
        found,
        rate: found ? (cells.get(`${rowKey} ${columnKey}`) ?? null) : null,
      };
    },
  };
}

/* ------------------------------------------------------------- the replicate view */

/**
 * Which sibling jobs in the same batch are independent replicates of this one.
 *
 * `apps/admin-server/src/lab/expand.ts` derives a replicate's stage as
 * `matches` (single) or `matches-r${ordinal}` (replicated), each its own job in
 * the batch the preset expanded into. Stripping the `-r{n}` suffix and matching
 * on `batchId` plus `presetId` plus that stripped stage is the whole of the
 * grouping rule: there is no field on the job that says "replicate of", only
 * the naming convention the preset expansion already committed to.
 */
const REPLICATE_STAGE = /^(.*)-r\d+$/;

function stageBase(stageId: string): string {
  return REPLICATE_STAGE.exec(stageId)?.[1] ?? stageId;
}

export function replicateSiblings(
  jobs: readonly CatalogJobView[],
  current: CatalogJobView,
): readonly CatalogJobView[] {
  const currentOrigin = current.origin;
  if (currentOrigin.kind !== 'preset') return [];
  const currentBase = stageBase(currentOrigin.stageId);
  return jobs
    .filter((job) => job.batchId === current.batchId && job.origin.kind === 'preset')
    .filter((job) => {
      const origin = job.origin;
      return (
        origin.kind === 'preset' &&
        origin.presetId === currentOrigin.presetId &&
        stageBase(origin.stageId) === currentBase
      );
    })
    .sort((left, right) => {
      const leftOrigin = left.origin;
      const rightOrigin = right.origin;
      const leftStage = leftOrigin.kind === 'preset' ? leftOrigin.stageId : '';
      const rightStage = rightOrigin.kind === 'preset' ? rightOrigin.stageId : '';
      return leftStage.localeCompare(rightStage);
    });
}

/** The tables the dashboard reads, kept in one place so a view and its fetch cannot drift. */
export const DASHBOARD_TABLES: readonly ResultTableName[] = [
  'decks',
  'matchups',
  'seats',
  'pilots',
  'terminations',
];

/* ----------------------------------------------------------------- formatting */

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function formatRate(rate: RateReading | null): string {
  if (rate === null || rate.total === 0) return 'Insufficient data — no games recorded';
  return `${formatPercent(rate.point)} (${formatPercent(rate.low)}–${formatPercent(rate.high)}, n=${String(rate.total)})`;
}
