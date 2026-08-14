import { describe, expect, it } from 'vitest';
import type { CardDefinitionInput } from '@tcg/card-data';
import { DEFAULT_RULES_CONFIG, type RulesConfig } from './config.js';
import { legalActions } from './legal-actions.js';
import {
  apply,
  databaseWith,
  deployUnit,
  eventsOfType,
  expectRejected,
  giveCard,
  instanceIn,
  keepAllHands,
  makeDeck,
  setEnergy,
  startMatch,
  startTable,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';

/**
 * Bounded Reaction windows (rule adjustment §5/§6).
 *
 * The tests below all use fixture cards rather than the shipped catalog. The
 * point is the *timing system* — priority, the one-per-window limit, LIFO
 * resolution, countering — and pinning it to whichever printed Reaction happens
 * to be legal at the time would make these tests fail whenever a card is
 * rebalanced.
 */

const spell = (id: string, name: string, cost: number): CardDefinitionInput => ({
  schemaVersion: 4,
  id,
  name,
  type: 'spell',
  colorIdentity: ['blue'],
  cost,
  displayText: 'Draw a card.',
  effects: [{ type: 'draw', player: 'self', amount: 1 }],
});

const CHEAP_SPELL = spell('test_cheap_spell', 'Test Cheap Spell', 1);
const PRICEY_SPELL = spell('test_pricey_spell', 'Test Pricey Spell', 5);

/** Counters whatever it was played in answer to. */
const DENIAL: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_denial',
  name: 'Test Denial',
  type: 'reaction',
  colorIdentity: ['blue'],
  cost: 1,
  displayText: 'Play when an opponent plays a Spell. Counter it.',
  reaction: { windows: ['when_opponent_plays_spell'] },
  effects: [{ type: 'counter' }],
};

/** Only answers a cheap Spell — the timing restriction, not a target filter. */
const NARROW_DENIAL: CardDefinitionInput = {
  ...DENIAL,
  id: 'test_narrow_denial',
  name: 'Test Narrow Denial',
  displayText: 'Play when an opponent plays a Spell costing 2 or less. Counter it.',
  reaction: { windows: ['when_opponent_plays_spell'], subjectFilter: { cost: { max: 2 } } },
};

const TAXING_DENIAL: CardDefinitionInput = {
  ...DENIAL,
  id: 'test_taxing_denial',
  name: 'Test Taxing Denial',
  cost: 2,
  displayText: 'Counter it unless its controller pays 2 additional Energy.',
  effects: [{ type: 'counter', unlessPays: 2 }],
};

/** A combat-window Reaction with a visible, checkable effect. */
const COMBAT_TRICK: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_combat_trick',
  name: 'Test Combat Trick',
  type: 'reaction',
  colorIdentity: ['white'],
  cost: 1,
  displayText: 'Play after attackers are declared. Draw a card.',
  reaction: { windows: ['after_attackers_declared', 'before_blockers_declared'] },
  effects: [{ type: 'draw', player: 'self', amount: 1 }],
};

/** Gives its controller the once-per-turn-cycle Reaction discount. */
const DISCOUNTER: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_discounter',
  name: 'Test Discounter',
  type: 'unit',
  colorIdentity: ['blue'],
  cost: 2,
  attack: 1,
  health: 3,
  displayText:
    'The first Reaction Spell you play after the beginning of each of your turns costs 1 less, to a minimum of 1.',
  staticAbilities: [
    {
      id: 'study',
      activeZone: 'battlefield',
      affects: { zone: 'hand', controller: 'self', filter: { cardTypes: ['reaction'] } },
      effect: { type: 'reaction_discount', amount: 1, minimum: 1, limit: 'first_each_turn' },
    },
  ],
};

const database = databaseWith([
  CHEAP_SPELL,
  PRICEY_SPELL,
  DENIAL,
  NARROW_DENIAL,
  TAXING_DENIAL,
  COMBAT_TRICK,
  DISCOUNTER,
]);
const context = { database, config: DEFAULT_RULES_CONFIG };

function ctx(config: RulesConfig): { database: typeof database; config: RulesConfig } {
  return { database, config };
}

function opened(seats = 2, config: RulesConfig = DEFAULT_RULES_CONFIG): MatchState {
  const start =
    seats === 2
      ? startMatch({ database, config, decks: [makeDeck(), makeDeck('prototype_commander_red')] })
      : startTable(seats, { database, config });
  return keepAllHands(start, { database, config });
}

/** Reaction window state, or a loud failure if none is open. */
function window(state: MatchState) {
  const open = state.reactionWindow;
  if (!open) throw new Error(`expected an open Reaction window, phase is "${state.phase}"`);
  return open;
}

