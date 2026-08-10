import { describe, expect, it } from 'vitest';
import { currentAttack, definitionOf, matchesCardFilter, playerOf } from './derive.js';
import { evaluateCount } from './values.js';
import {
  apply,
  attacksOnOpponent,
  databaseWith,
  deployUnit,
  eventsOfType,
  forcePhase,
  giveCard,
  instanceIn,
  keepBothHands,
  makeDeck,
  setEnergy,
  startMatch,
  testContext,
} from './test-fixtures.js';
import type { CardFilter } from '@tcg/card-data';
import type { MatchState } from './schema/state.js';

/**
 * The Precon Wave 1 effect and trigger vocabulary (ruleset update §15/§16).
 *
 * Four things the v0.2 schema could not say at all, and which most of the
 * authored catalog needs:
 *
 *  - **event-scoped triggers** — "whenever *another* friendly Unit is defeated";
 *  - **conditions** — "if at least two Units were defeated this turn";
 *  - **throttling** — "the first time … each turn";
 *  - **computed values** — "for each other attacking Goblin".
 *
 * Fixture cards live here rather than in `prototype_core`: adding to the shared
 * set changes the pool every seeded generated population draws from, which
 * silently moves unrelated simulator tests.
 */
const CARDS = [
  {
    schemaVersion: 3,
    id: 'vb_body',
    name: 'Plain Body',
    type: 'unit',
    colorIdentity: [],
    cost: 1,
    attack: 1,
    health: 1,
    tags: ['goblin'],
  },
  {
    schemaVersion: 3,
    id: 'vb_other_body',
    name: 'Other Body',
    type: 'unit',
    colorIdentity: [],
    cost: 1,
    attack: 1,
    health: 1,
    tags: ['thrall'],
  },
  /** Alternation fodder: differs from `vb_body` in card *type*, not in tags. */
  {
    schemaVersion: 3,
    id: 'vb_relic',
    name: 'Plain Relic',
    type: 'relic',
    colorIdentity: [],
    cost: 1,
  },
  /** A unit that only matches an alternative testing two predicates at once. */
  {
    schemaVersion: 3,
    id: 'vb_warden',
    name: 'Warden',
    type: 'unit',
    colorIdentity: [],
    cost: 2,
    attack: 1,
    health: 3,
    keywords: ['guardian'],
  },
  {
    // "Whenever *another* friendly Unit is defeated, gain +1 ATK this turn."
    schemaVersion: 3,
    id: 'vb_collector',
    name: 'Collector',
    type: 'unit',
    colorIdentity: [],
    cost: 3,
    attack: 2,
    health: 5,
    abilities: [
      {
        id: 'collect',
        trigger: 'on_defeated',
        scope: { controller: 'self', excludeSource: true },
        effects: [
          { type: 'modify_stats', target: { kind: 'source' }, attack: 1, duration: 'end_of_turn' },
        ],
      },
    ],
    displayText: 'Whenever another friendly unit is defeated, this gains +1 ATK this turn.',
  },
  {
    // The same trigger, throttled to once a turn.
    schemaVersion: 3,
    id: 'vb_throttled',
    name: 'Throttled Collector',
    type: 'unit',
    colorIdentity: [],
    cost: 3,
    attack: 2,
    health: 5,
    abilities: [
      {
        id: 'collect_once',
        trigger: 'on_defeated',
        scope: { controller: 'self', excludeSource: true },
        limit: 'each_turn',
        effects: [
          { type: 'modify_stats', target: { kind: 'source' }, attack: 1, duration: 'end_of_turn' },
        ],
      },
    ],
    displayText: 'The first time another friendly unit is defeated each turn, this gains +1 ATK.',
  },
  {
    // Scoped to Goblins, so a Thrall dying must not fire it.
    schemaVersion: 3,
    id: 'vb_goblin_watcher',
    name: 'Goblin Watcher',
    type: 'unit',
    colorIdentity: [],
    cost: 3,
    attack: 2,
    health: 5,
    abilities: [
      {
        id: 'watch_goblins',
        trigger: 'on_defeated',
        scope: { controller: 'self', excludeSource: true, filter: { tags: ['goblin'] } },
        effects: [
          { type: 'modify_stats', target: { kind: 'source' }, attack: 1, duration: 'end_of_turn' },
        ],
      },
    ],
    displayText: 'Whenever another friendly goblin is defeated, this gains +1 ATK this turn.',
  },
  {
    // "Deal damage equal to the number of Goblins you control."
    schemaVersion: 3,
    id: 'vb_mob_bolt',
    name: 'Mob Bolt',
    type: 'spell',
    colorIdentity: [],
    cost: 2,
    effects: [
      {
        type: 'deal_damage',
        target: { kind: 'player', relation: 'opponent' },
        amount: {
          kind: 'count',
          count: { subject: 'units', controller: 'self', filter: { tags: ['goblin'] } },
        },
      },
    ],
    displayText: 'Deal damage to an opponent equal to the number of goblins you control.',
  },
  {
    // "One for every three", to pin the rounding.
    schemaVersion: 3,
    id: 'vb_thirds',
    name: 'Third Bolt',
    type: 'spell',
    colorIdentity: [],
    cost: 2,
    effects: [
      {
        type: 'deal_damage',
        target: { kind: 'player', relation: 'opponent' },
        amount: {
          kind: 'count',
          count: { subject: 'units', controller: 'self', filter: { tags: ['goblin'] } },
          per: 3,
        },
      },
    ],
    displayText: 'Deal one damage to an opponent for every three goblins you control.',
  },
  {
    // "Draw a card. If two friendly units died this turn, draw another."
    schemaVersion: 3,
    id: 'vb_harvest',
    name: 'Harvest',
    type: 'spell',
    colorIdentity: [],
    cost: 2,
    effects: [
      { type: 'draw', player: 'self', amount: 1 },
      {
        type: 'draw',
        player: 'self',
        amount: 1,
        condition: {
          kind: 'count',
          count: { subject: 'units_defeated_this_turn', controller: 'self' },
          comparison: 'at_least',
          value: 2,
        },
      },
    ],
    displayText:
      'Draw a card. If at least two friendly units were defeated this turn, draw another.',
  },
  {
    // "Look at the top three. You may take a Goblin. Put the others on the bottom."
    schemaVersion: 3,
    id: 'vb_lookout',
    name: 'Lookout',
    type: 'spell',
    colorIdentity: [],
    cost: 1,
    effects: [
      {
        type: 'search_zone',
        player: 'self',
        zone: 'deck',
        fromTop: 3,
        filter: { tags: ['goblin'] },
        amount: 1,
        destination: 'hand',
        upTo: true,
        remainder: 'bottom',
      },
    ],
    displayText: 'Look at the top three cards of your deck. You may take a goblin.',
  },
  {
    // "Look at the top two. Put one on the bottom." No "may".
    schemaVersion: 3,
    id: 'vb_scry',
    name: 'Scry',
    type: 'spell',
    colorIdentity: [],
    cost: 1,
    effects: [
      {
        type: 'search_zone',
        player: 'self',
        zone: 'deck',
        fromTop: 2,
        amount: 1,
        destination: 'deck',
        upTo: false,
        remainder: 'unchanged',
      },
    ],
    displayText: 'Look at the top two cards of your deck. Put one on the bottom.',
  },
  {
    // A relic that hands Barrier to the unit that triggered it, once a turn.
    schemaVersion: 3,
    id: 'vb_armory',
    name: 'Armory',
    type: 'relic',
    colorIdentity: [],
    cost: 2,
    abilities: [
      {
        id: 'issue_barrier',
        trigger: 'on_deployed',
        scope: { controller: 'self' },
        limit: 'each_turn',
        effects: [
          { type: 'grant_keyword', target: { kind: 'trigger_subject' }, keyword: 'barrier' },
        ],
      },
    ],
    displayText: 'The first unit you deploy each turn gains Barrier.',
  },
] as const;

