import { describe, expect, it } from 'vitest';
import type { CardDefinitionInput } from '@tcg/card-data';
import { currentAttack, definitionOf, playerOf } from './derive.js';
import {
  apply,
  databaseWith,
  deployUnit,
  eventsOfType,
  expectRejected,
  giveCard,
  instanceIn,
  keepBothHands,
  setEnergy,
  startMatch,
  testContext,
} from './test-fixtures.js';
import { legalActions } from './legal-actions.js';
import type { MatchState } from './schema/state.js';

/**
 * Optional instructions, "if you do", and costs a player chooses the victims
 * for (ruleset update §15).
 *
 * Three mechanics that look like one and are not:
 *
 *  - **`optional`** — a yes/no on an instruction with nothing to decline by
 *    other means. The answer arrives as a `confirm` choice at resolution.
 *  - **an optional target selector** — "you may pick nothing", which is the
 *    better encoding whenever the decision *is* which card, because declining
 *    by choosing none is one interaction instead of two.
 *  - **an additional cost** — paid as the card is played, before an opponent's
 *    Reaction window can answer it, and never refunded.
 *
 * The last one is why an interactive cost cannot be a paused resolution: the
 * queue is the only thing that can pause, and nothing has been queued yet. It is
 * a paused *action* instead, re-run from the top once answered.
 */

const CARDS: CardDefinitionInput[] = [
  /** Filler to sacrifice, distinguishable by cost so a choice can be checked. */
  {
    schemaVersion: 3,
    id: 'oc_fodder',
    name: 'Fodder',
    type: 'unit',
    colorIdentity: [],
    cost: 1,
    attack: 1,
    health: 1,
  },
  {
    schemaVersion: 3,
    id: 'oc_bigger_fodder',
    name: 'Bigger Fodder',
    type: 'unit',
    colorIdentity: [],
    cost: 2,
    attack: 3,
    health: 3,
  },
  /** "You may draw a card." The plainest possible optional instruction. */
  {
    schemaVersion: 3,
    id: 'oc_may_draw',
    name: 'Perhaps Study',
    type: 'spell',
    colorIdentity: [],
    cost: 1,
    effects: [{ type: 'draw', optional: true, player: 'self', amount: 1 }],
  },
  /**
   * "You may sacrifice a unit. If you do, draw two cards."
   *
   * The decline path is an empty selection on an optional selector, not a
   * confirm — which is precisely the case `previousStepActed` has to get right,
   * since the engine still calls that instruction resolved.
   */
  {
    schemaVersion: 3,
    id: 'oc_if_you_do',
    name: 'Grim Bargain',
    type: 'spell',
    colorIdentity: [],
    cost: 1,
    effects: [
      {
        type: 'sacrifice',
        target: {
          kind: 'entity',
          selector: {
            zone: 'battlefield',
            controller: 'self',
            count: 1,
            selection: 'player_choice',
            optional: true,
          },
        },
      },
      {
        type: 'draw',
        condition: { kind: 'previous_step' },
        player: 'self',
        amount: 2,
      },
    ],
  },
  /** "As an additional cost, sacrifice a unit. Draw two cards." */
  {
    schemaVersion: 3,
    id: 'oc_offering',
    name: 'Test Offering',
    type: 'spell',
    colorIdentity: [],
    cost: 1,
    additionalCosts: [{ type: 'sacrifice', amount: 1 }],
    effects: [{ type: 'draw', player: 'self', amount: 2 }],
  },
  /** The same cost, but the engine picks — the pre-existing behaviour. */
  {
    schemaVersion: 3,
    id: 'oc_offering_auto',
    name: 'Automatic Offering',
    type: 'spell',
    colorIdentity: [],
    cost: 1,
    additionalCosts: [{ type: 'sacrifice', amount: 1, selection: 'automatic' }],
    effects: [{ type: 'draw', player: 'self', amount: 2 }],
  },
  /** Counters whatever it answers, so the no-refund rule can be checked. */
  {
    schemaVersion: 3,
    id: 'oc_denial',
    name: 'Test Denial',
    type: 'reaction',
    colorIdentity: [],
    cost: 1,
    reaction: { windows: ['when_opponent_plays_spell'] },
    effects: [{ type: 'counter' }],
  },
  /** An activated ability whose only cost is sacrificing something else. */
  {
    schemaVersion: 3,
    id: 'oc_feeder',
    name: 'Test Feeder',
    type: 'unit',
    colorIdentity: [],
    cost: 2,
    attack: 1,
    health: 3,
    activatedAbilities: [
      {
        id: 'feed',
        name: 'Feed',
        costs: [{ type: 'sacrifice', amount: 1, excludeSource: true }],
        usageLimit: 'once_per_turn',
        effects: [
          {
            type: 'modify_stats',
            target: { kind: 'source' },
            attack: 2,
            health: 0,
            duration: 'end_of_turn',
          },
        ],
      },
    ],
  },
];

