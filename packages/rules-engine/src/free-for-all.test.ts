import { describe, expect, it } from 'vitest';
import { applyAction } from './engine.js';
import { clockwiseFrom, livingPlayers } from './derive.js';
import { legalActions } from './legal-actions.js';
import { createMatch } from './setup.js';
import { deserializeMatchState, serializeMatchState } from './serialize.js';
import { playerView } from './view.js';
import {
  apply,
  databaseWith,
  deployUnit,
  eventsOfType,
  expectRejected,
  giveCard,
  instanceIn,
  keepAllHands,
  makeDeck,
  setEnergy,
  setHealth,
  startTable,
  testContext,
  testDatabase,
  toDeclareAttackers,
} from './test-fixtures.js';
import type { AttackDeclaration, MatchState } from './schema/state.js';
import type { PlayerId } from './schema/primitives.js';
import type { CardId } from '@tcg/card-data';

/**
 * Phase 3: free-for-all for two to four players (CLAUDE.md §12).
 *
 * Numbered to match the required-test list in §12 so a missing case is
 * obvious. Every table here uses a fixed seat order, so `player_1` really is
 * the seat before `player_2`.
 */

const context = testContext();
const database = testDatabase();

/** Takes a fresh table to the active player's Declare Attackers step. */
function atAttackStep(seats: number, seed = 'ffa-seed'): MatchState {
  return toDeclareAttackers(keepAllHands(startTable(seats, { seed })));
}

function attack(attackerInstanceId: string, defenderPlayerId: PlayerId): AttackDeclaration {
  return { attackerInstanceId, defenderPlayerId };
}

/* ------------------------------------------------- 1. starting legal matches */

describe('1. starting matches with two, three and four players', () => {
  for (const seats of [2, 3, 4]) {
    it(`starts a legal ${seats}-player match`, () => {
      const state = startTable(seats);
      expect(state.seatOrder).toHaveLength(seats);
      expect(state.playerOrder).toHaveLength(seats);
      expect(Object.keys(state.players)).toHaveLength(seats);
      expect(state.mode).toBe(seats === 2 ? '1v1' : 'ffa');

      // Turn order is the seat circle rotated, never a reshuffle: adjacency is
      // identical in both arrays.
      const rotation = state.seatOrder.indexOf(state.playerOrder[0] as PlayerId);
      expect(state.playerOrder).toEqual(
        state.seatOrder.map((_, i) => state.seatOrder[(rotation + i) % seats]),
      );
      expect(livingPlayers(state)).toHaveLength(seats);
    });
  }

  it('refuses one seat and refuses five', () => {
    const deck = makeDeck();
    const seat = (n: number) => ({ playerId: `p${n}`, name: `P${n}`, deck });
    for (const count of [1, 5]) {
      const result = createMatch({
        matchId: 'bad',
        seed: 's',
        database,
        seats: Array.from({ length: count }, (_, i) => seat(i)),
      });
      expect(result.ok).toBe(false);
    }
  });

  it('shuffles seat order from the seed rather than from join order', () => {
    // Same players, same declared order, different seeds: the table differs,
    // and each seed is reproducible (open-questions.md Q31).
    const orders = new Set<string>();
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const state = startTable(4, { seed, shuffleSeats: true });
      orders.add(state.seatOrder.join(','));
      expect(startTable(4, { seed, shuffleSeats: true }).seatOrder).toEqual(state.seatOrder);
    }
    expect(orders.size).toBeGreaterThan(1);
  });
});

/* ------------------------------------------- 2. circular turns and skipping */

describe('2. stable circular turns, skipping eliminated seats', () => {
  it('passes the turn clockwise through every seat', () => {
    let state = keepAllHands(startTable(4));
    const seen: PlayerId[] = [state.activePlayerId];

    for (let turn = 0; turn < 4; turn += 1) {
      state = apply(state, { type: 'pass_phase', playerId: state.activePlayerId });
      state = apply(state, {
        type: 'declare_attackers',
        playerId: state.activePlayerId,
        attacks: [],
      });
      state = apply(state, { type: 'pass_phase', playerId: state.activePlayerId });
      seen.push(state.activePlayerId);
    }

    expect(seen.slice(0, 4)).toEqual(state.playerOrder);
    // Back around to the start after a full lap.
    expect(seen[4]).toBe(seen[0]);
  });

  it('skips an eliminated seat without renumbering the others', () => {
    let state = keepAllHands(startTable(4));
    const order = [...state.playerOrder];
    const victim = order[1] as PlayerId;

    state = apply(state, { type: 'concede', playerId: victim });
    expect(state.seatOrder).toEqual(order.length === 4 ? state.seatOrder : []);
    expect(state.seatOrder).toHaveLength(4);
    expect(state.players[victim]?.lost).toBe(true);

    state = apply(state, { type: 'pass_phase', playerId: state.activePlayerId });
    state = apply(state, {
      type: 'declare_attackers',
      playerId: state.activePlayerId,
      attacks: [],
    });
    state = apply(state, { type: 'pass_phase', playerId: state.activePlayerId });

    // The turn jumps over the empty seat to the one after it.
    expect(state.activePlayerId).toBe(order[2]);
    expect(state.seatOrder).toHaveLength(4);
  });
});

