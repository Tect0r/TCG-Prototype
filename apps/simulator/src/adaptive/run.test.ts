import { describe, expect, it } from 'vitest';
import { makeDeck, type SimDeck } from '@tcg/deck-generator';
import { MatchStore } from '../reporting/match-store.js';
import { FAST_LIMITS, NO_RETENTION, VALUE_PILOT, tinyEnvironment } from '../test-fixtures.js';
import { ExperimentStopped, type StopSignal } from '../stop.js';
import type { AdaptiveConfig } from './config.js';
import {
  adaptiveRevisionSeedPath,
  makeAdaptiveRevision,
  type AdaptiveRevision,
} from './revision.js';
import type { AdaptiveCheckpoint } from './checkpoint.js';
import { runAdaptiveExperiment, runAdaptiveFinalValidation } from './run.js';

/**
 * M08.18B: resumable orchestration.
 *
 * Every earlier adaptive file only schedules, generates or decides; this
 * suite is the first to actually drive `runAdaptiveExperiment` through real
 * matches and prove the property `./run.ts`'s own doc comment claims —  an
 * attempt interrupted by `ExperimentStopped` and then retried with the same
 * checkpoint against the same `MatchStore` reaches the exact same final
 * checkpoint (lineages, `gamesSpent`, seed paths) as an uninterrupted run,
 * and never replays a match the interrupted attempt already committed.
 */

const environment = tinyEnvironment();

const SEED = 'run-fixture-seed';
const EXPERIMENT_ID = 'run-test';

function weakDeck(id: string, commanderId: string): SimDeck {
  return makeDeck({
    id,
    label: id,
    commanderId,
    cards: [
      { cardId: 'prototype_drone', quantity: 2 },
      { cardId: 'prototype_scout', quantity: 2 },
      { cardId: 'prototype_guard', quantity: 2 },
      { cardId: 'trench_guard', quantity: 2 },
      { cardId: 'unstable_construct', quantity: 2 },
      { cardId: 'surveyors_lens', quantity: 2 },
    ],
  });
}

function dominantDeck(id: string, commanderId: string): SimDeck {
  return makeDeck({
    id,
    label: id,
    commanderId,
    cards: [
      { cardId: 'fixture_dominant_unit', quantity: 2 },
      { cardId: 'prototype_scout', quantity: 2 },
      { cardId: 'prototype_guard', quantity: 2 },
      { cardId: 'trench_guard', quantity: 2 },
      { cardId: 'unstable_construct', quantity: 2 },
      { cardId: 'surveyors_lens', quantity: 2 },
    ],
  });
}

function root(deck: SimDeck): AdaptiveRevision {
  return makeAdaptiveRevision({
    experimentId: EXPERIMENT_ID,
    parentRevisionId: null,
    generation: 0,
    block: 0,
    opponentRevisionId: null,
    construction: 'root',
    seedPath: adaptiveRevisionSeedPath(SEED, EXPERIMENT_ID, 0, 0),
    deck,
  });
}

/**
 * One decisive block (2 mirrored games) plus one full generation's screening
 * (2 candidates x 2 mirrored games each, `referenceFieldShare: 0`) is exactly
 * 6 games; the next block would need 2 more and 0 remain, so the run stops
 * cleanly right after promotion instead of drifting into a second block.
 */
function baseConfig(overrides: Partial<AdaptiveConfig> = {}): AdaptiveConfig {
  return {
    schemaVersion: 1,
    id: EXPERIMENT_ID,
    label: '',
    seed: SEED,
    output: 'results',
    environment: environment.config,
    startingDecks: { kind: 'precon', preconIds: ['some_precon'] },
    commanderPolicy: 'locked',
    selectedCommanderIds: [],
    informationPolicy: 'public_observation',
    totalLearningBudget: 6,
    blockSize: 1,
    mirrorSeats: true,
    candidateCount: 2,
    swapBound: { minCards: 1, maxCards: 1 },
    rebuildTrigger: null,
    referenceFieldShare: 0,
    retention: NO_RETENTION,
    finalValidationGames: 1,
    ...overrides,
  };
}

function freshCheckpoint(): AdaptiveCheckpoint {
  const incumbentRoot = root(weakDeck('incumbent-root', 'prototype_commander_blue'));
  const opponentRoot = root(dominantDeck('opponent-root', 'prototype_commander_red'));
  return {
    schemaVersion: 2,
    experimentId: EXPERIMENT_ID,
    configHash: 'run-test-config-hash',
    lineages: {
      incumbent: { activeRevisionId: incumbentRoot.revisionId, revisions: [incumbentRoot] },
      opponent: { activeRevisionId: opponentRoot.revisionId, revisions: [opponentRoot] },
    },
    gamesSpent: 0,
    referenceField: [],
    pendingGeneration: null,
    nextGeneration: 1,
    nextBlock: 0,
    nextSeedPath: adaptiveRevisionSeedPath(SEED, EXPERIMENT_ID, 1, 0),
  };
}

/** Trips only once the caller's job budget is exhausted, then trips forever. */
function stopAfter(count: number): StopSignal {
  let calls = 0;
  return () => {
    calls += 1;
    return calls > count ? 'test-requested stop' : null;
  };
}

function newStore(): MatchStore {
  return new MatchStore(null, {
    experimentId: EXPERIMENT_ID,
    experimentKind: 'batch',
    configHash: 'run-test-config-hash',
  });
}

