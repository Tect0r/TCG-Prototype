import { describe, expect, it } from 'vitest';
import type { CardDefinitionInput } from '@tcg/card-data';
import type { PlayerId } from './schema/primitives.js';
import type { MatchState } from './schema/state.js';
import { DEFAULT_RULES_CONFIG } from './config.js';
import { effectiveKeywords, energyCostOf, opponentOf } from './derive.js';
import {
  apply,
  databaseWith,
  deployUnit,
  eventsOfType,
  expectRejected,
  forcePhase,
  giveCard,
  instanceIn,
  keepBothHands,
  makeDeck,
  moveInstance,
  setEnergy,
  stackDeck,
  startMatch,
  testContext,
  testDatabase,
} from './test-fixtures.js';

/**
 * One test per required v0.2 effect handler. Effects that no bundled card uses
 * are exercised with test-only card definitions rather than by inventing cards
 * for the shipped set.
 */

const context = testContext();

describe('static abilities', () => {
  const drone = () => testDatabase().getOrThrow('prototype_drone');

  /** Deploys `radiant_bulwark` — a lord granting Armored to your units. */
  function withBulwark(): { state: MatchState; active: PlayerId; relicInstanceId: string } {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const relic = giveCard(setEnergy(start, active, 5), active, 'radiant_bulwark');
    const state = apply(relic.state, {
      type: 'play_card',
      playerId: active,
      instanceId: relic.instanceId,
    });
    return { state, active, relicInstanceId: relic.instanceId };
  }

  it('reaches units that were already in play', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const unit = deployUnit(start, active, 'prototype_drone');
    const relic = giveCard(setEnergy(unit.state, active, 5), active, 'radiant_bulwark');

    const state = apply(relic.state, {
      type: 'play_card',
      playerId: active,
      instanceId: relic.instanceId,
    });

    expect([...effectiveKeywords(instanceIn(state, unit.instanceId), drone())]).toContain(
      'armored',
    );
    // Nothing is stamped onto the recipient: the bonus is derived, so no
    // one-shot grant event is emitted (CLAUDE.md §17 Q2).
    expect(eventsOfType(state, 'keyword_granted')).toHaveLength(0);
  });

  it('reaches a unit that arrives after it', () => {
    const { state, active } = withBulwark();
    const later = deployUnit(state, active, 'prototype_drone');

    // The board was edited directly, so recalculation has not run yet; any
    // real action settles the state.
    const settled = apply(later.state, { type: 'pass_phase', playerId: active });
    expect([...effectiveKeywords(instanceIn(settled, later.instanceId), drone())]).toContain(
      'armored',
    );
  });

  it('takes the bonus away when the source leaves play', () => {
    const { state, active, relicInstanceId } = withBulwark();
    const unit = deployUnit(state, active, 'prototype_drone');
    const settled = apply(unit.state, { type: 'pass_phase', playerId: active });
    expect([...effectiveKeywords(instanceIn(settled, unit.instanceId), drone())]).toContain(
      'armored',
    );

    const destroyed = moveInstance(settled, relicInstanceId, 'discard');
    const after = apply(destroyed, { type: 'declare_attackers', playerId: active, attacks: [] });
    expect([...effectiveKeywords(instanceIn(after, unit.instanceId), drone())]).not.toContain(
      'armored',
    );
  });
});

describe('modify_cost', () => {
  it('reduces costs for the rest of the turn and expires at end of turn', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const conduit = giveCard(setEnergy(start, active, 9), active, 'overload_conduit');

    const state = apply(conduit.state, {
      type: 'play_card',
      playerId: active,
      instanceId: conduit.instanceId,
    });

    const player = state.players[active];
    expect(player?.costModifiers).toHaveLength(1);
    const champion = testDatabase().getOrThrow('pyre_champion');
    expect(energyCostOf(player!, champion)).toBe(champion.cost! - 2);

    // Play through to the end of the turn; the discount is gone.
    let next = apply(state, { type: 'pass_phase', playerId: active });
    next = apply(next, { type: 'declare_attackers', playerId: active, attacks: [] });
    next = apply(next, { type: 'pass_phase', playerId: active });
    expect(next.activePlayerId).not.toBe(active);
    expect(next.players[active]?.costModifiers).toHaveLength(0);
  });

  it('never lets a cost fall below zero', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const conduit = giveCard(setEnergy(start, active, 9), active, 'overload_conduit');
    const state = apply(conduit.state, {
      type: 'play_card',
      playerId: active,
      instanceId: conduit.instanceId,
    });

    const drone = testDatabase().getOrThrow('prototype_drone');
    expect(energyCostOf(state.players[active]!, drone)).toBe(0);
  });
});

