import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES_CONFIG } from './config.js';
import { commanderDeployCost } from './derive.js';
import { legalActions } from './legal-actions.js';
import {
  apply,
  databaseWith,
  deployUnit,
  eventsOfType,
  expectRejected,
  instanceIn,
  keepBothHands,
  makeDeck,
  setEnergy,
  startMatch,
  testContext,
  type StartOptions,
} from './test-fixtures.js';
import type { CardDefinitionInput } from '@tcg/card-data';
import type { MatchState, PlayerState } from './schema/state.js';

/**
 * Deployable Commanders, and what happens when one dies (rule adjustment §2/§3).
 *
 * The two halves are one mechanic: a Commander is worth deploying because
 * defeat is not permanent, and defeat is survivable because the only lasting
 * cost is that the next deployment is dearer. Testing either alone would miss
 * the loop.
 */

/** A cheap deployable Commander with a battlefield-only activated ability. */
const DEPLOYABLE_COMMANDER: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_field_marshal',
  name: 'Test Field Marshal',
  type: 'commander',
  colorIdentity: ['white'],
  cost: 2,
  attack: 2,
  health: 3,
  unique: true,
  displayText: 'While on the battlefield: Exhaust — draw a card.',
  activatedAbilities: [
    {
      id: 'rally',
      name: 'Rally',
      activeZone: 'battlefield',
      costs: [{ type: 'exhaust_source' }],
      usageLimit: 'once_per_turn',
      effects: [{ type: 'draw', player: 'self', amount: 1 }],
    },
  ],
};

/** The older model: no printed cost, and an ability that works from its zone. */
const ZONE_ONLY_COMMANDER: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_zone_sage',
  name: 'Test Zone Sage',
  type: 'commander',
  colorIdentity: ['blue'],
  cost: null,
  attack: 1,
  health: 1,
  unique: true,
  displayText: 'From the Command Zone: pay 1 — draw a card.',
  activatedAbilities: [
    {
      id: 'foresee',
      name: 'Foresee',
      activeZone: 'commander_zone',
      costs: [{ type: 'energy', amount: 1 }],
      usageLimit: 'once_per_turn',
      effects: [{ type: 'draw', player: 'self', amount: 1 }],
    },
  ],
};

const database = databaseWith([DEPLOYABLE_COMMANDER, ZONE_ONLY_COMMANDER]);
const context = testContext();
const withDatabase = { database, config: DEFAULT_RULES_CONFIG };

function opened(options: StartOptions = {}): MatchState {
  const start = startMatch({
    database,
    decks: [
      makeDeck('test_field_marshal', ['prototype_drone']),
      makeDeck('test_zone_sage', ['prototype_drone']),
    ],
    ...options,
  });
  return keepBothHands(start, withDatabase);
}

/**
 * Plays out turns, doing nothing, until `playerId` is in their own first Main
 * Phase.
 *
 * Written as a phase-driven loop rather than a fixed sequence of passes because
 * the sequence is no longer fixed: a Reaction window can open mid-turn, and a
 * hard-coded "pass, attack, pass" walks straight into it.
 */
function toOwnMain(state: MatchState, playerId: string): MatchState {
  let next = state;
  for (let guard = 0; guard < 200; guard += 1) {
    if (next.activePlayerId === playerId && next.phase === 'main_1') return next;
    const active = next.activePlayerId;
    switch (next.phase) {
      case 'main_1':
      case 'main_2':
        next = apply(next, { type: 'pass_phase', playerId: active }, withDatabase);
        break;
      case 'declare_attackers':
        next = apply(
          next,
          { type: 'declare_attackers', playerId: active, attacks: [] },
          withDatabase,
        );
        break;
      case 'assign_blockers': {
        const defender = next.combat.awaitingDefenders[0];
        if (defender === undefined) throw new Error('blocking phase with no defender');
        next = apply(
          next,
          { type: 'assign_blockers', playerId: defender, blocks: [] },
          withDatabase,
        );
        break;
      }
      case 'reaction_window': {
        const holder = next.reactionWindow?.priorityOrder[next.reactionWindow.priorityIndex];
        if (holder === undefined) throw new Error('open window with no priority holder');
        next = apply(next, { type: 'pass_reaction', playerId: holder }, withDatabase);
        break;
      }
      default:
        throw new Error(`stuck in phase ${next.phase}`);
    }
  }
  throw new Error(`never reached ${playerId}'s main phase`);
}