const context = testContext();
const contextWith = { ...context, database: databaseWith(CARDS) };

/** A match at player_1's first Main Phase with enough energy for anything. */
function board(): MatchState {
  return setEnergy(keepBothHands(startMatch(), contextWith), 'player_1', 10);
}

function pending(state: MatchState) {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('Expected a pending choice.');
  return choice;
}

describe('optional instructions', () => {
  it('asks the controller yes/no and does the step on yes', () => {
    const { state, instanceId } = giveCard(board(), 'player_1', 'oc_may_draw');
    const handBefore = playerOf(state, 'player_1').hand.length;

    const asked = apply(
      state,
      { type: 'play_card', playerId: 'player_1', instanceId },
      contextWith,
    );
    const choice = pending(asked);
    expect(choice.type).toBe('confirm');
    expect(choice.reason).toBe('optional_effect');
    expect(choice.validEntityIds).toEqual(['yes', 'no']);

    const done = apply(
      asked,
      { type: 'submit_choice', playerId: 'player_1', choiceId: choice.id, selectedIds: ['yes'] },
      contextWith,
    );
    // -1 for the spell leaving hand, +1 for the draw.
    expect(playerOf(done, 'player_1').hand.length).toBe(handBefore);
  });

  it('skips the step on no, and records the refusal as its own fizzle reason', () => {
    const { state, instanceId } = giveCard(board(), 'player_1', 'oc_may_draw');
    const handBefore = playerOf(state, 'player_1').hand.length;

    const asked = apply(
      state,
      { type: 'play_card', playerId: 'player_1', instanceId },
      contextWith,
    );
    const done = apply(
      asked,
      {
        type: 'submit_choice',
        playerId: 'player_1',
        choiceId: pending(asked).id,
        selectedIds: ['no'],
      },
      contextWith,
    );

    expect(playerOf(done, 'player_1').hand.length).toBe(handBefore - 1);
    expect(eventsOfType(done, 'effect_fizzled').map((event) => event.reason)).toEqual(['declined']);
  });

  it('does not ask when the step has nothing to act on', () => {
    // "You may ready one of your units" with no units: an offer with one
    // possible outcome is a pause, not a choice.
    const database = databaseWith([
      ...CARDS,
      {
        schemaVersion: 3,
        id: 'oc_may_ready',
        name: 'Perhaps Rally',
        type: 'spell',
        colorIdentity: [],
        cost: 1,
        effects: [
          {
            type: 'ready',
            optional: true,
            target: {
              kind: 'entity',
              selector: { zone: 'battlefield', controller: 'self', count: 1 },
            },
          },
        ],
      },
    ]);
    const withReady = { ...context, database };
    const { state, instanceId } = giveCard(
      setEnergy(keepBothHands(startMatch(), withReady), 'player_1', 10),
      'player_1',
      'oc_may_ready',
    );

    const done = apply(state, { type: 'play_card', playerId: 'player_1', instanceId }, withReady);
    expect(done.pendingChoice).toBeNull();
    expect(eventsOfType(done, 'effect_fizzled').map((event) => event.reason)).toEqual([
      'no_legal_target',
    ]);
  });
});

