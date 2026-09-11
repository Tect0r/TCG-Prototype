import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  ADAPTIVE_COMMANDER_POLICIES,
  ADAPTIVE_INFORMATION_POLICIES,
  adaptiveConfigHashOf,
  adaptiveConfigSchema,
  adaptiveRebuildTriggerSchema,
  adaptiveSwapBoundSchema,
  parseAdaptiveConfig,
  pilotSpecsOf,
} from './config.js';
import { ADAPTIVE_CONFIG_SCHEMA_VERSION } from './version.js';

/**
 * M08.16A: the strict config surface and its policy bounds, proved without
 * generating a candidate or running adaptation. `runAdaptive` does not exist
 * yet — every case here only calls `parseAdaptiveConfig`/`adaptiveConfigSchema`.
 */

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: ADAPTIVE_CONFIG_SCHEMA_VERSION,
    id: 'my-adaptive-run',
    seed: 'adaptive-fixture-seed',
    environment: { id: 'fixture_env' },
    startingDecks: { kind: 'precon', preconIds: ['some_precon'] },
    totalLearningBudget: 1000,
    blockSize: 20,
    candidateCount: 4,
    finalValidationGames: 50,
    pilotIds: ['value'],
    ...overrides,
  };
}

describe('adaptiveConfigSchema: strict surface', () => {
  it('accepts a minimal valid config and fills in every default', () => {
    const parsed = parseAdaptiveConfig(validConfig());
    expect(parsed.label).toBe('');
    expect(parsed.output).toBe('results');
    expect(parsed.commanderPolicy).toBe('locked');
    expect(parsed.selectedCommanderIds).toEqual([]);
    expect(parsed.informationPolicy).toBe('public_observation');
    expect(parsed.mirrorSeats).toBe(true);
    expect(parsed.swapBound).toEqual({ minCards: 1, maxCards: 5 });
    expect(parsed.rebuildTrigger).toBeNull();
    expect(parsed.referenceFieldShare).toBe(0);
    expect(parsed.retention).toEqual({
      replaySampleRate: 50,
      keepLogs: false,
      keepDecisions: false,
    });
    expect(parsed.limits).toEqual({
      maxTurns: 200,
      maxActions: 6000,
      maxDecisionsPerSeat: 4000,
      noProgressWindow: 60,
    });
  });

  it('refuses an unrecognized top-level field', () => {
    expect(() => parseAdaptiveConfig(validConfig({ extraField: 'nope' }))).toThrow(ZodError);
  });

  it('refuses an unrecognized field inside swapBound', () => {
    expect(() => adaptiveSwapBoundSchema.parse({ minCards: 1, maxCards: 5, stray: true })).toThrow(
      ZodError,
    );
  });

  it('refuses an unrecognized field inside rebuildTrigger', () => {
    expect(() =>
      adaptiveRebuildTriggerSchema.parse({ afterConsecutiveLosses: 3, stray: true }),
    ).toThrow(ZodError);
  });
});

describe('adaptiveConfigSchema: policy enums', () => {
  it('accepts every declared commander policy', () => {
    for (const policy of ADAPTIVE_COMMANDER_POLICIES) {
      const overrides =
        policy === 'selected'
          ? { commanderPolicy: policy, selectedCommanderIds: ['prototype_commander_blue'] }
          : { commanderPolicy: policy };
      expect(() => parseAdaptiveConfig(validConfig(overrides))).not.toThrow();
    }
  });

  it('refuses a commander policy outside the enum', () => {
    expect(() => parseAdaptiveConfig(validConfig({ commanderPolicy: 'unlocked' }))).toThrow(
      ZodError,
    );
  });

  it('accepts every declared information policy', () => {
    for (const policy of ADAPTIVE_INFORMATION_POLICIES) {
      expect(() => parseAdaptiveConfig(validConfig({ informationPolicy: policy }))).not.toThrow();
    }
  });

  it('refuses an information policy outside the enum', () => {
    expect(() =>
      parseAdaptiveConfig(validConfig({ informationPolicy: 'full_omniscience' })),
    ).toThrow(ZodError);
  });
});

