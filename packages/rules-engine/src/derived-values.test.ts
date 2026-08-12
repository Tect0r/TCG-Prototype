import { describe, expect, it } from 'vitest';
import type { CardDefinitionInput } from '@tcg/card-data';
import { DEFAULT_RULES_CONFIG } from './config.js';
import { opponentOf, playerOf } from './derive.js';
import { playCostOf } from './costs.js';
import { legalActions } from './legal-actions.js';
import { playerView } from './view.js';
import { evaluateValue } from './values.js';
import {
  apply,
  attacksOnOpponent,
  databaseWith,
  deployCommander,
  deployUnit,
  eventsOfType,
  forcePhase,
  giveCard,
  instanceIn,
  keepBothHands,
  makeDeck,
  setEnergy,
  startMatch,
  testDatabase,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';

/**
 * M02.3 — values derived from a statline, and costs derived from the board.
 *
 * Both primitives share one property, and it is the property under test: nothing
 * is stored. A derived value is read at the moment the instruction resolves, and
 * a derived cost is read at the moment the cost is asked for — so both move when
 * the board moves, and neither can go stale.
 *
 * The two shipped cards carry the tranche. Two test-only cards exist alongside
 * them for the cases no authored card reaches: a targeted spell whose damage
 * scales with the target it is aimed at, and a way to defeat a board on demand.
 */

/** "Deal damage to target Unit equal to its ATK." Nothing authored says this. */
const MIRROR_BOLT: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_mirror_bolt',
  name: 'Test Mirror Bolt',
  type: 'spell',
  colorIdentity: ['red'],
  cost: 1,
  effects: [
    {
      type: 'deal_damage',
      target: { kind: 'entity', selector: { zone: 'battlefield', controller: 'any', count: 1 } },
      amount: { kind: 'stat', of: 'effect_target', stat: 'attack' },
    },
  ],
  displayText: 'Deal damage to target Unit equal to its ATK.',
};

/** Defeats the caster's own board, so "defeated this turn" can be moved at will. */
const PURGE: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_purge',
  name: 'Test Purge',
  type: 'spell',
  colorIdentity: ['black'],
  cost: 0,
  effects: [
    {
      type: 'destroy',
      target: {
        kind: 'entity',
        selector: {
          zone: 'battlefield',
          controller: 'self',
          count: 'all',
          // Nothing to decide: the spell names the whole board, so it must not
          // pause to have "all of them" confirmed.
          selection: 'automatic',
        },
      },
    },
  ],
  displayText: 'Destroy each Unit you control.',
};

const database = databaseWith([MIRROR_BOLT, PURGE]);
const context = { database, config: DEFAULT_RULES_CONFIG };

/** A stat modifier applied outside the engine, the way another card's buff would. */
function withAttackBonus(state: MatchState, instanceId: InstanceId, attack: number): MatchState {
  const next = structuredClone(state);
  const instance = next.instances[instanceId];
  if (!instance) throw new Error(`No instance ${instanceId}`);
  instance.statModifiers.push({
    attack,
    health: 0,
    duration: 'end_of_turn',
    sourceInstanceId: null,
    appliedOnTurn: next.turn,
  });
  return next;
}

/** What one instance was actually dealt, from the log rather than the board. */
function damageTo(state: MatchState, instanceId: InstanceId): number {
  return eventsOfType(state, 'damage_dealt')
    .filter((event) => event.targetInstanceId === instanceId)
    .reduce((sum, event) => sum + event.amount, 0);
}

function pendingChoice(state: MatchState) {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('Expected a pending choice');
  return choice;
}

function answer(state: MatchState, playerId: PlayerId, selectedIds: readonly InstanceId[]) {
  return apply(
    state,
    {
      type: 'submit_choice',
      playerId,
      choiceId: pendingChoice(state).id,
      selectedIds: [...selectedIds],
    },
    context,
  );
}

/* ------------------------------------------------- values read from a statline */

