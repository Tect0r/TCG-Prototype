import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';
import { readLiveMatchEnvelopes } from './live-match-read.js';
import { readLiveMatchPreActionCaptures } from './live-match-surrender-read.js';
import {
  DEFAULT_LIVE_MATCH_SNAPSHOT_LIMITS,
  LIVE_MATCH_SNAPSHOT_TTL_MS,
  openLiveMatchSnapshot,
  resetLiveMatchSnapshotCacheForTests,
} from './live-match-snapshot.js';

/**
 * M08.R10 — the single bounded, cached pass over a `LiveMatchFileStore` root
 * that `readLiveMatchEnvelopes`/`readLiveMatchPreActionCaptures` and every
 * Player Meta/explorer reader now share, replacing one independent
 * `readdirSync` sweep per reader per request.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tcg-sim-live-match-snapshot-'));
  resetLiveMatchSnapshotCacheForTests();
});

afterEach(() => {
  resetLiveMatchSnapshotCacheForTests();
  rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
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

function writeCaptureFile(matchId: string, contents: string): void {
  const directory = join(root, matchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'pre-action-capture.json'), contents, 'utf8');
}

describe('an empty or missing root', () => {
  it('returns the shared empty snapshot for a nonexistent root without throwing', () => {
    const snapshot = openLiveMatchSnapshot(join(root, 'does-not-exist'));
    expect(snapshot.matches).toEqual([]);
    expect(snapshot.skippedMatchCount).toBe(0);
    expect(snapshot.truncated).toBe(false);
  });
});

describe('one bounded pass per snapshot', () => {
  it('returns the same snapshot object for repeated reads against an unchanged root', () => {
    writeMatchDirectory('match_a', JSON.stringify(envelope('match_a')));

    const first = openLiveMatchSnapshot(root);
    const second = openLiveMatchSnapshot(root);

    expect(second).toBe(first);
  });

  it('serves every reader (envelopes, captures, a second direct call) from the one cached scan', () => {
    writeMatchDirectory('match_a', JSON.stringify(envelope('match_a')));
    writeCaptureFile('match_a', 'not json');

    // Simulates one dashboard load's several independent endpoint calls.
    const snapshot = openLiveMatchSnapshot(root);
    const envelopesResult = readLiveMatchEnvelopes(root);
    const capturesResult = readLiveMatchPreActionCaptures(root);
    const snapshotAgain = openLiveMatchSnapshot(root);

    expect(envelopesResult.matches).toBe(snapshot.matches);
    expect(capturesResult.skipped).toBe(snapshot.skippedCaptures);
    expect(snapshotAgain).toBe(snapshot);
  });

  it('rebuilds once a new match directory changes the root’s own mtime', () => {
    writeMatchDirectory('match_a', JSON.stringify(envelope('match_a')));
    const first = openLiveMatchSnapshot(root);
    expect(first.matches.map((match) => match.matchId)).toEqual(['match_a']);

    writeMatchDirectory('match_b', JSON.stringify(envelope('match_b')));
    const second = openLiveMatchSnapshot(root);

    expect(second).not.toBe(first);
    expect(second.matches.map((match) => match.matchId).sort()).toEqual(['match_a', 'match_b']);
  });

  it('resetLiveMatchSnapshotCacheForTests forces a fresh scan with equal but non-identical content', () => {
    writeMatchDirectory('match_a', JSON.stringify(envelope('match_a')));
    const first = openLiveMatchSnapshot(root);

    resetLiveMatchSnapshotCacheForTests();
    const second = openLiveMatchSnapshot(root);

    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it('keys the cache by limits as well as root, so a differently-limited call never inherits another call’s truncation (Tranche C review)', () => {
    for (let index = 0; index < 5; index += 1) {
      writeMatchDirectory(`match_${index}`, JSON.stringify(envelope(`match_${index}`)));
    }

    const boundedFirst = openLiveMatchSnapshot(root, { maxRecords: 1 });
    const defaultFirst = openLiveMatchSnapshot(root);
    expect(boundedFirst.truncated).toBe(true);
    expect(defaultFirst.truncated).toBe(false);

    // Repeating each call must return its own cached entry, not the other
    // limits value's — a shared `rootDirectory`-only key would otherwise let
    // whichever call ran second silently answer both.
    const boundedSecond = openLiveMatchSnapshot(root, { maxRecords: 1 });
    const defaultSecond = openLiveMatchSnapshot(root);
    expect(boundedSecond).toBe(boundedFirst);
    expect(defaultSecond).toBe(defaultFirst);
  });
});

describe('the TTL as a secondary safety net', () => {
  it('keeps serving the cached snapshot within the TTL even if a file changed without the root’s own mtime changing', () => {
    vi.useFakeTimers();
    writeMatchDirectory('match_a', JSON.stringify(envelope('match_a')));
    const first = openLiveMatchSnapshot(root);

    // Overwrites a file *inside* an already-existing match directory — this changes that
    // subdirectory's mtime, not the root's, so directory-mtime invalidation cannot see it.
    writeFileSync(
      join(root, 'match_a', 'envelope.json'),
      JSON.stringify(envelope('match_a', { actionCount: 999 })),
      'utf8',
    );
    const stillCached = openLiveMatchSnapshot(root);
    expect(stillCached).toBe(first);
    expect(stillCached.matches[0]?.actionCount).toBe(40);

    vi.advanceTimersByTime(LIVE_MATCH_SNAPSHOT_TTL_MS + 1);
    const rebuilt = openLiveMatchSnapshot(root);

    expect(rebuilt).not.toBe(first);
    expect(rebuilt.matches[0]?.actionCount).toBe(999);
  });
});

describe('bounded scanning', () => {
  it('stops at maxRecords and reports truncated', () => {
    for (let index = 0; index < 5; index += 1) {
      writeMatchDirectory(`match_${index}`, JSON.stringify(envelope(`match_${index}`)));
    }

    const snapshot = openLiveMatchSnapshot(root, { maxRecords: 3 });

    expect(snapshot.recordsScanned).toBe(3);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.matches.length).toBeLessThanOrEqual(3);
  });

  it('stops at maxBytes and reports truncated', () => {
    const firstEnvelope = JSON.stringify(envelope('match_0'));
    writeMatchDirectory('match_0', firstEnvelope);
    writeMatchDirectory('match_1', JSON.stringify(envelope('match_1')));

    const snapshot = openLiveMatchSnapshot(root, {
      maxBytes: Buffer.byteLength(firstEnvelope, 'utf8'),
    });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.matches.map((match) => match.matchId)).toEqual(['match_0']);
  });

  it('does not truncate a root within the configured limits', () => {
    for (let index = 0; index < 5; index += 1) {
      writeMatchDirectory(`match_${index}`, JSON.stringify(envelope(`match_${index}`)));
    }

    const snapshot = openLiveMatchSnapshot(root, { maxRecords: 50 });

    expect(snapshot.truncated).toBe(false);
    expect(snapshot.matches).toHaveLength(5);
  });
});

describe('bounded skip/health details, with exact true counts', () => {
  it('caps skippedMatches while skippedMatchCount stays the exact total', () => {
    const totalBad = 5;
    for (let index = 0; index < totalBad; index += 1) {
      writeMatchDirectory(`match_bad_${index}`, 'not json');
    }

    const snapshot = openLiveMatchSnapshot(root, { maxSkippedDetails: 2 });

    expect(snapshot.skippedMatchCount).toBe(totalBad);
    expect(snapshot.skippedMatches).toHaveLength(2);
  });

  it('caps skippedCaptures while skippedCaptureCount stays the exact total', () => {
    const totalBad = 5;
    for (let index = 0; index < totalBad; index += 1) {
      writeMatchDirectory(`match_${index}`, JSON.stringify(envelope(`match_${index}`)));
      writeCaptureFile(`match_${index}`, 'not json');
    }

    const snapshot = openLiveMatchSnapshot(root, { maxSkippedDetails: 2 });

    expect(snapshot.skippedCaptureCount).toBe(totalBad);
    expect(snapshot.skippedCaptures).toHaveLength(2);
  });

  it('never leaks a filesystem path in a skipped reason', () => {
    mkdirSync(join(root, 'match_incomplete'), { recursive: true });
    writeMatchDirectory('match_bad', 'not json');
    writeCaptureFile('match_capture_bad', 'not json');
    writeMatchDirectory('match_capture_bad', JSON.stringify(envelope('match_capture_bad')));

    const snapshot = openLiveMatchSnapshot(root);

    for (const entry of [...snapshot.skippedMatches, ...snapshot.skippedCaptures]) {
      expect(entry.reason).not.toContain(root);
      expect(entry.reason).not.toContain(':\\');
      expect(entry.reason).not.toContain('/');
    }
  });
});

describe('stable ordering', () => {
  it('returns matches sorted by matchId regardless of directory write order', () => {
    writeMatchDirectory('match_c', JSON.stringify(envelope('match_c')));
    writeMatchDirectory('match_a', JSON.stringify(envelope('match_a')));
    writeMatchDirectory('match_b', JSON.stringify(envelope('match_b')));

    const snapshot = openLiveMatchSnapshot(root);

    expect(snapshot.matches.map((match) => match.matchId)).toEqual([
      'match_a',
      'match_b',
      'match_c',
    ]);
  });
});

describe('a large synthetic fixture, within reasonable CI limits', () => {
  const matchCount = 500;

  beforeEach(() => {
    for (let index = 0; index < matchCount; index += 1) {
      const matchId = `match_${String(index).padStart(4, '0')}`;
      writeMatchDirectory(matchId, JSON.stringify(envelope(matchId)));
    }
    // A handful of damaged records mixed in, past the default DEFAULT_LIVE_MATCH_SNAPSHOT_LIMITS.maxSkippedDetails.
    for (let index = 0; index < 3; index += 1) {
      writeMatchDirectory(`match_corrupt_${index}`, 'not json');
    }
  });

  it('scans the whole root once, deterministically ordered, well under the configured limits', () => {
    const snapshot = openLiveMatchSnapshot(root);

    expect(snapshot.truncated).toBe(false);
    expect(snapshot.matches).toHaveLength(matchCount);
    expect(snapshot.skippedMatchCount).toBe(3);
    expect(snapshot.recordsScanned).toBeLessThanOrEqual(
      DEFAULT_LIVE_MATCH_SNAPSHOT_LIMITS.maxRecords,
    );

    const matchIds = snapshot.matches.map((match) => match.matchId);
    expect(matchIds).toEqual([...matchIds].sort());
  });

  it('serves an entire simulated dashboard load — several independent reader calls — from one cached scan', () => {
    // Freezes `Date.now()` for this test only (the file's `afterEach` always
    // restores real timers): five reader calls over a 500-match fixture is
    // real synchronous I/O, and under a heavily loaded machine — every
    // workspace's suite running at once, as `npm run verify` does — that can
    // take long enough in wall-clock time to cross `LIVE_MATCH_SNAPSHOT_TTL_MS`
    // between calls, which would make this cache-identity assertion flake on
    // something this test never means to exercise (the TTL itself has its
    // own coverage above).
    vi.useFakeTimers();
    const firstLoad = openLiveMatchSnapshot(root);
    const summaryCall = openLiveMatchSnapshot(root);
    const tableCallOne = readLiveMatchEnvelopes(root);
    const tableCallTwo = readLiveMatchEnvelopes(root);
    const captureCall = readLiveMatchPreActionCaptures(root);

    expect(summaryCall).toBe(firstLoad);
    expect(tableCallOne.matches).toBe(firstLoad.matches);
    expect(tableCallTwo.matches).toBe(firstLoad.matches);
    expect(captureCall.captures).toBe(firstLoad.captures);
  });

  it('bounds skip-detail entries at maxSkippedDetails even though the true count is exact', () => {
    const snapshot = openLiveMatchSnapshot(root, { maxSkippedDetails: 1 });

    expect(snapshot.skippedMatchCount).toBe(3);
    expect(snapshot.skippedMatches).toHaveLength(1);
  });
});
