import type { CardId } from '@tcg/card-data';
import { check, checkEqual, type CardContract } from './harness.js';

/**
 * The Ossuary (sacrifice) faction: giving Units up on purpose and being paid
 * for it, plus the Thrall Tokens that make the fodder.
 *
 * A sacrifice payoff needs something to sacrifice, and a defeat payoff needs
 * something to die, so most of these build a fodder board first and then aim
 * the removal at it with `prefer` — the point of the contract is what the card
 * does when its condition is met, not which Unit a default policy happened to
 * pick.
 */
export const SACRIFICE_CONTRACTS: Record<CardId, CardContract> = {
  ashen_vermin: {
    claim: 'deploys as a 2/1 body',
    run: (table) => {
      const instanceId = table.cast('ashen_vermin');
      checkEqual(table.attackOf(instanceId), 2, 'its ATK');
      checkEqual(table.healthOf(instanceId), 1, 'its Health');
    },
  },

  blood_scribe: {
    claim: 'looks at the top two cards the first time a Unit is sacrificed each turn',
    run: (table) => {
      table.board('blood_scribe');
      const fodder = table.board('grave_attendant');
      table.prefer(fodder);
      table.cast('divide_the_offering');
      checkEqual(table.zoneOf(fodder), 'discard', 'the sacrificed Unit');
      check(
        table.logged('effect_resolved', { effectType: 'search_zone' }),
        'the sacrifice trigger did not look at the deck',
      );
    },
  },

  bone_altar: {
    claim: 'creates a Thrall the first time a Unit is sacrificed each turn',
    run: (table) => {
      table.boardRelic('bone_altar');
      const fodder = table.board('grave_attendant');
      table.prefer(fodder);
      table.cast('divide_the_offering');
      // Two from the Spell, one more from the Altar.
      checkEqual(table.unitsOf('thrall_token').length, 3, 'Thrall Tokens after the Altar fires');
    },
  },

  bone_carrier: {
    claim: 'creates one Thrall Token when deployed',
    run: (table) => {
      table.cast('bone_carrier');
      checkEqual(table.unitsOf('thrall_token').length, 1, 'Thrall Tokens created');
    },
  },

  bone_harvest: {
    claim: 'draws a second card when at least two friendly Units died this turn',
    run: (table) => {
      table.board('ashen_vermin');
      table.board('ashen_vermin');
      table.cast('controlled_collapse');
      const before = table.handSize();
      table.cast('bone_harvest');
      checkEqual(table.handSize(), before + 2, 'cards drawn with two friendly Units defeated');
    },
  },

  bonepile_guardian: {
    claim: 'deploys as a 2/5 Guardian',
    run: (table) => {
      const instanceId = table.cast('bonepile_guardian');
      checkEqual(table.healthOf(instanceId), 5, 'its Health');
      check(table.hasKeyword(instanceId, 'guardian'), 'Guardian is missing');
    },
  },

  book_of_the_dead: {
    claim: 'looks for a Unit at the end of a turn a friendly Unit died in',
    run: (table) => {
      table.boardRelic('book_of_the_dead');
      table.stack(['grave_attendant']);
      table.board('grave_attendant');
      table.cast('throwing_knife');
      table.endTurn();
      check(
        table.logged('effect_resolved', { effectType: 'search_zone' }),
        'the end-of-turn look never resolved',
      );
    },
  },

  carrion_feeder: {
    claim: 'gains +2 ATK by sacrificing another Unit, once each turn',
    run: (table) => {
      const feeder = table.board('carrion_feeder');
      const fodder = table.board('grave_attendant');
      table.activate(feeder, 'feed');
      checkEqual(table.zoneOf(fodder), 'discard', 'the sacrificed Unit');
      checkEqual(table.attackOf(feeder), 3, "the Feeder's ATK after feeding");
    },
  },

  corpse_stitcher: {
    claim: 'removes a Unit card from the discard pile and creates two Thralls',
    run: (table) => {
      const stitcher = table.board('corpse_stitcher');
      const buried = table.bury('grave_attendant');
      table.activate(stitcher, 'stitch');
      checkEqual(table.zoneOf(buried), 'removed', 'the removed card');
      checkEqual(table.unitsOf('thrall_token').length, 2, 'Thrall Tokens created');
    },
  },

  corpse_wagon: {
    claim: 'creates two Thrall Tokens when deployed',
    run: (table) => {
      table.cast('corpse_wagon');
      checkEqual(table.unitsOf('thrall_token').length, 2, 'Thrall Tokens created');
    },
  },

  cruel_preacher: {
    claim: 'deals 1 damage to an opponent when another friendly Unit dies on its turn',
    run: (table) => {
      table.board('cruel_preacher');
      const fodder = table.board('grave_attendant');
      const before = table.player(table.foe).health;
      table.prefer(fodder);
      table.cast('throwing_knife');
      checkEqual(table.zoneOf(fodder), 'discard', 'the defeated Unit');
      checkEqual(table.player(table.foe).health, before - 1, "the opponent's Health");
    },
  },

  death_witness: {
    claim: 'draws and discards the first time a Unit is sacrificed each turn',
    run: (table) => {
      table.board('death_witness');
      const fodder = table.board('grave_attendant');
      table.prefer(fodder);
      table.cast('divide_the_offering');
      check(table.logged('card_discarded', { playerId: table.self }), 'nothing was discarded');
    },
  },

  divide_the_offering: {
    claim: 'sacrifices a Unit and creates two Thrall Tokens',
    run: (table) => {
      const fodder = table.board('grave_attendant');
      table.cast('divide_the_offering');
      checkEqual(table.zoneOf(fodder), 'discard', 'the sacrificed Unit');
      checkEqual(table.unitsOf('thrall_token').length, 2, 'Thrall Tokens created');
    },
  },

  doomed_acolyte: {
    claim: 'creates a Thrall Token when it is defeated',
    run: (table) => {
      const acolyte = table.board('doomed_acolyte');
      table.cast('throwing_knife');
      checkEqual(table.zoneOf(acolyte), 'discard', 'the defeated Acolyte');
      checkEqual(table.unitsOf('thrall_token').length, 1, 'Thrall Tokens created on defeat');
    },
  },

  equal_price: {
    claim: 'makes every player sacrifice one Unit they control',
    run: (table) => {
      const mine = table.board('grave_attendant');
      const theirs = table.board('veil_initiate', table.foe);
      table.cast('equal_price');
      checkEqual(table.zoneOf(mine), 'discard', 'my own sacrificed Unit');
      checkEqual(table.zoneOf(theirs), 'discard', "the opponent's sacrificed Unit");
    },
  },

  fading_wisp: {
    claim: 'returns to hand at the end of the turn it is sacrificed on',
    run: (table) => {
      const wisp = table.board('fading_wisp');
      table.prefer(wisp);
      table.cast('divide_the_offering');
      checkEqual(table.zoneOf(wisp), 'discard', 'the sacrificed Wisp before the turn ends');
      table.endTurn();
      checkEqual(table.zoneOf(wisp), 'hand', 'the Wisp after the turn ended');
    },
  },

  feed_the_pit: {
    claim: 'defeats an enemy Unit costing 3 or less for a sacrificed Unit',
    run: (table) => {
      const fodder = table.board('grave_attendant');
      const target = table.board('veil_skirmisher', table.foe);
      table.cast('feed_the_pit');
      checkEqual(table.zoneOf(fodder), 'discard', 'the sacrificed Unit');
      checkEqual(table.zoneOf(target), 'discard', 'the destroyed enemy Unit');
    },
  },

  feral_gravehound: {
    claim: 'deploys as a 3/2 body',
    run: (table) => {
      const instanceId = table.cast('feral_gravehound');
      checkEqual(table.attackOf(instanceId), 3, 'its ATK');
      checkEqual(table.healthOf(instanceId), 2, 'its Health');
    },
  },

  forbidden_offering: {
    claim: 'draws two cards for a sacrificed Unit',
    run: (table) => {
      const fodder = table.board('grave_attendant');
      const before = table.handSize();
      table.cast('forbidden_offering');
      checkEqual(table.zoneOf(fodder), 'discard', 'the sacrificed Unit');
      checkEqual(table.handSize(), before + 2, 'cards drawn');
    },
  },

  funeral_march: {
    claim: 'creates three Thrall Tokens',
    run: (table) => {
      table.cast('funeral_march');
      checkEqual(table.unitsOf('thrall_token').length, 3, 'Thrall Tokens created');
    },
  },

  grave_attendant: {
    claim: 'deploys as a 1/2 body',
    run: (table) => {
      const instanceId = table.cast('grave_attendant');
      checkEqual(table.attackOf(instanceId), 1, 'its ATK');
      checkEqual(table.healthOf(instanceId), 2, 'its Health');
    },
  },

  grave_matriarch: {
    claim: 'draws a card by sacrificing another Unit, once each turn',
    commander: 'grave_matriarch',
    run: (table) => {
      const matriarch = table.boardCommander();
      const fodder = table.board('grave_attendant');
      const before = table.handSize();
      table.activate(matriarch, 'matriarch_rite');
      checkEqual(table.zoneOf(fodder), 'discard', 'the sacrificed Unit');
      checkEqual(table.handSize(), before + 1, 'cards drawn');
    },
  },

  grave_prophet: {
    claim: 'draws at the end of a turn at least two friendly Units died in',
    run: (table) => {
      table.board('grave_prophet');
      table.board('ashen_vermin');
      table.board('ashen_vermin');
      table.cast('controlled_collapse');
      table.endTurn();
      check(
        table.logged('trigger_queued', { definitionId: 'grave_prophet' }),
        'the end-of-turn draw never triggered',
      );
    },
  },

  grave_reassembly: {
    claim: 'returns up to two cheap Unit cards from the discard pile, Exhausted',
    run: (table) => {
      const first = table.bury('grave_attendant');
      const second = table.bury('ashen_vermin');
      table.cast('grave_reassembly');
      checkEqual(table.zoneOf(first), 'battlefield', 'the first revived Unit');
      checkEqual(table.zoneOf(second), 'battlefield', 'the second revived Unit');
      check(table.instance(first).exhausted, 'the revived Unit should arrive Exhausted');
      check(table.instance(first).newlyDeployed, 'the revived Unit should be Newly Deployed');
    },
  },

  grave_robber: {
    claim: 'returns a Unit costing 1 from the discard pile when deployed',
    run: (table) => {
      const buried = table.bury('grave_attendant');
      table.cast('grave_robber');
      checkEqual(table.zoneOf(buried), 'hand', 'the recovered Unit');
    },
  },

  marked_for_death: {
    claim: 'gives a friendly Unit +3 ATK and pays two Thralls when it dies this turn',
    run: (table) => {
      const marked = table.board('grave_attendant');
      table.cast('marked_for_death');
      checkEqual(table.attackOf(marked), 4, "the marked Unit's ATK");
      table.prefer(marked);
      table.cast('crude_bomb');
      checkEqual(table.zoneOf(marked), 'discard', 'the marked Unit after it dies');
      checkEqual(table.unitsOf('thrall_token').length, 2, 'Thrall Tokens from the mark');
    },
  },

  mass_offering: {
    claim: 'sacrifices Tokens as Units and divides the total among enemy Units and the opponent',
    run: (table) => {
      table.token('thrall_token');
      table.token('thrall_token');
      const target = table.board('veil_adept', table.foe);
      const before = table.player(table.foe).health;

      // One point onto the Unit and one onto the opponent, which is the split
      // the card could not make before M07.8.
      table.choose((choice) => (choice.type === 'divide_damage' ? [target, table.foe] : null));
      table.cast('mass_offering');

      checkEqual(table.unitCount(), 0, 'friendly Units left after the offering');
      checkEqual(table.instance(target).markedDamage, 1, 'damage divided onto the enemy Unit');
      checkEqual(table.player(table.foe).health, before - 1, "the opponent's Health");
    },
  },

  mourning_keeper: {
    claim: 'restores 1 Health the first time another friendly Unit dies each turn',
    run: (table) => {
      table.board('mourning_keeper');
      const fodder = table.board('grave_attendant');
      table.health(table.self, 20);
      table.prefer(fodder);
      table.cast('throwing_knife');
      checkEqual(table.player(table.self).health, 21, 'my Health after the mourning');
    },
  },

  ossuary_captain: {
    claim: 'gives friendly Thrall Tokens +1 ATK',
    run: (table) => {
      const thrall = table.token('thrall_token');
      table.cast('ossuary_captain');
      checkEqual(table.attackOf(thrall), 2, "the Thrall's ATK");
    },
  },

  pit_executioner: {
    claim: 'defeats a cheap enemy Unit by sacrificing another friendly Unit when deployed',
    run: (table) => {
      const fodder = table.board('grave_attendant');
      const target = table.board('veil_skirmisher', table.foe);
      table.cast('pit_executioner');
      checkEqual(table.zoneOf(fodder), 'discard', 'the sacrificed Unit');
      checkEqual(table.zoneOf(target), 'discard', 'the destroyed enemy Unit');
    },
  },

  raise_a_thrall: {
    claim: 'creates one Thrall Token',
    run: (table) => {
      table.cast('raise_a_thrall');
      checkEqual(table.unitsOf('thrall_token').length, 1, 'Thrall Tokens created');
    },
  },

  ritual_butcher: {
    claim: 'sacrifices another Unit to deal 2 damage to an enemy Unit',
    run: (table) => {
      const butcher = table.board('ritual_butcher');
      const fodder = table.board('grave_attendant');
      const target = table.board('veil_adept', table.foe);
      table.activate(butcher, 'butcher');
      checkEqual(table.zoneOf(fodder), 'discard', 'the sacrificed Unit');
      checkEqual(table.instance(target).markedDamage, 2, 'damage on the enemy Unit');
    },
  },

  shackled_servant: {
    claim: 'deploys as a 0/3 body',
    run: (table) => {
      const instanceId = table.cast('shackled_servant');
      checkEqual(table.attackOf(instanceId), 0, 'its ATK');
      checkEqual(table.healthOf(instanceId), 3, 'its Health');
    },
  },

  soul_collector: {
    claim: 'gains +1 ATK for the turn whenever another Unit is defeated',
    run: (table) => {
      const collector = table.board('soul_collector');
      const victim = table.board('veil_initiate', table.foe);
      table.prefer(victim);
      table.cast('throwing_knife');
      checkEqual(table.zoneOf(victim), 'discard', 'the defeated Unit');
      checkEqual(table.attackOf(collector), 4, "the Collector's ATK");
    },
  },

  soul_furnace: {
    claim: 'deals 1 damage to an opponent the first time a friendly Unit dies each turn',
    run: (table) => {
      table.boardRelic('soul_furnace');
      const fodder = table.board('grave_attendant');
      const before = table.player(table.foe).health;
      table.prefer(fodder);
      table.cast('throwing_knife');
      checkEqual(table.player(table.foe).health, before - 1, "the opponent's Health");
    },
  },

  stitched_abomination: {
    claim: 'costs 1 less for each friendly Unit defeated this turn',
    run: (table) => {
      const inHand = table.give('stitched_abomination');
      checkEqual(table.costOf(inHand), 6, 'its printed cost with nothing defeated');
      table.board('ashen_vermin');
      table.board('ashen_vermin');
      table.cast('controlled_collapse');
      checkEqual(table.costOf(inHand), 4, 'its cost after two friendly Units died');
    },
  },

  unearth_the_remains: {
    claim: 'returns a Unit costing 2 or less from the discard pile to hand',
    run: (table) => {
      const buried = table.bury('ashen_vermin');
      table.cast('unearth_the_remains');
      checkEqual(table.zoneOf(buried), 'hand', 'the recovered Unit');
    },
  },
};