describe('an amount read from the target’s statline', () => {
  /** A spell in hand, and a fat unit on the opposing board to aim it at. */
  function bolt(): { state: MatchState; caster: PlayerId; boltId: InstanceId; victim: InstanceId } {
    const start = setEnergy(keepBothHands(startMatch({ database }), context), 'player_1', 9);
    const caster = start.activePlayerId;
    const victimPlayer = opponentOf(start, caster);
    const target = deployUnit(start, victimPlayer, 'goblin_chieftain');
    const spell = giveCard(target.state, caster, 'test_mirror_bolt');
    return {
      state: setEnergy(spell.state, caster, 9),
      caster,
      boltId: spell.instanceId,
      victim: target.instanceId,
    };
  }

  it('uses the chosen target’s current ATK', () => {
    const setup = bolt();
    const asked = apply(
      setup.state,
      { type: 'play_card', playerId: setup.caster, instanceId: setup.boltId },
      context,
    );
    const resolved = answer(asked, setup.caster, [setup.victim]);

    // Goblin Chieftain: 3/4, and it does not buff itself.
    expect(damageTo(resolved, setup.victim)).toBe(3);
  });

  it('is read when the instruction resolves, not when the target was chosen', () => {
    const setup = bolt();
    const asked = apply(
      setup.state,
      { type: 'play_card', playerId: setup.caster, instanceId: setup.boltId },
      context,
    );
    // The choice is answered against a board that has moved since it was
    // offered. A cached amount would still deal 3.
    const buffed = withAttackBonus(asked, setup.victim, 4);
    const resolved = answer(buffed, setup.caster, [setup.victim]);

    // Read from the log: seven damage is lethal to a 3/4, and a defeated unit
    // carries no marked damage to inspect afterwards.
    expect(damageTo(resolved, setup.victim)).toBe(7);
  });

  it('counts the continuous layer, not the printed statline', () => {
    // A second Goblin next to the Chieftain is a 1/1 printed and a 2/1 in play.
    const setup = bolt();
    const victimPlayer = opponentOf(setup.state, setup.caster);
    const buffed = deployUnit(setup.state, victimPlayer, 'goblin_torchrunner');
    const printed = database.getOrThrow('goblin_torchrunner').attack ?? 0;

    const asked = apply(
      buffed.state,
      { type: 'play_card', playerId: setup.caster, instanceId: setup.boltId },
      context,
    );
    const resolved = answer(asked, setup.caster, [buffed.instanceId]);

    expect(printed).toBe(1);
    expect(damageTo(resolved, buffed.instanceId)).toBe(printed + 1);
  });

  it('caches nothing: the same expression answers differently as the board moves', () => {
    const setup = bolt();
    const scope = {
      controllerId: setup.caster,
      sourceInstanceId: null,
      targetInstanceId: setup.victim,
    };
    const expression = {
      kind: 'stat',
      of: 'effect_target',
      stat: 'attack',
      plus: 0,
      minimum: 0,
    } as const;

    const before = evaluateValue({ ...context, state: setup.state }, expression, scope);
    const after = evaluateValue(
      { ...context, state: withAttackBonus(setup.state, setup.victim, 2) },
      expression,
      scope,
    );

    expect(before).toBe(3);
    expect(after).toBe(5);
  });
});

/* ------------------------------------------------------- Bastion Commander */

