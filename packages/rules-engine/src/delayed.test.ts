import { describe, expect, it } from 'vitest';
import { isOk } from '@tcg/shared';
import type { CardDefinitionInput } from '@tcg/card-data';
import { opponentOf } from './derive.js';
import { deserializeMatchState, serializeMatchState } from './serialize.js';
import { playerView } from './view.js';
import {
  apply,
  databaseWith,
  deployUnit,
  eventsOfType,
  expectRejected,
  forcePhase,
  giveCard,
  instanceIn,
  keepBothHands,
  makeDeck,
  setEnergy,
  setHealth,
  startMatch,
  startTable,
  testContext,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';

/**
 * Delayed end-of-turn effects (M02.1).
 *
 * The two authored cards are the two shapes the primitive has: `fading_wisp`
 * fires *at* the boundary, `marked_for_death` waits for an event *before* it.
 * Everything else here is the general contract they both have to obey, tested
 * through them rather than through a bespoke fixture — the milestone forbids
 * behaviour keyed to a card ID, so the rules have to be visible on real cards.
 */

/** A free sacrifice outlet. Nothing in the catalog sacrifices on demand for 0. */
const SACRIFICE_OUTLET: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_sac_outlet',
  name: 'Test Sacrifice Outlet',
  type: 'spell',
  colorIdentity: ['black'],
  cost: 0,
  effects: [
    {
      type: 'sacrifice',
      target: {
        kind: 'entity',
        selector: {
          zone: 'battlefield',
          controller: 'self',
          filter: { cardTypes: ['unit'] },
          count: 1,
        },
      },
    },
  ],
  displayText: 'Sacrifice a friendly Unit.',
};

/** Reanimation, so "the subject left the zone it was named in" is reachable. */
const REANIMATE: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_reanimate',
  name: 'Test Reanimate',
  type: 'spell',
  colorIdentity: ['black'],
  cost: 0,
  effects: [
    {
      type: 'move_card',
      target: {
        kind: 'entity',
        selector: {
          zone: 'discard',
          controller: 'self',
          filter: { cardTypes: ['unit'] },
          count: 1,
        },
      },
      toZone: 'battlefield',
    },
  ],
  displayText: 'Put a Unit from your discard pile onto the battlefield.',
};

/** Bounce, so a marked unit can leave the battlefield without being defeated. */
const RECALL: CardDefinitionInput = {
  schemaVersion: 4,
  id: 'test_recall',
  name: 'Test Recall',
  type: 'spell',
  colorIdentity: ['blue'],
  cost: 0,
  effects: [
    {
      type: 'return_to_hand',
      target: {
        kind: 'entity',
        selector: {
          zone: 'battlefield',
          controller: 'self',
          filter: { cardTypes: ['unit'] },
          count: 1,
        },
      },
    },
  ],
  displayText: 'Return a friendly Unit to your hand.',
};

const database = databaseWith([SACRIFICE_OUTLET, REANIMATE, RECALL]);
const context = testContext();
const CONTEXT = { ...context, database };

function opened(): MatchState {
  const deck = makeDeck('prototype_commander_blue', ['prototype_drone']);
  const state = startMatch({
    database,
    decks: [deck, makeDeck('prototype_commander_red')],
  });
  return setEnergy(keepBothHands(state, CONTEXT), state.playerOrder[0] as string, 10);
}

/** Plays a card from hand and answers nothing. */
function playCard(state: MatchState, definitionId: string): MatchState {
  const placed = giveCard(state, state.activePlayerId, definitionId);
  return apply(
    placed.state,
    { type: 'play_card', playerId: state.activePlayerId, instanceId: placed.instanceId },
    CONTEXT,
  );
}

/** Answers the pending choice with the given entities. */
function choose(state: MatchState, ...selectedIds: string[]): MatchState {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('Expected a pending choice.');
  return apply(
    state,
    {
      type: 'submit_choice',
      playerId: choice.playerId,
      choiceId: choice.id,
      selectedIds,
    },
    CONTEXT,
  );
}

/** Hands the turn over, running turn end and the next player's opening phases. */
function endTurn(state: MatchState): MatchState {
  return apply(
    forcePhase(state, 'main_2'),
    { type: 'pass_phase', playerId: state.activePlayerId },
    CONTEXT,
  );
}

function delayedIds(state: MatchState): string[] {
  return state.delayedEffects.map((entry) => entry.id);
}

