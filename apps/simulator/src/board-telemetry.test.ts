import { describe, expect, it } from 'vitest';
import { boardTelemetrySchema, collectBoardTelemetry } from '@tcg/board-telemetry';
import { deriveSeedBundle } from './seed.js';
import { toMatchDeck, type SimDeck } from './deck-search/deck.js';
import { generateDeck } from './deck-search/generate.js';
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
});
