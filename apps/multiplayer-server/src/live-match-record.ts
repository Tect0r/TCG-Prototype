import type { CardId } from '@tcg/card-data';
import type { DeckEntry } from '@tcg/deck';
import {
  freezeLiveMatchDeckSnapshot,
  liveMatchEnvelopeSchema,
  liveMatchSourceOf,
  LIVE_MATCH_ENVELOPE_SCHEMA_VERSION,
  LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION,
  LIVE_MATCH_REPLAY_SCHEMA_VERSION,
  type LiveMatchEnvelope,
  type LiveMatchParticipantKind,
  type LiveMatchPreActionCapture,
  type LiveMatchRawEventArtifact,
  type LiveMatchReplayArtifact,
  type LiveMatchRetentionConfig,
  type LiveMatchTerminationOrigin,
} from '@tcg/match-telemetry';
import { CURRENT_VERSIONS } from '@tcg/protocol';
import type { MatchEndReason, MatchState, PlayerId } from '@tcg/rules-engine';
import type { LiveMatchRecord } from './live-match-sink.js';

/**
 * Builds a completed match's canonical `LiveMatchRecord` (M08.22C).
 *
 * A pure function over the finished `MatchState` and the per-seat facts the
 * lobby already holds, in the shape `buildBotMatchSummary`
 * (`./bot-match-summary.ts`) established: no clock, no lobby reference, no
 * side effect. `publishLiveMatchRecord` in `match-server.ts` is the one
 * caller, and the whole reason this is separate from that method is so the
 * envelope's own invariants (`liveMatchEnvelopeSchema`'s `superRefine`) are
 * checked by the schema rather than re-derived by hand here.
 *
 * Returns `null`, not a thrown error, for every case that is a clean "nothing
 * to record" rather than a bug: a match outside this envelope's two-seat scope
 * (`IMPLEMENTATION_PLAN.md`'s open 3–4 seat note), or a seat whose deck never
 * resolved a Commander (the same guard `revealBotDecks` already applies to a
 * bot seat's deck). `publishLiveMatchRecord` treats `null` exactly like
 * `publishPacingSummary` treats "no bot seats": nothing published, no failure
 * recorded.
 */

/** One seat's provenance-relevant facts, as the lobby already holds them. */
export interface LiveMatchRecordSeatInput {
  readonly playerId: PlayerId;
  readonly kind: LiveMatchParticipantKind;
  readonly deck: {
    readonly commanderId: CardId | null;
    readonly cards: readonly DeckEntry[];
  };
}

export interface LiveMatchRecordInput {
  /** The finished match. Must be `status === 'complete'` with a non-null `result`. */
  readonly state: MatchState;
  readonly formatId: string;
  readonly softwareVersion: string;
  readonly seats: readonly LiveMatchRecordSeatInput[];
  readonly terminationOrigin: LiveMatchTerminationOrigin;
  readonly retention: LiveMatchRetentionConfig;
  /**
   * The lobby's own capture from the instant of concede/leave, if any. Never
   * read for a non-voluntary termination, and attached to the built record
   * only when `retention.preActionCapture` is configured on — a deployment
   * that leaves the dial off never gets one persisted, regardless of what the
   * lobby captured (M08.23D).
   */
  readonly preActionCapture: LiveMatchPreActionCapture | null;
}

/**
 * The one termination origin a finished `MatchResult` cannot resolve by
 * itself: `concede` is the same engine action whether it arrived from an
 * explicit `concede` action or from `leave()` turning a disconnect into a
 * concession (`schema.ts`'s doc comment on `LIVE_MATCH_TERMINATION_ORIGINS`).
 * `concedeOrigin` is the fact the caller observed at the instant a *human's*
 * concede was submitted through `submit_action` or `leave()`. It is `null`
 * both when the match ended some other way (this function never reads it
 * then) and when a bot conceded through its own decision path
 * (`applyBotAction`, which never sets it) — the latter defaults to
 * `'concede_action'`, correctly: a bot's concede is exactly as explicit as a
 * human's button press, never a disconnect.
 */
export function liveMatchTerminationOriginFor(
  reason: MatchEndReason,
  concedeOrigin: 'concede_action' | 'concede_leave' | null,
): LiveMatchTerminationOrigin {
  switch (reason) {
    case 'concede':
      return concedeOrigin ?? 'concede_action';
    case 'timeout':
      return 'disconnect_timeout';
    case 'health_depleted':
    case 'empty_deck':
    case 'simultaneous_loss':
      return 'rules_victory';
    case 'engine_error':
      return 'server_failure';
  }
}

