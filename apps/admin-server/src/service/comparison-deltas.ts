import {
  type CATALOG_COMPARISON_DELTA_TABLES,
  NO_PLAYER_META_FILTER,
  PAGE_SIZE_MAX,
  adminError,
  comparisonDeltaTableSchema,
  decideCatalogEnvironmentComparison,
  decidePlayerMetaComparison,
  type AdminError,
  type ComparisonDeltaIdentity,
  type ComparisonDeltaTable,
  type ComparisonDeltaTableName,
  type JobId,
  type PlayerMetaPartition,
  type PlayerMetaResultTableName,
  type ResultCell,
  type ResultColumn,
  type ResultRow,
  type ResultSummary,
  type ResultTableName,
} from '@tcg/admin-contracts';
import { err, isErr, ok, type Result } from '@tcg/shared';

import type { PlayerMetaResultReader } from './player-meta-results.js';
import type { ResultReader } from './results.js';

/**
 * M08.27B — computing the deltas `packages/admin-contracts/src/comparison-deltas.ts`
 * transports. See that file's doc comment for the scope decisions this module
 * carries out rather than re-deciding: `deckId` as the deck-family key,
 * surrender-pattern scoped to state/turn/phase (not exposure), and the
 * Player Meta `compatible`-unreachability gap accepted as-is.
 *
 * Nothing here recomputes a rate, a bound or a support count — every source
 * value is read back out of `ResultReader`/`PlayerMetaResultReader`, exactly
 * as `./results.ts`'s own doc comment requires of every result view. This
 * file's only arithmetic is the delta itself: `candidate - baseline`, and
 * only when both sides have support.
 */

type CatalogDeltaTableName = (typeof CATALOG_COMPARISON_DELTA_TABLES)[number];

const CATALOG_TABLE_SOURCE: Record<Exclude<CatalogDeltaTableName, 'duration'>, ResultTableName> = {
  deck_matchups: 'matchups',
  commander_matchups: 'commander_matchups',
  card_inclusion: 'cards',
  terminations: 'terminations',
  deck_family: 'decks',
};

const CATALOG_TABLE_KEYS: Record<Exclude<CatalogDeltaTableName, 'duration'>, readonly string[]> = {
  deck_matchups: ['deckHash', 'opponentHash'],
  commander_matchups: ['commanderId', 'opponentCommanderId'],
  card_inclusion: ['definitionId'],
  terminations: ['kind'],
  deck_family: ['deckId'],
};

const PLAYER_META_TABLE_SOURCE: Record<
  'surrender_turns' | 'surrender_phases' | 'surrender_state',
  PlayerMetaResultTableName
> = {
  surrender_turns: 'surrender_turns',
  surrender_phases: 'surrender_phases',
  surrender_state: 'surrender_state',
};

const PLAYER_META_TABLE_KEYS: Record<
  'surrender_turns' | 'surrender_phases' | 'surrender_state',
  readonly string[]
> = {
  surrender_turns: ['turn'],
  surrender_phases: ['phase'],
  surrender_state: [],
};

/** Whole-run readings this build diffs for the `duration` table — a fixed subset of `ResultSummary.readings`, never a table of its own. */
const DURATION_READING_KEYS: readonly string[] = [
  'matches',
  'usableMatches',
  'abnormalMatches',
  'abnormalShare',
  'draws',
  'turnsMean',
  'turnsMedian',
  'turnsP10',
  'turnsP90',
  'turnsMax',
  'decisionsPerMatch',
  'botFailures',
];

interface DeltaSource {
  readonly columns: readonly ResultColumn[];
  readonly rows: readonly ResultRow[];
}

function builtBadly(table: ComparisonDeltaTableName): AdminError {
  return adminError(
    'admin/schema',
    'This service built a comparison delta it could not validate against its own contract, so it was not sent. This is a defect in the build rather than a problem with either run.',
    { context: { view: table } },
  );
}

function noEnvironment(jobId: JobId): AdminError {
  return adminError(
    'admin/no_result',
    'The run this job indexes names no environment, so there is nothing to compare it against.',
    { context: { jobId } },
  );
}

function validate(value: {
  table: ComparisonDeltaTableName;
  identity: ComparisonDeltaIdentity;
  decision: ReturnType<typeof decideCatalogEnvironmentComparison>;
  columns: readonly ResultColumn[];
  rows: readonly ResultRow[];
}): Result<ComparisonDeltaTable, readonly AdminError[]> {
  const parsed = comparisonDeltaTableSchema.safeParse(value);
  if (!parsed.success) return err([builtBadly(value.table)]);
  return ok(parsed.data);
}