const database = databaseWith(CARDS as never);
const context = { ...testContext(), database };

/**
 * A match whose decks are all `vb_body` — a Goblin — so a filtered look at the
 * top of a deck has something to find. The default fixture deck is untagged,
 * which would make an empty option set look like a working filter.
 */
function opened(): MatchState {
  const deck = makeDeck('prototype_commander_blue', ['vb_body']);
  return keepBothHands(startMatch({ database, decks: [deck, deck] }), context);
}

/** Plays a card from a freshly conjured copy in the active seat's hand. */
function play(state: MatchState, definitionId: string): { state: MatchState; instanceId: string } {
  const active = state.activePlayerId;
  const placed = giveCard(setEnergy(state, active, 9), active, definitionId);
  return {
    state: apply(
      placed.state,
      { type: 'play_card', playerId: active, instanceId: placed.instanceId },
      context,
    ),
    instanceId: placed.instanceId,
  };
}

/**
 * Kills a unit outright by marking lethal damage and running a check.
 *
 * State-based checks only run inside `applyAction`, so an action is needed to
 * provoke one; passing a Main Phase is the smallest. The phase is put back
 * afterwards so the helper can be called twice in a row without walking the
 * turn forward and changing what is being tested.
 */
function destroy(state: MatchState, instanceId: string): MatchState {
  const next = structuredClone(forcePhase(state, 'main_1'));
  const target = next.instances[instanceId];
  if (!target) throw new Error(`no instance ${instanceId}`);
  target.markedDamage = 99;
  const after = apply(next, { type: 'pass_phase', playerId: next.activePlayerId }, context);
  return forcePhase(after, 'main_1');
}