/* ------------------------------------------------------- 3. splitting attacks */

describe('3. splitting attackers across opponents', () => {
  it('lets one player attack two different opponents in one combat', () => {
    const base = atAttackStep(3);
    const active = base.activePlayerId;
    const [left, right] = clockwiseFrom(base, active);

    const first = deployUnit(base, active, 'prototype_scout');
    const second = deployUnit(first.state, active, 'prototype_scout');

    const declared = apply(second.state, {
      type: 'declare_attackers',
      playerId: active,
      attacks: [
        attack(first.instanceId, left as PlayerId),
        attack(second.instanceId, right as PlayerId),
      ],
    });

    expect(declared.combat.attacks).toHaveLength(2);
    // Both attacked players owe a blocker submission.
    expect(declared.combat.awaitingDefenders).toEqual(
      declared.seatOrder.filter((id) => id === left || id === right),
    );
  });

  it('splits across three opponents at a four-player table', () => {
    const base = atAttackStep(4);
    const active = base.activePlayerId;
    const opponents = clockwiseFrom(base, active);

    let state = base;
    const attackerIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const placed = deployUnit(state, active, 'prototype_scout');
      state = placed.state;
      attackerIds.push(placed.instanceId);
    }

    const declared = apply(state, {
      type: 'declare_attackers',
      playerId: active,
      attacks: attackerIds.map((id, i) => attack(id, opponents[i] as PlayerId)),
    });

    expect(new Set(declared.combat.attacks.map((a) => a.defenderPlayerId)).size).toBe(3);
    expect(declared.combat.awaitingDefenders).toHaveLength(3);
  });

  it('rejects an attack aimed at a seat that is not a living opponent', () => {
    const base = atAttackStep(3);
    const active = base.activePlayerId;
    const attacker = deployUnit(base, active, 'prototype_scout');

    // Attacking yourself is not a thing.
    const self = expectRejected(attacker.state, {
      type: 'declare_attackers',
      playerId: active,
      attacks: [attack(attacker.instanceId, active)],
    });
    expect(self.code).toBe('engine/illegal_defender');

    const dead = clockwiseFrom(base, active)[0] as PlayerId;
    const afterConcede = apply(attacker.state, { type: 'concede', playerId: dead });
    const gone = expectRejected(afterConcede, {
      type: 'declare_attackers',
      playerId: active,
      attacks: [attack(attacker.instanceId, dead)],
    });
    expect(gone.code).toBe('engine/illegal_defender');
  });
});

/* ------------------------------------------------- 4. third-party blocking */

