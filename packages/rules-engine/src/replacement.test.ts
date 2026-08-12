import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES_CONFIG } from './config.js';
import { opponentOf, playerOf } from './derive.js';
import { matchStateSchema } from './schema/state.js';
import { playerView } from './view.js';
import {
  apply,
  attacksOnOpponent,
  deployRelic,
  deployUnit,
  eventsOfType,
  forcePhase,
  giveCard,
  instanceIn,
  keepBothHands,
  setEnergy,
  startMatch,
  testContext,
  testDatabase,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';

/**
 * M02.4 — the replacement layer, exercised through the five shipped cards.
 *
 * Test-only definitions are used for exactly one thing here: the bounded cases
 * the authored catalog does not contain — a zero-cost `replace_ready`, and two
 * replacements competing over the same arrival. Everything a printed card
 * claims is checked against that card's own data, because the point of the
 * tranche is that these five cards work.
 *
 * The recurring assertion is that nothing ever sees the un-replaced version: a
 * unit that arrives Exhausted is never reported Ready, and the log carries the
 * attribution rather than leaving a player to infer it from the board.
 */

const context = testContext(DEFAULT_RULES_CONFIG);
const database = testDatabase();

/** A two-seat match in the active player's first Main Phase, with energy. */
function board(): { state: MatchState; playerId: PlayerId; opponentId: PlayerId } {
  const start = keepBothHands(startMatch(), context);
  const playerId = start.activePlayerId;
  const opponentId = opponentOf(start, playerId);
  const funded = setEnergy(setEnergy(start, playerId, 10), opponentId, 10);
  return { state: funded, playerId, opponentId };
}

/** Hands the turn over, running the next player's whole turn start. */
function endTurn(state: MatchState): MatchState {
  return apply(
    forcePhase(state, 'main_2'),
    { type: 'pass_phase', playerId: state.activePlayerId },
    context,
  );
}

function play(state: MatchState, playerId: PlayerId, definitionId: string): MatchState {
  const placed = giveCard(state, playerId, definitionId);
  return apply(
    placed.state,
    { type: 'play_card', playerId, instanceId: placed.instanceId },
    context,
  );
}

function pendingChoice(state: MatchState) {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('Expected a pending choice');
  return choice;
}

function answer(state: MatchState, selectedIds: readonly InstanceId[]): MatchState {
  const choice = pendingChoice(state);
  return apply(
    state,
    {
      type: 'submit_choice',
      playerId: choice.playerId,
      choiceId: choice.id,
      selectedIds: [...selectedIds],
    },
    context,
  );
}

/** The units a player controls, in arrival order. */
function unitsOf(state: MatchState, playerId: PlayerId): InstanceId[] {
  return [...playerOf(state, playerId).units];
}

function tokensOf(state: MatchState, playerId: PlayerId, definitionId: string): InstanceId[] {
  return unitsOf(state, playerId).filter(
    (instanceId) => instanceIn(state, instanceId).definitionId === definitionId,
  );
}

describe('Containment Array — replacing an arrival', () => {
  it('makes the first enemy Unit deployed each turn arrive Exhausted, and says who did it', () => {
    const { state, playerId, opponentId } = board();
    const array = deployRelic(state, playerId, 'containment_array');
    const opponentTurn = endTurn(array.state);
    const funded = setEnergy(opponentTurn, opponentId, 10);

    const deployed = play(funded, opponentId, 'goblin_scout');
    const scout = unitsOf(deployed, opponentId).at(-1);
    if (scout === undefined) throw new Error('Expected the scout to be on the battlefield');

    expect(instanceIn(deployed, scout).exhausted).toBe(true);

    const replaced = eventsOfType(deployed, 'arrival_replaced');
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({
      instanceId: scout,
      playerId: opponentId,
      sourceInstanceId: array.instanceId,
      sourceDefinitionId: 'containment_array',
      abilityId: 'containment_field',
      exhausted: true,
      keyword: null,
    });
  });

  it('rewrites the arrival itself: nothing ever reports the unit Ready or exhausts it after', () => {
    const { state, playerId, opponentId } = board();
    const array = deployRelic(state, playerId, 'containment_array');
    const funded = setEnergy(endTurn(array.state), opponentId, 10);
    const before = funded.log.length;

    const deployed = play(funded, opponentId, 'goblin_scout');
    const scout = unitsOf(deployed, opponentId).at(-1);
    const fresh = deployed.log.slice(before);

    // The replacement is part of the arrival, so there is no separate
    // `unit_exhausted` step a player or a Reaction could sit between — and the
    // unit is never announced as readying.
    expect(fresh.filter((event) => event.type === 'unit_exhausted')).toEqual([]);
    expect(fresh.filter((event) => event.type === 'unit_readied')).toEqual([]);

    // The rewrite is announced before the arrival it rewrote.
    const replacedAt = fresh.findIndex((event) => event.type === 'arrival_replaced');
    const arrivedAt = fresh.findIndex(
      (event) => event.type === 'unit_entered_battlefield' && event.instanceId === scout,
    );
    expect(replacedAt).toBeGreaterThanOrEqual(0);
    expect(replacedAt).toBeLessThan(arrivedAt);
  });

  it('spends itself on the first arrival and leaves the second Ready', () => {
    const { state, playerId, opponentId } = board();
    const array = deployRelic(state, playerId, 'containment_array');
    const funded = setEnergy(endTurn(array.state), opponentId, 10);

    const first = play(funded, opponentId, 'goblin_scout');
    const second = play(first, opponentId, 'goblin_scout');
    const units = unitsOf(second, opponentId);
    const [caught, free] = [units.at(-2), units.at(-1)];
    if (caught === undefined || free === undefined) throw new Error('Expected two units');

    expect(instanceIn(second, caught).exhausted).toBe(true);
    expect(instanceIn(second, free).exhausted).toBe(false);
    expect(eventsOfType(second, 'arrival_replaced')).toHaveLength(1);
  });

  it('catches a Token an opponent creates, because creating one is deploying one', () => {
    const { state, playerId, opponentId } = board();
    const array = deployRelic(state, playerId, 'containment_array');
    const funded = setEnergy(endTurn(array.state), opponentId, 10);

    const summoned = play(funded, opponentId, 'call_a_goblin');
    const tokens = tokensOf(summoned, opponentId, 'goblin_token');
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.filter((id) => instanceIn(summoned, id).exhausted)).toHaveLength(1);
  });

  it('leaves its own controller’s units alone', () => {
    const { state, playerId } = board();
    const array = deployRelic(state, playerId, 'containment_array');

    const deployed = play(array.state, playerId, 'goblin_scout');
    const scout = unitsOf(deployed, playerId).at(-1);
    if (scout === undefined) throw new Error('Expected the scout to be on the battlefield');

    expect(instanceIn(deployed, scout).exhausted).toBe(false);
    expect(eventsOfType(deployed, 'arrival_replaced')).toEqual([]);
  });
});

