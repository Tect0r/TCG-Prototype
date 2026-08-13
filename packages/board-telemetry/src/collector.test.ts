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
import { reconcileBoardTelemetry } from './reconcile.js';
import { boardTelemetrySchema, emptyBoardTelemetry } from './schema.js';
import { DEFAULT_STALL_DEFINITION, type StallDefinition } from './stall.js';

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
      provenance: {
        origin: 'instruction',
        itemId: 'res_0001',
        effectIndex: 0,
        effectType: 'destroy',
        sourceControllerId: 'player_1',
        chooser: 'source_controller',
        targetRelation: 'opponent',
        intent: 'detriment',
      },
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

  it('records the per-round attacker series beside the verdict cut from it', () => {
    const telemetry = collect();
    expect(telemetry.attackersByRound).toEqual([0, 5, 0]);
    expect(telemetry.longestStallRounds).toBe(1);
    // The raw series survives the arrival of a verdict (M04.3): the streak the
    // classification was cut from is stored, so a different threshold can be
    // applied to a finished document without re-simulating the match.
    expect(Object.keys(telemetry)).not.toContain('boardStalled');
    expect(telemetry.attackOpportunity.longestUnanimousDeclinedStreak).toBe(0);
    expect(telemetry.attackOpportunity.classification).toBe('not_stalled');
    expect(telemetry.attackOpportunity.stallDefinition).toEqual(DEFAULT_STALL_DEFINITION);
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
      livingSeats: 2,
      seatsAsked: 1,
      seatsAble: 1,
      seatsDeclining: 1,
      seatsWithoutUnits: 0,
      seatsAllExhausted: 0,
      seatsNewlyDeployed: 0,
      seatsWithoutDefender: 0,
      readyPreventions: 0,
      attackers: 0,
      // Somebody declined, but the round only asked one of the two living seats
      // — the match ended in it. Under the strict rule Q43 chose that is not a
      // stall round, and the permissive `longestDeclinedStreak` below still sees
      // it. The two readings are kept apart rather than merged.
      stallEligible: false,
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
      livingSeats: 2,
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
      // Round 1 excludes itself, with no round-index special case anywhere: an
      // empty board is not able and a board that all arrived this turn is held by
      // Newly Deployed, so the ordinary rule already refuses it (Q43c).
      stallEligible: false,
    });
    expect(opportunity.byRound[1]).toEqual({
      round: 2,
      livingSeats: 2,
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
      // One of the two seats could not attack, so the table did not collectively
      // decline: an effect held it down. Not a stall round.
      stallEligible: false,
    });

    // Two quiet rounds in a row, and they are quiet for opposite reasons. A
    // single "three rounds without an attack" counter added them together.
    expect(opportunity.longestUnableStreak).toBe(1);
    expect(opportunity.longestDeclinedStreak).toBe(1);
    expect(collectUnable().longestStallRounds).toBe(2);
    // Two quiet rounds and neither is a stall round: the strict rule counts
    // neither, so the verdict is a real "no" rather than a pending one.
    expect(opportunity.longestUnanimousDeclinedStreak).toBe(0);
    expect(opportunity.classification).toBe('not_stalled');
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

/**
 * M04.3 — the configured stall definition (Q43).
 *
 * The rule: a round counts only when every living seat reached its attack step,
 * every one of them could legally have attacked, and none did; three consecutive
 * such rounds is a stall. These fixtures exist to show each clause doing work,
 * because a rule this strict is only trustworthy if it can be seen refusing.
 */