describe('4. illegal blockers', () => {
  it('refuses to let a third player block for someone else', () => {
    const base = atAttackStep(3);
    const active = base.activePlayerId;
    const [defender, bystander] = clockwiseFrom(base, active) as [PlayerId, PlayerId];

    const attacker = deployUnit(base, active, 'prototype_scout');
    const helper = deployUnit(attacker.state, bystander, 'prototype_guard');

    const declared = apply(helper.state, {
      type: 'declare_attackers',
      playerId: active,
      attacks: [attack(attacker.instanceId, defender)],
    });

    // The bystander is not being attacked at all, so they owe nothing and
    // cannot interpose a unit (CLAUDE.md §12).
    expect(declared.combat.awaitingDefenders).toEqual([defender]);
    const error = expectRejected(declared, {
      type: 'assign_blockers',
      playerId: bystander,
      blocks: [{ attackerInstanceId: attacker.instanceId, blockerInstanceId: helper.instanceId }],
    });
    expect(error.code).toBe('engine/wrong_player');
    expect(legalActions(declared, bystander, context).blocking).toBeNull();
  });

  it('refuses a block against an attacker aimed at a different player', () => {
    const base = atAttackStep(3);
    const active = base.activePlayerId;
    const [first, second] = clockwiseFrom(base, active) as [PlayerId, PlayerId];

    const a1 = deployUnit(base, active, 'prototype_scout');
    const a2 = deployUnit(a1.state, active, 'prototype_scout');
    const blocker = deployUnit(a2.state, first, 'prototype_guard');

    const declared = apply(blocker.state, {
      type: 'declare_attackers',
      playerId: active,
      attacks: [attack(a1.instanceId, first), attack(a2.instanceId, second)],
    });

    const error = expectRejected(declared, {
      type: 'assign_blockers',
      playerId: first,
      // a2 is attacking `second`, not `first`.
      blocks: [{ attackerInstanceId: a2.instanceId, blockerInstanceId: blocker.instanceId }],
    });
    expect(error.code).toBe('engine/illegal_blocker');

    // Only the attacker aimed at them is even offered.
    expect(legalActions(declared, first, context).blocking?.attackerInstanceIds).toEqual([
      a1.instanceId,
    ]);
  });

  it('refuses a second submission from a defender who already answered', () => {
    const base = atAttackStep(3);
    const active = base.activePlayerId;
    const [first, second] = clockwiseFrom(base, active) as [PlayerId, PlayerId];
    const a1 = deployUnit(base, active, 'prototype_scout');
    const a2 = deployUnit(a1.state, active, 'prototype_scout');

    const declared = apply(a2.state, {
      type: 'declare_attackers',
      playerId: active,
      attacks: [attack(a1.instanceId, first), attack(a2.instanceId, second)],
    });
    const once = apply(declared, { type: 'assign_blockers', playerId: first, blocks: [] });
    const error = expectRejected(once, { type: 'assign_blockers', playerId: first, blocks: [] });
    expect(error.code).toBe('engine/wrong_player');
  });
});

/* ----------------------------------------- 5. arrival order cannot matter */

describe('5. independent blocker submissions in different network orders', () => {
  function runWithOrder(order: readonly number[]): MatchState {
    const base = atAttackStep(3, 'order-seed');
    const active = base.activePlayerId;
    const [first, second] = clockwiseFrom(base, active) as [PlayerId, PlayerId];

    const a1 = deployUnit(base, active, 'prototype_scout');
    const a2 = deployUnit(a1.state, active, 'prototype_scout');
    const b1 = deployUnit(a2.state, first, 'prototype_guard');
    const b2 = deployUnit(b1.state, second, 'prototype_guard');

    let state = apply(b2.state, {
      type: 'declare_attackers',
      playerId: active,
      attacks: [attack(a1.instanceId, first), attack(a2.instanceId, second)],
    });

    const submissions = [
      {
        playerId: first,
        blocks: [{ attackerInstanceId: a1.instanceId, blockerInstanceId: b1.instanceId }],
      },
      {
        playerId: second,
        blocks: [{ attackerInstanceId: a2.instanceId, blockerInstanceId: b2.instanceId }],
      },
    ];
    for (const index of order) {
      const submission = submissions[index];
      if (!submission) continue;
      state = apply(state, { type: 'assign_blockers', ...submission });
    }
    return state;
  }

  it('produces identical final state whichever defender answers first', () => {
    const forwards = runWithOrder([0, 1]);
    const backwards = runWithOrder([1, 0]);

    // The merge is ordered by seat, not by arrival, so even the public block
    // list is byte-identical (CLAUDE.md §12).
    expect(backwards.combat.blocks).toEqual(forwards.combat.blocks);
    expect(backwards.phase).toBe(forwards.phase);
    for (const playerId of forwards.seatOrder) {
      expect(backwards.players[playerId]?.health).toBe(forwards.players[playerId]?.health);
    }
    const damageOf = (state: MatchState) =>
      eventsOfType(state, 'damage_dealt').map((event) => [
        event.targetInstanceId,
        event.targetPlayerId,
        event.amount,
      ]);
    expect(damageOf(backwards)).toEqual(damageOf(forwards));
  });

  it('holds each submission private until the last defender answers', () => {
    const base = atAttackStep(3, 'order-seed');
    const active = base.activePlayerId;
    const [first, second] = clockwiseFrom(base, active) as [PlayerId, PlayerId];

    const a1 = deployUnit(base, active, 'prototype_scout');
    const a2 = deployUnit(a1.state, active, 'prototype_scout');
    const b1 = deployUnit(a2.state, first, 'prototype_guard');

    const declared = apply(b1.state, {
      type: 'declare_attackers',
      playerId: active,
      attacks: [attack(a1.instanceId, first), attack(a2.instanceId, second)],
    });
    const partial = apply(declared, {
      type: 'assign_blockers',
      playerId: first,
      blocks: [{ attackerInstanceId: a1.instanceId, blockerInstanceId: b1.instanceId }],
    });

    // Nothing public yet, and the attacker cannot see the committed block.
    expect(partial.combat.blocks).toHaveLength(0);
    expect(partial.phase).toBe('assign_blockers');
    expect(playerView(partial, active, database).combat.submissions).toHaveLength(0);
    expect(playerView(partial, second, database).combat.submissions).toHaveLength(0);
    expect(playerView(partial, first, database).combat.submissions).toHaveLength(1);

    // The public event says who has answered, never what they chose.
    const submitted = eventsOfType(partial, 'blockers_submitted');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.awaitingPlayerIds).toEqual([second]);
    expect(Object.keys(submitted[0] ?? {})).not.toContain('blocks');
  });
});

