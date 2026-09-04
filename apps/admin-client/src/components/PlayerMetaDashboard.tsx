import { useEffect, useState } from 'react';

import {
  NO_PLAYER_META_FILTER,
  PAGE_SIZE_MAX,
  type PlayerMetaResultTable,
  type PlayerMetaResultTableName,
  type PlayerMetaRunSummary,
} from '@tcg/admin-contracts';

import {
  PLAYER_META_DASHBOARD_TABLES,
  displayColumns,
  formatPlayerMetaCell,
  hasPlayerMetaWeighting,
  playerMetaTruncationNote,
  sortPlayerMetaRowsByWeight,
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
 * not need one). No drill-down here: that is M08.25E's job.
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
};

export function PlayerMetaPanel() {
  const session = useAdminSession();
  const [summary, setSummary] = useState<AdminOutcome<PlayerMetaRunSummary> | null>(null);
  const [view, setView] = useState<PlayerMetaResultTableName>('commanders');
  const [tables, setTables] = useState<Partial<Record<PlayerMetaResultTableName, TableOutcome>>>(
    {},
  );
  const [weighting, setWeighting] = useState<PlayerMetaWeighting>('matches');

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
                }}
              >
                By unique decks
              </button>
            </div>
          )}

          <TableView table={view} outcome={tables[view]} weighting={weighting} />
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

function ExactTable({
  table,
  weighting,
}: {
  readonly table: PlayerMetaResultTable;
  readonly weighting: PlayerMetaWeighting;
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
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column.key}>{formatPlayerMetaCell(table, row, column)}</td>
              ))}
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
}: {
  readonly table: PlayerMetaResultTableName;
  readonly outcome: TableOutcome | undefined;
  readonly weighting: PlayerMetaWeighting;
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
      {note !== null && (
        <p className="dashboard__truncation" role="note">
          {note}
        </p>
      )}
      <ExactTable table={outcome.value} weighting={weighting} />
    </div>
  );
}
