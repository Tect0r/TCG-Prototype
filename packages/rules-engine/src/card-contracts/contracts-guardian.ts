import type { CardId } from '@tcg/card-data';
import { check, checkEqual, type CardContract } from './harness.js';

/**
 * The Bastion (Guardian) faction: blocking, surviving, and being rewarded for
 * both.
 *
 * Nearly half of these fire from combat, so their contracts hand the turn to
 * the opponent, let the opponent attack and block with the card under test.
 * Buffs printed "for that combat" are asserted from the `stats_modified` event
 * rather than from the statline afterwards, because the modifier is gone by the
 * time combat is over — that is the duration doing its job, not the card
 * failing.
 */
export const GUARDIAN_CONTRACTS: Record<CardId, CardContract> = {
  banner_keeper: {
    claim: 'draws and discards the first time a friendly Guardian blocks each turn',
    run: (table) => {
      table.board('banner_keeper');
      const guardian = table.board('bastion_infantry');
      table.endTurn();
      const attacker = table.board('goblin_sneak', table.foe);
      table.attack([attacker], table.foe);
      table.block([{ attacker, blocker: guardian }]);
      check(table.logged('card_discarded', { playerId: table.self }), 'nothing was discarded');
    },
  },

  bastion_armorer: {
    claim: 'gives a friendly Guardian Barrier when deployed',
    run: (table) => {
      const guardian = table.board('bastion_infantry');
      table.cast('bastion_armorer');
      check(table.hasKeyword(guardian, 'barrier'), 'the Guardian did not gain Barrier');
    },
  },

  bastion_armory: {
    claim: 'gives the first Guardian deployed each turn Barrier',
    run: (table) => {
      table.boardRelic('bastion_armory');
      const guardian = table.cast('bastion_infantry');
      check(table.hasKeyword(guardian, 'barrier'), 'the deployed Guardian did not gain Barrier');
    },
  },

  bastion_chaplain: {
    claim: 'restores 2 Health to friendly Units when deployed',
    run: (table) => {
      const hurt = table.board('oathsworn_protector');
      table.cast('throwing_knife');
      checkEqual(table.instance(hurt).markedDamage, 2, 'damage before the Chaplain arrives');
      table.cast('bastion_chaplain');
      checkEqual(table.instance(hurt).markedDamage, 0, 'damage after the Chaplain heals');
    },
  },

  bastion_commander: {
    claim: 'gives the first friendly blocker Health equal to its ATK for that combat',
    commander: 'bastion_commander',
    run: (table) => {
      table.boardCommander();
      const blocker = table.board('bastion_infantry');
      table.endTurn();
      const attacker = table.board('goblin_sneak', table.foe);
      table.attack([attacker], table.foe);
      table.block([{ attacker, blocker }]);
      check(
        table.logged('stats_modified', {
          instanceId: blocker,
          health: 2,
          duration: 'end_of_combat',
        }),
        'the blocker was not given Health equal to its own ATK for that combat',
      );
    },
  },

  bastion_infantry: {
    claim: 'deploys as a 2/3 Guardian',
    run: (table) => {
      const instanceId = table.cast('bastion_infantry');
      checkEqual(table.attackOf(instanceId), 2, 'its ATK');
      checkEqual(table.healthOf(instanceId), 3, 'its Health');
      check(table.hasKeyword(instanceId, 'guardian'), 'Guardian is missing');
    },
  },

  bastion_judgment: {
    claim: 'defeats an Exhausted enemy Unit with 4 Health or less',
    run: (table) => {
      const target = table.board('veil_initiate', table.foe, { exhausted: true });
      table.cast('bastion_judgment');
      checkEqual(table.zoneOf(target), 'discard', 'the judged Unit');
    },
  },

  border_recruit: {
    claim: 'deploys as a 2/1 body',
    run: (table) => {
      const instanceId = table.cast('border_recruit');
      checkEqual(table.attackOf(instanceId), 2, 'its ATK');
      checkEqual(table.healthOf(instanceId), 1, 'its Health');
    },
  },

  call_the_watch: {
    claim: 'creates one Guard Token',
    run: (table) => {
      table.cast('call_the_watch');
      checkEqual(table.unitsOf('guard_token').length, 1, 'Guard Tokens created');
    },
  },

  counteroffensive_captain: {
    claim: 'gives Units that survived as blockers +1 ATK at the beginning of its turn',
    run: (table) => {
      table.board('counteroffensive_captain');
      const blocker = table.board('bastion_infantry');
      table.endTurn();
      const attacker = table.board('goblin_sneak', table.foe);
      table.attack([attacker], table.foe);
      table.block([{ attacker, blocker }]);
      table.endTurn();
      checkEqual(table.attackOf(blocker), 3, "the surviving blocker's ATK on the next turn");
    },
  },

  emergency_interposition: {
    claim: 'Readies a friendly Guardian before blockers are declared',
    run: (table) => {
      const reaction = table.give('emergency_interposition');
      const guardian = table.board('oathsworn_protector', table.self, { exhausted: true });
      table.endTurn();
      const attacker = table.board('goblin_sneak', table.foe);
      table.declareAttack([attacker], table.foe);
      table.priorityTo(table.self);
      table.react(reaction);
      check(!table.instance(guardian).exhausted, 'the Guardian was not Readied');
    },
  },

  field_medic: {
    claim: 'restores 1 Health to the first other friendly Unit to survive combat each turn',
    run: (table) => {
      table.board('field_medic');
      const blocker = table.board('oathsworn_protector');
      table.endTurn();
      const attacker = table.board('goblin_spearman', table.foe);
      table.attack([attacker], table.foe);
      table.block([{ attacker, blocker }]);
      // Took two from the attacker, healed one back.
      checkEqual(table.instance(blocker).markedDamage, 1, 'damage left on the survivor');
    },
  },

  formation_tactician: {
    claim: 'Readies another friendly Guardian that survived combat',
    run: (table) => {
      table.board('formation_tactician');
      const guardian = table.board('oathsworn_protector');
      table.attack([guardian]);
      check(table.instance(guardian).exhausted, 'attacking should have Exhausted it');
      table.block([], table.foe);
      check(!table.instance(guardian).exhausted, 'the surviving Guardian was not Readied');
    },
  },

  fortress_gate: {
    claim: 'creates a Guard Token at the beginning of its turn while short of two',
    run: (table) => {
      table.boardRelic('fortress_gate');
      table.endTurn();
      table.endTurn();
      checkEqual(table.unitsOf('guard_token').length, 1, 'Guard Tokens created at turn start');
    },
  },

  gate_sentinel: {
    claim: 'deploys as a 1/6 Guardian',
    run: (table) => {
      const instanceId = table.cast('gate_sentinel');
      checkEqual(table.healthOf(instanceId), 6, 'its Health');
      check(table.hasKeyword(instanceId, 'guardian'), 'Guardian is missing');
    },
  },

  hold_the_line: {
    claim: 'gives a blocking Unit +0/+3 for that combat',
    run: (table) => {
      const reaction = table.give('hold_the_line');
      const blocker = table.board('bastion_infantry');
      table.endTurn();
      const attacker = table.board('goblin_sneak', table.foe);
      table.attack([attacker], table.foe);
      table.declareBlock([{ attacker, blocker }]);
      table.priorityTo(table.self);
      table.react(reaction);
      check(
        table.logged('stats_modified', {
          instanceId: blocker,
          health: 3,
          duration: 'end_of_combat',
        }),
        'the blocker was not given +0/+3 for that combat',
      );
    },
  },

  ironbound_knight: {
    claim: 'deploys as a 5/6 Guardian with Barrier',
    run: (table) => {
      const instanceId = table.cast('ironbound_knight');
      checkEqual(table.attackOf(instanceId), 5, 'its ATK');
      check(table.hasKeyword(instanceId, 'guardian'), 'Guardian is missing');
      check(table.hasKeyword(instanceId, 'barrier'), 'Barrier is missing');
    },
  },

  living_bulwark: {
    claim: 'gains +2 ATK permanently when it survives combat as a blocker',
    run: (table) => {
      const bulwark = table.board('living_bulwark');
      table.endTurn();
      const attacker = table.board('goblin_sneak', table.foe);
      table.attack([attacker], table.foe);
      table.block([{ attacker, blocker: bulwark }]);
      checkEqual(table.attackOf(bulwark), 8, "the Bulwark's ATK after surviving a block");
    },
  },

  oathsworn_protector: {
    claim: 'deploys as a 3/6 Guardian',
    run: (table) => {
      const instanceId = table.cast('oathsworn_protector');
      checkEqual(table.attackOf(instanceId), 3, 'its ATK');
      checkEqual(table.healthOf(instanceId), 6, 'its Health');
      check(table.hasKeyword(instanceId, 'guardian'), 'Guardian is missing');
    },
  },

  orderly_withdrawal: {
    claim: 'returns a surviving friendly blocker to hand and draws a card',
    run: (table) => {
      const reaction = table.give('orderly_withdrawal');
      const blocker = table.board('oathsworn_protector');
      table.endTurn();
      const attacker = table.board('goblin_sneak', table.foe);
      table.attack([attacker], table.foe);
      table.declareBlock([{ attacker, blocker }]);
      table.priorityTo(table.self);
      table.react(reaction);
      checkEqual(table.zoneOf(blocker), 'hand', 'the withdrawn blocker');
      check(table.logged('card_drawn', { playerId: table.self }), 'no card was drawn');
    },
  },

  patrol_scout: {
    claim: 'looks three deep for a Guardian card when deployed',
    run: (table) => {
      table.stack(['bastion_infantry']);
      table.cast('patrol_scout');
      checkEqual(table.countIn('hand', 'bastion_infantry'), 1, 'Guardian cards taken to hand');
    },
  },

  punish_the_assault: {
    claim: 'deals 2 damage to a Unit that attacked, after combat',
    run: (table) => {
      const reaction = table.give('punish_the_assault');
      table.endTurn();
      const attacker = table.board('veil_adept', table.foe);
      table.attack([attacker], table.foe);
      table.declareBlock([]);
      table.priorityTo(table.self);
      table.react(reaction);
      checkEqual(table.instance(attacker).markedDamage, 2, 'damage on the attacker');
    },
  },

  refuge_warden: {
    claim: 'creates two Guard Tokens when deployed',
    run: (table) => {
      table.cast('refuge_warden');
      checkEqual(table.unitsOf('guard_token').length, 2, 'Guard Tokens created');
    },
  },

  reinforce_the_gate: {
    claim: 'creates two Guard Tokens',
    run: (table) => {
      table.cast('reinforce_the_gate');
      checkEqual(table.unitsOf('guard_token').length, 2, 'Guard Tokens created');
    },
  },

  retaliating_guard: {
    claim: 'deals 1 damage to an opponent after surviving combat as a blocker',
    run: (table) => {
      const guard = table.board('retaliating_guard');
      table.endTurn();
      const before = table.player(table.foe).health;
      const attacker = table.board('goblin_sneak', table.foe);
      table.attack([attacker], table.foe);
      table.block([{ attacker, blocker: guard }]);
      checkEqual(table.player(table.foe).health, before - 1, "the opponent's Health");
    },
  },

  shield_formation: {
    claim: 'gives friendly Guardians +0/+2 until the beginning of the next turn',
    run: (table) => {
      const guardian = table.board('bastion_infantry');
      table.cast('shield_formation');
      checkEqual(table.healthOf(guardian), 5, "the Guardian's Health");
    },
  },

  shield_page: {
    claim: 'gives another friendly Unit Barrier when deployed',
    run: (table) => {
      const other = table.board('bastion_infantry');
      table.cast('shield_page');
      check(table.hasKeyword(other, 'barrier'), 'the other Unit did not gain Barrier');
    },
  },

  shieldwall_sergeant: {
    claim: 'gives other friendly Guardians +0/+1',
    run: (table) => {
      const guardian = table.board('bastion_infantry');
      table.cast('shieldwall_sergeant');
      checkEqual(table.healthOf(guardian), 4, "the other Guardian's Health");
    },
  },

  spear_guard: {
    claim: 'gains +1 ATK for the combat it blocks in',
    run: (table) => {
      const guard = table.board('spear_guard');
      table.endTurn();
      const attacker = table.board('goblin_sneak', table.foe);
      table.attack([attacker], table.foe);
      table.block([{ attacker, blocker: guard }]);
      check(
        table.logged('stats_modified', {
          instanceId: guard,
          attack: 1,
          duration: 'end_of_combat',
        }),
        'the blocker was not given +1 ATK for that combat',
      );
    },
  },

  stand_united: {
    claim: 'gives friendly Units +1 ATK for each Unit that survived as a blocker',
    run: (table) => {
      const blocker = table.board('oathsworn_protector');
      table.endTurn();
      const attacker = table.board('goblin_sneak', table.foe);
      table.attack([attacker], table.foe);
      table.block([{ attacker, blocker }]);
      table.endTurn();
      table.cast('stand_united');
      checkEqual(table.attackOf(blocker), 4, "the survivor's ATK after the rally");
    },
  },

  standfast_cadet: {
    claim: 'deploys as a 3/2 body',
    run: (table) => {
      const instanceId = table.cast('standfast_cadet');
      checkEqual(table.attackOf(instanceId), 3, 'its ATK');
      checkEqual(table.healthOf(instanceId), 2, 'its Health');
    },
  },

  tactical_assessment: {
    claim: 'looks four deep for a Guardian Unit or a Reaction Spell',
    run: (table) => {
      table.stack(['bastion_infantry']);
      table.cast('tactical_assessment');
      checkEqual(table.countIn('hand', 'bastion_infantry'), 1, 'Guardian cards taken to hand');
    },
  },

  unbreakable_formation: {
    claim: 'gives friendly Guardians Barrier until the end of combat',
    run: (table) => {
      const reaction = table.give('unbreakable_formation');
      const guardian = table.board('bastion_infantry');
      table.endTurn();
      const attacker = table.board('goblin_sneak', table.foe);
      table.declareAttack([attacker], table.foe);
      table.priorityTo(table.self);
      table.react(reaction);
      check(table.hasKeyword(guardian, 'barrier'), 'the Guardian did not gain Barrier');
    },
  },

  vigilant_squire: {
    claim: 'gains +0/+1 for the combat it blocks in',
    run: (table) => {
      const squire = table.board('vigilant_squire');
      table.endTurn();
      const attacker = table.board('goblin_sneak', table.foe);
      table.attack([attacker], table.foe);
      table.block([{ attacker, blocker: squire }]);
      check(
        table.logged('stats_modified', {
          instanceId: squire,
          health: 1,
          duration: 'end_of_combat',
        }),
        'the blocker was not given +0/+1 for that combat',
      );
    },
  },

  wall_initiate: {
    claim: 'deploys as a 0/3 Guardian',
    run: (table) => {
      const instanceId = table.cast('wall_initiate');
      checkEqual(table.healthOf(instanceId), 3, 'its Health');
      check(table.hasKeyword(instanceId, 'guardian'), 'Guardian is missing');
    },
  },

  watch_captain: {
    claim: 'gives other friendly Guardians +1 ATK',
    run: (table) => {
      const guardian = table.board('bastion_infantry');
      table.cast('watch_captain');
      checkEqual(table.attackOf(guardian), 3, "the other Guardian's ATK");
    },
  },

  watchtower: {
    claim: "looks at the top two cards at the end of an opponent's turn after a block",
    run: (table) => {
      table.boardRelic('watchtower');
      const blocker = table.board('oathsworn_protector');
      table.endTurn();
      const attacker = table.board('goblin_sneak', table.foe);
      table.attack([attacker], table.foe);
      table.block([{ attacker, blocker }]);
      table.endTurn();
      check(
        table.logged('effect_resolved', { effectType: 'search_zone' }),
        'the end-of-turn look never resolved',
      );
    },
  },
};