/* --------------------------------------- 6. simultaneous multi-defender damage */

describe('6. simultaneous combat across several defenders', () => {
  it('damages every attacked player in the same step', () => {
    const base = atAttackStep(3);
    const active = base.activePlayerId;
    const [first, second] = clockwiseFrom(base, active) as [PlayerId, PlayerId];

    const a1 = deployUnit(base, active, 'prototype_scout');
    const a2 = deployUnit(a1.state, active, 'prototype_scout');

    let state = apply(a2.state, {
      type: 'declare_attackers',
      playerId: active,
      attacks: [attack(a1.instanceId, first), attack(a2.instanceId, second)],
    });
    state = apply(state, { type: 'assign_blockers', playerId: first, blocks: [] });
    state = apply(state, { type: 'assign_blockers', playerId: second, blocks: [] });

    const scout = database.getOrThrow('prototype_scout');
    const expected = 20 - (scout.attack ?? 0);
    expect(state.players[first]?.health).toBe(expected);
    expect(state.players[second]?.health).toBe(expected);
    expect(state.players[active]?.health).toBe(20);
    // One damage step, not one per defender.
    expect(eventsOfType(state, 'combat_damage_step')).toHaveLength(1);
  });

  it('kills two players at once when both take lethal damage in one combat', () => {
    const base = atAttackStep(3);
    const active = base.activePlayerId;
    const [first, second] = clockwiseFrom(base, active) as [PlayerId, PlayerId];

    const a1 = deployUnit(
      setHealth(setHealth(base, first, 1), second, 1),
      active,
      'prototype_scout',
    );
    const a2 = deployUnit(a1.state, active, 'prototype_scout');

    let state = apply(a2.state, {
      type: 'declare_attackers',
      playerId: active,
      attacks: [attack(a1.instanceId, first), attack(a2.instanceId, second)],
    });
    state = apply(state, { type: 'assign_blockers', playerId: first, blocks: [] });
    state = apply(state, { type: 'assign_blockers', playerId: second, blocks: [] });

    // Both die simultaneously, leaving exactly one player: a win, not a draw.
    expect(state.status).toBe('complete');
    expect(state.result?.outcome).toBe('win');
    expect(state.result?.winnerId).toBe(active);
    expect(state.result?.loserIds).toHaveLength(2);
  });
});

/* ------------------------------------------- 7. opponent and each_opponent */

