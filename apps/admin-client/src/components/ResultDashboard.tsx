import { useCallback, useEffect, useState } from 'react';

import {
  PAGE_SIZE_MAX,
  type CatalogJobView,
  type JobId,
  type ResultRow,
  type ResultSummary,
  type ResultTable,
  type ResultTableName,
} from '@tcg/admin-contracts';

import {
  buildMatchupMatrix,
  DASHBOARD_TABLES,
  disambiguateLabels,
  formatPercent,
  formatRate,
  isInsufficient,
  orderedByRate,
  readRate,
  replicateSiblings,
  truncationNote,
  type HeatmapCell,
  type HeatmapMatrix,
  type RateReading,
} from '../lib/dashboard-view.js';
import type { AdminSession } from '../net/session.js';
import type { AdminFailure, AdminOutcome } from '../net/transport.js';
import { useAdminSession } from '../state/AdminContext.js';
import { Busy, Empty, Failure } from './Feedback.js';
import { FactTable, type Fact } from './FactTable.js';

/**
 * M08.11 — the precon result dashboard.
 *
 * Every number drawn here is read back out of `resultTable`, at the moment it
 * is shown, exactly as `resultSummarySchema`'s own doc comment requires: *a
 * reading is transport, not a definition*. This module computes nothing the
 * simulator did not already compute — `lib/dashboard-view.ts` only finds the
 * columns a view needs and orders them; the win rate, its interval and its
 * sample count are the service's own `Proportion`, unmodified.
 *
 * **No automatic verdict.** Nothing here renders "balanced" or "review" text,
 * or a color whose meaning is not also a printed number: every bar and every
 * heatmap cell carries its exact value, so removing color changes nothing a
 * reader can learn from the page. This screen is rendered *below* `SummaryFacts`
 * in `ResultsScreen.tsx`, which already prints the evidence standing and its
 * reasons — the milestone's "calibration standing before any review language"
 * ordering is a fact about that placement, and a second banner repeating the
 * same words here would only be a second author of it.
 *
 * **Drill-down reaches the exact row, not a match or a replay.** A cell or a
 * bar opens the table row it was drawn from — already an exact count, not an
 * aggregate a click could "unpack" further. Individual matches and replays are
 * `matches.jsonl` and `replays/`, which `packages/admin-contracts/src/artifacts.ts`
 * deliberately does not serve: they are a directory listing away, and that
 * listing is M08.26's Match Explorer to build. This screen says so rather than
 * pretending the link exists.
 */

type TableOutcome = AdminOutcome<ResultTable>;

interface ResultDashboardProps {
  readonly jobId: JobId;
  /** The row from the listing, when it is still on screen. Replicates need its `batchId`. */
  readonly job: CatalogJobView | null;
  readonly summary: ResultSummary;
  /** Precon names by Commander, so a deck reads as a precon rather than a bare identifier. */
  readonly preconNameByCommander: Readonly<Record<string, string>>;
}

type ViewId = 'overview' | 'seats' | 'pilots' | 'length' | 'terminations' | 'replicates';

const VIEWS: readonly { readonly id: ViewId; readonly label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'seats', label: 'Seat order' },
  { id: 'pilots', label: 'Pilot' },
  { id: 'length', label: 'Match length' },
  { id: 'terminations', label: 'Termination' },
  { id: 'replicates', label: 'Replicates' },
];

interface DrillTarget {
  readonly title: string;
  readonly facts: readonly Fact[];
}