describe('stall definition', () => {
  const FOUR_SEATS = [
    { playerId: 'player_1', seatIndex: 0, commanderId: COMMANDER },
    { playerId: 'player_2', seatIndex: 1, commanderId: COMMANDER },
    { playerId: 'player_3', seatIndex: 2, commanderId: COMMANDER },
    { playerId: 'player_4', seatIndex: 3, commanderId: COMMANDER },
  ] as const;

  function finalStateFor(seats: readonly { playerId: string }[]): MatchState {
    const created = createMatch({
      matchId: 'stall-definition',
      seed: 'stall-definition',
      database,
      config,
      preserveSeatOrder: true,
      seats: seats.map((seat) => ({ playerId: seat.playerId, name: seat.playerId, deck: deck() })),
    });
    if (!created.ok) throw new Error(`fixture match setup failed: ${created.error.code}`);
    return created.value.state;
  }

  /** A seat that could attack with everything it has and declared `declared`. */
  function ableStep(playerId: string, declared: number): EventBody {
    return opportunity(playerId, {
      units: 2,
      readyUnits: 2,
      legalAttackers: 2,
      declaredAttackers: declared,
    });
  }

  function collectWith(
    events: GameEvent[],
    seats: readonly { playerId: string; seatIndex: number; commanderId: string }[],
    stallDefinition?: StallDefinition,
  ): ReturnType<typeof collectBoardTelemetry> {
    return collectBoardTelemetry({
      finalState: finalStateFor(seats),
      events,
      actionTurns: [],
      database,
      config,
      seats,
      ...(stallDefinition ? { stallDefinition } : {}),
    });
  }

  /**
   * Six turns of a two-seat table in which both seats can attack every round and
   * neither ever does. Three eligible rounds: the rule's positive case.
   */
  function unanimousDeclineEvents(roundThreeAttackers: number): GameEvent[] {
    return stream([
      { type: 'turn_started', playerId: 'player_1', turn: 1 },
      entered('player_1', 'u1', DRONE),
      entered('player_1', 'u2', DRONE),
      ableStep('player_1', 0),
      { type: 'turn_started', playerId: 'player_2', turn: 2 },
      entered('player_2', 'v1', DRONE),
      entered('player_2', 'v2', DRONE),
      ableStep('player_2', 0),

      { type: 'turn_started', playerId: 'player_1', turn: 3 },
      ableStep('player_1', 0),
      { type: 'turn_started', playerId: 'player_2', turn: 4 },
      ableStep('player_2', 0),

      { type: 'turn_started', playerId: 'player_1', turn: 5 },
      ableStep('player_1', 0),
      { type: 'turn_started', playerId: 'player_2', turn: 6 },
      ableStep('player_2', roundThreeAttackers),
      ...(roundThreeAttackers > 0
        ? [
            {
              type: 'attackers_declared' as const,
              playerId: 'player_2',
              instanceIds: ['v1'],
              attacks: [{ attackerInstanceId: 'v1', defenderPlayerId: 'player_1' }],
            },
          ]
        : []),
    ]);
  }

  it('calls three rounds of unanimous declining a stall', () => {
    const telemetry = collectWith(unanimousDeclineEvents(0), SEATS);
    const opportunity = telemetry.attackOpportunity;

    expect(opportunity.byRound.map((round) => round.stallEligible)).toEqual([true, true, true]);
    expect(opportunity.longestUnanimousDeclinedStreak).toBe(3);
    expect(opportunity.classification).toBe('stalled');

    // The strict streak is a subset of the permissive one by construction, and
    // both are kept: "everyone could and nobody did" is the verdict, "somebody
    // could and nobody did" is the wider observation it was cut from.
    expect(opportunity.longestDeclinedStreak).toBe(3);
    expect(opportunity.longestUnableStreak).toBe(0);
    // Every round asked the whole table. That is what makes it unanimous.
    for (const round of opportunity.byRound) {
      expect(round.seatsAsked).toBe(round.livingSeats);
      expect(round.seatsAble).toBe(round.seatsAsked);
    }
  });

  it('lets a single declared attacker break the streak', () => {
    // Q43d: any attacker makes the round non-quiet, one Token included. Round 3
    // is otherwise identical to the stalled fixture's.
    const telemetry = collectWith(unanimousDeclineEvents(1), SEATS);
    const opportunity = telemetry.attackOpportunity;

    expect(opportunity.byRound.map((round) => round.stallEligible)).toEqual([true, true, false]);
    expect(opportunity.longestUnanimousDeclinedStreak).toBe(2);
    expect(opportunity.classification).toBe('not_stalled');
  });

  it('breaks the streak on a round one seat could not have attacked in', () => {
    // The clause that separates this rule from the baseline. Round 2 is quiet and
    // somebody declined in it, so the permissive streak runs through all four
    // rounds; the strict one restarts, because the table did not collectively
    // choose peace — one seat had no choice.
    const telemetry = collectWith(
      stream([
        { type: 'turn_started', playerId: 'player_1', turn: 1 },
        entered('player_1', 'u1', DRONE),
        ableStep('player_1', 0),
        { type: 'turn_started', playerId: 'player_2', turn: 2 },
        entered('player_2', 'v1', DRONE),
        ableStep('player_2', 0),

        { type: 'turn_started', playerId: 'player_1', turn: 3 },
        ableStep('player_1', 0),
        { type: 'turn_started', playerId: 'player_2', turn: 4 },
        opportunity('player_2', {
          units: 2,
          readyUnits: 0,
          legalAttackers: 0,
          exhaustedUnits: 2,
          declaredAttackers: 0,
        }),

        { type: 'turn_started', playerId: 'player_1', turn: 5 },
        ableStep('player_1', 0),
        { type: 'turn_started', playerId: 'player_2', turn: 6 },
        ableStep('player_2', 0),

        { type: 'turn_started', playerId: 'player_1', turn: 7 },
        ableStep('player_1', 0),
        { type: 'turn_started', playerId: 'player_2', turn: 8 },
        ableStep('player_2', 0),
      ]),
      SEATS,
    );
    const observed = telemetry.attackOpportunity;

    expect(observed.byRound.map((round) => round.stallEligible)).toEqual([true, false, true, true]);
    expect(observed.longestUnanimousDeclinedStreak).toBe(2);
    expect(observed.longestDeclinedStreak).toBe(4);
    expect(observed.classification).toBe('not_stalled');
  });

  /**
   * A four-seat table that loses a player, which is the case `seatsAsked` alone
   * cannot judge: three seats asked is the whole table afterwards and a missing
   * seat before.
   */
  function fourSeatEvents(): GameEvent[] {
    return stream([
      { type: 'turn_started', playerId: 'player_1', turn: 1 },
      entered('player_1', 'u1', DRONE),
      ableStep('player_1', 0),
      { type: 'turn_started', playerId: 'player_2', turn: 2 },
      ableStep('player_2', 0),
      { type: 'turn_started', playerId: 'player_3', turn: 3 },
      ableStep('player_3', 0),
      { type: 'turn_started', playerId: 'player_4', turn: 4 },
      ableStep('player_4', 0),
      { type: 'player_eliminated', playerId: 'player_4', turn: 4 },

      // Round 2: three seats left, all three asked, all three able, still quiet.
      { type: 'turn_started', playerId: 'player_1', turn: 5 },
      ableStep('player_1', 0),
      { type: 'turn_started', playerId: 'player_2', turn: 6 },
      ableStep('player_2', 0),
      { type: 'turn_started', playerId: 'player_3', turn: 7 },
      ableStep('player_3', 0),
    ]);
  }

  it('measures a round against the seats that were alive for it', () => {
    const telemetry = collectWith(fourSeatEvents(), FOUR_SEATS);
    const [first, second] = telemetry.attackOpportunity.byRound;

    expect(first).toMatchObject({ round: 1, livingSeats: 4, seatsAsked: 4, stallEligible: true });
    // Three of four seats asked *is* the whole table once one has been
    // eliminated. Against a fixed seat count this round would have been refused.
    expect(second).toMatchObject({ round: 2, livingSeats: 3, seatsAsked: 3, stallEligible: true });
    expect(telemetry.attackOpportunity.longestUnanimousDeclinedStreak).toBe(2);
    // Two eligible rounds against a threshold of three.
    expect(telemetry.attackOpportunity.classification).toBe('not_stalled');
  });

  it('takes the living-seat count at the start of the round, not the end', () => {
    // player_4 was eliminated during round 1, after taking its turn. The round
    // asked four seats because four seats had turns in it, so counting survivors
    // instead would refuse a round that was in fact unanimous.
    const round = collectWith(fourSeatEvents(), FOUR_SEATS).attackOpportunity.byRound[0];
    expect(round?.livingSeats).toBe(4);
    expect(round?.stallEligible).toBe(true);
  });

  it('applies a configured threshold and records which one it used', () => {
    // Q43 required the number to be explicit, configurable and versioned rather
    // than a judgement in the reporting layer — so the same evidence classifies
    // differently under a different threshold, and the document says which.
    const definition: StallDefinition = { ...DEFAULT_STALL_DEFINITION, thresholdRounds: 2 };
    const telemetry = collectWith(fourSeatEvents(), FOUR_SEATS, definition);

    expect(telemetry.attackOpportunity.longestUnanimousDeclinedStreak).toBe(2);
    expect(telemetry.attackOpportunity.classification).toBe('stalled');
    expect(telemetry.attackOpportunity.stallDefinition).toEqual(definition);

    // The raw streak is identical either way: only the verdict moved.
    const shipped = collectWith(fourSeatEvents(), FOUR_SEATS);
    expect(shipped.attackOpportunity.longestUnanimousDeclinedStreak).toBe(
      telemetry.attackOpportunity.longestUnanimousDeclinedStreak,
    );
    expect(shipped.attackOpportunity.stallDefinition.thresholdRounds).toBe(3);
  });

  it('never calls a table with no legal attacker a stall', () => {
    // Three quiet rounds in which nobody could attack at all — the exact input the
    // baseline's "three rounds without attackers" counted as a stall. Under the
    // rule Q43 chose it is the opposite finding, and the verdict says so.
    const bodies: EventBody[] = [];
    for (let turn = 1; turn <= 6; turn += 1) {
      const playerId = turn % 2 === 1 ? 'player_1' : 'player_2';
      bodies.push({ type: 'turn_started', playerId, turn });
      bodies.push(
        opportunity(playerId, {
          units: 1,
          readyUnits: 0,
          legalAttackers: 0,
          exhaustedUnits: 1,
          declaredAttackers: 0,
        }),
      );
    }
    const telemetry = collectWith(stream(bodies), SEATS);

    expect(telemetry.longestStallRounds).toBe(3);
    expect(telemetry.attackOpportunity.longestUnableStreak).toBe(3);
    expect(telemetry.attackOpportunity.longestUnanimousDeclinedStreak).toBe(0);
    expect(telemetry.attackOpportunity.classification).toBe('not_stalled');
    expect(telemetry.attackOpportunity.byRound.every((round) => !round.stallEligible)).toBe(true);
  });

  it('measures a token-heavy board without calling it stalled', () => {
    // Clutter and stalling are different complaints about an unbounded
    // battlefield (M04 acceptance). This board is very wide and very active, and
    // the numbers have to be able to say both things at once.
    const bodies: EventBody[] = [{ type: 'turn_started', playerId: 'player_1', turn: 1 }];
    for (let index = 0; index < 40; index += 1) {
      bodies.push(entered('player_1', `t${index}`, TOKEN));
    }
    bodies.push(
      opportunity('player_1', {
        units: 40,
        readyUnits: 40,
        legalAttackers: 40,
        declaredAttackers: 40,
      }),
      {
        type: 'attackers_declared',
        playerId: 'player_1',
        instanceIds: Array.from({ length: 40 }, (_, index) => `t${index}`),
        attacks: Array.from({ length: 40 }, (_, index) => ({
          attackerInstanceId: `t${index}`,
          defenderPlayerId: 'player_2',
        })),
      },
    );
    const telemetry = collectWith(stream(bodies), SEATS);
    const [first] = telemetry.seats;

    expect(first?.peakUnits).toBe(40);
    expect(first?.peakTokens).toBe(40);
    // One definition, so the whole board is one visual stack — the clutter
    // measure M06/Q42 will present and must not be allowed to move.
    expect(first?.peakTokenStack).toBe(40);
    expect(telemetry.largestCombat.attackers).toBe(40);
    expect(telemetry.attackOpportunity.classification).toBe('not_stalled');
  });

  it('records a wide board being answered, and does not call that a stall either', () => {
    // The anti-wide case: a board reaches 40 and a sweeper removes 38 of them.
    // "The largest board was answered" is the finding, and it is the opposite of
    // both a stall and an unanswerable board.
    const bodies: EventBody[] = [{ type: 'turn_started', playerId: 'player_1', turn: 1 }];
    for (let index = 0; index < 40; index += 1) {
      bodies.push(entered('player_1', `t${index}`, TOKEN));
    }
    bodies.push({ type: 'turn_started', playerId: 'player_2', turn: 2 });
    for (let index = 0; index < 38; index += 1) {
      bodies.push(defeated(`t${index}`, TOKEN, 'player_1', 'destroyed'));
    }
    const telemetry = collectWith(stream(bodies), SEATS);

    expect(telemetry.largestBoardAnswer).toEqual({
      playerId: 'player_1',
      peakUnits: 40,
      unitsLostAfterPeak: 38,
      reasons: ['destroyed'],
    });
    expect(telemetry.attackOpportunity.classification).toBe('not_stalled');
  });

  it('reaches the same verdict streamed live as replayed at the end', () => {
    // The verdict is derived in `finish`, from accumulators the streaming path
    // fills one event at a time. Reconciled rather than merely compared, so a
    // regression names the field that moved (M04.3).
    const events = unanimousDeclineEvents(0);
    const streamed = new BoardTelemetryCollector({ database, config, seats: SEATS });
    streamed.observeEvents(events);

    const reconciliation = reconcileBoardTelemetry(
      streamed.finish(finalStateFor(SEATS)),
      collectWith(unanimousDeclineEvents(0), SEATS),
    );
    expect(reconciliation.differences).toEqual([]);
    expect(reconciliation.agreed).toBe(true);
  });

  it('names the fields that disagree when two documents differ', () => {
    const stalled = collectWith(unanimousDeclineEvents(0), SEATS);
    const quiet = collectWith(unanimousDeclineEvents(1), SEATS);
    const reconciliation = reconcileBoardTelemetry(stalled, quiet);

    expect(reconciliation.agreed).toBe(false);
    // A path, not a diff of two forty-field objects: the point of the helper is
    // that a spectator/simulator disagreement is legible without a debugger.
    expect(reconciliation.differences).toContain(
      'attackOpportunity.classification: "stalled" !== "not_stalled"',
    );
    expect(reconciliation.differences).toContain(
      'attackOpportunity.byRound[2].stallEligible: true !== false',
    );
  });
});
