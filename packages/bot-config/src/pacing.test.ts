import { describe, expect, it } from 'vitest';
import {
  BOT_DECISION_CATEGORIES,
  DEFAULT_BOT_PACING_BUDGETS,
  IMMEDIATE_BOT_PACING,
  MAX_BUDGET_SECONDS,
  MIN_BUDGET_SECONDS,
  PACING_BUDGET_BY_CATEGORY,
  PACING_SAFETY_MARGIN_MS,
  botDelayMs,
  botDelayTable,
  botPacingBudgetsSchema,
  botPacingSchema,
  pacingDelayMs,
  pacingPercentFor,
  pacingRegistryGaps,
  readBotPacingBudgets,
  type BotPacing,
  type BotPacingBudgets,
} from './pacing.js';
import { PACING_CONFIG_VERSION } from './version.js';

/**
 * Bot pacing (M09.1).
 *
 * Nothing here waits. The whole point of pinning the arithmetic in one pure
 * integer function is that M09.12 can assert every delay against a fake clock
 * instead of against real time, and that the seconds a lobby prints beside a
 * percentage are the seconds the scheduler will actually use.
 */

const budgets: BotPacingBudgets = DEFAULT_BOT_PACING_BUDGETS;

function pacing(percent: number, reactionPercent: number | null = null): BotPacing {
  return { percent, reactionPercent };
}

describe('decision categories', () => {
  it('names three, and gives every one a budget', () => {
    expect(BOT_DECISION_CATEGORIES).toEqual(['ordinary', 'pending_choice', 'reaction']);
    expect(pacingRegistryGaps()).toEqual([]);
  });

  it('puts a pending choice on the ordinary budget and a Reaction on its own', () => {
    expect(PACING_BUDGET_BY_CATEGORY).toEqual({
      ordinary: 'ordinary',
      pending_choice: 'ordinary',
      reaction: 'reaction',
    });
  });
});

describe('budgets', () => {
  it('starts at the milestone dials: 30 seconds and 5', () => {
    expect(budgets.ordinarySeconds).toBe(30);
    expect(budgets.reactionSeconds).toBe(5);
    expect(budgets.pacingVersion).toBe(PACING_CONFIG_VERSION);
  });

  it('refuses a budget outside the supported range, and a fractional one', () => {
    const base = { pacingVersion: PACING_CONFIG_VERSION, reactionSeconds: 5 };
    expect(
      botPacingBudgetsSchema.safeParse({ ...base, ordinarySeconds: MIN_BUDGET_SECONDS }).success,
    ).toBe(true);
    expect(
      botPacingBudgetsSchema.safeParse({ ...base, ordinarySeconds: MAX_BUDGET_SECONDS }).success,
    ).toBe(true);
    expect(botPacingBudgetsSchema.safeParse({ ...base, ordinarySeconds: 0 }).success).toBe(false);
    expect(
      botPacingBudgetsSchema.safeParse({ ...base, ordinarySeconds: MAX_BUDGET_SECONDS + 1 })
        .success,
    ).toBe(false);
    expect(botPacingBudgetsSchema.safeParse({ ...base, ordinarySeconds: 30.5 }).success).toBe(
      false,
    );
  });

  it('is a strict object', () => {
    expect(
      botPacingBudgetsSchema.safeParse({ ...DEFAULT_BOT_PACING_BUDGETS, humanSeconds: 90 }).success,
    ).toBe(false);
  });

  it('round-trips through JSON', () => {
    const read = readBotPacingBudgets(JSON.parse(JSON.stringify(DEFAULT_BOT_PACING_BUDGETS)));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toEqual(DEFAULT_BOT_PACING_BUDGETS);
  });

  it('refuses budgets from a newer build by name, before complaining about shape', () => {
    const read = readBotPacingBudgets({
      pacingVersion: PACING_CONFIG_VERSION + 1,
      ordinarySeconds: 30,
      reactionSeconds: 5,
      somethingNewer: true,
    });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error).toHaveLength(1);
      expect(read.error[0]?.code).toBe('bot_config/unsupported_version');
      expect(read.error[0]?.message).toContain('newer build');
    }
  });

  it('refuses budgets that declare no version at all', () => {
    const read = readBotPacingBudgets({ ordinarySeconds: 30, reactionSeconds: 5 });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error[0]?.code).toBe('bot_config/missing_pacing_version');
  });
});

