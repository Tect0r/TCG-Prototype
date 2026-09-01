import { describe, expect, it } from 'vitest';
import { makeDeck, type SimDeck } from '@tcg/deck-generator';
import { tinyEnvironment, VALUE_PILOT, AGGRESSIVE_PILOT } from '../test-fixtures.js';
import type { AdaptiveConfig } from './config.js';
import {
  adaptiveBlockGameCount,
  decideAdaptiveBlock,
  planAdaptiveBudget,
  scheduleAdaptiveBlock,
  type AdaptiveBlockScheduleInput,
} from './block.js';

/**
 * M08.17A: the mirrored block as the sole decision unit, deterministic tie
 * and no-decision behaviour, and budget arithmetic that schedules only whole
 * blocks — recording an explained shortfall instead of overspending.
 * Evaluating real candidates and promoting on the resulting decision stay
 * M08.17B and M08.17C's jobs (`./block.ts` top-of-file comment).
 */

const environment = tinyEnvironment();

function deck(label: string): SimDeck {
  return makeDeck({
    id: label,
    label,
    commanderId: 'prototype_commander_blue',
    cards: [
      { cardId: 'prototype_scout', quantity: 2 },
      { cardId: 'prototype_guard', quantity: 2 },
    ],
  });
}

function baseConfig(overrides: Partial<AdaptiveConfig> = {}): AdaptiveConfig {
  return {
    schemaVersion: 1,
    id: 'block-test',
    label: '',
    seed: 'block-fixture-seed',
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

function baseScheduleInput(
  overrides: Partial<AdaptiveBlockScheduleInput> = {},
): AdaptiveBlockScheduleInput {
  const config = baseConfig();
  return {
    environment,
    config,
    generation: 1,
    block: 0,
    incumbentDeck: deck('incumbent'),
    opponentDeck: deck('opponent'),
    pilots: [VALUE_PILOT],
    gamesRemaining: 1000,
    ...overrides,
  };
}

describe('decideAdaptiveBlock', () => {
  it('names the side with fewer decisive wins as the loser', () => {
    expect(decideAdaptiveBlock({ incumbentWins: 9, opponentWins: 11, noResult: 0 })).toEqual({
      kind: 'win',
      loser: 'incumbent',
    });
    expect(decideAdaptiveBlock({ incumbentWins: 12, opponentWins: 8, noResult: 0 })).toEqual({
      kind: 'win',
      loser: 'opponent',
    });
  });

  it('never adapts from one isolated loss: a single-game deficit inside a won block stays a win', () => {
    // The incumbent lost exactly one individual game but still holds the block's
    // decisive majority — the block, not the game, is what decideAdaptiveBlock reads.
    expect(decideAdaptiveBlock({ incumbentWins: 15, opponentWins: 1, noResult: 0 })).toEqual({
      kind: 'win',
      loser: 'opponent',
    });
  });

  it('is a tie when decisive wins are equal', () => {
    expect(decideAdaptiveBlock({ incumbentWins: 10, opponentWins: 10, noResult: 0 })).toEqual({
      kind: 'tie',
    });
  });

  it('is no_decision when every scheduled game ended without a counted result', () => {
    const decision = decideAdaptiveBlock({ incumbentWins: 0, opponentWins: 0, noResult: 20 });
    expect(decision.kind).toBe('no_decision');
    if (decision.kind === 'no_decision') {
      expect(decision.reason).toContain('20');
    }
  });

  it('is no_decision when nothing was scheduled at all', () => {
    const decision = decideAdaptiveBlock({ incumbentWins: 0, opponentWins: 0, noResult: 0 });
    expect(decision.kind).toBe('no_decision');
  });

  it('ignores noResult games when a decisive majority already exists', () => {
    expect(decideAdaptiveBlock({ incumbentWins: 11, opponentWins: 5, noResult: 4 })).toEqual({
      kind: 'win',
      loser: 'opponent',
    });
  });
});

describe('adaptiveBlockGameCount', () => {
  it('doubles blockSize when seats are mirrored', () => {
    expect(adaptiveBlockGameCount({ blockSize: 20, mirrorSeats: true })).toBe(40);
  });

  it('is exactly blockSize when seats are not mirrored', () => {
    expect(adaptiveBlockGameCount({ blockSize: 20, mirrorSeats: false })).toBe(20);
  });
});

describe('planAdaptiveBudget', () => {
  it('schedules only whole blocks with no shortfall when the budget divides evenly', () => {
    const plan = planAdaptiveBudget({ totalLearningBudget: 800, blockSize: 20, mirrorSeats: true });
    expect(plan.gamesPerBlock).toBe(40);
    expect(plan.blocksScheduled).toBe(20);
    expect(plan.gamesScheduled).toBe(800);
    expect(plan.shortfall).toBeNull();
  });

  it('records an explained shortfall instead of scheduling a partial final block', () => {
    const plan = planAdaptiveBudget({ totalLearningBudget: 850, blockSize: 20, mirrorSeats: true });
    expect(plan.blocksScheduled).toBe(21);
    expect(plan.gamesScheduled).toBe(840);
    expect(plan.shortfall).not.toBeNull();
    expect(plan.shortfall?.gamesUnspent).toBe(10);
    expect(plan.shortfall?.reason).toContain('850');
    expect(plan.shortfall?.reason).toContain('40');
  });

  it('reports a shortfall of the whole budget when it cannot fund even one block', () => {
    const plan = planAdaptiveBudget({ totalLearningBudget: 15, blockSize: 20, mirrorSeats: true });
    expect(plan.blocksScheduled).toBe(0);
    expect(plan.gamesScheduled).toBe(0);
    expect(plan.shortfall?.gamesUnspent).toBe(15);
  });
});

describe('scheduleAdaptiveBlock', () => {
  it('schedules exactly blockSize x 2 games when seats are mirrored', () => {
    const result = scheduleAdaptiveBlock(baseScheduleInput());
    expect(result.scheduled).toBe(true);
    if (result.scheduled) {
      expect(result.matches).toHaveLength(40);
      expect(result.matches.every((match) => match.seats.length === 2)).toBe(true);
    }
  });

  it('schedules exactly blockSize games when seats are not mirrored', () => {
    const result = scheduleAdaptiveBlock(
      baseScheduleInput({ config: baseConfig({ blockSize: 20, mirrorSeats: false }) }),
    );
    expect(result.scheduled).toBe(true);
    if (result.scheduled) expect(result.matches).toHaveLength(20);
  });

  it('is deterministic: identical input produces an identical schedule', () => {
    const first = scheduleAdaptiveBlock(baseScheduleInput());
    const second = scheduleAdaptiveBlock(baseScheduleInput());
    expect(second).toEqual(first);
  });

  it('refuses to schedule a partial block when the remaining budget falls short', () => {
    const result = scheduleAdaptiveBlock(baseScheduleInput({ gamesRemaining: 39 }));
    expect(result.scheduled).toBe(false);
    if (!result.scheduled) {
      expect(result.shortfall.gamesNeeded).toBe(40);
      expect(result.shortfall.gamesRemaining).toBe(39);
      expect(result.shortfall.reason).toContain('40');
      expect(result.shortfall.reason).toContain('39');
    }
  });

  it('schedules exactly when the remaining budget matches the block exactly', () => {
    const result = scheduleAdaptiveBlock(baseScheduleInput({ gamesRemaining: 40 }));
    expect(result.scheduled).toBe(true);
  });

  it('scales the actual gate by pilot count rather than trusting the blockSize formula alone', () => {
    const result = scheduleAdaptiveBlock(
      baseScheduleInput({ pilots: [VALUE_PILOT, AGGRESSIVE_PILOT], gamesRemaining: 79 }),
    );
    // Two mirrored pilot sets over a mirrored 2-deck pairing: 2 x 40 = 80 needed.
    expect(result.scheduled).toBe(false);
    if (!result.scheduled) expect(result.shortfall.gamesNeeded).toBe(80);
  });
});