export function ResultDashboard({
  jobId,
  job,
  summary,
  preconNameByCommander,
}: ResultDashboardProps) {
  const session = useAdminSession();
  const [view, setView] = useState<ViewId>('overview');
  const [tables, setTables] = useState<Partial<Record<ResultTableName, TableOutcome>>>({});
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [replicates, setReplicates] = useState<AdminOutcome<ReplicateData> | null>(null);

  useEffect(() => {
    let live = true;
    setTables({});
    setDrill(null);
    for (const table of DASHBOARD_TABLES) {
      // The largest single page the contract allows (`PAGE_SIZE_MAX`), never
      // the default: `resultTable`'s own page carries `nextCursor`, and every
      // view below checks it rather than assuming one page is the whole
      // table — the "insufficient data" and "never played" text this screen
      // prints must never be a truncation boundary in disguise.
      void session
        .resultTable(jobId, table, { limit: PAGE_SIZE_MAX, cursor: null })
        .then((outcome) => {
          if (live) setTables((held) => ({ ...held, [table]: outcome }));
        });
    }
    return () => {
      live = false;
    };
  }, [session, jobId]);

  useEffect(() => {
    if (view !== 'replicates' || job === null) return;
    let live = true;
    setReplicates(null);
    void loadReplicates(session, job).then((outcome) => {
      if (live) setReplicates(outcome);
    });
    return () => {
      live = false;
    };
  }, [session, job, view]);

  const labelForCommander = useCallback(
    (commanderId: string) => preconNameByCommander[commanderId] ?? commanderId,
    [preconNameByCommander],
  );

  return (
    <section className="panel" aria-labelledby="results-dashboard">
      <h3 id="results-dashboard">Precon result dashboard</h3>

      <div className="dashboard__tabs" role="group" aria-label="Dashboard view">
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={view === entry.id}
            className={view === entry.id ? 'is-current' : ''}
            onClick={() => {
              setView(entry.id);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {view === 'overview' && (
        <OverviewView tables={tables} labelForCommander={labelForCommander} onDrill={setDrill} />
      )}
      {view === 'seats' && (
        <SimpleRateView
          table={tables.seats}
          keyOf={(row) => String(row.seatIndex ?? '')}
          labelOf={(row) => `Seat ${String(row.seatIndex ?? '')}`}
          rateKey="rate"
          ariaLabel="Win rate by seat, with interval and sample count"
          busyLabel="Reading the seat table…"
          rowNoun="seats"
          onDrill={setDrill}
        />
      )}
      {view === 'pilots' && (
        <SimpleRateView
          table={tables.pilots}
          keyOf={(row) => String(row.pilotId ?? '')}
          labelOf={(row) => String(row.pilotId ?? '')}
          rateKey="rate"
          ariaLabel="Win rate by pilot, with interval and sample count"
          busyLabel="Reading the pilot table…"
          rowNoun="pilots"
          onDrill={setDrill}
        />
      )}
      {view === 'length' && <LengthView summary={summary} />}
      {view === 'terminations' && <TerminationsView table={tables.terminations} />}
      {view === 'replicates' && <ReplicatesView job={job} replicates={replicates} />}

      {drill !== null && (
        <div className="dashboard__drill" role="region" aria-label={drill.title}>
          <div className="dashboard__drill-head">
            <h4>{drill.title}</h4>
            <button
              type="button"
              onClick={() => {
                setDrill(null);
              }}
            >
              Close
            </button>
          </div>
          <FactTable caption={drill.title} facts={drill.facts} />
          <p className="panel__note">
            This is the exact row a bar or cell summarizes — not a further aggregate. Opening one
            contributing match or its replay is not available from this screen: that needs a listing
            over the run's match records, which is M08.26&apos;s Match Explorer to build.
          </p>
        </div>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------------- overview */

interface OverviewViewProps {
  readonly tables: Partial<Record<ResultTableName, TableOutcome>>;
  readonly labelForCommander: (commanderId: string) => string;
  readonly onDrill: (target: DrillTarget) => void;
}

function OverviewView({ tables, labelForCommander, onDrill }: OverviewViewProps) {
  const decks = tables.decks;
  const matchups = tables.matchups;

  return (
    <div className="dashboard__view">
      <h4>Win rate by precon</h4>
      {decks === undefined && <Busy label="Reading the deck table…" />}
      {decks !== undefined && !decks.ok && (
        <Failure title="The deck table could not be read" failure={decks.failure} />
      )}
      {decks !== undefined && decks.ok && decks.value.rows.length === 0 && (
        <Empty>This run recorded no deck.</Empty>
      )}
      {decks !== undefined && decks.ok && decks.value.rows.length > 0 && (
        <>
          {truncationNote(decks.value, 'decks') !== null && (
            <p className="dashboard__truncation" role="note">
              {truncationNote(decks.value, 'decks')}
            </p>
          )}
          <RateBars
            ariaLabel="Win rate by precon, with interval and sample count"
            items={disambiguateLabels(
              orderedByRate(
                decks.value.rows.map((row) => ({
                  key: String(row.deckHash ?? ''),
                  label: labelForCommander(String(row.commanderId ?? '')),
                  rate: readRate(decks.value, row, 'winRate'),
                })),
              ),
            )}
            onSelect={(item) => {
              const row = decks.value.rows.find(
                (entry) => String(entry.deckHash ?? '') === item.key,
              );
              if (row !== undefined) {
                onDrill(rowDrillTarget(decks.value, row, `${item.label} — deck row`));
              }
            }}
          />
        </>
      )}

      <h4>Matchup heatmap</h4>
      {matchups === undefined && <Busy label="Reading the matchup table…" />}
      {matchups !== undefined && !matchups.ok && (
        <Failure title="The matchup table could not be read" failure={matchups.failure} />
      )}
      {decks !== undefined && decks.ok && matchups !== undefined && matchups.ok && (
        <>
          {(truncationNote(decks.value, 'decks') !== null ||
            truncationNote(matchups.value, 'matchup pairs') !== null) && (
            <p className="dashboard__truncation" role="note">
              {truncationNote(decks.value, 'decks') ??
                truncationNote(matchups.value, 'matchup pairs')}
              {
                ' A cell with no pair among the rows read is marked accordingly rather than as "no games".'
              }
            </p>
          )}
          <MatchupHeatmap
            matrix={buildMatchupMatrix(decks.value, matchups.value, labelForCommander)}
            onSelect={(cell) => {
              const title = 'Matchup — exact row';
              if (!cell.found) {
                onDrill({
                  title,
                  facts: [
                    {
                      label: 'Status',
                      value:
                        matchups.value.page.nextCursor !== null
                          ? 'This pair is not among the matchup rows this screen read; the table has more rows than were fetched.'
                          : 'No completed games between these two decks.',
                    },
                  ],
                });
                return;
              }
              const row = matchups.value.rows.find(
                (entry) =>
                  String(entry.deckHash ?? '') === cell.rowKey &&
                  String(entry.opponentHash ?? '') === cell.columnKey,
              );
              onDrill(
                row === undefined
                  ? { title, facts: [{ label: 'Games', value: 'Not measured.' }] }
                  : rowDrillTarget(matchups.value, row, title),
              );
            }}
          />
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------- bars */

interface RateBarItemView {
  readonly key: string;
  readonly label: string;
  readonly rate: RateReading | null;
}

function RateBars({
  ariaLabel,
  items,
  onSelect,
}: {
  readonly ariaLabel: string;
  readonly items: readonly RateBarItemView[];
  readonly onSelect: (item: RateBarItemView) => void;
}) {
  return (
    <table className="dashboard__bars">
      <caption className="visually-hidden">{ariaLabel}</caption>
      <tbody>
        {items.map((item) => (
          <tr key={item.key}>
            <th scope="row">{item.label}</th>
            <td>
              {isInsufficient(item.rate) ? (
                <span className="dashboard__insufficient">
                  Insufficient data — no games recorded
                </span>
              ) : (
                <>
                  <span className="dashboard__bar-track" aria-hidden="true">
                    <span
                      className="dashboard__bar-interval"
                      style={{
                        left: `${String((item.rate?.low ?? 0) * 100)}%`,
                        width: `${String(((item.rate?.high ?? 0) - (item.rate?.low ?? 0)) * 100)}%`,
                      }}
                    />
                    <span
                      className="dashboard__bar-fill"
                      style={{ width: `${String((item.rate?.point ?? 0) * 100)}%` }}
                    />
                  </span>
                  <span className="dashboard__bar-value">{formatRate(item.rate)}</span>
                </>
              )}
            </td>
            <td>
              <button
                type="button"
                onClick={() => {
                  onSelect(item);
                }}
              >
                Exact row
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------------ heatmap */

function MatchupHeatmap({
  matrix,
  onSelect,
}: {
  readonly matrix: HeatmapMatrix;
  readonly onSelect: (cell: HeatmapCell) => void;
}) {
  if (matrix.rows.length === 0) {
    return <Empty>No deck recorded enough games to place in a matchup matrix.</Empty>;
  }
  const cellText = (cell: HeatmapCell): string => {
    if (cell.found) return formatRate(cell.rate);
    return matrix.matchupsTruncated
      ? 'Not confirmed — this pair is not among the matchup rows read'
      : 'Insufficient data — no games recorded';
  };
  return (
    <div className="dashboard__heatmap-wrap">
      <table
        className="dashboard__heatmap"
        aria-label="Matchup win rate: the row deck's exact win rate against the column deck"
      >
        <caption className="visually-hidden">
          Ordered matchup matrix. Every cell states the row deck&apos;s exact win rate against the
          column deck, or that the pair never played, or — when this table was too large for one
          page — that the pair is not confirmed either way. Color shading is never the only way a
          value is shown.
        </caption>
        <thead>
          <tr>
            <th scope="col"> </th>
            {matrix.columns.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              {matrix.columns.map((column) => {
                const cell = matrix.cellAt(row.key, column.key);
                const empty = !cell.found || isInsufficient(cell.rate);
                const style = empty
                  ? undefined
                  : { backgroundColor: `rgba(91, 141, 214, ${String(cell.rate?.point ?? 0)})` };
                return (
                  <td
                    key={column.key}
                    className={
                      empty ? 'dashboard__heatmap-cell is-empty' : 'dashboard__heatmap-cell'
                    }
                    style={style}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(cell);
                      }}
                      aria-label={`${row.label} against ${column.label}: ${cellText(cell)}`}
                    >
                      {empty ? '—' : formatPercent(cell.rate?.point ?? 0)}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------------ seat/pilot */

interface SimpleRateViewProps {
  readonly table: TableOutcome | undefined;
  readonly keyOf: (row: ResultRow) => string;
  readonly labelOf: (row: ResultRow) => string;
  readonly rateKey: string;
  readonly ariaLabel: string;
  readonly busyLabel: string;
  readonly rowNoun: string;
  readonly onDrill: (target: DrillTarget) => void;
}

function SimpleRateView({
  table,
  keyOf,
  labelOf,
  rateKey,
  ariaLabel,
  busyLabel,
  rowNoun,
  onDrill,
}: SimpleRateViewProps) {
  if (table === undefined) return <Busy label={busyLabel} />;
  if (!table.ok) return <Failure title="This table could not be read" failure={table.failure} />;
  if (table.value.rows.length === 0) return <Empty>This run recorded no rows for this view.</Empty>;

  const items = disambiguateLabels(
    orderedByRate(
      table.value.rows.map((row) => ({
        key: keyOf(row),
        label: labelOf(row),
        rate: readRate(table.value, row, rateKey),
      })),
    ),
  );
  const note = truncationNote(table.value, rowNoun);

  return (
    <>
      {note !== null && (
        <p className="dashboard__truncation" role="note">
          {note}
        </p>
      )}
      <RateBars
        ariaLabel={ariaLabel}
        items={items}
        onSelect={(item) => {
          const row = table.value.rows.find((entry) => keyOf(entry) === item.key);
          if (row !== undefined)
            onDrill(rowDrillTarget(table.value, row, `${item.label} — exact row`));
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------------- length */

function LengthView({ summary }: { readonly summary: ResultSummary }) {
  const wanted = ['turnsMean', 'turnsMedian', 'turnsP10', 'turnsP90', 'turnsMax'];
  const byKey = new Map(summary.readings.map((reading) => [reading.key, reading]));
  const facts: Fact[] = wanted
    .map((key) => byKey.get(key))
    .filter((reading): reading is NonNullable<typeof reading> => reading !== undefined)
    .map((reading) => ({ label: reading.label, value: String(reading.value) }));

  if (facts.length === 0) {
    return <Empty>This run&apos;s summary carries no match-length readings.</Empty>;
  }
  return <FactTable caption="Match length" facts={facts} />;
}

/* -------------------------------------------------------------------- terminations */

function TerminationsView({ table }: { readonly table: TableOutcome | undefined }) {
  if (table === undefined) return <Busy label="Reading the termination table…" />;
  if (!table.ok) {
    return <Failure title="The termination table could not be read" failure={table.failure} />;
  }
  if (table.value.rows.length === 0) return <Empty>This run recorded no terminations.</Empty>;
  const note = truncationNote(table.value, 'termination kinds');
  return (
    <>
      {note !== null && (
        <p className="dashboard__truncation" role="note">
          {note}
        </p>
      )}
      <table className="dashboard__bars">
        <caption className="visually-hidden">Games by termination kind</caption>
        <thead>
          <tr>
            <th scope="col">Termination</th>
            <th scope="col">Games</th>
            <th scope="col">Excluded from statistics</th>
          </tr>
        </thead>
        <tbody>
          {table.value.rows.map((row) => (
            <tr key={String(row.kind)}>
              <th scope="row">{String(row.kind)}</th>
              <td>{String(row.matches)}</td>
              <td>{row.abnormal === true ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

/* -------------------------------------------------------------------- replicates */

interface ReplicateColumn {
  readonly jobId: string;
  readonly label: string;
}

interface ReplicateRow {
  readonly commanderId: string;
  readonly label: string;
  readonly rateByJob: Readonly<Record<string, RateReading | null>>;
}

interface ReplicateData {
  readonly columns: readonly ReplicateColumn[];
  readonly rows: readonly ReplicateRow[];
}

async function loadReplicates(
  session: AdminSession,
  job: CatalogJobView,
): Promise<AdminOutcome<ReplicateData>> {
  const batch = await session.batchDetail(job.batchId);
  if (!batch.ok) return batch;

  const siblings = replicateSiblings(batch.value.jobs, job);
  if (siblings.length === 0) return { ok: true, value: { columns: [], rows: [] } };

  const perJob = await Promise.all(
    siblings.map(async (sibling) => ({
      sibling,
      table: await session.resultTable(sibling.jobId, 'decks', {
        limit: PAGE_SIZE_MAX,
        cursor: null,
      }),
    })),
  );
  const failedEntry = perJob.find(
    (entry): entry is typeof entry & { table: { ok: false; failure: AdminFailure } } =>
      !entry.table.ok,
  );
  if (failedEntry) return { ok: false, failure: failedEntry.table.failure };

  const columns: ReplicateColumn[] = perJob.map((entry) => ({
    jobId: entry.sibling.jobId,
    label:
      entry.sibling.origin.kind === 'preset' ? entry.sibling.origin.stageId : entry.sibling.label,
  }));

  const rowsByCommander = new Map<string, ReplicateRow>();
  for (const entry of perJob) {
    if (!entry.table.ok) continue;
    for (const row of entry.table.value.rows) {
      const commanderId = String(row.commanderId ?? '');
      const existing = rowsByCommander.get(commanderId) ?? {
        commanderId,
        label: commanderId,
        rateByJob: {},
      };
      rowsByCommander.set(commanderId, {
        ...existing,
        rateByJob: {
          ...existing.rateByJob,
          [entry.sibling.jobId]: readRate(entry.table.value, row, 'winRate'),
        },
      });
    }
  }

  return { ok: true, value: { columns, rows: [...rowsByCommander.values()] } };
}

function ReplicatesView({
  job,
  replicates,
}: {
  readonly job: CatalogJobView | null;
  readonly replicates: AdminOutcome<ReplicateData> | null;
}) {
  if (job === null) {
    return (
      <Empty>
        This job is not in the current listing, so its batch cannot be reopened to find its
        replicate siblings.
      </Empty>
    );
  }
  if (replicates === null) return <Busy label="Reading this run's replicate siblings…" />;
  if (!replicates.ok) {
    return <Failure title="Replicate siblings could not be read" failure={replicates.failure} />;
  }
  if (replicates.value.columns.length <= 1) {
    return (
      <Empty>
        This run has no replicate siblings in its batch — it was not part of a multi-replicate
        benchmark.
      </Empty>
    );
  }

  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__heatmap" aria-label="Win rate per precon, by replicate">
        <caption className="visually-hidden">
          Win rate per precon, one column per independent replicate run. Replicates are separate
          runs on independent seed families and are never pooled into one number.
        </caption>
        <thead>
          <tr>
            <th scope="col">Precon</th>
            {replicates.value.columns.map((column) => (
              <th key={column.jobId} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {replicates.value.rows.map((row) => (
            <tr key={row.commanderId}>
              <th scope="row">{row.label}</th>
              {replicates.value.columns.map((column) => (
                <td key={column.jobId}>{formatRate(row.rateByJob[column.jobId] ?? null)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------------- shared */

/** Every column of a row, as exact facts — the drill-down's whole content. */
function rowDrillTarget(table: ResultTable, row: ResultRow, title: string): DrillTarget {
  const consumed = new Set<string>();
  for (const column of table.columns) {
    if (column.kind === 'interval' && column.bounds !== null) {
      consumed.add(column.bounds.low);
      consumed.add(column.bounds.high);
      consumed.add(`${column.key}Games`);
    }
  }
  const facts: Fact[] = table.columns
    .filter((column) => !consumed.has(column.key))
    .map((column) => {
      if (column.kind === 'interval') {
        return { label: column.label, value: formatRate(readRate(table, row, column.key)) };
      }
      const value = row[column.key];
      return { label: column.label, value: value === null ? 'Not measured' : String(value) };
    });
  return { title, facts };
}