/** The seat whose Commander is the deployable one, funded and in a Main Phase. */
function readyToDeploy(energy = 6): { state: MatchState; playerId: string; commanderId: string } {
  const playerId = 'player_1';
  const state = setEnergy(toOwnMain(opened(), playerId), playerId, energy);
  return { state, playerId, commanderId: state.players[playerId]?.commanderInstanceId ?? '' };
}

describe('deploying a Commander', () => {
  it('moves it from the Command Zone to the battlefield for its printed cost', () => {
    const { state, playerId, commanderId } = readyToDeploy();
    const before = state.players[playerId]?.energy ?? 0;

    const deployed = apply(
      state,
      { type: 'play_card', playerId, instanceId: commanderId },
      withDatabase,
    );

    expect(instanceIn(deployed, commanderId).zone).toBe('battlefield');
    expect(deployed.players[playerId]?.units).toContain(commanderId);
    expect(deployed.players[playerId]?.energy).toBe(before - 2);
    expect(eventsOfType(deployed, 'commander_deployed')).toHaveLength(1);
  });

  it('marks it Newly Deployed, so it cannot attack or pay an Exhaust cost yet', () => {
    const { state, playerId, commanderId } = readyToDeploy();
    const deployed = apply(
      state,
      { type: 'play_card', playerId, instanceId: commanderId },
      withDatabase,
    );

    expect(instanceIn(deployed, commanderId).newlyDeployed).toBe(true);

    const activation = expectRejected(
      deployed,
      { type: 'activate_ability', playerId, sourceInstanceId: commanderId, abilityId: 'rally' },
      withDatabase,
    );
    expect(activation.code).toBe('engine/cost_unpayable');

    const attacking = apply(deployed, { type: 'pass_phase', playerId }, withDatabase);
    const attack = expectRejected(
      attacking,
      {
        type: 'declare_attackers',
        playerId,
        attacks: [{ attackerInstanceId: commanderId, defenderPlayerId: 'player_2' }],
      },
      withDatabase,
    );
    expect(attack.code).toBe('engine/illegal_attacker');
  });

  it('is offered as a playable card while it is affordable and in its zone', () => {
    const { state, playerId, commanderId } = readyToDeploy();
    const legal = legalActions(state, playerId, withDatabase);
    expect(legal.playableCards.map((card) => card.instanceId)).toContain(commanderId);
    expect(legal.playableCards.find((card) => card.instanceId === commanderId)?.energyCost).toBe(2);

    const deployed = apply(
      state,
      { type: 'play_card', playerId, instanceId: commanderId },
      withDatabase,
    );
    expect(
      legalActions(deployed, playerId, withDatabase).playableCards.map((card) => card.instanceId),
    ).not.toContain(commanderId);
  });

  it('refuses a Commander with no printed cost', () => {
    const state = setEnergy(toOwnMain(opened(), 'player_2'), 'player_2', 8);

    const error = expectRejected(
      state,
      {
        type: 'play_card',
        playerId: 'player_2',
        instanceId: state.players['player_2']?.commanderInstanceId ?? '',
      },
      withDatabase,
    );
    expect(error.code).toBe('engine/commander_not_deployable');
  });
});

