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
import { runAdaptiveExperiment, runAdaptiveFinalValidation, type AdaptiveRawEvent } from './run.js';
import { ADAPTIVE_CONFIG_SCHEMA_VERSION } from './version.js';

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
    schemaVersion: ADAPTIVE_CONFIG_SCHEMA_VERSION,
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
    pilotIds: ['value'],
    limits: FAST_LIMITS,
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

  it('always re-emits onRawEvent for a phase an earlier, interrupted attempt already decided', async () => {
    const resumedStore = newStore();
    const startCheckpoint = freshCheckpoint();
    const firstEvents: AdaptiveRawEvent[] = [];
    // Stops after block 0's 2 games plus the first screening game — block 0
    // (and its generation record) are fully decided and emitted before the
    // interruption; the generation's screening round is not.
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
      onRawEvent: (event) => {
        firstEvents.push(event);
      },
    });
    await expect(firstAttempt).rejects.toThrow(ExperimentStopped);
    expect(firstEvents.map((event) => event.kind)).toEqual(['series', 'generation']);

    const resumedEvents: AdaptiveRawEvent[] = [];
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
      onRawEvent: (event) => {
        resumedEvents.push(event);
      },
    });

    expect(resumed.nextBlock).toBe(1);
    // Block 0's `series` and `generation` are deterministically recomputed
    // from already-committed matches (M08.R5 removed the old suppression
    // that assumed a recomputed phase had always already been persisted),
    // so this attempt re-decides and re-emits both — byte-identical to the
    // first attempt's copies — relying on a caller's idempotent
    // upsert-by-`block` to collapse them rather than on this file ever
    // withholding a re-emission itself.
    expect(resumedEvents.map((event) => event.kind)).toEqual([
      'series',
      'generation',
      'screeningRound',
    ]);
    expect(resumedEvents[0]).toEqual(firstEvents[0]);
    expect(resumedEvents[1]).toEqual(firstEvents[1]);
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

/**
 * M08.R5's four required fault-injection points, at the level this file
 * actually controls: a crash mid-`onRawEvent` (after matches committed, before
 * that phase's raw event persists), a crash mid-`onCheckpoint` (after the raw
 * event persists, before the checkpoint advance persists), and a crash that
 * lands cleanly after a checkpoint advance already persisted but before the
 * next phase begins — the one case where a real caller's next attempt starts
 * from an *advanced* checkpoint rather than the pre-attempt one `run.test.ts`'s
 * other resume tests always reuse. The fourth point — immediately before
 * final result publication — has no equivalent inside this file at all:
 * `runAdaptiveExperiment` never builds a final result, so that point is
 * exercised at the job-runner level instead
 * (`job-runner-adaptive.test.ts`).
 */
