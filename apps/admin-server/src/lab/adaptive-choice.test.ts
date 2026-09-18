import { describe, expect, it } from 'vitest';

import {
  ADAPTIVE_COMMANDER_POLICIES as CONTRACTS_ADAPTIVE_COMMANDER_POLICIES,
  ADAPTIVE_INFORMATION_POLICIES as CONTRACTS_ADAPTIVE_INFORMATION_POLICIES,
  adaptiveRebuildTriggerSchema as contractsAdaptiveRebuildTriggerSchema,
  adaptiveSwapBoundSchema as contractsAdaptiveSwapBoundSchema,
  DEFAULT_ADAPTIVE_SWAP_BOUND as CONTRACTS_DEFAULT_ADAPTIVE_SWAP_BOUND,
  PRESET_REGISTRY,
  type PresetChoiceInput,
} from '@tcg/admin-contracts';
import {
  ADAPTIVE_COMMANDER_POLICIES,
  ADAPTIVE_INFORMATION_POLICIES,
  adaptiveRebuildTriggerSchema,
  adaptiveSwapBoundSchema,
  DEFAULT_ADAPTIVE_SWAP_BOUND,
} from '@tcg/simulator';

import { PresetRefused } from './expand.js';
import { estimateAdaptiveChoice } from './adaptive-choice.js';

/**
 * `estimateAdaptiveChoice` — the adaptive_counter door M08.19A adds beside
 * `expandPreset`/`estimatePreset`. It never schedules a match; it only
 * validates a choice into a real `AdaptiveConfig` and prices the resulting
 * workload with the simulator's own `planAdaptiveBudget`.
 */

const A_PRECON = 'precon_goblin_swarm';
const A_COMMANDER = 'goblin_warboss';

function choice(overrides: Record<string, unknown> = {}): PresetChoiceInput {
  return {
    presetId: 'adaptive_counter',
    experimentId: 'adaptive-search',
    seed: 'preset-2026-08',
    startingPreconIds: [A_PRECON],
    pilotIds: ['value'],
    totalLearningBudget: 100,
    blockSize: 10,
    candidateCount: 4,
    finalValidationGames: 20,
    ...overrides,
  } as unknown as PresetChoiceInput;
}

describe('the adaptive constants admin-contracts restates from the simulator', () => {
  // `packages/admin-contracts/src/presets.ts` cannot import `@tcg/simulator`
  // (the dependency-boundary rule its own header documents), so it restates
  // `ADAPTIVE_COMMANDER_POLICIES`, `ADAPTIVE_INFORMATION_POLICIES`,
  // `adaptiveSwapBoundSchema` and `adaptiveRebuildTriggerSchema` from
  // `apps/simulator/src/adaptive/config.ts`. `estimateAdaptiveChoice` (this
  // file) is the one place that validates a choice through the restated
  // schemas and then, moments later, through the real ones via
  // `parseAdaptiveConfig` — the only boundary-crossing point a drift between
  // the two would be caught behaviorally. Bounds are compared by behavior
  // (`safeParse` on shared boundary values), not by reading zod internals,
  // since the restatement's stated safety net is behavioral: a narrower
  // restatement over-refuses safely, a wider one is refused for real by
  // `parseAdaptiveConfig` — this test exists so a bound drifting narrower
  // silently (which that safety net does not catch) fails loudly instead.
  it('names the same commander and information policies as the simulator', () => {
    expect(CONTRACTS_ADAPTIVE_COMMANDER_POLICIES).toEqual(ADAPTIVE_COMMANDER_POLICIES);
    expect(CONTRACTS_ADAPTIVE_INFORMATION_POLICIES).toEqual(ADAPTIVE_INFORMATION_POLICIES);
  });

  it('accepts and refuses the same swap bounds as the simulator', () => {
    expect(CONTRACTS_DEFAULT_ADAPTIVE_SWAP_BOUND).toEqual(DEFAULT_ADAPTIVE_SWAP_BOUND);
    const cases = [
      { minCards: 1, maxCards: 1 },
      { minCards: 1, maxCards: 40 },
      { minCards: 40, maxCards: 40 },
      { minCards: 0, maxCards: 5 },
      { minCards: 1, maxCards: 41 },
      { minCards: 5, maxCards: 1 },
    ];
    for (const candidate of cases) {
      expect(contractsAdaptiveSwapBoundSchema.safeParse(candidate).success).toBe(
        adaptiveSwapBoundSchema.safeParse(candidate).success,
      );
    }
  });

  it('accepts and refuses the same rebuild triggers as the simulator', () => {
    const cases = [
      { afterConsecutiveLosses: 1 },
      { afterConsecutiveLosses: 50 },
      { afterConsecutiveLosses: 51 },
      { afterConsecutiveLosses: 0 },
      { everyBlocks: 1 },
      { everyBlocks: 1000 },
      { everyBlocks: 1001 },
      {},
      { afterConsecutiveLosses: 3, everyBlocks: 10 },
    ];
    for (const candidate of cases) {
      expect(contractsAdaptiveRebuildTriggerSchema.safeParse(candidate).success).toBe(
        adaptiveRebuildTriggerSchema.safeParse(candidate).success,
      );
    }
  });
});

