import {
  LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION,
  liveMatchPreActionCaptureSchema,
  type LiveMatchPreActionCapture,
} from '@tcg/match-telemetry';
import type { MatchState, PlayerId } from '@tcg/rules-engine';

/**
 * Builds one player's pre-action capture (M08.23A) from a live `MatchState`.
 *
 * A pure function over the live `state` and the conceding `playerId`, the
 * same no-clock/no-lobby-reference/no-side-effect shape `buildLiveMatchRecord`
 * (`./live-match-record.ts`) established for the finished-match envelope.
 * `match-server.ts` calls this at the two points that can produce a concede —
 * `submit_action` with an explicit `concede`, and `leave()` — immediately
 * before `applyAction`, so the engine's own concede resolution (which clears
 * `pendingChoice`, ends `combat` and closes any open `reactionWindow`) never
 * has a chance to overwrite what it captures.
 *
 * `liveMatchPreActionCaptureSchema.parse` checks the contract's own
 * invariants rather than trusting the object built here by hand.
 */
export function capturePreActionState(
  state: MatchState,
  playerId: PlayerId,
): LiveMatchPreActionCapture {
  return liveMatchPreActionCaptureSchema.parse({
    schemaVersion: LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION,
    matchId: state.matchId,
    playerId,
    turn: state.turn,
    phase: state.phase,
    activePlayerId: state.activePlayerId,
    sequence: state.sequence,
    pendingChoice: state.pendingChoice,
    combat: state.combat,
    reactionWindow: state.reactionWindow,
  });
}