function capitalize(value: string): string {
  const first = value.charAt(0);
  return first === '' ? value : first.toUpperCase() + value.slice(1);
}

function numberOrNull(value: ResultCell | undefined): number | null {
  return typeof value === 'number' ? value : null;
}

function rowKey(row: ResultRow, keyColumns: readonly string[]): string {
  return keyColumns.map((key) => String(row[key] ?? '')).join('');
}

/**
 * The one generic delta builder every category below calls. `keyColumns`
 * says how to match a baseline row to its candidate: empty means "there is
 * exactly one row per side" (`duration`, `surrender_state`), non-empty means
 * "match by these fields, and a row on only one side is an appearance or
 * disappearance" — which is the whole of what `deck_family` needs, not a
 * separate mechanism (see the contracts file's doc comment).
 *
 * A metric column with `bounds !== null` (built with `./results.ts`'s
 * `interval()`) is read as a point-plus-support pair, using its `${key}Games`
 * sibling for support — never re-bounded into a new interval. Every other
 * numeric column (`count`/`number`/`proportion`/`milliseconds`) is diffed on
 * its raw value. `identifier`/`flag`/`text` columns that are not part of the
 * key pass through both sides without a delta, so nothing is silently
 * dropped from the source table.
 */
function buildDeltaTable(
  keyColumns: readonly string[],
  baseline: DeltaSource,
  candidate: DeltaSource,
): { columns: ResultColumn[]; rows: ResultRow[] } {
  const sourceColumns = baseline.columns.length > 0 ? baseline.columns : candidate.columns;

  const intervalMetrics: ResultColumn[] = [];
  const consumedKeys = new Set<string>();
  for (const col of sourceColumns) {
    if (keyColumns.includes(col.key)) continue;
    if (col.bounds !== null) {
      intervalMetrics.push(col);
      consumedKeys.add(col.bounds.low);
      consumedKeys.add(col.bounds.high);
      consumedKeys.add(`${col.key}Games`);
    }
  }

  const standaloneMetrics: ResultColumn[] = [];
  const passthroughColumns: ResultColumn[] = [];
  for (const col of sourceColumns) {
    if (keyColumns.includes(col.key)) continue;
    if (consumedKeys.has(col.key)) continue;
    if (intervalMetrics.some((metric) => metric.key === col.key)) continue;
    if (
      col.kind === 'count' ||
      col.kind === 'number' ||
      col.kind === 'proportion' ||
      col.kind === 'milliseconds'
    ) {
      standaloneMetrics.push(col);
    } else {
      passthroughColumns.push(col);
    }
  }

  const columns: ResultColumn[] = [];
  for (const key of keyColumns) {
    const original = sourceColumns.find((col) => col.key === key);
    columns.push(original ?? { key, label: key, kind: 'identifier', bounds: null });
  }
  if (keyColumns.length > 0) {
    columns.push({ key: 'presence', label: 'Presence', kind: 'identifier', bounds: null });
  }
  for (const metric of intervalMetrics) {
    const name = capitalize(metric.key);
    columns.push({
      key: `baseline${name}`,
      label: `Baseline ${metric.label}`,
      kind: 'proportion',
      bounds: null,
    });
    columns.push({
      key: `candidate${name}`,
      label: `Candidate ${metric.label}`,
      kind: 'proportion',
      bounds: null,
    });
    columns.push({
      key: `delta${name}`,
      label: `${metric.label} delta`,
      kind: 'number',
      bounds: null,
    });
    columns.push({
      key: `baseline${name}Games`,
      label: `Baseline ${metric.label} support`,
      kind: 'count',
      bounds: null,
    });
    columns.push({
      key: `candidate${name}Games`,
      label: `Candidate ${metric.label} support`,
      kind: 'count',
      bounds: null,
    });
  }
  for (const metric of standaloneMetrics) {
    const name = capitalize(metric.key);
    columns.push({
      key: `baseline${name}`,
      label: `Baseline ${metric.label}`,
      kind: metric.kind,
      bounds: null,
    });
    columns.push({
      key: `candidate${name}`,
      label: `Candidate ${metric.label}`,
      kind: metric.kind,
      bounds: null,
    });
    columns.push({
      key: `delta${name}`,
      label: `${metric.label} delta`,
      kind: 'number',
      bounds: null,
    });
  }
  for (const passthrough of passthroughColumns) {
    const name = capitalize(passthrough.key);
    columns.push({
      key: `baseline${name}`,
      label: `Baseline ${passthrough.label}`,
      kind: passthrough.kind,
      bounds: null,
    });
    columns.push({
      key: `candidate${name}`,
      label: `Candidate ${passthrough.label}`,
      kind: passthrough.kind,
      bounds: null,
    });
  }

  function buildRow(baseRow: ResultRow | undefined, candRow: ResultRow | undefined): ResultRow {
    const row: ResultRow = {};
    for (const key of keyColumns) {
      row[key] = (baseRow?.[key] ?? candRow?.[key] ?? null) as ResultCell;
    }
    if (keyColumns.length > 0) {
      row.presence =
        baseRow !== undefined && candRow !== undefined
          ? 'both'
          : baseRow !== undefined
            ? 'baseline_only'
            : 'candidate_only';
    }
    for (const metric of intervalMetrics) {
      const name = capitalize(metric.key);
      const baselineGames =
        baseRow === undefined ? 0 : (numberOrNull(baseRow[`${metric.key}Games`]) ?? 0);
      const candidateGames =
        candRow === undefined ? 0 : (numberOrNull(candRow[`${metric.key}Games`]) ?? 0);
      const baselinePoint = baselineGames === 0 ? null : numberOrNull(baseRow?.[metric.key]);
      const candidatePoint = candidateGames === 0 ? null : numberOrNull(candRow?.[metric.key]);
      row[`baseline${name}`] = baselinePoint;
      row[`candidate${name}`] = candidatePoint;
      row[`delta${name}`] =
        baselinePoint !== null && candidatePoint !== null ? candidatePoint - baselinePoint : null;
      row[`baseline${name}Games`] = baselineGames;
      row[`candidate${name}Games`] = candidateGames;
    }
    for (const metric of standaloneMetrics) {
      const name = capitalize(metric.key);
      const baselineValue = baseRow === undefined ? null : numberOrNull(baseRow[metric.key]);
      const candidateValue = candRow === undefined ? null : numberOrNull(candRow[metric.key]);
      row[`baseline${name}`] = baselineValue;
      row[`candidate${name}`] = candidateValue;
      row[`delta${name}`] =
        baselineValue !== null && candidateValue !== null ? candidateValue - baselineValue : null;
    }
    for (const passthrough of passthroughColumns) {
      const name = capitalize(passthrough.key);
      row[`baseline${name}`] = (baseRow?.[passthrough.key] ?? null) as ResultCell;
      row[`candidate${name}`] = (candRow?.[passthrough.key] ?? null) as ResultCell;
    }
    return row;
  }

  const rows: ResultRow[] = [];
  if (keyColumns.length === 0) {
    rows.push(buildRow(baseline.rows[0], candidate.rows[0]));
  } else {
    const baselineByKey = new Map(
      baseline.rows.map((row) => [rowKey(row, keyColumns), row] as const),
    );
    const candidateByKey = new Map(
      candidate.rows.map((row) => [rowKey(row, keyColumns), row] as const),
    );
    const allKeys = [...new Set([...baselineByKey.keys(), ...candidateByKey.keys()])].sort();
    for (const key of allKeys) {
      rows.push(buildRow(baselineByKey.get(key), candidateByKey.get(key)));
    }
  }

  return { columns, rows };
}