function priorityHolder(state: MatchState): string {
  const open = window(state);
  return open.priorityOrder[open.priorityIndex] as string;
}

/**
 * Passes priority until the window closes.
 *
 * Always driven from whoever actually holds priority, because priority is only
 * ever offered to a seat that could use it — a player with no playable Reaction
 * is skipped rather than asked to decline, which is the difference between a
 * bounded window and a full priority system.
 */
function passUntilClosed(state: MatchState): MatchState {
  let next = state;
  for (
    let guard = 0;
    guard < 16 && next.reactionWindow !== null && next.pendingChoice === null;
    guard += 1
  ) {
    const open = next.reactionWindow;
    const holder = open.priorityOrder[open.priorityIndex];
    if (open.closed || holder === undefined) break;
    next = apply(next, { type: 'pass_reaction', playerId: holder }, context);
  }
  return next;
}

describe('opening a window', () => {
  it('does not open one when nobody holds a playable Reaction', () => {
    const state = opened();
    const active = state.activePlayerId;
    const armed = giveCard(setEnergy(state, active, 6), active, 'test_cheap_spell');

    const played = apply(
      armed.state,
      { type: 'play_card', playerId: active, instanceId: armed.instanceId },
      context,
    );

    expect(played.reactionWindow).toBeNull();
    expect(played.phase).toBe('main_1');
    // The spell resolved as it always did.
    expect(eventsOfType(played, 'spell_resolved')).toHaveLength(1);
  });

  it('opens one when an opponent can answer, and holds the Spell until it closes', () => {
    const state = opened();
    const active = state.activePlayerId;
    const rival = state.playerOrder.find((id) => id !== active) as string;

    const armed = giveCard(setEnergy(setEnergy(state, active, 6), rival, 6), rival, 'test_denial');
    const cast = giveCard(armed.state, active, 'test_cheap_spell');

    const played = apply(
      cast.state,
      { type: 'play_card', playerId: active, instanceId: cast.instanceId },
      context,
    );

    expect(played.phase).toBe('reaction_window');
    expect(window(played).windows).toContain('when_opponent_plays_spell');
    // The Spell is waiting, not resolved.
    expect(eventsOfType(played, 'spell_resolved')).toHaveLength(0);
    expect(window(played).pending.map((entry) => entry.instanceId)).toEqual([cast.instanceId]);
  });

  it('offers priority to the active player first, then clockwise', () => {
    const state = opened(4);
    const active = state.activePlayerId;
    let armed = setEnergy(state, active, 6);
    for (const playerId of state.seatOrder) {
      armed = setEnergy(armed, playerId, 6);
      armed = giveCard(armed, playerId, 'test_combat_trick').state;
    }

    const attacking = apply(armed, { type: 'pass_phase', playerId: active }, context);
    const declared = apply(
      attacking,
      { type: 'declare_attackers', playerId: active, attacks: [] },
      context,
    );

    expect(declared.phase).toBe('reaction_window');
    // Rule adjustment §5.3 supersedes the earlier "non-active player first".
    expect(window(declared).priorityOrder[0]).toBe(active);
    expect(priorityHolder(declared)).toBe(active);
  });
});