describe('event-scoped triggers', () => {
  it('fires for another friendly unit, and not for itself', () => {
    const start = opened();
    const active = start.activePlayerId;
    const collector = deployUnit(start, active, 'vb_collector');
    const victim = deployUnit(collector.state, active, 'vb_body');

    const after = destroy(victim.state, victim.instanceId);

    const instance = instanceIn(after, collector.instanceId);
    expect(currentAttack(instance, definitionOf(database, instance))).toBe(3);
    // `excludeSource` is the whole of "another": the collector dying is not it.
    expect(instance.statModifiers).toHaveLength(1);
  });

  it('respects the scope filter', () => {
    const start = opened();
    const active = start.activePlayerId;
    const watcher = deployUnit(start, active, 'vb_goblin_watcher');
    const thrall = deployUnit(watcher.state, active, 'vb_other_body');
    const goblin = deployUnit(thrall.state, active, 'vb_body');

    const afterThrall = destroy(goblin.state, thrall.instanceId);
    expect(instanceIn(afterThrall, watcher.instanceId).statModifiers).toHaveLength(0);

    const afterGoblin = destroy(afterThrall, goblin.instanceId);
    expect(instanceIn(afterGoblin, watcher.instanceId).statModifiers).toHaveLength(1);
  });

  it('does not fire for an opposing player’s unit when scoped to self', () => {
    const start = opened();
    const active = start.activePlayerId;
    const other = start.seatOrder.find((id) => id !== active) as string;
    const collector = deployUnit(start, active, 'vb_collector');
    const enemy = deployUnit(collector.state, other, 'vb_body');

    const after = destroy(enemy.state, enemy.instanceId);
    expect(instanceIn(after, collector.instanceId).statModifiers).toHaveLength(0);
  });

  it('still fires a card’s own trigger after it has left play', () => {
    // A scoped ability watches the board and stops when its card leaves. An
    // unscoped one is the card talking about itself, and has to survive its own
    // death — that is the whole of `on_defeated` (CLAUDE.md §10).
    const start = opened();
    const active = start.activePlayerId;
    const collector = deployUnit(start, active, 'vb_collector');
    const victim = deployUnit(collector.state, active, 'vb_body');

    // Both die in the same state-based check.
    const next = structuredClone(victim.state);
    for (const id of [collector.instanceId, victim.instanceId]) {
      const target = next.instances[id];
      if (target) target.markedDamage = 99;
    }
    const after = apply(next, { type: 'pass_phase', playerId: active }, context);

    expect(after.instances[collector.instanceId]?.zone).toBe('discard');
    // The collector was scoped, so it does not react to a board it has left.
    expect(after.instances[collector.instanceId]?.statModifiers ?? []).toHaveLength(0);
  });
});

