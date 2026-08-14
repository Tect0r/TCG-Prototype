import { z } from 'zod';
import { err, error, ok, type Issue, type Result } from '@tcg/shared';
import { botConfigIssues, PACING_CONFIG_VERSION, refuseFutureVersion } from './version.js';

/**
 * Bot pacing (M09.1) — the fourth independent axis, and the one that must not be
 * mistaken for a rule.
 *
 * A live bot waits before submitting, for an integer percentage of a budget.
 * Both the percentage and the budget are **server and lobby configuration**:
 * they are not in `RulesConfig`, not in the engine, and `RULES_VERSION` does not
 * move because a bot waited
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §4).
 *
 * **This deliberately does not answer Q8.** Q8 asks whether a *human* should ever
 * be timed out of a phase or a choice and what expiry should do. M09 does not
 * answer it; it gives the owner a way to feel a 30-second decision and a
 * 5-second Reaction window against a bot, with nothing at stake, before deciding
 * whether humans should live under those numbers. Nothing here times out, passes
 * for, or defeats a human. The two budgets are test dials, and changing one after
 * playing is a configuration change recorded as one — which is why
 * `PACING_CONFIG_VERSION` pins the *calculation* and not the values.
 *
 * A delay is an **opportunity, not a stored action**: at expiry the server
 * rebuilds the observation and asks the pilot then. Nothing in this file
 * produces or holds an action, and nothing in it reads a clock — the caller
 * supplies the injectable one (M09.12).
 */

/* -------------------------------------------------------------- categories */

/**
 * What kind of opportunity a bot is being given, for the purpose of choosing a
 * budget. Deciding *which* category a live opportunity is in, from structured
 * state and view data, is M09.12's; the vocabulary and the mapping below are
 * fixed here so that the classification has something stable to produce.
 */
export const BOT_DECISION_CATEGORIES = ['ordinary', 'pending_choice', 'reaction'] as const;
export const botDecisionCategorySchema = z.enum(BOT_DECISION_CATEGORIES);
export type BotDecisionCategory = z.infer<typeof botDecisionCategorySchema>;

/** The two budgets a category can draw from. */
export const PACING_BUDGET_KEYS = ['ordinary', 'reaction'] as const;
export const pacingBudgetKeySchema = z.enum(PACING_BUDGET_KEYS);
export type PacingBudgetKey = z.infer<typeof pacingBudgetKeySchema>;

/**
 * Total over the categories, so a new one cannot be added without deciding what
 * it waits on. A pending choice draws on the ordinary budget: it is a decision
 * inside the bot's own turn structure, not an answer to somebody else's window.
 */
export const PACING_BUDGET_BY_CATEGORY: Readonly<Record<BotDecisionCategory, PacingBudgetKey>> =
  Object.freeze({
    ordinary: 'ordinary',
    pending_choice: 'ordinary',
    reaction: 'reaction',
  });

/* ----------------------------------------------------------------- budgets */

export const MIN_BUDGET_SECONDS = 1;
export const MAX_BUDGET_SECONDS = 300;

/**
 * The initial dials, from the milestone: 30 seconds for an ordinary decision or
 * a pending choice, 5 seconds for a Reaction window. Defaults, not constants of
 * the game.
 */
export const DEFAULT_BUDGET_SECONDS: Readonly<Record<PacingBudgetKey, number>> = Object.freeze({
  ordinary: 30,
  reaction: 5,
});

/**
 * How much of a budget is never spent waiting.
 *
 * At 100% the bot still has to build an observation, run a pilot, revalidate and
 * submit, and the budget is what the owner is measuring — so the wait stops
 * short of it rather than at it. Without this, "100%" would mean "the budget,
 * plus however long the pilot took", and the number on the screen would be a
 * lower bound instead of a value.
 */
export const PACING_SAFETY_MARGIN_MS = 250;

export const botPacingBudgetsSchema = z.strictObject({
  pacingVersion: z.literal(PACING_CONFIG_VERSION),
  /** Ordinary decisions and pending choices. */
  ordinarySeconds: z.number().int().min(MIN_BUDGET_SECONDS).max(MAX_BUDGET_SECONDS),
  /** Reaction windows, which are short by design. */
  reactionSeconds: z.number().int().min(MIN_BUDGET_SECONDS).max(MAX_BUDGET_SECONDS),
});
export type BotPacingBudgets = z.infer<typeof botPacingBudgetsSchema>;

export const DEFAULT_BOT_PACING_BUDGETS: BotPacingBudgets = Object.freeze({
  pacingVersion: PACING_CONFIG_VERSION,
  ordinarySeconds: DEFAULT_BUDGET_SECONDS.ordinary,
  reactionSeconds: DEFAULT_BUDGET_SECONDS.reaction,
});

export function budgetSecondsFor(budgets: BotPacingBudgets, key: PacingBudgetKey): number {
  return key === 'reaction' ? budgets.reactionSeconds : budgets.ordinarySeconds;
}

