import { describe, expect, it } from 'vitest';
import { checkDeck, makeDeck } from '@tcg/deck-generator';
import { tinyEnvironment } from '../test-fixtures.js';
import {
  adaptiveRevisionSeedPath,
  makeAdaptiveRevision,
  type AdaptiveRevision,
} from './revision.js';
import {
  adaptiveGenerationRecordSchema,
  generateAdaptiveCandidates,
  type GenerateAdaptiveCandidatesInput,
} from './generate.js';
import type { AdaptiveConfig } from './config.js';

/**
 * M08.16C: deterministic legal candidate generation, proved without any
 * evaluation, promotion or rollback — those stay M08.17's job (`./generate.ts`
 * top-of-file comment). This suite covers exactly the four things the
 * milestone names: deterministic replay, legality, swap bounds and the
 * public-observation versus analysis-only boundary.
 */

const NEUTRAL_POOL_IDS = [
  'prototype_drone',
  'prototype_scout',
  'prototype_guard',
  'trench_guard',
  'unstable_construct',
  'surveyors_lens',
  'energy_font',
  'field_survey',
] as const;

const FIXTURE_IDS = [
  'fixture_baseline_unit',
  'fixture_equivalent_unit',
  'fixture_strong_unit',
  'fixture_dominant_unit',
  'fixture_combo_enabler',
  'fixture_combo_payoff',
] as const;

const environment = tinyEnvironment();

function baseConfig(overrides: Partial<AdaptiveConfig> = {}): AdaptiveConfig {
  return {
    schemaVersion: 1,
    id: 'gen-test',
    label: '',
    seed: 'gen-fixture-seed',
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

function incumbentRevision(): AdaptiveRevision {
  const deck = makeDeck({
    commanderId: 'prototype_commander_blue',
    cards: [
      { cardId: 'prototype_scout', quantity: 2 },
      { cardId: 'prototype_guard', quantity: 2 },
      { cardId: 'trench_guard', quantity: 2 },
      { cardId: 'unstable_construct', quantity: 2 },
      { cardId: 'surveyors_lens', quantity: 2 },
      { cardId: 'energy_font', quantity: 2 },
    ],
  });
  return makeAdaptiveRevision({
    experimentId: 'gen-test',
    parentRevisionId: null,
    generation: 0,
    block: 0,
    opponentRevisionId: null,
    construction: 'root',
    seedPath: adaptiveRevisionSeedPath('gen-fixture-seed', 'gen-test', 0, 0),
    deck,
  });
}

function baseInput(
  overrides: Partial<GenerateAdaptiveCandidatesInput> = {},
): GenerateAdaptiveCandidatesInput {
  return {
    environment,
    config: baseConfig(),
    incumbent: incumbentRevision(),
    opponentRevisionId: 'rev_opponent',
    block: 1,
    rebuild: false,
    ...overrides,
  };
}

describe('generateAdaptiveCandidates: legality and swap bounds', () => {
  it('produces only legal decks, each within the configured swap bound', () => {
    const record = generateAdaptiveCandidates(baseInput());
    expect(record.candidates.length + record.rejected.length).toBe(baseConfig().candidateCount);
    for (const candidate of record.candidates) {
      expect(checkDeck(candidate.deck, environment).legal).toBe(true);
      expect(candidate.swaps.length).toBeGreaterThanOrEqual(1);
      expect(candidate.swaps.length).toBeLessThanOrEqual(3);
      expect(candidate.construction).toBe('swap');
      expect(candidate.parentRevisionId).toBe(baseInput().incumbent.revisionId);
      expect(candidate.generation).toBe(1);
      expect(candidate.opponentRevisionId).toBe('rev_opponent');
    }
  });

  it('validates against adaptiveGenerationRecordSchema', () => {
    const record = generateAdaptiveCandidates(baseInput());
    expect(() => adaptiveGenerationRecordSchema.parse(record)).not.toThrow();
  });

  it('records every rejected candidate with a non-empty reason', () => {
    // Pool capacity equals deck size exactly: every legal card is already at
    // its copy limit, so no swap can find a legal addition — every candidate
    // is rejected by `mutateDeck` itself, deterministically.
    const saturated = tinyEnvironment({
      deckSize: NEUTRAL_POOL_IDS.length + FIXTURE_IDS.length,
      copyLimit: 1,
    });
    const deck = makeDeck({
      commanderId: 'prototype_commander_blue',
      cards: [...NEUTRAL_POOL_IDS, ...FIXTURE_IDS].map((cardId) => ({ cardId, quantity: 1 })),
    });
    const incumbent = makeAdaptiveRevision({
      experimentId: 'gen-test',
      parentRevisionId: null,
      generation: 0,
      block: 0,
      opponentRevisionId: null,
      construction: 'root',
      seedPath: adaptiveRevisionSeedPath('gen-fixture-seed', 'gen-test', 0, 0),
      deck,
    });
    expect(checkDeck(deck, saturated).legal).toBe(true);

    const record = generateAdaptiveCandidates(
      baseInput({ environment: saturated, incumbent, config: baseConfig({ candidateCount: 3 }) }),
    );
    expect(record.candidates).toEqual([]);
    expect(record.rejected).toHaveLength(3);
    for (const rejection of record.rejected) {
      expect(rejection.reasons.length).toBeGreaterThan(0);
      expect(rejection.construction).toBe('swap');
    }
  });
});

describe('generateAdaptiveCandidates: deterministic replay', () => {
  it('produces identical candidates and rejections across repeated calls', () => {
    const first = generateAdaptiveCandidates(baseInput());
    const second = generateAdaptiveCandidates(baseInput());
    expect(second).toEqual(first);
  });
});

describe('generateAdaptiveCandidates: rebuild candidates', () => {
  it('produces fresh, legal, swap-free rebuild candidates', () => {
    const record = generateAdaptiveCandidates(baseInput({ rebuild: true }));
    expect(record.candidates.length).toBeGreaterThan(0);
    for (const candidate of record.candidates) {
      expect(candidate.construction).toBe('rebuild');
      expect(candidate.swaps).toEqual([]);
      expect(checkDeck(candidate.deck, environment).legal).toBe(true);
      expect(candidate.deck.hash).not.toBe(baseInput().incumbent.deck.hash);
    }
  });
});

describe('generateAdaptiveCandidates: public-observation versus analysis-only boundary', () => {
  it('records the configured information policy without changing what is generated', () => {
    const publicRecord = generateAdaptiveCandidates(
      baseInput({ config: baseConfig({ informationPolicy: 'public_observation' }) }),
    );
    const analysisRecord = generateAdaptiveCandidates(
      baseInput({ config: baseConfig({ informationPolicy: 'analysis_full_deck' }) }),
    );
    expect(publicRecord.informationPolicy).toBe('public_observation');
    expect(analysisRecord.informationPolicy).toBe('analysis_full_deck');
    expect(analysisRecord.candidates).toEqual(publicRecord.candidates);
    expect(analysisRecord.rejected).toEqual(publicRecord.rejected);
  });
});
