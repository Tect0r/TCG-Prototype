import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES_CONFIG } from './config.js';
import { opponentOf } from './derive.js';
import { legalActions } from './legal-actions.js';
import { playerView } from './view.js';
import {
  apply,
  attacksOnOpponent,
  deployUnit,
  eventsOfType,
  expectRejected,
  forcePhase,
  instanceIn,
  keepAllHands,
  keepBothHands,
  startMatch,
  startTable,
  testContext,
  testDatabase,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';

/**
 * A unit must be Ready to block, and declaring it as a blocker Exhausts it
 * (ruleset update §8/§9).
 *
 * This replaces the earlier provisional rule that exhausted units may block.
 * The engine used to allow it and nothing pinned either half, so these tests
 * exist as much to stop the old behaviour drifting back as to prove the new one.
 */

const database = testDatabase();
const context = testContext();

/** Two seats, opening hands kept, one attacker declared and awaiting blockers. */
function combat(options: { readonly blockers: readonly { exhausted?: boolean }[] }): {
  state: MatchState;
  attacker: string;
  attackerId: string;
  defender: string;
  blockerIds: string[];
} {
  let state = keepBothHands(startMatch());
  const attackerPlayer = state.activePlayerId;
  const defender = opponentOf(state, attackerPlayer);

  const swung = deployUnit(state, attackerPlayer, 'prototype_scout');
  state = swung.state;

  const blockerIds: string[] = [];
  for (const blocker of options.blockers) {
    const placed = deployUnit(state, defender, 'prototype_guard', {
      ...(blocker.exhausted ? { exhausted: true } : {}),
    });
    state = placed.state;
    blockerIds.push(placed.instanceId);
  }

  state = apply(
    forcePhase(state, 'declare_attackers'),
    {
      type: 'declare_attackers',
      playerId: attackerPlayer,
      attacks: attacksOnOpponent(state, [swung.instanceId]),
    },
    context,
  );

  return {
    state,
    attacker: attackerPlayer,
    attackerId: swung.instanceId,
    defender,
    blockerIds,
  };
}

describe('a blocker must be ready', () => {
  it('is the configured default', () => {
    expect(DEFAULT_RULES_CONFIG.exhaustedUnitsMayBlock).toBe(false);
  });

  it('rejects an exhausted unit declared as a blocker', () => {
    const setup = combat({ blockers: [{ exhausted: true }] });

    const error = expectRejected(
      setup.state,
      {
        type: 'assign_blockers',
        playerId: setup.defender,
        blocks: [
          {
            attackerInstanceId: setup.attackerId,
            blockerInstanceId: setup.blockerIds[0] as string,
          },
        ],
      },
      context,
    );
    expect(error.code).toBe('engine/illegal_blocker');
    expect(error.message).toMatch(/exhausted/i);
  });

  it('does not even offer an exhausted unit as a legal blocker', () => {
    const setup = combat({ blockers: [{ exhausted: true }, {}] });
    const legal = legalActions(setup.state, setup.defender, { database });

    expect(legal.blocking?.blockerInstanceIds).toEqual([setup.blockerIds[1]]);
  });

  it('accepts an exhausted blocker when the format allows it', () => {
    // The dial is still a dial: the *rule* is data, and turning defence back on
    // has to keep working so a playtest can measure it.
    const config = { ...DEFAULT_RULES_CONFIG, exhaustedUnitsMayBlock: true };
    const setup = combat({ blockers: [{ exhausted: true }] });

    const after = apply(
      setup.state,
      {
        type: 'assign_blockers',
        playerId: setup.defender,
        blocks: [
          {
            attackerInstanceId: setup.attackerId,
            blockerInstanceId: setup.blockerIds[0] as string,
          },
        ],
      },
      { database, config },
    );
    expect(after.combat.blocks).toHaveLength(1);
  });
});

describe('declaring a blocker exhausts it', () => {
  it('exhausts the blocker, and it still deals its combat damage', () => {
    const setup = combat({ blockers: [{}] });
    const blockerId = setup.blockerIds[0] as string;
    expect(instanceIn(setup.state, blockerId).exhausted).toBe(false);

    const after = apply(
      setup.state,
      {
        type: 'assign_blockers',
        playerId: setup.defender,
        blocks: [{ attackerInstanceId: setup.attackerId, blockerInstanceId: blockerId }],
      },
      context,
    );

    // `prototype_guard` survives `prototype_scout`, so it is still around to
    // inspect — and it is exhausted.
    expect(instanceIn(after, blockerId).exhausted).toBe(true);
    expect(
      eventsOfType(after, 'unit_exhausted').filter((event) => event.instanceId === blockerId),
    ).toHaveLength(1);
    // Exhaustion does not mute the blocker: the attacker took its damage.
    expect(instanceIn(after, setup.attackerId).markedDamage).toBeGreaterThan(0);
  });

  it('leaves the blocker unable to block again on the next turn cycle', () => {
    const setup = combat({ blockers: [{}] });
    const blockerId = setup.blockerIds[0] as string;

    const blocked = apply(
      setup.state,
      {
        type: 'assign_blockers',
        playerId: setup.defender,
        blocks: [{ attackerInstanceId: setup.attackerId, blockerInstanceId: blockerId }],
      },
      context,
    );

    // Still the attacker's turn: the defender's units do not ready until their
    // own Ready Step, so a second attack this turn cycle finds nothing ready.
    expect(instanceIn(blocked, blockerId).exhausted).toBe(true);
    const legal = legalActions(forcePhase(blocked, 'assign_blockers'), setup.defender, {
      database,
    });
    expect(legal.blocking?.blockerInstanceIds ?? []).not.toContain(blockerId);
  });
});

describe('hidden information survives the exhaustion', () => {
  it('does not reveal one defender’s blockers to another before everyone answers', () => {
    // Three seats: two defenders answer independently. Exhausting on submission
    // rather than on publication would let the attacker — and the other
    // defender — read the first submission straight off the board.
    let state = keepAllHands(startTable(3), context);
    const attackerPlayer = state.activePlayerId;
    const [defenderA, defenderB] = state.seatOrder.filter((id) => id !== attackerPlayer);

    const first = deployUnit(state, attackerPlayer, 'prototype_scout');
    const second = deployUnit(first.state, attackerPlayer, 'prototype_scout');
    state = second.state;
    const blockA = deployUnit(state, defenderA as string, 'prototype_guard');
    state = blockA.state;
    const blockB = deployUnit(state, defenderB as string, 'prototype_guard');
    state = blockB.state;

    state = apply(
      forcePhase(state, 'declare_attackers'),
      {
        type: 'declare_attackers',
        playerId: attackerPlayer,
        attacks: [
          { attackerInstanceId: first.instanceId, defenderPlayerId: defenderA as string },
          { attackerInstanceId: second.instanceId, defenderPlayerId: defenderB as string },
        ],
      },
      context,
    );

    const afterFirst = apply(
      state,
      {
        type: 'assign_blockers',
        playerId: defenderA as string,
        blocks: [{ attackerInstanceId: first.instanceId, blockerInstanceId: blockA.instanceId }],
      },
      context,
    );

    // Defender A has committed, but B has not — so nothing about A's choice is
    // visible on the board to anyone, including A's own units' readiness.
    expect(afterFirst.combat.blocks).toHaveLength(0);
    for (const viewerId of [attackerPlayer, defenderB as string]) {
      const view = playerView(afterFirst, viewerId, database);
      expect(view.instances[blockA.instanceId]?.exhausted).toBe(false);
      expect(view.combat.submissions).toHaveLength(0);
    }

    const afterBoth = apply(
      afterFirst,
      {
        type: 'assign_blockers',
        playerId: defenderB as string,
        blocks: [{ attackerInstanceId: second.instanceId, blockerInstanceId: blockB.instanceId }],
      },
      context,
    );

    // Now that everyone has answered, both blockers are public and both spent.
    expect(instanceIn(afterBoth, blockA.instanceId).exhausted).toBe(true);
    expect(instanceIn(afterBoth, blockB.instanceId).exhausted).toBe(true);
  });
});