describe('adaptiveConfigSchema: selectedCommanderIds refinement', () => {
  it('requires at least one ID when commanderPolicy is selected', () => {
    expect(() =>
      parseAdaptiveConfig(validConfig({ commanderPolicy: 'selected', selectedCommanderIds: [] })),
    ).toThrow(ZodError);
  });

  it('refuses a non-empty list when commanderPolicy is locked', () => {
    expect(() =>
      parseAdaptiveConfig(
        validConfig({
          commanderPolicy: 'locked',
          selectedCommanderIds: ['prototype_commander_blue'],
        }),
      ),
    ).toThrow(ZodError);
  });

  it('refuses a non-empty list when commanderPolicy is open', () => {
    expect(() =>
      parseAdaptiveConfig(
        validConfig({
          commanderPolicy: 'open',
          selectedCommanderIds: ['prototype_commander_blue'],
        }),
      ),
    ).toThrow(ZodError);
  });
});

describe('adaptiveConfigSchema: numeric bounds', () => {
  it.each([
    ['totalLearningBudget', 0],
    ['totalLearningBudget', 1_000_001],
    ['blockSize', 0],
    ['blockSize', 10_001],
    ['candidateCount', 0],
    ['candidateCount', 65],
    ['finalValidationGames', 0],
    ['finalValidationGames', 100_001],
  ])('refuses %s outside its bound (%d)', (field, value) => {
    expect(() => parseAdaptiveConfig(validConfig({ [field]: value }))).toThrow(ZodError);
  });

  it.each([
    ['totalLearningBudget', 1],
    ['totalLearningBudget', 1_000_000],
    ['blockSize', 1],
    ['blockSize', 10_000],
    ['candidateCount', 1],
    ['candidateCount', 64],
    ['finalValidationGames', 1],
    ['finalValidationGames', 100_000],
  ])('accepts %s at its bound (%d)', (field, value) => {
    expect(() => parseAdaptiveConfig(validConfig({ [field]: value }))).not.toThrow();
  });

  it('refuses a referenceFieldShare outside 0-1', () => {
    expect(() => parseAdaptiveConfig(validConfig({ referenceFieldShare: -0.01 }))).toThrow(
      ZodError,
    );
    expect(() => parseAdaptiveConfig(validConfig({ referenceFieldShare: 1.01 }))).toThrow(ZodError);
  });

  it('accepts a referenceFieldShare at 0 and 1', () => {
    expect(() => parseAdaptiveConfig(validConfig({ referenceFieldShare: 0 }))).not.toThrow();
    expect(() => parseAdaptiveConfig(validConfig({ referenceFieldShare: 1 }))).not.toThrow();
  });
});

describe('adaptiveSwapBoundSchema: minCards <= maxCards', () => {
  it('refuses a minCards greater than maxCards', () => {
    expect(() => adaptiveSwapBoundSchema.parse({ minCards: 6, maxCards: 5 })).toThrow(ZodError);
  });

  it('accepts minCards equal to maxCards', () => {
    expect(() => adaptiveSwapBoundSchema.parse({ minCards: 5, maxCards: 5 })).not.toThrow();
  });

  it('refuses a card count outside 1-40 on either side', () => {
    expect(() => adaptiveSwapBoundSchema.parse({ minCards: 0, maxCards: 5 })).toThrow(ZodError);
    expect(() => adaptiveSwapBoundSchema.parse({ minCards: 1, maxCards: 41 })).toThrow(ZodError);
  });
});

