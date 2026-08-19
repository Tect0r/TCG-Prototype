import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STALL_DEFINITION,
  boardTelemetrySchema,
  collectBoardTelemetry,
  reconcileBoardTelemetry,
} from '@tcg/board-telemetry';
import { PILOT_IDS, type PilotId } from '@tcg/bot-interface';
import { collectTelemetry } from '@tcg/spectator';
import { deriveSeedBundle } from './seed.js';
import { generateDeck, toMatchDeck, type SimDeck } from '@tcg/deck-generator';
import { runMatch, type RunMatchOptions, type RunMatchResult } from './run-match.js';
import { FAST_LIMITS, VALUE_PILOT, AGGRESSIVE_PILOT, tinyEnvironment } from './test-fixtures.js';
import type { Environment } from './environment.js';

/**
 * M04.1 — the simulator records the same board telemetry a watched match does.
 *
 * The acceptance criterion this milestone turns on is that a deterministic match
 * produces *identical* board telemetry in the spectator and simulator paths.
 * Those paths differ in exactly one way: the simulator feeds the collector live,
 * because a large batch must not retain every match's log
 * (`CLAUDE.md` §13.14), while the spectator hands it a finished replay. So the
 * check here re-derives the telemetry from the log this match happened to keep
 * and requires it to equal the one accumulated as the match ran — the same
 * collector, the same stream, byte for byte.
 */

/**
 * A record's pilot ID as the spectator's stricter seat type wants it.
 *
 * Checked rather than cast: if a simulator pilot ever exists that a watched match
 * cannot seat, this test should say so out loud rather than reconcile telemetry
 * for a seat configuration the spectator would have refused.
 */
function pilotIdOf(id: string): PilotId {
  const known = PILOT_IDS.find((candidate) => candidate === id);
  if (known === undefined) throw new Error(`not a spectator pilot: ${id}`);
  return known;
}

async function play(
  environment: Environment,
  left: SimDeck,
  right: SimDeck,
  seed: string,
): Promise<RunMatchResult> {
  const options: RunMatchOptions = {
    experimentId: 'board-telemetry',
    experimentKind: 'batch',
    configHash: 'board-telemetry-test',
    arm: null,
    environment,
    matchId: `m_${seed}`,
    orderKey: seed,
    deckPairId: 'pair',
    variantKey: 'variant',
    gameIndex: 0,
    orientation: 0,
    seeds: deriveSeedBundle(seed, 2),
    limits: FAST_LIMITS,
    seats: [
      {
        playerId: 'player_1',
        deckId: left.id,
        deckHash: left.hash,
        deck: toMatchDeck(left),
        pilot: VALUE_PILOT,
      },
      {
        playerId: 'player_2',
        deckId: right.id,
        deckHash: right.hash,
        deck: toMatchDeck(right),
        pilot: AGGRESSIVE_PILOT,
      },
    ],
  };
  return runMatch(options);
}

