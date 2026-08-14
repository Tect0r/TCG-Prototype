import type { CardId } from '@tcg/card-data';
import { check, checkEqual, type CardContract } from './harness.js';

/**
 * The Goblin faction: Tokens, attacking in numbers, and the payoffs that count
 * either.
 *
 * Most of these need a board of Goblins before the card does anything, so the
 * contracts build one out of vanilla Goblins and Tokens rather than out of the
 * card under test â€” a payoff that only counted its own copies would pass a
 * contract that proved nothing.
 */
export const GOBLIN_CONTRACTS: Record<CardId, CardContract> = {
  back_to_the_warrens: {
    claim: 'returns a Goblin Unit card from the discard pile to hand',
    run: (table) => {
      const buried = table.bury('goblin_spearman');
      table.cast('back_to_the_warrens');
      checkEqual(table.zoneOf(buried), 'hand', 'the recovered Goblin');
    },
  },

  call_a_goblin: {
    claim: 'creates one Goblin Token',
    run: (table) => {
      table.cast('call_a_goblin');
      checkEqual(table.unitsOf('goblin_token').length, 1, 'Goblin Tokens created');
    },
  },

  empty_the_tunnels: {
    claim: 'creates four Goblin Tokens',
    run: (table) => {
      table.cast('empty_the_tunnels');
      checkEqual(table.unitsOf('goblin_token').length, 4, 'Goblin Tokens created');
    },
  },

  goblin_banner_thief: {
    claim: 'gains +1 ATK when it attacks alongside another Goblin',
    run: (table) => {
      const thief = table.board('goblin_banner_thief');
      const mate = table.board('goblin_spearman');
      table.attack([thief, mate]);
      checkEqual(table.attackOf(thief), 3, "the Thief's ATK while attacking together");
    },
  },

  goblin_bomb_thrower: {
    claim: 'deals 2 damage to an enemy Unit when it is deployed',
    run: (table) => {
      const target = table.board('veil_adept', table.foe);
      table.cast('goblin_bomb_thrower');
      checkEqual(table.instance(target).markedDamage, 2, 'damage on the enemy Unit');
    },
  },

  goblin_breeder: {
    claim: 'creates a Goblin Token at the beginning of its turn while Ready',
    run: (table) => {
      table.board('goblin_breeder');
      table.endTurn();
      table.endTurn();
      checkEqual(table.unitsOf('goblin_token').length, 1, 'Goblin Tokens created at turn start');
    },
  },

  goblin_bruiser: {
    claim: 'deploys as a 3/2 body',
    run: (table) => {
      const instanceId = table.cast('goblin_bruiser');
      checkEqual(table.attackOf(instanceId), 3, 'its ATK');
      checkEqual(table.healthOf(instanceId), 2, 'its Health');
    },
  },

  goblin_caller: {
    claim: 'creates a Goblin Token when it is defeated',
    run: (table) => {
      const caller = table.board('goblin_caller');
      table.cast('throwing_knife');
      checkEqual(table.zoneOf(caller), 'discard', 'the defeated Caller');
      checkEqual(table.unitsOf('goblin_token').length, 1, 'Goblin Tokens created on defeat');
    },
  },

  goblin_chieftain: {
    claim: 'gives other friendly Goblins +1 ATK',
    run: (table) => {
      const other = table.board('goblin_spearman');
      const chieftain = table.cast('goblin_chieftain');
      checkEqual(table.attackOf(other), 3, "the other Goblin's ATK");
      checkEqual(table.attackOf(chieftain), 3, "the Chieftain's own ATK, which it does not buff");
    },
  },

  goblin_drummer: {
    claim: 'gives an attacking Goblin +2 ATK when at least three attack',
    run: (table) => {
      const drummer = table.board('goblin_drummer');
      const first = table.board('goblin_spearman');
      const second = table.board('goblin_sneak');
      const before = table.attackOf(drummer) + table.attackOf(first) + table.attackOf(second);
      table.attack([drummer, first, second]);
      const after = table.attackOf(drummer) + table.attackOf(first) + table.attackOf(second);
      checkEqual(after, before + 2, 'total ATK across the attacking Goblins');
    },
  },

  goblin_horde_breaker: {
    claim: 'gains +1 ATK for every three other Goblins when it attacks',
    run: (table) => {
      const breaker = table.board('goblin_horde_breaker');
      table.token('goblin_token');
      table.token('goblin_token');
      table.token('goblin_token');
      table.attack([breaker]);
      checkEqual(table.attackOf(breaker), 6, "the Horde Breaker's ATK with three other Goblins");
    },
  },

  goblin_instigator: {
    claim: 'creates a Goblin Token for 1 Energy and an Exhaust',
    run: (table) => {
      const instigator = table.board('goblin_instigator');
      table.activate(instigator, 'instigate');
      checkEqual(table.unitsOf('goblin_token').length, 1, 'Goblin Tokens created');
      check(table.instance(instigator).exhausted, 'the source was not Exhausted');
    },
  },

  goblin_lookout: {
    claim: 'looks three deep for a Goblin card when it is deployed',
    run: (table) => {
      table.stack(['goblin_spearman']);
      table.cast('goblin_lookout');
      checkEqual(table.countIn('hand', 'goblin_spearman'), 1, 'Goblin cards taken to hand');
    },
  },

  goblin_mob_caller: {
    claim: 'creates two Goblin Tokens when it is deployed',
    run: (table) => {
      table.cast('goblin_mob_caller');
      checkEqual(table.unitsOf('goblin_token').length, 2, 'Goblin Tokens created');
    },
  },

  goblin_piledriver: {
    claim: 'gains +1 ATK for each other attacking Goblin',
    run: (table) => {
      const piledriver = table.board('goblin_piledriver');
      const first = table.board('goblin_spearman');
      const second = table.board('goblin_sneak');
      table.attack([piledriver, first, second]);
      checkEqual(table.attackOf(piledriver), 3, "the Piledriver's ATK beside two other Goblins");
    },
  },

  goblin_powder_runner: {
    claim: 'deals 1 damage to an opponent when it is defeated, not to a permanent',
    run: (table) => {
      const runner = table.board('goblin_powder_runner');
      // A Unit and a deployed Commander both sit on the enemy board, so this
      // fails loudly if the blast ever reaches a battlefield permanent again.
      const enemy = table.board('veil_adept', table.foe);
      const commander = table.boardCommander(table.foe);
      const before = table.player(table.foe).health;
      // Steers `throwing_knife` onto the Runner rather than the scenery.
      table.prefer(runner);
      table.cast('throwing_knife');
      checkEqual(table.zoneOf(runner), 'discard', 'the defeated Runner');
      checkEqual(table.player(table.foe).health, before - 1, "the opponent's Health");
      checkEqual(table.instance(enemy).markedDamage, 0, 'damage on the enemy Unit');
      checkEqual(table.instance(commander).markedDamage, 0, 'damage on the enemy Commander');
    },
  },

  goblin_quartermaster: {
    claim: 'deploys as a 3/4 body',
    run: (table) => {
      const instanceId = table.cast('goblin_quartermaster');
      checkEqual(table.attackOf(instanceId), 3, 'its ATK');
      checkEqual(table.healthOf(instanceId), 4, 'its Health');
    },
  },

  goblin_raid_standard: {
    claim: 'gives every attacking Goblin +1 ATK when at least five attack',
    run: (table) => {
      table.boardRelic('goblin_raid_standard');
      const goblins = [
        table.board('goblin_spearman'),
        table.board('goblin_sneak'),
        table.board('goblin_bruiser'),
        table.token('goblin_token'),
        table.token('goblin_token'),
      ];
      const before = goblins.reduce((sum, id) => sum + table.attackOf(id), 0);
      table.attack(goblins);
      const after = goblins.reduce((sum, id) => sum + table.attackOf(id), 0);
      checkEqual(after, before + 5, 'total ATK across the five attacking Goblins');
    },
  },

  goblin_recruiter: {
    claim: 'creates a Goblin Token when it is deployed',
    run: (table) => {
      table.cast('goblin_recruiter');
      checkEqual(table.unitsOf('goblin_token').length, 1, 'Goblin Tokens created');
    },
  },

  goblin_scrapmaster: {
    claim: 'adds one Token the first time Goblin Tokens are created each turn',
    run: (table) => {
      table.board('goblin_scrapmaster');
      table.cast('call_a_goblin');
      checkEqual(table.unitsOf('goblin_token').length, 2, 'Goblin Tokens after the bonus');
    },
  },

  goblin_shieldbearer: {
    claim: 'deploys as a 0/3 body',
    run: (table) => {
      const instanceId = table.cast('goblin_shieldbearer');
      checkEqual(table.attackOf(instanceId), 0, 'its ATK');
      checkEqual(table.healthOf(instanceId), 3, 'its Health');
    },
  },

  goblin_siege_leader: {
    claim: 'creates three Goblin Tokens when it is deployed',
    run: (table) => {
      table.cast('goblin_siege_leader');
      checkEqual(table.unitsOf('goblin_token').length, 3, 'Goblin Tokens created');
    },
  },

  goblin_sneak: {
    claim: 'deploys as a 1/2 body',
    run: (table) => {
      const instanceId = table.cast('goblin_sneak');
      checkEqual(table.attackOf(instanceId), 1, 'its ATK');
      checkEqual(table.healthOf(instanceId), 2, 'its Health');
    },
  },

  goblin_spearman: {
    claim: 'deploys as a 2/1 body',
    run: (table) => {
      const instanceId = table.cast('goblin_spearman');
      checkEqual(table.attackOf(instanceId), 2, 'its ATK');
      checkEqual(table.healthOf(instanceId), 1, 'its Health');
    },
  },

  goblin_tallykeeper: {
    claim: 'adds one Token whenever Goblin Tokens are created',
    run: (table) => {
      table.board('goblin_tallykeeper');
      table.cast('call_a_goblin');
      checkEqual(table.unitsOf('goblin_token').length, 2, 'Goblin Tokens after the bonus');
    },
  },

  goblin_torchrunner: {
    claim: 'attacks the turn it is deployed, because it has Rush',
    run: (table) => {
      const runner = table.cast('goblin_torchrunner');
      check(table.hasKeyword(runner, 'rush'), 'Rush is missing');
      check(table.instance(runner).newlyDeployed, 'it should still be Newly Deployed');
      table.attack([runner]);
      check(
        table.logged('attackers_declared'),
        'the Newly Deployed Rush Unit could not be declared',
      );
    },
  },

  goblin_war_drum: {
    claim: 'adds one Token the first time Goblin Tokens are created each turn',
    run: (table) => {
      table.boardRelic('goblin_war_drum');
      table.cast('call_a_goblin');
      checkEqual(table.unitsOf('goblin_token').length, 2, 'Goblin Tokens after the bonus');
    },
  },

  goblin_warboss: {
    claim: 'creates a Goblin Token for each other Goblin, once each turn',
    commander: 'goblin_warboss',
    run: (table) => {
      const warboss = table.boardCommander();
      table.board('goblin_spearman');
      table.board('goblin_sneak');
      table.activate(warboss, 'muster_the_mob');
      checkEqual(table.unitsOf('goblin_token').length, 2, 'Goblin Tokens mustered');
    },
  },

  goblin_warhorn_captain: {
    claim: 'gives Goblin Tokens created on its turn Rush',
    run: (table) => {
      table.board('goblin_warhorn_captain');
      table.cast('call_a_goblin');
      check(table.hasKeyword(table.onlyUnitOf('goblin_token'), 'rush'), 'the Token has no Rush');
    },
  },

  mob_justice: {
    claim: 'deals damage equal to the number of Goblins controlled',
    run: (table) => {
      table.token('goblin_token');
      table.token('goblin_token');
      const target = table.board('veil_adept', table.foe);
      table.cast('mob_justice');
      checkEqual(table.instance(target).markedDamage, 2, 'damage equal to two Goblins');
    },
  },

  open_the_tunnels: {
    claim: 'creates two Goblin Tokens',
    run: (table) => {
      table.cast('open_the_tunnels');
      checkEqual(table.unitsOf('goblin_token').length, 2, 'Goblin Tokens created');
    },
  },

  rebuild_the_mob: {
    claim: 'creates seven Goblin Tokens when its controller has no Goblins',
    run: (table) => {
      table.cast('rebuild_the_mob');
      checkEqual(
        table.unitsOf('goblin_token').length,
        7,
        'Goblin Tokens created from an empty board',
      );
    },
  },

  scatter: {
    claim: 'makes a friendly Goblin Untargetable by opponents for the turn',
    run: (table) => {
      const reaction = table.give('scatter');
      const goblin = table.board('goblin_spearman');
      table.endTurn();
      const spell = table.give('reconstruct_the_theory', table.foe);
      table.applyOnly({ type: 'play_card', playerId: table.foe, instanceId: spell });
      table.priorityTo(table.self);
      table.react(reaction);
      check(
        table.hasKeyword(goblin, 'untargetable_by_opponents'),
        'the Goblin did not become Untargetable',
      );
    },
  },

  search_the_scrapheap: {
    claim: 'looks four deep and takes a Goblin or Relic card',
    run: (table) => {
      table.stack(['goblin_spearman']);
      table.cast('search_the_scrapheap');
      checkEqual(table.countIn('hand', 'goblin_spearman'), 1, 'Goblin cards taken to hand');
    },
  },

  sound_the_warhorn: {
    claim: 'gives Newly Deployed Goblins Rush for the turn',
    run: (table) => {
      const fresh = table.board('goblin_spearman', table.self, { summoningSick: true });
      table.cast('sound_the_warhorn');
      check(table.hasKeyword(fresh, 'rush'), 'the Newly Deployed Goblin did not gain Rush');
    },
  },

  strength_in_numbers: {
    claim: 'gives friendly Goblins +1 ATK for the turn',
    run: (table) => {
      const first = table.board('goblin_spearman');
      const second = table.board('goblin_sneak');
      table.cast('strength_in_numbers');
      checkEqual(table.attackOf(first), 3, "the first Goblin's ATK");
      checkEqual(table.attackOf(second), 2, "the second Goblin's ATK");
    },
  },
};