function durationSource(summary: ResultSummary): DeltaSource {
  const selected = summary.readings.filter((reading) =>
    DURATION_READING_KEYS.includes(reading.key),
  );
  return {
    columns: selected.map((reading) => ({
      key: reading.key,
      label: reading.label,
      kind: reading.kind,
      bounds: null,
    })),
    rows: [Object.fromEntries(selected.map((reading) => [reading.key, reading.value]))],
  };
}

async function readAllCatalogRows(
  reader: ResultReader,
  jobId: JobId,
  table: ResultTableName,
): Promise<Result<DeltaSource, readonly AdminError[]>> {
  let cursor: string | null = null;
  let columns: readonly ResultColumn[] = [];
  const rows: ResultRow[] = [];
  for (;;) {
    const page = await reader.readTable(jobId, table, { limit: PAGE_SIZE_MAX, cursor });
    if (isErr(page)) return page;
    columns = page.value.columns;
    rows.push(...page.value.rows);
    if (page.value.page.nextCursor === null) break;
    cursor = page.value.page.nextCursor;
  }
  return ok({ columns, rows });
}

function readAllPlayerMetaRows(
  reader: PlayerMetaResultReader,
  table: PlayerMetaResultTableName,
  partition: PlayerMetaPartition,
): Result<DeltaSource, readonly AdminError[]> {
  let cursor: string | null = null;
  let columns: readonly ResultColumn[] = [];
  const rows: ResultRow[] = [];
  const filter = {
    ...NO_PLAYER_META_FILTER,
    sources: [partition.source],
    contentVersions: [partition.contentVersion],
  };
  for (;;) {
    const page = reader.readTable(table, filter, { limit: PAGE_SIZE_MAX, cursor });
    if (isErr(page)) return page;
    columns = page.value.columns;
    for (const row of page.value.rows) {
      if (row.rulesVersion === partition.rulesVersion) rows.push(row);
    }
    if (page.value.page.nextCursor === null) break;
    cursor = page.value.page.nextCursor;
  }
  return ok({ columns, rows });
}