describe('Commander defeat', () => {
  /** Deploys the Commander and kills it with a direct damage spell. */
  function deployAndDefeat(): { state: MatchState; playerId: string; commanderId: string } {
    const { state, playerId, commanderId } = readyToDeploy();
    let next = apply(state, { type: 'play_card', playerId, instanceId: commanderId }, withDatabase);
    // Mark lethal damage directly: how it died is not what this is testing.
    const doomed = structuredClone(next);
    const instance = doomed.instances[commanderId];
    if (instance) instance.markedDamage = 99;
    // Any legal action runs the state-based check that notices it.
    next = apply(doomed, { type: 'pass_phase', playerId }, withDatabase);
    return { state: next, playerId, commanderId };
  }

  it('returns it to the Command Zone immediately, not to the discard pile', () => {
    const { state, playerId, commanderId } = deployAndDefeat();

    expect(instanceIn(state, commanderId).zone).toBe('commander_zone');
    expect(state.players[playerId]?.discard).not.toContain(commanderId);
    expect(state.players[playerId]?.units).not.toContain(commanderId);
    expect(eventsOfType(state, 'commander_returned')).toHaveLength(1);
  });

  it('raises the deployment cost by exactly one per defeat, and caps the total', () => {
    const seated = startMatch({ database }).players['player_1'];
    if (!seated) throw new Error('player_1 was not seated');
    // A real PlayerState, minus any cost modifiers: this is testing the
    // defeat surcharge, and a stray reduction would silently absorb it.
    const player: PlayerState = { ...seated, costModifiers: [] };
    const definition = database.getOrThrow('test_field_marshal');

    const costAt = (defeats: number): number | null =>
      commanderDeployCost(
        { ...player, commanderDefeats: defeats },
        definition,
        DEFAULT_RULES_CONFIG,
      );

    expect(costAt(0)).toBe(2);
    expect(costAt(1)).toBe(3);
    expect(costAt(5)).toBe(7);
    // The cap is on the total, not on the surcharge: 2 + 40 clamps to 10, not
    // to 2 + 10.
    expect(costAt(40)).toBe(DEFAULT_RULES_CONFIG.commanderCostCap);
  });

  it('keeps counting across repeated deploy/defeat cycles', () => {
    const { state, playerId, commanderId } = deployAndDefeat();
    expect(state.players[playerId]?.commanderDefeats).toBe(1);

    // Round two: come back, die again.
    let next = setEnergy(toOwnMain(state, playerId), playerId, 9);
    next = apply(next, { type: 'play_card', playerId, instanceId: commanderId }, withDatabase);
    // The second deployment really did cost the surcharge.
    const played = eventsOfType(next, 'commander_deployed');
    expect(played[played.length - 1]?.energySpent).toBe(3);

    const doomed = structuredClone(next);
    const instance = doomed.instances[commanderId];
    if (instance) instance.markedDamage = 99;
    next = apply(doomed, { type: 'pass_phase', playerId }, withDatabase);

    expect(next.players[playerId]?.commanderDefeats).toBe(2);
    expect(instanceIn(next, commanderId).zone).toBe('commander_zone');
  });

  it('does not damage its controller', () => {
    const { state, playerId } = deployAndDefeat();
    expect(state.players[playerId]?.health).toBe(DEFAULT_RULES_CONFIG.startingHealth);
    expect(state.status).not.toBe('complete');
  });
});

describe('Commander ability zones', () => {
  it('refuses a battlefield ability activated from the Command Zone', () => {
    const { state, playerId, commanderId } = readyToDeploy();
    const error = expectRejected(
      state,
      { type: 'activate_ability', playerId, sourceInstanceId: commanderId, abilityId: 'rally' },
      withDatabase,
    );
    expect(error.code).toBe('engine/wrong_zone');
    expect(
      legalActions(state, playerId, withDatabase).activatableAbilities.map((a) => a.abilityId),
    ).not.toContain('rally');
  });

  it('allows it once the Commander is on the battlefield and no longer Newly Deployed', () => {
    const { state, playerId, commanderId } = readyToDeploy();
    let next = apply(state, { type: 'play_card', playerId, instanceId: commanderId }, withDatabase);
    // Take the turn round to this player's own Ready Step, which clears
    // Newly Deployed.
    next = toOwnMain(apply(next, { type: 'pass_phase', playerId }, withDatabase), playerId);

    expect(instanceIn(next, commanderId).newlyDeployed).toBe(false);
    const used = apply(
      next,
      { type: 'activate_ability', playerId, sourceInstanceId: commanderId, abilityId: 'rally' },
      withDatabase,
    );
    expect(instanceIn(used, commanderId).exhausted).toBe(true);
  });

  it('keeps a zone-only Commander’s ability usable from its zone', () => {
    const state = setEnergy(toOwnMain(opened(), 'player_2'), 'player_2', 4);
    const commanderId = state.players['player_2']?.commanderInstanceId ?? '';
    const handBefore = state.players['player_2']?.hand.length ?? 0;

    const used = apply(
      state,
      {
        type: 'activate_ability',
        playerId: 'player_2',
        sourceInstanceId: commanderId,
        abilityId: 'foresee',
      },
      withDatabase,
    );
    expect(used.players['player_2']?.hand.length).toBe(handBefore + 1);
    expect(instanceIn(used, commanderId).zone).toBe('commander_zone');
  });
});

