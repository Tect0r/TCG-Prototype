import { describe, expect, it } from 'vitest';
import { makeDeck, type SimDeck } from '@tcg/deck-generator';
import { tinyEnvironment, VALUE_PILOT, AGGRESSIVE_PILOT } from '../test-fixtures.js';
import type { AdaptiveConfig } from './config.js';
import type { AdaptiveCheckpoint } from './checkpoint.js';
import {
  adaptiveGenerationRecordSchema,
  type AdaptiveGenerationRecord,
} from './generate.js';
import { adaptiveRevisionSeedPath, makeAdaptiveRevision, type AdaptiveRevision } from './revision.js';
import {
  adaptiveValidationSeedPath,
  adaptiveValidationStanding,
  freezeAdaptiveFinalDecks,
  scheduleAdaptiveValidation,
  tallyAdaptiveValidation,
  type AdaptiveFrozenDecks,
  type AdaptiveValidationScheduleInput,
} from './validate.js';

/**
 * M08.18C: freezing a checkpoint's final decks, scheduling the fresh-seed
 * mirrored validation stage on a seed family that shares nothing with any
 * block or screening seed, and tallying/standing derived only from that
 * stage's own results. Actually playing the validation games is
 * `./run.ts`'s `runAdaptiveFinalValidation` (`./validate.ts` top-of-file
 * comment).
 */

const environment = tinyEnvironment();

function deck(label: string, extra = 0): SimDeck {
  return makeDeck({
    id: label,
    label,
    commanderId: 'prototype_commander_blue',
    cards: [
      { cardId: 'prototype_scout', quantity: 2 + extra },
      { cardId: 'prototype_guard', quantity: 2 },
    ],
  });
}

function revision(revisionDeck: SimDeck): AdaptiveRevision {
  return makeAdaptiveRevision({
    experimentId: 'validate-test',
    parentRevisionId: null,
    generation: 0,
    block: 0,
    opponentRevisionId: null,
    construction: 'root',
    seedPath: adaptiveRevisionSeedPath('validate-fixture-seed', 'validate-test', 0, 0),
    deck: revisionDeck,
  });
}

function baseConfig(overrides: Partial<AdaptiveConfig> = {}): AdaptiveConfig {
  return {
    schemaVersion: 1,
    id: 'validate-test',
    label: '',
    seed: 'validate-fixture-seed',
    output: 'results',
    environment: environment.config,
    startingDecks: { kind: 'precon', preconIds: ['some_precon'] },
    commanderPolicy: 'locked',
    selectedCommanderIds: [],
    informationPolicy: 'public_observation',
    totalLearningBudget: 1000,
    blockSize: 20,
    mirrorSeats: true,
    candidateCount: 6,
    swapBound: { minCards: 1, maxCards: 3 },
    rebuildTrigger: null,
    referenceFieldShare: 0,
    retention: { replaySampleRate: 50, keepLogs: false, keepDecisions: false },
    finalValidationGames: 25,
    ...overrides,
  };
}

function baseCheckpoint(overrides: Partial<AdaptiveCheckpoint> = {}): AdaptiveCheckpoint {
  const incumbentRoot = revision(deck('incumbent'));
  const opponentRoot = revision(deck('opponent', 10));
  return {
    schemaVersion: 2,
    experimentId: 'validate-test',
    configHash: 'a-config-hash',
    lineages: {
      incumbent: { activeRevisionId: incumbentRoot.revisionId, revisions: [incumbentRoot] },
      opponent: { activeRevisionId: opponentRoot.revisionId, revisions: [opponentRoot] },
    },
    gamesSpent: 400,
    referenceField: [],
    pendingGeneration: null,
    nextGeneration: 1,
    nextBlock: 3,
    nextSeedPath: adaptiveRevisionSeedPath('validate-fixture-seed', 'validate-test', 1, 3),
    ...overrides,
  };
}

function pendingGenerationFor(checkpoint: AdaptiveCheckpoint): AdaptiveGenerationRecord {
  const incumbentRoot = checkpoint.lineages.incumbent.revisions[0]!;
  const opponentRoot = checkpoint.lineages.opponent.revisions[0]!;
  const candidate = makeAdaptiveRevision({
    experimentId: incumbentRoot.experimentId,
    parentRevisionId: incumbentRoot.revisionId,
    generation: incumbentRoot.generation + 1,
    block: checkpoint.nextBlock,
    opponentRevisionId: opponentRoot.revisionId,
    construction: 'swap',
    swaps: [{ cardOut: 'prototype_guard', cardIn: 'prototype_scout' }],
    seedPath: adaptiveRevisionSeedPath(
      'validate-fixture-seed',
      incumbentRoot.experimentId,
      incumbentRoot.generation + 1,
      checkpoint.nextBlock,
    ),
    deck: deck('incumbent-swap', 3),
  });
  return adaptiveGenerationRecordSchema.parse({
    generation: checkpoint.nextGeneration,
    block: checkpoint.nextBlock,
    informationPolicy: 'public_observation',
    incumbentRevisionId: incumbentRoot.revisionId,
    opponentRevisionId: opponentRoot.revisionId,
    candidates: [candidate],
    rejected: [],
  });
}

function frozenDecks(): AdaptiveFrozenDecks {
  return freezeAdaptiveFinalDecks(baseCheckpoint());
}

function baseScheduleInput(
  overrides: Partial<AdaptiveValidationScheduleInput> = {},
): AdaptiveValidationScheduleInput {
  return {
    environment,
    config: baseConfig(),
    decks: frozenDecks(),
    pilots: [VALUE_PILOT],
    ...overrides,
  };
}