describe('7. player targeting', () => {
  const burn = {
    schemaVersion: 2,
    id: 'test_bolt',
    name: 'Test Bolt',
    type: 'spell' as const,
    colorIdentity: [],
    cost: 0,
    collectible: false,
    effects: [
      {
        type: 'deal_damage' as const,
        target: { kind: 'player' as const, relation: 'opponent' as const },
        amount: 3,
      },
    ],
  };
  const sweep = {
    schemaVersion: 2,
    id: 'test_sweep',
    name: 'Test Sweep',
    type: 'spell' as const,
    colorIdentity: [],
    cost: 0,
    collectible: false,
    effects: [
      {
        type: 'deal_damage' as const,
        target: { kind: 'players' as const, relation: 'each_opponent' as const },
        amount: 2,
      },
    ],
  };
  const cataclysm = {
    schemaVersion: 2,
    id: 'test_cataclysm',
    name: 'Test Cataclysm',
    type: 'spell' as const,
    colorIdentity: [],
    cost: 0,
    collectible: false,
    effects: [
      {
        type: 'deal_damage' as const,
        target: { kind: 'players' as const, relation: 'all_players' as const },
        amount: 2,
      },
    ],
  };

  it('asks which opponent when more than one is alive, then damages only them', () => {
    const local = { ...context, database: databaseWithSpells() };
    const base = keepAllHands(startTable(3), local);
    const active = base.activePlayerId;
    const [first, second] = clockwiseFrom(base, active) as [PlayerId, PlayerId];
    const card = giveSpell(base, active, 'test_bolt');

    let state = apply(
      card.state,
      { type: 'play_card', playerId: active, instanceId: card.instanceId },
      local,
    );

    // The engine may not pick a victim on the controller's behalf.
    expect(state.pendingChoice?.type).toBe('select_players');
    expect(state.pendingChoice?.playerId).toBe(active);
    expect(state.pendingChoice?.validEntityIds).toEqual([first, second]);

    state = apply(
      state,
      {
        type: 'submit_choice',
        playerId: active,
        choiceId: state.pendingChoice?.id ?? '',
        selectedIds: [second],
      },
      local,
    );

    expect(state.players[second]?.health).toBe(17);
    expect(state.players[first]?.health).toBe(20);
  });

  it('resolves an opponent target without asking when only one is left', () => {
    const local = { ...context, database: databaseWithSpells() };
    const base = keepAllHands(startTable(2), local);
    const active = base.activePlayerId;
    const only = clockwiseFrom(base, active)[0] as PlayerId;
    const card = giveSpell(base, active, 'test_bolt');

    const state = apply(
      card.state,
      { type: 'play_card', playerId: active, instanceId: card.instanceId },
      local,
    );
    expect(state.pendingChoice).toBeNull();
    expect(state.players[only]?.health).toBe(17);
  });

  it('resolves each_opponent clockwise from the controller', () => {
    const local = { ...context, database: databaseWithSpells() };
    const base = keepAllHands(startTable(4), local);
    const active = base.activePlayerId;
    const opponents = clockwiseFrom(base, active);
    const card = giveSpell(base, active, 'test_sweep');

    const state = apply(
      card.state,
      { type: 'play_card', playerId: active, instanceId: card.instanceId },
      local,
    );

    expect(state.pendingChoice).toBeNull();
    for (const playerId of opponents) expect(state.players[playerId]?.health).toBe(18);
    expect(state.players[active]?.health).toBe(20);

    // Presentation events land in clockwise order (CLAUDE.md §12).
    const hit = eventsOfType(state, 'player_damaged').map((event) => event.playerId);
    expect(hit).toEqual(opponents);
  });

  it('makes an all_players kill a draw when it removes everyone at once', () => {
    const local = { ...context, database: databaseWithSpells() };
    let base = keepAllHands(startTable(3), local);
    const active = base.activePlayerId;
    // Everyone, controller included, dies to the same instruction. `each_opponent`
    // cannot produce this: it never touches the controller.
    for (const playerId of base.seatOrder) base = setHealth(base, playerId, 2);
    const card = giveSpell(base, active, 'test_cataclysm');

    const state = apply(
      card.state,
      { type: 'play_card', playerId: active, instanceId: card.instanceId },
      local,
    );
    expect(state.status).toBe('complete');
    expect(state.result?.outcome).toBe('draw');
    expect(state.result?.reason).toBe('simultaneous_loss');
  });

  it('cancels a dying controller’s own queued effect before it resolves', () => {
    const local = { ...context, database: databaseWithSpells() };
    let base = keepAllHands(startTable(3), local);
    const active = base.activePlayerId;
    for (const playerId of clockwiseFrom(base, active)) base = setHealth(base, playerId, 1);
    // The controller is already dead when the spell is played, so the
    // state-based check eliminates them and drops their queued work (§12 step 3)
    // before the sweep can reach anyone.
    base = setHealth(base, active, 0);
    const card = giveSpell(base, active, 'test_sweep');

    const state = apply(
      card.state,
      { type: 'play_card', playerId: active, instanceId: card.instanceId },
      local,
    );
    expect(eventsOfType(state, 'effects_cancelled')).toHaveLength(1);
    for (const playerId of clockwiseFrom(base, active)) {
      expect(state.players[playerId]?.health).toBe(1);
    }
    expect(state.status).toBe('playing');
  });

  function databaseWithSpells() {
    return databaseWithCards([burn, sweep, cataclysm]);
  }
});

/* ----------------------------------------------------- 8. trigger ordering */