describe('Bastion Commander', () => {
  /**
   * A two-seat board where the Bastion player is the *defender*: their
   * Commander is deployed, the opponent has declared an attack, and blockers
   * are about to be assigned.
   */
  function underAttack(
    options: { readonly blockers?: number; readonly attackerCardId?: string } = {},
  ): {
    state: MatchState;
    bastion: PlayerId;
    attacker: PlayerId;
    attackerIds: InstanceId[];
    blockerIds: InstanceId[];
  } {
    // One attacker per blocker: an attacker may currently receive at most one
    // blocker, so two blockers need two things to block.
    const blockers = options.blockers ?? 1;
    // Seat two is the Bastion player, so the attack lands on their turn-off
    // side and their Commander is defending rather than attacking.
    let state = keepBothHands(
      startMatch({
        database,
        decks: [makeDeck('prototype_commander_blue'), makeDeck('bastion_commander')],
      }),
      context,
    );
    const attacker = state.activePlayerId;
    const bastion = opponentOf(state, attacker);

    const commander = deployCommander(state, bastion);
    state = commander.state;

    const blockerIds: InstanceId[] = [];
    for (let index = 0; index < blockers; index += 1) {
      const placed = deployUnit(state, bastion, 'goblin_torchrunner');
      state = placed.state;
      blockerIds.push(placed.instanceId);
    }

    const attackerIds: InstanceId[] = [];
    for (let index = 0; index < Math.max(1, blockers); index += 1) {
      const swung = deployUnit(state, attacker, options.attackerCardId ?? 'prototype_scout');
      state = swung.state;
      attackerIds.push(swung.instanceId);
    }

    state = apply(
      forcePhase(state, 'declare_attackers'),
      {
        type: 'declare_attackers',
        playerId: attacker,
        attacks: attacksOnOpponent(state, attackerIds),
      },
      context,
    );

    return { state, bastion, attacker, attackerIds, blockerIds };
  }

  function block(setup: ReturnType<typeof underAttack>, blockerIds: readonly InstanceId[]) {
    return apply(
      setup.state,
      {
        type: 'assign_blockers',
        playerId: setup.bastion,
        blocks: blockerIds.map((blockerInstanceId, index) => ({
          attackerInstanceId: setup.attackerIds[index] as InstanceId,
          blockerInstanceId,
        })),
      },
      context,
    );
  }

  /**
   * The bonus itself is not observable once `assign_blockers` has returned: it
   * lasts "for that combat", and combat damage has already been dealt and the
   * modifier cleaned up by then. What the log records and what the board looks
   * like afterwards are the two honest witnesses, and both are used below.
   */
  const grants = (state: MatchState) => eventsOfType(state, 'stats_modified');

  it('gives the blocker Health equal to its ATK', () => {
    const setup = underAttack();
    const after = block(setup, [setup.blockerIds[0] as InstanceId]);

    // Goblin Torchrunner is a 1/1; nothing else on this board buffs it.
    expect(grants(after)).toHaveLength(1);
    expect(grants(after)[0]).toMatchObject({
      instanceId: setup.blockerIds[0],
      attack: 0,
      health: 1,
      duration: 'end_of_combat',
    });
  });

  it('absorbs more of an Overwhelm attack before it reaches the player', () => {
    // Where the bonus is worth the most, and the clearest proof it is live
    // during the damage step: Overwhelm splits against the blocker's *current*
    // Health (CLAUDE.md), so a 1/1 that is a 1/2 for the combat soaks one more
    // point and the player takes one less.
    const setup = underAttack({ attackerCardId: 'goblin_horde_breaker' });
    const before = playerOf(setup.state, setup.bastion).health;
    const after = block(setup, [setup.blockerIds[0] as InstanceId]);

    // Horde Breaker hits for 5: two into a blocker that is 1/2 for the combat,
    // three through to the player rather than four.
    expect(before - playerOf(after, setup.bastion).health).toBe(3);
  });

  it('does not save a blocker whose marked damage outlives the bonus', () => {
    // "For that combat" is exactly that. The blocker lives through the damage
    // step at 1/2, then the bonus ends with the combat and the point of damage
    // it is carrying is lethal against its printed 1 Health. That is the
    // documented behaviour of every combat-length Health bonus, not something
    // this card does specially — see `durations.test.ts`.
    const setup = underAttack();
    const blockerId = setup.blockerIds[0] as InstanceId;
    const after = block(setup, [blockerId]);

    expect(instanceIn(after, blockerId).zone).toBe('discard');
  });

  it('reads the ATK the blocker has when the ability resolves, buffs included', () => {
    const setup = underAttack();
    // A Chieftain makes every other Goblin a point stronger, so the bonus the
    // blocker is owed is larger than its printed ATK.
    const withLord = deployUnit(setup.state, setup.bastion, 'goblin_chieftain');
    const after = block({ ...setup, state: withLord.state }, [setup.blockerIds[0] as InstanceId]);

    expect(grants(after)[0]?.health).toBe(2);
  });

  it('fires for the first blocker only', () => {
    const setup = underAttack({ blockers: 2 });
    const after = block(setup, setup.blockerIds);

    expect(grants(after)).toHaveLength(1);
    expect(grants(after)[0]?.instanceId).toBe(setup.blockerIds[0]);
  });

  it('does not fire for an opponent’s blocker', () => {
    // `blockers_assigned` is one event for the whole combat, so the Bastion
    // player's ability sees every blocker in it. A scope of `self` has to keep
    // the other seat's out — here the Bastion player is the *attacker*, and the
    // only unit that blocks belongs to somebody else.
    let state = keepBothHands(
      startMatch({
        database,
        decks: [makeDeck('bastion_commander'), makeDeck('prototype_commander_red')],
      }),
      context,
    );
    const bastion = state.activePlayerId;
    const defender = opponentOf(state, bastion);

    state = deployCommander(state, bastion).state;
    const swung = deployUnit(state, bastion, 'prototype_scout');
    const theirBlocker = deployUnit(swung.state, defender, 'goblin_torchrunner');

    state = apply(
      forcePhase(theirBlocker.state, 'declare_attackers'),
      {
        type: 'declare_attackers',
        playerId: bastion,
        attacks: attacksOnOpponent(theirBlocker.state, [swung.instanceId]),
      },
      context,
    );
    const after = apply(
      state,
      {
        type: 'assign_blockers',
        playerId: defender,
        blocks: [
          {
            attackerInstanceId: swung.instanceId,
            blockerInstanceId: theirBlocker.instanceId,
          },
        ],
      },
      context,
    );

    expect(grants(after)).toEqual([]);
  });

  it('does nothing while the Commander is still in the Command Zone', () => {
    // `activeZone` is battlefield, and a Commander that has not been deployed
    // is not on one (rule adjustment §3).
    let state = keepBothHands(
      startMatch({
        database,
        decks: [makeDeck('prototype_commander_blue'), makeDeck('bastion_commander')],
      }),
      context,
    );
    const attacker = state.activePlayerId;
    const bastion = opponentOf(state, attacker);

    const blocker = deployUnit(state, bastion, 'goblin_torchrunner');
    const swung = deployUnit(blocker.state, attacker, 'prototype_scout');
    state = apply(
      forcePhase(swung.state, 'declare_attackers'),
      {
        type: 'declare_attackers',
        playerId: attacker,
        attacks: attacksOnOpponent(swung.state, [swung.instanceId]),
      },
      context,
    );

    const after = apply(
      state,
      {
        type: 'assign_blockers',
        playerId: bastion,
        blocks: [{ attackerInstanceId: swung.instanceId, blockerInstanceId: blocker.instanceId }],
      },
      context,
    );
    expect(instanceIn(after, blocker.instanceId).statModifiers).toEqual([]);
  });
});