describe('"if you do"', () => {
  it('runs the follow-up when the optional step actually happened', () => {
    const placed = deployUnit(board(), 'player_1', 'oc_fodder');
    const { state, instanceId } = giveCard(placed.state, 'player_1', 'oc_if_you_do');
    const handBefore = playerOf(state, 'player_1').hand.length;

    const asked = apply(
      state,
      { type: 'play_card', playerId: 'player_1', instanceId },
      contextWith,
    );
    const done = apply(
      asked,
      {
        type: 'submit_choice',
        playerId: 'player_1',
        choiceId: pending(asked).id,
        selectedIds: [placed.instanceId],
      },
      contextWith,
    );

    expect(instanceIn(done, placed.instanceId).zone).toBe('discard');
    // -1 spell, +2 drawn.
    expect(playerOf(done, 'player_1').hand.length).toBe(handBefore + 1);
  });

  it('skips the follow-up when the optional step was declined', () => {
    const placed = deployUnit(board(), 'player_1', 'oc_fodder');
    const { state, instanceId } = giveCard(placed.state, 'player_1', 'oc_if_you_do');
    const handBefore = playerOf(state, 'player_1').hand.length;

    const asked = apply(
      state,
      { type: 'play_card', playerId: 'player_1', instanceId },
      contextWith,
    );
    const done = apply(
      asked,
      {
        type: 'submit_choice',
        playerId: 'player_1',
        choiceId: pending(asked).id,
        selectedIds: [],
      },
      contextWith,
    );

    // Declining an optional selector still counts as the instruction resolving,
    // so the gate cannot be reading the outcome kind — it reads whether the step
    // changed anything.
    expect(instanceIn(done, placed.instanceId).zone).toBe('battlefield');
    expect(playerOf(done, 'player_1').hand.length).toBe(handBefore - 1);
  });

  it('is rejected at authoring time as the first instruction of a list', () => {
    expect(() =>
      databaseWith([
        {
          schemaVersion: 3,
          id: 'oc_dangling',
          name: 'Dangling Gate',
          type: 'spell',
          colorIdentity: [],
          cost: 1,
          effects: [
            { type: 'draw', condition: { kind: 'previous_step' }, player: 'self', amount: 1 },
          ],
        },
      ]),
    ).toThrow(/instruction before it/);
  });
});

describe('additional costs', () => {
  it('pauses for the victim before anything is spent, then pays it', () => {
    let state = board();
    const first = deployUnit(state, 'player_1', 'oc_fodder');
    const second = deployUnit(first.state, 'player_1', 'oc_bigger_fodder');
    const placed = giveCard(second.state, 'player_1', 'oc_offering');
    state = placed.state;

    const energyBefore = playerOf(state, 'player_1').energy;
    const asked = apply(
      state,
      { type: 'play_card', playerId: 'player_1', instanceId: placed.instanceId },
      contextWith,
    );

    const choice = pending(asked);
    expect(choice.reason).toBe('sacrifice_cost');
    expect(choice.validEntityIds).toEqual([first.instanceId, second.instanceId]);
    // Nothing has been committed: the card is still in hand and the energy is
    // still there. That is the whole point of pausing before the commit.
    expect(playerOf(asked, 'player_1').hand).toContain(placed.instanceId);
    expect(playerOf(asked, 'player_1').energy).toBe(energyBefore);

    const done = apply(
      asked,
      {
        type: 'submit_choice',
        playerId: 'player_1',
        choiceId: choice.id,
        selectedIds: [second.instanceId],
      },
      contextWith,
    );

    expect(instanceIn(done, second.instanceId).zone).toBe('discard');
    expect(instanceIn(done, first.instanceId).zone).toBe('battlefield');
    expect(playerOf(done, 'player_1').energy).toBe(energyBefore - 1);
  });

  it('does not ask when only one unit can pay', () => {
    const only = deployUnit(board(), 'player_1', 'oc_fodder');
    const placed = giveCard(only.state, 'player_1', 'oc_offering');

    const done = apply(
      placed.state,
      { type: 'play_card', playerId: 'player_1', instanceId: placed.instanceId },
      contextWith,
    );
    expect(done.pendingChoice).toBeNull();
    expect(instanceIn(done, only.instanceId).zone).toBe('discard');
  });

  it('picks deterministically when the cost says automatic', () => {
    const first = deployUnit(board(), 'player_1', 'oc_fodder');
    const second = deployUnit(first.state, 'player_1', 'oc_bigger_fodder');
    const placed = giveCard(second.state, 'player_1', 'oc_offering_auto');

    const done = apply(
      placed.state,
      { type: 'play_card', playerId: 'player_1', instanceId: placed.instanceId },
      contextWith,
    );
    expect(done.pendingChoice).toBeNull();
    expect(instanceIn(done, first.instanceId).zone).toBe('discard');
    expect(instanceIn(done, second.instanceId).zone).toBe('battlefield');
  });

  it('is unplayable, and unlisted, when the cost cannot be paid', () => {
    const placed = giveCard(board(), 'player_1', 'oc_offering');
    const legal = legalActions(placed.state, 'player_1', contextWith);
    expect(legal.playableCards.map((card) => card.instanceId)).not.toContain(placed.instanceId);

    const error = expectRejected(
      placed.state,
      { type: 'play_card', playerId: 'player_1', instanceId: placed.instanceId },
      contextWith,
    );
    expect(error.code).toBe('engine/cost_unpayable');
  });

  it('rejects an answer that has stopped being legal, leaving the choice standing', () => {
    const first = deployUnit(board(), 'player_1', 'oc_fodder');
    const second = deployUnit(first.state, 'player_1', 'oc_bigger_fodder');
    const placed = giveCard(second.state, 'player_1', 'oc_offering');

    const asked = apply(
      placed.state,
      { type: 'play_card', playerId: 'player_1', instanceId: placed.instanceId },
      contextWith,
    );
    // A unit the opponent controls was never a legal payer, so the option list
    // never held it — the engine must refuse it rather than trust the client.
    const enemy = deployUnit(asked, 'player_2', 'oc_fodder');
    const error = expectRejected(
      enemy.state,
      {
        type: 'submit_choice',
        playerId: 'player_1',
        choiceId: pending(asked).id,
        selectedIds: [enemy.instanceId],
      },
      contextWith,
    );
    expect(error.code).toBe('engine/invalid_selection');
    expect(enemy.state.pendingChoice).not.toBeNull();
  });
});