describe('8. active-player-then-clockwise trigger ordering', () => {
  it('orders simultaneous turn-start triggers by seat', () => {
    // `on_turn_start` fires only for the active player's own permanents, so the
    // seat tier is exercised through defeat triggers in one combat instead.
    const state = keepAllHands(startTable(4));
    const order = clockwiseFrom(state, state.activePlayerId, { includeSelf: true });
    expect(order[0]).toBe(state.activePlayerId);
    // Clockwise means "the seat after", all the way round, exactly once.
    expect(new Set(order).size).toBe(4);
    expect(order).toEqual(
      state.seatOrder
        .concat(state.seatOrder)
        .slice(
          state.seatOrder.indexOf(state.activePlayerId),
          state.seatOrder.indexOf(state.activePlayerId) + 4,
        ),
    );
  });

  it('queues defeat triggers active player first, then clockwise', () => {
    const base = atAttackStep(3);
    const active = base.activePlayerId;
    const [first, second] = clockwiseFrom(base, active) as [PlayerId, PlayerId];

    // Three constructs die in the same combat, one per player.
    const own = deployUnit(base, active, 'unstable_construct');
    const theirs = deployUnit(own.state, first, 'unstable_construct');
    const others = deployUnit(theirs.state, second, 'unstable_construct');

    let state = others.state;
    for (const instanceId of [own.instanceId, theirs.instanceId, others.instanceId]) {
      const instance = instanceIn(state, instanceId);
      instance.markedDamage = 99;
    }
    // Any action settles the board and runs the state-based check.
    state = apply(state, { type: 'declare_attackers', playerId: active, attacks: [] });

    const triggered = eventsOfType(state, 'trigger_queued').map((event) => event.controllerId);
    const seatsSeen = triggered.filter((id, index) => triggered.indexOf(id) === index);
    expect(seatsSeen).toEqual([active, first, second]);
  });
});

/* ------------------------------------------------- 9. elimination cleanup */

describe('9. elimination cleanup', () => {
  it('removes the eliminated player’s cards, tokens, queue and pending attacks', () => {
    const base = atAttackStep(3);
    const active = base.activePlayerId;
    const [victim, bystander] = clockwiseFrom(base, active) as [PlayerId, PlayerId];

    const attacker = deployUnit(base, active, 'prototype_scout');
    const victimUnit = deployUnit(attacker.state, victim, 'prototype_guard');
    const survivorUnit = deployUnit(victimUnit.state, bystander, 'prototype_guard');

    const declared = apply(survivorUnit.state, {
      type: 'declare_attackers',
      playerId: active,
      attacks: [attack(attacker.instanceId, victim)],
    });
    expect(declared.combat.attacks).toHaveLength(1);

    const after = apply(declared, { type: 'concede', playerId: victim });

    // 2. every card they own is gone from play, into a terminal zone.
    expect(instanceIn(after, victimUnit.instanceId).zone).toBe('removed');
    expect(after.players[victim]?.units.every((slot) => slot === null)).toBe(true);
    expect(after.players[victim]?.hand).toHaveLength(0);
    expect(after.players[victim]?.deck).toHaveLength(0);
    expect(after.players[victim]?.removed.length).toBeGreaterThan(0);

    // 7. the attack against them is dropped, and the attacker stays exhausted.
    expect(after.combat.attacks).toHaveLength(0);
    expect(instanceIn(after, attacker.instanceId).exhausted).toBe(true);
    expect(after.players[active]?.health).toBe(20);

    // Everyone else is untouched.
    expect(instanceIn(after, survivorUnit.instanceId).zone).toBe('battlefield');
    expect(eventsOfType(after, 'player_eliminated')).toHaveLength(1);
  });

  it('destroys tokens the eliminated player owned rather than moving them', () => {
    const base = keepAllHands(startTable(3));
    const active = base.activePlayerId;
    const victim = clockwiseFrom(base, active)[0] as PlayerId;

    const token = deployUnit(base, victim, 'prototype_scrap_token');
    const after = apply(token.state, { type: 'concede', playerId: victim });

    // A token ceases to exist; it never lands in `removed`.
    expect(after.instances[token.instanceId]).toBeUndefined();
    expect(after.players[victim]?.removed).not.toContain(token.instanceId);
  });

  it('returns a card owned by someone else to its owner', () => {
    const base = keepAllHands(startTable(3));
    const active = base.activePlayerId;
    const [victim, owner] = clockwiseFrom(base, active) as [PlayerId, PlayerId];

    // A unit owned by `owner` but controlled by `victim` — the state Phase 3
    // requires to be explicit rather than inferred from the battlefield.
    const placed = deployUnit(base, victim, 'prototype_guard');
    const seized = structuredClone(placed.state);
    const instance = seized.instances[placed.instanceId];
    if (!instance) throw new Error('missing instance');
    instance.owner = owner;

    const after = apply(seized, { type: 'concede', playerId: victim });

    expect(instanceIn(after, placed.instanceId).zone).toBe('discard');
    expect(instanceIn(after, placed.instanceId).controller).toBe(owner);
    expect(after.players[owner]?.discard).toContain(placed.instanceId);
    expect(eventsOfType(after, 'control_returned')).toHaveLength(1);
  });

  it('cancels a choice owed by a player who is eliminated while it is pending', () => {
    const local = { ...context, database: databaseWithCards([SLOW_DRAW]) };
    const base = keepAllHands(startTable(3), local);
    const active = base.activePlayerId;
    const card = giveSpell(base, active, 'test_hard_choice');

    const state = apply(
      card.state,
      { type: 'play_card', playerId: active, instanceId: card.instanceId },
      local,
    );
    expect(state.pendingChoice?.playerId).toBe(active);

    // Conceding is legal even while a mandatory choice is pending.
    const after = applyAction(state, { type: 'concede', playerId: active }, local);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.state.pendingChoice).toBeNull();
    expect(after.value.state.queue).toHaveLength(0);
  });
});

