import { describe, expect, it } from 'vitest';
import { loadBundledCardData, type CardDatabase } from '@tcg/card-data';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';
import type { MatchResult } from '@tcg/rules-engine';
import { MatchServer } from './match-server.js';
import type { LiveMatchRecord, LiveMatchSink } from './live-match-sink.js';

/**
 * M08.22A's own boundary: an injectable sink, optional by default, whose
 * failure is contained and never fatal to a match. No caller exists inside
 * `MatchServer` yet — building the record from a finished match is M08.22B's
 * job — so this drives `ingestLiveMatch` directly, the same way M09.17's
 * `bot-summary.test.ts` proved `ingestSummary`'s containment before this slice
 * existed.
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

function validEnvelope(): LiveMatchEnvelope {
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
    matchId: 'match_001',
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

function recordOf(): LiveMatchRecord {
  return { envelope: validEnvelope(), rawEvent: null, replay: null };
}

describe('the live-match sink boundary (M08.22A)', () => {
  it('is absent by default, and ingesting without one is a harmless no-op', () => {
    const server = new MatchServer({ database });
    expect(() => server.ingestLiveMatch(recordOf())).not.toThrow();
    expect(server.liveMatchSinkFailures).toEqual([]);
  });

  it('hands the exact record to an injected sink', () => {
    const received: LiveMatchRecord[] = [];
    const sink: LiveMatchSink = { sinkId: 'test_sink', receive: (record) => received.push(record) };
    const server = new MatchServer({ database, liveMatchSink: sink });

    const record = recordOf();
    server.ingestLiveMatch(record);

    expect(received).toEqual([record]);
    expect(server.liveMatchSinkFailures).toEqual([]);
  });

  it('contains a throwing sink’s failure instead of letting it escape', () => {
    const sink: LiveMatchSink = {
      sinkId: 'broken_sink',
      receive: () => {
        throw new Error('the store was unavailable');
      },
    };
    const server = new MatchServer({ database, liveMatchSink: sink });

    expect(() => server.ingestLiveMatch(recordOf())).not.toThrow();
    expect(server.liveMatchSinkFailures).toEqual(['broken_sink: the store was unavailable']);
  });

  it('records one failure per throwing call, keyed by the sink that threw', () => {
    const sink: LiveMatchSink = {
      sinkId: 'flaky_sink',
      receive: () => {
        throw new Error('unavailable');
      },
    };
    const server = new MatchServer({ database, liveMatchSink: sink });

    server.ingestLiveMatch(recordOf());
    server.ingestLiveMatch(recordOf());

    expect(server.liveMatchSinkFailures).toEqual([
      'flaky_sink: unavailable',
      'flaky_sink: unavailable',
    ]);
  });
});
