import { useCallback, useEffect, useState } from 'react';

import {
  LIVE_MATCH_SOURCES,
  LIVE_MATCH_TERMINATION_ORIGINS,
  NO_PLAYER_META_FILTER,
  PAGE_SIZE_DEFAULT,
  type ExplorerMatchId,
  type MatchExplorerDecisionDiagnostics,
  type MatchExplorerEventTimeline,
  type MatchExplorerFlattenedEvent,
  type MatchExplorerOutcome,
  type MatchExplorerRow,
  type MatchExplorerSeat,
  type MatchExplorerSeatSummary,
  type MatchExplorerView,
  type PlayerMetaFilterInput,
} from '@tcg/admin-contracts';

import {
  EMPTY_MATCH_EXPLORER_FILTER,
  matchExplorerArtifactStatusLabel,
  matchExplorerEndReasonLabel,
  matchExplorerFilterIsEmpty,
  matchExplorerParticipantKindLabel,
  matchExplorerPhaseLabel,
  matchExplorerSourceLabel,
  matchExplorerTerminationLabel,
  toMatchExplorerFilterInput,
  type MatchExplorerFilterState,
} from '../lib/match-explorer-view.js';
import { toggled } from '../lib/results-view.js';
import type { AdminFailure, AdminOutcome } from '../net/transport.js';
import { useAdminSession } from '../state/AdminContext.js';
import { Busy, Empty, Failure } from './Feedback.js';
import { FactTable, type Fact } from './FactTable.js';

/**
 * M08.26D — the Match Explorer: a filterable listing over the same live-match
 * evidence Deck Explorer (M08.26B) and Card Explorer (M08.26C) already read,
 * opening to one match's termination context, deck snapshots, artifact
 * availability, selected decision diagnostics and (when retained) its
 * flattened event timeline.
 *
 * The filter reuses `playerMetaFilterSchema` verbatim — the same query
 * `matchExplorerList` accepts is the one `PlayerMetaPanel` already reads
 * unfiltered — and this panel is the first place in the client that offers a
 * form over every one of its five fields (`match-explorer-view.ts`'s own doc
 * comment on why three of them are typed rather than selected).
 *
 * Cross-navigation refs are not wired here, matching the precedent
 * `DeckExplorerPanel`'s own drill-down note sets: that is M08.26E's job.
 */

type ViewOutcome = AdminOutcome<MatchExplorerView>;
type TimelineOutcome = AdminOutcome<MatchExplorerEventTimeline>;

