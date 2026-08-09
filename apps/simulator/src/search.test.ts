import { beforeAll, describe, expect, it } from 'vitest';
import {
  runSearch,
  updateArchive,
  searchCheckpointSchema,
  type Fitness,
  type SearchCheckpoint,
  type SearchOptions,
  type SearchResult,
} from './deck-search/evolve.js';
import { checkDeck, type SimDeck } from './deck-search/deck.js';
import { generatePopulation } from './deck-search/generate.js';
import type { Environment } from './environment.js';
import {
  FAST_LIMITS,
  NO_RETENTION,
  VALUE_PILOT,
  fixtureDeck,
  tinyEnvironment,
} from './test-fixtures.js';

/**
 * CLAUDE.md §13.9 and §13.15 items 14 and 15: the search rediscovers a
 * deliberately strong synthetic card, and the hall of fame stops the population
 * from forgetting an older counter.
 *
 * The planted card is `fixture_dominant_unit` — a one-cost 9/9 that can attack
 * immediately. It is far enough ahead of the rest of the pool that "the search
 * found it" is a real check rather than a coincidence a small sample produced.
 */

/** Six copies allowed, so a single card can genuinely define a deck. */
const env: Environment = tinyEnvironment({ id: 'search', copyLimit: 6 });

const dominantDeck = fixtureDeck('dominant', 'prototype_commander_blue', [
  ['fixture_dominant_unit', 6],
  ['fixture_baseline_unit', 6],
]);

/** A wall of guardians: a genuinely different strategy, and the older counter. */
const counterDeck = fixtureDeck('counter', 'prototype_commander_red', [
  ['trench_guard', 6],
  ['prototype_guard', 6],
]);

function plainDeck(index: number): SimDeck {
  const fillers = ['prototype_drone', 'prototype_scout', 'prototype_guard', 'trench_guard'];
  return fixtureDeck(`plain_${index}`, 'prototype_commander_blue', [
    [fillers[index % fillers.length] as string, 6],
    [fillers[(index + 1) % fillers.length] as string, 6],
  ]);
}

const POPULATION = [dominantDeck, counterDeck, plainDeck(0), plainDeck(1), plainDeck(2)];

function options(overrides: Partial<SearchOptions> = {}): SearchOptions {
  return {
    experimentId: 'search',
    experimentSeed: 'search-seed',
    experimentKind: 'search',
    configHash: 'search-test',
    armPrefix: 'search:r0',
    environment: env,
    pilots: [VALUE_PILOT],
    limits: FAST_LIMITS,
    retention: NO_RETENTION,
    workers: 1,
    populationSize: 5,
    generations: 3,
    eliteCount: 2,
    mutationStrength: 2,
    crossoverShare: 0,
    // Enough games per deck that the fitness interval means something: at six
    // games a lucky clean sweep is statistically indistinguishable from a real
    // edge, and the search would rank noise.
    opponentsPerEvaluation: 4,
    gamesPerOpponent: 2,
    archiveSize: 8,
    reevaluateElites: true,
    outputDir: null,
    checkpointEvery: 1,
    ...overrides,
  };
}

function copiesOf(decks: readonly SimDeck[], cardId: string): number {
  return decks.reduce(
    (sum, deck) => sum + (deck.cards.find((entry) => entry.cardId === cardId)?.quantity ?? 0),
    0,
  );
}

// One search, reused: it plays ~170 real matches and nothing below mutates it.
let result: SearchResult;
const checkpoints: SearchCheckpoint[] = [];

beforeAll(async () => {
  result = await runSearch(
    POPULATION,
    options({
      onGeneration: (_, checkpoint) => checkpoints.push(searchCheckpointSchema.parse(checkpoint)),
    }),
  );
}, 120_000);

