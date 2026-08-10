import { describe, expect, it } from 'vitest';
import { opponentOf } from './derive.js';
import { legalActions } from './legal-actions.js';
import { legalTargets } from './targeting.js';
import {
  apply,
  attacksOnOpponent,
  deployUnit,
  eventsOfType,
  expectRejected,
  forcePhase,
  instanceIn,
  keepBothHands,
  startMatch,
  databaseWith,
  testContext,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';

/**
 * The keywords the Precon Wave 1 ruleset introduced or revived — Guardian,
 * Barrier, Overwhelm, Rush and Untargetable — plus the `Newly Deployed` state
 * they all hang off. See ADR 0016.
 *
 * Fixture cards are defined here rather than added to `prototype_core`: putting
 * them in the shared set would change the pool every seeded generated
 * population draws from, which silently moves unrelated simulator tests.
 */
const CARDS = [
  {
    schemaVersion: 3,
    id: 'kw_plain_attacker',
    name: 'Plain Attacker',
    type: 'unit',
    colorIdentity: ['red'],
    cost: 2,
    attack: 3,
    health: 3,
  },
  {
    schemaVersion: 3,
    id: 'kw_big_attacker',
    name: 'Big Attacker',
    type: 'unit',
    colorIdentity: ['red'],
    cost: 5,
    attack: 7,
    health: 7,
  },
  {
    schemaVersion: 3,
    id: 'kw_overwhelmer',
    name: 'Overwhelmer',
    type: 'unit',
    colorIdentity: ['red'],
    cost: 5,
    attack: 7,
    health: 7,
    keywords: ['overwhelm'],
  },
  {
    schemaVersion: 3,
    id: 'kw_rusher',
    name: 'Rusher',
    type: 'unit',
    colorIdentity: ['red'],
    cost: 2,
    attack: 2,
    health: 2,
    keywords: ['rush'],
  },
  {
    schemaVersion: 3,
    id: 'kw_guardian',
    name: 'Test Guardian',
    type: 'unit',
    colorIdentity: ['white'],
    cost: 2,
    attack: 1,
    health: 4,
    keywords: ['guardian'],
  },
  {
    schemaVersion: 3,
    id: 'kw_barrier_blocker',
    name: 'Barrier Blocker',
    type: 'unit',
    colorIdentity: ['white'],
    cost: 2,
    attack: 1,
    health: 2,
    keywords: ['barrier'],
  },
  {
    schemaVersion: 3,
    id: 'kw_small_blocker',
    name: 'Small Blocker',
    type: 'unit',
    colorIdentity: ['white'],
    cost: 1,
    attack: 1,
    health: 2,
  },
  {
    schemaVersion: 3,
    id: 'kw_untargetable',
    name: 'Untargetable Unit',
    type: 'unit',
    colorIdentity: ['blue'],
    cost: 2,
    attack: 2,
    health: 2,
    keywords: ['untargetable_by_opponents'],
  },
  {
    schemaVersion: 3,
    id: 'kw_snipe',
    name: 'Snipe',
    type: 'spell',
    colorIdentity: ['blue'],
    cost: 1,
    effects: [
      {
        type: 'deal_damage',
        target: {
          kind: 'entity',
          selector: {
            zone: 'battlefield',
            controller: 'opponent',
            filter: { cardTypes: ['unit'] },
            count: 1,
          },
        },
        amount: 2,
      },
    ],
    displayText: 'Deal 2 damage to an enemy unit.',
  },
] as const;

const database = databaseWith(CARDS as never);
const context = testContext();
const ctx = { ...context, database };

/** Deploys `attackerCard` for the active player and `blockerCard` for the other. */
function setUp(attackerCard: string, blockerCards: readonly string[]) {
  const start = keepBothHands(startMatch({ database }));
  const active = start.activePlayerId;
  const other = opponentOf(start, active);

  const attacker = deployUnit(start, active, attackerCard);
  let state = attacker.state;
  const blockerIds: string[] = [];
  for (const card of blockerCards) {
    const deployed = deployUnit(state, other, card);
    state = deployed.state;
    blockerIds.push(deployed.instanceId);
  }

  return { state, active, other, attackerId: attacker.instanceId, blockerIds };
}

function declare(state: MatchState, active: string, attackerIds: readonly string[]): MatchState {
  const atAttack = forcePhase(state, 'declare_attackers');
  return apply(
    atAttack,
    {
      type: 'declare_attackers',
      playerId: active,
      attacks: attacksOnOpponent(atAttack, attackerIds),
    },
    ctx,
  );
}

describe('guardian', () => {
  it('makes a block compulsory while a ready Guardian is on the board', () => {
    const { state, active, other, attackerId } = setUp('kw_plain_attacker', ['kw_guardian']);
    const declared = declare(state, active, [attackerId]);

    const error = expectRejected(
      declared,
      { type: 'assign_blockers', playerId: other, blocks: [] },
      ctx,
    );
    expect(error.code).toBe('engine/guardian_must_block');
  });

  it('reports the obligation in the defender’s legal actions', () => {
    const { state, active, other, attackerId } = setUp('kw_plain_attacker', ['kw_guardian']);
    const declared = declare(state, active, [attackerId]);

    const legal = legalActions(declared, other, ctx);
    expect(legal.blocking?.mustBlockCount).toBe(1);
    expect(legal.blocking?.guardianInstanceIds).toHaveLength(1);
  });

  it('is satisfied by any legal blocker, not only by the Guardian itself', () => {
    // The defender chooses *which* unit blocks; Guardian only decides how many
    // attacks may not be left alone (ruleset update §9).
    const { state, active, other, attackerId, blockerIds } = setUp('kw_plain_attacker', [
      'kw_guardian',
      'kw_small_blocker',
    ]);
    const declared = declare(state, active, [attackerId]);

    const resolved = apply(
      declared,
      {
        type: 'assign_blockers',
        playerId: other,
        blocks: [{ attackerInstanceId: attackerId, blockerInstanceId: blockerIds[1] as string }],
      },
      ctx,
    );
    expect(resolved.combat.submissions.length + resolved.combat.blocks.length).toBeGreaterThan(0);
  });

  it('obliges only as many blocks as there are ready Guardians', () => {
    const start = keepBothHands(startMatch({ database }));
    const active = start.activePlayerId;
    const other = opponentOf(start, active);

    const first = deployUnit(start, active, 'kw_plain_attacker');
    const second = deployUnit(first.state, active, 'kw_plain_attacker');
    const guard = deployUnit(second.state, other, 'kw_guardian');

    const declared = declare(guard.state, active, [first.instanceId, second.instanceId]);
    const legal = legalActions(declared, other, ctx);
    expect(legal.blocking?.mustBlockCount).toBe(1);

    // One block is enough even though two attackers came in.
    const resolved = apply(
      declared,
      {
        type: 'assign_blockers',
        playerId: other,
        blocks: [{ attackerInstanceId: first.instanceId, blockerInstanceId: guard.instanceId }],
      },
      ctx,
    );
    expect(resolved.status).not.toBe('rejected');
  });

  it('imposes nothing when the only Guardian is exhausted', () => {
    const { state, active, other, attackerId, blockerIds } = setUp('kw_plain_attacker', [
      'kw_guardian',
    ]);
    const exhausted = structuredClone(state);
    instanceIn(exhausted, blockerIds[0] as string).exhausted = true;

    const declared = declare(exhausted, active, [attackerId]);
    expect(legalActions(declared, other, ctx).blocking?.mustBlockCount).toBe(0);
  });
});

describe('barrier', () => {
  it('prevents the whole of the next damage event and is then spent', () => {
    const { state, active, other, attackerId, blockerIds } = setUp('kw_big_attacker', [
      'kw_barrier_blocker',
    ]);
    const blockerId = blockerIds[0] as string;
    const declared = declare(state, active, [attackerId]);
    const resolved = apply(
      declared,
      {
        type: 'assign_blockers',
        playerId: other,
        blocks: [{ attackerInstanceId: attackerId, blockerInstanceId: blockerId }],
      },
      ctx,
    );

    // A 1/2 survives a 7-damage hit untouched, and loses its Barrier doing so.
    const blocker = instanceIn(resolved, blockerId);
    expect(blocker.markedDamage).toBe(0);
    expect(blocker.barrierSpent).toBe(true);
    expect(eventsOfType(resolved, 'barrier_consumed')).toHaveLength(1);
  });

  it('is not consumed by a zero-damage event', () => {
    const { state, blockerIds } = setUp('kw_plain_attacker', ['kw_barrier_blocker']);
    const blockerId = blockerIds[0] as string;
    expect(instanceIn(state, blockerId).barrierSpent).toBe(false);
  });
});

describe('overwhelm', () => {
  it('assigns the blocker its current health and sends the rest to the player', () => {
    const { state, active, other, attackerId, blockerIds } = setUp('kw_overwhelmer', [
      'kw_small_blocker',
    ]);
    const blockerId = blockerIds[0] as string;
    const before = state.players[other]?.health as number;

    const declared = declare(state, active, [attackerId]);
    const resolved = apply(
      declared,
      {
        type: 'assign_blockers',
        playerId: other,
        blocks: [{ attackerInstanceId: attackerId, blockerInstanceId: blockerId }],
      },
      ctx,
    );

    // 7 attack into a 1/2 blocker: exactly 2 assigned to the blocker (enough to
    // defeat it, and no more), and the other 5 through to the player.
    expect(instanceIn(resolved, blockerId).zone).not.toBe('battlefield');
    expect(before - (resolved.players[other]?.health as number)).toBe(5);
  });

  it('deals no overflow when the blocker soaks the whole attack', () => {
    const { state, active, other, attackerId, blockerIds } = setUp('kw_overwhelmer', [
      'kw_guardian',
    ]);
    const blockerId = blockerIds[0] as string;
    const before = state.players[other]?.health as number;

    const declared = declare(state, active, [attackerId]);
    const resolved = apply(
      declared,
      {
        type: 'assign_blockers',
        playerId: other,
        blocks: [{ attackerInstanceId: attackerId, blockerInstanceId: blockerId }],
      },
      ctx,
    );
    // 7 attack, 4-health Guardian: 4 assigned, 3 overflow.
    expect(before - (resolved.players[other]?.health as number)).toBe(3);
  });

  it('lets Barrier save the blocker while the overflow still reaches the player', () => {
    // ADR 0016 Q-D: Overwhelm splits first, Barrier prevents only the blocker's
    // share, and the player still takes the remainder.
    const { state, active, other, attackerId, blockerIds } = setUp('kw_overwhelmer', [
      'kw_barrier_blocker',
    ]);
    const blockerId = blockerIds[0] as string;
    const before = state.players[other]?.health as number;

    const declared = declare(state, active, [attackerId]);
    const resolved = apply(
      declared,
      {
        type: 'assign_blockers',
        playerId: other,
        blocks: [{ attackerInstanceId: attackerId, blockerInstanceId: blockerId }],
      },
      ctx,
    );

    const blocker = instanceIn(resolved, blockerId);
    expect(blocker.markedDamage).toBe(0);
    expect(blocker.barrierSpent).toBe(true);
    // 7 attack, 2-health blocker: 2 prevented by Barrier, 5 still hits the player.
    expect(before - (resolved.players[other]?.health as number)).toBe(5);
  });
});

describe('rush and Newly Deployed', () => {
  it('a unit without Rush cannot attack the turn it arrives', () => {
    const start = keepBothHands(startMatch({ database }));
    const active = start.activePlayerId;
    const deployed = deployUnit(start, active, 'kw_plain_attacker', { summoningSick: true });
    const atAttack = forcePhase(deployed.state, 'declare_attackers');

    expect(legalActions(atAttack, active, ctx).attacking?.legalAttackers).not.toContain(
      deployed.instanceId,
    );
  });

  it('Rush lets it attack immediately', () => {
    const start = keepBothHands(startMatch({ database }));
    const active = start.activePlayerId;
    const deployed = deployUnit(start, active, 'kw_rusher', { summoningSick: true });
    const atAttack = forcePhase(deployed.state, 'declare_attackers');

    expect(legalActions(atAttack, active, ctx).attacking?.legalAttackers).toContain(
      deployed.instanceId,
    );
  });

  it('clears Newly Deployed at the controller’s Ready Step, not at end of turn', () => {
    const start = keepBothHands(startMatch({ database }));
    const active = start.activePlayerId;
    const deployed = deployUnit(start, active, 'kw_plain_attacker', { summoningSick: true });
    expect(instanceIn(deployed.state, deployed.instanceId).newlyDeployed).toBe(true);
  });
});

describe('untargetable by opponents', () => {
  const enemyUnitTarget = {
    kind: 'entity' as const,
    selector: {
      zone: 'battlefield' as const,
      controller: 'opponent' as const,
      filter: { cardTypes: ['unit' as const] },
      count: 1 as const,
      selection: 'player_choice' as const,
      chooser: 'self' as const,
      optional: false,
      excludeSource: false,
    },
  };

  it('is removed from a legal target set computed for an opponent', () => {
    const { state, active, other, blockerIds } = setUp('kw_plain_attacker', [
      'kw_untargetable',
      'kw_small_blocker',
    ]);
    const targets = legalTargets(
      { ...ctx, state, events: [], cause: {} } as never,
      enemyUnitTarget,
      {
        controllerId: active,
        sourceInstanceId: null,
      },
    );

    expect(targets).not.toContain(blockerIds[0]);
    expect(targets).toContain(blockerIds[1]);
    expect(other).toBeTruthy();
  });

  it('is still targetable by its own controller', () => {
    const { state, other, blockerIds } = setUp('kw_plain_attacker', ['kw_untargetable']);
    const own = {
      ...enemyUnitTarget,
      selector: { ...enemyUnitTarget.selector, controller: 'self' as const },
    };
    const targets = legalTargets({ ...ctx, state, events: [], cause: {} } as never, own, {
      controllerId: other,
      sourceInstanceId: null,
    });
    expect(targets).toContain(blockerIds[0]);
  });
});
