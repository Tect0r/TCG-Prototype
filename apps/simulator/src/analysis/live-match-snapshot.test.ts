import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
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
  readBoundedEvidenceFile,
  resetLiveMatchSnapshotCacheForTests,
} from './live-match-snapshot.js';

/**
 * Creates a directory symlink (a Windows junction where needed), or reports
 * that this machine will not — mirrors `roots.test.ts`'s `linkDirectory` and
 * `artifacts.test.ts`'s `linkFile` (M08.R12): CI runs on Linux, where this
 * always succeeds; locally, without Developer Mode, a *file* symlink cannot
 * be created at all, so those cases are reported rather than skipped quietly.
 */
function linkDirectory(from: string, to: string): boolean {
  try {
    symlinkSync(to, from, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

function linkFile(from: string, to: string): boolean {
  try {
    symlinkSync(to, from, 'file');
    return true;
  } catch {
    return false;
  }
}

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

  it('never allocates or reads a first file that alone exceeds the whole byte budget (M08.R18)', () => {
    // Before M08.R18, `bytesRead >= maxBytes` was only checked at the top of
    // the loop, so a single oversized first file was fully read before the
    // cap was ever consulted. `maxBytes` set below the first file's own size
    // proves the file itself is never read at all: zero matches, not one.
    const oversized = JSON.stringify(envelope('match_0', { actionCount: 999_999 }));
    writeMatchDirectory('match_0', oversized);

    const snapshot = openLiveMatchSnapshot(root, {
      maxBytes: Buffer.byteLength(oversized, 'utf8') - 1,
    });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.matches).toEqual([]);
  });

  it('reads a file whose size lands exactly on the remaining byte budget', () => {
    const exact = JSON.stringify(envelope('match_0'));
    writeMatchDirectory('match_0', exact);

    const snapshot = openLiveMatchSnapshot(root, {
      maxBytes: Buffer.byteLength(exact, 'utf8'),
    });

    expect(snapshot.truncated).toBe(false);
    expect(snapshot.matches.map((match) => match.matchId)).toEqual(['match_0']);
  });
});

describe('symlinked, dangling and unreadable entries (M08.R18)', () => {
  it('refuses a match directory that is a symlink, and never scans into it', () => {
    const target = join(root, 'real_target');
    writeMatchDirectory('real_target', JSON.stringify(envelope('real_target')));

    const linked = linkDirectory(join(root, 'linked_match'), target);
    if (!linked) {
      expect(process.platform).toBe('win32');
      return;
    }

    const snapshot = openLiveMatchSnapshot(root);

    expect(snapshot.matches.map((match) => match.matchId)).toContain('real_target');
    expect(snapshot.matches.map((match) => match.matchId)).not.toContain('linked_match');
    expect(snapshot.skippedMatches).toContainEqual({
      matchId: 'linked_match',
      reason: 'match directory is a symlink (refused)',
    });
  });

  it('refuses an envelope.json that is a symlink to a file outside the root', () => {
    const outside = join(root, '..', 'outside-envelope');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.json'), JSON.stringify(envelope('secret')), 'utf8');

    const directory = join(root, 'match_linked');
    mkdirSync(directory, { recursive: true });
    const linked = linkFile(join(directory, 'envelope.json'), join(outside, 'secret.json'));
    if (!linked) {
      expect(process.platform).toBe('win32');
      return;
    }

    const snapshot = openLiveMatchSnapshot(root);

    expect(snapshot.matches).toEqual([]);
    expect(snapshot.skippedMatches).toContainEqual({
      matchId: 'match_linked',
      reason: 'envelope.json is a symlink (refused)',
    });
  });

  it('refuses a dangling match-directory symlink (target never existed) without throwing', () => {
    // `lstat`, unlike `stat`, succeeds on a dangling symlink — it reports the
    // link itself, never resolving the target — which is exactly why the
    // scan uses it: a target that never existed must be refused the same
    // way a live one is, not crash the whole snapshot.
    const linked = linkDirectory(join(root, 'match_dangling'), join(root, 'never-existed'));
    if (!linked) {
      expect(process.platform).toBe('win32');
      return;
    }

    const snapshot = openLiveMatchSnapshot(root);

    expect(snapshot.matches).toEqual([]);
    expect(snapshot.skippedMatches).toContainEqual({
      matchId: 'match_dangling',
      reason: 'match directory is a symlink (refused)',
    });
  });

  it('refuses a dangling envelope.json symlink the same way as a live one', () => {
    const directory = join(root, 'match_dangling_file');
    mkdirSync(directory, { recursive: true });
    const linked = linkFile(join(directory, 'envelope.json'), join(root, 'never-existed.json'));
    if (!linked) {
      expect(process.platform).toBe('win32');
      return;
    }

    const outcome = readBoundedEvidenceFile(join(directory, 'envelope.json'), 1_000_000);

    expect(outcome.kind).toBe('unsafe');
  });

  it('records an honest skipped reason for an envelope.json readBoundedEvidenceFile refuses, without a leaked path', () => {
    // Exercised directly against the helper: a file whose `lstat` succeeds
    // but is not a plain file (a directory at the expected file path)
    // cannot be opened as one, and must be reported rather than thrown.
    const directory = join(root, 'match_dir_as_file');
    mkdirSync(join(directory, 'envelope.json'), { recursive: true });

    const outcome = readBoundedEvidenceFile(join(directory, 'envelope.json'), 1_000_000);

    expect(outcome.kind).toBe('unreadable');
  });
});

describe('growth and truncation races (M08.R18)', () => {
  it('bounds a read to the size validated at fstat time, unaffected by growth before the read', () => {
    const original = JSON.stringify(envelope('match_grown'));
    const path = join(mkdtempSync(join(tmpdir(), 'tcg-sim-grow-')), 'envelope.json');
    writeFileSync(path, original, 'utf8');

    const outcome = readBoundedEvidenceFile(path, 1_000_000, {
      beforeRead: () => {
        // Growth after the descriptor is already fstat-validated and sized
        // must never change what a bounded read of that descriptor returns.
        const fd = openSync(path, 'a');
        writeSync(fd, Buffer.from('EXTRA GARBAGE THAT MUST NEVER BE READ'));
        closeSync(fd);
      },
    });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.byteLength).toBe(Buffer.byteLength(original, 'utf8'));
    expect(outcome.content).toBe(original);
    expect(JSON.parse(outcome.content)).toMatchObject({ matchId: 'match_grown' });
  });

  it('reports a file truncated mid-read as unparseable rather than returning a shorter, silently-wrong document', () => {
    const original = JSON.stringify(envelope('match_shrunk'));
    const path = join(mkdtempSync(join(tmpdir(), 'tcg-sim-shrink-')), 'envelope.json');
    writeFileSync(path, original, 'utf8');
    const shrunkSize = Math.floor(Buffer.byteLength(original, 'utf8') / 2);

    const outcome = readBoundedEvidenceFile(path, 1_000_000, {
      beforeRead: () => {
        // Simulates a concurrent writer truncating the file after this
        // read has already fstat-sized its buffer to the original length.
        truncateSync(path, shrunkSize);
      },
    });

    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.byteLength).toBe(shrunkSize);
    expect(() => JSON.parse(outcome.content)).toThrow();
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