describe('adaptiveRebuildTriggerSchema: at least one condition', () => {
  it('refuses a trigger with neither field', () => {
    expect(() => adaptiveRebuildTriggerSchema.parse({})).toThrow(ZodError);
  });

  it('accepts afterConsecutiveLosses alone', () => {
    expect(() => adaptiveRebuildTriggerSchema.parse({ afterConsecutiveLosses: 3 })).not.toThrow();
  });

  it('accepts everyBlocks alone', () => {
    expect(() => adaptiveRebuildTriggerSchema.parse({ everyBlocks: 10 })).not.toThrow();
  });

  it('refuses each field outside its own bound', () => {
    expect(() => adaptiveRebuildTriggerSchema.parse({ afterConsecutiveLosses: 51 })).toThrow(
      ZodError,
    );
    expect(() => adaptiveRebuildTriggerSchema.parse({ everyBlocks: 1001 })).toThrow(ZodError);
  });
});

describe('adaptiveConfigSchema: schema identity', () => {
  it('refuses a config id outside the lowercase slug alphabet', () => {
    expect(() => parseAdaptiveConfig(validConfig({ id: 'Not Valid' }))).toThrow(ZodError);
  });

  it('round-trips through adaptiveConfigSchema directly, not only the parse helper', () => {
    expect(() => adaptiveConfigSchema.parse(validConfig())).not.toThrow();
  });

  it('refuses a schemaVersion-1 config (predates pilotIds/limits, Q53) rather than migrating it', () => {
    const { pilotIds: _pilotIds, limits: _limits, ...legacy } = validConfig();
    expect(() => parseAdaptiveConfig({ ...legacy, schemaVersion: 1 })).toThrow(
      /older build.*no migration/s,
    );
  });
});

/** Q53: pilots and per-match limits are explicit, stored, hashed config inputs. */
describe('adaptiveConfigSchema: pilotIds and limits (Q53)', () => {
  it('refuses a config with no pilotIds', () => {
    expect(() => parseAdaptiveConfig(validConfig({ pilotIds: [] }))).toThrow(ZodError);
  });

  it('refuses a pilotId outside the registered enum', () => {
    expect(() => parseAdaptiveConfig(validConfig({ pilotIds: ['not_a_pilot'] }))).toThrow(ZodError);
  });

  it('accepts multiple distinct pilotIds', () => {
    const parsed = parseAdaptiveConfig(validConfig({ pilotIds: ['value', 'aggressive'] }));
    expect(parsed.pilotIds).toEqual(['value', 'aggressive']);
  });

  it('round-trips explicit limits overrides rather than silently defaulting them', () => {
    const parsed = parseAdaptiveConfig(
      validConfig({ limits: { maxTurns: 40, noProgressWindow: 10 } }),
    );
    expect(parsed.limits).toEqual({
      maxTurns: 40,
      maxActions: 6000,
      maxDecisionsPerSeat: 4000,
      noProgressWindow: 10,
    });
  });

  it('changes the config hash when pilotIds change', () => {
    const base = parseAdaptiveConfig(validConfig());
    const changed = parseAdaptiveConfig(validConfig({ pilotIds: ['aggressive'] }));
    expect(adaptiveConfigHashOf(changed)).not.toBe(adaptiveConfigHashOf(base));
  });

  it('changes the config hash when limits change', () => {
    const base = parseAdaptiveConfig(validConfig());
    const changed = parseAdaptiveConfig(validConfig({ limits: { maxTurns: 5 } }));
    expect(adaptiveConfigHashOf(changed)).not.toBe(adaptiveConfigHashOf(base));
  });
});

describe('pilotSpecsOf: Q53 pilotIds -> PilotSpec expansion', () => {
  it('maps each pilotId to a full PilotSpec with defaulted weights/randomConfig', () => {
    const config = parseAdaptiveConfig(validConfig({ pilotIds: ['value', 'aggressive'] }));
    expect(pilotSpecsOf(config)).toEqual([
      { id: 'value', weights: {}, randomConfig: {} },
      { id: 'aggressive', weights: {}, randomConfig: {} },
    ]);
  });
});