export function MatchExplorerPanel() {
  const session = useAdminSession();

  const [filter, setFilter] = useState<MatchExplorerFilterState>(EMPTY_MATCH_EXPLORER_FILTER);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [appliedFilter, setAppliedFilter] = useState<PlayerMetaFilterInput>(NO_PLAYER_META_FILTER);
  const [appliedIsEmpty, setAppliedIsEmpty] = useState(true);

  const [items, setItems] = useState<readonly MatchExplorerRow[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [listFailure, setListFailure] = useState<AdminFailure | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [selected, setSelected] = useState<ExplorerMatchId | null>(null);
  const [view, setView] = useState<ViewOutcome | null>(null);
  const [timeline, setTimeline] = useState<TimelineOutcome | null>(null);
  const [timelineCursor, setTimelineCursor] = useState<string | null>(null);
  const [timelineLoadingMore, setTimelineLoadingMore] = useState(false);

  const search = useCallback(
    async (nextFilter: PlayerMetaFilterInput, isEmpty: boolean): Promise<void> => {
      setAppliedFilter(nextFilter);
      setAppliedIsEmpty(isEmpty);
      setItems(null);
      setListFailure(null);
      setSelected(null);
      setView(null);
      setTimeline(null);
      const answer = await session.matchExplorerList(nextFilter, {
        limit: PAGE_SIZE_DEFAULT,
        cursor: null,
      });
      if (!answer.ok) {
        setListFailure(answer.failure);
        return;
      }
      setItems(answer.value.items);
      setTotal(answer.value.page.total);
      setCursor(answer.value.page.nextCursor);
    },
    [session],
  );

  useEffect(() => {
    void search(NO_PLAYER_META_FILTER, true);
    // Only on mount, matching `ResultsScreen`'s own note: a fresh listing is an
    // explicit "Show matches" or "Show more", never a re-ask on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMore = useCallback(async (): Promise<void> => {
    if (cursor === null) return;
    setLoadingMore(true);
    const answer = await session.matchExplorerList(appliedFilter, {
      limit: PAGE_SIZE_DEFAULT,
      cursor,
    });
    setLoadingMore(false);
    if (!answer.ok) {
      setListFailure(answer.failure);
      return;
    }
    setItems((held) => [...(held ?? []), ...answer.value.items]);
    setCursor(answer.value.page.nextCursor);
  }, [session, appliedFilter, cursor]);

  const open = useCallback(
    (matchId: ExplorerMatchId): void => {
      setSelected(matchId);
      setView(null);
      setTimeline(null);
      setTimelineCursor(null);
      void session.matchExplorerView(matchId).then(setView);
    },
    [session],
  );

  const loadTimeline = useCallback(async (): Promise<void> => {
    if (selected === null) return;
    setTimeline(null);
    const answer = await session.matchExplorerEventTimeline(selected, {
      limit: PAGE_SIZE_DEFAULT,
      cursor: null,
    });
    setTimeline(answer);
    setTimelineCursor(answer.ok ? (answer.value.page?.page.nextCursor ?? null) : null);
  }, [session, selected]);

  const loadMoreTimeline = useCallback(async (): Promise<void> => {
    if (selected === null || timelineCursor === null) return;
    setTimelineLoadingMore(true);
    const answer = await session.matchExplorerEventTimeline(selected, {
      limit: PAGE_SIZE_DEFAULT,
      cursor: timelineCursor,
    });
    setTimelineLoadingMore(false);
    if (!answer.ok) {
      setTimeline(answer);
      return;
    }
    setTimeline((held) => {
      if (held !== null && held.ok && held.value.page !== null && answer.value.page !== null) {
        return {
          ok: true,
          value: {
            status: answer.value.status,
            page: {
              items: [...held.value.page.items, ...answer.value.page.items],
              page: answer.value.page.page,
            },
          },
        };
      }
      return answer;
    });
    setTimelineCursor(answer.value.page?.page.nextCursor ?? null);
  }, [session, selected, timelineCursor]);

  return (
    <section className="panel" aria-labelledby="match-explorer">
      <h2 id="match-explorer">Match Explorer</h2>
      <p className="panel__note">
        Every field below narrows the listing below it; choosing more than one value in a field
        matches any of them. Nothing here changes until you ask.
      </p>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          const result = toMatchExplorerFilterInput(filter);
          if (!result.ok) {
            setFilterError(result.error);
            return;
          }
          setFilterError(null);
          void search(result.value, matchExplorerFilterIsEmpty(filter));
        }}
      >
        <fieldset className="builder__field">
          <legend>Source</legend>
          {LIVE_MATCH_SOURCES.map((source) => (
            <label key={source}>
              <input
                type="checkbox"
                checked={filter.sources.includes(source)}
                onChange={() => {
                  setFilter((held) => ({ ...held, sources: toggled(held.sources, source) }));
                }}
              />
              {matchExplorerSourceLabel(source)}
            </label>
          ))}
        </fieldset>

        <fieldset className="builder__field">
          <legend>Termination</legend>
          {LIVE_MATCH_TERMINATION_ORIGINS.map((origin) => (
            <label key={origin}>
              <input
                type="checkbox"
                checked={filter.terminations.includes(origin)}
                onChange={() => {
                  setFilter((held) => ({
                    ...held,
                    terminations: toggled(held.terminations, origin),
                  }));
                }}
              />
              {matchExplorerTerminationLabel(origin)}
            </label>
          ))}
        </fieldset>

        <label className="builder__field">
          Content versions (comma-separated)
          <input
            type="text"
            value={filter.contentVersions}
            placeholder="3, 4"
            onChange={(event) => {
              setFilter((held) => ({ ...held, contentVersions: event.target.value }));
            }}
          />
        </label>
        <label className="builder__field">
          Commander IDs (comma-separated)
          <input
            type="text"
            value={filter.commanderIds}
            onChange={(event) => {
              setFilter((held) => ({ ...held, commanderIds: event.target.value }));
            }}
          />
        </label>
        <label className="builder__field">
          Deck hashes (comma-separated)
          <input
            type="text"
            value={filter.deckHashes}
            placeholder="0123456789abcdef"
            onChange={(event) => {
              setFilter((held) => ({ ...held, deckHashes: event.target.value }));
            }}
          />
        </label>

        <p className="builder__actions">
          <button type="submit">Show matches</button>
          <button
            type="button"
            onClick={() => {
              setFilter(EMPTY_MATCH_EXPLORER_FILTER);
              setFilterError(null);
              void search(NO_PLAYER_META_FILTER, true);
            }}
          >
            Clear
          </button>
        </p>
      </form>
      {filterError !== null && (
        <p className="feedback feedback--failure" role="alert">
          {filterError}
        </p>
      )}

      <section className="panel" aria-labelledby="match-explorer-list">
        <h3 id="match-explorer-list">
          {appliedIsEmpty ? 'Every match this server holds' : 'Matching matches'}
        </h3>
        {total !== null && (
          <p className="panel__note">
            {total} {total === 1 ? 'match matches' : 'matches match'} this filter.
          </p>
        )}

        {listFailure !== null && (
          <Failure
            title="This listing could not be read"
            failure={listFailure}
            onRetry={() => void search(appliedFilter, appliedIsEmpty)}
          />
        )}
        {items === null && listFailure === null && <Busy label="Asking the match record…" />}
        {items !== null && items.length === 0 && (
          <Empty>
            No match in this server&apos;s one configured result root matches this filter.
          </Empty>
        )}
        {items !== null && items.length > 0 && (
          <ul className="results__rows">
            {items.map((row) => (
              <li key={row.matchId}>
                <button
                  type="button"
                  className={row.matchId === selected ? 'is-current' : ''}
                  aria-current={row.matchId === selected ? 'true' : undefined}
                  onClick={() => {
                    open(row.matchId);
                  }}
                >
                  <span className="results__row-label">{row.matchId}</span>
                  <span className="results__row-note">
                    {matchExplorerTerminationLabel(row.terminationOrigin)} ·{' '}
                    {matchExplorerSourceLabel(row.observedIn.source)} · {seatsSummary(row.seats)}
                    {row.outcome !== null ? ` · ${outcomeSummary(row.outcome)}` : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {cursor !== null && (
          <p className="builder__actions">
            <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? 'Reading more…' : 'Show more'}
            </button>
          </p>
        )}
      </section>

      {selected !== null && (
        <MatchDetail
          matchId={selected}
          view={view}
          onRetry={() => open(selected)}
          timeline={timeline}
          timelineCursor={timelineCursor}
          timelineLoadingMore={timelineLoadingMore}
          onLoadTimeline={() => void loadTimeline()}
          onLoadMoreTimeline={() => void loadMoreTimeline()}
        />
      )}
    </section>
  );
}

function seatsSummary(
  seats: readonly [MatchExplorerSeatSummary, MatchExplorerSeatSummary],
): string {
  return seats
    .map((seat) => `${seat.commanderId} (${matchExplorerParticipantKindLabel(seat.kind)})`)
    .join(' vs ');
}

function outcomeSummary(outcome: MatchExplorerOutcome): string {
  if (outcome.outcome === 'draw') return `draw (${matchExplorerEndReasonLabel(outcome.reason)})`;
  return `won by ${outcome.winnerId ?? 'unknown'} (${matchExplorerEndReasonLabel(outcome.reason)})`;
}

interface MatchDetailProps {
  readonly matchId: ExplorerMatchId;
  readonly view: ViewOutcome | null;
  readonly onRetry: () => void;
  readonly timeline: TimelineOutcome | null;
  readonly timelineCursor: string | null;
  readonly timelineLoadingMore: boolean;
  readonly onLoadTimeline: () => void;
  readonly onLoadMoreTimeline: () => void;
}

function MatchDetail({
  matchId,
  view,
  onRetry,
  timeline,
  timelineCursor,
  timelineLoadingMore,
  onLoadTimeline,
  onLoadMoreTimeline,
}: MatchDetailProps) {
  return (
    <div className="dashboard__drill" role="region" aria-label={`Match ${matchId}`}>
      <div className="dashboard__drill-head">
        <h3>{matchId}</h3>
      </div>

      {view === null && <Busy label="Reading this match…" />}
      {view !== null && !view.ok && (
        <Failure title="This match could not be shown" failure={view.failure} onRetry={onRetry} />
      )}
      {view !== null && view.ok && (
        <>
          <IdentityView view={view.value} />
          <SeatsView seats={view.value.seats} />
          <ArtifactsView
            view={view.value}
            timeline={timeline}
            timelineCursor={timelineCursor}
            timelineLoadingMore={timelineLoadingMore}
            onLoadTimeline={onLoadTimeline}
            onLoadMoreTimeline={onLoadMoreTimeline}
          />
        </>
      )}
    </div>
  );
}

function IdentityView({ view }: { readonly view: MatchExplorerView }) {
  const facts: Fact[] = [
    { label: 'Termination', value: matchExplorerTerminationLabel(view.terminationOrigin) },
    { label: 'Action count', value: String(view.actionCount) },
    { label: 'Source', value: matchExplorerSourceLabel(view.observedIn.source) },
    { label: 'Content version', value: String(view.observedIn.contentVersion) },
    { label: 'Rules version', value: view.observedIn.rulesVersion },
  ];
  if (view.outcome !== null) {
    facts.push(
      { label: 'Outcome', value: view.outcome.outcome === 'draw' ? 'Draw' : 'Win' },
      { label: 'Winner', value: view.outcome.winnerId ?? '—' },
      { label: 'End reason', value: matchExplorerEndReasonLabel(view.outcome.reason) },
      { label: 'Final turn', value: String(view.outcome.finalTurn) },
    );
    if (view.outcome.diagnostics !== null) {
      facts.push({ label: 'Engine diagnostics', value: view.outcome.diagnostics });
    }
  } else {
    facts.push({ label: 'Outcome', value: 'Not recorded' });
  }
  return <FactTable caption="This match's identity" facts={facts} />;
}

function SeatsView({ seats }: { readonly seats: readonly [MatchExplorerSeat, MatchExplorerSeat] }) {
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">Both seats&apos; deck snapshots</caption>
        <thead>
          <tr>
            <th scope="col">Seat</th>
            <th scope="col">Player</th>
            <th scope="col">Kind</th>
            <th scope="col">Commander</th>
            <th scope="col">Deck hash</th>
            <th scope="col">Card entries</th>
          </tr>
        </thead>
        <tbody>
          {seats.map((seat) => (
            <tr key={seat.playerId}>
              <td>{seat.seatIndex}</td>
              <td>{seat.playerId}</td>
              <td>{matchExplorerParticipantKindLabel(seat.kind)}</td>
              <td>{seat.deck.commanderId}</td>
              <td>{seat.deck.deckHash}</td>
              <td>{seat.deck.cards.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArtifactsView({
  view,
  timeline,
  timelineCursor,
  timelineLoadingMore,
  onLoadTimeline,
  onLoadMoreTimeline,
}: {
  readonly view: MatchExplorerView;
  readonly timeline: TimelineOutcome | null;
  readonly timelineCursor: string | null;
  readonly timelineLoadingMore: boolean;
  readonly onLoadTimeline: () => void;
  readonly onLoadMoreTimeline: () => void;
}) {
  const facts: Fact[] = [
    { label: 'Raw event log', value: matchExplorerArtifactStatusLabel(view.artifacts.rawEvent) },
    { label: 'Replay', value: matchExplorerArtifactStatusLabel(view.artifacts.replay) },
    {
      label: 'Pre-action capture (surrender)',
      value: matchExplorerArtifactStatusLabel(view.artifacts.preActionCapture),
    },
  ];
  return (
    <>
      <FactTable caption="Artifact availability" facts={facts} />

      {view.artifacts.rawEvent === 'present' && (
        <div>
          {timeline === null && (
            <p className="builder__actions">
              <button type="button" onClick={onLoadTimeline}>
                View event timeline
              </button>
            </p>
          )}
          {timeline !== null && (
            <TimelineView
              timeline={timeline}
              cursor={timelineCursor}
              loadingMore={timelineLoadingMore}
              onLoadMore={onLoadMoreTimeline}
              onRetry={onLoadTimeline}
            />
          )}
        </div>
      )}
      {view.artifacts.rawEvent !== 'present' && (
        <p className="panel__note">
          No event timeline: this deployment&apos;s retention configuration did not keep this
          match&apos;s raw-event log.
        </p>
      )}

      {view.decisionDiagnostics !== null && (
        <DecisionDiagnosticsView diagnostics={view.decisionDiagnostics} />
      )}
    </>
  );
}

function TimelineView({
  timeline,
  cursor,
  loadingMore,
  onLoadMore,
  onRetry,
}: {
  readonly timeline: TimelineOutcome;
  readonly cursor: string | null;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
}) {
  if (!timeline.ok) {
    return (
      <Failure
        title="This event timeline could not be read"
        failure={timeline.failure}
        onRetry={onRetry}
      />
    );
  }
  if (timeline.value.page === null) {
    return (
      <Empty>
        This match&apos;s raw-event log is{' '}
        {matchExplorerArtifactStatusLabel(timeline.value.status).toLowerCase()}.
      </Empty>
    );
  }
  if (timeline.value.page.items.length === 0) {
    return <Empty>This match&apos;s raw-event log carries no event.</Empty>;
  }
  return (
    <div className="dashboard__heatmap-wrap">
      <table className="dashboard__bars">
        <caption className="visually-hidden">This match&apos;s flattened event timeline</caption>
        <thead>
          <tr>
            <th scope="col">Sequence</th>
            <th scope="col">Type</th>
            <th scope="col">Summary</th>
          </tr>
        </thead>
        <tbody>
          {timeline.value.page.items.map((event: MatchExplorerFlattenedEvent) => (
            <tr key={event.sequence}>
              <td>{event.sequence}</td>
              <td>{event.type}</td>
              <td>{event.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cursor !== null && (
        <p className="builder__actions">
          <button type="button" onClick={onLoadMore} disabled={loadingMore}>
            {loadingMore ? 'Reading more…' : 'Show more'}
          </button>
        </p>
      )}
    </div>
  );
}

function DecisionDiagnosticsView({
  diagnostics,
}: {
  readonly diagnostics: MatchExplorerDecisionDiagnostics;
}) {
  const facts: Fact[] = [
    { label: 'Conceding player', value: diagnostics.playerId },
    { label: 'Origin', value: matchExplorerTerminationLabel(diagnostics.origin) },
    { label: 'Turn', value: String(diagnostics.turn) },
    { label: 'Phase', value: matchExplorerPhaseLabel(diagnostics.phase) },
    { label: 'Active player', value: diagnostics.activePlayerId },
    { label: 'In combat', value: diagnostics.inCombat ? 'Yes' : 'No' },
    { label: 'Reaction window open', value: diagnostics.reactionWindowOpen ? 'Yes' : 'No' },
    { label: 'Pending choice open', value: diagnostics.pendingChoiceOpen ? 'Yes' : 'No' },
  ];
  if (diagnostics.pendingChoiceType !== null) {
    facts.push({ label: 'Pending choice type', value: diagnostics.pendingChoiceType });
  }
  return (
    <>
      <FactTable caption="Selected decision diagnostics, at the capture instant" facts={facts} />
      {diagnostics.recentEvents.length > 0 && (
        <div className="dashboard__heatmap-wrap">
          <table className="dashboard__bars">
            <caption className="visually-hidden">Recent events leading to the capture</caption>
            <thead>
              <tr>
                <th scope="col">Sequence</th>
                <th scope="col">Type</th>
                <th scope="col">Summary</th>
              </tr>
            </thead>
            <tbody>
              {diagnostics.recentEvents.map((event) => (
                <tr key={event.sequence}>
                  <td>{event.sequence}</td>
                  <td>{event.type}</td>
                  <td>{event.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