describe('fading_wisp — an instruction that happens at the boundary', () => {
  it('schedules on sacrifice and returns the card to hand at the end of the turn', () => {
    const start = opened();
    const active = start.activePlayerId;
    const wisp = deployUnit(start, active, 'fading_wisp');

    const sacrificed = choose(playCard(wisp.state, 'test_sac_outlet'), wisp.instanceId);

    // The promise exists, is bound to the card that died, and is public.
    expect(sacrificed.delayedEffects).toHaveLength(1);
    const entry = sacrificed.delayedEffects[0]!;
    expect(entry.sourceDefinitionId).toBe('fading_wisp');
    expect(entry.abilityId).toBe('return_at_end_of_turn');
    expect(entry.subjectInstanceId).toBe(wisp.instanceId);
    expect(entry.subjectZone).toBe('discard');
    expect(entry.trigger).toBeNull();
    expect(entry.controllerId).toBe(active);
    expect(entry.createdOnTurn).toBe(sacrificed.turn);

    // Nothing has happened yet: it is still in the discard pile.
    expect(instanceIn(sacrificed, wisp.instanceId).zone).toBe('discard');

    const next = endTurn(sacrificed);
    expect(instanceIn(next, wisp.instanceId).zone).toBe('hand');
    expect(next.players[active]?.hand).toContain(wisp.instanceId);
    expect(next.delayedEffects).toHaveLength(0);
    expect(eventsOfType(next, 'delayed_effect_fired')).toHaveLength(1);
  });

  it('is dropped when the card leaves the zone it was named in', () => {
    const start = opened();
    const active = start.activePlayerId;
    const wisp = deployUnit(start, active, 'fading_wisp');
    const sacrificed = choose(playCard(wisp.state, 'test_sac_outlet'), wisp.instanceId);

    // Reanimated: the card in the discard pile the promise was about is not the
    // unit now standing on the battlefield, so the return is dropped rather
    // than bouncing a unit its controller just paid to bring back.
    const revived = choose(playCard(sacrificed, 'test_reanimate'), wisp.instanceId);
    expect(instanceIn(revived, wisp.instanceId).zone).toBe('battlefield');
    expect(revived.delayedEffects).toHaveLength(0);
    expect(eventsOfType(revived, 'delayed_effect_expired').map((event) => event.reason)).toEqual([
      'subject_moved',
    ]);

    const next = endTurn(revived);
    expect(instanceIn(next, wisp.instanceId).zone).toBe('battlefield');
    expect(eventsOfType(next, 'delayed_effect_fired')).toHaveLength(0);
  });

  it('does not fire on a later turn than the one that created it', () => {
    const start = opened();
    const active = start.activePlayerId;
    const wisp = deployUnit(start, active, 'fading_wisp');
    const sacrificed = choose(playCard(wisp.state, 'test_sac_outlet'), wisp.instanceId);

    const next = endTurn(sacrificed);
    const fired = eventsOfType(next, 'delayed_effect_fired');
    expect(fired).toHaveLength(1);

    // Two more turn boundaries, and it never happens again.
    const later = endTurn(endTurn(next));
    expect(eventsOfType(later, 'delayed_effect_fired')).toHaveLength(1);
    expect(later.delayedEffects).toHaveLength(0);
  });
});

describe('marked_for_death — a watch that expires with the turn', () => {
  it('buffs the chosen unit and creates two Thralls when that unit is defeated', () => {
    const start = opened();
    const active = start.activePlayerId;
    const body = deployUnit(start, active, 'prototype_drone');

    const played = playCard(body.state, 'marked_for_death');
    // One decision only: the delayed half re-uses the buff's target.
    const resolved = choose(played, body.instanceId);
    expect(resolved.pendingChoice).toBeNull();

    const modifiers = instanceIn(resolved, body.instanceId).statModifiers;
    expect(modifiers).toHaveLength(1);
    expect(modifiers[0]?.attack).toBe(3);
    expect(modifiers[0]?.duration).toBe('end_of_turn');

    expect(resolved.delayedEffects).toHaveLength(1);
    const entry = resolved.delayedEffects[0]!;
    expect(entry.trigger).toBe('on_defeated');
    expect(entry.subjectInstanceId).toBe(body.instanceId);
    expect(entry.subjectZone).toBe('battlefield');

    const before = resolved.players[active]?.units.length ?? 0;
    const killed = choose(playCard(resolved, 'test_sac_outlet'), body.instanceId);

    // Two Thralls, minus the unit that died.
    expect(killed.players[active]?.units).toHaveLength(before + 1);
    const tokens = eventsOfType(killed, 'token_created').filter(
      (event) => event.definitionId === 'thrall_token',
    );
    expect(tokens).toHaveLength(2);
    expect(killed.delayedEffects).toHaveLength(0);
  });

  it('ends with the turn when the unit is never defeated', () => {
    const start = opened();
    const active = start.activePlayerId;
    const body = deployUnit(start, active, 'prototype_drone');
    const resolved = choose(playCard(body.state, 'marked_for_death'), body.instanceId);

    const next = endTurn(resolved);
    expect(next.delayedEffects).toHaveLength(0);
    expect(eventsOfType(next, 'delayed_effect_expired').map((event) => event.reason)).toEqual([
      'boundary_passed',
    ]);
    expect(
      eventsOfType(next, 'token_created').filter((event) => event.definitionId === 'thrall_token'),
    ).toHaveLength(0);
  });

  it('stops watching a unit that leaves the battlefield another way', () => {
    const start = opened();
    const active = start.activePlayerId;
    const body = deployUnit(start, active, 'prototype_drone');
    const resolved = choose(playCard(body.state, 'marked_for_death'), body.instanceId);

    const bounced = choose(playCard(resolved, 'test_recall'), body.instanceId);
    expect(bounced.delayedEffects).toHaveLength(0);
    expect(eventsOfType(bounced, 'delayed_effect_expired').map((event) => event.reason)).toEqual([
      'subject_moved',
    ]);
    expect(
      eventsOfType(bounced, 'token_created').filter(
        (event) => event.definitionId === 'thrall_token',
      ),
    ).toHaveLength(0);
  });

  it('cannot be played at all with no friendly Unit to mark', () => {
    const start = opened();
    // The delayed clause is about the Unit the first instruction buffs, so a
    // board with nothing to buff is a card with nothing to promise. The
    // existing legality gate refuses it before any of that is reached, which is
    // the outcome the delayed half depends on: `previous_target` is never asked
    // to bind against an instruction that did not happen.
    const placed = giveCard(start, start.activePlayerId, 'marked_for_death');
    const error = expectRejected(
      placed.state,
      { type: 'play_card', playerId: start.activePlayerId, instanceId: placed.instanceId },
      CONTEXT,
    );
    expect(error.code).toBe('engine/no_legal_target');
  });
});