describe('Goblin Warhorn Captain — replacing an arrival with a keyword', () => {
  it('gives a Goblin Token you create on your own turn Rush until end of turn', () => {
    const { state, playerId } = board();
    const captain = deployUnit(state, playerId, 'goblin_warhorn_captain');

    const summoned = play(captain.state, playerId, 'call_a_goblin');
    const token = tokensOf(summoned, playerId, 'goblin_token').at(-1);
    if (token === undefined) throw new Error('Expected a Goblin Token');

    const granted = instanceIn(summoned, token).grantedKeywords;
    expect(granted).toEqual([
      expect.objectContaining({
        keyword: 'rush',
        duration: 'end_of_turn',
        sourceInstanceId: captain.instanceId,
      }),
    ]);
    expect(playerView(summoned, playerId, database).instances[token]?.keywords).toContain('rush');
  });

  it('does nothing on somebody else’s turn', () => {
    const { state, playerId, opponentId } = board();
    const captain = deployUnit(state, playerId, 'goblin_warhorn_captain');
    // The Captain's controller passes; the opponent's Goblins are not "yours",
    // and the Captain's own turn is over either way.
    const opponentTurn = setEnergy(endTurn(captain.state), opponentId, 10);

    const summoned = play(opponentTurn, opponentId, 'call_a_goblin');
    for (const token of tokensOf(summoned, opponentId, 'goblin_token')) {
      expect(instanceIn(summoned, token).grantedKeywords).toEqual([]);
    }
    expect(eventsOfType(summoned, 'arrival_replaced')).toEqual([]);
  });

  it('does not reach a Token that is not a Goblin', () => {
    const { state, playerId } = board();
    const captain = deployUnit(state, playerId, 'goblin_warhorn_captain');

    const summoned = play(captain.state, playerId, 'call_the_watch');
    const guards = tokensOf(summoned, playerId, 'guard_token');
    expect(guards.length).toBeGreaterThan(0);
    for (const guard of guards) {
      expect(instanceIn(summoned, guard).grantedKeywords).toEqual([]);
    }
  });
});

