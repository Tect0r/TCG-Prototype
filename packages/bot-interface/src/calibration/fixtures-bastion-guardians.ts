import { blockersIn } from './table.js';
import type { TacticalFixture } from './fixture.js';

/**
 * Tactical calibration fixtures for `precon_bastion_guardians` (M05.6).
 *
 * A Guardian deck is a *blocking* deck, so the decisions worth pinning are the
 * ones combat asks: which body goes in front, what the removal is saved for,
 * and whether the trick is spent to keep a wall standing. It contains no
 * sacrifice, so that facet does not apply.
 */

const PRECON = 'precon_bastion_guardians';

export const BASTION_GUARDIANS_FIXTURES: readonly TacticalFixture[] = [
  {
    id: 'bastion_guardians/armory_before_the_guardian',
    preconId: PRECON,
    facet: 'sequencing',
    claim: 'the Armory is deployed before the Guardian, so the Guardian arrives with Barrier',
    // Exactly enough for both, so only the order is in question.
    energy: 5,
    play: (table, pilot, rng) => {
      table.boardCommander();
      table.give('bastion_armory');
      table.give('bastion_infantry');

      table.askUntilPass(pilot, rng);

      const infantry = table.onlyUnitOf('bastion_infantry');
      return infantry !== null && table.hasKeyword(infantry, 'barrier');
    },
    knownGaps: {
      aggressive: 'scores each play on its own, so the Relic’s deploy trigger is invisible',
      defensive: 'scores each play on its own, so the Relic’s deploy trigger is invisible',
      value: 'scores each play on its own, so the Relic’s deploy trigger is invisible',
    },
  },
  {
    id: 'bastion_guardians/judgment_on_the_bigger_body',
    preconId: PRECON,
    facet: 'targeting',
    claim: 'Bastion Judgment defeats the Exhausted 4/4 rather than the Exhausted 2/1',
    play: (table, pilot, rng) => {
      table.boardCommander();
      const threat = table.board('watch_captain', table.foe, { exhausted: true });
      const scrap = table.board('border_recruit', table.foe, { exhausted: true });
      table.give('bastion_judgment');

      if (table.askUntilFamily(pilot, rng, 'submit_choice') === null) return false;

      return table.offBoard(threat) && !table.offBoard(scrap);
    },
  },
  {
    id: 'bastion_guardians/the_guardian_takes_the_hit',
    preconId: PRECON,
    facet: 'blocking',
    claim: 'the 3/6 Guardian blocks the 4/4 and the 2/1 stays home',
    play: (table, pilot, rng) => {
      const guardian = table.board('oathsworn_protector');
      table.board('border_recruit');
      const attacker = table.board('watch_captain', table.foe);

      table.handTurnTo(table.foe);
      table.toPhase('declare_attackers', table.foe);
      table.act({
        type: 'declare_attackers',
        playerId: table.foe,
        attacks: [{ attackerInstanceId: attacker, defenderPlayerId: table.self }],
      });
      const decision = table.ask(pilot, rng);

      // The Guardian obligation forces *a* block; which body pays for it is the
      // decision, and the 2/1 dying to a 4/4 for nothing is the wrong answer.
      const blocks = blockersIn(decision);
      return blocks.length === 1 && blocks[0] === guardian;
    },
  },
  {
    id: 'bastion_guardians/hold_the_line_saves_the_wall',
    preconId: PRECON,
    facet: 'reaction',
    claim: 'Hold the Line is spent to keep a blocking 2/3 alive under a 4/4',
    play: (table, pilot, rng) => {
      const wall = table.board('bastion_infantry');
      const attacker = table.board('watch_captain', table.foe);
      table.give('hold_the_line');

      table.handTurnTo(table.foe);
      table.toPhase('declare_attackers', table.foe);
      table.act({
        type: 'declare_attackers',
        playerId: table.foe,
        attacks: [{ attackerInstanceId: attacker, defenderPlayerId: table.self }],
      });
      // The block itself is scenery here: the fixture is about the window it
      // opens, not about which body was put in front.
      table.act({
        type: 'assign_blockers',
        playerId: table.self,
        blocks: [{ attackerInstanceId: attacker, blockerInstanceId: wall }],
      });
      table.ask(pilot, rng);

      return !table.offBoard(wall);
    },
  },
];
