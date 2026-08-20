import { attackersIn, blockersIn, playIndexOf } from './table.js';
import type { TacticalFixture } from './fixture.js';

/**
 * Tactical calibration fixtures for `precon_goblin_swarm` (M05.6).
 *
 * A swarm deck's characteristic decisions are about *width*: build the
 * multiplier before the thing it multiplies, spend removal where it removes,
 * and never trade a body away for nothing. The deck contains no sacrifice, so
 * that facet does not apply to it — which the registry derives from the card
 * list rather than taking anyone's word for.
 */

const PRECON = 'precon_goblin_swarm';

export const GOBLIN_SWARM_FIXTURES: readonly TacticalFixture[] = [
  {
    id: 'goblin_swarm/drum_before_the_call',
    preconId: PRECON,
    facet: 'sequencing',
    claim: 'the War Drum lands before the Token spell, so the spell makes two Goblins',
    // Exactly enough for both, so only the order is in question.
    energy: 4,
    play: (table, pilot, rng) => {
      // Already deployed, so the Commander is not a third call on the Energy the
      // fixture is about.
      table.boardCommander();
      const drum = table.give('goblin_war_drum');
      const call = table.give('call_a_goblin');

      const taken = table.askUntilPass(pilot, rng);

      // Asserted on the order rather than on the Token count: the Commander's
      // own free Token also triggers the Drum, so the board a right order and a
      // wrong order end on can agree while the decision differs.
      const drumAt = playIndexOf(taken, drum);
      const callAt = playIndexOf(taken, call);
      return drumAt >= 0 && callAt >= 0 && drumAt < callAt;
    },
  },
  {
    id: 'goblin_swarm/bomb_the_body_it_defeats',
    preconId: PRECON,
    facet: 'targeting',
    claim: 'Crude Bomb is spent on the 3/2 it defeats, not the 2/5 it survives',
    play: (table, pilot, rng) => {
      table.boardCommander();
      const killable = table.board('goblin_bruiser', table.foe);
      const untouchable = table.board('veteran_guard', table.foe);
      table.give('crude_bomb');

      if (table.askUntilFamily(pilot, rng, 'submit_choice') === null) return false;

      return table.offBoard(killable) && !table.offBoard(untouchable);
    },
    knownGaps: {
      // Not `aggressive`: its weight vector values ATK enough that the 3/2 is
      // the higher-ranked target anyway, so it gets the right answer for a
      // reason that has nothing to do with lethality. The split is the finding.
      defensive: 'ranks targets by board value alone, so the 2/5 outranks the 3/2 it cannot kill',
      value: 'ranks targets by board value alone, so the 2/5 outranks the 3/2 it cannot kill',
    },
  },
  {
    id: 'goblin_swarm/absorb_with_the_wall_not_the_bruiser',
    preconId: PRECON,
    facet: 'blocking',
    claim: 'a 2/1 attacker is walled off by the 0/3 rather than traded with the 3/2',
    play: (table, pilot, rng) => {
      const wall = table.board('goblin_shieldbearer');
      table.board('goblin_bruiser');
      const attacker = table.board('goblin_spearman', table.foe);

      table.handTurnTo(table.foe);
      table.toPhase('declare_attackers', table.foe);
      table.act({
        type: 'declare_attackers',
        playerId: table.foe,
        attacks: [{ attackerInstanceId: attacker, defenderPlayerId: table.self }],
      });
      const decision = table.ask(pilot, rng);

      // Blocking with the 3/2 kills the 2/1 and loses a better body doing it.
      const blocks = blockersIn(decision);
      return blocks.length === 1 && blocks[0] === wall;
    },
    knownGaps: {
      aggressive: 'declines to block at all while its own Health is not in danger',
      defensive: 'blocks for the kill with the 3/2 and pays a better body for a 2/1',
      value: 'declines to block at all while its own Health is not in danger',
    },
  },
  {
    id: 'goblin_swarm/scatter_the_targeted_goblin',
    preconId: PRECON,
    facet: 'reaction',
    claim: 'Scatter answers removal aimed at the only Goblin on the board',
    play: (table, pilot, rng) => {
      // A 3/2, so the three damage on the stack is lethal and declining is a
      // real loss rather than a scratch.
      const threatened = table.board('goblin_bruiser');
      table.give('scatter');
      const bomb = table.give('crude_bomb', table.foe);

      table.handTurnTo(table.foe);
      table.act({ type: 'play_card', playerId: table.foe, instanceId: bomb });
      table.ask(pilot, rng);

      return !table.offBoard(threatened);
    },
  },
  {
    id: 'goblin_swarm/swing_at_the_open_board',
    preconId: PRECON,
    facet: 'attacking',
    claim: 'with nothing opposite that can block, both Goblins go to the face',
    play: (table, pilot, rng) => {
      const spearman = table.board('goblin_spearman');
      const bruiser = table.board('goblin_bruiser');
      // No opposing Unit at all, so nothing about the attack is a guess: every
      // point of Attack on the board reaches a player.
      table.toPhase('declare_attackers');

      const sent = new Set(attackersIn(table.ask(pilot, rng)));
      return sent.size === 2 && sent.has(spearman) && sent.has(bruiser);
    },
  },
  {
    id: 'goblin_swarm/knife_the_seat_holding_the_killable_body',
    preconId: PRECON,
    facet: 'targeting',
    claim: 'across three seats, Throwing Knife defeats the 2/1 rather than scratching a 2/5',
    seats: 3,
    play: (table, pilot, rng) => {
      // The one board in the suite that needs a third seat: with a single
      // opponent there is no cross-seat choice to get wrong, so this question
      // cannot be posed at all on a two-seat table.
      table.boardCommander();
      const killable = table.board('goblin_spearman', table.foe);
      const untouchable = table.board('veteran_guard', table.otherFoe ?? table.foe);
      table.give('throwing_knife');

      if (table.askUntilFamily(pilot, rng, 'submit_choice') === null) return false;

      return table.offBoard(killable) && !table.offBoard(untouchable);
    },
    knownGaps: {
      aggressive: 'ranks targets by board value alone, so the other seat’s 2/5 outranks the 2/1',
      defensive: 'ranks targets by board value alone, so the other seat’s 2/5 outranks the 2/1',
      value: 'ranks targets by board value alone, so the other seat’s 2/5 outranks the 2/1',
    },
  },
];
