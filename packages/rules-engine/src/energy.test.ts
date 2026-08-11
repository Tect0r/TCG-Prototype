import { describe, expect, it } from 'vitest';
import type { CardDefinitionInput } from '@tcg/card-data';
import { DEFAULT_RULES_CONFIG } from './config.js';
import {
  apply,
  databaseWith,
  forcePhase,
  giveCard,
  keepBothHands,
  makeDeck,
  setEnergy,
  startMatch,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';

/**
 * Energy carryover (ruleset update §5).
 *
 * Unspent Energy survives the opponents' turns so it can pay for a Reaction, and
 * is then **replaced** — not topped up — by the normal refill on its owner's
 * next turn.
 *
 * The engine has always behaved this way by omission: `flow.ts` refills only at
 * the controller's own turn start, and nothing zeroes Energy at turn end. That
 * is exactly why these tests exist. A rule that holds because no code contradicts
 * it is one deletion away from being wrong, and until Reactions landed there was
 * nothing a player could *do* with carried Energy, so nothing would have failed.
 */

/** A Reaction that pays for itself with whatever is left over. */
const ANSWER_COST = 2;
const HELD_ANSWER: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_held_answer',
  name: 'Test Held Answer',
  type: 'reaction',
  colorIdentity: ['blue'],
  cost: ANSWER_COST,
  displayText: 'Play when an opponent plays a Spell. Draw a card.',
  reaction: { windows: ['when_opponent_plays_spell'] },
  effects: [{ type: 'draw', player: 'self', amount: 1 }],
};

const BAIT: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_bait_spell',
  name: 'Test Bait Spell',
  type: 'spell',
  colorIdentity: ['blue'],
  cost: 1,
  displayText: 'Draw a card.',
  effects: [{ type: 'draw', player: 'self', amount: 1 }],
};

const database = databaseWith([HELD_ANSWER, BAIT]);
const context = { database, config: DEFAULT_RULES_CONFIG };

function opened(): MatchState {
  return keepBothHands(
    startMatch({ database, decks: [makeDeck(), makeDeck('prototype_commander_red')] }),
    context,
  );
}

/**
 * Answers whatever the engine is waiting for, minimally.
 *
 * Idling for many turns eventually runs a player into the hand-size limit, and
 * the discard choice that follows is not what any of these tests are about —
 * but it has to be answered or the next `pass_phase` is refused.
 */
function settleChoices(state: MatchState): MatchState {
  let next = state;
  for (let guard = 0; guard < 32 && next.pendingChoice !== null; guard += 1) {
    const choice = next.pendingChoice;
    next = apply(
      next,
      {
        type: 'submit_choice',
        playerId: choice.playerId,
        choiceId: choice.id,
        selectedIds: choice.ordered
          ? [...choice.validEntityIds]
          : choice.validEntityIds.slice(0, choice.minimum),
      },
      context,
    );
  }
  return next;
}

/** Hands the turn over from wherever the active player is standing. */
function endTurn(state: MatchState): MatchState {
  const settled = settleChoices(state);
  return settleChoices(
    apply(
      forcePhase(settled, 'main_2'),
      { type: 'pass_phase', playerId: settled.activePlayerId },
      context,
    ),
  );
}

function energyOf(state: MatchState, playerId: string): number {
  const player = state.players[playerId];
  if (!player) throw new Error(`No player ${playerId}`);
  return player.energy;
}

function maxEnergyOf(state: MatchState, playerId: string): number {
  const player = state.players[playerId];
  if (!player) throw new Error(`No player ${playerId}`);
  return player.maxEnergy;
}

describe('unspent energy', () => {
  it('survives the opponent turn untouched, then is replaced rather than topped up', () => {
    let state = opened();
    const first = state.activePlayerId;
    const second = state.playerOrder.find((id) => id !== first) as string;

    // Two more of the first player's own turns, so `maxEnergy` has grown past 1
    // and a partial spend is expressible at all.
    for (let cycle = 0; cycle < 4; cycle += 1) state = endTurn(state);
    expect(state.activePlayerId).toBe(first);
    const max = maxEnergyOf(state, first);
    expect(max).toBeGreaterThanOrEqual(3);

    // A turn in which they spent all but two.
    const partlySpent = setEnergy(state, first, 2);
    expect(maxEnergyOf(partlySpent, first)).toBe(max);

    const opponentTurn = endTurn(partlySpent);
    expect(opponentTurn.activePlayerId).toBe(second);
    // Nothing in the opponent's whole turn — turn start, draw, combat, turn end —
    // reached into the other seat's Energy. This is what pays for a Reaction.
    expect(energyOf(opponentTurn, first)).toBe(2);

    const ownTurnAgain = endTurn(opponentTurn);
    expect(ownTurnAgain.activePlayerId).toBe(first);
    // Replaced, not topped up: the refill sets Energy *to* the new maximum. Had
    // the two carried Energy been added to it, this would read `max + 3`.
    expect(maxEnergyOf(ownTurnAgain, first)).toBe(max + 1);
    expect(energyOf(ownTurnAgain, first)).toBe(max + 1);
  });

  it('never climbs above maximum energy', () => {
    let state = opened();

    // Long enough for `maxEnergy` to reach the cap and keep refilling against it.
    for (let cycle = 0; cycle < 26; cycle += 1) {
      state = endTurn(state);
      for (const playerId of state.playerOrder) {
        expect(energyOf(state, playerId)).toBeLessThanOrEqual(maxEnergyOf(state, playerId));
        expect(maxEnergyOf(state, playerId)).toBeLessThanOrEqual(DEFAULT_RULES_CONFIG.energyCap);
      }
    }
  });
});

describe('paying for a Reaction with carried energy', () => {
  it('spends Energy the player still had from their own previous turn', () => {
    const start = opened();
    const first = start.activePlayerId;
    const second = start.playerOrder.find((id) => id !== first) as string;

    // Give the responder their Reaction while it is nobody's business but their
    // own, then hand the turn back and forth until they have enough Energy for
    // it. Nothing tops them up: the Energy is whatever their own turn left them.
    let state = giveCard(start, second, 'test_held_answer').state;
    const reactionId = state.players[second]?.hand.at(-1) as string;

    while (maxEnergyOf(state, second) < ANSWER_COST) state = endTurn(state);
    while (state.activePlayerId !== first) state = endTurn(state);

    const carried = energyOf(state, second);
    expect(carried).toBeGreaterThanOrEqual(ANSWER_COST);

    const bait = giveCard(state, first, 'test_bait_spell');
    const cast = apply(
      bait.state,
      { type: 'play_card', playerId: first, instanceId: bait.instanceId },
      context,
    );

    // The window only opens because the responder can pay out of the Energy they
    // carried across the turn boundary.
    expect(cast.phase).toBe('reaction_window');
    expect(energyOf(cast, second)).toBe(carried);

    const answered = apply(
      cast,
      { type: 'play_reaction', playerId: second, instanceId: reactionId },
      context,
    );

    expect(energyOf(answered, second)).toBe(carried - ANSWER_COST);
  });
});
