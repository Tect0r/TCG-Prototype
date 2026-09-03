import type { CardId } from '@tcg/card-data';
import type { DeckEntry } from '@tcg/deck';
import {
  LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION,
  deriveLiveMatchEventWindow,
  freezeLiveMatchDeckSnapshot,
  liveMatchPreActionCaptureSchema,
  type LiveMatchPreActionCapture,
} from '@tcg/match-telemetry';
import { CURRENT_VERSIONS } from '@tcg/protocol';
import type { MatchState, PlayerId } from '@tcg/rules-engine';

/** The conceding player's own deck, as far as this capture needs it. */
export interface PreActionCaptureDeckInput {
  readonly commanderId: CardId | null;
  readonly cards: readonly DeckEntry[];
}

/**
 * Builds one player's pre-action capture (M08.23A, widened M08.23B) from a
 * live `MatchState`.
 *
 * A pure function over the live `state`, the conceding `playerId` and the
 * caller-supplied build/deck facts the lobby already holds — the same
 * no-clock/no-lobby-reference/no-side-effect shape `buildLiveMatchRecord`
 * (`./live-match-record.ts`) established for the finished-match envelope.
 * `match-server.ts` calls this at the two points that can produce a concede —
 * `submit_action` with an explicit `concede`, and `leave()` — immediately
 * before `applyAction`, so the engine's own concede resolution (which clears
 * `pendingChoice`, ends `combat` and closes any open `reactionWindow`) never
 * has a chance to overwrite what it captures.
 *
 * Returns `null`, not a thrown error, when the conceding seat's deck never
 * resolved a Commander — the same clean "nothing to record" case
 * `buildLiveMatchRecord` treats a missing `commanderId` as, since neither a
 * deck snapshot nor its provenance can be captured without one. This should
 * not happen for a seat that reached a live match, but the type of
 * `SeatBase.deck` (`SavedDeck | null`, `commanderId` itself nullable before a
 * format resolves one) does not rule it out, so the schema-validating parse
 * below is not the only thing standing between a null Commander and a thrown
 * error.
 *
 * `liveMatchPreActionCaptureSchema.parse` checks the contract's own
 * invariants rather than trusting the object built here by hand.
 */
export function capturePreActionState(
  state: MatchState,
  playerId: PlayerId,
  context: { readonly softwareVersion: string; readonly deck: PreActionCaptureDeckInput },
): LiveMatchPreActionCapture | null {
  if (context.deck.commanderId === null) return null;

  const eventWindow = deriveLiveMatchEventWindow({
    log: state.log,
    actionLog: state.actionLog,
    turn: state.turn,
    sequence: state.sequence,
  });

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
    eventWindow,
    provenance: {
      softwareVersion: context.softwareVersion,
      contentVersion: CURRENT_VERSIONS.cardSchema,
      rulesVersion: state.rulesVersion,
    },
    deck: freezeLiveMatchDeckSnapshot({
      commanderId: context.deck.commanderId,
      cards: context.deck.cards,
    }),
  });
}