describe('runAdaptiveExperiment', () => {
  it('decisively resolves a block, generates, screens and promotes, then stops cleanly at budget', async () => {
    const store = newStore();
    const checkpoint = freshCheckpoint();
    const result = await runAdaptiveExperiment({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: store,
      checkpoint,
    });

    expect(result.gamesSpent).toBe(6);
    expect(result.pendingGeneration).toBeNull();
    expect(result.nextBlock).toBe(1);
    // The dominant-deck side decisively won block 0, so the *incumbent*
    // (weak-deck) lineage is the one that generated and (possibly) promoted.
    expect(result.lineages.opponent.activeRevisionId).toBe(
      result.lineages.opponent.revisions[0]?.revisionId,
    );
    expect(store.all()).toHaveLength(6);
    expect(new Set(store.all().map((record) => record.matchId)).size).toBe(6);
  });

  it('reaches the exact same final checkpoint whether uninterrupted or interrupted mid-block and resumed', async () => {
    const uninterruptedStore = newStore();
    const uninterrupted = await runAdaptiveExperiment({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: uninterruptedStore,
      checkpoint: freshCheckpoint(),
    });

    const resumedStore = newStore();
    const startCheckpoint = freshCheckpoint();
    // Block 0 schedules 2 games; stopping after the first interrupts inside it.
    const firstAttempt = runAdaptiveExperiment({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: resumedStore,
      checkpoint: startCheckpoint,
      shouldStop: stopAfter(1),
    });
    await expect(firstAttempt).rejects.toThrow(ExperimentStopped);
    // The interrupted attempt never returned a checkpoint, so the caller's
    // own copy — still the pre-block one — is exactly what gets retried.
    expect(resumedStore.all().length).toBeGreaterThan(0);
    expect(resumedStore.all().length).toBeLessThan(6);

    const resumed = await runAdaptiveExperiment({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: resumedStore,
      checkpoint: startCheckpoint,
    });

    expect(resumed).toEqual(uninterrupted);
    // Never replayed: exactly 6 distinct matches total, not 6 plus whatever
    // the interrupted attempt already committed before it stopped.
    const resumedRecords = resumedStore.all();
    expect(resumedRecords).toHaveLength(6);
    expect(new Set(resumedRecords.map((record) => record.matchId)).size).toBe(6);
    expect(resumedRecords.map((record) => record.matchId).sort()).toEqual(
      uninterruptedStore
        .all()
        .map((record) => record.matchId)
        .sort(),
    );
  });

  it('reaches the same final checkpoint when interrupted mid-generation screening and resumed', async () => {
    const uninterruptedStore = newStore();
    const uninterrupted = await runAdaptiveExperiment({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: uninterruptedStore,
      checkpoint: freshCheckpoint(),
    });

    const resumedStore = newStore();
    const startCheckpoint = freshCheckpoint();
    // Block 0 (2 games) plus the first candidate's first screening game: stop
    // after 3 dispatched jobs lands inside the generation's screening phase,
    // after `pendingGeneration` was already committed to the checkpoint.
    const firstAttempt = runAdaptiveExperiment({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: resumedStore,
      checkpoint: startCheckpoint,
      shouldStop: stopAfter(3),
    });
    await expect(firstAttempt).rejects.toThrow(ExperimentStopped);
    expect(resumedStore.all().length).toBeGreaterThan(2);
    expect(resumedStore.all().length).toBeLessThan(6);

    const resumed = await runAdaptiveExperiment({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: resumedStore,
      checkpoint: startCheckpoint,
    });

    expect(resumed).toEqual(uninterrupted);
    const resumedRecords = resumedStore.all();
    expect(resumedRecords).toHaveLength(6);
    expect(new Set(resumedRecords.map((record) => record.matchId)).size).toBe(6);
  });

  it('stops without spending a game once the budget no longer affords the next block', async () => {
    const store = newStore();
    const result = await runAdaptiveExperiment({
      environment,
      config: baseConfig({ totalLearningBudget: 1 }),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: store,
      checkpoint: freshCheckpoint(),
    });

    expect(result.gamesSpent).toBe(0);
    expect(result.nextBlock).toBe(0);
    expect(store.all()).toHaveLength(0);
  });
});

describe('runAdaptiveFinalValidation', () => {
  it('plays the frozen root decks on the validation seed family and tallies only that stage', async () => {
    const store = newStore();
    const validation = await runAdaptiveFinalValidation({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: store,
      checkpoint: freshCheckpoint(),
    });

    // finalValidationGames: 1, mirrorSeats: true -> 2 games, both won by the
    // same dominant-deck side the learning series itself decided block 0 with.
    expect(validation.outcome.incumbentWins + validation.outcome.opponentWins).toBe(2);
    expect(validation.outcome.opponentWins).toBe(2);
    expect(validation.standing.total).toBe(2);
    const records = store.all();
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.experimentId === `${EXPERIMENT_ID}:validation`)).toBe(
      true,
    );
  });

  it('never replays a validation game already recorded for the same checkpoint and store', async () => {
    const store = newStore();
    const checkpoint = freshCheckpoint();
    const options = {
      environment,
      config: baseConfig(),
      experimentKind: 'batch' as const,
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: store,
      checkpoint,
    };

    const first = await runAdaptiveFinalValidation(options);
    const second = await runAdaptiveFinalValidation(options);

    expect(second).toEqual(first);
    expect(store.all()).toHaveLength(2);
  });
});
