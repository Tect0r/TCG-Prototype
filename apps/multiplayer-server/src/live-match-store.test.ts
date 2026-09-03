import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBundledCardData, type CardDatabase } from '@tcg/card-data';
import {
  freezeLiveMatchDeckSnapshot,
  parseLiveMatchEnvelope,
  parseLiveMatchRawEventArtifact,
  parseLiveMatchReplayArtifact,
  type LiveMatchEnvelope,
  type LiveMatchRawEventArtifact,
  type LiveMatchReplayArtifact,
} from '@tcg/match-telemetry';
import type { MatchResult } from '@tcg/rules-engine';
import { MatchServer } from './match-server.js';
import type { LiveMatchRecord } from './live-match-sink.js';
import { LiveMatchFileStore } from './live-match-store.js';

/**
 * M08.22B: one canonical record per match, on disk, with stable duplicate/retry
 * keys and no second source of truth. Proves the file layout, the atomic write,
 * idempotent overwrite-in-place on retry, and — composed with M08.22A's already
 * proven boundary — that an unsafe matchId is contained the same way a throwing
 * sink is.
 */

const database: CardDatabase = loadBundledCardData().database;

const winOutcome: MatchResult = {
  outcome: 'win',
  winnerId: 'player_1',
  loserIds: ['player_2'],
  reason: 'health_depleted',
  finalTurn: 12,
  finalSequence: 240,
  diagnostics: null,
};

function envelopeFor(matchId: string): LiveMatchEnvelope {
  const winnerDeck = freezeLiveMatchDeckSnapshot({
    commanderId: 'cmd_alpha',
    cards: [{ cardId: 'card_a', quantity: 40 }],
  });
  const loserDeck = freezeLiveMatchDeckSnapshot({
    commanderId: 'cmd_beta',
    cards: [{ cardId: 'card_b', quantity: 40 }],
  });
  return {
    schemaVersion: 3,
    matchId,
    source: 'human_human',
    formatId: 'precon_wave_1',
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    seats: [
      { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: winnerDeck },
      { seatIndex: 1, playerId: 'player_2', kind: 'human', deck: loserDeck },
    ],
    actionCount: 87,
    terminationOrigin: 'rules_victory',
    outcome: winOutcome,
  };
}

function rawEventFor(matchId: string): LiveMatchRawEventArtifact {
  return { schemaVersion: 1, matchId, log: [], actionLog: [] };
}

function replayFor(matchId: string): LiveMatchReplayArtifact {
  return { schemaVersion: 1, matchId, seed: 'seed_001', actionLog: [] };
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tcg-live-match-store-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('LiveMatchFileStore (M08.22B)', () => {
  it('writes the canonical envelope and skips artifacts the record does not carry', () => {
    const store = new LiveMatchFileStore({ rootDirectory: root });
    const record: LiveMatchRecord = {
      envelope: envelopeFor('match_001'),
      rawEvent: null,
      replay: null,
      preActionCapture: null,
    };

    store.receive(record);

    const matchDirectory = join(root, 'match_001');
    const written = parseLiveMatchEnvelope(
      JSON.parse(readFileSync(join(matchDirectory, 'envelope.json'), 'utf8')),
    );
    expect(written).toEqual(record.envelope);
    expect(existsSync(join(matchDirectory, 'raw-event.json'))).toBe(false);
    expect(existsSync(join(matchDirectory, 'replay.json'))).toBe(false);
  });

  it('writes configured raw-event and replay artifacts alongside the envelope', () => {
    const store = new LiveMatchFileStore({ rootDirectory: root });
    const record: LiveMatchRecord = {
      envelope: envelopeFor('match_002'),
      rawEvent: rawEventFor('match_002'),
      replay: replayFor('match_002'),
      preActionCapture: null,
    };

    store.receive(record);

    const matchDirectory = join(root, 'match_002');
    const rawEvent = parseLiveMatchRawEventArtifact(
      JSON.parse(readFileSync(join(matchDirectory, 'raw-event.json'), 'utf8')),
    );
    const replay = parseLiveMatchReplayArtifact(
      JSON.parse(readFileSync(join(matchDirectory, 'replay.json'), 'utf8')),
    );
    expect(rawEvent).toEqual(record.rawEvent);
    expect(replay).toEqual(record.replay);
  });

  it('keeps separate matches in separate directories', () => {
    const store = new LiveMatchFileStore({ rootDirectory: root });
    store.receive({ envelope: envelopeFor('match_a'), rawEvent: null, replay: null, preActionCapture: null });
    store.receive({ envelope: envelopeFor('match_b'), rawEvent: null, replay: null, preActionCapture: null });

    expect(existsSync(join(root, 'match_a', 'envelope.json'))).toBe(true);
    expect(existsSync(join(root, 'match_b', 'envelope.json'))).toBe(true);
  });

  it('is idempotent: repeating the exact same record overwrites in place, not a duplicate', () => {
    const store = new LiveMatchFileStore({ rootDirectory: root });
    const record: LiveMatchRecord = {
      envelope: envelopeFor('match_003'),
      rawEvent: null,
      replay: null,
      preActionCapture: null,
    };

    expect(() => store.receive(record)).not.toThrow();
    expect(() => store.receive(record)).not.toThrow();

    const matchDirectory = join(root, 'match_003');
    const written = parseLiveMatchEnvelope(
      JSON.parse(readFileSync(join(matchDirectory, 'envelope.json'), 'utf8')),
    );
    expect(written).toEqual(record.envelope);
  });

  it('a retry with different content for the same matchId overwrites, keyed by matchId alone', () => {
    const store = new LiveMatchFileStore({ rootDirectory: root });
    const first = envelopeFor('match_004');
    store.receive({ envelope: first, rawEvent: null, replay: null, preActionCapture: null });

    const retried: LiveMatchEnvelope = { ...first, actionCount: first.actionCount + 3 };
    store.receive({ envelope: retried, rawEvent: null, replay: null, preActionCapture: null });

    const matchDirectory = join(root, 'match_004');
    const written = parseLiveMatchEnvelope(
      JSON.parse(readFileSync(join(matchDirectory, 'envelope.json'), 'utf8')),
    );
    expect(written.actionCount).toBe(retried.actionCount);
  });

  it('refuses a matchId that is not safe as a filesystem path segment', () => {
    const store = new LiveMatchFileStore({ rootDirectory: root });
    const record: LiveMatchRecord = {
      envelope: envelopeFor('../escape'),
      rawEvent: null,
      replay: null,
      preActionCapture: null,
    };

    expect(() => store.receive(record)).toThrow(/not safe to use as a filesystem path segment/);
  });

  it('composes with M08.22A: an unsafe matchId is contained the same way a throwing sink is', () => {
    const store = new LiveMatchFileStore({ rootDirectory: root });
    const server = new MatchServer({ database, liveMatchSink: store });
    const record: LiveMatchRecord = {
      envelope: envelopeFor('../escape'),
      rawEvent: null,
      replay: null,
      preActionCapture: null,
    };

    expect(() => server.ingestLiveMatch(record)).not.toThrow();
    expect(server.liveMatchSinkFailures).toEqual([
      'live_match_file_store: matchId "../escape" is not safe to use as a filesystem path segment ' +
        '(must match ^[A-Za-z0-9_-]{1,128}$).',
    ]);
  });
});
