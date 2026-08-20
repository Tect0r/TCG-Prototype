import { BOT_DECISION_CATEGORIES, type BotDecisionCategory } from '@tcg/bot-config';
import type { LegalActions } from '@tcg/rules-engine';
import { DECISION_FAMILIES, type DecisionFamily } from './types.js';

/**
 * Which pacing budget an opportunity draws on (M09.12).
 *
 * `@tcg/bot-config` fixed the vocabulary in M09.1 and deliberately left the
 * classification to the tranche that would spend the budgets. This is that
 * classification, and it lives here rather than in the server because it is a
 * statement about *what the pilot is being asked*, and the answer to that
 * question is `candidateActions`' — one file along, in this package.
 *
 * It is derived from structured data only: the engine's own `LegalActions`, and
 * nothing read out of display text, a card name or a rendered view. Nothing here
 * reads a clock, holds an action, or knows a bot exists — the runner asks it what
 * kind of opportunity it is looking at and then decides how long to wait.
 */

/**
 * Every decision family, and the budget its category draws on. Total over
 * `DECISION_FAMILIES`, so a new family cannot be added without deciding whether
 * it is somebody else's window or the bot's own turn.
 *
 * Only the two Reaction families are `reaction`. `assign_blockers` is
 * deliberately **not**: blocking is an answer to a declaration rather than to an
 * open Reaction window, and the five-second budget is named for the mechanic
 * (`legal.reaction`) rather than for "anything that happens on somebody else's
 * turn". Adding a third budget to split them is a configuration change M09.1
 * considered and did not make.
 */
export const CATEGORY_BY_DECISION_FAMILY: Readonly<Record<DecisionFamily, BotDecisionCategory>> =
  Object.freeze({
    mulligan: 'ordinary',
    play_card: 'ordinary',
    activate_ability: 'ordinary',
    pass_phase: 'ordinary',
    declare_attackers: 'ordinary',
    assign_blockers: 'ordinary',
    play_reaction: 'reaction',
    pass_reaction: 'reaction',
    submit_choice: 'pending_choice',
    concede: 'ordinary',
  });

/**
 * What kind of opportunity this seat is being offered.
 *
 * The order is `candidateActions`' order and must stay it: a seat holding both a
 * pending choice and an open Reaction window is being asked for the choice, so
 * the choice is what it is timed on. `decisionCategoryDisagreement` below is what
 * keeps the two from drifting apart, by checking this answer against the family
 * the candidates actually came out as.
 */
export function classifyDecisionCategory(legal: LegalActions): BotDecisionCategory {
  if (legal.pendingChoice) return 'pending_choice';
  if (legal.mulligan) return 'ordinary';
  if (legal.reaction) return 'reaction';
  return 'ordinary';
}

/**
 * The cross-check, exported so it can be run against real boards rather than
 * against a fixture of one.
 *
 * Returns a readable disagreement when the families a set of candidates actually
 * carries do not all map to the category `classifyDecisionCategory` gave the same
 * `LegalActions`, and `null` when they agree. A candidate list that is empty
 * agrees with anything: the seat was not being offered a decision at all.
 */
export function decisionCategoryDisagreement(
  legal: LegalActions,
  families: readonly DecisionFamily[],
): string | null {
  if (families.length === 0) return null;
  const expected = classifyDecisionCategory(legal);
  const seen = [...new Set(families)].map((family) => CATEGORY_BY_DECISION_FAMILY[family]);
  const wrong = seen.filter((category) => category !== expected);
  if (wrong.length === 0) return null;
  return (
    `classified as "${expected}" but the offered candidates are ` +
    `${[...new Set(families)].sort().join(', ')}, which draw on ${[...new Set(wrong)].sort().join(', ')}.`
  );
}

/** Same shape as the other registry checks, for the same reason. */
export function decisionCategoryGaps(): string[] {
  const problems: string[] = [];
  const categories = new Set<string>(BOT_DECISION_CATEGORIES);
  for (const family of DECISION_FAMILIES) {
    const category: BotDecisionCategory | undefined = CATEGORY_BY_DECISION_FAMILY[family];
    if (category === undefined) problems.push(`decision family "${family}" has no category.`);
    else if (!categories.has(category)) {
      problems.push(`decision family "${family}" draws on unknown category "${category}".`);
    }
  }
  for (const family of Object.keys(CATEGORY_BY_DECISION_FAMILY)) {
    if (!DECISION_FAMILIES.includes(family as DecisionFamily)) {
      problems.push(`"${family}" has a category but is not a decision family.`);
    }
  }
  return problems;
}