/**
 * Computes one catalog-domain delta table (`deck_matchups`, `commander_matchups`,
 * `card_inclusion`, `duration`, `terminations` or `deck_family`) between two
 * jobs, gating on `decideCatalogEnvironmentComparison` — a `refused` verdict
 * returns immediately with no table read and an empty payload.
 *
 * The environment compared is `identity.environments[0]` on each side, the
 * same "first stable thing found" anchor `ResultReader.readProvenance` already
 * documents for a single-environment stamp.
 */
export async function computeCatalogComparisonDelta(
  reader: ResultReader,
  table: CatalogDeltaTableName,
  baselineJobId: JobId,
  candidateJobId: JobId,
  declaredChange?: string,
): Promise<Result<ComparisonDeltaTable, readonly AdminError[]>> {
  const baselineSummary = await reader.readSummary(baselineJobId);
  if (isErr(baselineSummary)) return baselineSummary;
  const candidateSummary = await reader.readSummary(candidateJobId);
  if (isErr(candidateSummary)) return candidateSummary;

  const baselineEnvironment = baselineSummary.value.identity.environments[0];
  if (baselineEnvironment === undefined) {
    return err([noEnvironment(baselineJobId)]);
  }
  const candidateEnvironment = candidateSummary.value.identity.environments[0];
  if (candidateEnvironment === undefined) {
    return err([noEnvironment(candidateJobId)]);
  }
  const decision = decideCatalogEnvironmentComparison(
    baselineEnvironment.hashes,
    candidateEnvironment.hashes,
    declaredChange,
  );

  const identity: ComparisonDeltaIdentity = { domain: 'catalog', baselineJobId, candidateJobId };

  if (decision.kind === 'refused') {
    return validate({ table, identity, decision, columns: [], rows: [] });
  }

  if (table === 'duration') {
    const built = buildDeltaTable(
      [],
      durationSource(baselineSummary.value),
      durationSource(candidateSummary.value),
    );
    return validate({ table, identity, decision, columns: built.columns, rows: built.rows });
  }

  const sourceTable = CATALOG_TABLE_SOURCE[table];
  const keyColumns = CATALOG_TABLE_KEYS[table];
  const baselineRows = await readAllCatalogRows(reader, baselineJobId, sourceTable);
  if (isErr(baselineRows)) return baselineRows;
  const candidateRows = await readAllCatalogRows(reader, candidateJobId, sourceTable);
  if (isErr(candidateRows)) return candidateRows;

  const built = buildDeltaTable(keyColumns, baselineRows.value, candidateRows.value);
  return validate({ table, identity, decision, columns: built.columns, rows: built.rows });
}

/**
 * Computes one Player Meta-domain delta table (`surrender_turns`,
 * `surrender_phases` or `surrender_state`) between two partitions, gating on
 * `decidePlayerMetaComparison` — a `refused` verdict returns immediately with
 * no table read and an empty payload. See the contracts file's doc comment
 * for why every reachable verdict here is `refused` or `deliberately_different`,
 * never `compatible` — a documented property of the gate this slice computes
 * deltas from, not a defect introduced here.
 */
export function computePlayerMetaComparisonDelta(
  reader: PlayerMetaResultReader,
  table: 'surrender_turns' | 'surrender_phases' | 'surrender_state',
  baseline: PlayerMetaPartition,
  candidate: PlayerMetaPartition,
  declaredChange?: string,
): Result<ComparisonDeltaTable, readonly AdminError[]> {
  const decision = decidePlayerMetaComparison(baseline, candidate, declaredChange);
  const identity: ComparisonDeltaIdentity = { domain: 'player_meta', baseline, candidate };

  if (decision.kind === 'refused') {
    return validate({ table, identity, decision, columns: [], rows: [] });
  }

  const sourceTable = PLAYER_META_TABLE_SOURCE[table];
  const keyColumns = PLAYER_META_TABLE_KEYS[table];
  const baselineRows = readAllPlayerMetaRows(reader, sourceTable, baseline);
  if (isErr(baselineRows)) return baselineRows;
  const candidateRows = readAllPlayerMetaRows(reader, sourceTable, candidate);
  if (isErr(candidateRows)) return candidateRows;

  const built = buildDeltaTable(keyColumns, baselineRows.value, candidateRows.value);
  return validate({ table, identity, decision, columns: built.columns, rows: built.rows });
}