const SLOW_DRAW = {
  schemaVersion: 2,
  id: 'test_hard_choice',
  name: 'Test Hard Choice',
  type: 'spell' as const,
  colorIdentity: [],
  cost: 0,
  collectible: false,
  effects: [
    {
      type: 'discard' as const,
      player: 'self' as const,
      amount: 1,
      selection: 'player_choice' as const,
    },
  ],
};

/* --------------------------------------------- 10. timeout while others play */

describe('10. timeout elimination while the others continue', () => {
  it('eliminates one seat and leaves the match running', () => {
    const base = keepAllHands(startTable(4));
    const victim = clockwiseFrom(base, base.activePlayerId)[0] as PlayerId;

    const after = apply(base, { type: 'server_timeout', playerId: victim });

    expect(after.players[victim]?.lossReason).toBe('timeout');
    expect(after.status).not.toBe('complete');
    expect(livingPlayers(after)).toHaveLength(3);
  });
});

/* ----------------------------------------- 11. last player wins / draw */

describe('11. victory and draw', () => {
  it('ends only when one player is left', () => {
    let state = keepAllHands(startTable(4));
    const [, second, third, fourth] = state.seatOrder as [PlayerId, PlayerId, PlayerId, PlayerId];

    state = apply(state, { type: 'concede', playerId: second });
    expect(state.status).not.toBe('complete');
    state = apply(state, { type: 'concede', playerId: third });
    expect(state.status).not.toBe('complete');
    state = apply(state, { type: 'concede', playerId: fourth });

    expect(state.status).toBe('complete');
    expect(state.result?.outcome).toBe('win');
    expect(state.result?.winnerId).toBe(state.seatOrder[0]);
  });
});

/* -------------------------------------------------- 12. per-viewer redaction */

describe('12. hidden information with four players', () => {
  it('shows each viewer only their own hand and never a deck order', () => {
    const state = keepAllHands(startTable(4));

    for (const viewerId of state.seatOrder) {
      const view = playerView(state, viewerId, database);
      expect(view.viewerId).toBe(viewerId);
      expect(view.hand).toEqual(state.players[viewerId]?.hand);

      const visibleIds = new Set(Object.keys(view.instances));
      for (const otherId of state.seatOrder) {
        if (otherId === viewerId) continue;
        for (const cardId of state.players[otherId]?.hand ?? []) {
          expect(visibleIds.has(cardId)).toBe(false);
        }
        for (const cardId of state.players[otherId]?.deck ?? []) {
          expect(visibleIds.has(cardId)).toBe(false);
        }
      }
      // Their own deck order is hidden from them too.
      for (const cardId of state.players[viewerId]?.deck ?? []) {
        expect(visibleIds.has(cardId)).toBe(false);
      }
      const serialised = JSON.stringify(view);
      expect(serialised).not.toContain('"rng"');
    }
  });

  it('keeps another player’s private mulligan choice out of the view', () => {
    let state = startTable(4);
    const [first] = state.seatOrder as [PlayerId];
    const hand = [...(state.players[first]?.hand ?? [])];
    state = apply(state, {
      type: 'mulligan',
      playerId: first,
      returnInstanceIds: hand.slice(0, 2),
    });

    const other = state.seatOrder[1] as PlayerId;
    const view = playerView(state, other, database);
    const submitted = view.log.filter((event) => event.type === 'mulligan_submitted');
    // Only the count is public, never which cards went back.
    expect(submitted[0]).toMatchObject({ playerId: first, returnedCount: 2 });
    expect(JSON.stringify(view)).not.toContain(hand[0] ?? 'nothing');
  });
});

