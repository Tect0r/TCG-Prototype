import { useCallback, useEffect, useState } from 'react';

import {
  PAGE_SIZE_MAX,
  adaptiveExperimentIdSchema,
  type AdaptiveExperimentId,
  type AdaptiveResultTable,
  type AdaptiveResultTableName,
  type AdaptiveRunSummary,
  type ResultRow,
} from '@tcg/admin-contracts';

import {
  ADAPTIVE_DASHBOARD_TABLES,
  ADAPTIVE_ROLLING_WINDOW,
  adaptiveTruncationNote,
  cumulativeSeriesTally,
  displayColumns,
  formatAdaptiveCell,
  readAdaptiveRate,
  rollingSeriesTally,
  type SeriesTallyPoint,
} from '../lib/adaptive-view.js';
import { formatRate } from '../lib/dashboard-view.js';
import type { AdminOutcome } from '../net/transport.js';
import { useAdminSession } from '../state/AdminContext.js';
import { Busy, Empty, Failure } from './Feedback.js';
import { FactTable, type Fact } from './FactTable.js';

/**
 * M08.19C — the directory-keyed Adaptive Counter run dashboard.
 *
 * An Adaptive Counter run has no `JobId` yet (`adaptive-results.ts`'s own
 * note on why), so this panel is entered by an operator typing the
 * `experimentId` a run was configured with, rather than by selecting a row
 * from the catalog listing `ResultsScreen.tsx` already offers. Everything
 * downstream — the summary, every table — is read through `AdminSession`'s
 * `adaptiveRunSummary`/`adaptiveResultTable`, exactly as thin a wrapper
 * around the wire as `ResultDashboard.tsx`'s own calls are.
 *
 * Series, revisions and the deck diff are shown as exact tables only — every
 * cell in them is a categorical fact (`decisionKind`, a swap, a revision
 * lineage), and a rate bar over a categorical fact would be inventing a
 * proportion nobody measured. `cumulativeSeriesTally`/`rollingSeriesTally`
 * are the one derived view this screen draws for `series`, and both are pure
 * running counts over the table's own decided blocks — never a fabricated
 * confidence interval. Screening candidates and the reference-field standing
 * *are* the simulator's own measured proportions, so those two get the same
 * `RateBars`-shaped rendering `ResultDashboard.tsx` already uses for one.
 */

type TableOutcome = AdminOutcome<AdaptiveResultTable>;

const TAB_LABELS: Readonly<Record<AdaptiveResultTableName, string>> = {
  series: 'Series',
  revisions: 'Revisions',
  screening_candidates: 'Screening',
  deck_diff: 'Deck diff',
  cycles: 'Cycles',
  reference_field: 'Reference field',
  validation: 'Validation',
};

export function AdaptiveRunPanel() {
  const session = useAdminSession();
  const [input, setInput] = useState('');
  const [experimentId, setExperimentId] = useState<AdaptiveExperimentId | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [summary, setSummary] = useState<AdminOutcome<AdaptiveRunSummary> | null>(null);
  const [view, setView] = useState<AdaptiveResultTableName>('series');
  const [tables, setTables] = useState<Partial<Record<AdaptiveResultTableName, TableOutcome>>>({});

  const open = useCallback(
    (id: AdaptiveExperimentId) => {
      setExperimentId(id);
      setSummary(null);
      setTables({});
      setView('series');
      void session.adaptiveRunSummary(id).then(setSummary);
    },
    [session],
  );

  useEffect(() => {
    if (experimentId === null || summary === null || !summary.ok) return;
    let live = true;
    for (const table of ADAPTIVE_DASHBOARD_TABLES) {
      void session
        .adaptiveResultTable(experimentId, table, { limit: PAGE_SIZE_MAX, cursor: null })
        .then((outcome) => {
          if (live) setTables((held) => ({ ...held, [table]: outcome }));
        });
    }
    return () => {
      live = false;
    };
    // `summary.ok` alone would refetch on every summary re-render; the identity
    // of `experimentId` is what actually decides whether a new run was opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, experimentId, summary?.ok]);

  return (
    <section className="panel" aria-labelledby="adaptive-run">
      <h2 id="adaptive-run">Adaptive Counter run</h2>
      <p className="panel__note">
        A directory-keyed run has no job in the catalog above — enter the experiment ID it was
        configured with. The server resolves its evidence itself; this screen never names or sees a
        filesystem path.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsed = adaptiveExperimentIdSchema.safeParse(input.trim());
          if (!parsed.success) {
            setFormError(parsed.error.issues[0]?.message ?? 'Not a valid experiment ID.');
            return;
          }
          setFormError(null);
          open(parsed.data);
        }}
      >
        <label className="builder__field">
          Experiment ID
          <input
            type="text"
            value={input}
            placeholder="goblin_counter"
            onChange={(event) => {
              setInput(event.target.value);
            }}
          />
        </label>
        <p className="builder__actions">
          <button type="submit">Open</button>
        </p>
        {formError !== null && (
          <p className="dashboard__truncation" role="alert">
            {formError}
          </p>
        )}
      </form>

      {experimentId !== null && summary === null && <Busy label="Reading this run's summary…" />}
      {experimentId !== null && summary !== null && !summary.ok && (
        <Failure
          title="This run's summary could not be shown"
          failure={summary.failure}
          onRetry={() => open(experimentId)}
        />
      )}
      {experimentId !== null && summary !== null && summary.ok && (
        <>
          <SummaryFacts summary={summary.value} />

          <div className="dashboard__tabs" role="group" aria-label="Adaptive dashboard view">
            {ADAPTIVE_DASHBOARD_TABLES.map((table) => (
              <button
                key={table}
                type="button"
                aria-pressed={view === table}
                className={view === table ? 'is-current' : ''}
                onClick={() => {
                  setView(table);
                }}
              >
                {TAB_LABELS[table]}
              </button>
            ))}
          </div>

          <TableView table={view} outcome={tables[view]} />
        </>
      )}
    </section>
  );
}