/* ---------------------------------------------------- Stitched Abomination */

describe('Stitched Abomination', () => {
  /** The Abomination in hand, plus `bodies` friendly units to feed the discount. */
  function hand(bodies: number): {
    state: MatchState;
    playerId: PlayerId;
    abominationId: InstanceId;
    purgeId: InstanceId;
  } {
    let state = keepBothHands(startMatch({ database }), context);
    const playerId = state.activePlayerId;
    for (let index = 0; index < bodies; index += 1) {
      state = deployUnit(state, playerId, 'goblin_torchrunner').state;
    }
    const abomination = giveCard(state, playerId, 'stitched_abomination');
    const purge = giveCard(abomination.state, playerId, 'test_purge');
    return {
      state: setEnergy(purge.state, playerId, 10),
      playerId,
      abominationId: abomination.instanceId,
      purgeId: purge.instanceId,
    };
  }

  /** Kills the caster's whole board, filling "units defeated this turn". */
  function purge(setup: ReturnType<typeof hand>): MatchState {
    return apply(
      setup.state,
      { type: 'play_card', playerId: setup.playerId, instanceId: setup.purgeId },
      context,
    );
  }

  const costOf = (state: MatchState, setup: ReturnType<typeof hand>): number =>
    playCostOf(
      { state, database, config: DEFAULT_RULES_CONFIG },
      setup.playerId,
      instanceIn(state, setup.abominationId),
    );

  it('costs its printed cost with nothing defeated', () => {
    const setup = hand(0);
    expect(costOf(setup.state, setup)).toBe(6);
  });

  it('gets 1 cheaper for each friendly Unit defeated this turn', () => {
    const setup = hand(2);
    const after = purge(setup);
    expect(playerOf(after, setup.playerId).units).toEqual([]);
    expect(costOf(after, setup)).toBe(4);
  });

  it('stops at the printed minimum cost of 3', () => {
    const setup = hand(5);
    const after = purge(setup);
    expect(costOf(after, setup)).toBe(3);
  });

  it('does not count Units an opponent lost', () => {
    const setup = hand(0);
    const opponent = opponentOf(setup.state, setup.playerId);
    let state = setup.state;
    for (let index = 0; index < 3; index += 1) {
      state = deployUnit(state, opponent, 'goblin_torchrunner').state;
    }
    // Their board, their losses. The clause says "friendly".
    const theirPurge = giveCard(state, opponent, 'test_purge');
    const cleared = apply(
      { ...theirPurge.state, activePlayerId: opponent },
      { type: 'play_card', playerId: opponent, instanceId: theirPurge.instanceId },
      context,
    );
    expect(costOf(cleared, setup)).toBe(6);
  });

  it('is offered by legal actions at the reduced cost, and only then', () => {
    const setup = hand(3);
    const after = setEnergy(purge(setup), setup.playerId, 3);

    const legal = legalActions(after, setup.playerId, { database });
    const offered = legal.playableCards.find((card) => card.instanceId === setup.abominationId);
    expect(offered?.energyCost).toBe(3);

    // One point short of even the reduced cost, and it disappears again.
    const broke = setEnergy(after, setup.playerId, 2);
    expect(
      legalActions(broke, setup.playerId, { database }).playableCards.map((c) => c.instanceId),
    ).not.toContain(setup.abominationId);
  });

  it('actually charges the reduced cost when it is played', () => {
    const setup = hand(3);
    const after = setEnergy(purge(setup), setup.playerId, 8);

    const played = apply(
      after,
      { type: 'play_card', playerId: setup.playerId, instanceId: setup.abominationId },
      context,
    );
    expect(playerOf(played, setup.playerId).energy).toBe(5);
    expect(playerOf(played, setup.playerId).units).toContain(setup.abominationId);
  });

  it('shows the discounted cost in the view before the card is affordable', () => {
    // The whole point of putting the number on the view: a player must be able
    // to see the discount while they still cannot pay it.
    const setup = hand(2);
    const after = setEnergy(purge(setup), setup.playerId, 0);

    const view = playerView(after, setup.playerId, database, DEFAULT_RULES_CONFIG);
    expect(view.instances[setup.abominationId]?.energyCost).toBe(4);
    expect(view.legalActions.playableCards.map((card) => card.instanceId)).not.toContain(
      setup.abominationId,
    );
  });

  it('never puts a cost on a card that is not in the viewer’s hand', () => {
    const setup = hand(1);
    const view = playerView(setup.state, setup.playerId, database, DEFAULT_RULES_CONFIG);

    for (const instance of Object.values(view.instances)) {
      if (instance.zone === 'hand' && instance.controller === setup.playerId) {
        expect(instance.energyCost).not.toBeNull();
        continue;
      }
      expect(instance.energyCost).toBeNull();
    }
  });

  it('leaves an unrelated card in the same hand at its printed cost', () => {
    const setup = hand(3);
    const after = purge(setup);
    const other = giveCard(after, setup.playerId, 'goblin_chieftain');

    expect(
      playCostOf(
        { state: other.state, database, config: DEFAULT_RULES_CONFIG },
        setup.playerId,
        instanceIn(other.state, other.instanceId),
      ),
    ).toBe(4);
  });
});