describe('Stasis Seal — a stored readiness prevention', () => {
  it('exhausts one chosen Unit and seals that same Unit, asking only once', () => {
    const { state, playerId, opponentId } = board();
    const target = deployUnit(state, opponentId, 'goblin_scout');

    const cast = play(target.state, playerId, 'stasis_seal');
    const chosen = answer(cast, [target.instanceId]);

    expect(chosen.pendingChoice).toBeNull();
    expect(instanceIn(chosen, target.instanceId).exhausted).toBe(true);
    expect(instanceIn(chosen, target.instanceId).readySkip).toMatchObject({
      sourceInstanceId: expect.any(String),
    });
    expect(eventsOfType(chosen, 'ready_skip_applied')).toHaveLength(1);
    expect(
      playerView(chosen, opponentId, database).instances[target.instanceId]?.willNotReady,
    ).toBe(true);
  });

  it('keeps the Unit Exhausted through its controller’s next Ready Step, once', () => {
    const { state, playerId, opponentId } = board();
    const target = deployUnit(state, opponentId, 'goblin_scout');
    const sealed = answer(play(target.state, playerId, 'stasis_seal'), [target.instanceId]);

    const theirTurn = endTurn(sealed);
    expect(theirTurn.activePlayerId).toBe(opponentId);
    expect(instanceIn(theirTurn, target.instanceId).exhausted).toBe(true);
    expect(instanceIn(theirTurn, target.instanceId).readySkip).toBeNull();

    const prevented = eventsOfType(theirTurn, 'ready_prevented');
    expect(prevented).toHaveLength(1);
    expect(prevented[0]).toMatchObject({
      instanceId: target.instanceId,
      playerId: opponentId,
      abilityId: null,
      energySpent: 0,
    });

    // Used up: the Ready Step after that readies it as normal.
    const nextCycle = endTurn(endTurn(theirTurn));
    expect(nextCycle.activePlayerId).toBe(opponentId);
    expect(instanceIn(nextCycle, target.instanceId).exhausted).toBe(false);
  });

  it('is shed when the Unit leaves the battlefield', () => {
    const { state, playerId, opponentId } = board();
    const target = deployUnit(state, opponentId, 'goblin_scout');
    const sealed = answer(play(target.state, playerId, 'stasis_seal'), [target.instanceId]);

    // `forced_recall` returns Exhausted units, which the seal has just made this
    // one, so the same card that sealed it supplies the way out.
    const bounced = play(sealed, playerId, 'forced_recall');
    const returned = bounced.pendingChoice ? answer(bounced, [target.instanceId]) : bounced;

    expect(instanceIn(returned, target.instanceId).zone).not.toBe('battlefield');
    expect(instanceIn(returned, target.instanceId).readySkip).toBeNull();
  });
});

describe('Stasis Keeper — sealing what it blocks', () => {
  it('locks the attacker it blocked, and the lock survives the Keeper dying', () => {
    const { state, playerId, opponentId } = board();
    // The attacker belongs to the active player; the Keeper blocks it.
    const attacker = deployUnit(state, playerId, 'stitched_abomination');
    const keeper = deployUnit(attacker.state, opponentId, 'stasis_keeper');

    const declared = apply(
      forcePhase(keeper.state, 'declare_attackers'),
      {
        type: 'declare_attackers',
        playerId,
        attacks: attacksOnOpponent(keeper.state, [attacker.instanceId]),
      },
      context,
    );
    const blocked = apply(
      declared,
      {
        type: 'assign_blockers',
        playerId: opponentId,
        blocks: [{ attackerInstanceId: attacker.instanceId, blockerInstanceId: keeper.instanceId }],
      },
      context,
    );

    expect(instanceIn(blocked, attacker.instanceId).readySkip).not.toBeNull();
    // A 7/7 Abomination kills a 2/4 Keeper outright: the lock was fixed onto the
    // attacker when blockers were declared and does not depend on the Keeper.
    expect(instanceIn(blocked, keeper.instanceId).zone).not.toBe('battlefield');

    // The attacker was exhausted by attacking, and stays that way through its
    // controller's next Ready Step.
    const backToAttacker = endTurn(endTurn(blocked));
    expect(backToAttacker.activePlayerId).toBe(playerId);
    expect(instanceIn(backToAttacker, attacker.instanceId).exhausted).toBe(true);
  });

  it('does nothing when it is not blocking', () => {
    const { state, playerId, opponentId } = board();
    const attacker = deployUnit(state, playerId, 'goblin_scout');
    const keeper = deployUnit(attacker.state, opponentId, 'stasis_keeper');

    const declared = apply(
      forcePhase(keeper.state, 'declare_attackers'),
      {
        type: 'declare_attackers',
        playerId,
        attacks: attacksOnOpponent(keeper.state, [attacker.instanceId]),
      },
      context,
    );
    const unblocked = apply(
      declared,
      { type: 'assign_blockers', playerId: opponentId, blocks: [] },
      context,
    );

    expect(instanceIn(unblocked, attacker.instanceId).readySkip).toBeNull();
    expect(eventsOfType(unblocked, 'ready_skip_applied')).toEqual([]);
  });
});

