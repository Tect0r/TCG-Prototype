import {
  adminError,
  matchExplorerEventTimelineSchema,
  matchExplorerListSchema,
  matchExplorerViewSchema,
  type AdminError,
  type MatchExplorerDecisionDiagnostics,
  type MatchExplorerEventTimeline,
  type MatchExplorerEventTimelineRequest,
  type MatchExplorerFlattenedEvent,
  type MatchExplorerList,
  type MatchExplorerListRequest,
  type MatchExplorerOutcome,
  type MatchExplorerRow,
  type MatchExplorerSeat,
  type MatchExplorerSeatSummary,
  type MatchExplorerView,
  type MatchExplorerViewRequest,
} from '@tcg/admin-contracts';
import { err, isErr, ok, type Result } from '@tcg/shared';
import {
  filterLiveMatches,
  readLiveMatchEnvelopes,
  readLiveMatchPreActionCaptures,
  readLiveMatchRawEvent,
  readLiveMatchReplay,
} from '@tcg/simulator';

import { type ResolvedCatalogRoots } from '../catalog/roots.js';
import { decodeRowCursor, encodeRowCursor } from './results.js';

/**
 * M08.26D — the Match Explorer read model. See `match-explorer.ts`
 * (`@tcg/admin-contracts`) for the full design rationale — this file is the
 * thin execution of that design: read raw live-match envelopes, one match's
 * optional raw-event/replay/pre-action-capture artifacts, and reduce them to
 * `MatchExplorerList`/`MatchExplorerView`/`MatchExplorerEventTimeline`, never
 * a second copy of the flattening logic `aggregateLiveMatchSurrenders`
 * (`@tcg/simulator`) already draws for the *aggregate* surrender view.
 */

type LiveMatchEnvelope = ReturnType<typeof readLiveMatchEnvelopes>['matches'][number];
type LiveMatchPreActionCapture = ReturnType<
  typeof readLiveMatchPreActionCaptures
>['captures'][number];
type LiveMatchRawEventArtifact = NonNullable<ReturnType<typeof readLiveMatchRawEvent>>;
type LiveMatchRawEvent = LiveMatchRawEventArtifact['log'][number];

/**
 * Restates `LIVE_MATCH_VOLUNTARY_TERMINATION_ORIGINS`
 * (`@tcg/match-telemetry`'s `schema.ts`) — the only two origins a pre-action
 * capture can ever exist for. `@tcg/simulator` does not re-export it (ADR
 * 0023 §2), so it is restated narrowly here rather than imported.
 */
const MATCH_EXPLORER_VOLUNTARY_TERMINATION_ORIGINS = ['concede_action', 'concede_leave'] as const;

/* -------------------------------------------------------------- evidence */

function liveMatchEvidenceOf(match: LiveMatchEnvelope) {
  return {
    realm: 'live_match' as const,
    source: match.source,
    contentVersion: match.provenance.contentVersion,
    rulesVersion: match.provenance.rulesVersion,
  };
}

/* ----------------------------------------------------------------- seats */

function seatSummaryOf(seat: LiveMatchEnvelope['seats'][number]): MatchExplorerSeatSummary {
  return {
    seatIndex: seat.seatIndex,
    playerId: seat.playerId,
    kind: seat.kind,
    commanderId: seat.deck.commanderId,
    deckHash: seat.deck.deckHash,
    deckRef: { kind: 'deck', deckHash: seat.deck.deckHash },
  };
}

function seatOf(seat: LiveMatchEnvelope['seats'][number]): MatchExplorerSeat {
  return {
    seatIndex: seat.seatIndex,
    playerId: seat.playerId,
    kind: seat.kind,
    deck: {
      commanderId: seat.deck.commanderId,
      cards: seat.deck.cards.map((entry) => ({
        cardId: entry.cardId,
        quantity: entry.quantity,
        cardRef: { kind: 'card', cardId: entry.cardId },
      })),
      deckHash: seat.deck.deckHash,
    },
    deckRef: { kind: 'deck', deckHash: seat.deck.deckHash },
  };
}

/* -------------------------------------------------------------- outcome */

function outcomeOf(match: LiveMatchEnvelope): MatchExplorerOutcome | null {
  if (match.outcome === null) return null;
  return {
    outcome: match.outcome.outcome,
    winnerId: match.outcome.winnerId,
    loserIds: match.outcome.loserIds,
    reason: match.outcome.reason,
    finalTurn: match.outcome.finalTurn,
    finalSequence: match.outcome.finalSequence,
    diagnostics: match.outcome.diagnostics,
  };
}

/* --------------------------------------------------------- flattened events */

/** One `GameEvent`, reduced generically to `{sequence, type, summary}` — see file doc comment. */
function flattenEvent(event: LiveMatchRawEvent): MatchExplorerFlattenedEvent {
  const { sequence, type } = event;
  const rest: Record<string, unknown> = { ...event };
  delete rest.sequence;
  delete rest.cause;
  delete rest.type;

  const text = `${type}: ${JSON.stringify(rest)}`;
  return { sequence, type, summary: text.length > 200 ? text.slice(0, 200) : text };
}

