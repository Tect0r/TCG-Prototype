import { describe, expect, it } from 'vitest';
import { attackCensus } from './derive.js';
import { legalActions } from './legal-actions.js';
import {
  apply,
  attacksOnOpponent,
  deployUnit,
  eventsOfType,
  keepAllHands,
  keepBothHands,
  startMatch,
  startTable,
  testContext,
  testDatabase,
  toDeclareAttackers,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';

/**
 * M04.2 — the attack-opportunity census.
 *
 * The baseline could see that nobody attacked and nothing about whether anybody
 * could, so a quiet round was unreadable: a board the ruleset was still holding
 * back and a table of players declining produced the same silence. These tests
 * pin the census the engine now records at every attack declaration, and they pin
 * it against the *legality the engine enforces* rather than against a second
 * reading of the same rules — the point of `attackCensus` being one function is
 * that the telemetry cannot describe a game the engine is not playing.
 *
 * Nothing here asserts a verdict. Whether any of these boards is a stall is Q43.
 */

const context = testContext();

function opportunityOf(state: MatchState) {
  const events = eventsOfType(state, 'attack_opportunity');
  const last = events[events.length - 1];
  if (!last) throw new Error('No attack_opportunity event was recorded.');
  return last;
}

describe('attack opportunity', () => {
  it('reports the census the engine would enforce, and nothing else', () => {
    // Two Units that may attack, one Exhausted, one that arrived this turn.
    let state = keepBothHands(startMatch());
    state = deployUnit(state, 'player_1', 'prototype_drone').state;
    state = deployUnit(state, 'player_1', 'prototype_drone').state;
    state = deployUnit(state, 'player_1', 'prototype_drone', { exhausted: true }).state;
    state = deployUnit(state, 'player_1', 'prototype_drone', { summoningSick: true }).state;
    state = toDeclareAttackers(state, context);

    // The engine's own answer to "who may attack", taken before the declaration
    // so the comparison is against what the seat was actually offered.
    const offered = legalActions(state, 'player_1', context).attacking;
    expect(offered?.legalAttackers).toHaveLength(2);

    state = apply(state, { type: 'declare_attackers', playerId: 'player_1', attacks: [] }, context);

    const census = opportunityOf(state);
    expect(census.playerId).toBe('player_1');
    expect(census.units).toBe(4);
    expect(census.readyUnits).toBe(3);
    expect(census.legalAttackers).toBe(2);
    expect(census.exhaustedUnits).toBe(1);
    expect(census.newlyDeployedUnits).toBe(1);
    expect(census.legalDefenders).toBe(1);
    // The fact the baseline could not record: this seat could have attacked and
    // did not. Silence alone never said which.
    expect(census.declaredAttackers).toBe(0);
    expect(census.legalAttackers).toBe(offered?.legalAttackers.length);
  });

  it('partitions every Unit into exactly one reason', () => {
    // A breakdown that does not add up is a defect, not a judgement call: a
    // future attack restriction landing in only one branch of `attackCensus`
    // would leave a seat unaccounted for and the round series would quietly stop
    // being readable.
    let state = keepBothHands(startMatch());
    state = deployUnit(state, 'player_1', 'prototype_drone').state;
    state = deployUnit(state, 'player_1', 'prototype_drone', { exhausted: true }).state;
    state = deployUnit(state, 'player_1', 'prototype_scout', { summoningSick: true }).state;
    state = deployUnit(state, 'player_1', 'prototype_drone', { summoningSick: true }).state;

    const census = attackCensus(state, testDatabase(), 'player_1');
    expect(census.units).toBe(
      census.legalAttackers.length + census.exhaustedUnits + census.newlyDeployedUnits,
    );
    expect(census.readyUnits).toBe(census.units - census.exhaustedUnits);
    // Rush is not a fourth category: it makes a Newly Deployed Unit legal, so
    // the Scout counts as an attacker and only the Drone is held back.
    expect(census.legalAttackers).toHaveLength(2);
    expect(census.newlyDeployedUnits).toBe(1);
  });

  it('describes the board the seat decided against, not the one it produced', () => {
    // Declared attackers Exhaust immediately, so a census taken a moment later
    // would report a board with no Ready Unit on it and read as "nobody could
    // attack" for the turn somebody attacked with everything.
    let state = keepBothHands(startMatch());
    const first = deployUnit(state, 'player_1', 'prototype_drone');
    const second = deployUnit(first.state, 'player_1', 'prototype_drone');
    state = toDeclareAttackers(second.state, context);
    state = apply(
      state,
      {
        type: 'declare_attackers',
        playerId: 'player_1',
        attacks: attacksOnOpponent(state, [first.instanceId, second.instanceId]),
      },
      context,
    );

    const census = opportunityOf(state);
    expect(census.readyUnits).toBe(2);
    expect(census.legalAttackers).toBe(2);
    expect(census.exhaustedUnits).toBe(0);
    expect(census.declaredAttackers).toBe(2);
  });

  it('records a census even when there was nothing at all to attack with', () => {
    // The other half of the distinction. An empty board is early development;
    // reporting it as a decision would be wrong, and reporting nothing would make
    // it indistinguishable from a seat that declined.
    let state = keepBothHands(startMatch());
    state = toDeclareAttackers(state, context);
    state = apply(state, { type: 'declare_attackers', playerId: 'player_1', attacks: [] }, context);

    const census = opportunityOf(state);
    expect(census.units).toBe(0);
    expect(census.readyUnits).toBe(0);
    expect(census.legalAttackers).toBe(0);
    expect(census.newlyDeployedUnits).toBe(0);
    expect(census.declaredAttackers).toBe(0);
  });

  it('counts the living opponents a seat could have attacked', () => {
    // Not a constant: with three opponents "nobody to attack" is a different
    // situation from "nothing to attack with", and on a free-for-all table the
    // count changes as seats go out.
    let state = keepAllHands(startTable(4));
    state = deployUnit(state, state.activePlayerId, 'prototype_drone').state;
    const active = state.activePlayerId;
    state = toDeclareAttackers(state, context);
    state = apply(state, { type: 'declare_attackers', playerId: active, attacks: [] }, context);

    expect(opportunityOf(state).legalDefenders).toBe(3);
  });

  it('is an observation: no trigger and no rule reads it', () => {
    // Emitted immediately before `attackers_declared`, in the same declaration,
    // so a reader can pair them without matching on turn numbers — and after the
    // validation that would have rejected the declaration, so a refused attack
    // records no census at all.
    let state = keepBothHands(startMatch());
    state = deployUnit(state, 'player_1', 'prototype_drone').state;
    state = toDeclareAttackers(state, context);
    state = apply(state, { type: 'declare_attackers', playerId: 'player_1', attacks: [] }, context);

    const types = state.log.map((event) => event.type);
    const census = types.lastIndexOf('attack_opportunity');
    const declared = types.lastIndexOf('attackers_declared');
    expect(census).toBeGreaterThan(-1);
    expect(declared).toBe(census + 1);
    // No queued trigger came out of it. The event exists to be read by
    // telemetry; a rule that branched on it would make the measurement part of
    // the game.
    expect(eventsOfType(state, 'trigger_queued')).toHaveLength(0);
  });
});