/* ------------------------------------------------------- floors and clamps */

describe('the cost floor', () => {
  it('never raises a card that already costs less than the printed minimum', () => {
    // A "to a minimum cost of N" clause is a floor on the reduction, not a
    // price. Clamped against the printed cost, exactly as `energyCostOf` clamps
    // one: a card printed at 2 with a floor of 5 simply does not get cheaper,
    // and must never be made *more* expensive by its own discount
    // (ruleset update §5).
    const cheap: CardDefinitionInput = {
      schemaVersion: 4,
      id: 'test_cheap_scaler',
      name: 'Test Cheap Scaler',
      type: 'unit',
      colorIdentity: ['black'],
      cost: 2,
      attack: 1,
      health: 1,
      staticAbilities: [
        {
          id: 'discount',
          activeZone: 'hand',
          affects: { zone: 'hand', controller: 'self', onlySource: true },
          effect: {
            type: 'cost_reduction',
            amount: { kind: 'count', count: { subject: 'units', controller: 'self' } },
            minimum: 5,
          },
        },
      ],
      displayText: 'This card costs 1 less for each Unit you control, to a minimum cost of 5.',
    };

    const withCheap = databaseWith([cheap]);
    const start = keepBothHands(startMatch({ database: withCheap }), {
      database: withCheap,
      config: DEFAULT_RULES_CONFIG,
    });
    const playerId = start.activePlayerId;
    const withUnits = deployUnit(start, playerId, 'goblin_torchrunner');
    const placed = giveCard(withUnits.state, playerId, 'test_cheap_scaler');

    expect(
      playCostOf(
        { state: placed.state, database: withCheap, config: DEFAULT_RULES_CONFIG },
        playerId,
        instanceIn(placed.state, placed.instanceId),
      ),
    ).toBe(2);
  });
});

describe('the shipped catalog', () => {
  it('no longer reports either M02.3 card as unimplemented', () => {
    const bundled = testDatabase();
    for (const cardId of ['bastion_commander', 'stitched_abomination']) {
      expect(bundled.getOrThrow(cardId).implemented).toBe(true);
    }
  });
});
