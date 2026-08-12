import type { CardId } from '@tcg/card-data';
import { check, checkEqual, type CardContract } from './harness.js';

/** The six cards Wave 1 shares between factions. */
export const NEUTRAL_CONTRACTS: Record<CardId, CardContract> = {
  crude_bomb: {
    claim: 'deals 3 damage to a Unit',
    run: (table) => {
      const target = table.board('veteran_guard', table.foe);
      table.cast('crude_bomb');
      checkEqual(table.instance(target).markedDamage, 3, 'damage marked on the target');
    },
  },

  dismantle_the_device: {
    claim: 'defeats the active Relic',
    run: (table) => {
      const relic = table.boardRelic('watchtower', table.foe);
      table.cast('dismantle_the_device');
      checkEqual(table.zoneOf(relic), 'discard', "the Relic's zone");
      checkEqual(table.player(table.foe).relics.length, 0, 'Relics left in play');
    },
  },

  hired_mercenary: {
    claim: 'deploys as a 2/3 body',
    run: (table) => {
      const instanceId = table.cast('hired_mercenary');
      checkEqual(table.zoneOf(instanceId), 'battlefield', 'the zone it arrived in');
      checkEqual(table.attackOf(instanceId), 2, 'its ATK');
      checkEqual(table.healthOf(instanceId), 3, 'its Health');
    },
  },

  makeshift_weapon: {
    claim: 'gives a target Unit +2 ATK this turn',
    run: (table) => {
      const target = table.board('veteran_guard');
      const before = table.attackOf(target);
      table.cast('makeshift_weapon');
      checkEqual(table.attackOf(target), before + 2, 'ATK after the buff');
    },
  },

  throwing_knife: {
    claim: 'deals 2 damage to a Unit',
    run: (table) => {
      const target = table.board('veteran_guard', table.foe);
      table.cast('throwing_knife');
      checkEqual(table.instance(target).markedDamage, 2, 'damage marked on the target');
    },
  },

  veteran_guard: {
    claim: 'deploys as a 2/5 body',
    run: (table) => {
      const instanceId = table.cast('veteran_guard');
      check(table.zoneOf(instanceId) === 'battlefield', 'Veteran Guard did not reach the board');
      checkEqual(table.attackOf(instanceId), 2, 'its ATK');
      checkEqual(table.healthOf(instanceId), 5, 'its Health');
    },
  },
};
