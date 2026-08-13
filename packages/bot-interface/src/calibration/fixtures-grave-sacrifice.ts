import { blockersIn } from './table.js';
import type { TacticalFixture } from './fixture.js';

/**
 * Tactical calibration fixtures for `precon_grave_sacrifice` (M05.6).
 *
 * The deck's whole idea is that a body is a resource: it feeds an outlet, it
 * pays an additional cost, and it comes back as two Thralls. Every decision
 * below is one a person playing it makes without thinking and a scoring
 * function has to be shown to make.
 */

const PRECON = 'precon_grave_sacrifice';

export const GRAVE_SACRIFICE_FIXTURES: readonly TacticalFixture[] = [
  {
    id: 'grave_sacrifice/feed_the_cheap_body_not_the_giant',
    preconId: PRECON,
    facet: 'sacrifice',
    claim: 'feeding Carrion Feeder gives up the 2/1, not the 7/7',
    play: (table, pilot, rng) => {
      const feeder = table.board('carrion_feeder');
      // Both are printed Units. A Thrall Token would not do: `carrion_feeder`
      // filters its cost on `cardTypes: ["unit"]`, which a Token is not, and a
      // cost with one legal payment is paid without asking anybody.
      const fodder = table.board('ashen_vermin');
      const giant = table.board('stitched_abomination');

      // The activation is scenery: the fixture is about the cost, which pauses
      // for a choice before anything is committed.
      table.act({
        type: 'activate_ability',
        playerId: table.self,
        sourceInstanceId: feeder,
        abilityId: 'feed',
      });
      table.ask(pilot, rng);

      return table.offBoard(fodder) && !table.offBoard(giant);
    },
  },
  {
    id: 'grave_sacrifice/knife_the_unit_it_kills',
    preconId: PRECON,
    facet: 'targeting',
    claim: 'Throwing Knife is spent on the 2/1 it defeats, not the 2/5 it scratches',
    play: (table, pilot, rng) => {
      table.boardCommander();
      const killable = table.board('ashen_vermin', table.foe);
      const untouchable = table.board('veteran_guard', table.foe);
      table.give('throwing_knife');

      if (table.askUntilFamily(pilot, rng, 'submit_choice') === null) return false;

      return table.offBoard(killable) && !table.offBoard(untouchable);
    },
    knownGaps: {
      aggressive: 'ranks targets by board value alone, so the 2/5 outranks the 2/1 it cannot kill',
      defensive: 'ranks targets by board value alone, so the 2/5 outranks the 2/1 it cannot kill',
      value: 'ranks targets by board value alone, so the 2/5 outranks the 2/1 it cannot kill',
    },
  },
  {
    id: 'grave_sacrifice/make_fodder_before_spending_it',
    preconId: PRECON,
    facet: 'sequencing',
    claim: 'the last body is turned into two Thralls and one of them is then spent on a draw',
    // Exactly enough for both, and only in one order.
    energy: 3,
    play: (table, pilot, rng) => {
      table.board('ashen_vermin');
      const convert = table.give('divide_the_offering');
      const draw = table.give('forbidden_offering');

      table.askUntilPass(pilot, rng);

      // Both cards resolved, which only happens if the converter went first: the
      // draw spell eats the only Unit on the board and strands the other card.
      return table.zoneOf(convert) === 'discard' && table.zoneOf(draw) === 'discard';
    },
    knownGaps: {
      aggressive:
        'prices the additional sacrifice against the draw and never plays the second card',
      defensive: 'prices the additional sacrifice against the draw and never plays the second card',
      value: 'prices the additional sacrifice against the draw and never plays the second card',
    },
  },
  {
    id: 'grave_sacrifice/block_with_the_body_that_survives',
    preconId: PRECON,
    facet: 'blocking',
    claim: 'a 3/2 attacker is answered by the 2/5 that eats it, not chumped by the 2/1',
    play: (table, pilot, rng) => {
      const wall = table.board('veteran_guard');
      table.board('ashen_vermin');
      const attacker = table.board('feral_gravehound', table.foe);

      table.handTurnTo(table.foe);
      table.toPhase('declare_attackers', table.foe);
      table.act({
        type: 'declare_attackers',
        playerId: table.foe,
        attacks: [{ attackerInstanceId: attacker, defenderPlayerId: table.self }],
      });
      const decision = table.ask(pilot, rng);

      const blocks = blockersIn(decision);
      return blocks.length === 1 && blocks[0] === wall;
    },
    knownGaps: {
      aggressive: 'chumps with the 2/1 for the kill, though the 2/5 kills it and survives',
      defensive: 'chumps with the 2/1 for the kill, though the 2/5 kills it and survives',
      value: 'chumps with the 2/1 for the kill, though the 2/5 kills it and survives',
    },
  },
];
