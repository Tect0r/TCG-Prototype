import { describe, expect, it } from 'vitest';
import { currentAttack, currentHealth, definitionOf, opponentOf } from './derive.js';
import {
  apply,
  attacksOnOpponent,
  databaseWith,
  deployUnit,
  forcePhase,
  giveCard,
  instanceIn,
  keepBothHands,
  makeDeck,
  setEnergy,
  startMatch,
  testContext,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';

/**
 * The two duration boundaries the ruleset's combat tricks need (§15).
 *
 * `end_of_turn` could express neither of them. "+1 ATK **for that combat**" has
 * to be gone by the second Main Phase, and "+0/+2 **until the beginning of your
 * next turn**" has to survive the opponents' turns in between — which is the
 * whole reason a defensive buff is worth playing on your own turn.
 *
 * Both are tested against the boundary they are *not*: the end-of-combat case
 * checks the bonus was live while damage was dealt, and the next-turn case
 * checks against an `end_of_turn` control that expires a turn earlier. Without
 * the contrast a modifier that silently never expired would pass.
 */

const CARDS = [
  /** Attacks for nothing, so a blocker's survival is never in question. */
  {
    schemaVersion: 3,
    id: 'dur_attacker',
    name: 'Harmless Charger',
    type: 'unit',
    colorIdentity: [],
    cost: 1,
    attack: 0,
    health: 6,
  },
  {
    schemaVersion: 3,
    id: 'dur_body',
    name: 'Plain Body',
    type: 'unit',
    colorIdentity: [],
    cost: 1,
    attack: 1,
    health: 1,
  },
  {
    // "When this Unit blocks, it gains +2 ATK for that combat."
    schemaVersion: 3,
    id: 'dur_bracer',
    name: 'Bracing Guard',
    type: 'unit',
    colorIdentity: [],
    cost: 1,
    attack: 1,
    health: 6,
    abilities: [
      {
        id: 'brace',
        trigger: 'on_block',
        effects: [
          {
            type: 'modify_stats',
            target: { kind: 'source' },
            attack: 2,
            health: 0,
            duration: 'end_of_combat',
          },
        ],
      },
    ],
  },
  {
    schemaVersion: 3,
    id: 'dur_ward',
    name: 'Long Ward',
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
            filter: { cardTypes: ['unit'] },
            count: 'all',
            selection: 'automatic',
          },
        },
        attack: 0,
        health: 2,
        duration: 'until_your_next_turn',
      },
    ],
  },
  {
    /** Identical but for the duration: the control the ward is measured against. */
    schemaVersion: 3,
    id: 'dur_flash',
    name: 'Brief Ward',
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
            filter: { cardTypes: ['unit'] },
            count: 'all',
            selection: 'automatic',
          },
        },
        attack: 0,
        health: 2,
        duration: 'end_of_turn',
      },
    ],
  },
] as const;

const database = databaseWith(CARDS as never);
const context = { ...testContext(), database };