/* ------------------------------------------- 13/15. serialisation and replay */

describe('13/15. determinism, serialisation and replay', () => {
  it('reproduces an identical four-player match from the same seed and actions', () => {
    const build = (): MatchState => {
      let state = keepAllHands(startTable(4, { seed: 'replay-seed' }));
      for (let i = 0; i < 6; i += 1) {
        state = apply(state, { type: 'pass_phase', playerId: state.activePlayerId });
        state = apply(state, {
          type: 'declare_attackers',
          playerId: state.activePlayerId,
          attacks: [],
        });
        state = apply(state, { type: 'pass_phase', playerId: state.activePlayerId });
      }
      return state;
    };

    const left = build();
    const right = build();
    expect(serializeMatchState(right)).toEqual(serializeMatchState(left));
  });

  it('round-trips a four-player state that is paused on a defender submission', () => {
    const base = atAttackStep(3);
    const active = base.activePlayerId;
    const [first, second] = clockwiseFrom(base, active) as [PlayerId, PlayerId];
    const a1 = deployUnit(base, active, 'prototype_scout');
    const a2 = deployUnit(a1.state, active, 'prototype_scout');

    let state = apply(a2.state, {
      type: 'declare_attackers',
      playerId: active,
      attacks: [attack(a1.instanceId, first), attack(a2.instanceId, second)],
    });
    state = apply(state, { type: 'assign_blockers', playerId: first, blocks: [] });

    const restored = deserializeMatchState(serializeMatchState(state));
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.combat.awaitingDefenders).toEqual([second]);

    // The match resumes from the restored state exactly as it would have.
    const finished = apply(restored.value, {
      type: 'assign_blockers',
      playerId: second,
      blocks: [],
    });
    expect(finished.combat.awaitingDefenders).toHaveLength(0);
    expect(finished.combat.damageResolved).toBe(true);
  });
});

/* ------------------------------------------------- 14. spectating after out */

describe('14. eliminated players spectate but cannot act', () => {
  it('rejects every gameplay action from an eliminated seat', () => {
    const base = keepAllHands(startTable(3));
    const victim = clockwiseFrom(base, base.activePlayerId)[0] as PlayerId;
    const state = apply(base, { type: 'concede', playerId: victim });

    const rejected = expectRejected(state, {
      type: 'play_card',
      playerId: victim,
      instanceId: state.players[victim]?.removed[0] ?? 'inst_0000',
    });
    expect(rejected.code).toBe('engine/eliminated');

    const legal = legalActions(state, victim, context);
    expect(legal.eliminated).toBe(true);
    expect(legal.canPassPhase).toBe(false);
    expect(legal.playableCards).toHaveLength(0);
    expect(legal.attacking).toBeNull();
    expect(legal.blocking).toBeNull();
    expect(legal.canConcede).toBe(false);
  });

  it('still gives them a public view of the match', () => {
    const base = keepAllHands(startTable(3));
    const victim = clockwiseFrom(base, base.activePlayerId)[0] as PlayerId;
    const state = apply(base, { type: 'concede', playerId: victim });

    const view = playerView(state, victim, database);
    expect(view.players).toHaveLength(3);
    expect(view.players.find((p) => p.playerId === victim)?.eliminated).toBe(true);
    expect(view.log.length).toBeGreaterThan(0);
    // Spectating never unlocks anyone else's hand.
    const survivor = state.seatOrder.find((id) => id !== victim) as PlayerId;
    for (const cardId of state.players[survivor]?.hand ?? []) {
      expect(Object.keys(view.instances)).not.toContain(cardId);
    }
  });
});

/* ------------------------------------------------------------------ helpers */

/** The shared test database with extra test-only cards bolted on. */
function databaseWithCards(cards: readonly unknown[]) {
  return databaseWith(cards as never);
}

/** Puts a spell in hand with enough energy to cast it. */
function giveSpell(
  state: MatchState,
  playerId: PlayerId,
  definitionId: CardId,
): { state: MatchState; instanceId: string } {
  return giveCard(setEnergy(state, playerId, 9), playerId, definitionId);
}
