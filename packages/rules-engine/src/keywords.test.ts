import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES_CONFIG } from './config.js';
import { currentAttack, opponentOf } from './derive.js';
import { INERT_KEYWORDS, KEYWORD_BEHAVIOUR } from './keywords.js';
import {
  attacksOnOpponent,
  apply,
  deployUnit,
  eventsOfType,
  forcePhase,
  instanceIn,
  keepBothHands,
  setHealth,
  startMatch,
  testDatabase,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';

/**
 * Keyword behaviour, one test per implemented keyword. `guardian` and
 * `resilient` are deliberately inert — see `keywords.ts` and open-questions.md
 * Q4 — so the only thing asserted about them is that they stay inert.
 */

interface Fight {
  readonly state: MatchState;
  readonly attackerId: string;
  readonly blockerId: string;
  readonly attackerPlayer: string;
  readonly defenderPlayer: string;
}

function fight(attackerCard: string, blockerCard: string | null): Fight {
  const start = keepBothHands(startMatch());
  const active = start.activePlayerId;
  const other = opponentOf(start, active);

  const attacker = deployUnit(start, active, attackerCard);
  const blocker = blockerCard ? deployUnit(attacker.state, other, blockerCard) : null;
  const atAttack = forcePhase(blocker?.state ?? attacker.state, 'declare_attackers');

  let state = apply(atAttack, {
    type: 'declare_attackers',
    playerId: active,
    attacks: attacksOnOpponent(atAttack, [attacker.instanceId]),
  });
  state = apply(state, {
    type: 'assign_blockers',
    playerId: other,
    blocks: blocker
      ? [{ attackerInstanceId: attacker.instanceId, blockerInstanceId: blocker.instanceId }]
      : [],
  });

  return {
    state,
    attackerId: attacker.instanceId,
    blockerId: blocker?.instanceId ?? '',
    attackerPlayer: active,
    defenderPlayer: other,
  };
}

describe('armored', () => {
  it('reduces each instance of damage by the configured amount', () => {
    // Dawn Conscript is 2/1; Trench Guard is 1/5 with armored.
    const { state, attackerId, blockerId } = fight('dawn_conscript', 'trench_guard');

    expect(instanceIn(state, blockerId).markedDamage).toBe(
      2 - DEFAULT_RULES_CONFIG.armoredReduction,
    );
    expect(instanceIn(state, blockerId).zone).toBe('battlefield');
    // The 1-power blocker still kills the 1-health attacker.
    expect(instanceIn(state, attackerId).zone).toBe('discard');
    expect(eventsOfType(state, 'damage_prevented')).toHaveLength(1);
  });
});

describe('venom', () => {
  it('makes any damage lethal, even after armour reduces it below Health', () => {
    // Dread Sovereign is 7/7 with venom; Bramble Titan is 7/7 with armored, so
    // it takes 6 — survivable without venom.
    const { state, blockerId } = fight('dread_sovereign', 'bramble_titan');
    expect(instanceIn(state, blockerId).zone).toBe('discard');
  });
});

describe('siphon', () => {
  it('heals the controller for combat damage dealt', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const other = opponentOf(start, active);

    const wounded = setHealth(start, active, 10);
    const attacker = deployUnit(wounded, active, 'oathbound_paladin');
    const atAttack = forcePhase(attacker.state, 'declare_attackers');

    let state = apply(atAttack, {
      type: 'declare_attackers',
      playerId: active,
      attacks: attacksOnOpponent(atAttack, [attacker.instanceId]),
    });
    state = apply(state, { type: 'assign_blockers', playerId: other, blocks: [] });

    // Oathbound Paladin is 4/5: four damage through, four Health back.
    expect(state.players[other]?.health).toBe(DEFAULT_RULES_CONFIG.startingHealth - 4);
    expect(state.players[active]?.health).toBe(14);
  });
});

