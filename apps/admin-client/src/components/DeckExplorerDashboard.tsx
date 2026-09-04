import { useCallback, useEffect, useState } from 'react';

import {
  PAGE_SIZE_MAX,
  adaptiveExperimentIdSchema,
  liveMatchDeckHashSchema,
  type AdaptiveExperimentId,
  type DeckExplorerView,
  type LiveMatchDeckHash,
  type PlayerMetaResultTable,
  type PlayerMetaResultTableName,
  type ResultRow,
} from '@tcg/admin-contracts';

import {
  DECK_EXPLORER_EVIDENCE_TABLES,
  DECK_EXPLORER_EVIDENCE_TABLE_LABELS,
  deckExplorerConstructionLabel,
  deckExplorerEvidenceFilter,
  deckExplorerSideLabel,
} from '../lib/deck-explorer-view.js';
import {
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
 * M08.26B — the Deck Explorer: an immutable card list and Commander tied to
 * one exact observed occurrence of a deck hash, its provenance, and
 * (optionally) the Adaptive Counter revision lineage that produced it —
 * `deck-explorer.ts`'s own doc comment on why that is what
 * `deckExplorerViewSchema` answers and nothing more.
 *
 * Matches, matchup split, cluster and separated AI/human evidence are not a
 * second read model here: they are the existing `playerMetaResultTable`
 * address, narrowed to this one deck hash via `deckExplorerEvidenceFilter`,
 * rendered with the exact same `player-meta-view.ts` helpers
 * `PlayerMetaDashboard.tsx` already uses — same cell formatting, same
 * drill-down, same Match Explorer disclaimer.
 *
 * Entered the same way `AdaptiveRunPanel` is entered — by typing an
 * identifier, here a deck hash plus an optional Adaptive Counter experiment
 * ID — because a deck read has neither a `JobId` nor a catalog row to select
 * from.
 */

type EvidenceOutcome = AdminOutcome<PlayerMetaResultTable>;

export function DeckExplorerPanel() {
  const session = useAdminSession();
  const [hashInput, setHashInput] = useState('');
  const [experimentInput, setExperimentInput] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [deckHash, setDeckHash] = useState<LiveMatchDeckHash | null>(null);
  const [view, setView] = useState<AdminOutcome<DeckExplorerView> | null>(null);
  const [evidenceView, setEvidenceView] = useState<PlayerMetaResultTableName>('decks');
  const [evidence, setEvidence] = useState<
    Partial<Record<PlayerMetaResultTableName, EvidenceOutcome>>
  >({});
  const [weighting, setWeighting] = useState<PlayerMetaWeighting>('matches');
  const [drill, setDrill] = useState<PlayerMetaDrillTarget | null>(null);

  const open = useCallback(
    (hash: LiveMatchDeckHash, experimentId: AdaptiveExperimentId | null) => {
      setDeckHash(hash);
      setView(null);
      setEvidence({});
      setEvidenceView('decks');
      setWeighting('matches');
      setDrill(null);
      void session.deckExplorerView(hash, experimentId).then(setView);
    },
    [session],
  );

  useEffect(() => {
    if (deckHash === null || view === null || !view.ok) return;
    let live = true;
    for (const table of DECK_EXPLORER_EVIDENCE_TABLES) {
      void session
        .playerMetaResultTable(table, deckExplorerEvidenceFilter(deckHash), {
          limit: PAGE_SIZE_MAX,
          cursor: null,
        })
        .then((outcome) => {
          if (live) setEvidence((held) => ({ ...held, [table]: outcome }));
        });
    }
    return () => {
      live = false;
    };
    // `view.ok` alone decides whether a fresh fetch is needed; `deckHash` names which
    // deck it is for, and `session` is stable for the life of this screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, deckHash, view?.ok]);

  return (
    <section className="panel" aria-labelledby="deck-explorer">
      <h2 id="deck-explorer">Deck Explorer</h2>
      <p className="panel__note">
        Enter the deck hash to inspect. Its immutable identity is read off the one live match this
        server finds carrying it; matches, matchup split, cluster and separated AI/human evidence
        are the existing Player Meta tables narrowed to this one deck.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const parsedHash = liveMatchDeckHashSchema.safeParse(hashInput.trim());
          if (!parsedHash.success) {
            setFormError(parsedHash.error.issues[0]?.message ?? 'Not a valid deck hash.');
            return;
          }
          let experimentId: AdaptiveExperimentId | null = null;
          if (experimentInput.trim() !== '') {
            const parsedExperiment = adaptiveExperimentIdSchema.safeParse(experimentInput.trim());
            if (!parsedExperiment.success) {
              setFormError(
                parsedExperiment.error.issues[0]?.message ?? 'Not a valid experiment ID.',
              );
              return;
            }
            experimentId = parsedExperiment.data;
          }
          setFormError(null);
          open(parsedHash.data, experimentId);
        }}
      >
        <label className="builder__field">
          Deck hash
          <input
            type="text"
            value={hashInput}
            placeholder="0123456789abcdef"
            onChange={(event) => {
              setHashInput(event.target.value);
            }}
          />
        </label>
        <label className="builder__field">
          Adaptive Counter experiment ID (optional, for known revisions)
          <input
            type="text"
            value={experimentInput}
            placeholder="goblin_counter"
            onChange={(event) => {
              setExperimentInput(event.target.value);
            }}
          />
        </label>
        <p className="builder__actions">
          <button type="submit">Open</button>
        </p>
      </form>
      {formError !== null && (
        <p className="feedback feedback--failure" role="alert">
          {formError}
        </p>
      )}

      {view === null && deckHash !== null && <Busy label="Reading the deck's identity…" />}
      {view !== null && !view.ok && (
        <Failure
          title="This deck could not be shown"
          failure={view.failure}
          onRetry={() => {
            if (deckHash === null) return;
            open(deckHash, null);
          }}
        />
      )}
      {view !== null && view.ok && (
        <>
          <IdentityView view={view.value} />
          <RevisionsView view={view.value} />

          <div className="dashboard__tabs" role="group" aria-label="Deck evidence">
            {DECK_EXPLORER_EVIDENCE_TABLES.map((table) => (
              <button
                key={table}
                type="button"
                aria-pressed={evidenceView === table}
                className={evidenceView === table ? 'is-current' : ''}
                onClick={() => {
                  setEvidenceView(table);
                  setDrill(null);
                }}
              >
                {DECK_EXPLORER_EVIDENCE_TABLE_LABELS[table] ?? table}
              </button>
            ))}
          </div>

          {hasPlayerMetaWeighting(evidenceView) && (
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

          <EvidenceTableView
            table={evidenceView}
            outcome={evidence[evidenceView]}
            weighting={weighting}
            onDrill={setDrill}
          />

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
                This is the exact row a cell summarizes — not a further aggregate. Opening one
                contributing match or its replay is not available from this screen: that needs a
                listing over the run&apos;s match records, which is M08.26&apos;s Match Explorer to
                build.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function IdentityView({ view }: { readonly view: DeckExplorerView }) {
  if (view.identity === null) {
    return (
      <Empty>
        No live match in the server&apos;s one configured result root played deck hash{' '}
        {view.deckHash} yet — this is a fact about what has been played, not a failed read.
      </Empty>
    );
  }
  const { identity } = view;
  const facts: Fact[] = [
    { label: 'Deck hash', value: view.deckHash },
    { label: 'Commander', value: identity.commanderId },
    { label: 'Card entries', value: String(identity.cards.length) },
    { label: 'Observed source', value: identity.observedIn.source },
    { label: 'Content version', value: String(identity.observedIn.contentVersion) },
    { label: 'Rules version', value: identity.observedIn.rulesVersion },
  ];
  return (
    <>
      <FactTable caption="This deck's identity" facts={facts} />
      <div className="dashboard__heatmap-wrap">
        <table className="dashboard__bars">
          <caption className="visually-hidden">This deck&apos;s exact card list</caption>
          <thead>
            <tr>
              <th scope="col">Card</th>
              <th scope="col">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {identity.cards.map((entry) => (
              <tr key={entry.cardId}>
                <td>{entry.cardId}</td>
                <td>{entry.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function RevisionsView({ view }: { readonly view: DeckExplorerView }) {
  if (view.knownRevisions === null) {
    return (
      <p className="panel__note" role="note">
        Known revisions: not checked — name an Adaptive Counter experiment ID above to cross-check
        this deck against its revision lineage.
      </p>
    );
  }
  if (view.knownRevisions.length === 0) {
    return (
      <Empty>
        Known revisions: checked — no revision in the named experiment&apos;s lineage names this
        deck hash.
      </Empty>
    );
  }
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">Known revisions naming this deck</caption>
        <thead>
          <tr>
            <th scope="col">Side</th>
            <th scope="col">Revision</th>
            <th scope="col">Parent</th>
            <th scope="col">Generation</th>
            <th scope="col">Block</th>
            <th scope="col">Opponent revision</th>
            <th scope="col">Construction</th>
            <th scope="col">Swaps</th>
          </tr>
        </thead>
        <tbody>
          {view.knownRevisions.map((revision) => (
            <tr key={revision.revisionId}>
              <td>{deckExplorerSideLabel(revision.side)}</td>
              <td>{revision.revisionId}</td>
              <td>{revision.parentRevisionId ?? '—'}</td>
              <td>{revision.generation}</td>
              <td>{revision.block}</td>
              <td>{revision.opponentRevisionId ?? '—'}</td>
              <td>{deckExplorerConstructionLabel(revision.construction)}</td>
              <td>{revision.swapCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The title a reused evidence row's drill-down opens under — the subset of `PlayerMetaDashboard.tsx`'s own `exactRowTitle` this panel's four tables need. */
function exactRowTitle(table: PlayerMetaResultTableName, row: ResultRow): string {
  switch (table) {
    case 'decks':
      return `${String(row.deckHash)} — deck row`;
    case 'deck_matchups':
      return `${String(row.deckHash)} vs ${String(row.opponentDeckHash)} — matchup row`;
    case 'clusters':
      return `${String(row.clusterId)} — cluster row`;
    case 'cluster_matchups':
      return `${String(row.clusterId)} vs ${String(row.opponentClusterId)} — cluster matchup row`;
    default:
      return 'Exact row';
  }
}

function EvidenceTable({
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
  const label = DECK_EXPLORER_EVIDENCE_TABLE_LABELS[table.table] ?? table.table;
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">{label} — exact rows</caption>
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

function EvidenceTableView({
  table,
  outcome,
  weighting,
  onDrill,
}: {
  readonly table: PlayerMetaResultTableName;
  readonly outcome: EvidenceOutcome | undefined;
  readonly weighting: PlayerMetaWeighting;
  readonly onDrill: (target: PlayerMetaDrillTarget) => void;
}) {
  const label = DECK_EXPLORER_EVIDENCE_TABLE_LABELS[table] ?? table;
  if (outcome === undefined) return <Busy label={`Reading ${label}…`} />;
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
      <EvidenceTable table={outcome.value} weighting={weighting} onDrill={onDrill} />
    </div>
  );
}
