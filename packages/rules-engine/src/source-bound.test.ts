import { describe, expect, it } from 'vitest';
import { cardDefinitionSchema } from '@tcg/card-data';
import { currentAttack, currentHealth, definitionOf, energyCostOf, playerOf } from './derive.js';
import {
  apply,
  databaseWith,
  deployUnit,
  eventsOfType,
  giveCard,
  instanceIn,
  keepBothHands,
  moveInstance,
  setEnergy,
  startMatch,
  testContext,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';

/**
 * `while_source_present`: a modifier that ends when the card granting it leaves
 * play (readiness gate B1).
 *
 * The duration was in the vocabulary and explained to players, but nothing ever
 * expired it, so in practice it meant `permanent`. It exists because
 * `staticAbilities` cannot express "the *chosen* unit gets +2/+0 while this
 * relic is out" — a static ability applies to everything matching a filter, not
 * to one unit somebody picked.
 */
const CARDS = [
  {
    schemaVersion: 3,
    id: 'sb_relic_buff',
    name: 'Bound Relic',
    type: 'relic',
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
            count: 1,
            selection: 'automatic',
          },
        },
        attack: 2,
        health: 3,
        duration: 'while_source_present',
      },
    ],
    displayText: 'A friendly unit gets +2/+3 while this relic is in play.',
  },
  {
    schemaVersion: 3,
    id: 'sb_relic_keyword',
    name: 'Bound Banner',
    type: 'relic',
    colorIdentity: [],
    cost: 1,
    effects: [
      {
        type: 'grant_keyword',
        target: {
          kind: 'entity',
          selector: {
            zone: 'battlefield',
            controller: 'self',
            filter: { cardTypes: ['unit'] },
            count: 1,
            selection: 'automatic',
          },
        },
        keyword: 'guardian',
        duration: 'while_source_present',
      },
    ],
    displayText: 'A friendly unit gains Guardian while this relic is in play.',
  },
  {
    schemaVersion: 3,
    id: 'sb_relic_shield',
    name: 'Bound Ward',
    type: 'relic',
    colorIdentity: [],
    cost: 1,
    effects: [
      {
        type: 'prevent_damage',
        target: { kind: 'player', relation: 'self', selection: 'automatic' },
        amount: 3,
        duration: 'while_source_present',
      },
    ],
    displayText: 'Prevent the next 3 damage to you while this relic is in play.',
  },
  {
    schemaVersion: 3,
    id: 'sb_relic_discount',
    name: 'Bound Ledger',
    type: 'relic',
    colorIdentity: [],
    cost: 1,
    effects: [{ type: 'modify_cost', player: 'self', delta: -1, duration: 'while_source_present' }],
    displayText: 'Your cards cost 1 less while this relic is in play.',
  },
] as const;

const database = databaseWith(CARDS as never);
const context = { ...testContext(), database };

/** Deploys a unit, then plays the named relic so its effect lands on the unit. */
function withRelic(definitionId: string): {
  state: MatchState;
  player: string;
  unitId: string;
  relicId: string;
} {
  const start = keepBothHands(startMatch({ database }), context);
  const player = start.activePlayerId;
  const unit = deployUnit(start, player, 'prototype_drone');
  const placed = giveCard(setEnergy(unit.state, player, 8), player, definitionId);
  const state = apply(
    placed.state,
    { type: 'play_card', playerId: player, instanceId: placed.instanceId },
    context,
  );
  return { state, player, unitId: unit.instanceId, relicId: placed.instanceId };
}