describe('additional costs and countering', () => {
  it('does not refund the sacrifice when the spell is countered', () => {
    let state = setEnergy(board(), 'player_2', 6);
    const fodder = deployUnit(state, 'player_1', 'oc_fodder');
    state = giveCard(fodder.state, 'player_2', 'oc_denial').state;
    const offering = giveCard(state, 'player_1', 'oc_offering');

    const handBefore = playerOf(offering.state, 'player_1').hand.length;
    let next = apply(
      offering.state,
      { type: 'play_card', playerId: 'player_1', instanceId: offering.instanceId },
      contextWith,
    );

    // The cost is paid as the card is played, so the sacrifice has already
    // happened by the time the window opens — which is the whole reason it is a
    // cost and not a first instruction.
    expect(instanceIn(next, fodder.instanceId).zone).toBe('discard');

    const reaction = legalActions(next, 'player_2', contextWith).reaction?.playableCards[0];
    if (!reaction) throw new Error('Expected the rival to hold a playable Reaction.');
    next = apply(
      next,
      { type: 'play_reaction', playerId: 'player_2', instanceId: reaction.instanceId },
      contextWith,
    );
    for (let guard = 0; guard < 8 && next.reactionWindow !== null; guard += 1) {
      const open = next.reactionWindow;
      const holder = open.priorityOrder[open.priorityIndex];
      if (open.closed || holder === undefined) break;
      next = apply(next, { type: 'pass_reaction', playerId: holder }, contextWith);
    }

    expect(eventsOfType(next, 'card_countered')).toHaveLength(1);
    // The unit stays dead and the energy stays spent; only the two cards the
    // spell would have drawn are missing.
    expect(instanceIn(next, fodder.instanceId).zone).toBe('discard');
    expect(playerOf(next, 'player_1').hand.length).toBe(handBefore - 1);
  });
});

/**
 * The five shipped cards this vocabulary was built for.
 *
 * Deliberately the printed cards from the bundle rather than fixtures: the
 * fixtures above prove the mechanics, and these prove that the catalog's
 * authoring of them is the authoring the engine executes.
 */