/**
 * Reads budgets from outside this build, refusing a future `pacingVersion` the
 * same way a bot configuration refuses a future schema version. Budgets travel
 * separately from a bot because they belong to the lobby, not to a seat.
 */
export function readBotPacingBudgets(raw: unknown): Result<BotPacingBudgets, Issue[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err([error('bot_config/malformed', 'Pacing budgets must be a JSON object.')]);
  }
  const refusal = refuseFutureVersion(
    'pacing',
    (raw as Record<string, unknown>).pacingVersion,
    'pacingVersion',
  );
  if (refusal) return err([refusal]);

  const parsed = botPacingBudgetsSchema.safeParse(raw);
  if (!parsed.success) return err(botConfigIssues(parsed.error));
  return ok(parsed.data);
}

/* -------------------------------------------------------------- per-bot dial */

export const MIN_PACING_PERCENT = 0;
export const MAX_PACING_PERCENT = 100;
export const pacingPercentSchema = z.number().int().min(MIN_PACING_PERCENT).max(MAX_PACING_PERCENT);

/**
 * One bot's timing.
 *
 * `reactionPercent` is `null` to inherit `percent`, which is the setting almost
 * everyone wants: the override exists because a Reaction window is five seconds
 * and a tester may want a bot that thinks slowly in its own turn and answers
 * quickly in someone else's. `null` is an explicit member rather than an absent
 * key so that "inherit" survives a round trip through a strict object.
 */
export const botPacingSchema = z.strictObject({
  percent: pacingPercentSchema,
  reactionPercent: pacingPercentSchema.nullable(),
});
export type BotPacing = z.infer<typeof botPacingSchema>;

/** Instant. The only pacing M09.4 and M09.5 support; M09.12 makes the rest live. */
export const IMMEDIATE_BOT_PACING: BotPacing = Object.freeze({
  percent: 0,
  reactionPercent: null,
});

export function pacingPercentFor(pacing: BotPacing, category: BotDecisionCategory): number {
  if (PACING_BUDGET_BY_CATEGORY[category] !== 'reaction') return pacing.percent;
  return pacing.reactionPercent ?? pacing.percent;
}

/* ------------------------------------------------------------ the calculation */

/**
 * How long a bot waits, in whole milliseconds.
 *
 * ```text
 * budgetMs  = budgetSeconds * 1000
 * requested = round(budgetMs * percent / 100)
 * delay     = clamp(min(requested, budgetMs - PACING_SAFETY_MARGIN_MS), 0, budgetMs)
 * ```
 *
 * 0% is exactly zero — an immediate bot waits for nothing at all, and must not
 * acquire a delay by rounding. 100% is the budget less the safety margin, so the
 * decision still lands inside the budget the owner is measuring. Everything
 * between is linear, and the result is an integer, because a schedule that
 * cannot be written down exactly cannot be asserted against a fake clock.
 */
export function pacingDelayMs(
  percent: number,
  budgetSeconds: number,
  safetyMarginMs: number = PACING_SAFETY_MARGIN_MS,
): number {
  const budgetMs = Math.round(budgetSeconds * 1000);
  if (percent <= MIN_PACING_PERCENT) return 0;
  const requested = Math.round((budgetMs * percent) / 100);
  const ceiling = Math.max(0, budgetMs - Math.max(0, safetyMarginMs));
  return Math.max(0, Math.min(requested, ceiling));
}

/** The same calculation, from a bot's configuration and the lobby's budgets. */
export function botDelayMs(
  pacing: BotPacing,
  budgets: BotPacingBudgets,
  category: BotDecisionCategory,
): number {
  const key = PACING_BUDGET_BY_CATEGORY[category];
  return pacingDelayMs(pacingPercentFor(pacing, category), budgetSecondsFor(budgets, key));
}

/**
 * Every delay a bot's configuration implies, for the lobby to print beside the
 * percentage. M09.11 shows calculated seconds next to every dial, and this is
 * what it shows.
 */
export function botDelayTable(
  pacing: BotPacing,
  budgets: BotPacingBudgets,
): Readonly<Record<BotDecisionCategory, number>> {
  return Object.freeze({
    ordinary: botDelayMs(pacing, budgets, 'ordinary'),
    pending_choice: botDelayMs(pacing, budgets, 'pending_choice'),
    reaction: botDelayMs(pacing, budgets, 'reaction'),
  });
}

/** Same shape as the other registry checks, for the same reason. */
export function pacingRegistryGaps(): string[] {
  const problems: string[] = [];
  const keys = new Set<string>(PACING_BUDGET_KEYS);
  for (const category of BOT_DECISION_CATEGORIES) {
    const key = PACING_BUDGET_BY_CATEGORY[category];
    if (!keys.has(key)) problems.push(`decision category "${category}" draws on no known budget.`);
  }
  for (const key of Object.keys(PACING_BUDGET_BY_CATEGORY)) {
    if (!BOT_DECISION_CATEGORIES.includes(key as BotDecisionCategory)) {
      problems.push(`"${key}" has a budget but is not a decision category.`);
    }
  }
  return problems;
}
