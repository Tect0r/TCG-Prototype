import { describe, expect, it } from 'vitest';
import { loadBundledCardData } from '@tcg/card-data';
import {
  createMatch,
  DEFAULT_RULES_CONFIG,
  type GameEvent,
  type MatchDeck,
  type MatchState,
} from '@tcg/rules-engine';
import { BoardTelemetryCollector, collectBoardTelemetry } from './collector.js';
import { boardTelemetrySchema, emptyBoardTelemetry } from './schema.js';

/**
 * M04.1 — the shared board collector.
 *
 * These fixtures are hand-written event streams rather than played matches, and
 * deliberately so: every number here is a *definition* — what "peak board"
 * forgets when the peak moves, what counts as one combat, what a quiet round is
 * — and a definition is only tested by a stream whose answer can be read off it
 * by hand. That the definitions hold on real matches is asserted where real
 * matches are played: `apps/simulator/src/board-telemetry.test.ts` runs one and
 * checks the live and replayed paths agree exactly.
 */

const { database } = loadBundledCardData();
const config = DEFAULT_RULES_CONFIG;

const TOKEN = 'prototype_soldier_token';
const DRONE = 'prototype_drone';
const COMMANDER = 'prototype_commander_blue';

const SEATS = [
  { playerId: 'player_1', seatIndex: 0, commanderId: COMMANDER },
  { playerId: 'player_2', seatIndex: 1, commanderId: COMMANDER },
] as const;

function deck(): MatchDeck {
  return { commanderId: COMMANDER, cards: [{ cardId: DRONE, quantity: 30 }] };
}

/** A real final state, so `finish` reads real players rather than a stub. */
function finalState(): MatchState {
  const created = createMatch({
    matchId: 'board-telemetry',
    seed: 'board-telemetry',
    database,
    config,
    preserveSeatOrder: true,
    seats: SEATS.map((seat) => ({ playerId: seat.playerId, name: seat.playerId, deck: deck() })),
  });
  if (!created.ok) throw new Error(`fixture match setup failed: ${created.error.code}`);
  return created.value.state;
}

/** Event bodies without the provenance every real event carries. */
type EventBody = {
  [K in GameEvent['type']]: Omit<Extract<GameEvent, { type: K }>, 'sequence' | 'cause'>;
}[GameEvent['type']];

function stream(bodies: readonly EventBody[]): GameEvent[] {
  return bodies.map(
    (body, index) =>
      ({
        ...body,
        sequence: index + 1,
        cause: { actionType: null, sourceInstanceId: null, resolutionId: null },
      }) as GameEvent,
  );
}

function entered(playerId: string, instanceId: string, definitionId: string): EventBody {
  return { type: 'unit_entered_battlefield', playerId, instanceId, definitionId, method: 'effect' };
}

function defeated(
  instanceId: string,
  definitionId: string,
  controllerId: string,
  reason: 'lethal_damage' | 'destroyed' | 'sacrificed' | 'zero_health',
): EventBody {
  return { type: 'unit_defeated', instanceId, definitionId, controllerId, reason };
}

function trigger(instanceId: string, definitionId: string, controllerId: string): EventBody {
  return {
    type: 'trigger_queued',
    sourceInstanceId: instanceId,
    definitionId,
    controllerId,
    abilityId: null,
    triggerId: 'fixture',
    resolutionId: 'fixture',
  };
}

/**
 * Turns 1–5 of a two-seat table.
 *
 * Round 1 (turns 1–2) is development, round 2 (turns 3–4) holds both combats,
 * round 3 (turn 5) is quiet. Seat 1 fields two ordinary Units; seat 2 fields
 * three Tokens of one definition and then a fourth Unit *after* losing one, so
 * the peak-board reduction has an earlier, smaller high-water mark to forget.
 */