describe('the Precon Wave 1 cards', () => {
  /** A match at player_1's Main Phase, using only the shipped card pool. */
  function shipped(): MatchState {
    return setEnergy(keepBothHands(startMatch(), context), 'player_1', 10);
  }

  it('Feed the Pit pays its sacrifice and defeats a cheap enemy unit', () => {
    let state = shipped();
    const mine = deployUnit(state, 'player_1', 'ashen_vermin');
    const theirs = deployUnit(mine.state, 'player_2', 'ashen_vermin');
    const spell = giveCard(theirs.state, 'player_1', 'feed_the_pit');
    state = spell.state;

    // One friendly unit means one legal payer, so the cost settles without a
    // pause and the only choice offered is the removal target.
    const played = apply(
      state,
      { type: 'play_card', playerId: 'player_1', instanceId: spell.instanceId },
      context,
    );
    expect(instanceIn(played, mine.instanceId).zone).toBe('discard');

    const choice = pending(played);
    expect(choice.reason).toBe('effect_target');
    const done = apply(
      played,
      {
        type: 'submit_choice',
        playerId: 'player_1',
        choiceId: choice.id,
        selectedIds: [theirs.instanceId],
      },
      context,
    );
    expect(instanceIn(done, theirs.instanceId).zone).toBe('discard');
  });

  it('Forbidden Offering is unplayable with no unit to offer', () => {
    const spell = giveCard(shipped(), 'player_1', 'forbidden_offering');
    const legal = legalActions(spell.state, 'player_1', context);
    expect(legal.playableCards.map((card) => card.instanceId)).not.toContain(spell.instanceId);
  });

  it('Pit Executioner skips its removal when the sacrifice is declined', () => {
    const feeder = deployUnit(shipped(), 'player_1', 'ashen_vermin');
    const victim = deployUnit(feeder.state, 'player_2', 'ashen_vermin');
    const card = giveCard(victim.state, 'player_1', 'pit_executioner');

    const deployed = apply(
      card.state,
      { type: 'play_card', playerId: 'player_1', instanceId: card.instanceId },
      context,
    );
    const choice = pending(deployed);
    // The Executioner itself is on the battlefield now, and "another Unit"
    // keeps it off its own menu.
    expect(choice.validEntityIds).toEqual([feeder.instanceId]);
    expect(choice.minimum).toBe(0);

    const declined = apply(
      deployed,
      { type: 'submit_choice', playerId: 'player_1', choiceId: choice.id, selectedIds: [] },
      context,
    );
    expect(declined.pendingChoice).toBeNull();
    expect(instanceIn(declined, feeder.instanceId).zone).toBe('battlefield');
    expect(instanceIn(declined, victim.instanceId).zone).toBe('battlefield');
  });

  it('Carrion Feeder eats another unit once a turn for +2 attack', () => {
    const feeder = deployUnit(shipped(), 'player_1', 'carrion_feeder');
    const meal = deployUnit(feeder.state, 'player_1', 'ashen_vermin');

    const done = apply(
      meal.state,
      {
        type: 'activate_ability',
        playerId: 'player_1',
        sourceInstanceId: feeder.instanceId,
        abilityId: 'feed',
      },
      context,
    );
    expect(done.pendingChoice).toBeNull();
    expect(instanceIn(done, meal.instanceId).zone).toBe('discard');
    const instance = instanceIn(done, feeder.instanceId);
    expect(currentAttack(instance, definitionOf(context.database, instance))).toBe(3);

    // Once each turn: the ability is gone from the legal list even though there
    // is still something else it could eat.
    const another = deployUnit(done, 'player_1', 'ashen_vermin');
    const legal = legalActions(another.state, 'player_1', context);
    expect(
      legal.activatableAbilities.filter((entry) => entry.sourceInstanceId === feeder.instanceId),
    ).toEqual([]);
  });
});

describe('interactive activation costs', () => {
  it('lets the controller pick which unit the ability eats', () => {
    const feeder = deployUnit(board(), 'player_1', 'oc_feeder');
    const first = deployUnit(feeder.state, 'player_1', 'oc_fodder');
    const second = deployUnit(first.state, 'player_1', 'oc_bigger_fodder');

    const asked = apply(
      second.state,
      {
        type: 'activate_ability',
        playerId: 'player_1',
        sourceInstanceId: feeder.instanceId,
        abilityId: 'feed',
      },
      contextWith,
    );

    const choice = pending(asked);
    expect(choice.reason).toBe('sacrifice_cost');
    // "Sacrifice another Unit": the feeder is not on its own menu.
    expect(choice.validEntityIds).not.toContain(feeder.instanceId);

    const done = apply(
      asked,
      {
        type: 'submit_choice',
        playerId: 'player_1',
        choiceId: choice.id,
        selectedIds: [second.instanceId],
      },
      contextWith,
    );
    expect(instanceIn(done, second.instanceId).zone).toBe('discard');
    const feederInstance = instanceIn(done, feeder.instanceId);
    expect(currentAttack(feederInstance, definitionOf(contextWith.database, feederInstance))).toBe(
      3,
    );
  });

  it('does not offer the ability when the source is the only unit', () => {
    const feeder = deployUnit(board(), 'player_1', 'oc_feeder');
    const legal = legalActions(feeder.state, 'player_1', contextWith);
    // The Commander's own ability is always on offer; the feeder's is not,
    // because "another Unit" leaves it nothing to eat.
    expect(
      legal.activatableAbilities.filter((entry) => entry.sourceInstanceId === feeder.instanceId),
    ).toEqual([]);
  });
});