describe('Temporal Anchor — an interactive readiness replacement', () => {
  /** Sets up an Anchor for `playerId` and an exhausted enemy unit, then ends the turn. */
  function anchored(): {
    state: MatchState;
    anchorPlayerId: PlayerId;
    readyingPlayerId: PlayerId;
    unitId: InstanceId;
    anchorId: InstanceId;
  } {
    const { state, playerId, opponentId } = board();
    const anchor = deployRelic(state, playerId, 'temporal_anchor');
    const unit = deployUnit(anchor.state, opponentId, 'goblin_scout', { exhausted: true });
    return {
      state: setEnergy(unit.state, playerId, 3),
      anchorPlayerId: playerId,
      readyingPlayerId: opponentId,
      unitId: unit.instanceId,
      anchorId: anchor.instanceId,
    };
  }

  it('asks the Anchor’s controller at the other seat’s Ready Step, and holds the named Unit down', () => {
    const setup = anchored();
    const asked = endTurn(setup.state);

    const choice = pendingChoice(asked);
    expect(choice.playerId).toBe(setup.anchorPlayerId);
    expect(choice.reason).toBe('keep_exhausted');
    expect(choice.minimum).toBe(0);
    expect(choice.maximum).toBe(1);
    expect(choice.validEntityIds).toContain(setup.unitId);
    expect(choice.sourceInstanceId).toBe(setup.anchorId);
    // Turn start has not finished: nothing has readied and the turn has not
    // been announced yet.
    expect(instanceIn(asked, setup.unitId).exhausted).toBe(true);

    const paid = answer(asked, [setup.unitId]);
    expect(instanceIn(paid, setup.unitId).exhausted).toBe(true);
    expect(playerOf(paid, setup.anchorPlayerId).energy).toBe(2);
    expect(eventsOfType(paid, 'ready_prevented')[0]).toMatchObject({
      instanceId: setup.unitId,
      sourceInstanceId: setup.anchorId,
      abilityId: 'temporal_drag',
      energySpent: 1,
    });
    // Turn start finished: the readying player has their Energy and their turn.
    expect(paid.phase).not.toBe('turn_start');
    expect(eventsOfType(paid, 'turn_started').at(-1)?.playerId).toBe(setup.readyingPlayerId);
  });

  it('declining readies the Unit and spends nothing', () => {
    const setup = anchored();
    const declined = answer(endTurn(setup.state), []);

    expect(instanceIn(declined, setup.unitId).exhausted).toBe(false);
    expect(playerOf(declined, setup.anchorPlayerId).energy).toBe(3);
    expect(eventsOfType(declined, 'ready_prevented')).toEqual([]);
  });

  it('never asks a controller who cannot pay', () => {
    const setup = anchored();
    const broke = setEnergy(setup.state, setup.anchorPlayerId, 0);
    const started = endTurn(broke);

    expect(started.pendingChoice).toBeNull();
    expect(instanceIn(started, setup.unitId).exhausted).toBe(false);
  });

  it('asks once each turn, not once per Unit', () => {
    const setup = anchored();
    const second = deployUnit(setup.state, setup.readyingPlayerId, 'goblin_scout', {
      exhausted: true,
    });
    const paid = answer(endTurn(second.state), [setup.unitId]);

    expect(paid.pendingChoice).toBeNull();
    expect(instanceIn(paid, setup.unitId).exhausted).toBe(true);
    expect(instanceIn(paid, second.instanceId).exhausted).toBe(false);
  });

  it('is not offered a Unit a free prevention is already holding down', () => {
    const setup = anchored();
    // Seal the only exhausted enemy Unit, so the Anchor has nothing left worth
    // paying for: the stored prevention is applied first, deliberately.
    const sealed = answer(play(setup.state, setup.anchorPlayerId, 'stasis_seal'), [setup.unitId]);
    // Refunded to the same three Energy the other cases start with, so the
    // assertion below is about the Anchor never being offered rather than about
    // what the Seal cost.
    const started = endTurn(setEnergy(sealed, setup.anchorPlayerId, 3));

    expect(started.pendingChoice).toBeNull();
    expect(instanceIn(started, setup.unitId).exhausted).toBe(true);
    expect(playerOf(started, setup.anchorPlayerId).energy).toBe(3);
    expect(eventsOfType(started, 'ready_prevented')).toHaveLength(1);
    expect(eventsOfType(started, 'ready_prevented')[0]?.abilityId).toBeNull();
  });

  it('survives a serialisation round trip while it is paused', () => {
    const setup = anchored();
    const asked = endTurn(setup.state);
    // A paused Ready Step is ordinary match state: nothing about the offer lives
    // outside `pendingChoice`, so a reconnecting seat resumes it unchanged.
    const restored = matchStateSchema.parse(JSON.parse(JSON.stringify(asked)));

    const paid = answer(restored, [setup.unitId]);
    expect(instanceIn(paid, setup.unitId).exhausted).toBe(true);
    expect(playerOf(paid, setup.anchorPlayerId).energy).toBe(2);
  });
});
