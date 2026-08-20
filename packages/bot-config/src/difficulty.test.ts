import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_DIFFICULTIES,
  BOT_DIFFICULTIES,
  DIFFICULTY_REGISTRY,
  PLANNED_DIFFICULTIES,
  assertDifficultyRegistryComplete,
  botDifficultySchema,
  difficultyDefinition,
  difficultyIsAvailable,
  difficultyRegistryGaps,
  difficultySelection,
  difficultySelectionSchema,
  EASY_SELECTION,
  type BotDifficulty,
} from './difficulty.js';
import {
  BOT_STYLES,
  BOT_STYLE_REGISTRY,
  botStyleRegistryGaps,
  botStyleSchema,
  type BotStyle,
} from './style.js';
import { DIFFICULTY_REGISTRY_VERSION } from './version.js';

/**
 * The difficulty and style registries (M09.1).
 *
 * The expectations below are written out again rather than read back off the
 * registry, because a test that folds the registry into itself proves only that
 * `Object.keys` works. The `Record` types are what make forgetting an entry a
 * compile error; these are what make *changing* one a visible decision.
 */

const EXPECTED_STATUS: Record<BotDifficulty, 'available' | 'planned'> = {
  easy: 'available',
  normal: 'available',
  hard: 'planned',
};

const EXPECTED_STYLE_PILOTS: Record<BotStyle, string> = {
  aggressive: 'aggressive',
  defensive: 'defensive',
  value: 'value',
};

describe('difficulty registry', () => {
  it('is total, self-consistent and complete', () => {
    expect(difficultyRegistryGaps()).toEqual([]);
    expect(() => assertDifficultyRegistryComplete()).not.toThrow();
    for (const difficulty of BOT_DIFFICULTIES) {
      expect(difficultyDefinition(difficulty).id).toBe(difficulty);
    }
  });

  it('declares three IDs, easiest first', () => {
    expect(BOT_DIFFICULTIES).toEqual(['easy', 'normal', 'hard']);
  });

  it('ships Easy and Normal, and names the tranche that owns Hard', () => {
    for (const difficulty of BOT_DIFFICULTIES) {
      expect(DIFFICULTY_REGISTRY[difficulty].status).toBe(EXPECTED_STATUS[difficulty]);
    }
    // Easiest first, and the order is the lobby's order: M09.13 turned Easy on
    // and deliberately left Hard where M09.15 will find it.
    expect(AVAILABLE_DIFFICULTIES).toEqual(['easy', 'normal']);
    expect(PLANNED_DIFFICULTIES).toEqual(['hard']);
    expect(DIFFICULTY_REGISTRY.easy.plannedIn).toBeNull();
    expect(DIFFICULTY_REGISTRY.hard.plannedIn).toBe('M09.15');
  });

  it('gives a behaviour version to what it implements, and to nothing else', () => {
    // A result citing `hard` has to be able to say *which* Hard; a difficulty
    // with no decision procedure has no Hard to cite yet, and says null.
    expect(DIFFICULTY_REGISTRY.normal.behaviorVersion).toBe('1.0.0');
    expect(DIFFICULTY_REGISTRY.easy.behaviorVersion).toBe('1.0.0');
    expect(DIFFICULTY_REGISTRY.hard.behaviorVersion).toBeNull();
    for (const difficulty of BOT_DIFFICULTIES) {
      expect(difficultyIsAvailable(difficulty)).toBe(
        DIFFICULTY_REGISTRY[difficulty].behaviorVersion !== null,
      );
    }
  });

  it('says how each available difficulty chooses, and refuses to guess for Hard', () => {
    // The whole of what a difficulty *is*. Written out rather than read back,
    // because these two numbers are the published bound: changing either is a
    // change to what "Easy" means and has to be argued for here first.
    expect(DIFFICULTY_REGISTRY.normal.selection).toEqual({ kind: 'best' });
    expect(DIFFICULTY_REGISTRY.easy.selection).toEqual({
      kind: 'bounded_error',
      errorBudget: 0.5,
      maxBand: 3,
    });
    expect(EASY_SELECTION).toEqual(DIFFICULTY_REGISTRY.easy.selection);
    expect(DIFFICULTY_REGISTRY.hard.selection).toBeNull();

    expect(difficultySelection('easy')).toEqual(EASY_SELECTION);
    expect(difficultySelection('normal')).toEqual({ kind: 'best' });
    // Refused by name rather than silently falling back to `best`, which is how
    // a planned difficulty would otherwise end up playing as Normal while the
    // lobby, the seat label and the match record all said it did not.
    expect(() => difficultySelection('hard')).toThrow(/Hard.*M09\.15/);
  });

  it('refuses a bound that would not bound anything', () => {
    for (const bad of [
      { kind: 'bounded_error', errorBudget: 1.5, maxBand: 3 },
      { kind: 'bounded_error', errorBudget: -0.1, maxBand: 3 },
      { kind: 'bounded_error', errorBudget: 0.5, maxBand: 0 },
      { kind: 'bounded_error', errorBudget: 0.5, maxBand: 2.5 },
      { kind: 'bounded_error', errorBudget: 0.5 },
      { kind: 'sometimes_random' },
    ]) {
      expect(difficultySelectionSchema.safeParse(bad).success).toBe(false);
    }
    expect(difficultySelectionSchema.safeParse(EASY_SELECTION).success).toBe(true);
    expect(difficultySelectionSchema.safeParse({ kind: 'best' }).success).toBe(true);
  });

  it('refuses an unknown ID', () => {
    expect(botDifficultySchema.safeParse('nightmare').success).toBe(false);
    expect(botDifficultySchema.safeParse('Normal').success).toBe(false);
    expect(botDifficultySchema.safeParse('normal').success).toBe(true);
  });

  it('pins the registry version, so a record can say which registry it cited', () => {
    // 2 since M09.13: `easy` changed status, which is exactly what this constant
    // is for. A record that cites `easy` against registry 1 was written by a
    // build that could not fly one.
    expect(DIFFICULTY_REGISTRY_VERSION).toBe(2);
  });
});

describe('style registry', () => {
  it('is total and self-consistent', () => {
    expect(botStyleRegistryGaps()).toEqual([]);
    expect(BOT_STYLES).toEqual(['aggressive', 'defensive', 'value']);
  });

  it('names one published weight vector per style', () => {
    for (const style of BOT_STYLES) {
      expect(BOT_STYLE_REGISTRY[style].pilotId).toBe(EXPECTED_STYLE_PILOTS[style]);
    }
  });

  it('does not offer random_legal as a style', () => {
    // It is a legality probe with no preferences. Offering it beside the three
    // above would read as "an even easier Easy" and rebuild the pooled skill
    // axis M05.4 exists to refuse.
    expect(botStyleSchema.safeParse('random_legal').success).toBe(false);
  });

  it('does not offer automatic before it has a deterministic mapping', () => {
    expect(botStyleSchema.safeParse('automatic').success).toBe(false);
  });
});

describe('difficulty and style are independent axes', () => {
  it('shares no identifier between the two vocabularies', () => {
    const difficulties = new Set<string>(BOT_DIFFICULTIES);
    for (const style of BOT_STYLES) expect(difficulties.has(style)).toBe(false);
  });

  it('never presents a style as a difficulty', () => {
    for (const style of BOT_STYLES) {
      expect(botDifficultySchema.safeParse(style).success).toBe(false);
    }
    for (const difficulty of BOT_DIFFICULTIES) {
      expect(botStyleSchema.safeParse(difficulty).success).toBe(false);
    }
  });
});
