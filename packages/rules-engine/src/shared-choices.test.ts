import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES_CONFIG } from './config.js';
import { opponentOf, playerOf } from './derive.js';
import { matchStateSchema } from './schema/state.js';
import { playerView } from './view.js';
import {
  apply,
  deployUnit,
  eventsOfType,
  expectRejected,
  giveCard,
  keepAllHands,
  keepBothHands,
  moveInstance,
  setEnergy,
  startMatch,
  startTable,
  testContext,
  testDatabase,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';

/**
 * M02.5 — choices several seats make at once, and totals one seat splits.
 *
 * Both mechanics are exercised through the two shipped cards, `equal_price` and
 * `mass_offering`, because the point of the tranche is that those cards work.
 * The recurring claims are the ones a card cannot state for itself: no seat
 * learns anything from an earlier seat's answer, and an allocation is validated
 * as an allocation rather than as a list of distinct picks.
 */

const context = testContext(DEFAULT_RULES_CONFIG);
const database = testDatabase();

const FODDER = 'prototype_drone';

function pendingChoice(state: MatchState) {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('Expected a pending choice');
  return choice;
}

function answer(state: MatchState, selectedIds: readonly InstanceId[]): MatchState {
  const choice = pendingChoice(state);
  return apply(
    state,
    {
      type: 'submit_choice',
      playerId: choice.playerId,
      choiceId: choice.id,
      selectedIds: [...selectedIds],
    },
    context,
  );
}

/** Answers whatever is pending with the first legal option, until none is. */
function answerAll(state: MatchState): MatchState {
  let next = state;
  while (next.pendingChoice) {
    next = answer(next, [pendingChoice(next).validEntityIds[0] as InstanceId]);
  }
  return next;
}

function play(state: MatchState, playerId: PlayerId, definitionId: string): MatchState {
  const placed = giveCard(state, playerId, definitionId);
  return apply(
    placed.state,
    { type: 'play_card', playerId, instanceId: placed.instanceId },
    context,
  );
}

/** Puts `count` fodder units onto a seat's battlefield and names them. */
function stock(state: MatchState, playerId: PlayerId, count: number): [MatchState, InstanceId[]] {
  let next = state;
  const ids: InstanceId[] = [];
  for (let i = 0; i < count; i += 1) {
    const placed = deployUnit(next, playerId, FODDER);
    next = placed.state;
    ids.push(placed.instanceId);
  }
  return [next, ids];
}

const unitsOf = (state: MatchState, playerId: PlayerId): InstanceId[] => [
  ...playerOf(state, playerId).units,
];

const damageTo = (state: MatchState, instanceId: InstanceId): number[] =>
  eventsOfType(state, 'damage_dealt')
    .filter((event) => event.targetInstanceId === instanceId)
    .map((event) => event.amount);

/* --------------------------------------------- 1. each player chooses */

describe('a selection several seats make at once (M02.5)', () => {
  /** A four-seat table where every seat holds two units. */
  function table(): { state: MatchState; caster: PlayerId } {
    let state = keepAllHands(startTable(4, { database }), context);
    for (const playerId of state.seatOrder) {
      state = setEnergy(state, playerId, 10);
      [state] = stock(state, playerId, 2);
    }
    return { state, caster: state.activePlayerId };
  }

  it('asks the controller first, then clockwise', () => {
    const { state, caster } = table();
    let next = play(state, caster, 'equal_price');

    const asked: PlayerId[] = [];
    for (let i = 0; i < 4; i += 1) {
      const choice = pendingChoice(next);
      expect(choice.reason).toBe('each_player_choice');
      asked.push(choice.playerId);
      next = answer(next, [choice.validEntityIds[0] as InstanceId]);
    }

    // `all_players` is the controller then clockwise — the same order every
    // other multi-seat effect resolves in.
    const seats = next.seatOrder;
    const start = seats.indexOf(caster);
    expect(asked).toEqual(seats.map((_, i) => seats[(start + i) % seats.length]));
  });

  it('offers each seat only its own units', () => {
    const { state, caster } = table();
    let next = play(state, caster, 'equal_price');

    for (let i = 0; i < 4; i += 1) {
      const choice = pendingChoice(next);
      expect([...choice.validEntityIds].sort()).toEqual(unitsOf(next, choice.playerId).sort());
      next = answer(next, [choice.validEntityIds[0] as InstanceId]);
    }
  });

  it('sacrifices nothing until the last seat has answered', () => {
    const { state, caster } = table();
    let next = play(state, caster, 'equal_price');

    const before = Object.fromEntries(
      next.seatOrder.map((playerId) => [playerId, unitsOf(next, playerId).length]),
    );

    // Three of the four have answered and the board has not moved, so the
    // fourth is deciding against exactly what the first one saw.
    for (let i = 0; i < 3; i += 1) {
      next = answer(next, [pendingChoice(next).validEntityIds[0] as InstanceId]);
      for (const playerId of next.seatOrder) {
        expect(unitsOf(next, playerId).length).toBe(before[playerId]);
      }
    }

    next = answer(next, [pendingChoice(next).validEntityIds[0] as InstanceId]);
    for (const playerId of next.seatOrder) {
      expect(unitsOf(next, playerId).length).toBe((before[playerId] as number) - 1);
    }
  });

  it('never shows one seat what another seat picked', () => {
    const { state, caster } = table();
    let next = play(state, caster, 'equal_price');
    const first = pendingChoice(next);
    const picked = first.validEntityIds[0] as InstanceId;
    next = answer(next, [picked]);

    const second = pendingChoice(next);
    const view = playerView(next, second.playerId, database);

    // The seat now choosing sees that somebody answered and nothing else: the
    // resolved-choice event carries no selection for anyone else's answer, and
    // the named unit is still standing because nothing has been applied.
    const resolved = view.log.filter((event) => event.type === 'choice_resolved');
    expect(resolved.length).toBeGreaterThan(0);
    for (const event of resolved) {
      if (event.type !== 'choice_resolved') continue;
      if (event.playerId === second.playerId) continue;
      expect(event.selectedIds).toBeNull();
    }
    expect(unitsOf(next, first.playerId)).toContain(picked);
  });

  it('skips a seat with nothing to offer, and everybody else still answers', () => {
    let state = keepAllHands(startTable(3, { database }), context);
    for (const playerId of state.seatOrder) state = setEnergy(state, playerId, 10);
    const caster = state.activePlayerId;
    const others = state.seatOrder.filter((id) => id !== caster);
    const empty = others[0] as PlayerId;
    const stocked = others[1] as PlayerId;

    [state] = stock(state, caster, 1);
    [state] = stock(state, stocked, 1);

    let next = play(state, caster, 'equal_price');
    const asked: PlayerId[] = [];
    while (next.pendingChoice) {
      asked.push(pendingChoice(next).playerId);
      next = answer(next, [pendingChoice(next).validEntityIds[0] as InstanceId]);
    }

    expect(asked).not.toContain(empty);
    expect(unitsOf(next, caster)).toHaveLength(0);
    expect(unitsOf(next, stocked)).toHaveLength(0);
  });

  it('drops an answer that has stopped being legal by the time it resolves', () => {
    const { state, caster } = table();
    let next = play(state, caster, 'equal_price');

    const first = pendingChoice(next);
    const named = first.validEntityIds[0] as InstanceId;
    next = answer(next, [named]);

    // The named unit leaves the battlefield while the rest of the table is
    // still deciding, which is the ordinary re-validation every stored selection
    // goes through. Nothing is substituted for it.
    next = moveInstance(next, named, 'discard');
    const remaining = unitsOf(next, first.playerId);

    next = answerAll(next);
    expect(unitsOf(next, first.playerId)).toEqual(remaining);
  });

  it('survives a serialisation round trip mid-collection', () => {
    const { state, caster } = table();
    let next = play(state, caster, 'equal_price');
    next = answer(next, [pendingChoice(next).validEntityIds[0] as InstanceId]);

    const round = matchStateSchema.parse(JSON.parse(JSON.stringify(next)));
    expect(round.pendingChoice?.id).toBe(next.pendingChoice?.id);

    const resumed = answerAll(round);
    for (const playerId of resumed.seatOrder) {
      expect(unitsOf(resumed, playerId)).toHaveLength(1);
    }
  });

  it('includes the caster, at two seats as well as four', () => {
    let state = keepBothHands(startMatch({ database }), context);
    const caster = state.activePlayerId;
    const other = opponentOf(state, caster);
    state = setEnergy(setEnergy(state, caster, 10), other, 10);
    [state] = stock(state, caster, 1);
    [state] = stock(state, other, 1);

    const next = answerAll(play(state, caster, 'equal_price'));

    expect(unitsOf(next, caster)).toHaveLength(0);
    expect(unitsOf(next, other)).toHaveLength(0);
  });
});

/* ------------------------------------------------- 2. divided damage */

describe('a damage total one seat splits (M02.5)', () => {
  /** The caster holds `fodder` units; the opponent holds two. */
  function board(fodder: number): {
    state: MatchState;
    caster: PlayerId;
    other: PlayerId;
    enemies: InstanceId[];
  } {
    let state = keepBothHands(startMatch({ database }), context);
    const caster = state.activePlayerId;
    const other = opponentOf(state, caster);
    state = setEnergy(setEnergy(state, caster, 10), other, 10);
    [state] = stock(state, caster, fodder);
    const [stocked, enemies] = stock(state, other, 2);
    return { state: stocked, caster, other, enemies };
  }

  /** Casts Mass Offering and answers the sacrifice with `count` of our units. */
  function cast(state: MatchState, caster: PlayerId, count: number): MatchState {
    const next = play(state, caster, 'mass_offering');
    const choice = pendingChoice(next);
    expect(choice.reason).toBe('effect_target');
    return answer(next, choice.validEntityIds.slice(0, count) as InstanceId[]);
  }

  it('asks for exactly as many points as were sacrificed', () => {
    const { state, caster } = board(3);
    const next = cast(state, caster, 3);

    const choice = pendingChoice(next);
    expect(choice.type).toBe('divide_damage');
    expect(choice.reason).toBe('divide_damage');
    expect(choice.minimum).toBe(3);
    expect(choice.maximum).toBe(3);
    expect(choice.playerId).toBe(caster);
  });

  it('offers only enemy units and Commanders', () => {
    const { state, caster, other } = board(2);
    const next = cast(state, caster, 2);

    const choice = pendingChoice(next);
    const ours = unitsOf(next, caster);
    expect(choice.validEntityIds.some((id) => ours.includes(id as InstanceId))).toBe(false);
    expect([...choice.validEntityIds].sort()).toEqual(unitsOf(next, other).sort());
  });

  it('accepts the same target twice and deals it both points at once', () => {
    const { state, caster, enemies } = board(3);
    const next = answer(cast(state, caster, 3), [
      enemies[0] as InstanceId,
      enemies[0] as InstanceId,
      enemies[1] as InstanceId,
    ]);

    // One event per target carrying the whole share — not one event per point,
    // which is what a shield would otherwise get to absorb twice.
    expect(damageTo(next, enemies[0] as InstanceId)).toEqual([2]);
    expect(damageTo(next, enemies[1] as InstanceId)).toEqual([1]);
  });

  it('lets the whole total go on one target', () => {
    const { state, caster, enemies } = board(3);
    const only = enemies[0] as InstanceId;
    const next = answer(cast(state, caster, 3), [only, only, only]);

    expect(damageTo(next, only)).toEqual([3]);
    expect(damageTo(next, enemies[1] as InstanceId)).toEqual([]);
  });

  it('refuses an allocation that does not add up', () => {
    const { state, caster, enemies } = board(3);
    const next = cast(state, caster, 3);
    const choice = pendingChoice(next);
    const target = enemies[0] as InstanceId;

    for (const selectedIds of [[target], [target, target], [target, target, target, target]]) {
      const error = expectRejected(
        next,
        { type: 'submit_choice', playerId: caster, choiceId: choice.id, selectedIds },
        context,
      );
      expect(error.code).toBe('engine/invalid_selection');
    }
    // Rejected outright, so the choice is still standing.
    expect(next.pendingChoice?.id).toBe(choice.id);
  });

  it('refuses a point aimed at something that is not a legal target', () => {
    // Three fodder, two fed to the spell: the third is still standing, and is
    // the caster's own unit rather than a legal recipient.
    const { state, caster, enemies } = board(3);
    const next = cast(state, caster, 2);
    const choice = pendingChoice(next);
    const ours = unitsOf(next, caster)[0] as InstanceId;

    const error = expectRejected(
      next,
      {
        type: 'submit_choice',
        playerId: caster,
        choiceId: choice.id,
        selectedIds: [enemies[0] as InstanceId, ours],
      },
      context,
    );
    expect(error.code).toBe('engine/invalid_selection');
    expect(next.pendingChoice?.id).toBe(choice.id);
  });

  it('deals nothing when nothing was sacrificed', () => {
    const { state, caster, other } = board(2);
    const next = cast(state, caster, 0);

    // "Up to five" that took none leaves no total to divide, so there is no
    // allocation to make and the spell simply finishes.
    expect(next.pendingChoice).toBeNull();
    expect(eventsOfType(next, 'damage_dealt')).toEqual([]);
    expect(unitsOf(next, other)).toHaveLength(2);
  });

  it('counts what this spell sacrificed, not what died earlier this turn', () => {
    const { state, caster } = board(4);
    // A sacrifice already logged this turn must not inflate the total: the
    // amount reads the preceding instruction, not the turn's history.
    const earlier: MatchState = {
      ...state,
      turnEvents: {
        ...state.turnEvents,
        sacrificed: [
          ...state.turnEvents.sacrificed,
          { instanceId: 'inst_gone' as InstanceId, definitionId: FODDER, controller: caster },
        ],
        defeated: [
          ...state.turnEvents.defeated,
          { instanceId: 'inst_gone' as InstanceId, definitionId: FODDER, controller: caster },
        ],
      },
    };

    expect(pendingChoice(cast(earlier, caster, 2)).minimum).toBe(2);
  });

  it('drops a share whose target has left, and lands the rest', () => {
    const { state, caster, enemies } = board(3);
    let next = cast(state, caster, 3);
    const choice = pendingChoice(next);
    const gone = enemies[0] as InstanceId;
    const alive = enemies[1] as InstanceId;

    next = moveInstance(next, gone, 'discard');
    next = apply(
      next,
      {
        type: 'submit_choice',
        playerId: caster,
        choiceId: choice.id,
        selectedIds: [gone, gone, alive],
      },
      context,
    );

    expect(damageTo(next, alive)).toEqual([1]);
    expect(damageTo(next, gone)).toEqual([]);
  });
});