describe('percentage to delay', () => {
  it('is exactly zero at 0%', () => {
    // An immediate bot must not acquire a delay by rounding: M09.4 and M09.5
    // ship before the scheduler exists, and 0% is what they run at.
    expect(pacingDelayMs(0, 30)).toBe(0);
    expect(pacingDelayMs(0, 5)).toBe(0);
    expect(botDelayMs(IMMEDIATE_BOT_PACING, budgets, 'ordinary')).toBe(0);
    expect(botDelayMs(IMMEDIATE_BOT_PACING, budgets, 'reaction')).toBe(0);
  });

  it('is half the budget at 50%', () => {
    expect(pacingDelayMs(50, 30)).toBe(15_000);
    expect(pacingDelayMs(50, 5)).toBe(2_500);
  });

  it('stops one safety margin short of the budget at 100%', () => {
    expect(pacingDelayMs(100, 30)).toBe(30_000 - PACING_SAFETY_MARGIN_MS);
    expect(pacingDelayMs(100, 5)).toBe(5_000 - PACING_SAFETY_MARGIN_MS);
  });

  it('applies the margin only where it binds', () => {
    // The margin is a ceiling, not a tax. At 99% of 30 seconds the requested
    // delay is already inside it and passes through untouched; at 99% of the
    // 5-second Reaction budget it is not, and the ceiling is what applies.
    expect(pacingDelayMs(99, 30)).toBe(29_700);
    expect(pacingDelayMs(99, 5)).toBe(5_000 - PACING_SAFETY_MARGIN_MS);
  });

  it('never returns a negative delay, however small the budget', () => {
    expect(pacingDelayMs(100, 1, 5_000)).toBe(0);
    expect(pacingDelayMs(100, MIN_BUDGET_SECONDS)).toBe(1_000 - PACING_SAFETY_MARGIN_MS);
  });

  it('returns whole milliseconds, so a fake clock can assert them exactly', () => {
    for (let percent = 0; percent <= 100; percent += 1) {
      const delay = pacingDelayMs(percent, 30);
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
    }
  });

  it('is monotonic in the percentage', () => {
    let previous = -1;
    for (let percent = 0; percent <= 100; percent += 1) {
      const delay = pacingDelayMs(percent, 30);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });
});

describe('the Reaction override', () => {
  it('inherits the ordinary percentage when it is null', () => {
    const inherited = pacing(50);
    expect(pacingPercentFor(inherited, 'reaction')).toBe(50);
    expect(botDelayMs(inherited, budgets, 'reaction')).toBe(2_500);
  });

  it('overrides only the Reaction category', () => {
    const overridden = pacing(100, 0);
    expect(botDelayMs(overridden, budgets, 'ordinary')).toBe(30_000 - PACING_SAFETY_MARGIN_MS);
    expect(botDelayMs(overridden, budgets, 'pending_choice')).toBe(
      30_000 - PACING_SAFETY_MARGIN_MS,
    );
    expect(botDelayMs(overridden, budgets, 'reaction')).toBe(0);
  });

  it('distinguishes an override of 0 from inheriting', () => {
    // `null` is an explicit member rather than an absent key precisely so that
    // "answer instantly" survives a round trip and is not read as "inherit".
    expect(pacingPercentFor(pacing(80, 0), 'reaction')).toBe(0);
    expect(pacingPercentFor(pacing(80, null), 'reaction')).toBe(80);
    const parsed = botPacingSchema.parse(JSON.parse(JSON.stringify(pacing(80, 0))));
    expect(parsed.reactionPercent).toBe(0);
  });

  it('shows every calculated delay a lobby needs to print', () => {
    expect(botDelayTable(pacing(50, 100), budgets)).toEqual({
      ordinary: 15_000,
      pending_choice: 15_000,
      reaction: 5_000 - PACING_SAFETY_MARGIN_MS,
    });
  });
});

describe('the per-bot dial', () => {
  it('is a strict object over integer percentages', () => {
    expect(botPacingSchema.safeParse({ percent: 50, reactionPercent: null }).success).toBe(true);
    expect(botPacingSchema.safeParse({ percent: 50 }).success).toBe(false);
    expect(botPacingSchema.safeParse({ percent: 50.5, reactionPercent: null }).success).toBe(false);
    expect(botPacingSchema.safeParse({ percent: -1, reactionPercent: null }).success).toBe(false);
    expect(botPacingSchema.safeParse({ percent: 101, reactionPercent: null }).success).toBe(false);
  });

  it('refuses an unknown member', () => {
    expect(
      botPacingSchema.safeParse({ percent: 50, reactionPercent: null, humanPercent: 50 }).success,
    ).toBe(false);
  });
});
