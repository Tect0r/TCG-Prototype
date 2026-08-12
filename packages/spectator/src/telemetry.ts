import type { CardDatabase } from '@tcg/card-data';
import { collectBoardTelemetry, type BoardSeatTelemetry } from '@tcg/board-telemetry';
import type { GameEvent, MatchState, PlayerId, RulesConfig } from '@tcg/rules-engine';
import {
  VALID_PROVENANCE,
  type SpectatorDecision,
  type SpectatorProvenance,
  type SpectatorSeat,
  type SpectatorSeatTelemetry,
  type SpectatorTelemetry,
} from './schema.js';

/**
 * The spectator's view of the shared board telemetry (M04.1).
 *
 * Every measurement is `@tcg/board-telemetry`'s, taken by replaying the event
 * log rather than by inspecting the final board — the difference between "how
 * many units did this seat ever have" and "how many does it have now", and the
 * first is the question the unlimited battlefield has to be judged on. This file
 * is what a *watched* match adds on top: a leaderboard and the provenance flag.
 *
 * Since M04.2 it adds nothing else. The summary screen's stall wording used to be
 * decided here, from a three-round threshold over silence; the shared schema now
 * carries the attack-opportunity evidence and leaves the verdict
 * `'undetermined'` until Q43, and a watched match reads the same undetermined
 * classification a batch does.
 *
 * Playback timing is deliberately absent from all of it. A delay the viewer
 * chose must never reach a number that describes the match.
 */

export function collectTelemetry(
  finalState: MatchState,
  events: readonly GameEvent[],
  decisions: readonly SpectatorDecision[],
  database: CardDatabase,
  config: RulesConfig,
  seats: readonly SpectatorSeat[],
  /** Provenance of the match these numbers describe. See `schema.ts` (M01.2). */
  provenance: SpectatorProvenance = VALID_PROVENANCE,
): SpectatorTelemetry {
  const board = collectBoardTelemetry({
    finalState,
    events,
    // Each recorded decision is one accepted action, and it already carries the
    // turn it was taken on.
    actionTurns: decisions.map((decision) => decision.turn),
    database,
    config,
    seats: seats.map((seat) => ({
      playerId: seat.playerId,
      seatIndex: seat.seatIndex,
      commanderId: seat.commanderId,
    })),
  });

  const placements = rankSeats(finalState, seats, board.seats);
  const seatTelemetry: SpectatorSeatTelemetry[] = board.seats.map((seat) => ({
    ...seat,
    placement: placements.get(seat.playerId) ?? seats.length,
  }));

  return {
    ...board,
    seats: seatTelemetry,
    resultsValid: provenance.resultsValid,
  };
}

/**
 * Final placement: the winner is first, then the seats that survived longest.
 *
 * A seat eliminated later placed better than one eliminated earlier, which is
 * the only ordering a free-for-all supports without inventing a scoring system.
 */
function rankSeats(
  state: MatchState,
  seats: readonly SpectatorSeat[],
  board: readonly BoardSeatTelemetry[],
): Map<PlayerId, number> {
  const exits = new Map(board.map((seat) => [seat.playerId, seat.eliminatedAtSequence]));
  const ordered = [...seats].sort((left, right) => {
    const leftWon = state.result?.winnerId === left.playerId;
    const rightWon = state.result?.winnerId === right.playerId;
    if (leftWon !== rightWon) return leftWon ? -1 : 1;

    const leftOut = exits.get(left.playerId);
    const rightOut = exits.get(right.playerId);
    if (leftOut === rightOut) return left.seatIndex - right.seatIndex;
    if (leftOut === null || leftOut === undefined) return -1;
    if (rightOut === null || rightOut === undefined) return 1;
    return rightOut - leftOut;
  });

  return new Map(ordered.map((seat, index) => [seat.playerId, index + 1]));
}
