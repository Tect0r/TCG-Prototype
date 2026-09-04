import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';
import { readLiveMatchEnvelopes } from './live-match-read.js';

/**
 * M08.25B — the tolerant reader for `LiveMatchFileStore`'s on-disk layout
 * (`apps/multiplayer-server/src/live-match-store.ts`):
 * `<rootDirectory>/<matchId>/envelope.json`.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tcg-sim-live-match-read-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const winOutcome: LiveMatchEnvelope['outcome'] = {
  outcome: 'win',
  winnerId: 'player_1',
  loserIds: ['player_2'],
  reason: 'health_depleted',
  finalTurn: 10,
  finalSequence: 200,
  diagnostics: null,
};

function envelope(matchId: string, overrides: Partial<LiveMatchEnvelope> = {}): LiveMatchEnvelope {
  return {
    schemaVersion: 3,
    matchId,
    source: 'human_human',
    formatId: 'precon_wave_1',
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    seats: [
      {
        seatIndex: 0,
        playerId: 'player_1',
        kind: 'human',
        deck: freezeLiveMatchDeckSnapshot({
          commanderId: 'prototype_commander_blue',
          cards: [{ cardId: 'prototype_drone', quantity: 40 }],
        }),
      },
      {
        seatIndex: 1,
        playerId: 'player_2',
        kind: 'human',
        deck: freezeLiveMatchDeckSnapshot({
          commanderId: 'prototype_commander_red',
          cards: [{ cardId: 'prototype_scout', quantity: 40 }],
        }),
      },
    ],
    actionCount: 40,
    terminationOrigin: 'rules_victory',
    outcome: winOutcome,
    ...overrides,
  };
}

function writeMatchDirectory(matchId: string, contents: string): void {
  const directory = join(root, matchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'envelope.json'), contents, 'utf8');
}

describe('an empty or missing root', () => {
  it('reads nothing from a nonexistent directory rather than throwing', () => {
    const result = readLiveMatchEnvelopes(join(root, 'does-not-exist'));
    expect(result).toEqual({ matches: [], skipped: [] });
  });

  it('reads nothing from an empty directory', () => {
    const result = readLiveMatchEnvelopes(root);
    expect(result).toEqual({ matches: [], skipped: [] });
  });
});

describe('the happy path', () => {
  it('reads every match directory’s envelope.json', () => {
    writeMatchDirectory('match_a', JSON.stringify(envelope('match_a')));
    writeMatchDirectory(
      'match_b',
      JSON.stringify(
        envelope('match_b', {
          source: 'ai_ai',
          seats: [
            {
              seatIndex: 0,
              playerId: 'player_1',
              kind: 'bot',
              deck: freezeLiveMatchDeckSnapshot({
                commanderId: 'prototype_commander_blue',
                cards: [{ cardId: 'prototype_drone', quantity: 40 }],
              }),
            },
            {
              seatIndex: 1,
              playerId: 'player_2',
              kind: 'bot',
              deck: freezeLiveMatchDeckSnapshot({
                commanderId: 'prototype_commander_red',
                cards: [{ cardId: 'prototype_scout', quantity: 40 }],
              }),
            },
          ],
        }),
      ),
    );

    const result = readLiveMatchEnvelopes(root);
    expect(result.skipped).toEqual([]);
    expect(result.matches.map((match) => match.matchId).sort()).toEqual(['match_a', 'match_b']);
  });
});

describe('a damaged tail', () => {
  it('skips a match directory with no envelope.json', () => {
    mkdirSync(join(root, 'match_incomplete'), { recursive: true });
    writeMatchDirectory('match_good', JSON.stringify(envelope('match_good')));

    const result = readLiveMatchEnvelopes(root);
    expect(result.matches).toHaveLength(1);
    expect(result.skipped).toEqual([
      { matchId: 'match_incomplete', reason: 'no envelope.json in this match directory' },
    ]);
  });

  it('skips unparseable JSON, likely from a truncated write', () => {
    writeMatchDirectory('match_truncated', '{"matchId": "match_truncated", "sea');

    const result = readLiveMatchEnvelopes(root);
    expect(result.matches).toEqual([]);
    expect(result.skipped).toEqual([
      { matchId: 'match_truncated', reason: 'unparseable JSON (likely a truncated write)' },
    ]);
  });

  it('skips a schema version this build cannot read', () => {
    writeMatchDirectory(
      'match_future',
      JSON.stringify(envelope('match_future', { schemaVersion: 99 as never })),
    );

    const result = readLiveMatchEnvelopes(root);
    expect(result.matches).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.matchId).toBe('match_future');
  });

  it('skips a document that fails schema validation, with a reason from the parser', () => {
    writeMatchDirectory(
      'match_invalid',
      JSON.stringify({ schemaVersion: 3, matchId: 'match_invalid' }),
    );

    const result = readLiveMatchEnvelopes(root);
    expect(result.matches).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.matchId).toBe('match_invalid');
    expect(result.skipped[0]?.reason.length).toBeGreaterThan(0);
  });

  it('keeps reading past a damaged match rather than aborting the whole read', () => {
    writeMatchDirectory('match_bad', 'not json');
    writeMatchDirectory('match_good', JSON.stringify(envelope('match_good')));

    const result = readLiveMatchEnvelopes(root);
    expect(result.matches.map((match) => match.matchId)).toEqual(['match_good']);
    expect(result.skipped.map((entry) => entry.matchId)).toEqual(['match_bad']);
  });
});