describe('estimateAdaptiveChoice', () => {
  it('validates a choice into a real AdaptiveConfig and prices its budget', () => {
    const result = estimateAdaptiveChoice(choice());
    expect(result.expansion).toEqual({
      presetId: 'adaptive_counter',
      testStyle: PRESET_REGISTRY.adaptive_counter.testStyle,
      sourceClasses: [...PRESET_REGISTRY.adaptive_counter.sourceClasses],
      limitations: [...PRESET_REGISTRY.adaptive_counter.limitations],
    });
    expect(result.estimate).toEqual({
      gamesPerBlock: 20,
      blocksScheduled: 5,
      gamesScheduled: 100,
      gamesUnspent: 0,
      shortfallReason: '',
      finalValidationGames: 20,
      limitations: [...PRESET_REGISTRY.adaptive_counter.limitations],
    });
  });

  it('reports a shortfall when the budget does not divide evenly into blocks', () => {
    const result = estimateAdaptiveChoice(choice({ totalLearningBudget: 105 }));
    expect(result.estimate.gamesScheduled).toBe(100);
    expect(result.estimate.gamesUnspent).toBe(5);
    expect(result.estimate.shortfallReason).not.toBe('');
  });

  it('carries every value forward untouched, including a Commander selection', () => {
    const result = estimateAdaptiveChoice(
      choice({
        commanderPolicy: 'selected',
        selectedCommanderIds: [A_COMMANDER],
        informationPolicy: 'analysis_full_deck',
        blockSize: 5,
        mirrorSeats: false,
        candidateCount: 8,
        swapBound: { minCards: 2, maxCards: 3 },
        referenceFieldShare: 0.25,
        rebuildTrigger: { afterConsecutiveLosses: 3 },
        finalValidationGames: 50,
      }),
    );
    expect(result.estimate).toMatchObject({ gamesPerBlock: 5, finalValidationGames: 50 });
  });

  it('refuses a precon this content does not publish, naming the field', () => {
    expect(() =>
      estimateAdaptiveChoice(choice({ startingPreconIds: ['precon_not_real'] })),
    ).toThrow(PresetRefused);
  });

  it('refuses a duplicated starting precon, because a selection is a set', () => {
    expect(() =>
      estimateAdaptiveChoice(choice({ startingPreconIds: [A_PRECON, A_PRECON] })),
    ).toThrow(PresetRefused);
  });

  it('refuses a Commander this format does not have', () => {
    expect(() =>
      estimateAdaptiveChoice(
        choice({ commanderPolicy: 'selected', selectedCommanderIds: ['not_a_real_commander'] }),
      ),
    ).toThrow(PresetRefused);
  });

  it('refuses a swap bound whose minimum exceeds its maximum, at the schema itself', () => {
    expect(() =>
      estimateAdaptiveChoice(choice({ swapBound: { minCards: 5, maxCards: 1 } })),
    ).toThrow(PresetRefused);
  });

  it('refuses a Commander selection when the policy never reads one', () => {
    expect(() =>
      estimateAdaptiveChoice(
        choice({ commanderPolicy: 'locked', selectedCommanderIds: [A_COMMANDER] }),
      ),
    ).toThrow(PresetRefused);
  });

  it('refuses a choice for a different preset', () => {
    expect(() =>
      estimateAdaptiveChoice({
        presetId: 'precon_smoke',
        experimentId: 'precon-smoke',
        seed: 'preset-2026-08',
        preconIds: [A_PRECON, 'precon_bastion_guardians'],
        pilotIds: ['value'],
      }),
    ).toThrow(PresetRefused);
  });

  it('names no filesystem location anywhere in a refusal', () => {
    try {
      estimateAdaptiveChoice(choice({ startingPreconIds: ['precon_not_real'] }));
      throw new Error('expected a refusal');
    } catch (cause) {
      if (!(cause instanceof PresetRefused)) throw cause;
      for (const error of cause.errors) {
        expect(error.message).not.toMatch(/[/\\]/);
      }
    }
  });
});