describe('runSearch', () => {
  it('rediscovers the deliberately strong planted card', () => {
    expect(result.history).toHaveLength(3);

    // It tops the ranking in every generation, not just once.
    for (const report of result.history) {
      const best = report.best as Fitness;
      const deck = [...result.population, ...result.archive].find(
        (entry) => entry.hash === best.deckHash,
      );
      expect(deck, `generation ${report.generation}`).toBeDefined();
      expect(
        deck?.cards.find((entry) => entry.cardId === 'fixture_dominant_unit')?.quantity ?? 0,
        `generation ${report.generation} winner runs the planted card`,
      ).toBeGreaterThan(0);
    }

    // And the card spread rather than staying in the one deck it started in.
    expect(copiesOf(result.population, 'fixture_dominant_unit')).toBeGreaterThan(
      copiesOf(POPULATION, 'fixture_dominant_unit'),
    );
  });

  it('does not flag the planted card by fiat: the evidence is the fitness record', () => {
    const best = result.history.at(-1)?.best as Fitness;
    expect(best.matches).toBeGreaterThanOrEqual(10);
    expect(best.winRate).toBeGreaterThan(0.6);
    // The interval is reported, so a reader can see how firm the estimate is.
    expect(best.winRateLow).toBeLessThanOrEqual(best.winRate);
    expect(best.winRateHigh).toBeGreaterThanOrEqual(best.winRate);
    expect(best.opponentBreadth).toBeGreaterThan(0);
  });

  it('ranks a confident result above a lucky one', () => {
    // Fitness scores on the lower bound of the interval, so a deck measured over
    // few games cannot out-rank a better-measured one on a clean sweep alone.
    for (const entry of result.fitness) {
      expect(entry.score).toBeLessThanOrEqual(entry.winRateLow + 0.71);
      expect(entry.winRateLow).toBeLessThanOrEqual(entry.winRate);
    }
  });

  it('only ever produces legal decks', () => {
    for (const deck of [...result.population, ...result.archive]) {
      expect(checkDeck(deck, env).legal, deck.id).toBe(true);
    }
  });

  it('records auditable lineage for everything it bred', () => {
    const bred = result.population.filter((deck) => deck.origin.kind !== 'seed');
    expect(bred.length).toBeGreaterThan(0);
    for (const deck of bred) {
      expect(deck.origin.parentHashes.length).toBeGreaterThan(0);
      expect(deck.origin.mutationSeed.length).toBeGreaterThan(0);
      expect(deck.origin.changes.length).toBeGreaterThan(0);
      expect(deck.origin.generation).toBeGreaterThan(0);
    }
  });

  it('reports diversity every generation, healthy or not', () => {
    for (const report of result.history) {
      expect(report.cardEntropy).toBeGreaterThanOrEqual(0);
      expect(report.cardEntropy).toBeLessThanOrEqual(1);
      expect(report.commanderCount).toBeGreaterThan(0);
      expect(report.meanPairwiseDistance).toBeGreaterThan(0);
      expect(report.archiveSize).toBeGreaterThan(0);
      // Collapse is reported, never quietly corrected by injecting randomness.
      if (report.cardEntropy < 0.6) expect(report.notes.join(' ')).toMatch(/entropy/);
      if (report.commanderCount <= 1) expect(report.notes.join(' ')).toMatch(/Commander/);
    }
  });

  it('emits a schema-valid checkpoint per generation', () => {
    expect(checkpoints).toHaveLength(3);
    checkpoints.forEach((checkpoint, index) => {
      expect(checkpoint.generation).toBe(index);
      expect(checkpoint.environmentHash).toBe(env.hash);
      expect(checkpoint.population.length).toBeGreaterThan(0);
      expect(checkpoint.nextPopulation.length).toBeGreaterThan(0);
      expect(checkpoint.history).toHaveLength(index + 1);
    });
  });

  it('is deterministic for a given seed', async () => {
    const repeat = await runSearch(POPULATION, options({ generations: 2 }));
    const prefix = await runSearch(POPULATION, options({ generations: 2 }));
    expect(repeat.population.map((deck) => deck.hash)).toEqual(
      prefix.population.map((deck) => deck.hash),
    );
    expect(JSON.stringify(repeat.fitness)).toBe(JSON.stringify(prefix.fitness));
    expect(JSON.stringify(repeat.history)).toBe(JSON.stringify(prefix.history));
  }, 120_000);

  it('resumes from a checkpoint and lands exactly where the whole run did', async () => {
    // The checkpoint carries the already-bred next population: re-breeding on
    // resume would consume the generation seed twice and silently diverge.
    const resumed = await runSearch(POPULATION, options(), checkpoints[0] as SearchCheckpoint);
    expect(resumed.population.map((deck) => deck.hash)).toEqual(
      result.population.map((deck) => deck.hash),
    );
    expect(resumed.history.map((entry) => entry.generation)).toEqual([0, 1, 2]);
    expect(JSON.stringify(resumed.fitness)).toBe(JSON.stringify(result.fitness));
  }, 120_000);

  it('gives no credit for winning through abnormal terminations', async () => {
    const stalled = await runSearch(
      POPULATION,
      options({ generations: 1, limits: { ...FAST_LIMITS, maxTurns: 2 } }),
    );
    expect(stalled.history[0]?.abnormalMatches).toBeGreaterThan(0);
    expect(stalled.history[0]?.notes.join(' ')).toMatch(/abnormally/);
    for (const entry of stalled.fitness) {
      expect(entry.matches).toBe(0);
      expect(entry.winRate).toBe(0);
    }
  }, 120_000);
});