function fixtureEvents(): GameEvent[] {
  return stream([
    { type: 'turn_started', playerId: 'player_1', turn: 1 },
    entered('player_1', 'u1', DRONE),
    entered('player_1', 'u2', DRONE),

    { type: 'turn_started', playerId: 'player_2', turn: 2 },
    entered('player_2', 't1', TOKEN),
    entered('player_2', 't2', TOKEN),
    entered('player_2', 't3', TOKEN),

    // Round 2. A small combat that is expensive to resolve.
    { type: 'turn_started', playerId: 'player_1', turn: 3 },
    {
      type: 'attackers_declared',
      playerId: 'player_1',
      instanceIds: ['u1', 'u2'],
      attacks: [
        { attackerInstanceId: 'u1', defenderPlayerId: 'player_2' },
        { attackerInstanceId: 'u2', defenderPlayerId: 'player_2' },
      ],
    },
    {
      type: 'blockers_assigned',
      playerId: 'player_2',
      blocks: [{ attackerInstanceId: 'u1', blockerInstanceId: 't1' }],
    },
    trigger('u1', DRONE, 'player_1'),
    trigger('u2', DRONE, 'player_1'),
    defeated('t1', TOKEN, 'player_2', 'lethal_damage'),
    {
      type: 'choice_requested',
      choiceId: 'c1',
      playerId: 'player_1',
      choiceType: 'select_units',
      reason: 'effect_target',
      minimum: 1,
      maximum: 1,
      validEntityIds: ['t2'],
    },
    { type: 'phase_changed', from: 'resolve_combat', to: 'main_2' },
    // After the combat, so it is not counted as part of resolving it.
    trigger('u1', DRONE, 'player_1'),

    // A wider combat that resolves in fewer events, and a fourth Unit for seat 2
    // that moves its peak.
    { type: 'turn_started', playerId: 'player_2', turn: 4 },
    entered('player_2', 't4', TOKEN),
    entered('player_2', 't5', TOKEN),
    {
      type: 'attackers_declared',
      playerId: 'player_2',
      instanceIds: ['t2', 't3', 't4'],
      attacks: [
        { attackerInstanceId: 't2', defenderPlayerId: 'player_1' },
        { attackerInstanceId: 't3', defenderPlayerId: 'player_1' },
        { attackerInstanceId: 't4', defenderPlayerId: 'player_1' },
      ],
    },
    { type: 'blockers_assigned', playerId: 'player_1', blocks: [] },
    defeated('t2', TOKEN, 'player_2', 'destroyed'),
    { type: 'phase_changed', from: 'resolve_combat', to: 'main_2' },

    // Round 3: nobody attacks.
    { type: 'turn_started', playerId: 'player_1', turn: 5 },
    {
      type: 'card_moved',
      instanceId: 'u2',
      definitionId: DRONE,
      playerId: 'player_1',
      fromZone: 'battlefield',
      toZone: 'hand',
    },
  ]);
}

/** One accepted action per turn, plus two more on turn 3. */
const ACTION_TURNS = [1, 2, 3, 3, 3, 4, 5];

function collect(): ReturnType<typeof collectBoardTelemetry> {
  return collectBoardTelemetry({
    finalState: finalState(),
    events: fixtureEvents(),
    actionTurns: ACTION_TURNS,
    database,
    config,
    seats: SEATS,
  });
}

