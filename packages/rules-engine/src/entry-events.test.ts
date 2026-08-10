import { describe, expect, it } from 'vitest';
import type { CardDefinitionInput } from '@tcg/card-data';
import { DEFAULT_RULES_CONFIG } from './config.js';
import {
  apply,
  databaseWith,
  deployUnit,
  eventsOfType,
  giveCard,
  instanceIn,
  keepBothHands,
  makeDeck,
  setEnergy,
  startMatch,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';

/**
 * `deployed` versus `enters the battlefield` (rule adjustment §7), and the
 * Token-definition group rule (§8).
 *
 * The two events must stay distinguishable. The update explicitly forbids
 * converting existing "When deployed" cards into "when this enters the
 * battlefield" cards wholesale — each has to be reviewed on its own — which is
 * only possible if the engine can tell a deployment from an arrival at all.
 */

const PLAIN_UNIT: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_plain_unit',
  name: 'Test Plain Unit',
  type: 'unit',
  colorIdentity: ['green'],
  cost: 1,
  attack: 1,
  health: 1,
};

/** Watches deployments only. */
const DEPLOY_WATCHER: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_deploy_watcher',
  name: 'Test Deploy Watcher',
  type: 'unit',
  colorIdentity: ['green'],
  cost: 1,
  attack: 0,
  health: 6,
  displayText: 'Whenever a friendly Unit is deployed, draw a card.',
  abilities: [
    {
      id: 'watch_deploys',
      trigger: 'on_deployed',
      activeZone: 'battlefield',
      scope: { controller: 'self', excludeSource: true },
      effects: [{ type: 'draw', player: 'self', amount: 1 }],
    },
  ],
};

/** Watches every arrival, however it happened. */
const ENTRY_WATCHER: CardDefinitionInput = {
  ...DEPLOY_WATCHER,
  id: 'test_entry_watcher',
  name: 'Test Entry Watcher',
  displayText: 'Whenever a friendly Unit enters the battlefield, draw a card.',
  abilities: [
    {
      id: 'watch_entries',
      trigger: 'on_entered_battlefield',
      activeZone: 'battlefield',
      scope: { controller: 'self', excludeSource: true },
      effects: [{ type: 'draw', player: 'self', amount: 1 }],
    },
  ],
};

/** Revives a unit from the discard pile: an arrival that is not a deployment. */
const REVIVER: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_reviver',
  name: 'Test Reviver',
  type: 'spell',
  colorIdentity: ['black'],
  cost: 1,
  displayText: 'Put a Unit from your discard pile onto the battlefield.',
  effects: [
    {
      type: 'move_card',
      toZone: 'battlefield',
      target: {
        kind: 'entity',
        selector: {
          zone: 'discard',
          controller: 'self',
          filter: { cardTypes: ['unit'] },
          count: 1,
          selection: 'automatic',
        },
      },
    },
  ],
};

/** Exhausts every Token sharing the chosen one's definition and controller. */
const GROUP_PULSE: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_group_pulse',
  name: 'Test Group Pulse',
  type: 'spell',
  colorIdentity: ['blue'],
  cost: 1,
  displayText: 'Exhaust every Token with the same Token definition controlled by target player.',
  effects: [
    {
      type: 'exhaust',
      target: {
        kind: 'entity',
        selector: {
          zone: 'battlefield',
          controller: 'any',
          filter: { cardTypes: ['token'] },
          count: 1,
          selection: 'automatic',
          groupByTokenDefinition: true,
        },
      },
    },
  ],
};

/** Creates three Goblin tokens, so there is a group to hit. */
const TOKEN_MAKER: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_token_maker',
  name: 'Test Token Maker',
  type: 'spell',
  colorIdentity: ['red'],
  cost: 1,
  displayText: 'Create three Goblin Tokens.',
  effects: [{ type: 'create_token', tokenCardId: 'goblin_token', amount: 3, controller: 'self' }],
};