/**
 * The half of Newly Deployed that was missing: it blocks an `Exhaust this
 * source` cost, not only an attack (rule adjustment §4). Rush was already
 * documented as covering both and only ever checked one of them.
 */
const TAPPER: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_tapper',
  name: 'Test Tapper',
  type: 'unit',
  colorIdentity: ['blue'],
  cost: 1,
  attack: 1,
  health: 1,
  displayText: 'Exhaust — draw a card.',
  activatedAbilities: [
    {
      id: 'tap_for_value',
      name: 'Tap For Value',
      costs: [{ type: 'exhaust_source' }],
      usageLimit: 'unlimited',
      effects: [{ type: 'draw', player: 'self', amount: 1 }],
    },
  ],
};

const RUSHING_TAPPER: CardDefinitionInput = {
  ...TAPPER,
  id: 'test_rushing_tapper',
  name: 'Test Rushing Tapper',
  keywords: ['rush'],
  displayText: 'Rush. Exhaust — draw a card.',
};

describe('Newly Deployed and Exhaust costs', () => {
  const tapperDatabase = databaseWith([TAPPER, RUSHING_TAPPER]);
  const tapperContext = { database: tapperDatabase, config: DEFAULT_RULES_CONFIG };

  function withTapper(definitionId: string): {
    state: MatchState;
    playerId: string;
    unitId: string;
  } {
    const start = keepBothHands(startMatch({ database: tapperDatabase }), tapperContext);
    const playerId = start.activePlayerId;
    const placed = deployUnit(setEnergy(start, playerId, 6), playerId, definitionId, {
      summoningSick: true,
    });
    return { state: placed.state, playerId, unitId: placed.instanceId };
  }

  it('refuses an Exhaust cost from a Newly Deployed unit', () => {
    const { state, playerId, unitId } = withTapper('test_tapper');

    const error = expectRejected(
      state,
      { type: 'activate_ability', playerId, sourceInstanceId: unitId, abilityId: 'tap_for_value' },
      tapperContext,
    );
    expect(error.code).toBe('engine/cost_unpayable');
    // …and it is not offered either, so a client never shows a move the engine
    // would reject.
    expect(
      legalActions(state, playerId, tapperContext).activatableAbilities.map(
        (a) => a.sourceInstanceId,
      ),
    ).not.toContain(unitId);
  });

  it('allows it when the unit has Rush', () => {
    const { state, playerId, unitId } = withTapper('test_rushing_tapper');

    expect(
      legalActions(state, playerId, tapperContext).activatableAbilities.map(
        (a) => a.sourceInstanceId,
      ),
    ).toContain(unitId);

    const used = apply(
      state,
      { type: 'activate_ability', playerId, sourceInstanceId: unitId, abilityId: 'tap_for_value' },
      tapperContext,
    );
    expect(instanceIn(used, unitId).exhausted).toBe(true);
  });

  it('still lets a Newly Deployed unit block', () => {
    // ADR 0016 Q-C: the restriction is on attacking and on Exhaust costs, never
    // on defending.
    const start = keepBothHands(startMatch());
    const attacker = deployUnit(start, start.activePlayerId, 'prototype_drone');
    const defenderId = start.playerOrder.find((id) => id !== start.activePlayerId) as string;
    const blocker = deployUnit(attacker.state, defenderId, 'prototype_guard', {
      summoningSick: true,
    });

    const attacking = apply(
      apply(blocker.state, { type: 'pass_phase', playerId: start.activePlayerId }, context),
      {
        type: 'declare_attackers',
        playerId: start.activePlayerId,
        attacks: [{ attackerInstanceId: attacker.instanceId, defenderPlayerId: defenderId }],
      },
      context,
    );

    expect(legalActions(attacking, defenderId, context).blocking?.blockerInstanceIds).toContain(
      blocker.instanceId,
    );

    const blocked = apply(
      attacking,
      {
        type: 'assign_blockers',
        playerId: defenderId,
        blocks: [
          { attackerInstanceId: attacker.instanceId, blockerInstanceId: blocker.instanceId },
        ],
      },
      context,
    );
    expect(blocked.combat.blocks).toHaveLength(1);
  });
});
