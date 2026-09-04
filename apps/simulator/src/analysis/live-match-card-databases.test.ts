import { describe, expect, it } from 'vitest';
import { CARD_SCHEMA_VERSION } from '@tcg/card-data';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';
import { currentLiveMatchCardDatabases } from './live-match-card-databases.js';

/**
 * M08.25B — resolving the one honest `CardDatabase` a batch of live matches
 * can be evaluated against, per the format-scoped database invariant
 * (CLAUDE.md): today's bundled database, keyed by today's
 * `CARD_SCHEMA_VERSION`, and only when every match shares exactly one
 * bundled format.
 */

const winOutcome: LiveMatchEnvelope['outcome'] = {
  outcome: 'win',
  winnerId: 'player_1',
  loserIds: ['player_2'],
  reason: 'health_depleted',
  finalTurn: 10,
  finalSequence: 200,
  diagnostics: null,
};

function envelope(overrides: Partial<LiveMatchEnvelope> = {}): LiveMatchEnvelope {
  return {
    schemaVersion: 3,
    matchId: `match_${Math.random().toString(36).slice(2)}`,
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

describe('currentLiveMatchCardDatabases', () => {
  it('resolves one entry keyed by today’s CARD_SCHEMA_VERSION when every match shares one bundled format', () => {
    const databases = currentLiveMatchCardDatabases([envelope(), envelope()]);
    expect([...databases.keys()]).toEqual([CARD_SCHEMA_VERSION]);
    expect(databases.get(CARD_SCHEMA_VERSION)).toBeDefined();
  });

  it('returns an empty map for zero matches', () => {
    expect(currentLiveMatchCardDatabases([]).size).toBe(0);
  });

  it('returns an empty map when matches span more than one format', () => {
    const databases = currentLiveMatchCardDatabases([
      envelope({ formatId: 'precon_wave_1' }),
      envelope({ formatId: 'some_other_format' }),
    ]);
    expect(databases.size).toBe(0);
  });

  it('returns an empty map, never a throw, for a format this build does not have bundled', () => {
    const databases = currentLiveMatchCardDatabases([
      envelope({ formatId: 'unbundled_format_that_does_not_exist' }),
    ]);
    expect(databases.size).toBe(0);
  });
});
