import { describe, expect, it } from 'vitest';
import { deriveSeedBundle } from './seed.js';
import { generateDeck, toMatchDeck, type SimDeck } from '@tcg/deck-generator';
import { matchRecordSchema, isAbnormal, TERMINATION_KINDS } from './telemetry/schema.js';
import { runMatch, seatToAct, DEFAULT_LIMITS, type RunMatchOptions } from './run-match.js';
import type { MatchState } from '@tcg/rules-engine';
import type { Environment } from './environment.js';
import {
  AGGRESSIVE_PILOT,
  FAST_LIMITS,
  RANDOM_PILOT,
  VALUE_PILOT,
  tinyEnvironment,
} from './test-fixtures.js';

/**
 * CLAUDE.md §13.5 (single-match runner) and §13.15 items 4, 7 and 8:
 * reproducibility, safeguard classification, and isolated pilot failure.
 */

const env = tinyEnvironment();
const deckA = generateDeck(env, 'run-match-a').deck as SimDeck;
const deckB = generateDeck(env, 'run-match-b').deck as SimDeck;

function options(overrides: Partial<RunMatchOptions> = {}): RunMatchOptions {
  const seeds = overrides.seeds ?? deriveSeedBundle('test|game:000000', 2);
  return {
    experimentId: 'test',
    experimentKind: 'batch',
    configHash: 'run-match-test',
    arm: null,
    environment: env as Environment,
    matchId: 'm_test',
    orderKey: 'test 000',
    deckPairId: 'pair',
    variantKey: 'variant',
    gameIndex: 0,
    orientation: 0,
    limits: FAST_LIMITS,
    seats: [
      {
        playerId: 'player_1',
        deckId: deckA.id,
        deckHash: deckA.hash,
        deck: toMatchDeck(deckA),
        pilot: VALUE_PILOT,
      },
      {
        playerId: 'player_2',
        deckId: deckB.id,
        deckHash: deckB.hash,
        deck: toMatchDeck(deckB),
        pilot: AGGRESSIVE_PILOT,
      },
    ],
    ...overrides,
    seeds,
  };
}

describe('runMatch', () => {
  it('plays a complete match and produces a schema-valid record', async () => {
    const { record } = await runMatch(options());
    expect(() => matchRecordSchema.parse(record)).not.toThrow();
    expect(record.termination).toBe('victory');
    expect(record.outcome).toBe('win');
    expect(record.winnerId).not.toBeNull();
    expect(record.turns).toBeGreaterThan(0);
    expect(record.actions).toBeGreaterThan(0);
    expect(record.botFailures).toEqual([]);
  });

  it('carries the full provenance a result needs to be reproduced', async () => {
    const { record } = await runMatch(options());
    expect(record.seeds.matchSeed).toBe(options().seeds.matchSeed);
    expect(record.environmentHash).toBe(env.hash);
    expect(record.cardPoolHash).toBe(env.cardPoolHash);
    expect(record.rulesVersion).toBe(env.rulesConfig.version);
    expect(record.seats.map((seat) => seat.deckHash)).toEqual([deckA.hash, deckB.hash]);
    expect(record.seats.map((seat) => seat.pilotId)).toEqual(['value', 'aggressive']);
    expect(record.seats.every((seat) => seat.pilotConfigHash.length > 0)).toBe(true);
  });

  it('reproduces byte-identical records for identical inputs', async () => {
    // CLAUDE.md §13.15 item 4. Records carry no wall-clock field, so equality is
    // exact rather than "equal apart from timing".
    const first = await runMatch(options());
    const second = await runMatch(options());
    expect(JSON.stringify(second.record)).toBe(JSON.stringify(first.record));
  });

  it('reproduces byte-identical action and event logs', async () => {
    const first = await runMatch(options());
    const second = await runMatch(options());
    expect(JSON.stringify(second.actions)).toBe(JSON.stringify(first.actions));
    expect(JSON.stringify(second.events)).toBe(JSON.stringify(first.events));
    expect(first.actions.length).toBeGreaterThan(0);
  });

  it('produces different matches for different seeds', async () => {
    const first = await runMatch(options({ seeds: deriveSeedBundle('a', 2) }));
    const second = await runMatch(options({ seeds: deriveSeedBundle('b', 2) }));
    expect(
      second.record.turns === first.record.turns && second.record.actions === first.record.actions,
    ).toBe(false);
  });

  it('honours the schedule’s seat order rather than re-rolling it', async () => {
    const { record } = await runMatch(options());
    expect(record.seats.map((seat) => seat.playerId)).toEqual(['player_1', 'player_2']);
    expect(record.seats.map((seat) => seat.deckId)).toEqual([deckA.id, deckB.id]);
    expect(record.orientation).toBe(0);
  });

  it('always returns the logs, because abnormality is only known at the end', async () => {
    // Gating collection on a flag decided up front would produce empty replays
    // for exactly the matches that need one. Retention is the caller's decision.
    const { actions, events, decisions, record } = await runMatch(options());
    expect(actions.length).toBe(record.actions);
    expect(events.length).toBeGreaterThan(0);
    expect(decisions).toHaveLength(record.decisions);
    expect(decisions[0]).toMatchObject({ index: 0, playerId: expect.any(String) });
  });

  it('runs every pilot pairing to a clean finish across many seeds', async () => {
    const pilots = [VALUE_PILOT, AGGRESSIVE_PILOT, RANDOM_PILOT];
    for (let index = 0; index < 6; index += 1) {
      const left = pilots[index % pilots.length]!;
      const right = pilots[(index + 1) % pilots.length]!;
      const { record } = await runMatch(
        options({
          seeds: deriveSeedBundle(`pairing-${index}`, 2),
          seats: options().seats.map((seat, seatIndex) => ({
            ...seat,
            pilot: seatIndex === 0 ? left : right,
          })),
        }),
      );
      expect(record.botFailures).toEqual([]);
      expect(isAbnormal(record.termination)).toBe(false);
    }
  });

  it('seats a four-player table', async () => {
    const decks = [deckA, deckB, generateDeck(env, 'c').deck!, generateDeck(env, 'd').deck!];
    const { record } = await runMatch(
      options({
        seeds: deriveSeedBundle('ffa', 4),
        seats: decks.map((deck, index) => ({
          playerId: `player_${index + 1}`,
          deckId: deck.id,
          deckHash: deck.hash,
          deck: toMatchDeck(deck),
          pilot: VALUE_PILOT,
        })),
      }),
    );
    expect(record.playerCount).toBe(4);
    expect(record.seats).toHaveLength(4);
    expect(matchRecordSchema.parse(record).seats).toHaveLength(4);
  });
});

