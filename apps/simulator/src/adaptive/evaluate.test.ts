import { describe, expect, it } from 'vitest';
import { makeDeck, type SimDeck } from '@tcg/deck-generator';
import { tinyEnvironment, VALUE_PILOT } from '../test-fixtures.js';
import {
  adaptiveRevisionSeedPath,
  makeAdaptiveRevision,
  type AdaptiveRevision,
} from './revision.js';
import type { AdaptiveConfig } from './config.js';
import {
  adaptiveObjectiveOf,
  scheduleAdaptiveCandidateScreening,
  tallyAdaptiveScreening,
  type AdaptiveCandidateScreeningInput,
} from './evaluate.js';

/**
 * M08.17B: scheduling and attributing a candidate revision's own screening
 * games, separately for the current opponent revision and (only under a
 * `meta_aware` objective with a non-empty field) a configured reference
 * field. Deciding or promoting from the resulting tallies stays M08.17C's job
 * (`./evaluate.ts` top-of-file comment).
 */

const environment = tinyEnvironment();

/** `extra` shifts a card's quantity so decks with different `extra` values hash differently (deckHash is quantity-sensitive). */
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

function candidateRevision(label: string, revisionDeck: SimDeck): AdaptiveRevision {
  return makeAdaptiveRevision({
    experimentId: 'eval-test',
    parentRevisionId: null,
    generation: 0,
    block: 0,
    opponentRevisionId: null,
    construction: 'root',
    seedPath: adaptiveRevisionSeedPath(`eval-fixture-seed-${label}`, 'eval-test', 0, 0),
    deck: revisionDeck,
  });
}

