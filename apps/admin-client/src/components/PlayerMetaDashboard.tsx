import { useEffect, useState } from 'react';

import {
  NO_PLAYER_META_FILTER,
  PAGE_SIZE_MAX,
  type PlayerMetaResultTable,
  type PlayerMetaResultTableName,
  type PlayerMetaRunSummary,
  type ResultRow,
} from '@tcg/admin-contracts';

import {
  PLAYER_META_DASHBOARD_TABLES,
  displayColumns,
  formatPlayerMetaCell,
  hasPlayerMetaWeighting,
  playerMetaRowDrillTarget,
  playerMetaTruncationNote,
  sortPlayerMetaRowsByWeight,
  type PlayerMetaDrillTarget,
  type PlayerMetaWeighting,
} from '../lib/player-meta-view.js';
import type { AdminOutcome } from '../net/transport.js';
import { useAdminSession } from '../state/AdminContext.js';
import { Busy, Empty, Failure } from './Feedback.js';
import { FactTable, type Fact } from './FactTable.js';

/**
 * M08.25C — the directory-keyed Player Meta dashboard.
 *
 * Unlike `AdaptiveRunPanel`, this panel has no form to open with: a Player
 * Meta read has neither a `JobId` nor an `experimentId`, so there is nothing
 * for an operator to type before the summary can be fetched
 * (`player-meta-view.ts`'s own note on why). It fetches on mount with
 * `NO_PLAYER_META_FILTER` — M08.25A/B already built the filter surface and
 * read model; wiring a filter form into this screen is a later slice, per
 * this slice's own "exact tables, source labels and weighting controls only"
 * scope.
 *
 * Every table renders as a plain exact table — `commanders` and `clusters`
 * additionally get a match/unique-deck weighting control
 * (`hasPlayerMetaWeighting`), the only two tables where that toggle is
 * meaningful (`player-meta-view.ts`'s own note on why `cards`/`pairs` do
 * not need one).
 *
 * M08.25E adds the four states this read model can be in that M08.25B/C/D
 * had not yet designed for, plus the drill-down every sibling dashboard
 * already offers:
 *
 * - Empty and unauthorized were already generic (`Empty`/`Failure` render
 *   for any `AdminOutcome`) — this slice only adds test coverage for them,
 *   never new branching.
 * - Sparse is likewise already handled at the cell level: a zero-observation
 *   interval already reads as "Insufficient data — no games recorded"
 *   (`formatRate`/`isInsufficient` in `dashboard-view.ts`) rather than a
 *   fabricated proportion; this slice adds test coverage only.
 * - Corrupt is new: `summary.source.recordsSkipped` was already computed by
 *   `player-meta-results.ts`'s tolerant reader and shown as a bare count in
 *   `SummaryFacts`, but nothing named what a skipped record means. A skipped
 *   count above zero now gets its own descriptive note — evidence for
 *   review, never a verdict that the surviving rows are unaffected.
 * - Drill-down reuses `playerMetaRowDrillTarget` the way `AdaptiveDashboard.tsx`
 *   reuses `adaptiveRowDrillTarget`: a row's "Exact row" button opens the
 *   exact facts it was drawn from, with the same fixed disclaimer that an
 *   individual match or replay is not browsable from this screen yet
 *   (M08.26's Match Explorer).
 */

type TableOutcome = AdminOutcome<PlayerMetaResultTable>;

const TAB_LABELS: Readonly<Record<PlayerMetaResultTableName, string>> = {
  commanders: 'Commanders',
  decks: 'Decks',
  deck_matchups: 'Deck matchups',
  clusters: 'Clusters',
  cluster_matchups: 'Cluster matchups',
  cards: 'Cards',
  pairs: 'Pairs',
  duration: 'Duration',
  terminations: 'Terminations',
  surrender_turns: 'Surrender turns',
  surrender_phases: 'Surrender phases',
  surrender_state: 'Surrender state',
  surrender_exposure_cards: 'Surrender exposure — cards',
  surrender_exposure_events: 'Surrender exposure — events',
};

/** M08.25D's five surrender tables — the only tabs that need the exposure/proximity caption below. */
const SURRENDER_TABLES: ReadonlySet<PlayerMetaResultTableName> = new Set([
  'surrender_turns',
  'surrender_phases',
  'surrender_state',
  'surrender_exposure_cards',
  'surrender_exposure_events',
]);