describe('safeguards', () => {
  it('classifies a turn-limit stop and keeps it out of ordinary results', async () => {
    const { record, abnormal } = await runMatch(
      options({ limits: { ...FAST_LIMITS, maxTurns: 3 } }),
    );
    expect(record.termination).toBe('turn_limit');
    expect(abnormal).toBe(true);
    expect(record.diagnostics.join(' ')).toMatch(/turn limit 3/);
    expect(record.winnerId).toBeNull();
  });

  it('classifies an action-limit stop', async () => {
    const { record, abnormal } = await runMatch(
      options({ limits: { ...FAST_LIMITS, maxActions: 5 } }),
    );
    expect(record.termination).toBe('action_limit');
    expect(abnormal).toBe(true);
    expect(record.actions).toBe(5);
  });

  it('records a pilot decision budget breach as a pilot error, not a normal loss', async () => {
    // The budget is per seat; two decisions is not enough to finish a match, so
    // the fallback pilot takes over and the match is marked defective.
    const { record } = await runMatch(
      options({ limits: { ...FAST_LIMITS, maxDecisionsPerSeat: 2 } }),
    );
    expect(record.botFailures.length).toBeGreaterThan(0);
    expect(record.botFailures[0]?.kind).toBe('budget_exceeded');
    expect(['pilot_error', 'turn_limit', 'action_limit', 'no_progress']).toContain(
      record.termination,
    );
    expect(isAbnormal(record.termination)).toBe(true);
  });

  it('never reports a bare victory when a pilot failed on the way there', async () => {
    const { record } = await runMatch(
      options({ limits: { ...FAST_LIMITS, maxDecisionsPerSeat: 4 } }),
    );
    if (record.botFailures.length > 0) expect(record.termination).not.toBe('victory');
  });

  it('exposes every termination kind through the schema', () => {
    expect(TERMINATION_KINDS.filter(isAbnormal)).toEqual([
      'engine_error',
      'pilot_error',
      'illegal_bot_action',
      'turn_limit',
      'action_limit',
      'no_progress',
    ]);
    expect(TERMINATION_KINDS.filter((kind) => !isAbnormal(kind))).toEqual(['victory', 'draw']);
  });

  it('ships defaults generous enough that a normal match never trips them', async () => {
    const { record } = await runMatch(options({ limits: DEFAULT_LIMITS }));
    expect(record.termination).toBe('victory');
    expect(record.turns).toBeLessThan(DEFAULT_LIMITS.maxTurns);
    expect(record.actions).toBeLessThan(DEFAULT_LIMITS.maxActions);
  });
});

describe('seatToAct', () => {
  it('returns null once the match is complete', async () => {
    const { state } = await runMatch(options());
    expect(state.status).toBe('complete');
    expect(seatToAct(state)).toBeNull();
  });

  /**
   * An open Reaction window holds priority itself, and `legalActions` offers its
   * moves to the priority holder alone. Asking the active player instead handed
   * a seat with nothing legal to the pilots, and the random-legal fallback threw
   * rather than returning an action — killing the whole match. Found by M03.3's
   * precon smoke run; the fixture decks these tests use carry no Reactions, so
   * nothing here had ever opened a window with a non-active priority holder.
   */
  it('asks the seat holding priority in an open Reaction window', async () => {
    const { state } = await runMatch(options());
    const [first, second] = state.seatOrder;
    if (!first || !second) throw new Error('The fixture match needs two seats.');

    const open: MatchState = {
      ...state,
      status: 'playing',
      phase: 'reaction_window',
      activePlayerId: first,
      pendingChoice: null,
      reactionWindow: {
        id: 'rw_0001',
        windows: ['after_blockers_declared'],
        triggerSequence: 1,
        priorityOrder: [first, second],
        priorityIndex: 1,
        playsByPlayer: {},
        passedPlayerIds: [],
        pending: [],
        closed: false,
        resumePhase: 'resolve_combat',
      },
    };
    expect(seatToAct(open)).toBe(second);

    // A closed window is drained by the engine's own resolution queue without
    // anybody being asked, so it must not divert the seat that is to act.
    const closed: MatchState = {
      ...open,
      reactionWindow: { ...open.reactionWindow!, closed: true },
    };
    expect(seatToAct(closed)).toBe(first);
  });
});
