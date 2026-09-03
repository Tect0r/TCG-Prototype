import { z } from 'zod';
import { gameEventSchema, type GameEvent, type LoggedAction } from '@tcg/rules-engine';

/**
 * The event/turn-window contract (M08.23B): the last meaningful stretch of a
 * match's own event log, the turn boundaries either side of the capture
 * instant, and how far back each retained event sits — in events, actions and
 * turns — from that instant.
 *
 * Every field here is purely structural, derived from `MatchState.log`,
 * `MatchState.actionLog`, `MatchState.turn` and `MatchState.sequence` with no
 * new engine concept invented: `sequence` is already a contiguous per-event
 * counter (`context.ts`'s `emit()` increments it by exactly one per event,
 * never skipping), `turn_started` events already mark every turn boundary,
 * and `LoggedAction.sequenceAfter` already correlates an action to the
 * sequence it produced. This module only reads those facts; it assigns no
 * cause and flags nothing as "the reason" a player conceded — that judgment
 * belongs to a human reviewing exposure-adjusted aggregates later (M08.24D),
 * never to this derivation.
 */

/** How many of the most recent log events a pre-action capture retains. */
export const LIVE_MATCH_RECENT_EVENT_WINDOW_SIZE = 30;

/** One turn's span on the match's own sequence counter. */
export const liveMatchTurnWindowSchema = z
  .strictObject({
    turn: z.number().int().min(0),
    /** The sequence of that turn's own `turn_started` event, or 0 for turn 0 (pre-game). */
    startSequence: z.number().int().min(0),
    /** The sequence this window was closed off at — not necessarily the turn's last event. */
    endSequence: z.number().int().min(0),
  })
  .refine((window) => window.startSequence <= window.endSequence, {
    message: 'A turn window must not end before it starts.',
  });
export type LiveMatchTurnWindow = z.infer<typeof liveMatchTurnWindowSchema>;

/** How far one retained event sits from the capture instant, along three different axes. */
export const liveMatchEventDistanceSchema = z.strictObject({
  sequence: z.number().int().min(0),
  eventsAgo: z.number().int().min(0),
  actionsAgo: z.number().int().min(0),
  turnsAgo: z.number().int().min(0),
});
export type LiveMatchEventDistance = z.infer<typeof liveMatchEventDistanceSchema>;

/** The recent-event chain, its per-event distances and the two turn windows around a capture instant. */
export const liveMatchEventWindowSchema = z.strictObject({
  recentEvents: z.array(gameEventSchema),
  eventDistances: z.array(liveMatchEventDistanceSchema),
  currentTurnWindow: liveMatchTurnWindowSchema,
  previousTurnWindow: liveMatchTurnWindowSchema.nullable(),
});
export type LiveMatchEventWindow = z.infer<typeof liveMatchEventWindowSchema>;

/**
 * The sequence of `turn`'s own `turn_started` event, 0 when `turn` is 0
 * (pre-game), or `null` when `turn` is 1 or higher but its `turn_started`
 * has not been logged yet — reachable at a capture instant paused inside
 * `beginTurn`'s Ready Step (`flow.ts`'s `runReadyStep`, e.g. a `replace_ready`
 * with a cost, such as `temporal_anchor`): `MatchState.turn` is set before
 * `runReadyStep` runs, but `turn_started` is only emitted once it finishes,
 * so a `pendingChoice` can be open in a turn the log does not yet record the
 * start of. Distinct from 0 so a caller never mistakes "not yet started" for
 * "started at sequence 0."
 */
function turnStartSequence(log: readonly GameEvent[], turn: number): number | null {
  if (turn <= 0) return 0;
  for (const event of log) {
    if (event.type === 'turn_started' && event.turn === turn) return event.sequence;
  }
  return null;
}

/** The highest turn number whose `turn_started` event has a sequence `<= sequence`. */
function turnOfSequence(log: readonly GameEvent[], sequence: number): number {
  let turn = 0;
  for (const event of log) {
    if (event.sequence > sequence) break;
    if (event.type === 'turn_started') turn = event.turn;
  }
  return turn;
}

/**
 * Derives the event/turn window for a capture taken at `turn`/`sequence` over
 * a match's full `log` and `actionLog`. Pure: no clock, no lobby reference, no
 * side effect, the same shape `capturePreActionState` (M08.23A) established.
 */
export function deriveLiveMatchEventWindow(input: {
  readonly log: readonly GameEvent[];
  readonly actionLog: readonly LoggedAction[];
  readonly turn: number;
  readonly sequence: number;
}): LiveMatchEventWindow {
  const { log, actionLog, turn, sequence } = input;

  // `?? sequence`: when this turn's own `turn_started` has not been logged
  // yet (see `turnStartSequence`'s doc comment), there is no real boundary
  // sequence to report, so the current window collapses to "nothing of this
  // turn logged so far" rather than deriving a startSequence past the log's
  // own end.
  const currentStart = turnStartSequence(log, turn) ?? sequence;
  const currentTurnWindow: LiveMatchTurnWindow = {
    turn,
    startSequence: currentStart,
    endSequence: sequence,
  };
  const previousTurnWindow: LiveMatchTurnWindow | null =
    turn > 1
      ? {
          turn: turn - 1,
          // Always found in practice: turn only ever reaches turn - 1 + 1
          // after turn - 1's own `turn_started` has already been logged. The
          // fallback is defensive, not a documented case.
          startSequence: turnStartSequence(log, turn - 1) ?? 0,
          // Tied to `currentStart` by construction (not independently
          // clamped) so `liveMatchPreActionCaptureSchema`'s contiguity check
          // — previous window's end + 1 equals the current window's start —
          // holds unconditionally, in the fallback branch as much as the
          // normal one.
          endSequence: currentStart - 1,
        }
      : null;

  const recentEvents = log.slice(-LIVE_MATCH_RECENT_EVENT_WINDOW_SIZE);
  const eventDistances: LiveMatchEventDistance[] = recentEvents.map((event) => ({
    sequence: event.sequence,
    eventsAgo: sequence - event.sequence,
    actionsAgo: actionLog.filter((action) => action.sequenceAfter > event.sequence).length,
    turnsAgo: turn - turnOfSequence(log, event.sequence),
  }));

  return { recentEvents, eventDistances, currentTurnWindow, previousTurnWindow };
}
