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
  easy: 'planned',
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

  it('ships Normal only, and names the tranche that owns each of the others', () => {
    for (const difficulty of BOT_DIFFICULTIES) {
      expect(DIFFICULTY_REGISTRY[difficulty].status).toBe(EXPECTED_STATUS[difficulty]);
    }
    expect(AVAILABLE_DIFFICULTIES).toEqual(['normal']);
    expect(PLANNED_DIFFICULTIES).toEqual(['easy', 'hard']);
    expect(DIFFICULTY_REGISTRY.easy.plannedIn).toBe('M09.13');
    expect(DIFFICULTY_REGISTRY.hard.plannedIn).toBe('M09.15');
  });

  it('gives a behaviour version to what it implements, and to nothing else', () => {
    // A result citing `hard` has to be able to say *which* Hard; a difficulty
    // with no decision procedure has no Hard to cite yet, and says null.
    expect(DIFFICULTY_REGISTRY.normal.behaviorVersion).toBe('1.0.0');
    expect(DIFFICULTY_REGISTRY.easy.behaviorVersion).toBeNull();
    expect(DIFFICULTY_REGISTRY.hard.behaviorVersion).toBeNull();
    for (const difficulty of BOT_DIFFICULTIES) {
      expect(difficultyIsAvailable(difficulty)).toBe(
        DIFFICULTY_REGISTRY[difficulty].behaviorVersion !== null,
      );
    }
  });

  it('refuses an unknown ID', () => {
    expect(botDifficultySchema.safeParse('nightmare').success).toBe(false);
    expect(botDifficultySchema.safeParse('Normal').success).toBe(false);
    expect(botDifficultySchema.safeParse('normal').success).toBe(true);
  });

  it('pins the registry version, so a record can say which registry it cited', () => {
    expect(DIFFICULTY_REGISTRY_VERSION).toBe(1);
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
