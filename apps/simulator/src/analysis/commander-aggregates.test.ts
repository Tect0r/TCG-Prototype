import { beforeAll, describe, expect, it } from 'vitest';
import { aggregate, type Aggregate } from './aggregate.js';
import { SUMMARY_SCHEMA_VERSION } from '../experiment.js';
import { runBatch } from '../run-batch.js';
import { buildSchedule } from '../schedule.js';
import type { MatchRecord } from '../telemetry/schema.js';
import type { Environment } from '../environment.js';
import {
  AGGRESSIVE_PILOT,
  FAST_LIMITS,
  NO_RETENTION,
  VALUE_PILOT,
  fixtureDeck,
  tinyEnvironment,
} from '../test-fixtures.js';

/**
 * M08.13 — Commander aggregates.
 *
 * Two blue decks and one red deck, played by two pilots, so a single fixture
 * covers every acceptance case: `blueA`/`blueB` give the blue Commander a
 * two-deck population (seat/pilot partition, deck diversity) and `redDeck`
 * gives the red Commander a one-deck population (the small-sample case, and
 * the "mixed-source" case of two Commanders with different legal pools in one
 * run, per the same reading `card-inclusion.test.ts` uses for M08.12).
 */

const env: Environment = tinyEnvironment({ id: 'commander_aggregates' });

const FILLER: readonly [string, number][] = [
  ['prototype_drone', 2],
  ['prototype_scout', 2],
  ['prototype_guard', 2],
  ['trench_guard', 2],
];

const blueA = fixtureDeck('blue_a', 'prototype_commander_blue', [
  ['fixture_baseline_unit', 2],
  ['unstable_construct', 2],
  ...FILLER,
]);
const blueB = fixtureDeck('blue_b', 'prototype_commander_blue', [
  ['fixture_equivalent_unit', 2],
  ['energy_font', 2],
  ...FILLER,
]);
const redDeck = fixtureDeck('red_deck', 'prototype_commander_red', [
  ['fixture_baseline_unit', 2],
  ['energy_font', 2],
  ...FILLER,
]);

let records: readonly MatchRecord[];

beforeAll(async () => {
  const decks = [blueA, blueB, redDeck];
  const schedule = buildSchedule({
    experimentId: 'commander-aggregates',
    experimentSeed: 'commander-aggregates-seed',
    environmentId: env.id,
    decks,
    pilots: [VALUE_PILOT, AGGRESSIVE_PILOT],
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: 4,
    mirrorSeats: true,
    schedule: 'round_robin',
    sampledPairings: 10_000,
  });

  const outcome = await runBatch({
    experimentId: 'commander-aggregates',
    experimentKind: 'batch',
    configHash: 'commander-aggregates-test',
    arm: null,
    environment: env,
    decks,
    pilots: [VALUE_PILOT, AGGRESSIVE_PILOT],
    schedule,
    limits: FAST_LIMITS,
    retention: NO_RETENTION,
    workers: 1,
    failFast: false,
    sink: null,
    softwareCommit: null,
  });
  records = outcome.records;
}, 120_000);

