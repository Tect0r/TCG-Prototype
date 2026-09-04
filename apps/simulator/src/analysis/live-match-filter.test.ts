import { describe, expect, it } from 'vitest';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';
import {
  NO_LIVE_MATCH_FILTER,
  filterLiveMatches,
  type LiveMatchFilter,
} from './live-match-filter.js';

/**
 * M08.25A — narrowing which matches reach `partitionLiveMatches`/
 * `aggregateLiveMatches` without touching how they are partitioned or
 * weighted once admitted.
 */

const blueDeck = () =>
  freezeLiveMatchDeckSnapshot({
    commanderId: 'prototype_commander_blue',
    cards: [{ cardId: 'prototype_drone', quantity: 40 }],
  });
const redDeck = () =>
  freezeLiveMatchDeckSnapshot({
    commanderId: 'prototype_commander_red',
    cards: [{ cardId: 'prototype_scout', quantity: 40 }],
  });

function envelope(overrides: Partial<LiveMatchEnvelope> = {}): LiveMatchEnvelope {
  return {
    schemaVersion: 3,
    matchId: `match_${Math.random().toString(36).slice(2)}`,
    source: 'human_human',
    formatId: 'precon_wave_1',
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    seats: [
      { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: blueDeck() },
      { seatIndex: 1, playerId: 'player_2', kind: 'human', deck: redDeck() },
    ],
    actionCount: 40,
    terminationOrigin: 'rules_victory',
    outcome: {
      outcome: 'win',
      winnerId: 'player_1',
      loserIds: ['player_2'],
      reason: 'health_depleted',
      finalTurn: 10,
      finalSequence: 200,
      diagnostics: null,
    },
    ...overrides,
  };
}

describe('the unfiltered query', () => {
  it('is what `{}` means: every field absent admits everything', () => {
    const matches = [envelope(), envelope({ source: 'human_ai' }), envelope({ source: 'ai_ai' })];
    expect(filterLiveMatches(matches, NO_LIVE_MATCH_FILTER)).toEqual(matches);
    expect(filterLiveMatches(matches, {})).toEqual(matches);
  });

  it('treats an explicit empty array the same as an absent field', () => {
    const matches = [envelope()];
    expect(filterLiveMatches(matches, { sources: [] })).toEqual(matches);
  });
});

describe('single-field filters', () => {
  it('narrows by content version', () => {
    const v5 = envelope({
      provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    });
    const v6 = envelope({
      provenance: { softwareVersion: '1.0.0', contentVersion: 6, rulesVersion: '1.0.0' },
    });
    expect(filterLiveMatches([v5, v6], { contentVersions: [5] })).toEqual([v5]);
  });

  it('narrows by source without pooling', () => {
    const human = envelope({ source: 'human_human' });
    const ai = envelope({ source: 'ai_ai' });
    expect(filterLiveMatches([human, ai], { sources: ['human_human'] })).toEqual([human]);
  });

  it('narrows by Commander on either seat', () => {
    const match = envelope();
    expect(filterLiveMatches([match], { commanderIds: ['prototype_commander_red'] })).toEqual([
      match,
    ]);
    expect(filterLiveMatches([match], { commanderIds: ['prototype_commander_absent'] })).toEqual(
      [],
    );
  });

  it('narrows by deck hash on either seat', () => {
    const match = envelope();
    const targetHash = match.seats[1]?.deck.deckHash;
    expect(filterLiveMatches([match], { deckHashes: [targetHash as string] })).toEqual([match]);
    expect(filterLiveMatches([match], { deckHashes: ['0000000000000000'] })).toEqual([]);
  });

  it('narrows by termination origin', () => {
    const decisive = envelope({ terminationOrigin: 'rules_victory' });
    const abandoned = envelope({ terminationOrigin: 'abandoned_unrecordable', outcome: null });
    expect(
      filterLiveMatches([decisive, abandoned], { terminations: ['abandoned_unrecordable'] }),
    ).toEqual([abandoned]);
  });
});

describe('field combination', () => {
  it('is OR within a field, AND across fields', () => {
    const humanV5 = envelope({
      source: 'human_human',
      provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    });
    const aiV5 = envelope({
      source: 'ai_ai',
      provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    });
    const humanV6 = envelope({
      source: 'human_human',
      provenance: { softwareVersion: '1.0.0', contentVersion: 6, rulesVersion: '1.0.0' },
    });

    const filter: LiveMatchFilter = { sources: ['human_human', 'ai_ai'], contentVersions: [5] };
    expect(filterLiveMatches([humanV5, aiV5, humanV6], filter)).toEqual([humanV5, aiV5]);
  });
});