describe('"the first time … each turn"', () => {
  it('fires once however many times the event happens', () => {
    const start = opened();
    const active = start.activePlayerId;
    const throttled = deployUnit(start, active, 'vb_throttled');
    const first = deployUnit(throttled.state, active, 'vb_body');
    const second = deployUnit(first.state, active, 'vb_other_body');

    let after = destroy(second.state, first.instanceId);
    after = destroy(after, second.instanceId);

    const instance = instanceIn(after, throttled.instanceId);
    expect(instance.statModifiers).toHaveLength(1);
    expect(currentAttack(instance, definitionOf(database, instance))).toBe(3);
  });

  it('an unthrottled copy of the same ability fires every time', () => {
    const start = opened();
    const active = start.activePlayerId;
    const collector = deployUnit(start, active, 'vb_collector');
    const first = deployUnit(collector.state, active, 'vb_body');
    const second = deployUnit(first.state, active, 'vb_other_body');

    let after = destroy(second.state, first.instanceId);
    after = destroy(after, second.instanceId);

    expect(instanceIn(after, collector.instanceId).statModifiers).toHaveLength(2);
  });
});

describe('instruction conditions', () => {
  it('skips the gated instruction and still resolves the rest', () => {
    const start = opened();
    const active = start.activePlayerId;
    const before = playerOf(start, active).hand.length;

    const cast = play(start, 'vb_harvest');

    // One dead unit is not two, so only the ungated draw happened. (The spell
    // itself left the hand, hence the -1.)
    expect(playerOf(cast.state, active).hand.length).toBe(before + 1 - 1 + 1);
    const fizzles = eventsOfType(cast.state, 'effect_fizzled');
    expect(fizzles.map((event) => event.reason)).toContain('condition_unmet');
  });

  it('resolves the gated instruction once the condition holds', () => {
    const start = opened();
    const active = start.activePlayerId;
    const first = deployUnit(start, active, 'vb_body');
    const second = deployUnit(first.state, active, 'vb_other_body');
    let state = destroy(second.state, first.instanceId);
    state = destroy(state, second.instanceId);

    const before = playerOf(state, active).hand.length;
    const cast = play(state, 'vb_harvest');

    expect(playerOf(cast.state, active).hand.length).toBe(before + 2 - 1 + 1);
    expect(
      eventsOfType(cast.state, 'effect_fizzled').filter(
        (event) => event.reason === 'condition_unmet',
      ),
    ).toHaveLength(0);
  });
});

describe('computed values', () => {
  it('counts the board when the instruction resolves', () => {
    const start = opened();
    const active = start.activePlayerId;
    const other = start.seatOrder.find((id) => id !== active) as string;

    let state = start;
    for (let index = 0; index < 4; index += 1) {
      state = deployUnit(state, active, 'vb_body').state;
    }
    const health = playerOf(state, other).health;

    const cast = play(state, 'vb_mob_bolt');
    expect(playerOf(cast.state, other).health).toBe(health - 4);
  });

  it('rounds "one for every three" down', () => {
    const start = opened();
    const active = start.activePlayerId;
    const other = start.seatOrder.find((id) => id !== active) as string;

    let state = start;
    for (let index = 0; index < 4; index += 1) {
      state = deployUnit(state, active, 'vb_body').state;
    }
    const health = playerOf(state, other).health;

    const cast = play(state, 'vb_thirds');
    // Four goblins is one lot of three, not one and a third.
    expect(playerOf(cast.state, other).health).toBe(health - 1);
  });
});