describe('the general delayed-effect contract', () => {
  it('survives a JSON round trip mid-flight', () => {
    const start = opened();
    const active = start.activePlayerId;
    const body = deployUnit(start, active, 'prototype_drone');
    const resolved = choose(playCard(body.state, 'marked_for_death'), body.instanceId);
    expect(resolved.delayedEffects).toHaveLength(1);

    const round = deserializeMatchState(serializeMatchState(resolved));
    expect(isOk(round)).toBe(true);
    if (!isOk(round)) return;
    expect(round.value.delayedEffects).toEqual(resolved.delayedEffects);
    expect(round.value.nextDelayedOrdinal).toBe(resolved.nextDelayedOrdinal);

    // And it still fires from the restored state.
    const killed = choose(playCard(round.value, 'test_sac_outlet'), body.instanceId);
    expect(
      eventsOfType(killed, 'token_created').filter(
        (event) => event.definitionId === 'thrall_token',
      ),
    ).toHaveLength(2);
  });

  it('is public: every seat sees the same promises', () => {
    const start = opened();
    const active = start.activePlayerId;
    const other = opponentOf(start, active);
    const body = deployUnit(start, active, 'prototype_drone');
    const resolved = choose(playCard(body.state, 'marked_for_death'), body.instanceId);

    const mine = playerView(resolved, active, database);
    const theirs = playerView(resolved, other, database);
    expect(mine.delayedEffects).toEqual(theirs.delayedEffects);
    expect(mine.delayedEffects).toHaveLength(1);
    expect(mine.delayedEffects[0]?.definitionId).toBe('marked_for_death');
    expect(mine.delayedEffects[0]?.subjectInstanceId).toBe(body.instanceId);
  });

  it('ends with a controller who is eliminated', () => {
    const table = startTable(3, { database });
    const started = setEnergy(keepAll(table), table.playerOrder[0] as string, 10);
    const active = started.activePlayerId;

    const body = deployUnit(started, active, 'prototype_drone');
    const resolved = choose(playCard(body.state, 'marked_for_death'), body.instanceId);
    expect(resolved.delayedEffects).toHaveLength(1);

    // The seat that made the promise concedes; the promise goes with it, and
    // the unit it was about is cleared as part of the same elimination.
    const gone = apply(
      setHealth(resolved, active, 1),
      { type: 'concede', playerId: active },
      CONTEXT,
    );
    expect(gone.delayedEffects).toHaveLength(0);
    expect(eventsOfType(gone, 'delayed_effect_expired').map((event) => event.reason)).toContain(
      'controller_eliminated',
    );
  });

  it('gives every entry a distinct, ordered identity', () => {
    const start = opened();
    const active = start.activePlayerId;
    const first = deployUnit(start, active, 'fading_wisp');
    const second = deployUnit(first.state, active, 'fading_wisp');

    const one = choose(playCard(second.state, 'test_sac_outlet'), first.instanceId);
    const two = choose(playCard(one, 'test_sac_outlet'), second.instanceId);

    expect(delayedIds(two)).toEqual(['delayed_0000', 'delayed_0001']);
    const next = endTurn(two);
    expect(instanceIn(next, first.instanceId).zone).toBe('hand');
    expect(instanceIn(next, second.instanceId).zone).toBe('hand');
  });
});

/** Every seat keeps its opening hand, on the shared test database. */
function keepAll(state: MatchState): MatchState {
  let next = state;
  for (const playerId of state.seatOrder) {
    next = apply(next, { type: 'mulligan', playerId, returnInstanceIds: [] }, CONTEXT);
  }
  return next;
}
