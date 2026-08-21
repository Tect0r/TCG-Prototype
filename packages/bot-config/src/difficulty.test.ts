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
  difficultyTactics,
  plannedDifficultyRefusal,
  EASY_SELECTION,
  type DifficultyDefinition,
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
  hard: 'available',
};

/** Which scorer each one flies. `hard` is the whole of what makes it Hard. */
const EXPECTED_TACTICS: Record<BotDifficulty, string> = {
  easy: 'baseline',
  normal: 'baseline',
  hard: 'hard_tactical',
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

  it('ships all three, and plans nothing', () => {
    for (const difficulty of BOT_DIFFICULTIES) {
      expect(DIFFICULTY_REGISTRY[difficulty].status).toBe(EXPECTED_STATUS[difficulty]);
    }
    // Easiest first, and the order is the lobby's order. M09.13 turned Easy on;
    // M09.14 and M09.15 built Hard's behaviour without publishing it; M09.16 put
    // the publication decision to the owner as Q50 and got "not yet, close the
    // third strategic gap first"; M09.20 closed it and published Hard on that
    // condition. Nothing is planned any more, which is what empties the lobby's
    // planned-difficulty sentence - it is read from here rather than written out
    // over there.
    expect(AVAILABLE_DIFFICULTIES).toEqual(['easy', 'normal', 'hard']);
    expect(PLANNED_DIFFICULTIES).toEqual([]);
    for (const difficulty of BOT_DIFFICULTIES) {
      expect(DIFFICULTY_REGISTRY[difficulty].plannedIn).toBeNull();
    }
  });

  it('gives a behaviour version to what it implements, and to nothing else', () => {
    // A result citing `hard` has to be able to say *which* Hard. All three now
    // implement something, so all three say which one.
    expect(DIFFICULTY_REGISTRY.normal.behaviorVersion).toBe('1.0.0');
    expect(DIFFICULTY_REGISTRY.easy.behaviorVersion).toBe('1.0.0');
    // The **difficulty's** first version, not the profile's: `hard_tactical` has
    // been at `1.0.0`, `1.1.0` and `1.2.0` without a difficulty existing to fly
    // it, and folding the two together is how a reader comes to think Hard
    // shipped three times.
    expect(DIFFICULTY_REGISTRY.hard.behaviorVersion).toBe('1.0.0');
    for (const difficulty of BOT_DIFFICULTIES) {
      expect(difficultyIsAvailable(difficulty)).toBe(
        DIFFICULTY_REGISTRY[difficulty].behaviorVersion !== null,
      );
    }
  });

  it('names a tactical profile for each, and Hard is the only one that is not baseline', () => {
    // The second half of what a difficulty is (M09.20). Written out rather than
    // read back for the same reason the selections are: `easy` or `normal`
    // quietly acquiring a refinement would make "Normal is the published
    // heuristic, unchanged" false, and this is where that has to be argued.
    for (const difficulty of BOT_DIFFICULTIES) {
      expect(DIFFICULTY_REGISTRY[difficulty].tactics).toBe(EXPECTED_TACTICS[difficulty]);
      expect(difficultyTactics(difficulty)).toBe(EXPECTED_TACTICS[difficulty]);
    }
    // The IDs are strings here because the profiles live one package up;
    // `tactics.test.ts` in `@tcg/bot-interface` resolves every one of them
    // against the real registry, which is what stops a typo being a bot that
    // silently flies the baseline.
    expect(DIFFICULTY_REGISTRY.hard.tactics).not.toBe(DIFFICULTY_REGISTRY.normal.tactics);
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
    // Hard takes the best candidate, exactly as Normal does. The difference
    // between them is entirely in the other half, and saying so here is what
    // keeps "a Hard bot is not luckier and does not get a wider band" checkable.
    expect(DIFFICULTY_REGISTRY.hard.selection).toEqual({ kind: 'best' });

    expect(difficultySelection('easy')).toEqual(EASY_SELECTION);
    expect(difficultySelection('normal')).toEqual({ kind: 'best' });
    expect(difficultySelection('hard')).toEqual({ kind: 'best' });
  });

  it('still refuses by name for a difficulty with nothing behind it', () => {
    // Nothing is planned today, so the refusal is exercised against a definition
    // built here rather than against the shipped table. It is the guard that
    // stops the *next* planned difficulty from silently playing as Normal, and a
    // guard that only ran while something happened to be planned would have
    // rotted the moment the last one shipped.
    const planned: DifficultyDefinition = {
      ...DIFFICULTY_REGISTRY.hard,
      status: 'planned',
      plannedIn: 'M99.9',
      behaviorVersion: null,
      selection: null,
      tactics: null,
    };
    expect(plannedDifficultyRefusal(planned, 'decision procedure')).toMatch(/Hard.*M99\.9/);
    expect(plannedDifficultyRefusal(planned, 'tactical profile')).toMatch(/Hard.*M99\.9/);
    // Both accessors are built out of that one wording, so the two cannot drift.
    expect(() => difficultySelection('hard')).not.toThrow();
    expect(() => difficultyTactics('hard')).not.toThrow();
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
    // 3 since M09.20: `hard` changed status and every definition gained
    // `tactics`. Both are exactly what this constant is for - a record that
    // cites `hard` against registry 2 was written by a build that could not fly
    // one, and a v2 reader meets an unknown member on a v3 definition.
    expect(DIFFICULTY_REGISTRY_VERSION).toBe(3);
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
