import { describe, expect, it } from 'vitest';
import {
  BOT_DECISION_CATEGORIES,
  PACING_BUDGET_BY_CATEGORY,
  type BotDecisionCategory,
} from '@tcg/bot-config';
import { DEFAULT_RULES_CONFIG, type LegalActions } from '@tcg/rules-engine';
import { candidateActions } from './candidates.js';
import {
  CATEGORY_BY_DECISION_FAMILY,
  classifyDecisionCategory,
  decisionCategoryDisagreement,
  decisionCategoryGaps,
} from './decision-category.js';
import { createPilot } from './registry.js';
import { DEFAULT_WEIGHTS } from './scoring.js';
import { botTestDatabase, driveMatch } from './test-driver.js';
import { DECISION_FAMILIES } from './types.js';

/**
 * Which pacing budget an opportunity draws on (M09.12).
 *
 * The scheduler that spends the budgets lives in the server, and its own suite
 * asserts the milliseconds. What is asserted here is the thing the milliseconds
 * are derived *from*: that the category is read out of the engine's structured
 * `LegalActions` and nothing else, that the mapping is total over the decision
 * families, and — the part a fixture could not show — that the category the
 * scheduler picks agrees with the family the pilot is actually about to answer,
 * on every board of a real match rather than on one board somebody chose.
 */

const database = botTestDatabase();
const config = DEFAULT_RULES_CONFIG;

/** A `LegalActions` with only the fields the classification is allowed to read. */
function legalWith(overrides: Partial<LegalActions>): LegalActions {
  return {
    playerId: 'player_1',
    playableCards: [],
    activatableAbilities: [],
    canPassPhase: true,
    canConcede: true,
    mulligan: null,
    reaction: null,
    attacking: null,
    blocking: null,
    pendingChoice: null,
    ...overrides,
  } as LegalActions;
}

describe('the mapping is total, both ways', () => {
  it('gives every decision family a known category', () => {
    expect(decisionCategoryGaps()).toEqual([]);
  });

  it('names a category that some budget actually pays for', () => {
    for (const family of DECISION_FAMILIES) {
      const category = CATEGORY_BY_DECISION_FAMILY[family];
      expect(BOT_DECISION_CATEGORIES).toContain(category);
      // The other half of the chain: a category with no budget would classify
      // cleanly and then schedule nothing.
      expect(PACING_BUDGET_BY_CATEGORY[category]).toBeDefined();
    }
  });

  it('is exactly this table, so a change to it has to be argued for', () => {
    // Written out rather than derived, for the reason `PACING_BUDGET_BY_CATEGORY`
    // is: the two Reaction families are the only ones on the five-second budget,
    // and a card or a phase that quietly moved a third one there would otherwise
    // change every bot's timing without a line of this suite noticing.
    expect(CATEGORY_BY_DECISION_FAMILY).toEqual({
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
    expect(Object.keys(CATEGORY_BY_DECISION_FAMILY).sort()).toEqual([...DECISION_FAMILIES].sort());
  });
});

describe('the category is read from structured legality alone', () => {
  it('prefers a pending choice to everything else offered at the same time', () => {
    // A seat can hold a pending choice while a Reaction window is open. It is
    // being asked for the choice, so the choice is what it is timed on — the
    // same precedence `candidateActions` uses to decide what to enumerate.
    const legal = legalWith({
      pendingChoice: { playerId: 'player_1' } as LegalActions['pendingChoice'],
      reaction: { playableCards: [] } as unknown as LegalActions['reaction'],
    });
    expect(classifyDecisionCategory(legal)).toBe('pending_choice');
  });

  it('times a mulligan on the ordinary budget and a Reaction window on its own', () => {
    expect(
      classifyDecisionCategory(
        legalWith({ mulligan: { hand: [] } as unknown as LegalActions['mulligan'] }),
      ),
    ).toBe('ordinary');
    expect(
      classifyDecisionCategory(
        legalWith({ reaction: { playableCards: [] } as unknown as LegalActions['reaction'] }),
      ),
    ).toBe('reaction');
    expect(classifyDecisionCategory(legalWith({}))).toBe('ordinary');
  });

  it('does not treat blocking as a Reaction', () => {
    // Blocking answers a declaration rather than an open Reaction window, so it
    // draws on the thirty-second budget. Asserted rather than left implicit,
    // because the five-second budget is named for the mechanic and it would be
    // easy to read it as "anything on somebody else's turn".
    expect(
      classifyDecisionCategory(
        legalWith({ blocking: { attackers: [] } as unknown as LegalActions['blocking'] }),
      ),
    ).toBe('ordinary');
    expect(CATEGORY_BY_DECISION_FAMILY.assign_blockers).toBe('ordinary');
  });
});

describe('the classification agrees with what the pilot is actually asked', () => {
  it('never disagrees across a whole real match, and sees all three categories', async () => {
    const seen = new Set<BotDecisionCategory>();
    const disagreements: string[] = [];

    const outcome = await driveMatch({
      seed: 'decision-category',
      pilots: [createPilot({ id: 'value' }), createPilot({ id: 'aggressive' })],
      database,
      config,
      onObservation: (observation) => {
        const families = candidateActions(observation, {
          weights: DEFAULT_WEIGHTS,
          mayConcede: false,
        }).map((candidate) => candidate.family);
        seen.add(classifyDecisionCategory(observation.legal));
        const disagreement = decisionCategoryDisagreement(observation.legal, families);
        if (disagreement) disagreements.push(disagreement);
      },
    });

    expect(outcome.stoppedEarly).toBe(false);
    expect(disagreements).toEqual([]);
    // A match that never asked a choice would make the line above pass without
    // exercising anything but the default. The third category is missing on
    // purpose and not by luck: `driveMatch` resolves the seat to act from
    // pending choice, mulligan, blocker and active player, and has no branch for
    // an open Reaction window, so a deck holding a Reaction desynchronises the
    // driver rather than producing one. Real Reaction windows are classified
    // under a real match in `apps/multiplayer-server/src/bot-delay.test.ts`,
    // which asserts all three categories from shipping precons.
    expect([...seen].sort()).toEqual(['ordinary', 'pending_choice']);
  });

  it('names the families and the budgets when it does disagree', () => {
    const reaction = legalWith({
      reaction: { playableCards: [] } as unknown as LegalActions['reaction'],
    });
    // A Reaction window whose candidates came out as ordinary play is exactly
    // the drift this function exists to catch.
    const message = decisionCategoryDisagreement(reaction, ['play_card', 'pass_reaction']);
    expect(message).toContain('reaction');
    expect(message).toContain('play_card');
    expect(message).toContain('ordinary');
  });

  it('agrees with anything when the seat was offered nothing', () => {
    expect(decisionCategoryDisagreement(legalWith({}), [])).toBeNull();
  });
});
