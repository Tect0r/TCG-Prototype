import type { CardId } from '@tcg/card-data';
import { check, checkEqual, type CardContract } from './harness.js';

/**
 * The Containment (control) faction: exhausting, bouncing, countering and
 * looking at the top of the deck.
 *
 * Several of these are Reactions, so their contracts hand the turn to the
 * opponent first and answer the window the opponent's own action opened —
 * a Reaction played on its controller's turn would be testing a card nobody
 * can play.
 */
export const CONTROL_CONTRACTS: Record<CardId, CardContract> = {
  arcane_snare: {
    claim: 'Exhausts a Unit',
    run: (table) => {
      const target = table.board('veil_adept', table.foe);
      table.cast('arcane_snare');
      check(table.instance(target).exhausted, 'the target was not Exhausted');
    },
  },

  archive_acolyte: {
    claim: 'deploys as a 0/3 body',
    run: (table) => {
      const instanceId = table.cast('archive_acolyte');
      checkEqual(table.attackOf(instanceId), 0, 'its ATK');
      checkEqual(table.healthOf(instanceId), 3, 'its Health');
    },
  },

  bound_anomaly: {
    claim: 'deploys as a 7/8 with Barrier and Overwhelm',
    run: (table) => {
      const instanceId = table.cast('bound_anomaly');
      checkEqual(table.attackOf(instanceId), 7, 'its ATK');
      checkEqual(table.healthOf(instanceId), 8, 'its Health');
      check(table.hasKeyword(instanceId, 'barrier'), 'Barrier is missing');
      check(table.hasKeyword(instanceId, 'overwhelm'), 'Overwhelm is missing');
    },
  },

  calculated_response: {
    claim: 'counters an opponent Spell whose controller declines to pay 2 more',
    run: (table) => {
      const reaction = table.give('calculated_response');
      table.endTurn();
      const spell = table.give('reconstruct_the_theory', table.foe);
      table.applyOnly({ type: 'play_card', playerId: table.foe, instanceId: spell });
      table.priorityTo(table.self);
      table.react(reaction);
      check(table.logged('card_countered', { instanceId: spell }), 'the Spell was not countered');
    },
  },

  chief_containment_scholar: {
    claim: 'makes the first Reaction of each of its turns cost 1 less while deployed',
    commander: 'chief_containment_scholar',
    run: (table) => {
      const commander = table.playCommander();
      checkEqual(table.zoneOf(commander), 'battlefield', 'the Commander zone after deploying');
      const reaction = table.give('narrow_denial');
      checkEqual(table.costOf(reaction), 1, "Narrow Denial's discounted cost");
    },
  },

  containment_array: {
    claim: 'makes the first enemy Unit deployed each turn enter Exhausted',
    run: (table) => {
      table.boardRelic('containment_array');
      table.endTurn();
      const arriving = table.cast('veil_adept', table.foe);
      check(table.instance(arriving).exhausted, 'the arriving enemy Unit was not Exhausted');
      check(table.logged('arrival_replaced'), 'no arrival replacement was recorded');
    },
  },

  containment_guard: {
    claim: 'deploys as a 1/4 body',
    run: (table) => {
      const instanceId = table.cast('containment_guard');
      checkEqual(table.attackOf(instanceId), 1, 'its ATK');
      checkEqual(table.healthOf(instanceId), 4, 'its Health');
    },
  },

  containment_pulse: {
    claim: 'Exhausts every Token of one definition a player controls',
    run: (table) => {
      const first = table.token('goblin_token', table.foe);
      const second = table.token('goblin_token', table.foe);
      table.cast('containment_pulse');
      check(table.instance(first).exhausted, 'the first Token was not Exhausted');
      check(table.instance(second).exhausted, 'the second Token was not Exhausted');
    },
  },

  containment_warden: {
    claim: 'Exhausts up to two enemy Units when deployed',
    run: (table) => {
      const first = table.board('veil_adept', table.foe);
      const second = table.board('veil_initiate', table.foe);
      table.cast('containment_warden');
      check(table.instance(first).exhausted, 'the first enemy Unit was not Exhausted');
      check(table.instance(second).exhausted, 'the second enemy Unit was not Exhausted');
    },
  },

  controlled_collapse: {
    claim: 'deals 2 damage to every Unit',
    run: (table) => {
      const mine = table.board('veteran_guard');
      const theirs = table.board('veil_adept', table.foe);
      table.cast('controlled_collapse');
      checkEqual(table.instance(mine).markedDamage, 2, 'damage on my own Unit');
      checkEqual(table.instance(theirs).markedDamage, 2, 'damage on the enemy Unit');
    },
  },

  field_analyst: {
    claim: 'looks at the top three cards and takes a Spell or Relic when deployed',
    run: (table) => {
      table.stack(['crude_bomb']);
      table.cast('field_analyst');
      checkEqual(table.countIn('hand', 'crude_bomb'), 1, 'copies of the revealed Spell in hand');
    },
  },

  forced_recall: {
    claim: "returns up to two Exhausted Units to their owners' hands",
    run: (table) => {
      const first = table.board('veil_adept', table.foe, { exhausted: true });
      const second = table.board('veil_initiate', table.foe, { exhausted: true });
      table.cast('forced_recall');
      checkEqual(table.zoneOf(first), 'hand', "the first Unit's zone");
      checkEqual(table.zoneOf(second), 'hand', "the second Unit's zone");
    },
  },

  inventory_audit: {
    claim: 'draws two cards, then discards one',
    run: (table) => {
      const before = table.handSize();
      table.cast('inventory_audit');
      // `cast` is hand-neutral in itself — the Spell arrives and leaves — so the
      // whole change is two drawn less one discarded.
      checkEqual(table.handSize(), before + 1, 'hand size after drawing two and discarding one');
      check(table.logged('card_discarded', { playerId: table.self }), 'nothing was discarded');
    },
  },

  laboratory_familiar: {
    claim: 'looks at the top two cards when it is defeated',
    run: (table) => {
      const familiar = table.board('laboratory_familiar');
      table.cast('throwing_knife');
      checkEqual(table.zoneOf(familiar), 'discard', 'the defeated body');
      check(
        table.logged('effect_resolved', { effectType: 'search_zone' }),
        'the defeat trigger did not look at the deck',
      );
    },
  },

  mass_displacement: {
    claim: "returns every Newly Deployed attacking Unit to its owner's hand",
    run: (table) => {
      const reaction = table.give('mass_displacement');
      table.endTurn();
      const rusher = table.board('goblin_torchrunner', table.foe, { summoningSick: true });
      table.declareAttack([rusher], table.foe);
      table.priorityTo(table.self);
      table.react(reaction);
      checkEqual(table.zoneOf(rusher), 'hand', 'the attacking Rush Unit');
    },
  },

  narrow_denial: {
    claim: 'counters an opponent Spell costing 2 or less',
    run: (table) => {
      const reaction = table.give('narrow_denial');
      table.endTurn();
      const spell = table.give('throwing_knife', table.foe);
      table.board('veil_adept');
      table.applyOnly({ type: 'play_card', playerId: table.foe, instanceId: spell });
      table.priorityTo(table.self);
      table.react(reaction);
      check(table.logged('card_countered', { instanceId: spell }), 'the Spell was not countered');
    },
  },

  nullmage_apprentice: {
    claim: 'discounts Reaction Spells by 1 while it is Ready',
    run: (table) => {
      const apprentice = table.board('nullmage_apprentice');
      const reaction = table.give('narrow_denial');
      checkEqual(table.costOf(reaction), 1, 'the discounted Reaction cost');
      table.exhaust(apprentice);
      checkEqual(table.costOf(reaction), 2, 'the cost once the Unit is Exhausted');
    },
  },

  observation_lens: {
    claim: 'looks at the top two cards at the end of a turn with no Unit deployed',
    run: (table) => {
      table.boardRelic('observation_lens');
      table.endTurn();
      check(
        table.logged('effect_resolved', { effectType: 'search_zone' }),
        'the end-of-turn look never resolved',
      );
    },
  },

  phase_withdrawal: {
    claim: 'returns one of its own Units to hand and draws a card',
    run: (table) => {
      const reaction = table.give('phase_withdrawal');
      const unit = table.board('veil_adept');
      table.endTurn();
      const spell = table.give('reconstruct_the_theory', table.foe);
      table.applyOnly({ type: 'play_card', playerId: table.foe, instanceId: spell });
      table.priorityTo(table.self);
      table.react(reaction);
      checkEqual(table.zoneOf(unit), 'hand', 'the withdrawn Unit');
      check(table.logged('card_drawn', { playerId: table.self }), 'no card was drawn');
    },
  },

  probe_the_future: {
    claim: 'looks five deep and takes a Reaction Spell',
    run: (table) => {
      table.stack(['narrow_denial']);
      table.cast('probe_the_future');
      checkEqual(table.countIn('hand', 'narrow_denial'), 1, 'copies of the Reaction in hand');
    },
  },

  quick_study: {
    claim: 'draws a card, then puts one from hand on the bottom of the deck',
    run: (table) => {
      const before = table.handSize();
      table.cast('quick_study');
      // Drew one and put one back: the hand ends where it started.
      checkEqual(table.handSize(), before, 'hand size after the swap');
      check(
        table.logged('card_moved', { playerId: table.self, fromZone: 'hand', toZone: 'deck' }),
        'nothing went back to the deck',
      );
    },
  },

  reconstruct_the_theory: {
    claim: 'draws three cards',
    run: (table) => {
      const before = table.handSize();
      table.cast('reconstruct_the_theory');
      checkEqual(table.handSize(), before + 3, 'hand size after drawing three');
    },
  },

  return_to_the_veil: {
    claim: "returns an enemy Unit costing 3 or less to its owner's hand",
    run: (table) => {
      const target = table.board('veil_skirmisher', table.foe);
      table.cast('return_to_the_veil');
      checkEqual(table.zoneOf(target), 'hand', 'the bounced Unit');
    },
  },

  rift_displacer: {
    claim: 'bounces an enemy Unit costing 2 or less when deployed',
    run: (table) => {
      const target = table.board('veil_skirmisher', table.foe);
      table.cast('rift_displacer');
      checkEqual(table.zoneOf(target), 'hand', 'the bounced Unit');
    },
  },

  rift_scholar: {
    claim: 'draws then discards when deployed',
    run: (table) => {
      const before = table.handSize();
      table.cast('rift_scholar');
      checkEqual(table.handSize(), before, 'hand size after the loot');
      check(table.logged('card_discarded', { playerId: table.self }), 'nothing was discarded');
    },
  },

  seal_the_rift: {
    claim: 'defeats an enemy Unit with 4 ATK or more',
    run: (table) => {
      const target = table.board('veil_adept', table.foe);
      table.cast('seal_the_rift');
      checkEqual(table.zoneOf(target), 'discard', 'the destroyed Unit');
    },
  },

  senior_researcher: {
    claim: 'draws two and discards one when deployed',
    run: (table) => {
      const before = table.handSize();
      table.cast('senior_researcher');
      checkEqual(table.handSize(), before + 1, 'hand size after drawing two and discarding one');
      check(table.logged('card_discarded', { playerId: table.self }), 'nothing was discarded');
    },
  },

  stasis_keeper: {
    claim: 'stops a Unit it blocked from readying at its next Ready Step',
    run: (table) => {
      const keeper = table.board('stasis_keeper');
      table.endTurn();
      const attacker = table.board('veil_adept', table.foe);
      table.attack([attacker], table.foe);
      table.block([{ attacker, blocker: keeper }]);
      check(table.instance(attacker).readySkip !== null, 'no ready skip was stored');
      table.endTurn();
      table.endTurn();
      check(table.instance(attacker).exhausted, 'the blocked attacker readied anyway');
      check(table.logged('ready_prevented'), 'no ready prevention was recorded');
    },
  },

  stasis_seal: {
    claim: 'Exhausts a Unit and stops it readying at its next Ready Step',
    run: (table) => {
      const target = table.board('veil_adept', table.foe);
      table.cast('stasis_seal');
      check(table.instance(target).exhausted, 'the target was not Exhausted');
      check(table.instance(target).readySkip !== null, 'no ready skip was stored');
    },
  },

  static_adept: {
    claim: 'Exhausts an enemy Unit with 2 ATK or less when deployed',
    run: (table) => {
      const target = table.board('veil_initiate', table.foe);
      table.cast('static_adept');
      check(table.instance(target).exhausted, 'the enemy Unit was not Exhausted');
    },
  },

  temporal_anchor: {
    claim: 'keeps one enemy Unit Exhausted each turn for 1 Energy',
    run: (table) => {
      table.boardRelic('temporal_anchor');
      const held = table.board('veil_adept', table.foe, { exhausted: true });
      table.endTurn();
      check(table.instance(held).exhausted, 'the enemy Unit readied anyway');
      check(table.logged('ready_prevented'), 'no ready prevention was recorded');
    },
  },

  total_recall: {
    claim: "returns every non-Commander Unit to its owner's hand",
    run: (table) => {
      const mine = table.board('veil_adept');
      const theirs = table.board('veil_initiate', table.foe);
      const tokenId = table.token('goblin_token', table.foe);
      table.cast('total_recall');
      checkEqual(table.zoneOf(mine), 'hand', 'my own Unit');
      checkEqual(table.zoneOf(theirs), 'hand', 'the enemy Unit');
      check(!table.exists(tokenId), 'the Token should have ceased existing');
    },
  },

  veil_adept: {
    claim: 'deploys as a 4/5 body',
    run: (table) => {
      const instanceId = table.cast('veil_adept');
      checkEqual(table.attackOf(instanceId), 4, 'its ATK');
      checkEqual(table.healthOf(instanceId), 5, 'its Health');
    },
  },

  veil_initiate: {
    claim: 'deploys as a 1/2 body',
    run: (table) => {
      const instanceId = table.cast('veil_initiate');
      checkEqual(table.attackOf(instanceId), 1, 'its ATK');
      checkEqual(table.healthOf(instanceId), 2, 'its Health');
    },
  },

  veil_skirmisher: {
    claim: 'deploys as a 3/2 body',
    run: (table) => {
      const instanceId = table.cast('veil_skirmisher');
      checkEqual(table.attackOf(instanceId), 3, 'its ATK');
      checkEqual(table.healthOf(instanceId), 2, 'its Health');
    },
  },

  ward_scribe: {
    claim: 'deploys as a 3/4 with Barrier',
    run: (table) => {
      const instanceId = table.cast('ward_scribe');
      checkEqual(table.attackOf(instanceId), 3, 'its ATK');
      check(table.hasKeyword(instanceId, 'barrier'), 'Barrier is missing');
    },
  },
};