/* ----------------------------------------------------- decision diagnostics */

/**
 * Mirrors `SurrenderStateSummary`'s own structural-state-only derivation
 * (`apps/simulator/src/analysis/live-match-surrender.ts`) for a *single*
 * capture rather than an aggregate: a pre-action capture never records board,
 * Health or resource state, only whether combat had declared attacks,
 * whether a Reaction window was open, and whether a pending choice was open.
 */
function decisionDiagnosticsOf(
  capture: LiveMatchPreActionCapture,
): MatchExplorerDecisionDiagnostics {
  return {
    playerId: capture.playerId,
    origin: capture.origin,
    turn: capture.turn,
    phase: capture.phase,
    activePlayerId: capture.activePlayerId,
    sequence: capture.sequence,
    inCombat: capture.combat.attacks.length > 0,
    reactionWindowOpen: capture.reactionWindow !== null,
    pendingChoiceOpen: capture.pendingChoice !== null,
    pendingChoiceType: capture.pendingChoice !== null ? capture.pendingChoice.type : null,
    recentEvents: capture.eventWindow.recentEvents.map(flattenEvent),
  };
}

/* ------------------------------------------------------------ finding a match */

/** The one live-match envelope named by `matchId`, or `null` if none was found. This is the one place `matchId` is proven safe before it reaches a targeted artifact reader — see `live-match-artifact-read.ts`'s doc comment. */
function findMatchExplorerMatch(rootDirectory: string, matchId: string): LiveMatchEnvelope | null {
  const { matches } = readLiveMatchEnvelopes(rootDirectory);
  return matches.find((match) => match.matchId === matchId) ?? null;
}

function findMatchExplorerCapture(
  rootDirectory: string,
  matchId: string,
): LiveMatchPreActionCapture | null {
  const { captures } = readLiveMatchPreActionCaptures(rootDirectory);
  return captures.find((capture) => capture.matchId === matchId) ?? null;
}

/* -------------------------------------------------------------- the list */

function rowOf(match: LiveMatchEnvelope): MatchExplorerRow {
  const [seatA, seatB] = match.seats;
  return {
    matchId: match.matchId,
    terminationOrigin: match.terminationOrigin,
    actionCount: match.actionCount,
    seats: [seatSummaryOf(seatA), seatSummaryOf(seatB)],
    outcome: outcomeOf(match),
    observedIn: liveMatchEvidenceOf(match),
  };
}

function readMatchExplorerList(
  rootDirectory: string,
  request: MatchExplorerListRequest,
): Result<MatchExplorerList, readonly AdminError[]> {
  const { matches } = readLiveMatchEnvelopes(rootDirectory);
  const filtered = filterLiveMatches(matches, request.filter);
  const sorted = [...filtered].sort((left, right) => (left.matchId < right.matchId ? -1 : 1));

  let offset = 0;
  if (request.page.cursor !== null) {
    const decoded = decodeRowCursor(request.page.cursor);
    if (isErr(decoded)) return decoded;
    offset = decoded.value;
  }

  const rows = sorted.slice(offset, offset + request.page.limit).map(rowOf);
  const consumed = offset + rows.length;

  const parsed = matchExplorerListSchema.safeParse({
    items: rows,
    page: {
      returned: rows.length,
      limit: request.page.limit,
      nextCursor: consumed < sorted.length ? encodeRowCursor(consumed) : null,
      total: sorted.length,
    },
  });
  if (!parsed.success) return err([builtBadly('match-explorer-list')]);
  return ok(parsed.data);
}

/* -------------------------------------------------------------- the view */

function artifactStatusOf(present: boolean): 'present' | 'not_retained' {
  return present ? 'present' : 'not_retained';
}

function readMatchExplorerView(
  rootDirectory: string,
  request: MatchExplorerViewRequest,
): Result<MatchExplorerView, readonly AdminError[]> {
  const match = findMatchExplorerMatch(rootDirectory, request.matchId);
  if (match === null) return err([matchNotFound(request.matchId)]);

  const voluntary = (MATCH_EXPLORER_VOLUNTARY_TERMINATION_ORIGINS as readonly string[]).includes(
    match.terminationOrigin,
  );
  const capture = voluntary ? findMatchExplorerCapture(rootDirectory, request.matchId) : null;

  const [seatA, seatB] = match.seats;

  const parsed = matchExplorerViewSchema.safeParse({
    matchId: match.matchId,
    terminationOrigin: match.terminationOrigin,
    actionCount: match.actionCount,
    seats: [seatOf(seatA), seatOf(seatB)],
    outcome: outcomeOf(match),
    artifacts: {
      rawEvent: artifactStatusOf(readLiveMatchRawEvent(rootDirectory, match.matchId) !== null),
      replay: artifactStatusOf(readLiveMatchReplay(rootDirectory, match.matchId) !== null),
      preActionCapture: !voluntary ? 'not_applicable' : artifactStatusOf(capture !== null),
    },
    decisionDiagnostics: capture !== null ? decisionDiagnosticsOf(capture) : null,
    observedIn: liveMatchEvidenceOf(match),
  });
  if (!parsed.success) return err([builtBadly('match-explorer-view')]);
  return ok(parsed.data);
}