describe('while_source_present stat modifiers', () => {
  it('applies while the source is on the battlefield', () => {
    const { state, unitId } = withRelic('sb_relic_buff');
    const instance = instanceIn(state, unitId);
    const definition = definitionOf(database, instance);

    expect(currentAttack(instance, definition)).toBe((definition.attack ?? 0) + 2);
    expect(currentHealth(instance, definition)).toBe((definition.health ?? 0) + 3);
  });

  it('ends the moment the source leaves play', () => {
    const setup = withRelic('sb_relic_buff');
    const after = apply(
      moveInstance(setup.state, setup.relicId, 'discard'),
      // Any action re-runs state-based checks; passing is the smallest one.
      { type: 'pass_phase', playerId: setup.player },
      context,
    );

    const instance = instanceIn(after, setup.unitId);
    const definition = definitionOf(database, instance);
    expect(instance.statModifiers).toEqual([]);
    expect(currentAttack(instance, definition)).toBe(definition.attack ?? 0);
    expect(eventsOfType(after, 'modifiers_expired').length).toBeGreaterThan(0);
  });

  it('defeats an already-damaged unit when the Health bonus goes with it', () => {
    // `prototype_drone` is 1/1; the relic makes it 3/4. Three marked damage is
    // survivable at 4 Health and lethal at 1, so removing the source has to kill
    // it in the very next state-based check rather than a step later.
    const setup = withRelic('sb_relic_buff');
    let state = setup.state;
    const damaged = structuredClone(state);
    const target = damaged.instances[setup.unitId];
    expect(target).toBeDefined();
    if (target) target.markedDamage = 3;
    state = damaged;
    expect(instanceIn(state, setup.unitId).zone).toBe('battlefield');

    const after = apply(
      moveInstance(state, setup.relicId, 'discard'),
      { type: 'pass_phase', playerId: setup.player },
      context,
    );

    expect(after.instances[setup.unitId]?.zone).toBe('discard');
    expect(
      eventsOfType(after, 'unit_defeated').filter((event) => event.instanceId === setup.unitId),
    ).toHaveLength(1);
  });
});

describe('while_source_present on the other modifier kinds', () => {
  it('expires a granted keyword', () => {
    const setup = withRelic('sb_relic_keyword');
    expect(instanceIn(setup.state, setup.unitId).grantedKeywords).toHaveLength(1);

    const after = apply(
      moveInstance(setup.state, setup.relicId, 'discard'),
      { type: 'pass_phase', playerId: setup.player },
      context,
    );
    expect(instanceIn(after, setup.unitId).grantedKeywords).toEqual([]);
  });

  it('expires a damage shield sitting on a player', () => {
    const setup = withRelic('sb_relic_shield');
    expect(playerOf(setup.state, setup.player).damageShields).toHaveLength(1);

    const after = apply(
      moveInstance(setup.state, setup.relicId, 'discard'),
      { type: 'pass_phase', playerId: setup.player },
      context,
    );
    expect(playerOf(after, setup.player).damageShields).toEqual([]);
  });

  it('expires a cost modifier', () => {
    const setup = withRelic('sb_relic_discount');
    const cheap = database.getOrThrow('prototype_drone');
    expect(energyCostOf(playerOf(setup.state, setup.player), cheap)).toBe(
      Math.max(0, (cheap.cost ?? 0) - 1),
    );

    const after = apply(
      moveInstance(setup.state, setup.relicId, 'discard'),
      { type: 'pass_phase', playerId: setup.player },
      context,
    );
    expect(playerOf(after, setup.player).costModifiers).toEqual([]);
    expect(energyCostOf(playerOf(after, setup.player), cheap)).toBe(cheap.cost ?? 0);
  });
});

describe('a source that cannot persist is rejected at authoring time', () => {
  const spellShape = {
    schemaVersion: 3,
    id: 'sb_bad_spell',
    name: 'Impossible Buff',
    type: 'spell',
    colorIdentity: [],
    cost: 1,
    effects: [
      {
        type: 'modify_stats',
        target: {
          kind: 'entity',
          selector: { zone: 'battlefield', controller: 'self', count: 1 },
        },
        attack: 2,
        health: 0,
        duration: 'while_source_present',
      },
    ],
  };

  it('refuses a spell whose own effect outlives it', () => {
    const result = cardDefinitionSchema.safeParse(spellShape);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message).join(' ')).toMatch(
      /cannot sustain a `while_source_present` modifier/,
    );
  });

  it('accepts the same effect with a duration the card can actually keep', () => {
    const fixed = {
      ...spellShape,
      effects: [{ ...spellShape.effects[0], duration: 'end_of_turn' }],
    };
    expect(cardDefinitionSchema.safeParse(fixed).success).toBe(true);
  });

  it('still accepts it on a permanent, which can', () => {
    const relic = { ...spellShape, id: 'sb_ok_relic', type: 'relic', name: 'Possible Buff' };
    expect(cardDefinitionSchema.safeParse(relic).success).toBe(true);
  });
});