describe('crash-safe raw evidence (M08.R5)', () => {
  it('resumes correctly from a crash inside onRawEvent, after matches committed but before that phase’s raw event persisted', async () => {
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

    const crashStore = newStore();
    const crashCheckpoint = freshCheckpoint();
    let rawCalls = 0;
    const crashing = runAdaptiveExperiment({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: crashStore,
      checkpoint: crashCheckpoint,
      onRawEvent: () => {
        rawCalls += 1;
        if (rawCalls === 1) throw new Error('simulated crash before raw-event persistence');
      },
    });
    await expect(crashing).rejects.toThrow('simulated crash before raw-event persistence');
    // Block 0's 2 games are committed to the sink even though the crash
    // prevented this phase's raw event from ever being persisted.
    expect(crashStore.all()).toHaveLength(2);

    const events: AdaptiveRawEvent[] = [];
    const resumed = await runAdaptiveExperiment({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: crashStore,
      checkpoint: crashCheckpoint,
      onRawEvent: (event) => {
        events.push(event);
      },
    });

    expect(resumed).toEqual(uninterrupted);
    expect(events.map((event) => event.kind)).toEqual(['series', 'generation', 'screeningRound']);
    expect(crashStore.all()).toHaveLength(6);
    expect(new Set(crashStore.all().map((record) => record.matchId)).size).toBe(6);
  });

  it('resumes correctly from a crash inside onCheckpoint, after that phase’s raw event persisted but before its checkpoint advance', async () => {
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

    const crashStore = newStore();
    const crashCheckpoint = freshCheckpoint();
    const persistedEvents: AdaptiveRawEvent[] = [];
    let checkpointCalls = 0;
    const crashing = runAdaptiveExperiment({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: crashStore,
      checkpoint: crashCheckpoint,
      onRawEvent: (event) => {
        persistedEvents.push(event);
      },
      onCheckpoint: () => {
        checkpointCalls += 1;
        if (checkpointCalls === 1) throw new Error('simulated crash before checkpoint persistence');
      },
    });
    await expect(crashing).rejects.toThrow('simulated crash before checkpoint persistence');
    // Block 0 decisively wins, so `playBlock` emits both its `series` record
    // and the losing lineage's `generation` record before calling
    // `onCheckpoint` once for that whole decided phase — both persisted even
    // though the crash prevented this phase's checkpoint advance
    // (pendingGeneration) from ever reaching disk.
    expect(persistedEvents.map((event) => event.kind)).toEqual(['series', 'generation']);

    const events: AdaptiveRawEvent[] = [];
    const resumed = await runAdaptiveExperiment({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: crashStore,
      checkpoint: crashCheckpoint, // still the original, pre-crash checkpoint
      onRawEvent: (event) => {
        events.push(event);
      },
    });

    expect(resumed).toEqual(uninterrupted);
    // Block 0 is re-decided (its matches are already committed) and both of
    // its raw events re-emitted — identical to the crashed attempt's copies —
    // before the run continues past where the crash stopped it.
    expect(events.map((event) => event.kind)).toEqual(['series', 'generation', 'screeningRound']);
    expect(events[0]).toEqual(persistedEvents[0]);
    expect(events[1]).toEqual(persistedEvents[1]);
  });

  it('resumes correctly from a crash that lands after one phase’s checkpoint durably advanced but before the next phase began', async () => {
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

    const crashStore = newStore();
    let persistedCheckpoint: AdaptiveCheckpoint | null = null;
    const crashing = runAdaptiveExperiment({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: crashStore,
      checkpoint: freshCheckpoint(),
      onCheckpoint: (next) => {
        if (persistedCheckpoint !== null) {
          throw new Error('simulated crash after the first checkpoint durably advanced');
        }
        persistedCheckpoint = next;
      },
    });
    await expect(crashing).rejects.toThrow(
      'simulated crash after the first checkpoint durably advanced',
    );
    if (persistedCheckpoint === null) throw new Error('onCheckpoint never fired.');
    // `persistedCheckpoint` is reassigned only inside the `onCheckpoint`
    // closure above, so TS's control-flow analysis cannot see past its
    // initializer and narrows every direct read of it to `null` even here,
    // after the runtime-null guard. Binding it to a freshly, explicitly
    // typed const is the escape: assigning that already-excluded-null
    // (`never`) value into a `: AdaptiveCheckpoint` binding is always
    // permitted, and every read of the new binding is properly typed.
    const crashCheckpoint: AdaptiveCheckpoint = persistedCheckpoint;
    expect(crashCheckpoint.pendingGeneration).not.toBeNull();

    // A real caller (the job runner) reloads whatever checkpoint it last
    // durably persisted — here, the advanced one a crash right after
    // `onCheckpoint` resolved still leaves on disk — rather than replaying
    // from the pre-attempt checkpoint this file's other resume tests reuse.
    const events: AdaptiveRawEvent[] = [];
    const resumed = await runAdaptiveExperiment({
      environment,
      config: baseConfig(),
      experimentKind: 'batch',
      pilots: [VALUE_PILOT],
      limits: FAST_LIMITS,
      retention: NO_RETENTION,
      workers: 1,
      sink: crashStore,
      checkpoint: crashCheckpoint,
      onRawEvent: (event) => {
        events.push(event);
      },
    });

    expect(resumed).toEqual(uninterrupted);
    // Block 0 is never re-decided this attempt — the checkpoint handed in
    // already names it done — so only the generation's screening round fires.
    expect(events.map((event) => event.kind)).toEqual(['screeningRound']);
    expect(crashStore.all()).toHaveLength(6);
    expect(new Set(crashStore.all().map((record) => record.matchId)).size).toBe(6);
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