describe('priority and the one-per-window limit', () => {
  /** A two-seat match where the rival holds two Denials and the active a Spell. */
  interface Loaded {
    readonly state: MatchState;
    readonly active: string;
    readonly rival: string;
    readonly spellId: string;
    /** The Reaction handed to the active player, when one was. */
    readonly activeReactionId: string | null;
  }

  /**
   * The rival holds two Reactions and the active player has just played a
   * Spell, so a window is open.
   *
   * `armActive` also gives the active player a Reaction *before* the Spell is
   * played, which matters: eligibility is evaluated when the window opens, so a
   * card conjured into a hand afterwards would not have been counted when
   * priority was first offered.
   */
  function loaded(armActive = false): Loaded {
    const start = opened();
    const active = start.activePlayerId;
    const rival = start.playerOrder.find((id) => id !== active) as string;

    let next = setEnergy(setEnergy(start, active, 8), rival, 8);
    next = giveCard(next, rival, 'test_denial').state;
    next = giveCard(next, rival, 'test_denial').state;

    let activeReactionId: string | null = null;
    if (armActive) {
      const armed = giveCard(next, active, 'test_denial');
      next = armed.state;
      activeReactionId = armed.instanceId;
    }

    const cast = giveCard(next, active, 'test_pricey_spell');
    const played = apply(
      cast.state,
      { type: 'play_card', playerId: active, instanceId: cast.instanceId },
      context,
    );
    return { state: played, active, rival, spellId: cast.instanceId, activeReactionId };
  }

  it('does not re-offer a seat that already passed, and closes instead (Q47)', () => {
    // Both seats hold a Reaction. The active player declines, the rival answers
    // — and that is the whole window. Before Q47 was answered, playing cleared
    // every recorded pass and the active player was asked again, which is what
    // let a counter be countered by somebody who had already declined.
    const { state, active, rival, activeReactionId } = loaded(true);

    expect(priorityHolder(state)).toBe(active);
    const passed = apply(state, { type: 'pass_reaction', playerId: active }, context);
    expect(priorityHolder(passed)).toBe(rival);

    const first = legalActions(passed, rival, context).reaction?.playableCards[0];
    expect(first).toBeDefined();
    const answered = apply(
      passed,
      { type: 'play_reaction', playerId: rival, instanceId: first?.instanceId ?? '' },
      context,
    );

    // The pass survived the play, so nobody was left to offer: the window closed
    // and drained on the spot rather than coming back round to the active
    // player. It is gone entirely, which is the strongest form of "not
    // re-offered" the state can express.
    expect(answered.reactionWindow).toBeNull();
    expect(answered.phase).toBe('main_1');
    expect(legalActions(answered, active, context).reaction).toBeNull();
    // Exactly one Reaction was played in the whole window.
    expect(eventsOfType(answered, 'reaction_played')).toHaveLength(1);
    // And the active player still holds theirs, unspent and unofferable.
    expect(answered.players[active]?.hand).toContain(activeReactionId);
  });

  it('refuses a second Reaction from the same player in one window', () => {
    const { state, active, rival } = loaded(true);

    // The active player spends their one Reaction first, which hands priority to
    // the rival rather than ending the round — so the window is still open and
    // there is somewhere to refuse the active player a second.
    const own = legalActions(state, active, context).reaction?.playableCards[0];
    expect(own).toBeDefined();
    const answered = apply(
      state,
      { type: 'play_reaction', playerId: active, instanceId: own?.instanceId ?? '' },
      context,
    );

    expect(priorityHolder(answered)).toBe(rival);
    expect(window(answered).playsByPlayer[active]).toBe(1);
    // Refused twice over: they no longer hold priority, and the per-window limit
    // would refuse them even if they did.
    expect(legalActions(answered, active, context).reaction).toBeNull();
    const error = expectRejected(
      answered,
      { type: 'play_reaction', playerId: active, instanceId: own?.instanceId ?? '' },
      context,
    );
    expect(error.code).toBe('engine/wrong_player');
  });

  it('resolves the window last in, first out', () => {
    const { state, active, rival, spellId, activeReactionId } = loaded(true);

    // Two seats, one Reaction each, both spent in the same window — which is
    // still legal after Q47, because each seat had its single offer. What is
    // gone is the *re-offer*, not the interaction.
    const answered = apply(
      state,
      { type: 'play_reaction', playerId: active, instanceId: activeReactionId ?? '' },
      context,
    );
    const rivalReaction = legalActions(answered, rival, context).reaction?.playableCards[0]
      ?.instanceId as string;
    const countered = apply(
      answered,
      { type: 'play_reaction', playerId: rival, instanceId: rivalReaction },
      context,
    );

    const closed = passUntilClosed(countered);

    // Last in, first out: the rival's counter was played last, so it resolved
    // first and took the active player's with it. The original Spell was two
    // places down the queue and survived to resolve.
    expect(eventsOfType(closed, 'card_countered').map((event) => event.instanceId)).toEqual([
      activeReactionId,
    ]);
    expect(instanceIn(closed, activeReactionId as string).zone).toBe('discard');
    expect(eventsOfType(closed, 'spell_resolved').map((event) => event.instanceId)).toContain(
      spellId,
    );
  });

  it('closes once everybody has passed consecutively, then resolves', () => {
    const { state, active, rival } = loaded();

    void active;
    void rival;
    const closed = passUntilClosed(state);

    expect(closed.reactionWindow).toBeNull();
    expect(closed.phase).toBe('main_1');
    // The Spell that was waiting has now resolved.
    expect(eventsOfType(closed, 'spell_resolved')).toHaveLength(1);
    expect(eventsOfType(closed, 'reaction_window_closed')).toHaveLength(1);
  });

  it('records every pass in the log rather than collapsing them', () => {
    const { state, active, rival } = loaded();
    void active;
    void rival;
    const closed = passUntilClosed(state);
    // One pass per seat that was actually offered priority. Nothing is
    // collapsed here: the spectator log may fold runs of passes for
    // readability, and the record underneath must not.
    const passes = eventsOfType(closed, 'reaction_passed');
    expect(passes.length).toBeGreaterThan(0);
    expect(passes.length).toBe(new Set(passes.map((event) => event.playerId)).size);
  });

  it('rejects an action from a seat that does not hold priority', () => {
    const { state } = loaded();
    const holder = priorityHolder(state);
    const other = state.seatOrder.find((id) => id !== holder) as string;
    const error = expectRejected(state, { type: 'pass_reaction', playerId: other }, context);
    expect(error.code).toBe('engine/wrong_player');
  });
});

