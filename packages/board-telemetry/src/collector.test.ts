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

/**
 * One attack-opportunity census (M04.2).
 *
 * Spelled out per fixture rather than derived from the units the stream created,
 * because these are the *engine's* answers and the collector must not be tested
 * against a second implementation of the rules that decide them. The engine's
 * side of the contract — that the counts partition the board and match the
 * legality it enforces — is pinned in
 * `packages/rules-engine/src/attack-opportunity.test.ts`.
 */
function opportunity(
  playerId: string,
  counts: {
    units: number;
    readyUnits: number;
    legalAttackers: number;
    exhaustedUnits?: number;
    newlyDeployedUnits?: number;
    legalDefenders?: number;
    declaredAttackers: number;
  },
): EventBody {
  return {
    type: 'attack_opportunity',
    playerId,
    units: counts.units,
    readyUnits: counts.readyUnits,
    legalAttackers: counts.legalAttackers,
    exhaustedUnits: counts.exhaustedUnits ?? 0,
    newlyDeployedUnits: counts.newlyDeployedUnits ?? 0,
    legalDefenders: counts.legalDefenders ?? 1,
    declaredAttackers: counts.declaredAttackers,
  };
}

function readyPrevented(playerId: string, instanceId: string): EventBody {
  return {
    type: 'ready_prevented',
    instanceId,
    playerId,
    sourceInstanceId: null,
    sourceDefinitionId: null,
    abilityId: null,
    energySpent: 0,
  };
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
    opportunity('player_1', {
      units: 2,
      readyUnits: 2,
      legalAttackers: 2,
      declaredAttackers: 2,
    }),
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
    // Four Units, one of which arrived this turn and is held by Newly Deployed:
    // the seat attacked with everything it was allowed to.
    opportunity('player_2', {
      units: 4,
      readyUnits: 4,
      legalAttackers: 3,
      newlyDeployedUnits: 1,
      declaredAttackers: 3,
    }),
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

    // Round 3: nobody attacks — and seat 1 could have. That is the distinction
    // the baseline could not draw; the round looks identical in
    // `attackersByRound` either way.
    { type: 'turn_started', playerId: 'player_1', turn: 5 },
    opportunity('player_1', {
      units: 2,
      readyUnits: 2,
      legalAttackers: 2,
      declaredAttackers: 0,
    }),
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
    // Nothing here classifies the quiet rounds. The threshold that would make a
    // stall out of them is Q43, so the document carries the series a later cut
    // can be re-derived from and no flag at all.
    expect(Object.keys(telemetry)).not.toContain('boardStalled');
    expect(telemetry.attackOpportunity.classification).toBe('undetermined');
  });

  it('separates declining to attack from being unable to (M04.2)', () => {
    const telemetry = collect();
    const opportunity = telemetry.attackOpportunity;
    // Three attack steps: seat 1 attacked on turn 3, seat 2 on turn 4, seat 1
    // declined on turn 5. Every one of them could have attacked.
    expect(opportunity.steps).toBe(3);
    expect(opportunity.able).toBe(3);
    expect(opportunity.unable).toBe(0);
    expect(opportunity.declined).toBe(1);

    // Round 3 was quiet *and* somebody could have attacked, which the attacker
    // series cannot say and a stall threshold over it would have got backwards.
    expect(opportunity.byRound[2]).toEqual({
      round: 3,
      seatsAsked: 1,
      seatsAble: 1,
      seatsDeclining: 1,
      seatsWithoutUnits: 0,
      seatsAllExhausted: 0,
      seatsNewlyDeployed: 0,
      seatsWithoutDefender: 0,
      readyPreventions: 0,
      attackers: 0,
    });
    expect(opportunity.longestDeclinedStreak).toBe(1);
    expect(opportunity.longestUnableStreak).toBe(0);

    // Round 1 is quiet too, and nobody was asked in it — the match had not
    // reached an attack step. It counts as a quiet round and belongs to neither
    // streak, because there is no decision to attribute.
    expect(opportunity.byRound[0]?.seatsAsked).toBe(0);
    expect(telemetry.longestStallRounds).toBe(1);
  });

  it('attributes each attack step to the seat that took it', () => {
    const [first, second] = collect().seats;
    // The round series cannot say who declined: on a wide table one seat
    // sandbagging and three with nothing to attack with make the same quiet
    // round, and they are opposite findings about an unbounded battlefield.
    expect(first?.attackSteps).toBe(2);
    expect(first?.attackStepsAble).toBe(2);
    expect(first?.attackStepsDeclined).toBe(1);
    expect(first?.attackersDeclared).toBe(2);

    expect(second?.attackSteps).toBe(1);
    expect(second?.attackStepsDeclined).toBe(0);
    expect(second?.attackersDeclared).toBe(3);

    // Per seat, `able + unable` is every step it was asked in.
    for (const seat of [first, second]) {
      expect(seat?.attackSteps).toBe((seat?.attackStepsAble ?? 0) + (seat?.attackStepsUnable ?? 0));
    }
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

  /**
   * The three ways a seat can be unable to attack, and the effect that caused one
   * of them — the cases M04.2 has to keep apart from "chose not to".
   *
   * A separate stream because the main fixture is a match where people attack,
   * and these rounds are the opposite: an empty board, a board that all arrived
   * at once, and a board an opponent paid to keep Exhausted.
   */
  function unableEvents(): GameEvent[] {
    return stream([
      // Round 1. Seat 1 has nothing yet; seat 2 has two Units that arrived this
      // turn. Neither could attack, and neither declined.
      { type: 'turn_started', playerId: 'player_1', turn: 1 },
      opportunity('player_1', {
        units: 0,
        readyUnits: 0,
        legalAttackers: 0,
        declaredAttackers: 0,
      }),
      { type: 'turn_started', playerId: 'player_2', turn: 2 },
      entered('player_2', 't1', TOKEN),
      entered('player_2', 't2', TOKEN),
      opportunity('player_2', {
        units: 2,
        readyUnits: 2,
        legalAttackers: 0,
        newlyDeployedUnits: 2,
        declaredAttackers: 0,
      }),

      // Round 2. Seat 1's only Unit is held down by an effect at its Ready Step —
      // emitted *before* `turn_started`, which is where the Ready Step runs.
      readyPrevented('player_1', 'u1'),
      { type: 'turn_started', playerId: 'player_1', turn: 3 },
      opportunity('player_1', {
        units: 1,
        readyUnits: 0,
        legalAttackers: 0,
        exhaustedUnits: 1,
        declaredAttackers: 0,
      }),
      // Seat 2's Units have settled and it declines.
      { type: 'turn_started', playerId: 'player_2', turn: 4 },
      opportunity('player_2', {
        units: 2,
        readyUnits: 2,
        legalAttackers: 2,
        declaredAttackers: 0,
      }),
    ]);
  }

  function collectUnable(): ReturnType<typeof collectBoardTelemetry> {
    return collectBoardTelemetry({
      finalState: finalState(),
      events: unableEvents(),
      actionTurns: [1, 2, 3, 4],
      database,
      config,
      seats: SEATS,
    });
  }

  it('tells an empty board, a fresh board and a held-down board apart', () => {
    const opportunity = collectUnable().attackOpportunity;
    expect(opportunity.byRound[0]).toEqual({
      round: 1,
      seatsAsked: 2,
      seatsAble: 0,
      seatsDeclining: 0,
      // Early development on one side, the ruleset holding a board back on the
      // other. Both are "no attackers this round" and neither is a stall.
      seatsWithoutUnits: 1,
      seatsAllExhausted: 0,
      seatsNewlyDeployed: 1,
      seatsWithoutDefender: 0,
      readyPreventions: 0,
      attackers: 0,
    });
    expect(opportunity.byRound[1]).toEqual({
      round: 2,
      seatsAsked: 2,
      seatsAble: 1,
      seatsDeclining: 1,
      seatsWithoutUnits: 0,
      seatsAllExhausted: 1,
      seatsNewlyDeployed: 0,
      seatsWithoutDefender: 0,
      // Filed on the round the Ready Step belonged to, not the round that had
      // just ended when the event was emitted.
      readyPreventions: 1,
      attackers: 0,
    });

    // Two quiet rounds in a row, and they are quiet for opposite reasons. A
    // single "three rounds without an attack" counter added them together.
    expect(opportunity.longestUnableStreak).toBe(1);
    expect(opportunity.longestDeclinedStreak).toBe(1);
    expect(collectUnable().longestStallRounds).toBe(2);
    expect(opportunity.classification).toBe('undetermined');
  });

  it('does not call a seat with no opponent left "able to attack"', () => {
    // A free-for-all seat can reach its attack step with a board full of Ready
    // Units and nothing living to point them at, between the last elimination and
    // the match ending. It could not attack, and it did not decline.
    const telemetry = collectBoardTelemetry({
      finalState: finalState(),
      events: stream([
        { type: 'turn_started', playerId: 'player_1', turn: 1 },
        opportunity('player_1', {
          units: 3,
          readyUnits: 3,
          legalAttackers: 3,
          legalDefenders: 0,
          declaredAttackers: 0,
        }),
      ]),
      actionTurns: [1],
      database,
      config,
      seats: SEATS,
    });

    const round = telemetry.attackOpportunity.byRound[0];
    expect(round?.seatsWithoutDefender).toBe(1);
    expect(round?.seatsAble).toBe(0);
    expect(round?.seatsDeclining).toBe(0);
    expect(telemetry.attackOpportunity.unable).toBe(1);
    // A quiet round nobody could attack in, so it is the unable streak and not
    // the declined one — a seat cannot decline an attack it could not make.
    expect(telemetry.attackOpportunity.longestUnableStreak).toBe(1);
    expect(telemetry.attackOpportunity.longestDeclinedStreak).toBe(0);
  });

  it('counts a prevented Ready Step against the seat whose permanent it was', () => {
    const [first, second] = collectUnable().seats;
    expect(first?.readyPreventions).toBe(1);
    expect(second?.readyPreventions).toBe(0);
    // Counted from the event rather than inferred from an Exhausted Unit: a Unit
    // that attacked last turn and a Unit somebody paid to keep down are the same
    // board and different findings.
    expect(first?.attackStepsUnable).toBe(2);
    expect(first?.attackStepsAble).toBe(0);
  });

  it('every round adds up, in both fixtures', () => {
    // The partition is the guarantee that makes the series readable at all. A
    // round whose outcomes do not sum to `seatsAsked` means a census was filed
    // under two reasons or none.
    for (const telemetry of [collect(), collectUnable()]) {
      let steps = 0;
      for (const round of telemetry.attackOpportunity.byRound) {
        expect(round.seatsAsked).toBe(
          round.seatsAble +
            round.seatsWithoutUnits +
            round.seatsAllExhausted +
            round.seatsNewlyDeployed +
            round.seatsWithoutDefender,
        );
        expect(round.seatsDeclining).toBeLessThanOrEqual(round.seatsAble);
        expect(round.attackers).toBe(telemetry.attackersByRound[round.round - 1]);
        steps += round.seatsAsked;
      }
      expect(telemetry.attackOpportunity.steps).toBe(steps);
      expect(steps).toBe(telemetry.seats.reduce((sum, seat) => sum + seat.attackSteps, 0));
    }
  });

  it('reaches the same attack-opportunity answer streamed as replayed', () => {
    // The buffered Ready-Step prevention is the one accumulator whose answer
    // depends on an event that arrives *before* the round it belongs to, so the
    // equality M04 turns on is asserted on the fixture that exercises it too.
    const streamed = new BoardTelemetryCollector({ database, config, seats: SEATS });
    streamed.observeEvents(unableEvents());
    for (const turn of [1, 2, 3, 4]) streamed.observeAction(turn);
    expect(streamed.finish(finalState())).toEqual(collectUnable());
  });

  it('carries no playback timing at all', () => {
    // The shape itself is the guarantee: there is nowhere for a viewer's chosen
    // delay to land, in either path.
    const keys = Object.keys(collect()).join(' ');
    expect(keys).not.toMatch(/ms|millis|duration|elapsed|wall/i);
  });
});
