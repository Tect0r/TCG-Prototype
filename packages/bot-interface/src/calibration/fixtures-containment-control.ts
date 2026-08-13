import { blockersIn } from './table.js';
import type { TacticalFixture } from './fixture.js';

/**
 * Tactical calibration fixtures for `precon_containment_control` (M05.6).
 *
 * A control deck's characteristic decisions are the two a greedy scorer finds
 * hardest: spend the answer on the thing worth answering, and *hold* Energy for
 * a window that has not opened yet. The second one is the reason this deck is
 * calibrated at all — a valuation that prices only what it can play this instant
 * cannot price patience, and a match result will never tell you so.
 */

const PRECON = 'precon_containment_control';

export const CONTAINMENT_CONTROL_FIXTURES: readonly TacticalFixture[] = [
  {
    id: 'containment_control/hold_energy_for_the_counter',
    preconId: PRECON,
    facet: 'sequencing',
    claim: 'a held counter keeps its Energy instead of buying a 2-cost body',
    // Enough for the counter, or for the body, and never for both.
    energy: 3,
    play: (table, pilot, rng) => {
      table.give('calculated_response');
      const body = table.give('veil_skirmisher');

      table.ask(pilot, rng);

      return table.zoneOf(body) === 'hand';
    },
    knownGaps: {
      aggressive: 'penalises unspent Energy and prices no window that has not opened yet',
      defensive: 'penalises unspent Energy and prices no window that has not opened yet',
      value: 'penalises unspent Energy and prices no window that has not opened yet',
    },
  },
  {
    id: 'containment_control/dismantle_their_relic_not_mine',
    preconId: PRECON,
    facet: 'targeting',
    claim: 'Dismantle the Device answers the opponent’s Relic, even when mine is worth more',
    play: (table, pilot, rng) => {
      table.boardCommander();
      // Deliberately the wrong way round by raw value: the pilot has to read the
      // instruction's direction, not the ranking.
      const mine = table.boardRelic('temporal_anchor');
      const theirs = table.boardRelic('observation_lens', table.foe);
      table.give('dismantle_the_device');

      if (table.askUntilFamily(pilot, rng, 'submit_choice') === null) return false;

      return table.offBoard(theirs) && !table.offBoard(mine);
    },
  },
  {
    id: 'containment_control/counter_the_expensive_spell',
    preconId: PRECON,
    facet: 'reaction',
    claim: 'Calculated Response is spent on a 5-cost draw spell rather than held',
    play: (table, pilot, rng) => {
      table.give('calculated_response');
      const bomb = table.give('reconstruct_the_theory', table.foe);

      table.handTurnTo(table.foe);
      table.act({ type: 'play_card', playerId: table.foe, instanceId: bomb });
      // Counted after the Spell is on the stack, so the opponent's own turn draw
      // is not mistaken for the three cards the counter is there to deny.
      const before = table.handSize(table.foe);
      table.ask(pilot, rng);

      return table.handSize(table.foe) === before;
    },
  },
  {
    id: 'containment_control/wall_eats_the_attack',
    preconId: PRECON,
    facet: 'blocking',
    claim: 'a 3/2 attacker is answered by the 1/4 that survives it, not by the 3/2 that trades',
    play: (table, pilot, rng) => {
      const wall = table.board('containment_guard');
      table.board('veil_skirmisher');
      const attacker = table.board('veil_skirmisher', table.foe);

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
      aggressive: 'declines to block at all while its own Health is not in danger',
      defensive: 'takes the one-for-one trade rather than the block that loses nothing',
      value: 'takes the one-for-one trade rather than the block that loses nothing',
    },
  },
];
