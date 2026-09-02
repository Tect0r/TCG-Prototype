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
  adaptiveRowDrillTarget,
  adaptiveTruncationNote,
  cumulativeSeriesTally,
  displayColumns,
  formatAdaptiveCell,
  readAdaptiveRate,
  rollingSeriesTally,
  type AdaptiveDrillTarget,
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
 *
 * M08.19D adds three things this screen was still missing:
 *
 * - `SummaryFacts` leads with `summary.informationPolicy`, worded exactly as
 *   unmistakably as `apps/simulator/src/adaptive/report.ts`'s own
 *   `informationPolicyLabel` states it in the Markdown report, so a reader
 *   here and a reader of that file's rendered report never see two different
 *   claims about the same run.
 * - `cycles` and `validation` — shown as `Empty` placeholders through
 *   M08.19C — now render: `cycles` as the plain descriptive table CLAUDE.md's
 *   "evidence for review, never a verdict" rule requires (no "healthy",
 *   "stuck" or "converged" language anywhere near it), and `validation` as
 *   its own controlled-comparison table, kept visually and structurally apart
 *   from `seriesTally`'s screening evidence exactly as `promote.ts` and
 *   `report.ts` keep them apart in the data itself.
 * - Every exact table gets a drill-down, reusing `adaptiveRowDrillTarget` the
 *   way `ResultDashboard.tsx` reuses its own `rowDrillTarget`: a row's button
 *   opens the exact facts it was drawn from, with the same fixed disclaimer
 *   that an individual match or replay is not browsable from this screen yet
 *   (M08.26's Match Explorer).
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
  const [drill, setDrill] = useState<AdaptiveDrillTarget | null>(null);

  const open = useCallback(
    (id: AdaptiveExperimentId) => {
      setExperimentId(id);
      setSummary(null);
      setTables({});
      setView('series');
      setDrill(null);
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
                  setDrill(null);
                }}
              >
                {TAB_LABELS[table]}
              </button>
            ))}
          </div>

          <TableView table={view} outcome={tables[view]} onDrill={setDrill} />

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
                contributing match or its replay is not available from this screen: that needs a
                listing over the run's match records, which is M08.26&apos;s Match Explorer to build.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The one-line, unmistakable label this screen leads with (M08.19D), worded
 * identically to `apps/simulator/src/adaptive/report.ts`'s own
 * `informationPolicyLabel` so the Markdown report and this dashboard never
 * disagree about which policy produced a run's evidence.
 */
function informationPolicyBanner(policy: AdaptiveRunSummary['informationPolicy']): string {
  return policy === 'analysis_full_deck'
    ? "Full-information analysis. Every pilot in this run saw its opponent's exact decklist. This " +
        "is not evidence of how these decks would play under a normal match's hidden information."
    : "Public observation. Every pilot in this run saw only what a normal match's observation " +
        'boundary allows.';
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
      <p className="dashboard__policy" role="note">
        {informationPolicyBanner(summary.informationPolicy)}
      </p>
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

/**
 * The title a row's drill-down opens under (M08.19D) — names the revision or
 * segment the row is, per table shape, the same way each `ResultDashboard.tsx`
 * call site names its own `rowDrillTarget` title.
 */
function exactRowTitle(table: AdaptiveResultTable, row: ResultRow): string {
  switch (table.table) {
    case 'series':
      return `Block ${String(row.block)} (gen ${String(row.generation)}) — exact row`;
    case 'revisions':
      return `${String(row.side)} revision ${String(row.revisionId)} — exact row`;
    case 'screening_candidates':
      return `Gen ${String(row.generation)}, block ${String(row.block)} — ${String(row.revisionId)} — exact row`;
    case 'deck_diff':
      return `${String(row.side)} lineage — exact row`;
    case 'cycles':
      return `Block ${String(row.block)} repeats block ${String(row.repeatsBlock)} — exact row`;
    case 'reference_field':
      return 'Reference-field standing — exact row';
    case 'validation':
      return 'Frozen validation — exact row';
  }
}

function ExactTable({
  table,
  onDrill,
}: {
  readonly table: AdaptiveResultTable;
  readonly onDrill: (target: AdaptiveDrillTarget) => void;
}) {
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
            <th scope="col"> </th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.key}>{formatAdaptiveCell(table, row, column)}</td>
              ))}
              <td>
                <button
                  type="button"
                  onClick={() => {
                    onDrill(adaptiveRowDrillTarget(table, row, exactRowTitle(table, row)));
                  }}
                >
                  Exact row
                </button>
              </td>
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

function SeriesView({
  outcome,
  onDrill,
}: {
  readonly outcome: TableOutcome | undefined;
  readonly onDrill: (target: AdaptiveDrillTarget) => void;
}) {
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
      <ExactTable table={outcome.value} onDrill={onDrill} />
    </div>
  );
}

/* --------------------------------------------------------------------- screening */