function SummaryFacts({ summary }: { readonly summary: AdaptiveRunSummary }) {
  const facts: Fact[] = [
    { label: 'Experiment', value: <code>{summary.experimentId}</code> },
    { label: 'Configuration hash', value: <code>{summary.configHash}</code> },
    {
      label: 'Read from',
      value: `${summary.source.document} (schema ${String(summary.source.schemaVersion)})`,
    },
    ...summary.readings.map((reading) => ({ label: reading.label, value: String(reading.value) })),
  ];
  return (
    <>
      <FactTable caption="What this run has produced so far" facts={facts} />
      {summary.limitations.length > 0 && (
        <>
          <h4>Limitations</h4>
          <ul className="results__limitations" role="note">
            {summary.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/* ----------------------------------------------------------------- exact tables */

function ExactTable({ table }: { readonly table: AdaptiveResultTable }) {
  const columns = displayColumns(table);
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">{TAB_LABELS[table.table]} — exact rows</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.key}>{formatAdaptiveCell(table, row, column)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------------ series */

function SeriesTallyTable({
  caption,
  points,
}: {
  readonly caption: string;
  readonly points: readonly SeriesTallyPoint[];
}) {
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Generation</th>
            <th scope="col">Block</th>
            <th scope="col">Decision</th>
            <th scope="col">Incumbent wins</th>
            <th scope="col">Opponent wins</th>
            <th scope="col">Ties</th>
            <th scope="col">No decisions</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point, index) => (
            <tr key={index}>
              <td>{point.generation}</td>
              <td>{point.block}</td>
              <td>{point.decisionKind}</td>
              <td>{point.incumbentWins}</td>
              <td>{point.opponentWins}</td>
              <td>{point.ties}</td>
              <td>{point.noDecisions}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeriesView({ outcome }: { readonly outcome: TableOutcome | undefined }) {
  if (outcome === undefined) return <Busy label="Reading the series table…" />;
  if (!outcome.ok)
    return <Failure title="The series table could not be read" failure={outcome.failure} />;
  if (outcome.value.rows.length === 0) return <Empty>This run has decided no block yet.</Empty>;

  const note = adaptiveTruncationNote(outcome.value, 'decided blocks');
  return (
    <div className="dashboard__view">
      {note !== null && (
        <p className="dashboard__truncation" role="note">
          {note}
        </p>
      )}
      <h4>Cumulative — every decided block so far</h4>
      <SeriesTallyTable
        caption="Cumulative series tally, one row per decided block"
        points={cumulativeSeriesTally(outcome.value.rows)}
      />
      <h4>Rolling — last {ADAPTIVE_ROLLING_WINDOW} decided blocks</h4>
      <SeriesTallyTable
        caption={`Series tally over a trailing window of ${String(ADAPTIVE_ROLLING_WINDOW)} decided blocks`}
        points={rollingSeriesTally(outcome.value.rows)}
      />
      <h4>Exact rows</h4>
      <ExactTable table={outcome.value} />
    </div>
  );
}

/* --------------------------------------------------------------------- screening */

function ScreeningView({ outcome }: { readonly outcome: TableOutcome | undefined }) {
  if (outcome === undefined) return <Busy label="Reading the screening-candidates table…" />;
  if (!outcome.ok) {
    return (
      <Failure title="The screening-candidates table could not be read" failure={outcome.failure} />
    );
  }
  if (outcome.value.rows.length === 0)
    return <Empty>This run has screened no candidate yet.</Empty>;

  const note = adaptiveTruncationNote(outcome.value, 'candidates');
  return (
    <div className="dashboard__view">
      {note !== null && (
        <p className="dashboard__truncation" role="note">
          {note}
        </p>
      )}
      <h4>Promotion score, by candidate</h4>
      <table className="dashboard__bars">
        <caption className="visually-hidden">
          Each screened candidate's promotion score, with interval and sample count
        </caption>
        <tbody>
          {outcome.value.rows.map((row, index) => (
            <tr key={index}>
              <th scope="row">
                Gen {String(row.generation)}, block {String(row.block)} —{' '}
                {String(row.revisionId ?? '')}
              </th>
              <td>{formatRate(readAdaptiveRate(outcome.value, row, 'score'))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>Exact rows</h4>
      <ExactTable table={outcome.value} />
    </div>
  );
}

/* ---------------------------------------------------------------- reference field */

function ReferenceFieldView({ outcome }: { readonly outcome: TableOutcome | undefined }) {
  if (outcome === undefined) return <Busy label="Reading the reference-field table…" />;
  if (!outcome.ok) {
    return (
      <Failure title="The reference-field table could not be read" failure={outcome.failure} />
    );
  }
  if (outcome.value.rows.length === 0) {
    return (
      <Empty>
        This run recorded no reference-field standing — its absence is not evidence of an even
        split.
      </Empty>
    );
  }
  const row = outcome.value.rows[0] as ResultRow;
  return (
    <div className="dashboard__view">
      <h4>Reference-field standing</h4>
      <table className="dashboard__bars">
        <caption className="visually-hidden">
          Reference-field standing, with interval and sample count
        </caption>
        <tbody>
          <tr>
            <th scope="row">Standing</th>
            <td>{formatRate(readAdaptiveRate(outcome.value, row, 'standing'))}</td>
          </tr>
        </tbody>
      </table>
      <h4>Exact row</h4>
      <ExactTable table={outcome.value} />
    </div>
  );
}

/* -------------------------------------------------------------- plain exact tables */

function PlainTableView({
  outcome,
  emptyMessage,
  noun,
}: {
  readonly outcome: TableOutcome | undefined;
  readonly emptyMessage: string;
  readonly noun: string;
}) {
  if (outcome === undefined) return <Busy label="Reading this table…" />;
  if (!outcome.ok)
    return <Failure title="This table could not be read" failure={outcome.failure} />;
  if (outcome.value.rows.length === 0) return <Empty>{emptyMessage}</Empty>;
  const note = adaptiveTruncationNote(outcome.value, noun);
  return (
    <div className="dashboard__view">
      {note !== null && (
        <p className="dashboard__truncation" role="note">
          {note}
        </p>
      )}
      <ExactTable table={outcome.value} />
    </div>
  );
}

/* --------------------------------------------------------------------------- switch */

function TableView({
  table,
  outcome,
}: {
  readonly table: AdaptiveResultTableName;
  readonly outcome: TableOutcome | undefined;
}) {
  switch (table) {
    case 'series':
      return <SeriesView outcome={outcome} />;
    case 'revisions':
      return (
        <PlainTableView
          outcome={outcome}
          emptyMessage="This run has recorded no revision yet."
          noun="revisions"
        />
      );
    case 'screening_candidates':
      return <ScreeningView outcome={outcome} />;
    case 'deck_diff':
      return (
        <PlainTableView
          outcome={outcome}
          emptyMessage="This run has recorded no deck diff yet."
          noun="lineages"
        />
      );
    case 'reference_field':
      return <ReferenceFieldView outcome={outcome} />;
    case 'cycles':
    case 'validation':
      return <Empty>Shown in a later slice.</Empty>;
  }
}