/**
 * Attaches the lobby's pre-action capture to a voluntary termination's
 * `LiveMatchRecord` (M08.23C), gated on facts already immutable by the time
 * this runs rather than any new dedup state — the same idempotence-via-pure-
 * path-function shape `LiveMatchFileStore` (`./live-match-store.ts`) already
 * uses for a duplicate publish. `capture.origin` only ever holds one of the
 * two voluntary values, so requiring it to equal `envelope.terminationOrigin`
 * both picks the right one of the two concessions apart and, as a side
 * effect, proves the termination was voluntary at all — `disconnect_timeout`,
 * `rules_victory`, `server_failure` and `abandoned_unrecordable` can never
 * satisfy it. `matchId` guards against a stale capture surviving into a
 * different match on a reused lobby, and the captured player must be one of
 * this outcome's losers, since a pre-action capture is only ever taken for
 * whoever conceded or left.
 *
 * This proves voluntariness and freshness; it does not decide whether the
 * capture should be kept at all — that is the caller's `retention.preActionCapture`
 * gate below (M08.23D), since the most sensitive artifact this package
 * defines must default to discarded like every other retention tier.
 */
function voluntaryPreActionCaptureFor(
  envelope: Pick<LiveMatchEnvelope, 'matchId' | 'terminationOrigin' | 'outcome'>,
  capture: LiveMatchPreActionCapture | null,
): LiveMatchPreActionCapture | null {
  if (capture === null) return null;
  if (capture.origin !== envelope.terminationOrigin) return null;
  if (capture.matchId !== envelope.matchId) return null;
  if (envelope.outcome === null || !envelope.outcome.loserIds.includes(capture.playerId)) return null;
  return capture;
}

export function buildLiveMatchRecord(input: LiveMatchRecordInput): LiveMatchRecord | null {
  const { state } = input;
  if (state.status !== 'complete' || state.result === null) return null;
  // `liveMatchEnvelopeSchema` covers exactly two seats (M08.21A). A 3- or
  // 4-seat free-for-all is real and startable, but classifying its `source`
  // is unscoped — recording nothing for it is the deliberate boundary, not a
  // gap this slice papers over.
  if (state.seatOrder.length !== 2) return null;

  const bySeat = new Map(input.seats.map((seat) => [seat.playerId, seat]));
  const ordered = state.seatOrder.map((playerId) => bySeat.get(playerId));
  const [seatA, seatB] = ordered;
  if (!seatA || !seatB) return null;
  if (seatA.deck.commanderId === null || seatB.deck.commanderId === null) return null;

  const seats = [
    {
      seatIndex: 0 as const,
      playerId: seatA.playerId,
      kind: seatA.kind,
      deck: freezeLiveMatchDeckSnapshot({
        commanderId: seatA.deck.commanderId,
        cards: seatA.deck.cards,
      }),
    },
    {
      seatIndex: 1 as const,
      playerId: seatB.playerId,
      kind: seatB.kind,
      deck: freezeLiveMatchDeckSnapshot({
        commanderId: seatB.deck.commanderId,
        cards: seatB.deck.cards,
      }),
    },
  ];

  const envelope = liveMatchEnvelopeSchema.parse({
    schemaVersion: LIVE_MATCH_ENVELOPE_SCHEMA_VERSION,
    matchId: state.matchId,
    source: liveMatchSourceOf([seatA.kind, seatB.kind]),
    formatId: input.formatId,
    provenance: {
      softwareVersion: input.softwareVersion,
      contentVersion: CURRENT_VERSIONS.cardSchema,
      rulesVersion: state.rulesVersion,
    },
    seats,
    actionCount: state.actionLog.length,
    terminationOrigin: input.terminationOrigin,
    outcome: state.result,
  });

  const rawEvent: LiveMatchRawEventArtifact | null = input.retention.rawEvent
    ? {
        schemaVersion: LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION,
        matchId: state.matchId,
        log: state.log,
        actionLog: state.actionLog,
      }
    : null;

  const replay: LiveMatchReplayArtifact | null = input.retention.replay
    ? {
        schemaVersion: LIVE_MATCH_REPLAY_SCHEMA_VERSION,
        matchId: state.matchId,
        seed: state.seed,
        actionLog: state.actionLog,
      }
    : null;

  const preActionCapture = input.retention.preActionCapture
    ? voluntaryPreActionCaptureFor(envelope, input.preActionCapture)
    : null;

  return { envelope, rawEvent, replay, preActionCapture };
}