describe('hall of fame', () => {
  /**
   * CLAUDE.md §13.15 item 15. The property is that the archive is not simply the
   * top N by score: if it were, a population could beat a counter once, drop it
   * from the field, and then look dominant against a field that no longer
   * contains the thing that beats it.
   */
  it('keeps a low-scoring but distant deck rather than only the best', () => {
    const winners = [0, 1, 2, 3].map((index) =>
      fixtureDeck(`winner_${index}`, 'prototype_commander_blue', [
        ['fixture_dominant_unit', 6 - index],
        ['fixture_baseline_unit', 6 + index],
      ]),
    );
    const population = [...winners, counterDeck];
    const fitness: Fitness[] = population.map((deck, index) => ({
      deckHash: deck.hash,
      score: deck.hash === counterDeck.hash ? 0.05 : 0.9 - index * 0.01,
      winRate: 0.5,
      winRateLow: 0.3,
      winRateHigh: 0.7,
      matches: 20,
      opponentBreadth: 0.5,
      seatRobustness: 0.5,
      novelty: 0.5,
      penalty: 0,
      penaltyReasons: [],
    }));

    const archive = updateArchive([], population, fitness, 4);
    expect(archive).toHaveLength(4);
    // The distant, worst-scoring counter survives on distance alone.
    expect(archive.map((deck) => deck.hash)).toContain(counterDeck.hash);
  });

  it('never grows past its limit and is deterministically ordered', () => {
    const decks = generatePopulation(env, 'archive-pop', 8).decks;
    const fitness: Fitness[] = decks.map((deck, index) => ({
      deckHash: deck.hash,
      score: 1 - index * 0.1,
      winRate: 0.5,
      winRateLow: 0.3,
      winRateHigh: 0.7,
      matches: 10,
      opponentBreadth: 0.5,
      seatRobustness: 0.5,
      novelty: 0.5,
      penalty: 0,
      penaltyReasons: [],
    }));
    const archive = updateArchive([], decks, fitness, 5);
    expect(archive).toHaveLength(5);
    expect(archive.map((deck) => deck.hash)).toEqual([...archive.map((deck) => deck.hash)].sort());
    expect(updateArchive([], decks, fitness, 5).map((deck) => deck.hash)).toEqual(
      archive.map((deck) => deck.hash),
    );
  });

  it('carries the older counter forward as an opponent the population must still beat', () => {
    expect(result.archive.map((deck) => deck.hash)).toContain(counterDeck.hash);

    // And the archive is genuinely older than the population: it holds seed decks
    // that breeding has since replaced.
    const current = new Set(result.population.map((deck) => deck.hash));
    const retired = result.archive.filter((deck) => !current.has(deck.hash));
    expect(retired.length).toBeGreaterThan(0);
    expect(new Set(result.archive.map((deck) => deck.commanderId)).size).toBeGreaterThan(1);
  });
});