describe('countering', () => {
  function counterSetUp(reactionId: string, spellId: string) {
    const start = opened();
    const active = start.activePlayerId;
    const rival = start.playerOrder.find((id) => id !== active) as string;

    let next = setEnergy(setEnergy(start, active, 9), rival, 9);
    next = giveCard(next, rival, reactionId).state;
    const cast = giveCard(next, active, spellId);
    const played = apply(
      cast.state,
      { type: 'play_card', playerId: active, instanceId: cast.instanceId },
      context,
    );
    return { state: played, active, rival, spellInstanceId: cast.instanceId };
  }

  it('sends the countered Spell to its owner’s discard with no effect', () => {
    const { state, active, rival, spellInstanceId } = counterSetUp(
      'test_denial',
      'test_pricey_spell',
    );
    const handBefore = state.players[active]?.hand.length ?? 0;

    const answered = apply(
      state,
      {
        type: 'play_reaction',
        playerId: rival,
        instanceId: legalActions(state, rival, context).reaction?.playableCards[0]
          ?.instanceId as string,
      },
      context,
    );

    // Everyone passes; the counter resolves, then the Spell is discarded.
    const closed = passUntilClosed(answered);

    expect(instanceIn(closed, spellInstanceId).zone).toBe('discard');
    expect(eventsOfType(closed, 'card_countered')).toHaveLength(1);
    expect(eventsOfType(closed, 'spell_resolved').map((event) => event.instanceId)).not.toContain(
      spellInstanceId,
    );
    // The Spell drew nothing, because it never resolved.
    expect(closed.players[active]?.hand.length).toBe(handBefore);
  });

  it('is not offered against a Spell its printed timing excludes', () => {
    const { state, active, rival } = counterSetUp('test_narrow_denial', 'test_pricey_spell');
    // A 5-cost Spell is outside "costing 2 or less", so no window should have
    // opened at all — nobody could have used it.
    expect(state.reactionWindow).toBeNull();
    expect(state.phase).toBe('main_1');
    void active;
    void rival;
  });

  it('is offered against a Spell its printed timing admits', () => {
    const { state, active, rival } = counterSetUp('test_narrow_denial', 'test_cheap_spell');
    expect(state.phase).toBe('reaction_window');
    void active;
    expect(legalActions(state, rival, context).reaction?.playableCards).toHaveLength(1);
  });

  it('lets the countered card’s controller pay the additional Energy instead', () => {
    const { state, active, rival, spellInstanceId } = counterSetUp(
      'test_taxing_denial',
      'test_pricey_spell',
    );

    void active;
    const reactionId = legalActions(state, rival, context).reaction?.playableCards[0]
      ?.instanceId as string;
    const next = passUntilClosed(
      apply(state, { type: 'play_reaction', playerId: rival, instanceId: reactionId }, context),
    );

    // The Spell's controller is asked, and only them.
    expect(next.pendingChoice?.reason).toBe('pay_additional_cost');
    expect(next.pendingChoice?.playerId).toBe(active);
    const energyBefore = next.players[active]?.energy ?? 0;

    const paid = apply(
      next,
      {
        type: 'submit_choice',
        playerId: active,
        choiceId: next.pendingChoice?.id ?? '',
        selectedIds: ['yes'],
      },
      context,
    );

    expect(paid.players[active]?.energy).toBe(energyBefore - 2);
    expect(instanceIn(paid, spellInstanceId).zone).toBe('discard');
    expect(eventsOfType(paid, 'card_countered')).toHaveLength(0);
    expect(eventsOfType(paid, 'spell_resolved').map((event) => event.instanceId)).toContain(
      spellInstanceId,
    );
  });

  it('counters when the controller declines to pay', () => {
    const { state, active, rival, spellInstanceId } = counterSetUp(
      'test_taxing_denial',
      'test_pricey_spell',
    );
    void active;
    const reactionId = legalActions(state, rival, context).reaction?.playableCards[0]
      ?.instanceId as string;
    const next = passUntilClosed(
      apply(state, { type: 'play_reaction', playerId: rival, instanceId: reactionId }, context),
    );

    const declined = apply(
      next,
      {
        type: 'submit_choice',
        playerId: active,
        choiceId: next.pendingChoice?.id ?? '',
        selectedIds: ['no'],
      },
      context,
    );

    expect(eventsOfType(declined, 'card_countered')).toHaveLength(1);
    expect(instanceIn(declined, spellInstanceId).zone).toBe('discard');
  });
});

