import { describe, expect, it } from 'vitest';
import type { GameEvent, LoggedAction } from '@tcg/rules-engine';
import { LIVE_MATCH_RECENT_EVENT_WINDOW_SIZE, deriveLiveMatchEventWindow } from './event-window.js';

/**
 * The event/turn-window derivation (M08.23B): pure, so every case here is a
 * hand-built `log`/`actionLog` fixture rather than a live match. No schema
 * round trip here — that lives in `pre-action-capture.test.ts`, which checks
 * the widened contract's own cross-field invariants against this function's
 * output.
 */

const cause = { actionType: null, sourceInstanceId: null, resolutionId: null };

function turnStarted(sequence: number, turn: number): GameEvent {
  return { type: 'turn_started', sequence, cause, playerId: 'player_1', turn };
}

function phaseChanged(sequence: number): GameEvent {
  return { type: 'phase_changed', sequence, cause, from: 'main_1', to: 'declare_attackers' };
}

function loggedAction(index: number, sequenceAfter: number): LoggedAction {
  return { index, action: { type: 'pass_phase', playerId: 'player_1' }, sequenceAfter };
}

describe('deriveLiveMatchEventWindow', () => {
  it('reports an empty window before any turn has started', () => {
    const window = deriveLiveMatchEventWindow({ log: [], actionLog: [], turn: 0, sequence: 0 });
    expect(window.recentEvents).toEqual([]);
    expect(window.eventDistances).toEqual([]);
    expect(window.currentTurnWindow).toEqual({ turn: 0, startSequence: 0, endSequence: 0 });
    expect(window.previousTurnWindow).toBeNull();
  });

  it('has no previous turn window on turn 1', () => {
    const log = [turnStarted(1, 1), phaseChanged(2)];
    const window = deriveLiveMatchEventWindow({ log, actionLog: [], turn: 1, sequence: 2 });
    expect(window.currentTurnWindow).toEqual({ turn: 1, startSequence: 1, endSequence: 2 });
    expect(window.previousTurnWindow).toBeNull();
  });

  it('places the current and previous turn windows back to back on turn 2', () => {
    const log = [turnStarted(1, 1), phaseChanged(2), phaseChanged(3), turnStarted(4, 2), phaseChanged(5)];
    const window = deriveLiveMatchEventWindow({ log, actionLog: [], turn: 2, sequence: 5 });
    expect(window.currentTurnWindow).toEqual({ turn: 2, startSequence: 4, endSequence: 5 });
    expect(window.previousTurnWindow).toEqual({ turn: 1, startSequence: 1, endSequence: 3 });
  });

  it('computes events-ago, actions-ago and turns-ago for every retained event', () => {
    const log = [turnStarted(1, 1), phaseChanged(2), turnStarted(3, 2), phaseChanged(4)];
    const actionLog = [loggedAction(0, 2), loggedAction(1, 4)];
    const window = deriveLiveMatchEventWindow({ log, actionLog, turn: 2, sequence: 4 });

    expect(window.recentEvents).toEqual(log);
    expect(window.eventDistances).toEqual([
      { sequence: 1, eventsAgo: 3, actionsAgo: 2, turnsAgo: 1 },
      { sequence: 2, eventsAgo: 2, actionsAgo: 1, turnsAgo: 1 },
      { sequence: 3, eventsAgo: 1, actionsAgo: 1, turnsAgo: 0 },
      { sequence: 4, eventsAgo: 0, actionsAgo: 0, turnsAgo: 0 },
    ]);
  });

  it('retains only the most recent window-size events, always ending at the capture sequence', () => {
    const log: GameEvent[] = [turnStarted(1, 1)];
    for (let sequence = 2; sequence <= LIVE_MATCH_RECENT_EVENT_WINDOW_SIZE + 10; sequence += 1) {
      log.push(phaseChanged(sequence));
    }
    const lastSequence = log.at(-1)!.sequence;
    const window = deriveLiveMatchEventWindow({ log, actionLog: [], turn: 1, sequence: lastSequence });

    expect(window.recentEvents).toHaveLength(LIVE_MATCH_RECENT_EVENT_WINDOW_SIZE);
    expect(window.recentEvents.at(-1)?.sequence).toBe(lastSequence);
    expect(window.recentEvents[0]?.sequence).toBe(lastSequence - LIVE_MATCH_RECENT_EVENT_WINDOW_SIZE + 1);
  });
});
