import { describe, expect, it } from 'vitest';
import { currentAttack, definitionOf, opponentOf, playerOf } from './derive.js';
import { evaluateCount } from './values.js';
import {
  apply,
  attacksOnOpponent,
  databaseWith,
  deployUnit,
  forcePhase,
  giveCard,
  instanceIn,
  keepAllHands,
  keepBothHands,
  makeDeck,
  setEnergy,
  startMatch,
  startTable,
  testContext,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';

/**
 * "Survived combat as a blocker" (ruleset update §15), in both windows the
 * catalog asks for.
 *
 * The cards print two different questions and they are genuinely different:
 *
 *  - **"…that turn"** — `turnEvents.survivedAsBlocker`, cleared at every turn
 *    start like the rest of the turn history.
 *  - **"…since your previous turn"** — the `survivedAsBlocker` flag on the
 *    instance, cleared at the end of its controller's *own* turn.
 *
 * With one opponent the two coincide, which is exactly why the three-seat test
 * below matters: after two opponents' turns the flag is still set from the
 * first and the per-turn answer for the second is no. Collapsing them into one
 * record would make `watchtower` fire on a turn nothing happened.
 */

const CARDS = [
  /** Attacks for nothing, so the blocker always lives to record the fact. */
  {
    schemaVersion: 3,
    id: 'sb_attacker',
    name: 'Harmless Charger',
    type: 'unit',
    colorIdentity: [],
    cost: 1,
    attack: 0,
    health: 6,
  },
  {
    schemaVersion: 3,
    id: 'sb_blocker',
    name: 'Plain Blocker',
    type: 'unit',
    colorIdentity: [],
    cost: 1,
    attack: 1,
    health: 6,
  },
  {
    // "Whenever this Unit survives combat as a blocker, it gains +2 ATK."
    schemaVersion: 3,
    id: 'sb_grower',
    name: 'Grower',
    type: 'unit',
    colorIdentity: [],
    cost: 1,
    attack: 1,
    health: 6,
    abilities: [
      {
        id: 'grow',
        trigger: 'on_survive_combat_as_blocker',
        effects: [
          {
            type: 'modify_stats',
            target: { kind: 'source' },
            attack: 2,
            health: 0,
            duration: 'permanent',
          },
        ],
      },
    ],
  },
  {
    /** "Friendly Units that survived as blockers since your previous turn gain +1 ATK." */
    schemaVersion: 3,
    id: 'sb_rally',
    name: 'Rally',
    type: 'spell',
    colorIdentity: [],
    cost: 1,
    effects: [
      {
        type: 'modify_stats',
        target: {
          kind: 'entity',
          selector: {
            zone: 'battlefield',
            controller: 'self',
            filter: { cardTypes: ['unit'], survivedAsBlocker: true },
            count: 'all',
            selection: 'automatic',
          },
        },
        attack: 1,
        health: 0,
        duration: 'end_of_turn',
      },
    ],
  },
] as const;

const database = databaseWith(CARDS as never);
const context = { ...testContext(), database };

function opened(seats = 2): MatchState {
  const deck = makeDeck('prototype_commander_blue', ['sb_blocker']);
  if (seats === 2) return keepBothHands(startMatch({ database, decks: [deck, deck] }), context);
  return keepAllHands(startTable(seats, { database, deck }), context);
}

/** Plays a card from a freshly conjured copy in the active seat's hand. */
function play(state: MatchState, definitionId: string): MatchState {
  const active = state.activePlayerId;
  const placed = giveCard(setEnergy(state, active, 9), active, definitionId);
  return apply(
    placed.state,
    { type: 'play_card', playerId: active, instanceId: placed.instanceId },
    context,
  );
}

function endTurn(state: MatchState): MatchState {
  return apply(
    forcePhase(state, 'main_2'),
    { type: 'pass_phase', playerId: state.activePlayerId },
    context,
  );
}

/** The active player attacks with `attackerId`; `blockerId` blocks and lives. */
function blockOnce(state: MatchState, attackerId: string, blockerId: string): MatchState {
  const attackerPlayer = state.activePlayerId;
  const defender = instanceIn(state, blockerId).controller;
  const declared = apply(
    forcePhase(state, 'declare_attackers'),
    {
      type: 'declare_attackers',
      playerId: attackerPlayer,
      // Named explicitly rather than via `attacksOnOpponent`, which assumes the
      // single opponent of a two-seat table.
      attacks: [{ attackerInstanceId: attackerId, defenderPlayerId: defender }],
    },
    context,
  );
  return apply(
    declared,
    {
      type: 'assign_blockers',
      playerId: defender,
      blocks: [{ attackerInstanceId: attackerId, blockerInstanceId: blockerId }],
    },
    context,
  );
}

describe('the on_survive_combat_as_blocker trigger', () => {
  it('fires for a blocker that lives, and not for the attacker', () => {
    const start = opened();
    const attackerPlayer = start.activePlayerId;
    const defender = opponentOf(start, attackerPlayer);

    const charger = deployUnit(start, attackerPlayer, 'sb_attacker');
    const grower = deployUnit(charger.state, defender, 'sb_grower');
    // An attacking Grower is the control: it also survives combat, but not as a
    // blocker, and the two triggers must not be the same trigger.
    const attackingGrower = deployUnit(grower.state, attackerPlayer, 'sb_grower');

    const after = blockOnce(attackingGrower.state, charger.instanceId, grower.instanceId);

    const blocked = instanceIn(after, grower.instanceId);
    expect(currentAttack(blocked, definitionOf(database, blocked))).toBe(3);
    expect(instanceIn(after, attackingGrower.instanceId).statModifiers).toHaveLength(0);
  });
});

describe('"since your previous turn"', () => {
  it('is set by blocking and readable on the controller’s next turn', () => {
    const start = opened();
    const attackerPlayer = start.activePlayerId;
    const defender = opponentOf(start, attackerPlayer);

    const charger = deployUnit(start, attackerPlayer, 'sb_attacker');
    const blocker = deployUnit(charger.state, defender, 'sb_blocker');
    const blocked = blockOnce(blocker.state, charger.instanceId, blocker.instanceId);
    expect(instanceIn(blocked, blocker.instanceId).survivedAsBlocker).toBe(true);

    // The defender's own turn: this is when their payoff cards read it.
    const defenderTurn = endTurn(blocked);
    expect(defenderTurn.activePlayerId).toBe(defender);
    const rallied = play(defenderTurn, 'sb_rally');
    const instance = instanceIn(rallied, blocker.instanceId);
    expect(currentAttack(instance, definitionOf(database, instance))).toBe(2);
  });

  it('is cleared at the end of the controller’s own turn, not at its start', () => {
    // The order matters: clearing at the Ready Step would leave the
    // `on_turn_start` cards that read this with nothing to see.
    const start = opened();
    const attackerPlayer = start.activePlayerId;
    const defender = opponentOf(start, attackerPlayer);

    const charger = deployUnit(start, attackerPlayer, 'sb_attacker');
    const blocker = deployUnit(charger.state, defender, 'sb_blocker');
    const blocked = blockOnce(blocker.state, charger.instanceId, blocker.instanceId);

    const defenderTurn = endTurn(blocked);
    expect(instanceIn(defenderTurn, blocker.instanceId).survivedAsBlocker).toBe(true);

    const afterDefenderTurn = endTurn(defenderTurn);
    expect(instanceIn(afterDefenderTurn, blocker.instanceId).survivedAsBlocker).toBe(false);
  });

  it('reaches nobody who did not block', () => {
    const start = opened();
    const attackerPlayer = start.activePlayerId;
    const defender = opponentOf(start, attackerPlayer);

    const charger = deployUnit(start, attackerPlayer, 'sb_attacker');
    const blocker = deployUnit(charger.state, defender, 'sb_blocker');
    const bystander = deployUnit(blocker.state, defender, 'sb_blocker');
    const blocked = blockOnce(bystander.state, charger.instanceId, blocker.instanceId);

    const rallied = play(endTurn(blocked), 'sb_rally');
    const idle = instanceIn(rallied, bystander.instanceId);
    expect(currentAttack(idle, definitionOf(database, idle))).toBe(1);
  });
});

describe('"that turn"', () => {
  it('records the block in the turn history and clears it next turn', () => {
    const start = opened();
    const attackerPlayer = start.activePlayerId;
    const defender = opponentOf(start, attackerPlayer);

    const charger = deployUnit(start, attackerPlayer, 'sb_attacker');
    const blocker = deployUnit(charger.state, defender, 'sb_blocker');
    const blocked = blockOnce(blocker.state, charger.instanceId, blocker.instanceId);

    expect(blocked.turnEvents.survivedAsBlocker).toHaveLength(1);
    expect(blocked.turnEvents.survivedAsBlocker[0]?.controller).toBe(defender);
    expect(endTurn(blocked).turnEvents.survivedAsBlocker).toEqual([]);
  });

  it('answers "no" on a later opponent’s turn where the flag still says "yes"', () => {
    // The case the two windows exist for. The blocker is the *last* seat, so
    // the next turn belongs to a third player: the block did not happen on it,
    // and the blocker's own turn — the boundary that clears the flag — has not
    // come round yet.
    const start = opened(3);
    const first = start.activePlayerId;
    const defender = start.seatOrder[start.seatOrder.length - 1] as string;
    expect(defender).not.toBe(first);

    const charger = deployUnit(start, first, 'sb_attacker');
    const blocker = deployUnit(charger.state, defender, 'sb_blocker');
    const blocked = blockOnce(blocker.state, charger.instanceId, blocker.instanceId);

    const bystanderTurn = endTurn(blocked);
    expect(bystanderTurn.activePlayerId).not.toBe(defender);
    expect(bystanderTurn.activePlayerId).not.toBe(first);

    const ctx = { ...context, state: bystanderTurn, events: [], cause: {} } as never;
    const thisTurn = evaluateCount(
      ctx,
      { subject: 'units_survived_as_blocker_this_turn', controller: 'self', excludeSource: false },
      { controllerId: defender, sourceInstanceId: null },
    );
    expect(thisTurn).toBe(0);
    // …while the durable flag is still set, because the defender's own turn has
    // not come round to clear it.
    expect(instanceIn(bystanderTurn, blocker.instanceId).survivedAsBlocker).toBe(true);
  });

  it('counts one entry per surviving blocker', () => {
    const start = opened();
    const attackerPlayer = start.activePlayerId;
    const defender = opponentOf(start, attackerPlayer);

    let state = deployUnit(start, attackerPlayer, 'sb_attacker').state;
    const chargers = playerOf(state, attackerPlayer).units;
    const secondCharger = deployUnit(state, attackerPlayer, 'sb_attacker');
    state = secondCharger.state;

    const firstBlocker = deployUnit(state, defender, 'sb_blocker');
    const secondBlocker = deployUnit(firstBlocker.state, defender, 'sb_blocker');
    state = secondBlocker.state;

    const declared = apply(
      forcePhase(state, 'declare_attackers'),
      {
        type: 'declare_attackers',
        playerId: attackerPlayer,
        attacks: attacksOnOpponent(state, [chargers[0] as string, secondCharger.instanceId]),
      },
      context,
    );
    const after = apply(
      declared,
      {
        type: 'assign_blockers',
        playerId: defender,
        blocks: [
          { attackerInstanceId: chargers[0] as string, blockerInstanceId: firstBlocker.instanceId },
          {
            attackerInstanceId: secondCharger.instanceId,
            blockerInstanceId: secondBlocker.instanceId,
          },
        ],
      },
      context,
    );

    expect(after.turnEvents.survivedAsBlocker).toHaveLength(2);
  });
});