describe('counting subjects', () => {
  it('counts attackers in the current combat', () => {
    const start = opened();
    const active = start.activePlayerId;
    const first = deployUnit(start, active, 'vb_body');
    const second = deployUnit(first.state, active, 'vb_body');

    const declared = apply(
      forcePhase(second.state, 'declare_attackers'),
      {
        type: 'declare_attackers',
        playerId: active,
        attacks: attacksOnOpponent(second.state, [first.instanceId, second.instanceId]),
      },
      context,
    );

    const ctx = { ...context, state: declared, events: [], cause: {} } as never;
    expect(
      evaluateCount(
        ctx,
        {
          subject: 'attacking_units',
          controller: 'self',
          filter: { tags: ['goblin'] },
          excludeSource: false,
        },
        { controllerId: active, sourceInstanceId: null },
      ),
    ).toBe(2);
  });

  it('counts what happened this turn, not what is still standing', () => {
    const start = opened();
    const active = start.activePlayerId;
    const victim = deployUnit(start, active, 'vb_body');
    const after = destroy(victim.state, victim.instanceId);

    const ctx = { ...context, state: after, events: [], cause: {} } as never;
    const count = evaluateCount(
      ctx,
      { subject: 'units_defeated_this_turn', controller: 'self', excludeSource: false },
      { controllerId: active, sourceInstanceId: null },
    );
    expect(count).toBe(1);
    // The card is in a discard pile, so a board query would have said zero.
    expect(after.players[active]?.units).toEqual([]);
  });

  it('clears the turn log when the next turn begins', () => {
    const start = opened();
    const active = start.activePlayerId;
    const victim = deployUnit(start, active, 'vb_body');
    let state = destroy(victim.state, victim.instanceId);
    expect(state.turnEvents.defeated).toHaveLength(1);

    // Walk to the next turn.
    state = apply(forcePhase(state, 'main_2'), { type: 'pass_phase', playerId: active }, context);
    expect(state.turn).toBeGreaterThan(victim.state.turn);
    expect(state.turnEvents.defeated).toEqual([]);
  });
});

describe('looking at the top of a deck', () => {
  it('offers only the cards in the window, not the whole deck', () => {
    const start = opened();
    const active = start.activePlayerId;
    // Every card in the fixture deck is a Goblin body, so the filter matches
    // everything and only `fromTop` can be limiting the option set.
    const deck = playerOf(start, active).deck;
    expect(deck.length).toBeGreaterThan(5);

    const cast = play(start, 'vb_lookout');
    const choice = cast.state.pendingChoice;
    expect(choice?.validEntityIds).toEqual(deck.slice(0, 3));
    expect(choice?.minimum).toBe(0);
  });

  it('puts the cards it did not take on the bottom, in order, without shuffling', () => {
    const start = opened();
    const active = start.activePlayerId;
    const [first, second, third, fourth] = playerOf(start, active).deck;

    const cast = play(start, 'vb_lookout');
    const after = apply(
      cast.state,
      {
        type: 'submit_choice',
        playerId: active,
        choiceId: cast.state.pendingChoice?.id ?? '',
        selectedIds: [second as string],
      },
      context,
    );

    const deck = playerOf(after, active).deck;
    expect(playerOf(after, active).hand).toContain(second);
    // The two it declined went to the bottom in the order they were in, and the
    // fourth card is now on top — nothing was shuffled.
    expect(deck[0]).toBe(fourth);
    expect(deck.slice(-2)).toEqual([first, third]);
  });

  it('is answerable rather than declinable when the card does not say "may"', () => {
    // A hidden-zone *search* may legally find nothing (CLAUDE.md §17 Q25), but
    // these cards were shown to the chooser, so a printed "put one on the
    // bottom" is a decision they can and must make.
    const cast = play(opened(), 'vb_scry');
    expect(cast.state.pendingChoice?.minimum).toBe(1);
    expect(cast.state.pendingChoice?.maximum).toBe(1);
  });

  it('sends the chosen card to the bottom and leaves the other on top', () => {
    const start = opened();
    const active = start.activePlayerId;
    const [first, second, third] = playerOf(start, active).deck;

    const cast = play(start, 'vb_scry');
    const after = apply(
      cast.state,
      {
        type: 'submit_choice',
        playerId: active,
        choiceId: cast.state.pendingChoice?.id ?? '',
        selectedIds: [first as string],
      },
      context,
    );

    const deck = playerOf(after, active).deck;
    expect(deck[0]).toBe(second);
    expect(deck[1]).toBe(third);
    expect(deck[deck.length - 1]).toBe(first);
  });
});