function opened(): MatchState {
  const deck = makeDeck('prototype_commander_blue', ['dur_body']);
  return keepBothHands(startMatch({ database, decks: [deck, deck] }), context);
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

/**
 * Hands the turn over. Passing from the second Main Phase runs turn end and
 * every phase of the next player's turn up to their first Main Phase.
 */
function endTurn(state: MatchState): MatchState {
  return apply(
    forcePhase(state, 'main_2'),
    { type: 'pass_phase', playerId: state.activePlayerId },
    context,
  );
}

function healthOf(state: MatchState, instanceId: string): number {
  const instance = instanceIn(state, instanceId);
  return currentHealth(instance, definitionOf(database, instance));
}

function attackOf(state: MatchState, instanceId: string): number {
  const instance = instanceIn(state, instanceId);
  return currentAttack(instance, definitionOf(database, instance));
}

describe('"for that combat"', () => {
  it('is live while combat damage is dealt, and gone in the second Main Phase', () => {
    const start = opened();
    const attackerPlayer = start.activePlayerId;
    const defender = opponentOf(start, attackerPlayer);

    const charger = deployUnit(start, attackerPlayer, 'dur_attacker');
    const bracer = deployUnit(charger.state, defender, 'dur_bracer');

    const declared = apply(
      forcePhase(bracer.state, 'declare_attackers'),
      {
        type: 'declare_attackers',
        playerId: attackerPlayer,
        attacks: attacksOnOpponent(bracer.state, [charger.instanceId]),
      },
      context,
    );

    const resolved = apply(
      declared,
      {
        type: 'assign_blockers',
        playerId: defender,
        blocks: [{ attackerInstanceId: charger.instanceId, blockerInstanceId: bracer.instanceId }],
      },
      context,
    );

    // Three damage, not one: the on-block bonus was applied before damage, which
    // is the only thing that distinguishes a working trick from a no-op.
    expect(instanceIn(resolved, charger.instanceId).markedDamage).toBe(3);
    // …and it is already gone, because combat resolution is the boundary.
    expect(resolved.phase).toBe('main_2');
    expect(attackOf(resolved, bracer.instanceId)).toBe(1);
    expect(instanceIn(resolved, bracer.instanceId).statModifiers).toHaveLength(0);
  });

  it('can defeat a damaged unit the moment the bonus lapses', () => {
    // Health granted for a combat is the lethal case: the state-based check has
    // to run at the boundary, not lazily at turn end (CLAUDE.md §4).
    const start = opened();
    const active = start.activePlayerId;
    const body = deployUnit(start, active, 'dur_body');

    const instance = structuredClone(body.state);
    const target = instance.instances[body.instanceId];
    if (!target) throw new Error('missing fixture instance');
    target.statModifiers.push({
      attack: 0,
      health: 3,
      duration: 'end_of_combat',
      sourceInstanceId: null,
      appliedOnTurn: instance.turn,
    });
    target.markedDamage = 2;

    // A combat that involves nobody still ends, and ending it is what kills it.
    const after = apply(
      forcePhase(instance, 'declare_attackers'),
      { type: 'declare_attackers', playerId: active, attacks: [] },
      context,
    );

    expect(after.instances[body.instanceId]?.zone).toBe('discard');
  });
});

describe('"until the beginning of your next turn"', () => {
  it('survives the opponent’s whole turn, then expires at your Ready Step', () => {
    const start = opened();
    const active = start.activePlayerId;
    const body = deployUnit(start, active, 'dur_body');

    const warded = play(body.state, 'dur_ward');
    expect(healthOf(warded, body.instanceId)).toBe(3);

    const opponentTurn = endTurn(warded);
    expect(opponentTurn.activePlayerId).not.toBe(active);
    // The point of the duration: an `end_of_turn` buff would already be gone,
    // and the opponent's attack step is exactly when this one has to hold.
    expect(healthOf(opponentTurn, body.instanceId)).toBe(3);

    const ownTurn = endTurn(opponentTurn);
    expect(ownTurn.activePlayerId).toBe(active);
    expect(healthOf(ownTurn, body.instanceId)).toBe(1);
    expect(instanceIn(ownTurn, body.instanceId).statModifiers).toHaveLength(0);
  });

  it('outlasts an otherwise identical end-of-turn buff', () => {
    const start = opened();
    const active = start.activePlayerId;
    const body = deployUnit(start, active, 'dur_body');

    const buffed = play(body.state, 'dur_flash');
    expect(healthOf(buffed, body.instanceId)).toBe(3);

    const opponentTurn = endTurn(buffed);
    expect(healthOf(opponentTurn, body.instanceId)).toBe(1);
  });

  it('expires only for the player whose turn is beginning', () => {
    // Clearing every player's modifiers at one turn start would silently make
    // the duration mean "until the next turn", whoever's it is.
    const start = opened();
    const active = start.activePlayerId;
    const other = opponentOf(start, active);

    const mine = deployUnit(start, active, 'dur_body');
    const theirs = deployUnit(mine.state, other, 'dur_body');
    const warded = play(theirs.state, 'dur_ward');

    const opponentTurn = endTurn(warded);
    expect(healthOf(opponentTurn, mine.instanceId)).toBe(3);
    // The opponent's own unit was never warded, so it is the untouched control.
    expect(healthOf(opponentTurn, theirs.instanceId)).toBe(1);
  });
});