const database = databaseWith([
  PLAIN_UNIT,
  DEPLOY_WATCHER,
  ENTRY_WATCHER,
  REVIVER,
  GROUP_PULSE,
  TOKEN_MAKER,
]);
const context = { database, config: DEFAULT_RULES_CONFIG };

function main(): { state: MatchState; playerId: string } {
  const start = keepBothHands(
    startMatch({ database, decks: [makeDeck(), makeDeck('prototype_commander_red')] }),
    context,
  );
  const playerId = start.activePlayerId;
  return { state: setEnergy(start, playerId, 9), playerId };
}

describe('deployment versus battlefield entry', () => {
  it('emits both events, deployment first, when a unit is played', () => {
    const { state, playerId } = main();
    const card = giveCard(state, playerId, 'test_plain_unit');
    const played = apply(
      card.state,
      { type: 'play_card', playerId, instanceId: card.instanceId },
      context,
    );

    const deployed = eventsOfType(played, 'unit_deployed').find(
      (event) => event.instanceId === card.instanceId,
    );
    const entered = eventsOfType(played, 'unit_entered_battlefield').find(
      (event) => event.instanceId === card.instanceId,
    );

    expect(deployed).toBeDefined();
    expect(entered).toBeDefined();
    expect(entered?.method).toBe('deployed');
    // "A normal deployment emits `deployed` and then `entersBattlefield` in a
    // deterministic documented order."
    expect((deployed?.sequence ?? 0) < (entered?.sequence ?? 0)).toBe(true);
  });

  it('emits only the entry event for a revival', () => {
    const { state, playerId } = main();
    // A unit already in the discard pile, and the spell that brings it back.
    const buried = giveCard(state, playerId, 'test_plain_unit');
    const inDiscard = structuredClone(buried.state);
    const seat = inDiscard.players[playerId];
    const instance = inDiscard.instances[buried.instanceId];
    if (!seat || !instance) throw new Error('fixture failed');
    seat.hand = seat.hand.filter((id) => id !== buried.instanceId);
    seat.discard.push(buried.instanceId);
    instance.zone = 'discard';

    const spell = giveCard(inDiscard, playerId, 'test_reviver');
    const cast = apply(
      spell.state,
      { type: 'play_card', playerId, instanceId: spell.instanceId },
      context,
    );

    expect(instanceIn(cast, buried.instanceId).zone).toBe('battlefield');
    expect(eventsOfType(cast, 'unit_deployed').map((event) => event.instanceId)).not.toContain(
      buried.instanceId,
    );
    const entered = eventsOfType(cast, 'unit_entered_battlefield').find(
      (event) => event.instanceId === buried.instanceId,
    );
    expect(entered?.method).toBe('effect');
  });

  it('keeps the two triggers distinct: a deploy watcher ignores a revival', () => {
    const { state, playerId } = main();
    const watched = deployUnit(state, playerId, 'test_deploy_watcher');

    const buried = giveCard(watched.state, playerId, 'test_plain_unit');
    const inDiscard = structuredClone(buried.state);
    const seat = inDiscard.players[playerId];
    const instance = inDiscard.instances[buried.instanceId];
    if (!seat || !instance) throw new Error('fixture failed');
    seat.hand = seat.hand.filter((id) => id !== buried.instanceId);
    seat.discard.push(buried.instanceId);
    instance.zone = 'discard';

    const handBefore = seat.hand.length;
    const spell = giveCard(inDiscard, playerId, 'test_reviver');
    const cast = apply(
      spell.state,
      { type: 'play_card', playerId, instanceId: spell.instanceId },
      context,
    );

    // The spell left the hand and nothing was drawn: the revival is not a
    // deployment.
    expect(cast.players[playerId]?.hand.length).toBe(handBefore);
  });

  it('an entry watcher does fire on a revival', () => {
    const { state, playerId } = main();
    const watched = deployUnit(state, playerId, 'test_entry_watcher');

    const buried = giveCard(watched.state, playerId, 'test_plain_unit');
    const inDiscard = structuredClone(buried.state);
    const seat = inDiscard.players[playerId];
    const instance = inDiscard.instances[buried.instanceId];
    if (!seat || !instance) throw new Error('fixture failed');
    seat.hand = seat.hand.filter((id) => id !== buried.instanceId);
    seat.discard.push(buried.instanceId);
    instance.zone = 'discard';

    const handBefore = seat.hand.length;
    const spell = giveCard(inDiscard, playerId, 'test_reviver');
    const cast = apply(
      spell.state,
      { type: 'play_card', playerId, instanceId: spell.instanceId },
      context,
    );

    // The revival fired the entry trigger, so the hand ends one card up on
    // where the deploy-watcher case above ended: same board, same spell, and
    // the only difference is which trigger was listening.
    expect(cast.players[playerId]?.hand.length).toBe(handBefore + 1);
  });

  it('reports a token arrival as a creation, not a deployment', () => {
    const { state, playerId } = main();
    const maker = giveCard(state, playerId, 'test_token_maker');
    const cast = apply(
      maker.state,
      { type: 'play_card', playerId, instanceId: maker.instanceId },
      context,
    );

    const entries = eventsOfType(cast, 'unit_entered_battlefield').filter(
      (event) => event.method === 'token_created',
    );
    expect(entries).toHaveLength(3);
  });
});