describe('prevent_damage', () => {
  it('absorbs the next damage and then falls away', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const other = opponentOf(start, active);

    const shielded = deployUnit(start, active, 'prototype_guard');
    const ward = giveCard(setEnergy(shielded.state, active, 5), active, 'verdant_ward');

    let state = apply(ward.state, {
      type: 'play_card',
      playerId: active,
      instanceId: ward.instanceId,
    });
    state = apply(state, {
      type: 'submit_choice',
      playerId: active,
      choiceId: state.pendingChoice?.id ?? '',
      selectedIds: [shielded.instanceId],
    });
    expect(instanceIn(state, shielded.instanceId).damageShields[0]?.amount).toBe(3);

    // A 2-damage spell is fully absorbed.
    const scorch = giveCard(setEnergy(state, active, 5), active, 'wither_touch');
    let burned = apply(scorch.state, {
      type: 'play_card',
      playerId: active,
      instanceId: scorch.instanceId,
    });
    burned = apply(burned, {
      type: 'submit_choice',
      playerId: burned.pendingChoice?.playerId ?? active,
      choiceId: burned.pendingChoice?.id ?? '',
      selectedIds: [shielded.instanceId],
    });

    expect(instanceIn(burned, shielded.instanceId).markedDamage).toBe(0);
    expect(instanceIn(burned, shielded.instanceId).damageShields[0]?.amount).toBe(1);
    expect(eventsOfType(burned, 'damage_prevented').length).toBeGreaterThan(0);
    void other;
  });
});

describe('return_to_hand', () => {
  it('bounces an enemy unit and clears its board state', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const other = opponentOf(start, active);

    const victim = deployUnit(start, other, 'prototype_guard', { exhausted: true });
    const binder = giveCard(setEnergy(victim.state, active, 5), active, 'tide_binder');

    let state = apply(binder.state, {
      type: 'play_card',
      playerId: active,
      instanceId: binder.instanceId,
    });
    state = apply(state, {
      type: 'submit_choice',
      playerId: active,
      choiceId: state.pendingChoice?.id ?? '',
      selectedIds: [victim.instanceId],
    });

    const bounced = instanceIn(state, victim.instanceId);
    expect(bounced.zone).toBe('hand');
    expect(bounced.slot).toBeNull();
    expect(bounced.exhausted).toBe(false);
    expect(state.players[other]?.hand).toContain(victim.instanceId);
  });
});

describe('exhaust', () => {
  it('exhausts a chosen enemy unit', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const other = opponentOf(start, active);

    const victim = deployUnit(start, other, 'prototype_guard');
    const snare = giveCard(setEnergy(victim.state, active, 5), active, 'root_snare');

    let state = apply(snare.state, {
      type: 'play_card',
      playerId: active,
      instanceId: snare.instanceId,
    });
    state = apply(state, {
      type: 'submit_choice',
      playerId: active,
      choiceId: state.pendingChoice?.id ?? '',
      selectedIds: [victim.instanceId],
    });

    expect(instanceIn(state, victim.instanceId).exhausted).toBe(true);
  });
});

describe('search_zone', () => {
  it('finds a matching card, reveals it, and reshuffles the deck', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const stacked = stackDeck(start, active, ['scorch', 'prototype_drone']);
    const recall = giveCard(setEnergy(stacked, active, 5), active, 'arcane_recall');

    const paused = apply(recall.state, {
      type: 'play_card',
      playerId: active,
      instanceId: recall.instanceId,
    });

    expect(paused.pendingChoice?.reason).toBe('search_zone');
    // Only spells are legal options.
    for (const entityId of paused.pendingChoice?.validEntityIds ?? []) {
      const definitionId = paused.instances[entityId]?.definitionId ?? '';
      expect(testDatabase().getOrThrow(definitionId).type).toBe('spell');
    }

    const found = paused.pendingChoice?.validEntityIds[0] as string;
    const state = apply(paused, {
      type: 'submit_choice',
      playerId: active,
      choiceId: paused.pendingChoice?.id ?? '',
      selectedIds: [found],
    });

    expect(state.players[active]?.hand).toContain(found);
    expect(eventsOfType(state, 'cards_revealed')).toHaveLength(1);
    expect(eventsOfType(state, 'deck_shuffled').length).toBeGreaterThan(2);
  });

  it('may legally find nothing even when matches exist', () => {
    const start = keepBothHands(
      startMatch({
        decks: [
          makeDeck('prototype_commander_blue', ['scorch']),
          makeDeck('prototype_commander_red', ['scorch']),
        ],
      }),
    );
    const active = start.activePlayerId;
    const recall = giveCard(setEnergy(start, active, 5), active, 'arcane_recall');

    const paused = apply(recall.state, {
      type: 'play_card',
      playerId: active,
      instanceId: recall.instanceId,
    });
    expect(paused.pendingChoice?.minimum).toBe(0);

    const state = apply(paused, {
      type: 'submit_choice',
      playerId: active,
      choiceId: paused.pendingChoice?.id ?? '',
      selectedIds: [],
    });
    expect(state.pendingChoice).toBeNull();
    expect(state.queue).toHaveLength(0);
  });
});

/* ---------------------------------------------- effects with no bundled card */