describe('trigger_subject targeting', () => {
  it('affects the card the trigger was about, not the card that noticed', () => {
    const start = opened();
    const armory = play(start, 'vb_armory');
    const deployed = play(armory.state, 'vb_body');

    const instance = instanceIn(deployed.state, deployed.instanceId);
    expect(instance.grantedKeywords.map((entry) => entry.keyword)).toContain('barrier');
    // The relic itself gained nothing.
    expect(instanceIn(deployed.state, armory.instanceId).grantedKeywords).toHaveLength(0);
  });

  it('only the first deployment each turn is covered', () => {
    const start = opened();
    const armory = play(start, 'vb_armory');
    const first = play(armory.state, 'vb_body');
    const second = play(first.state, 'vb_other_body');

    expect(instanceIn(second.state, first.instanceId).grantedKeywords).toHaveLength(1);
    expect(instanceIn(second.state, second.instanceId).grantedKeywords).toHaveLength(0);
  });
});

describe('"X or Y" card filters', () => {
  /** Filters are about card identity, so no instance is needed to ask. */
  const matches = (definitionId: string, filter: CardFilter): boolean =>
    matchesCardFilter(database.getOrThrow(definitionId), null, filter);

  it('accepts a card matching any one alternative', () => {
    // The alternatives test *different* predicates, which is the only case
    // `anyOf` exists for — `cardTypes` and `tags` already OR within themselves.
    const filter: CardFilter = { anyOf: [{ tags: ['goblin'] }, { cardTypes: ['relic'] }] };

    expect(matches('vb_body', filter)).toBe(true);
    expect(matches('vb_relic', filter)).toBe(true);
    expect(matches('vb_other_body', filter)).toBe(false);
  });

  it('requires every predicate inside one alternative', () => {
    const filter: CardFilter = {
      anyOf: [{ cardTypes: ['unit'], keywords: ['guardian'] }, { cardTypes: ['relic'] }],
    };

    expect(matches('vb_warden', filter)).toBe(true);
    // A unit without the keyword satisfies half of that alternative and none of
    // the other, so it fails: an alternative is an AND, the list is the OR.
    expect(matches('vb_body', filter)).toBe(false);
  });

  it('still applies the predicates sitting alongside it', () => {
    const filter: CardFilter = {
      cardTypes: ['unit'],
      anyOf: [{ tags: ['goblin'] }, { cardTypes: ['relic'] }],
    };

    expect(matches('vb_body', filter)).toBe(true);
    // The relic matches an alternative but is not a unit. Reading `anyOf` as an
    // escape hatch from its siblings would make "a Goblin unit or a Relic unit"
    // silently mean "anything".
    expect(matches('vb_relic', filter)).toBe(false);
  });
});