describe('freezeAdaptiveFinalDecks', () => {
  it('freezes each lineage\'s currently active revision and deck', () => {
    const checkpoint = baseCheckpoint();
    const frozen = freezeAdaptiveFinalDecks(checkpoint);
    expect(frozen.incumbent.revisionId).toBe(checkpoint.lineages.incumbent.activeRevisionId);
    expect(frozen.incumbent.deck.hash).toBe(checkpoint.lineages.incumbent.revisions[0]!.deck.hash);
    expect(frozen.opponent.revisionId).toBe(checkpoint.lineages.opponent.activeRevisionId);
    expect(frozen.opponent.deck.hash).toBe(checkpoint.lineages.opponent.revisions[0]!.deck.hash);
  });

  it('refuses a checkpoint with an undecided pending generation', () => {
    const checkpoint = baseCheckpoint();
    const partial: AdaptiveCheckpoint = {
      ...checkpoint,
      pendingGeneration: pendingGenerationFor(checkpoint),
    };
    expect(() => freezeAdaptiveFinalDecks(partial)).toThrow(/undecided pending generation/);
  });
});

describe('adaptiveValidationSeedPath', () => {
  it('is deterministic for the same experiment seed and id', () => {
    expect(adaptiveValidationSeedPath('root-seed', 'exp')).toBe(
      adaptiveValidationSeedPath('root-seed', 'exp'),
    );
  });

  it('never collides with any generation/block seed path the learning series derives', () => {
    const validationPath = adaptiveValidationSeedPath('root-seed', 'exp');
    // A representative sample of block/generation seed paths a real run could
    // reach; none should ever equal the validation stage's own fresh branch.
    for (const generation of [0, 1, 5]) {
      for (const block of [0, 1, 42]) {
        expect(adaptiveRevisionSeedPath('root-seed', 'exp', generation, block)).not.toBe(
          validationPath,
        );
      }
    }
  });
});

describe('scheduleAdaptiveValidation', () => {
  it('schedules finalValidationGames x2 games when seats are mirrored', () => {
    const matches = scheduleAdaptiveValidation(baseScheduleInput());
    expect(matches).toHaveLength(50);
    expect(matches.every((match) => match.seats.length === 2)).toBe(true);
  });

  it('schedules exactly finalValidationGames games when seats are not mirrored', () => {
    const matches = scheduleAdaptiveValidation(
      baseScheduleInput({ config: baseConfig({ mirrorSeats: false }) }),
    );
    expect(matches).toHaveLength(25);
  });

  it('is deterministic: identical input produces an identical schedule', () => {
    const first = scheduleAdaptiveValidation(baseScheduleInput());
    const second = scheduleAdaptiveValidation(baseScheduleInput());
    expect(second).toEqual(first);
  });

  it('seats exactly the two frozen decks, never a third', () => {
    const decks = frozenDecks();
    const matches = scheduleAdaptiveValidation(baseScheduleInput({ decks }));
    const seatedIndices = new Set(
      matches.flatMap((match) => match.seats.map((seat) => seat.deckIndex)),
    );
    expect(seatedIndices).toEqual(new Set([0, 1]));
    expect(matches.every((match) => match.seats.length === 2)).toBe(true);
  });

  it('derives every game seed from the validation seed path, not a block/generation one', () => {
    const config = baseConfig();
    const validationMatches = scheduleAdaptiveValidation(baseScheduleInput({ config }));
    const validationPath = adaptiveValidationSeedPath(config.seed, config.id);
    expect(validationMatches.length).toBeGreaterThan(0);
    for (const match of validationMatches) {
      expect(match.seeds.path.startsWith(validationPath)).toBe(true);
    }
  });

  it('scales with more pilots the same way other adaptive schedules do', () => {
    const single = scheduleAdaptiveValidation(baseScheduleInput({ pilots: [VALUE_PILOT] }));
    const doubled = scheduleAdaptiveValidation(
      baseScheduleInput({ pilots: [VALUE_PILOT, AGGRESSIVE_PILOT] }),
    );
    expect(doubled).toHaveLength(single.length * 2);
  });
});

describe('tallyAdaptiveValidation', () => {
  it('tallies incumbent, opponent and noResult separately', () => {
    const decks = frozenDecks();
    const results = [
      { matchId: 'm1', winnerDeckHash: decks.incumbent.deck.hash },
      { matchId: 'm2', winnerDeckHash: decks.incumbent.deck.hash },
      { matchId: 'm3', winnerDeckHash: decks.opponent.deck.hash },
      { matchId: 'm4', winnerDeckHash: null },
    ];
    expect(tallyAdaptiveValidation(decks, results)).toEqual({
      incumbentWins: 2,
      opponentWins: 1,
      noResult: 1,
    });
  });

  it('is zero across the board for an empty result set', () => {
    const decks = frozenDecks();
    expect(tallyAdaptiveValidation(decks, [])).toEqual({
      incumbentWins: 0,
      opponentWins: 0,
      noResult: 0,
    });
  });
});

describe('adaptiveValidationStanding', () => {
  it('is the incumbent\'s win rate over decisive games, noResult excluded', () => {
    const standing = adaptiveValidationStanding({
      incumbentWins: 15,
      opponentWins: 5,
      noResult: 3,
    });
    expect(standing.successes).toBe(15);
    expect(standing.total).toBe(20);
    expect(standing.point).toBeCloseTo(0.75, 5);
  });

  it('never reads series or screening evidence: identical outcomes always produce identical standings', () => {
    const outcome = { incumbentWins: 7, opponentWins: 3, noResult: 0 };
    expect(adaptiveValidationStanding(outcome)).toEqual(adaptiveValidationStanding({ ...outcome }));
  });
});
