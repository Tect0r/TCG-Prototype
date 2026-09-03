import { describe, expect, it } from 'vitest';
import { loadBundledCardData, type CardDatabase } from '@tcg/card-data';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';
import { aggregateLiveCardEvidence } from './live-card-evidence.js';

/**
 * M08.24B — eligibility-aware card evidence.
 *
 * Covers: a structurally off-colour card is reported `'unusable'` with a
 * `null` inclusion rate rather than a fabricated 0% selection; a legal card
 * nobody included is `'held'` (inclusion 0, not `null`); a legal card at
 * least one seat included is `'played'` with the correct match-weighted
 * inclusion rate; card pairs only report co-occurrence that actually
 * happened; evidence is computed per Commander, never pooled across
 * Commanders of different colours; no database supplied leaves the
 * partition's evidence unavailable with a stated reason; empty input.
 */

const database: CardDatabase = loadBundledCardData().database;

// prototype_drone: neutral (colorIdentity []). arcane_snare: blue. archive_acolyte: blue,
// never included below. banner_keeper: white — off-colour for both test Commanders.
const blueDeckWithSnare = () =>
  freezeLiveMatchDeckSnapshot({
    commanderId: 'prototype_commander_blue',
    cards: [
      { cardId: 'prototype_drone', quantity: 39 },
      { cardId: 'arcane_snare', quantity: 1 },
    ],
  });
const blueDeckWithoutSnare = () =>
  freezeLiveMatchDeckSnapshot({
    commanderId: 'prototype_commander_blue',
    cards: [{ cardId: 'prototype_drone', quantity: 40 }],
  });
const redDeck = () =>
  freezeLiveMatchDeckSnapshot({
    commanderId: 'prototype_commander_red',
    cards: [{ cardId: 'prototype_scout', quantity: 40 }],
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

function envelope(overrides: Partial<LiveMatchEnvelope> = {}): LiveMatchEnvelope {
  return {
    schemaVersion: 3,
    matchId: `match_${Math.random().toString(36).slice(2)}`,
    source: 'human_human',
    formatId: 'precon_wave_1',
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    seats: [
      { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: blueDeckWithSnare() },
      { seatIndex: 1, playerId: 'player_2', kind: 'human', deck: redDeck() },
    ],
    actionCount: 40,
    terminationOrigin: 'rules_victory',
    outcome: winOutcome,
    ...overrides,
  };
}

const databases = new Map([[5, database]]);

describe('aggregateLiveCardEvidence', () => {
  it('reports an off-colour card as unusable with a null inclusion rate, never 0% selection', () => {
    const [evidence] = aggregateLiveCardEvidence([envelope()], {
      cardDatabasesByContentVersion: databases,
    });
    const blue = evidence?.commanders?.find((entry) => entry.commanderId === 'prototype_commander_blue');
    const bannerKeeper = blue?.cards.find((entry) => entry.cardId === 'banner_keeper');

    expect(bannerKeeper?.status).toBe('unusable');
    expect(bannerKeeper?.inclusion).toBeNull();
    expect(bannerKeeper?.matchesIncluding).toBe(0);
  });

  it('distinguishes a held legal card (0 inclusion) from a played one, match-weighted', () => {
    const [evidence] = aggregateLiveCardEvidence(
      [envelope(), envelope({ matchId: 'match_two', seats: [
        { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: blueDeckWithoutSnare() },
        { seatIndex: 1, playerId: 'player_2', kind: 'human', deck: redDeck() },
      ] })],
      { cardDatabasesByContentVersion: databases },
    );
    const blue = evidence?.commanders?.find((entry) => entry.commanderId === 'prototype_commander_blue');
    expect(blue?.commanderMatches).toBe(2);

    const archiveAcolyte = blue?.cards.find((entry) => entry.cardId === 'archive_acolyte');
    expect(archiveAcolyte?.status).toBe('held');
    expect(archiveAcolyte?.matchesIncluding).toBe(0);
    expect(archiveAcolyte?.inclusion).toBe(0);

    const arcaneSnare = blue?.cards.find((entry) => entry.cardId === 'arcane_snare');
    expect(arcaneSnare?.status).toBe('played');
    expect(arcaneSnare?.matchesIncluding).toBe(1);
    expect(arcaneSnare?.inclusion).toBe(0.5);
  });

  it('reports only pairs that actually co-occurred, with match-weighted support', () => {
    const [evidence] = aggregateLiveCardEvidence(
      [envelope(), envelope({ matchId: 'match_two', seats: [
        { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: blueDeckWithoutSnare() },
        { seatIndex: 1, playerId: 'player_2', kind: 'human', deck: redDeck() },
      ] })],
      { cardDatabasesByContentVersion: databases },
    );
    const blue = evidence?.commanders?.find((entry) => entry.commanderId === 'prototype_commander_blue');

    expect(blue?.pairs).toHaveLength(1);
    expect(blue?.pairs[0]).toMatchObject({
      cardIdA: 'arcane_snare',
      cardIdB: 'prototype_drone',
      matchesIncludingBoth: 1,
      support: 0.5,
    });
  });

  it('computes evidence per Commander, never pooling different colours together', () => {
    const [evidence] = aggregateLiveCardEvidence([envelope()], {
      cardDatabasesByContentVersion: databases,
    });
    expect(evidence?.commanders).toHaveLength(2);

    const red = evidence?.commanders?.find((entry) => entry.commanderId === 'prototype_commander_red');
    const arcaneSnareUnderRed = red?.cards.find((entry) => entry.cardId === 'arcane_snare');
    expect(arcaneSnareUnderRed?.status).toBe('unusable');
    expect(arcaneSnareUnderRed?.inclusion).toBeNull();
  });

  it('leaves a partition unavailable when no database was supplied for its content version', () => {
    const [evidence] = aggregateLiveCardEvidence([envelope()]);
    expect(evidence?.commanders).toBeNull();
    expect(evidence?.unavailableReason).toMatch(/content version 5/);
  });

  it('returns no partitions for an empty input', () => {
    expect(aggregateLiveCardEvidence([])).toEqual([]);
  });
});
