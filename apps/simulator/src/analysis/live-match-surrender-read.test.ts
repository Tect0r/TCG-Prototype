import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  freezeLiveMatchDeckSnapshot,
  type LiveMatchEventWindow,
  type LiveMatchPreActionCapture,
} from '@tcg/match-telemetry';
import type { CombatState } from '@tcg/rules-engine';
import { readLiveMatchPreActionCaptures } from './live-match-surrender-read.js';

/**
 * M08.25D — the tolerant reader for `LiveMatchFileStore`'s optional
 * `pre-action-capture.json` (`apps/multiplayer-server/src/live-match-store.ts`):
 * `<rootDirectory>/<matchId>/pre-action-capture.json`, written only for a
 * voluntary surrender.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tcg-sim-live-match-surrender-read-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const eventCause = { actionType: null, sourceInstanceId: null, resolutionId: null };

const idleCombat: CombatState = {
  attacks: [],
  awaitingDefenders: [],
  submissions: [],
  blocks: [],
  combatantInstanceIds: [],
  damageResolved: false,
};

function eventWindow(): LiveMatchEventWindow {
  return {
    recentEvents: [
      { type: 'turn_started', sequence: 12, cause: eventCause, playerId: 'player_1', turn: 3 },
    ],
    eventDistances: [{ sequence: 12, eventsAgo: 0, actionsAgo: 0, turnsAgo: 0 }],
    currentTurnWindow: { turn: 3, startSequence: 8, endSequence: 12 },
    previousTurnWindow: { turn: 2, startSequence: 5, endSequence: 7 },
  };
}

function capture(
  matchId: string,
  overrides: Partial<LiveMatchPreActionCapture> = {},
): LiveMatchPreActionCapture {
  return {
    schemaVersion: 3,
    matchId,
    playerId: 'player_1',
    origin: 'concede_action',
    turn: 3,
    phase: 'main_1',
    activePlayerId: 'player_1',
    sequence: 12,
    pendingChoice: null,
    combat: idleCombat,
    reactionWindow: null,
    eventWindow: eventWindow(),
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    deck: freezeLiveMatchDeckSnapshot({
      commanderId: 'prototype_commander_blue',
      cards: [{ cardId: 'prototype_drone', quantity: 40 }],
    }),
    ...overrides,
  };
}

function writeCaptureFile(matchId: string, contents: string): void {
  const directory = join(root, matchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'pre-action-capture.json'), contents, 'utf8');
}

describe('an empty or missing root', () => {
  it('reads nothing from a nonexistent directory rather than throwing', () => {
    const result = readLiveMatchPreActionCaptures(join(root, 'does-not-exist'));
    expect(result).toEqual({ captures: [], skipped: [] });
  });

  it('reads nothing from an empty directory', () => {
    const result = readLiveMatchPreActionCaptures(root);
    expect(result).toEqual({ captures: [], skipped: [] });
  });
});

describe('the happy path', () => {
  it("reads every match directory's pre-action-capture.json", () => {
    writeCaptureFile('match_a', JSON.stringify(capture('match_a')));
    writeCaptureFile('match_b', JSON.stringify(capture('match_b', { playerId: 'player_2' })));

    const result = readLiveMatchPreActionCaptures(root);
    expect(result.skipped).toEqual([]);
    expect(result.captures.map((entry) => entry.matchId).sort()).toEqual(['match_a', 'match_b']);
  });
});

describe('a match that never surrendered', () => {
  it('skips a match directory with no pre-action-capture.json, silently — not a reported skip', () => {
    mkdirSync(join(root, 'match_no_surrender'), { recursive: true });
    writeCaptureFile('match_surrendered', JSON.stringify(capture('match_surrendered')));

    const result = readLiveMatchPreActionCaptures(root);
    expect(result.captures).toHaveLength(1);
    expect(result.skipped).toEqual([]);
  });
});

describe('a damaged capture', () => {
  it('reports unparseable JSON, likely from a truncated write', () => {
    writeCaptureFile('match_truncated', '{"matchId": "match_truncated", "pl');

    const result = readLiveMatchPreActionCaptures(root);
    expect(result.captures).toEqual([]);
    expect(result.skipped).toEqual([
      { matchId: 'match_truncated', reason: 'unparseable JSON (likely a truncated write)' },
    ]);
  });

  it('reports a schema version this build cannot read', () => {
    writeCaptureFile(
      'match_future',
      JSON.stringify(capture('match_future', { schemaVersion: 99 as never })),
    );

    const result = readLiveMatchPreActionCaptures(root);
    expect(result.captures).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.matchId).toBe('match_future');
  });

  it('reports a document that fails schema validation, with a reason from the parser', () => {
    writeCaptureFile(
      'match_invalid',
      JSON.stringify({ schemaVersion: 3, matchId: 'match_invalid' }),
    );

    const result = readLiveMatchPreActionCaptures(root);
    expect(result.captures).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.matchId).toBe('match_invalid');
    expect(result.skipped[0]?.reason.length).toBeGreaterThan(0);
  });

  it('keeps reading past a damaged match rather than aborting the whole read', () => {
    writeCaptureFile('match_bad', 'not json');
    writeCaptureFile('match_good', JSON.stringify(capture('match_good')));

    const result = readLiveMatchPreActionCaptures(root);
    expect(result.captures.map((entry) => entry.matchId)).toEqual(['match_good']);
    expect(result.skipped.map((entry) => entry.matchId)).toEqual(['match_bad']);
  });
});