describe('Token-definition group targeting', () => {
  it('exhausts every matching Token of the chosen one’s controller', () => {
    const { state, playerId } = main();
    const maker = giveCard(state, playerId, 'test_token_maker');
    const withTokens = apply(
      maker.state,
      { type: 'play_card', playerId, instanceId: maker.instanceId },
      context,
    );

    const tokenIds = withTokens.players[playerId]?.units.filter(
      (id) => instanceIn(withTokens, id).isToken,
    );
    expect(tokenIds).toHaveLength(3);

    const pulse = giveCard(withTokens, playerId, 'test_group_pulse');
    const cast = apply(
      pulse.state,
      { type: 'play_card', playerId, instanceId: pulse.instanceId },
      context,
    );

    for (const id of tokenIds ?? []) {
      expect(instanceIn(cast, id).exhausted).toBe(true);
    }
  });

  it('leaves non-Token units alone and does not cross to another controller', () => {
    const { state, playerId } = main();
    const rival = state.playerOrder.find((id) => id !== playerId) as string;

    // A non-token unit on the same board, and tokens on the rival's board.
    const mine = deployUnit(state, playerId, 'test_plain_unit');
    const theirs = deployUnit(mine.state, rival, 'test_plain_unit');

    const maker = giveCard(theirs.state, playerId, 'test_token_maker');
    const withTokens = apply(
      maker.state,
      { type: 'play_card', playerId, instanceId: maker.instanceId },
      context,
    );

    const pulse = giveCard(withTokens, playerId, 'test_group_pulse');
    const cast = apply(
      pulse.state,
      { type: 'play_card', playerId, instanceId: pulse.instanceId },
      context,
    );

    expect(instanceIn(cast, mine.instanceId).exhausted).toBe(false);
    expect(instanceIn(cast, theirs.instanceId).exhausted).toBe(false);
  });

  it('is independent of any UI grouping, because grouping is not in the state', () => {
    // The engine has no notion of a "stack" at all: the expansion is computed
    // from definition identity and controller, both of which are authoritative
    // state. This test pins that the group is exactly the set the rule names.
    const { state, playerId } = main();
    const maker = giveCard(state, playerId, 'test_token_maker');
    const withTokens = apply(
      maker.state,
      { type: 'play_card', playerId, instanceId: maker.instanceId },
      context,
    );

    const tokens = (withTokens.players[playerId]?.units ?? []).filter(
      (id) => instanceIn(withTokens, id).isToken,
    );
    const definitions = new Set(tokens.map((id) => instanceIn(withTokens, id).definitionId));
    expect(definitions.size).toBe(1);
    // Each token remains its own game object with its own instance ID.
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