describe('board telemetry', () => {
  it('validates against its own schema', () => {
    expect(() => boardTelemetrySchema.parse(collect())).not.toThrow();
    expect(() => boardTelemetrySchema.parse(emptyBoardTelemetry())).not.toThrow();
  });

  it('counts each seat at every round boundary, not at the end', () => {
    const telemetry = collect();
    expect(telemetry.rounds).toBe(3);
    const [first, second] = telemetry.seats;
    // Round 1 closes after turn 2, round 2 after turn 4, round 3 at the end.
    expect(first?.unitsByRound).toEqual([2, 2, 1]);
    expect(second?.unitsByRound).toEqual([3, 3, 3]);
    // Every seat's series is the same length, so a chart can read them side by
    // side without aligning indexes.
    expect(second?.unitsByRound.length).toBe(first?.unitsByRound.length);
  });

  it('separates Tokens, non-Token Units and the largest visual stack', () => {
    const [first, second] = collect().seats;
    expect(first?.peakUnits).toBe(2);
    expect(first?.peakTokens).toBe(0);
    expect(first?.peakNonTokenUnits).toBe(2);

    expect(second?.peakUnits).toBe(4);
    expect(second?.peakTokens).toBe(4);
    expect(second?.peakNonTokenUnits).toBe(0);
    // One definition, so the whole board is one visual stack — and the number
    // says so whether or not a client groups them (M06/Q42 cannot move it).
    expect(second?.peakTokenStack).toBe(4);
    expect(second?.peakTokensByDefinition).toEqual({ [TOKEN]: 4 });
  });

  it('forgets an earlier peak when a wider board replaces it', () => {
    const telemetry = collect();
    const second = telemetry.seats[1];
    // Seat 2 lost a Token at three, then reached four. Only the loss after the
    // *largest* board counts, so the answer describes the board that mattered.
    expect(second?.peakUnits).toBe(4);
    expect(second?.unitsLostAfterPeak).toBe(1);
    expect(second?.lossReasonsAfterPeak).toEqual({ destroyed: 1 });
    expect(telemetry.largestBoardAnswer).toEqual({
      playerId: 'player_2',
      peakUnits: 4,
      unitsLostAfterPeak: 1,
      reasons: ['destroyed'],
    });
  });

  it('counts a Unit that left the battlefield without dying', () => {
    // A bounce is a board reduction too, and attributing it to the zone it went
    // to is what keeps "the board was answered" separable from "it was removed".
    const first = collect().seats[0];
    expect(first?.unitsLostAfterPeak).toBe(1);
    expect(first?.lossReasonsAfterPeak).toEqual({ moved_to_hand: 1 });
  });

  it('measures the largest combat and the most expensive one separately', () => {
    const telemetry = collect();
    // Turn 3: two attackers, six events between declaration and leaving combat.
    expect(telemetry.longestCombatResolution).toEqual({
      turn: 3,
      attackers: 2,
      blockers: 1,
      resolutionEvents: 6,
    });
    // Turn 4: more attackers, cheaper to resolve. A board that is wide and a
    // board that is slow are different complaints about an unbounded battlefield.
    expect(telemetry.largestCombat).toEqual({
      turn: 4,
      attackers: 3,
      blockers: 0,
      resolutionEvents: 3,
    });
  });

  it('names the busiest turn by triggers and reports its choices', () => {
    const telemetry = collect();
    expect(telemetry.busiestTurn).toEqual({ turn: 3, triggers: 3, choices: 1 });
    expect(telemetry.longestTurn).toEqual({ turn: 3, actions: 3 });
    expect(telemetry.actions).toBe(ACTION_TURNS.length);
    expect(telemetry.events).toBe(fixtureEvents().length);
  });

  it('records the per-round attacker series and the quiet streak, not a verdict', () => {
    const telemetry = collect();
    expect(telemetry.attackersByRound).toEqual([0, 5, 0]);
    expect(telemetry.longestStallRounds).toBe(1);
    // Nothing here classifies the quiet rounds. Whether anybody *could* have
    // attacked is M04.2 and the threshold is Q43, so the document carries the
    // series a later cut can be re-derived from and no flag at all.
    expect(Object.keys(telemetry)).not.toContain('boardStalled');
  });

  it('reaches the same answer streamed live as replayed at the end', () => {
    // The acceptance property M04 turns on: the simulator feeds this collector
    // while the match runs and the spectator feeds it a finished log, and the
    // two must not be able to disagree.
    const events = fixtureEvents();
    const streamed = new BoardTelemetryCollector({ database, config, seats: SEATS });
    let action = 0;
    for (const event of events) {
      streamed.observeEvents([event]);
      // Actions arrive interleaved with the events they produced, which is what
      // a live driver does and what a replay cannot reproduce.
      if (event.type === 'turn_started') {
        while (action < ACTION_TURNS.length && ACTION_TURNS[action] === event.turn) {
          streamed.observeAction(ACTION_TURNS[action] ?? 0);
          action += 1;
        }
      }
    }
    expect(streamed.finish(finalState())).toEqual(collect());
  });

  it('carries no playback timing at all', () => {
    // The shape itself is the guarantee: there is nowhere for a viewer's chosen
    // delay to land, in either path.
    const keys = Object.keys(collect()).join(' ');
    expect(keys).not.toMatch(/ms|millis|duration|elapsed|wall/i);
  });
});