/* -------------------------------------------------------- the event timeline */

function readMatchExplorerEventTimeline(
  rootDirectory: string,
  request: MatchExplorerEventTimelineRequest,
): Result<MatchExplorerEventTimeline, readonly AdminError[]> {
  const match = findMatchExplorerMatch(rootDirectory, request.matchId);
  if (match === null) return err([matchNotFound(request.matchId)]);

  const artifact = readLiveMatchRawEvent(rootDirectory, match.matchId);
  if (artifact === null) {
    const parsed = matchExplorerEventTimelineSchema.safeParse({
      status: 'not_retained',
      page: null,
    });
    if (!parsed.success) return err([builtBadly('match-explorer-event-timeline')]);
    return ok(parsed.data);
  }

  let offset = 0;
  if (request.page.cursor !== null) {
    const decoded = decodeRowCursor(request.page.cursor);
    if (isErr(decoded)) return decoded;
    offset = decoded.value;
  }

  const events = artifact.log.slice(offset, offset + request.page.limit).map(flattenEvent);
  const consumed = offset + events.length;

  const parsed = matchExplorerEventTimelineSchema.safeParse({
    status: 'present',
    page: {
      items: events,
      page: {
        returned: events.length,
        limit: request.page.limit,
        nextCursor: consumed < artifact.log.length ? encodeRowCursor(consumed) : null,
        total: artifact.log.length,
      },
    },
  });
  if (!parsed.success) return err([builtBadly('match-explorer-event-timeline')]);
  return ok(parsed.data);
}

/* ---------------------------------------------------------- the HTTP reader */

export interface MatchExplorerReaderOptions {
  readonly roots: ResolvedCatalogRoots;
  readonly resultRootId: string;
}

/**
 * The thin HTTP-facing layer for M08.26D's three `match-explorer-*`
 * addresses, reading live-match evidence out of the server's one configured
 * default result root — the same root `DeckExplorerReader` and
 * `CardExplorerReader` read, for the same reason: a match's own record has no
 * `JobId` of its own.
 */
export class MatchExplorerReader {
  readonly #roots: ResolvedCatalogRoots;
  readonly #resultRootId: string;

  constructor(options: MatchExplorerReaderOptions) {
    this.#roots = options.roots;
    this.#resultRootId = options.resultRootId;
  }

  async readList(
    request: MatchExplorerListRequest,
  ): Promise<Result<MatchExplorerList, readonly AdminError[]>> {
    const directory = this.#resolve();
    if (isErr(directory)) return directory;
    return readMatchExplorerList(directory.value, request);
  }

  async readView(
    request: MatchExplorerViewRequest,
  ): Promise<Result<MatchExplorerView, readonly AdminError[]>> {
    const directory = this.#resolve();
    if (isErr(directory)) return directory;
    return readMatchExplorerView(directory.value, request);
  }

  async readEventTimeline(
    request: MatchExplorerEventTimelineRequest,
  ): Promise<Result<MatchExplorerEventTimeline, readonly AdminError[]>> {
    const directory = this.#resolve();
    if (isErr(directory)) return directory;
    return readMatchExplorerEventTimeline(directory.value, request);
  }

  #resolve(): Result<string, readonly AdminError[]> {
    const configured = this.#roots.resultRoots.get(this.#resultRootId);
    if (configured === undefined) {
      return err([
        adminError(
          'admin/unsafe_result_reference',
          `No result root named \`${this.#resultRootId}\` is configured, so the Match Explorer cannot be read.`,
          { path: 'resultRootId', context: { rootId: this.#resultRootId } },
        ),
      ]);
    }
    return ok(configured);
  }
}

/**
 * `admin/no_result`'s own description already covers this case in as many
 * words: "the reference no longer resolves" is one of the ways a client can
 * do exactly one thing about it — show the match without its view. `matchId`
 * is an opaque identifier (`explorerMatchIdSchema`), never a filesystem path,
 * so echoing it back in context carries nothing ADR 0023 §5 forbids.
 */
function matchNotFound(matchId: string): AdminError {
  return adminError(
    'admin/no_result',
    `No live match with id \`${matchId}\` was found in the configured result root, so the Match Explorer cannot show it.`,
    { path: 'matchId', context: { matchId } },
  );
}

function builtBadly(what: string): AdminError {
  return adminError(
    'admin/schema',
    'This service built a Match Explorer view it could not validate against its own contract, ' +
      'so it was not sent. This is a defect in the build rather than a problem with the underlying matches.',
    { context: { view: what } },
  );
}
