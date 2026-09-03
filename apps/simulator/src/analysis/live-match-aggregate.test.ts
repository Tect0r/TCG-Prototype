import { describe, expect, it } from 'vitest';
import { loadBundledCardData, type CardDatabase } from '@tcg/card-data';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';
import { aggregateLiveMatches } from './live-match-aggregate.js';

/**
 * M08.24A — source-separated match and deck aggregates.
 *
 * Covers: source partitioning never pools human/mixed/AI; content/rules
 * version partitioning never pools a card change across itself; a
 * `null`-outcome (`abandoned_unrecordable`) match counts as selection but not
 * as a win, loss or duration sample; clustering is computed only for a
 * partition whose content version has a supplied database, with a stated
 * reason otherwise; and termination-origin counting.
 */

const database: CardDatabase = loadBundledCardData().database;

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
      { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: blueDeck() },
      { seatIndex: 1, playerId: 'player_2', kind: 'human', deck: redDeck() },
    ],
    actionCount: 40,
    terminationOrigin: 'rules_victory',
    outcome: winOutcome,
    ...overrides,
  };
}

describe('aggregateLiveMatches', () => {
  it('never pools distinct sources into one partition', () => {
    const aggregates = aggregateLiveMatches([
      envelope({ source: 'human_human' }),
      envelope({ source: 'human_ai' }),
      envelope({ source: 'ai_ai' }),
    ]);

    expect(aggregates).toHaveLength(3);
    expect(aggregates.map((entry) => entry.partition.source).sort()).toEqual([
      'ai_ai',
      'human_ai',
      'human_human',
    ]);
    for (const aggregate of aggregates) expect(aggregate.matches).toBe(1);
  });

  it('never pools distinct content or rules versions into one partition', () => {
    const aggregates = aggregateLiveMatches([
      envelope({ provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' } }),
      envelope({ provenance: { softwareVersion: '1.0.0', contentVersion: 6, rulesVersion: '1.0.0' } }),
      envelope({ provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.1.0' } }),
    ]);

    expect(aggregates).toHaveLength(3);
    expect(aggregates.every((entry) => entry.matches === 1)).toBe(true);
  });

  it('counts an unrecordable match as selection but excludes it from win rate and duration', () => {
    const decisive = envelope();
    const abandoned = envelope({
      matchId: 'match_abandoned',
      terminationOrigin: 'abandoned_unrecordable',
      outcome: null,
    });

    const [aggregate] = aggregateLiveMatches([decisive, abandoned]);
    expect(aggregate).toBeDefined();
    expect(aggregate?.matches).toBe(2);
    expect(aggregate?.decisiveMatches).toBe(1);

    const blueSelection = aggregate?.commanderSelection.find(
      (entry) => entry.commanderId === 'prototype_commander_blue',
    );
    // Selected in both matches, but the win-rate denominator only counts the one decisive match.
    expect(blueSelection?.matches).toBe(2);
    expect(blueSelection?.winRate.total).toBe(1);
    expect(blueSelection?.winRate.successes).toBe(1);

    expect(aggregate?.duration.decisiveMatches).toBe(1);
    expect(aggregate?.duration.meanFinalTurn).toBe(10);

    const origins = aggregate?.terminationOrigins ?? [];
    expect(origins.find((entry) => entry.origin === 'abandoned_unrecordable')?.matches).toBe(1);
    expect(origins.find((entry) => entry.origin === 'rules_victory')?.matches).toBe(1);
  });

  it('reports deck usage and matchup win rates over decisive matches only', () => {
    const [aggregate] = aggregateLiveMatches([envelope(), envelope({ matchId: 'match_two' })]);

    expect(aggregate?.deckUsage).toHaveLength(2);
    const blueUsage = aggregate?.deckUsage.find(
      (entry) => entry.commanderId === 'prototype_commander_blue',
    );
    expect(blueUsage?.matches).toBe(2);
    expect(blueUsage?.winRate.point).toBe(1);

    expect(aggregate?.deckMatchups).toHaveLength(2);
    for (const matchup of aggregate?.deckMatchups ?? []) expect(matchup.winRate.total).toBe(2);
  });

  it('computes clusters only for a partition whose content version has a supplied database', () => {
    const withDatabase = aggregateLiveMatches([envelope({ provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' } })], {
      cardDatabasesByContentVersion: new Map([[5, database]]),
    });
    expect(withDatabase[0]?.clusters).not.toBeNull();
    expect(withDatabase[0]?.clustersUnavailableReason).toBeNull();
    expect(withDatabase[0]?.clusters?.features).toHaveLength(2);

    const withoutDatabase = aggregateLiveMatches([envelope()]);
    expect(withoutDatabase[0]?.clusters).toBeNull();
    expect(withoutDatabase[0]?.clustersUnavailableReason).toMatch(/content version 5/);
  });

  it('separates decks of different commanders into different clusters', () => {
    const [aggregate] = aggregateLiveMatches([envelope()], {
      cardDatabasesByContentVersion: new Map([[5, database]]),
      clusterThreshold: 0.1,
    });

    const clusters = aggregate?.clusters?.clusters ?? [];
    expect(clusters.length).toBeGreaterThanOrEqual(2);
  });

  it('returns no partitions for an empty input', () => {
    expect(aggregateLiveMatches([])).toEqual([]);
  });
});