export function PlayerMetaPanel() {
  const session = useAdminSession();
  const [summary, setSummary] = useState<AdminOutcome<PlayerMetaRunSummary> | null>(null);
  const [view, setView] = useState<PlayerMetaResultTableName>('commanders');
  const [tables, setTables] = useState<Partial<Record<PlayerMetaResultTableName, TableOutcome>>>(
    {},
  );
  const [weighting, setWeighting] = useState<PlayerMetaWeighting>('matches');
  const [drill, setDrill] = useState<PlayerMetaDrillTarget | null>(null);

  useEffect(() => {
    void session.playerMetaRunSummary(NO_PLAYER_META_FILTER).then(setSummary);
  }, [session]);

  useEffect(() => {
    if (summary === null || !summary.ok) return;
    let live = true;
    for (const table of PLAYER_META_DASHBOARD_TABLES) {
      void session
        .playerMetaResultTable(table, NO_PLAYER_META_FILTER, { limit: PAGE_SIZE_MAX, cursor: null })
        .then((outcome) => {
          if (live) setTables((held) => ({ ...held, [table]: outcome }));
        });
    }
    return () => {
      live = false;
    };
    // `summary.ok` alone is what decides whether a fresh fetch is needed; `session`
    // is stable for the life of this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, summary?.ok]);

  return (
    <section className="panel" aria-labelledby="player-meta-run">
      <h2 id="player-meta-run">Player Meta</h2>
      <p className="panel__note">
        A live-match read has no job in the catalog above and no run identifier to enter — the
        server reads its one configured default result root directly. This view shows every match
        unfiltered; a filter form over the M08.25A surface is a later slice.
      </p>

      {summary === null && <Busy label="Reading the Player Meta summary…" />}
      {summary !== null && !summary.ok && (
        <Failure
          title="The Player Meta summary could not be shown"
          failure={summary.failure}
          onRetry={() => {
            setSummary(null);
            void session.playerMetaRunSummary(NO_PLAYER_META_FILTER).then(setSummary);
          }}
        />
      )}
      {summary !== null && summary.ok && (
        <>
          <SummaryFacts summary={summary.value} />

          <div className="dashboard__tabs" role="group" aria-label="Player Meta dashboard view">
            {PLAYER_META_DASHBOARD_TABLES.map((table) => (
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

          {hasPlayerMetaWeighting(view) && (
            <div className="dashboard__tabs" role="group" aria-label="Weighting">
              <button
                type="button"
                aria-pressed={weighting === 'matches'}
                className={weighting === 'matches' ? 'is-current' : ''}
                onClick={() => {
                  setWeighting('matches');
                  setDrill(null);
                }}
              >
                By matches
              </button>
              <button
                type="button"
                aria-pressed={weighting === 'unique'}
                className={weighting === 'unique' ? 'is-current' : ''}
                onClick={() => {
                  setWeighting('unique');
                  setDrill(null);
                }}
              >
                By unique decks
              </button>
            </div>
          )}

          <TableView table={view} outcome={tables[view]} weighting={weighting} onDrill={setDrill} />

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
                This is the exact row a bar or cell summarizes — not a further aggregate. Opening
                one contributing match or its replay is not available from this screen: that needs a
                listing over the run's match records, which is M08.26&apos;s Match Explorer to
                build.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SummaryFacts({ summary }: { readonly summary: PlayerMetaRunSummary }) {
  const facts: Fact[] = [
    { label: 'Matches read', value: String(summary.source.recordsRead) },
    { label: 'Matches skipped', value: String(summary.source.recordsSkipped) },
    { label: 'Partitions', value: String(summary.partitions.length) },
  ];
  return (
    <>
      {summary.source.recordsSkipped > 0 && (
        <p className="dashboard__truncation" role="note">
          {summary.source.recordsSkipped} match record
          {summary.source.recordsSkipped === 1 ? '' : 's'} could not be read and were skipped rather
          than aborting this read — the {summary.source.recordsRead} record
          {summary.source.recordsRead === 1 ? '' : 's'} below are what survived, never a complete
          population. This is evidence for review, not a verdict about the tables below.
        </p>
      )}
      <FactTable caption="What this read has found so far" facts={facts} />
      {summary.partitions.length > 0 && (
        <table className="dashboard__bars">
          <caption className="visually-hidden">Every partition this query found</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Content version</th>
              <th scope="col">Rules version</th>
              <th scope="col">Matches</th>
              <th scope="col">Unique decks</th>
              <th scope="col">Decisive</th>
            </tr>
          </thead>
          <tbody>
            {summary.partitions.map((entry, index) => (
              <tr key={index}>
                <td>{entry.partition.source}</td>
                <td>{entry.partition.contentVersion}</td>
                <td>{entry.partition.rulesVersion}</td>
                <td>{entry.matches}</td>
                <td>{entry.uniqueDecks}</td>
                <td>{entry.decisiveMatches}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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

/**
 * The title a row's drill-down opens under — names the row's own identifying
 * column(s) per table shape, mirroring `AdaptiveDashboard.tsx`'s own
 * `exactRowTitle`. `duration` and `surrender_state` carry one row per
 * partition rather than a per-entity identifier, so those two name the
 * partition's source label instead.
 */
function exactRowTitle(table: PlayerMetaResultTableName, row: ResultRow): string {
  switch (table) {
    case 'commanders':
      return `${String(row.commanderId)} — Commander row`;
    case 'decks':
      return `${String(row.deckHash)} — deck row`;
    case 'deck_matchups':
      return `${String(row.deckHash)} vs ${String(row.opponentDeckHash)} — matchup row`;
    case 'clusters':
      return `${String(row.clusterId)} — cluster row`;
    case 'cluster_matchups':
      return `${String(row.clusterId)} vs ${String(row.opponentClusterId)} — cluster matchup row`;
    case 'cards':
      return `${String(row.commanderId)} — ${String(row.cardId)} — card row`;
    case 'pairs':
      return `${String(row.commanderId)} — ${String(row.cardIdA)} + ${String(row.cardIdB)} — pair row`;
    case 'duration':
      return `${String(row.source)} — duration row`;
    case 'terminations':
      return `${String(row.origin)} — termination row`;
    case 'surrender_turns':
      return `Turn ${String(row.turn)} — surrender row`;
    case 'surrender_phases':
      return `${String(row.phase)} — surrender row`;
    case 'surrender_state':
      return `${String(row.source)} — surrender state row`;
    case 'surrender_exposure_cards':
    case 'surrender_exposure_events':
      return `${String(row.key)} — exposure row`;
  }
}

function ExactTable({
  table,
  weighting,
  onDrill,
}: {
  readonly table: PlayerMetaResultTable;
  readonly weighting: PlayerMetaWeighting;
  readonly onDrill: (target: PlayerMetaDrillTarget) => void;
}) {
  const columns = displayColumns(table);
  const rows = sortPlayerMetaRowsByWeight(table.table, table.rows, weighting);
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
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.key}>{formatPlayerMetaCell(table, row, column)}</td>
              ))}
              <td>
                <button
                  type="button"
                  onClick={() => {
                    onDrill(playerMetaRowDrillTarget(table, row, exactRowTitle(table.table, row)));
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

function TableView({
  table,
  outcome,
  weighting,
  onDrill,
}: {
  readonly table: PlayerMetaResultTableName;
  readonly outcome: TableOutcome | undefined;
  readonly weighting: PlayerMetaWeighting;
  readonly onDrill: (target: PlayerMetaDrillTarget) => void;
}) {
  if (outcome === undefined) return <Busy label={`Reading ${TAB_LABELS[table]}…`} />;
  if (!outcome.ok) {
    return <Failure title="This table could not be read" failure={outcome.failure} />;
  }
  if (outcome.value.rows.length === 0) {
    return <Empty>This query matched no row for this table.</Empty>;
  }
  const note = playerMetaTruncationNote(outcome.value, 'rows');
  return (
    <div className="dashboard__view">
      {SURRENDER_TABLES.has(table) && (
        <p className="panel__note" role="note">
          Structural state and event/card figures from surrenders only — never board, Health or
          resource numbers. A card or event listed here was <em>exposed</em> to a surrendering
          player, in proximity to their concession; this is evidence for review, never a stated
          cause.
        </p>
      )}
      {note !== null && (
        <p className="dashboard__truncation" role="note">
          {note}
        </p>
      )}
      <ExactTable table={outcome.value} weighting={weighting} onDrill={onDrill} />
    </div>
  );
}
