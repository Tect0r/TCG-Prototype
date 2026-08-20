import {
  PACING_SAFETY_MARGIN_MS,
  botDelayMs,
  pacingPercentFor,
  type BotPacing,
  type BotPacingBudgets,
} from '@tcg/bot-config';

/**
 * The seconds a lobby prints beside every percentage (M09.11).
 *
 * A percentage on its own is not a number anybody can read: 50% of what, and
 * how long is that? Every dial in the bot panel therefore carries the delay it
 * implies, computed by `botDelayMs` — the same function M09.12's scheduler will
 * use — rather than by a second piece of arithmetic in a component. If the two
 * ever disagreed, the screen would be the one that was wrong, and a tester
 * timing a bot with a stopwatch would be the one who found out.
 *
 * Nothing here waits, times anything, or reads a clock. These are **bot pacing
 * references, not human timers**: no budget in this file times out, passes for,
 * or defeats a person, and open-questions.md Q8 is still open
 * ([ADR 0024](../../../../docs/architecture/0024-live-bot-seats.md) §4).
 */

/**
 * Milliseconds as seconds, exactly, with up to two decimals and no trailing
 * zeros.
 *
 * Exact rather than rounded to one decimal because the safety margin is a
 * quarter of a second: at 100% of a 30-second budget the wait is 29.75 s, and a
 * screen that printed "29.8 s" would be describing a delay the scheduler does
 * not use.
 */
export function secondsLabel(ms: number): string {
  const text = (ms / 1000).toFixed(2).replace(/\.?0+$/, '');
  return `${text} s`;
}

/** What a bot waits before an ordinary decision or a pending choice. */
export function ordinaryPacingLabel(pacing: BotPacing, budgets: BotPacingBudgets): string {
  const delay = botDelayMs(pacing, budgets, 'ordinary');
  return `${pacing.percent}% of ${budgets.ordinarySeconds} s — ${secondsLabel(delay)} before a decision or a choice`;
}

/**
 * What it waits inside somebody else's Reaction window.
 *
 * Says whether the percentage was inherited, because "50%" beside a Reaction
 * budget means two different configurations — one the host set here, and one
 * they set once above — and only one of them changes when they move the other.
 */
export function reactionPacingLabel(pacing: BotPacing, budgets: BotPacingBudgets): string {
  const percent = pacingPercentFor(pacing, 'reaction');
  const delay = botDelayMs(pacing, budgets, 'reaction');
  const inherited = pacing.reactionPercent === null ? ' (inherited)' : '';
  return `${percent}%${inherited} of ${budgets.reactionSeconds} s — ${secondsLabel(delay)} in a Reaction window`;
}

/**
 * The same fact in a tag beside a seat, for every player rather than the host.
 *
 * A bot's percentage is public — an opponent can time it with a stopwatch — so
 * the lobby shows it to everyone, with the seconds it implies rather than the
 * percentage alone.
 */
export function compactPacingLabel(pacing: BotPacing, budgets: BotPacingBudgets): string {
  return `${pacing.percent}% · ${secondsLabel(botDelayMs(pacing, budgets, 'ordinary'))}`;
}

/**
 * Why 100% is not the whole budget.
 *
 * Printed wherever a budget is, because the alternative is a host setting 100%,
 * timing 29.75 seconds and concluding the number on the screen was a lie. The
 * margin is `@tcg/bot-config`'s constant rather than a sentence with a number
 * typed into it.
 */
export const PACING_SAFETY_MARGIN_NOTE =
  `A bot never waits a whole budget: ${secondsLabel(PACING_SAFETY_MARGIN_MS)} of it is kept ` +
  'for deciding and submitting, so 100% stops that much short.';

/** Said wherever a budget is offered, so it cannot be mistaken for a rule. */
export const PACING_IS_NOT_A_HUMAN_TIMER =
  'These budgets pace bots only. Nothing here times you out of a phase, a choice or a match.';