function baseConfig(overrides: Partial<AdaptiveConfig> = {}): AdaptiveConfig {
  return {
    schemaVersion: 1,
    id: 'eval-test',
    label: '',
    seed: 'eval-fixture-seed',
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
    finalValidationGames: 50,
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<AdaptiveCandidateScreeningInput> = {},
): AdaptiveCandidateScreeningInput {
  return {
    environment,
    config: baseConfig(),
    candidate: candidateRevision('candidate', deck('candidate')),
    block: 0,
    opponentDeck: deck('opponent', 10),
    referenceField: [],
    pilots: [VALUE_PILOT],
    ...overrides,
  };
}

describe('adaptiveObjectiveOf', () => {
  it('is pure_counter at a zero reference-field share', () => {
    expect(adaptiveObjectiveOf({ referenceFieldShare: 0 })).toBe('pure_counter');
  });

  it('is meta_aware at any positive reference-field share', () => {
    expect(adaptiveObjectiveOf({ referenceFieldShare: 0.01 })).toBe('meta_aware');
    expect(adaptiveObjectiveOf({ referenceFieldShare: 1 })).toBe('meta_aware');
  });
});

describe('scheduleAdaptiveCandidateScreening', () => {
  it('schedules only opponent games under a pure_counter objective', () => {
    const input = baseInput({
      config: baseConfig({ blockSize: 10, mirrorSeats: false, referenceFieldShare: 0 }),
    });
    const screening = scheduleAdaptiveCandidateScreening(input);
    expect(screening.objective).toBe('pure_counter');
    expect(screening.opponentMatches).toHaveLength(10);
    expect(screening.fieldMatches).toHaveLength(0);
  });

  it('splits the block between opponent and reference-field games under a meta_aware objective', () => {
    const field = [deck('field-a', 1), deck('field-b', 2), deck('field-c', 3)];
    const input = baseInput({
      config: baseConfig({ blockSize: 10, mirrorSeats: false, referenceFieldShare: 0.3 }),
      referenceField: field,
    });
    const screening = scheduleAdaptiveCandidateScreening(input);
    expect(screening.objective).toBe('meta_aware');
    expect(screening.fieldMatches).toHaveLength(3);
    expect(screening.opponentMatches).toHaveLength(7);
  });

  it('falls back to opponent-only screening when the reference field is empty', () => {
    const input = baseInput({
      config: baseConfig({ blockSize: 10, mirrorSeats: false, referenceFieldShare: 0.5 }),
      referenceField: [],
    });
    const screening = scheduleAdaptiveCandidateScreening(input);
    expect(screening.objective).toBe('meta_aware');
    expect(screening.fieldMatches).toHaveLength(0);
    expect(screening.opponentMatches).toHaveLength(10);
  });

  it('caps reference-field selection at the number of distinct decks available', () => {
    const field = [deck('field-a', 1), deck('field-b', 2)];
    const input = baseInput({
      config: baseConfig({ blockSize: 10, mirrorSeats: false, referenceFieldShare: 0.8 }),
      referenceField: field,
    });
    const screening = scheduleAdaptiveCandidateScreening(input);
    expect(screening.fieldMatches).toHaveLength(2);
    expect(screening.opponentMatches).toHaveLength(2);
  });

  it('attributes every screening match to the candidate revision and its own seed path', () => {
    const candidate = candidateRevision('candidate', deck('candidate'));
    const field = [deck('field-a', 1)];
    const input = baseInput({
      candidate,
      config: baseConfig({ blockSize: 4, mirrorSeats: false, referenceFieldShare: 0.5 }),
      referenceField: field,
    });
    const screening = scheduleAdaptiveCandidateScreening(input);
    for (const entry of [...screening.opponentMatches, ...screening.fieldMatches]) {
      expect(entry.revisionId).toBe(candidate.revisionId);
      expect(entry.seedPath.startsWith(candidate.seedPath)).toBe(true);
    }
    expect(
      screening.opponentMatches.every(
        (entry) => entry.opponentDeckHash === input.opponentDeck.hash,
      ),
    ).toBe(true);
    expect(screening.fieldMatches.every((entry) => entry.opponentDeckHash === field[0]!.hash)).toBe(
      true,
    );
  });

  it('is deterministic: identical input produces an identical schedule', () => {
    const field = [deck('field-a', 1), deck('field-b', 2)];
    const input = baseInput({
      config: baseConfig({ blockSize: 6, mirrorSeats: true, referenceFieldShare: 0.5 }),
      referenceField: field,
    });
    expect(scheduleAdaptiveCandidateScreening(input)).toEqual(
      scheduleAdaptiveCandidateScreening(input),
    );
  });

  it('doubles both groups across mirrored seat orientations', () => {
    const field = [deck('field-a', 1)];
    const input = baseInput({
      config: baseConfig({ blockSize: 4, mirrorSeats: true, referenceFieldShare: 0.5 }),
      referenceField: field,
    });
    const screening = scheduleAdaptiveCandidateScreening(input);
    expect(screening.fieldMatches).toHaveLength(2);
    expect(screening.opponentMatches).toHaveLength(4);
  });
});

describe('tallyAdaptiveScreening', () => {
  it('tallies wins and leaves field null when no field games were scheduled', () => {
    const candidate = candidateRevision('candidate', deck('candidate'));
    const input = baseInput({
      candidate,
      config: baseConfig({ blockSize: 3, mirrorSeats: false, referenceFieldShare: 0 }),
    });
    const screening = scheduleAdaptiveCandidateScreening(input);
    const results = [
      { matchId: screening.opponentMatches[0]!.match.matchId, winnerDeckHash: candidate.deck.hash },
      {
        matchId: screening.opponentMatches[1]!.match.matchId,
        winnerDeckHash: input.opponentDeck.hash,
      },
      // the third match is left out of `results` entirely to exercise noResult.
    ];
    const tallies = tallyAdaptiveScreening(screening, candidate.deck.hash, results);
    expect(tallies.opponent).toEqual({ candidateWins: 1, opponentWins: 1, noResult: 1 });
    expect(tallies.field).toBeNull();
  });

  it('keeps field tallies separate from opponent tallies', () => {
    const candidate = candidateRevision('candidate', deck('candidate'));
    const field = [deck('field-a', 1)];
    const input = baseInput({
      candidate,
      config: baseConfig({ blockSize: 4, mirrorSeats: false, referenceFieldShare: 0.5 }),
      referenceField: field,
    });
    const screening = scheduleAdaptiveCandidateScreening(input);
    const results = [
      ...screening.opponentMatches.map((entry) => ({
        matchId: entry.match.matchId,
        winnerDeckHash: candidate.deck.hash,
      })),
      ...screening.fieldMatches.map((entry) => ({
        matchId: entry.match.matchId,
        winnerDeckHash: entry.opponentDeckHash,
      })),
    ];
    const tallies = tallyAdaptiveScreening(screening, candidate.deck.hash, results);
    expect(tallies.opponent).toEqual({
      candidateWins: screening.opponentMatches.length,
      opponentWins: 0,
      noResult: 0,
    });
    expect(tallies.field).toEqual({
      candidateWins: 0,
      opponentWins: screening.fieldMatches.length,
      noResult: 0,
    });
  });
});
