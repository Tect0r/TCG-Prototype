import { attackersIn, blockersIn } from './table.js';
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
      // Both are printed Units, and deliberately: a Token would also satisfy
      // `carrion_feeder`'s `cardTypes: ["unit"]` cost since Q49, and a cost with
      // one legal payment is paid without asking anybody — so a third body on
      // the board would change what question this fixture asks.
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
    // No gap at either profile since M09.15, and the reason is worth writing
    // down because it is not a pilot improvement. Every style already sequenced
    // this correctly — the converter outscores the draw spell and was always
    // played first. What stopped the second card was the *engine*: a Thrall
    // could not pay "sacrifice a Unit", so once the last printed body had been
    // converted there was no legal payment left and the draw stranded in hand.
    // The owner's Token ruling (Q49) makes a battlefield Token a Unit, and the
    // line became legal for a pilot for the same reason it became legal for a
    // person. Recorded here rather than in `tacticalGaps` so nobody reads this
    // board as evidence about Hard.
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
  {
    id: 'grave_sacrifice/an_exhausted_wall_cannot_block',
    preconId: PRECON,
    facet: 'attacking',
    claim: 'both bodies swing past a 2/5 that is Exhausted and therefore cannot answer them',
    play: (table, pilot, rng) => {
      const fodder = table.board('ashen_vermin');
      const bigger = table.board('bonepile_guardian');
      // The one Unit opposite would answer both of these if it were ready. It is
      // not, and reading that is the whole decision.
      table.board('veteran_guard', table.foe, { exhausted: true });
      table.toPhase('declare_attackers');

      const sent = new Set(attackersIn(table.ask(pilot, rng)));
      return sent.size === 2 && sent.has(fodder) && sent.has(bigger);
    },
  },
  {
    id: 'grave_sacrifice/no_chump_against_overwhelm',
    preconId: PRECON,
    facet: 'blocking',
    claim:
      'a 2/1 is kept rather than thrown under a 7/7 Overwhelm that tramples six through anyway',
    play: (table, pilot, rng) => {
      const chump = table.board('ashen_vermin');
      const attacker = table.board('stitched_abomination', table.foe);

      table.handTurnTo(table.foe);
      table.toPhase('declare_attackers', table.foe);
      table.act({
        type: 'declare_attackers',
        playerId: table.foe,
        attacks: [{ attackerInstanceId: attacker, defenderPlayerId: table.self }],
      });
      const decision = table.ask(pilot, rng);

      // Overwhelm assigns the blocker its own Health and sends the rest to the
      // player, so this block buys one damage and costs a body.
      return blockersIn(decision).length === 0 && !table.offBoard(chump);
    },
    knownGaps: {
      defensive: 'treats a blocked attacker as fully stopped, so the chump looks like seven saved',
      value: 'treats a blocked attacker as fully stopped, so the chump looks like seven saved',
    },
  },
];