describe('Commander aggregates (M08.13)', () => {
  it('reports a SUMMARY_SCHEMA_VERSION at or beyond the one this tranche shipped', () => {
    // "At least 9" rather than "exactly 9", on the same terms
    // `card-inclusion.test.ts` pins its own M08.12 version: a later tranche
    // legitimately moves this forward, and `experiment.ts`'s own
    // version-history comment is the place that re-pins the exact number.
    expect(SUMMARY_SCHEMA_VERSION).toBeGreaterThanOrEqual(9);
  });

  it('small-sample: an empty run produces no Commanders and does not divide by zero', () => {
    const summary = aggregate([]);
    expect(summary.commanders).toEqual([]);
    expect(summary.commanderMatchups).toEqual([]);
  });

  it('small-sample: a Commander seated behind exactly one deck reports zero diversity, not NaN', () => {
    const summary = aggregate(records);
    const red = summary.commanders.find((entry) => entry.commanderId === 'prototype_commander_red');
    expect(red).toBeDefined();
    expect(red?.decks).toBe(1);
    expect(red?.deckDiversity).toBe(0);
    expect(Number.isFinite(red?.winRate.point)).toBe(true);
  });

  it('mixed-source: both Commanders this run seated get their own summary', () => {
    const summary = aggregate(records);
    const ids = summary.commanders.map((entry) => entry.commanderId).sort();
    expect(ids).toEqual(['prototype_commander_blue', 'prototype_commander_red']);
    const blue = summary.commanders.find(
      (entry) => entry.commanderId === 'prototype_commander_blue',
    );
    expect(blue?.decks).toBe(2);
    expect(blue?.matches).toBeGreaterThan(0);
  });

  it('seat and pilot partition: win rates are split by seat and by pilot within a Commander', () => {
    const summary = aggregate(records);
    const blue = summary.commanders.find(
      (entry) => entry.commanderId === 'prototype_commander_blue',
    );
    expect(blue).toBeDefined();
    if (!blue) return;

    expect(blue.bySeat.map((entry) => entry.seatIndex).sort()).toEqual([0, 1]);
    for (const entry of blue.bySeat) {
      expect(entry.rate.total).toBeGreaterThan(0);
    }

    const pilotIds = blue.byPilot.map((entry) => entry.pilotId).sort();
    expect(pilotIds).toEqual(['aggressive', 'value']);
    for (const entry of blue.byPilot) {
      expect(entry.rate.total).toBeGreaterThan(0);
    }
    // Every pilot's own seat-matches sum to the Commander's total: the
    // partition covers the population, it does not double-count it.
    const pilotTotal = blue.byPilot.reduce((sum, entry) => sum + entry.rate.total, 0);
    expect(pilotTotal).toBe(blue.matches);
  });

  it('turn and end-reason distributions: seat-counted totals sum to matches, by Commander and by agent class', () => {
    const summary = aggregate(records);
    const blue = summary.commanders.find(
      (entry) => entry.commanderId === 'prototype_commander_blue',
    );
    expect(blue).toBeDefined();
    if (!blue) return;

    // `endReasons` and `turns` are counted once per seat (the same convention
    // `DeckSummary` uses), so every end-reason bucket must sum to `matches` —
    // not to the number of distinct matches, which would be half as many for
    // a two-seat game.
    const endReasonTotal = Object.values(blue.endReasons).reduce((sum, count) => sum + count, 0);
    expect(endReasonTotal).toBe(blue.matches);
    expect(blue.turns.mean).toBeGreaterThan(0);
    expect(blue.turns.max).toBeGreaterThanOrEqual(blue.turns.p90);

    // Both pilots this run used are generic heuristics (M05.4), so `byPilot`
    // and `byAgentClass` partition the same population two different ways —
    // each must sum to the Commander's total on its own terms.
    const classTotal = blue.byAgentClass.reduce((sum, entry) => sum + entry.rate.total, 0);
    expect(classTotal).toBe(blue.matches);
  });

  it('ordered Commander-matrix: cells are sorted and cover every pairing this run played', () => {
    const summary = aggregate(records);
    const keys = summary.commanderMatchups.map(
      (entry) => `${entry.commanderId}§${entry.opponentCommanderId}`,
    );
    expect(keys).toEqual([...keys].sort((left, right) => left.localeCompare(right)));

    // blueA vs blueB is an intra-Commander cell; blue vs red is the
    // cross-Commander cell. Both must appear, and a matrix that only ever
    // printed the cross cell would be silently dropping the mirror.
    expect(keys).toContain('prototype_commander_blue§prototype_commander_blue');
    expect(keys).toContain('prototype_commander_blue§prototype_commander_red');
    expect(keys).toContain('prototype_commander_red§prototype_commander_blue');
  });

  it('population and archive: shares read supplied search membership, null when none is supplied', () => {
    const withoutSearch = aggregate(records);
    for (const commander of withoutSearch.commanders) {
      expect(commander.populationSurvivalShare).toBeNull();
      expect(commander.archiveSurvivalShare).toBeNull();
      expect(commander.topDeckFitness).toBeNull();
      expect(commander.medianDeckFitness).toBeNull();
    }

    // blueA is in the final population only, blueB in the archive only, and
    // redDeck in neither — so blue's shares must land at exactly one half and
    // red's at exactly zero, never guessed from decks a search never scored.
    const withSearch = aggregate(records, {
      search: {
        populationDeckHashes: new Set([blueA.hash]),
        archiveDeckHashes: new Set([blueB.hash]),
        fitnessByDeckHash: new Map([
          [blueA.hash, 0.7],
          [redDeck.hash, 0.3],
        ]),
      },
    });
    const blue = withSearch.commanders.find(
      (entry) => entry.commanderId === 'prototype_commander_blue',
    );
    const red = withSearch.commanders.find(
      (entry) => entry.commanderId === 'prototype_commander_red',
    );
    expect(blue?.populationSurvivalShare).toBeCloseTo(0.5, 6);
    expect(blue?.archiveSurvivalShare).toBeCloseTo(0.5, 6);
    // blueB was never scored, so the top/median must come from blueA alone.
    expect(blue?.topDeckFitness).toBeCloseTo(0.7, 6);
    expect(blue?.medianDeckFitness).toBeCloseTo(0.7, 6);

    expect(red?.populationSurvivalShare).toBe(0);
    expect(red?.archiveSurvivalShare).toBe(0);
    expect(red?.topDeckFitness).toBeCloseTo(0.3, 6);
    expect(red?.medianDeckFitness).toBeCloseTo(0.3, 6);
  });

  it('diversity: a two-deck Commander scores strictly above a one-deck Commander', () => {
    const summary = aggregate(records);
    const blue = summary.commanders.find(
      (entry) => entry.commanderId === 'prototype_commander_blue',
    );
    const red = summary.commanders.find((entry) => entry.commanderId === 'prototype_commander_red');
    expect(blue?.deckDiversity).toBeGreaterThan(0);
    expect(blue?.deckDiversity).toBeLessThanOrEqual(1);
    expect(red?.deckDiversity).toBe(0);
  });

  it('regeneration: re-aggregating the same raw records is deterministic', () => {
    const first: Aggregate = aggregate(records);
    const second: Aggregate = aggregate([...records].reverse());
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