function ScreeningView({
  outcome,
  onDrill,
}: {
  readonly outcome: TableOutcome | undefined;
  readonly onDrill: (target: AdaptiveDrillTarget) => void;
}) {
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
      <ExactTable table={outcome.value} onDrill={onDrill} />
    </div>
  );
}

/* ---------------------------------------------------------------- reference field */

function ReferenceFieldView({
  outcome,
  onDrill,
}: {
  readonly outcome: TableOutcome | undefined;
  readonly onDrill: (target: AdaptiveDrillTarget) => void;
}) {
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
      <ExactTable table={outcome.value} onDrill={onDrill} />
    </div>
  );
}

/* --------------------------------------------------------------------------- cycles */

function CyclesView({
  outcome,
  onDrill,
}: {
  readonly outcome: TableOutcome | undefined;
  readonly onDrill: (target: AdaptiveDrillTarget) => void;
}) {
  if (outcome === undefined) return <Busy label="Reading the cycles table…" />;
  if (!outcome.ok)
    return <Failure title="The cycles table could not be read" failure={outcome.failure} />;
  if (outcome.value.rows.length === 0) {
    return (
      <Empty>
        This run has recorded no repeated deck-hash pair. Its absence is descriptive only, never a
        verdict that the meta is healthy, stuck or converged.
      </Empty>
    );
  }
  const note = adaptiveTruncationNote(outcome.value, 'repeated states');
  return (
    <div className="dashboard__view">
      <p className="panel__note">
        A repeated deck-hash pair is descriptive observation only — evidence for review, never an
        automatic verdict that the meta is healthy, stuck or converged.
      </p>
      {note !== null && (
        <p className="dashboard__truncation" role="note">
          {note}
        </p>
      )}
      <ExactTable table={outcome.value} onDrill={onDrill} />
    </div>
  );
}

/* ----------------------------------------------------------------------- validation */

function ValidationView({
  outcome,
  onDrill,
}: {
  readonly outcome: TableOutcome | undefined;
  readonly onDrill: (target: AdaptiveDrillTarget) => void;
}) {
  if (outcome === undefined) return <Busy label="Reading the validation table…" />;
  if (!outcome.ok)
    return <Failure title="The validation table could not be read" failure={outcome.failure} />;
  if (outcome.value.rows.length === 0) {
    return (
      <Empty>
        The frozen validation stage has not been run for this experiment yet. This is separate from
        the series score above: screening evidence is never folded into a validation standing.
      </Empty>
    );
  }
  const row = outcome.value.rows[0] as ResultRow;
  return (
    <div className="dashboard__view">
      <p className="panel__note">
        A controlled comparison between the two frozen final decks, on fresh seeds never used during
        screening — kept apart from <code>seriesTally</code> above rather than folded into it.
      </p>
      <h4>Frozen validation standing</h4>
      <table className="dashboard__bars">
        <caption className="visually-hidden">
          Frozen validation standing, with interval and sample count
        </caption>
        <tbody>
          <tr>
            <th scope="row">Standing</th>
            <td>{formatRate(readAdaptiveRate(outcome.value, row, 'standing'))}</td>
          </tr>
        </tbody>
      </table>
      <h4>Exact row</h4>
      <ExactTable table={outcome.value} onDrill={onDrill} />
    </div>
  );
}

/* -------------------------------------------------------------- plain exact tables */

function PlainTableView({
  outcome,
  emptyMessage,
  noun,
  onDrill,
}: {
  readonly outcome: TableOutcome | undefined;
  readonly emptyMessage: string;
  readonly noun: string;
  readonly onDrill: (target: AdaptiveDrillTarget) => void;
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
      <ExactTable table={outcome.value} onDrill={onDrill} />
    </div>
  );
}

/* --------------------------------------------------------------------------- switch */

function TableView({
  table,
  outcome,
  onDrill,
}: {
  readonly table: AdaptiveResultTableName;
  readonly outcome: TableOutcome | undefined;
  readonly onDrill: (target: AdaptiveDrillTarget) => void;
}) {
  switch (table) {
    case 'series':
      return <SeriesView outcome={outcome} onDrill={onDrill} />;
    case 'revisions':
      return (
        <PlainTableView
          outcome={outcome}
          emptyMessage="This run has recorded no revision yet."
          noun="revisions"
          onDrill={onDrill}
        />
      );
    case 'screening_candidates':
      return <ScreeningView outcome={outcome} onDrill={onDrill} />;
    case 'deck_diff':
      return (
        <PlainTableView
          outcome={outcome}
          emptyMessage="This run has recorded no deck diff yet."
          noun="lineages"
          onDrill={onDrill}
        />
      );
    case 'cycles':
      return <CyclesView outcome={outcome} onDrill={onDrill} />;
    case 'reference_field':
      return <ReferenceFieldView outcome={outcome} onDrill={onDrill} />;
    case 'validation':
      return <ValidationView outcome={outcome} onDrill={onDrill} />;
  }
}