describe('board telemetry in a simulated match', () => {
  const env = tinyEnvironment();
  const deckA = generateDeck(env, 'board-a').deck as SimDeck;
  const deckB = generateDeck(env, 'board-b').deck as SimDeck;

  it('records a schema-valid board block on every match record', async () => {
    const { record } = await play(env, deckA, deckB, 'board-1');
    expect(() => boardTelemetrySchema.parse(record.board)).not.toThrow();
    expect(record.board.seats.map((seat) => seat.playerId)).toEqual(
      record.seats.map((seat) => seat.playerId),
    );
    expect(record.board.turns).toBe(record.turns);
    expect(record.board.actions).toBe(record.actions);
  });

  it('measures a real board rather than reporting zeroes', async () => {
    const { record } = await play(env, deckA, deckB, 'board-2');
    // The fixture decks are all Units, so a played match must show a board.
    expect(record.board.seats.some((seat) => seat.peakUnits > 0)).toBe(true);
    expect(record.board.rounds).toBeGreaterThan(0);
    expect(record.board.largestBoardAnswer).not.toBeNull();
    for (const seat of record.board.seats) {
      expect(seat.peakUnits).toBeGreaterThanOrEqual(seat.peakNonTokenUnits);
      expect(seat.peakUnits).toBeGreaterThanOrEqual(seat.peakTokens);
      expect(seat.peakTokens).toBeGreaterThanOrEqual(seat.peakTokenStack);
      expect(seat.unitsByRound).toHaveLength(record.board.rounds);
    }
    expect(record.board.attackersByRound).toHaveLength(record.board.rounds);
  });

  /**
   * M04.2 on a real match rather than a hand-written stream.
   *
   * The census is only worth anything if it holds where the engine, not a fixture
   * author, decides who may attack: every attack step a real match took has to be
   * accounted for under exactly one reason, and the per-seat and per-round views
   * of the same steps have to agree.
   */
  it('accounts for every attack step a real match took', async () => {
    const { record } = await play(env, deckA, deckB, 'board-5');
    const opportunity = record.board.attackOpportunity;
    // Aggressive and value pilots on all-Unit decks: this match reaches combat.
    expect(opportunity.steps).toBeGreaterThan(0);
    expect(opportunity.byRound).toHaveLength(record.board.rounds);
    expect(opportunity.steps).toBe(opportunity.able + opportunity.unable);
    expect(opportunity.declined).toBeLessThanOrEqual(opportunity.able);
    expect(opportunity.steps).toBe(
      record.board.seats.reduce((sum, seat) => sum + seat.attackSteps, 0),
    );

    for (const round of opportunity.byRound) {
      expect(round.seatsAsked).toBe(
        round.seatsAble +
          round.seatsWithoutUnits +
          round.seatsAllExhausted +
          round.seatsNewlyDeployed +
          round.seatsWithoutDefender,
      );
      expect(round.attackers).toBe(record.board.attackersByRound[round.round - 1]);
    }

    // The verdict, in a batch record, cut by the rule Q43 chose (M04.3). A real
    // two-seat match of these decks trades attacks, so the honest answer is "no"
    // — and the streak behind it is stored, so that answer is checkable.
    expect(opportunity.classification).toBe('not_stalled');
    expect(opportunity.longestUnanimousDeclinedStreak).toBeLessThan(
      opportunity.stallDefinition.thresholdRounds,
    );
    expect(opportunity.stallDefinition).toEqual(DEFAULT_STALL_DEFINITION);

    // Every round is judged against the seats that were alive for it, and the
    // per-round flag agrees with the streak it was summed into.
    for (const round of opportunity.byRound) {
      expect(round.livingSeats).toBeGreaterThan(0);
      expect(round.seatsAsked).toBeLessThanOrEqual(round.livingSeats);
      if (round.stallEligible) {
        expect(round.attackers).toBe(0);
        expect(round.seatsAsked).toBe(round.livingSeats);
        expect(round.seatsAble).toBe(round.seatsAsked);
      }
    }
  });

  it('agrees exactly with the same collector run over the finished log', async () => {
    const { record, state, events, decisions } = await play(env, deckA, deckB, 'board-3');
    const replayed = collectBoardTelemetry({
      finalState: state,
      events,
      actionTurns: decisions.map((decision) => decision.turn),
      database: env.database,
      config: env.rulesConfig,
      seats: record.seats.map((seat) => ({
        playerId: seat.playerId,
        seatIndex: seat.seatIndex,
        commanderId: seat.commanderId,
      })),
    });
    expect(replayed).toEqual(record.board);
    // And the serialized forms match too, which is the property a record stream
    // needs: key order is part of a byte-identical `matches.jsonl` line.
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(record.board));
  });

  it('is deterministic: the same seed produces the same board telemetry', async () => {
    const first = await play(env, deckA, deckB, 'board-4');
    const second = await play(env, deckA, deckB, 'board-4');
    expect(second.record.board).toEqual(first.record.board);
  });

  /**
   * M04.3 — reconciliation against the spectator path for the same match.
   *
   * The two paths are genuinely different code: the simulator accumulates board
   * telemetry live inside `runMatch` because a batch must not retain every
   * match's log, while `collectTelemetry` — the spectator's entry point — builds
   * it from a finished one and then layers the leaderboard and provenance on top.
   * M04's acceptance criterion is that they cannot disagree, so the check runs the
   * spectator's own function over the simulator's match and reconciles the two
   * board blocks field by field rather than asserting equality and leaving a
   * failure illegible.
   */
  it('reconciles field for field with the spectator path on the same seed', async () => {
    const { record, state, events, decisions } = await play(env, deckA, deckB, 'board-5');

    const spectator = collectTelemetry(
      state,
      events,
      // Padded into the spectator's own decision shape. Only `turn` reaches the
      // collector — "longest turn" is counted in accepted actions — so the pilot
      // scoring fields a watched match would carry are left empty rather than
      // invented from the simulator's differently-shaped trace.
      decisions.map((decision) => ({
        index: decision.index,
        playerId: decision.playerId,
        turn: decision.turn,
        phase: decision.phase,
        sequenceAfter: 0,
        chosenKey: null,
        candidateCount: 0,
        scores: [],
        notes: [],
        usedFallback: decision.usedFallback,
      })),
      env.database,
      env.rulesConfig,
      record.seats.map((seat) => ({
        playerId: seat.playerId,
        name: seat.playerId,
        seatIndex: seat.seatIndex,
        preconId: null,
        commanderId: seat.commanderId,
        cardIds: [],
        pilotId: pilotIdOf(seat.pilotId),
        pilotVersion: seat.pilotVersion,
        pilotSeed: seat.pilotSeed,
      })),
    );

    // `SpectatorTelemetry` extends the shared schema with exactly two things true
    // only of a watched match — the leaderboard and the provenance flag — so
    // those come off and *everything else* has to be identical. That the removal
    // list is this short is itself the M04.1 property being re-checked.
    const { resultsValid: _resultsValid, ...shared } = spectator;
    const reconciliation = reconcileBoardTelemetry(record.board, {
      ...shared,
      seats: spectator.seats.map(({ placement: _placement, ...seat }) => seat),
    });
    expect(reconciliation.differences).toEqual([]);
    expect(reconciliation.agreed).toBe(true);

    // Including the verdict, which is the only derived value either path holds.
    expect(spectator.attackOpportunity.classification).toBe(
      record.board.attackOpportunity.classification,
    );
    expect(spectator.attackOpportunity.stallDefinition).toEqual(
      record.board.attackOpportunity.stallDefinition,
    );
  });
});