const TEST_CARDS: CardDefinitionInput[] = [
  {
    schemaVersion: 1,
    id: 'test_rally_call',
    name: 'Test Rally Call',
    type: 'spell',
    colorIdentity: [],
    cost: 0,
    collectible: false,
    effects: [
      {
        type: 'ready',
        target: {
          kind: 'entity',
          selector: {
            zone: 'battlefield',
            controller: 'self',
            count: 'all',
            selection: 'automatic',
          },
        },
      },
    ],
  },
  {
    schemaVersion: 1,
    id: 'test_grave_recall',
    name: 'Test Grave Recall',
    type: 'spell',
    colorIdentity: [],
    cost: 0,
    collectible: false,
    effects: [
      {
        type: 'move_card',
        target: {
          kind: 'entity',
          selector: { zone: 'discard', controller: 'self', count: 1, selection: 'player_choice' },
        },
        toZone: 'hand',
      },
    ],
  },
];

describe('ready and move_card', () => {
  const database = databaseWith(TEST_CARDS);
  const local = { database, config: DEFAULT_RULES_CONFIG };

  it('readies every exhausted friendly unit', () => {
    const start = keepBothHands(startMatch({ database }), local);
    const active = start.activePlayerId;
    const one = deployUnit(start, active, 'prototype_drone', { exhausted: true });
    const two = deployUnit(one.state, active, 'prototype_guard', { exhausted: true });
    const spell = giveCard(setEnergy(two.state, active, 5), active, 'test_rally_call');

    const state = apply(
      spell.state,
      { type: 'play_card', playerId: active, instanceId: spell.instanceId },
      local,
    );

    expect(instanceIn(state, one.instanceId).exhausted).toBe(false);
    expect(instanceIn(state, two.instanceId).exhausted).toBe(false);
    expect(eventsOfType(state, 'unit_readied').length).toBeGreaterThanOrEqual(2);
  });

  it('moves a chosen card between zones', () => {
    const start = keepBothHands(startMatch({ database }), local);
    const active = start.activePlayerId;

    // Put something in the discard by letting a unit die to a spell.
    const victim = deployUnit(start, active, 'prototype_drone');
    const scorch = giveCard(setEnergy(victim.state, active, 9), active, 'scorch');
    let state = apply(
      scorch.state,
      { type: 'play_card', playerId: active, instanceId: scorch.instanceId },
      local,
    );
    state = apply(
      state,
      {
        type: 'submit_choice',
        playerId: active,
        choiceId: state.pendingChoice?.id ?? '',
        selectedIds: [victim.instanceId],
      },
      local,
    );
    expect(instanceIn(state, victim.instanceId).zone).toBe('discard');

    const recall = giveCard(setEnergy(state, active, 5), active, 'test_grave_recall');
    let moved = apply(
      recall.state,
      { type: 'play_card', playerId: active, instanceId: recall.instanceId },
      local,
    );
    moved = apply(
      moved,
      {
        type: 'submit_choice',
        playerId: active,
        choiceId: moved.pendingChoice?.id ?? '',
        selectedIds: [victim.instanceId],
      },
      local,
    );

    expect(instanceIn(moved, victim.instanceId).zone).toBe('hand');
  });
});

describe('activated abilities', () => {
  it('pays energy, honours a once-per-turn limit, and queues its effects', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const commanderId = start.players[active]?.commanderInstanceId ?? '';
    const definitionId = start.instances[commanderId]?.definitionId;

    if (definitionId !== 'prototype_commander_blue') {
      // The other seat holds the Commander with the activated ability.
      const other = opponentOf(start, active);
      expect(start.instances[start.players[other]?.commanderInstanceId ?? '']?.definitionId).toBe(
        'prototype_commander_blue',
      );
      return;
    }

    const funded = setEnergy(start, active, 4);
    const used = apply(funded, {
      type: 'activate_ability',
      playerId: active,
      sourceInstanceId: commanderId,
      abilityId: 'tidal_insight',
    });

    expect(used.players[active]?.energy).toBe(2);
    expect(used.pendingChoice?.reason).toBe('discard_effect');

    const resolved = apply(used, {
      type: 'submit_choice',
      playerId: active,
      choiceId: used.pendingChoice?.id ?? '',
      selectedIds: [used.pendingChoice?.validEntityIds[0] as string],
    });

    const again = expectRejected(resolved, {
      type: 'activate_ability',
      playerId: active,
      sourceInstanceId: commanderId,
      abilityId: 'tidal_insight',
    });
    expect(again.code).toBe('engine/invalid_action');
  });

  it('rejects an ability activated outside a Main Phase', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const commanderId = start.players[active]?.commanderInstanceId ?? '';
    const atAttack = forcePhase(setEnergy(start, active, 4), 'declare_attackers');

    const error = expectRejected(
      atAttack,
      {
        type: 'activate_ability',
        playerId: active,
        sourceInstanceId: commanderId,
        abilityId: 'tidal_insight',
      },
      context,
    );
    expect(error.code).toBe('engine/wrong_phase');
  });
});
