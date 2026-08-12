import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES_CONFIG } from './config.js';
import { playerOf } from './derive.js';
import { legalActions } from './legal-actions.js';
import { playerView } from './view.js';
import {
  apply,
  deployUnit,
  eventsOfType,
  expectRejected,
  giveCard,
  giveDiscard,
  instanceIn,
  keepBothHands,
  setEnergy,
  startMatch,
  testContext,
  testDatabase,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';
import type { InstanceId } from './schema/primitives.js';

/**
 * M02.2 — the two zone transitions `precon_wave_1` prints.
 *
 * `corpse_stitcher` sends a card from a discard pile out of the game, and
 * `grave_reassembly` brings cards the other way, from a discard pile onto the
 * battlefield. Both are exercised through the shipped cards rather than through
 * test-only definitions: the point of the tranche is that these two cards work,
 * and a fixture card would prove something about the primitive while leaving the
 * authored data untested.
 */

const context = testContext(DEFAULT_RULES_CONFIG);

/** A two-seat match in the active player's first Main Phase, with energy. */
function board(): { state: MatchState; playerId: string } {
  const start = keepBothHands(startMatch(), context);
  const playerId = start.activePlayerId;
  return { state: setEnergy(start, playerId, 9), playerId };
}

function pendingChoice(state: MatchState) {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('Expected a pending choice');
  return choice;
}

function answer(state: MatchState, playerId: string, selectedIds: readonly InstanceId[]) {
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

/** Tokens on a player's battlefield, by definition. */
function tokensOf(state: MatchState, playerId: string, definitionId: string): InstanceId[] {
  return playerOf(state, playerId).units.filter(
    (instanceId) => instanceIn(state, instanceId).definitionId === definitionId,
  );
}

describe('removing a card from the game', () => {
  it('takes a chosen Unit card out of the discard pile for good and creates two Thralls', () => {
    const { state, playerId } = board();
    const stitcher = deployUnit(state, playerId, 'corpse_stitcher');
    const buried = giveDiscard(stitcher.state, playerId, 'prototype_drone');
    const energyBefore = playerOf(buried.state, playerId).energy;

    const asked = apply(
      buried.state,
      {
        type: 'activate_ability',
        playerId,
        sourceInstanceId: stitcher.instanceId,
        abilityId: 'stitch',
      },
      context,
    );

    const choice = pendingChoice(asked);
    expect(choice.type).toBe('select_cards');
    expect(choice.zone).toBe('discard');
    expect(choice.validEntityIds).toEqual([buried.instanceId]);

    const done = answer(asked, playerId, [buried.instanceId]);
    const seat = playerOf(done, playerId);

    expect(instanceIn(done, buried.instanceId).zone).toBe('removed');
    expect(seat.discard).not.toContain(buried.instanceId);
    expect(seat.removed).toContain(buried.instanceId);
    expect(tokensOf(done, playerId, 'thrall_token')).toHaveLength(2);
    // The Exhaust half of the cost, and the Energy half.
    expect(instanceIn(done, stitcher.instanceId).exhausted).toBe(true);
    expect(seat.energy).toBe(energyBefore - 1);
  });

  it('reports the removal as a move to the terminal zone', () => {
    const { state, playerId } = board();
    const stitcher = deployUnit(state, playerId, 'corpse_stitcher');
    const buried = giveDiscard(stitcher.state, playerId, 'prototype_drone');

    const done = answer(
      apply(
        buried.state,
        {
          type: 'activate_ability',
          playerId,
          sourceInstanceId: stitcher.instanceId,
          abilityId: 'stitch',
        },
        context,
      ),
      playerId,
      [buried.instanceId],
    );

    const moved = eventsOfType(done, 'card_moved').find(
      (event) => event.instanceId === buried.instanceId,
    );
    expect(moved?.fromZone).toBe('discard');
    expect(moved?.toZone).toBe('removed');
  });

  it('leaves a removed card unreachable by anything that reads the discard pile', () => {
    const { state, playerId } = board();
    const stitcher = deployUnit(state, playerId, 'corpse_stitcher');
    const buried = giveDiscard(stitcher.state, playerId, 'prototype_drone');
    const removed = answer(
      apply(
        buried.state,
        {
          type: 'activate_ability',
          playerId,
          sourceInstanceId: stitcher.instanceId,
          abilityId: 'stitch',
        },
        context,
      ),
      playerId,
      [buried.instanceId],
    );

    // The revival spell can still be *played* — "up to two" resolves with
    // nothing — but the removed card is not among the cards it may return.
    const spell = giveCard(removed, playerId, 'grave_reassembly');
    const cast = apply(
      spell.state,
      { type: 'play_card', playerId, instanceId: spell.instanceId },
      context,
    );
    expect(cast.pendingChoice).toBeNull();
    expect(instanceIn(cast, buried.instanceId).zone).toBe('removed');
  });

  it('only offers Unit cards, and still creates the Thralls when there are none', () => {
    const { state, playerId } = board();
    const stitcher = deployUnit(state, playerId, 'corpse_stitcher');
    // A spell in the discard pile is not a legal choice for "a Unit card".
    const spell = giveDiscard(stitcher.state, playerId, 'grave_reassembly');

    const done = apply(
      spell.state,
      {
        type: 'activate_ability',
        playerId,
        sourceInstanceId: stitcher.instanceId,
        abilityId: 'stitch',
      },
      context,
    );

    expect(done.pendingChoice).toBeNull();
    expect(instanceIn(done, spell.instanceId).zone).toBe('discard');
    // The removal found no target; the second instruction is not skipped with
    // it, because a fizzled instruction does not stop the ones after it.
    expect(
      eventsOfType(done, 'effect_fizzled').map((event) => `${event.effectType}:${event.reason}`),
    ).toEqual(['move_card:no_legal_target']);
    expect(tokensOf(done, playerId, 'thrall_token')).toHaveLength(2);
  });

  it('counts removed cards in every seat’s view without naming them', () => {
    const { state, playerId } = board();
    const stitcher = deployUnit(state, playerId, 'corpse_stitcher');
    const buried = giveDiscard(stitcher.state, playerId, 'prototype_drone');
    const done = answer(
      apply(
        buried.state,
        {
          type: 'activate_ability',
          playerId,
          sourceInstanceId: stitcher.instanceId,
          abilityId: 'stitch',
        },
        context,
      ),
      playerId,
      [buried.instanceId],
    );

    for (const viewerId of done.seatOrder) {
      const view = playerView(done, viewerId, testDatabase());
      const seat = view.players.find((entry) => entry.playerId === playerId);
      expect(seat?.removedCount).toBe(1);
      expect(seat?.discard).not.toContain(buried.instanceId);
      // Terminal means terminal: the card is not identified to anybody.
      expect(view.instances[buried.instanceId]).toBeUndefined();
    }
  });
});

describe('returning Units from the discard pile to the battlefield', () => {
  /** The revival spell in hand, with two cheap Units and one expensive one buried. */
  function withGraveyard(): {
    state: MatchState;
    playerId: string;
    spellId: InstanceId;
    cheap: InstanceId[];
    expensive: InstanceId;
  } {
    const { state, playerId } = board();
    const first = giveDiscard(state, playerId, 'prototype_drone');
    const second = giveDiscard(first.state, playerId, 'ashen_vermin');
    const expensive = giveDiscard(second.state, playerId, 'corpse_wagon');
    const spell = giveCard(expensive.state, playerId, 'grave_reassembly');
    return {
      state: spell.state,
      playerId,
      spellId: spell.instanceId,
      cheap: [first.instanceId, second.instanceId],
      expensive: expensive.instanceId,
    };
  }

  it('offers only Units costing 3 or less, and lets the controller take fewer', () => {
    const { state, playerId, spellId, cheap, expensive } = withGraveyard();
    const cast = apply(state, { type: 'play_card', playerId, instanceId: spellId }, context);

    const choice = pendingChoice(cast);
    expect(choice.zone).toBe('discard');
    expect([...choice.validEntityIds].sort()).toEqual([...cheap].sort());
    expect(choice.validEntityIds).not.toContain(expensive);
    // "Up to two": the floor is nothing at all.
    expect(choice.minimum).toBe(0);
    expect(choice.maximum).toBe(2);

    const one = answer(cast, playerId, [cheap[0] as InstanceId]);
    expect(instanceIn(one, cheap[0] as InstanceId).zone).toBe('battlefield');
    expect(instanceIn(one, cheap[1] as InstanceId).zone).toBe('discard');
  });

  it('puts them onto the battlefield Exhausted and Newly Deployed', () => {
    const { state, playerId, spellId, cheap } = withGraveyard();
    const done = answer(
      apply(state, { type: 'play_card', playerId, instanceId: spellId }, context),
      playerId,
      cheap,
    );

    for (const instanceId of cheap) {
      const instance = instanceIn(done, instanceId);
      expect(instance.zone).toBe('battlefield');
      expect(instance.exhausted).toBe(true);
      expect(instance.newlyDeployed).toBe(true);
      expect(playerOf(done, playerId).units).toContain(instanceId);
    }
  });

  it('is an entry, not a deployment', () => {
    const { state, playerId, spellId, cheap } = withGraveyard();
    const done = answer(
      apply(state, { type: 'play_card', playerId, instanceId: spellId }, context),
      playerId,
      cheap,
    );

    const entered = eventsOfType(done, 'unit_entered_battlefield').filter((event) =>
      cheap.includes(event.instanceId),
    );
    expect(entered).toHaveLength(2);
    expect(entered.every((event) => event.method === 'effect')).toBe(true);
    // Nobody paid a deployment cost, so nothing may report one (rule
    // adjustment §7).
    expect(
      eventsOfType(done, 'unit_deployed').filter((event) => cheap.includes(event.instanceId)),
    ).toHaveLength(0);
  });

  it('leaves the returned Units unable to attack or block this turn', () => {
    const { state, playerId, spellId, cheap } = withGraveyard();
    const done = answer(
      apply(state, { type: 'play_card', playerId, instanceId: spellId }, context),
      playerId,
      cheap,
    );

    const attackers = apply(done, { type: 'pass_phase', playerId }, context);
    const legal = legalActions(attackers, playerId, {
      database: testDatabase(),
      config: DEFAULT_RULES_CONFIG,
    });
    expect(legal.attacking).not.toBeNull();
    for (const instanceId of cheap) {
      expect(legal.attacking?.legalAttackers).not.toContain(instanceId);
    }
    expectRejected(
      attackers,
      {
        type: 'declare_attackers',
        playerId,
        attacks: [{ attackerInstanceId: cheap[0] as InstanceId, defenderPlayerId: 'player_2' }],
      },
      context,
    );
  });

  it('resolves harmlessly with an empty discard pile', () => {
    const { state, playerId } = board();
    const spell = giveCard(state, playerId, 'grave_reassembly');
    const energyBefore = playerOf(spell.state, playerId).energy;

    const done = apply(
      spell.state,
      { type: 'play_card', playerId, instanceId: spell.instanceId },
      context,
    );

    expect(done.pendingChoice).toBeNull();
    // The spell was still played and still paid for: an "up to" that finds
    // nothing is a resolved instruction, not a fizzle.
    expect(playerOf(done, playerId).energy).toBe(energyBefore - 5);
    expect(playerOf(done, playerId).discard).toContain(spell.instanceId);
  });
});