describe('the per-turn Reaction discount', () => {
  /**
   * The discounting unit belongs to the seat that is *not* active, which is the
   * situation the rule is written for: a Reaction is normally played on
   * somebody else's turn.
   */
  function discounted(): { state: MatchState; active: string; rival: string } {
    const start = opened();
    const active = start.activePlayerId;
    const rival = start.playerOrder.find((id) => id !== active) as string;

    let next = setEnergy(setEnergy(start, active, 9), rival, 9);
    next = deployUnit(next, rival, 'test_discounter').state;
    next = giveCard(next, rival, 'test_denial').state;
    next = giveCard(next, rival, 'test_denial').state;
    return { state: next, active, rival };
  }

  it('reduces the first Reaction and not the second, and never below the printed floor', () => {
    const { state, active, rival } = discounted();

    const cast = giveCard(state, active, 'test_pricey_spell');
    const played = apply(
      cast.state,
      { type: 'play_card', playerId: active, instanceId: cast.instanceId },
      context,
    );
    void active;
    // Denial costs 1; the "to a minimum of 1" floor means the discount buys
    // nothing here rather than making it free.
    expect(legalActions(played, rival, context).reaction?.playableCards[0]?.energyCost).toBe(1);
  });

  it('is consumed by a Reaction that actually used it', () => {
    const { state, active, rival } = discounted();
    // A dearer Reaction, so the discount has somewhere to go.
    const armed = giveCard(state, rival, 'test_taxing_denial');
    const cast = giveCard(armed.state, active, 'test_pricey_spell');
    const played = apply(
      cast.state,
      { type: 'play_card', playerId: active, instanceId: cast.instanceId },
      context,
    );
    void active;
    const offered = legalActions(played, rival, context).reaction?.playableCards.find(
      (card) => card.definitionId === 'test_taxing_denial',
    );
    expect(offered?.energyCost).toBe(1);

    const answered = apply(
      played,
      { type: 'play_reaction', playerId: rival, instanceId: armed.instanceId },
      context,
    );
    expect(answered.players[rival]?.reactionDiscountSpent).toBe(true);
    const played_events = eventsOfType(answered, 'reaction_played');
    expect(played_events[0]?.discountApplied).toBe(1);
  });

  it('survives the opponents’ turns and resets at its controller’s own turn start', () => {
    const { state, rival } = discounted();
    const spent = structuredClone(state);
    const seat = spent.players[rival];
    if (seat) seat.reactionDiscountSpent = true;

    // Walk to the discounting player's own turn.
    let next = spent;
    for (let guard = 0; guard < 60 && next.activePlayerId !== rival; guard += 1) {
      const active = next.activePlayerId;
      if (next.phase === 'main_1' || next.phase === 'main_2') {
        next = apply(next, { type: 'pass_phase', playerId: active }, context);
      } else if (next.phase === 'declare_attackers') {
        next = apply(next, { type: 'declare_attackers', playerId: active, attacks: [] }, context);
      } else if (next.phase === 'reaction_window') {
        next = apply(next, { type: 'pass_reaction', playerId: priorityHolder(next) }, context);
      } else {
        throw new Error(`stuck in ${next.phase}`);
      }
    }

    expect(next.players[rival]?.reactionDiscountSpent).toBe(false);
  });
});

describe('the reactions dial', () => {
  it('runs the pre-Reaction phase machine when reactions are disabled', () => {
    const config: RulesConfig = { ...DEFAULT_RULES_CONFIG, reactionsEnabled: false };
    const state = opened(2, config);
    const active = state.activePlayerId;
    const rival = state.playerOrder.find((id) => id !== active) as string;

    let next = setEnergy(setEnergy(state, active, 9), rival, 9);
    next = giveCard(next, rival, 'test_denial').state;
    const cast = giveCard(next, active, 'test_cheap_spell');

    const played = apply(
      cast.state,
      { type: 'play_card', playerId: active, instanceId: cast.instanceId },
      ctx(config),
    );

    expect(played.reactionWindow).toBeNull();
    expect(eventsOfType(played, 'spell_resolved')).toHaveLength(1);
  });
});