describe('quick_strike', () => {
  it('resolves in an earlier damage step so the loser never strikes back', () => {
    const { state, attackerId, blockerId } = fight('pyre_champion', 'goblin_scout');

    expect(instanceIn(state, blockerId).zone).toBe('discard');
    expect(instanceIn(state, attackerId).markedDamage).toBe(0);

    const steps = eventsOfType(state, 'combat_damage_step').map((event) => event.step);
    expect(steps).toEqual(['quick_strike']);
  });

  it('still exchanges damage normally when both sides survive the first step', () => {
    // Pyre Champion 6/4 vs Bramble Titan 7/7 armored: 6 - 1 armour = 5 marked,
    // the titan survives and answers in the regular step.
    const { state, attackerId, blockerId } = fight('pyre_champion', 'bramble_titan');
    const steps = eventsOfType(state, 'combat_damage_step').map((event) => event.step);
    expect(steps).toEqual(['quick_strike', 'regular']);
    expect(instanceIn(state, blockerId).markedDamage).toBe(5);
    expect(instanceIn(state, attackerId).zone).toBe('discard');
  });
});

describe('evasive and swift', () => {
  it('lets a swift unit attack the turn it arrives', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const swift = deployUnit(start, active, 'goblin_scout', { summoningSick: true });
    const atAttack = forcePhase(swift.state, 'declare_attackers');

    const state = apply(atAttack, {
      type: 'declare_attackers',
      playerId: active,
      attacks: attacksOnOpponent(atAttack, [swift.instanceId]),
    });
    expect(state.combat.attacks.map((attack) => attack.attackerInstanceId)).toEqual([
      swift.instanceId,
    ]);
  });
});

describe('on_survive_combat with a source target', () => {
  it('permanently buffs the surviving unit itself, not an arbitrary friendly', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const other = opponentOf(start, active);

    const harvester = deployUnit(start, active, 'bone_harvester');
    const bystander = deployUnit(harvester.state, active, 'prototype_guard');
    const chaff = deployUnit(bystander.state, other, 'prototype_drone');
    const atAttack = forcePhase(chaff.state, 'declare_attackers');

    let state = apply(atAttack, {
      type: 'declare_attackers',
      playerId: active,
      attacks: attacksOnOpponent(atAttack, [harvester.instanceId]),
    });
    state = apply(state, {
      type: 'assign_blockers',
      playerId: other,
      blocks: [{ attackerInstanceId: harvester.instanceId, blockerInstanceId: chaff.instanceId }],
    });

    const harvesterDefinition = testDatabase().getOrThrow('bone_harvester');
    const guardDefinition = testDatabase().getOrThrow('prototype_guard');
    expect(currentAttack(instanceIn(state, harvester.instanceId), harvesterDefinition)).toBe(4);
    expect(currentAttack(instanceIn(state, bystander.instanceId), guardDefinition)).toBe(1);
  });
});

describe('inert keywords', () => {
  it('records resilient as authored but not executed', () => {
    // Guardian left this list when the Precon Wave 1 ruleset gave it real
    // must-block behaviour (ADR 0016). Resilient is still an open design
    // decision and no Precon Wave 1 card prints it.
    expect(INERT_KEYWORDS).toEqual(['resilient']);
    expect(KEYWORD_BEHAVIOUR.resilient.implemented).toBe(false);
    expect(KEYWORD_BEHAVIOUR.guardian.implemented).toBe(true);
  });

  it('gives a guardian blocker no mechanical advantage yet', () => {
    // Prototype Guard (1/4, guardian) and Thornback Calf (2/3) both block a
    // 2/1 attacker identically: two damage marked, attacker defeated.
    const withGuardian = fight('dawn_conscript', 'prototype_guard');
    const withoutGuardian = fight('dawn_conscript', 'thornback_calf');

    expect(instanceIn(withGuardian.state, withGuardian.blockerId).markedDamage).toBe(2);
    expect(instanceIn(withoutGuardian.state, withoutGuardian.blockerId).markedDamage).toBe(2);
  });
});
