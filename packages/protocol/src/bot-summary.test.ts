import { describe, expect, it } from 'vitest';
import {
  BOT_SUMMARY_SCHEMA_VERSION,
  CURRENT_BOT_CONFIG_VERSIONS,
  DEFAULT_BOT_PACING_BUDGETS,
} from '@tcg/bot-config';
import {
  ALWAYS_TRUE_SUMMARY_LIMITS,
  BOT_SUMMARY_LIMITS,
  CURRENT_VERSIONS,
  EMPTY_BOT_WAIT_STATS,
  botMatchSummarySchema,
  botSummaryClockSchema,
  botSummaryEngineSchema,
  decodeServerMessage,
  encode,
  mergeWaitStats,
  readBotMatchSummary,
  serverMessageSchema,
  unionSpanMs,
  waitStatsOf,
  type BotMatchSummary,
} from './index.js';

/**
 * The pacing summary contract (M09.17).
 *
 * Four claims are checked here, where they belong — in the package that owns the
 * shape — rather than through a server that would also have to play a match to
 * reach them.
 *
 * 1. **The arithmetic is the arithmetic.** Distributions, merges and the union of
 *    overlapping waits are pure functions with exact answers, so they are
 *    asserted against literals rather than against a match.
 * 2. **A union is not a sum.** Two bots waiting at the same instant cost the
 *    table the span they cover between them, which is the number a person felt.
 * 3. **Engine and clock share no key.** The separation the milestone asks for is
 *    a property of the two schemas, not a habit of whoever fills them in.
 * 4. **A round trip is a round trip, and a newer record is refused.** An exported
 *    file outlives the wire that carried it, so the document carries its own
 *    version and `readBotMatchSummary` enforces it.
 */

/* --------------------------------------------------------- the arithmetic */

describe('a distribution over measured waits', () => {
  it('is empty when nothing waited, rather than a row of zeroes', () => {
    expect(waitStatsOf([])).toEqual(EMPTY_BOT_WAIT_STATS);
    expect(waitStatsOf([]).minActualMs).toBeNull();
  });

  it('adds both totals and keeps the spread', () => {
    const stats = waitStatsOf([
      { intendedMs: 1_000, actualMs: 1_004 },
      { intendedMs: 1_000, actualMs: 1_010 },
      { intendedMs: 5_000, actualMs: 5_002 },
    ]);
    expect(stats).toEqual({
      count: 3,
      intendedTotalMs: 7_000,
      actualTotalMs: 7_016,
      minActualMs: 1_004,
      // The lower of the two middle readings on an even count, and the middle
      // one here: always a wait that actually happened, never an average of two
      // that did not.
      medianActualMs: 1_010,
      maxActualMs: 5_002,
    });
  });

  it('takes the lower middle reading on an even count', () => {
    const stats = waitStatsOf([
      { intendedMs: 0, actualMs: 10 },
      { intendedMs: 0, actualMs: 20 },
      { intendedMs: 0, actualMs: 30 },
      { intendedMs: 0, actualMs: 40 },
    ]);
    expect(stats.medianActualMs).toBe(20);
  });
});

describe('merging two distributions', () => {
  it('returns the other one untouched when one is empty', () => {
    const stats = waitStatsOf([{ intendedMs: 100, actualMs: 101 }]);
    expect(mergeWaitStats(EMPTY_BOT_WAIT_STATS, stats)).toEqual(stats);
    expect(mergeWaitStats(stats, EMPTY_BOT_WAIT_STATS)).toEqual(stats);
  });

  it('combines the extremes and refuses to invent a median', () => {
    const left = waitStatsOf([
      { intendedMs: 100, actualMs: 100 },
      { intendedMs: 100, actualMs: 200 },
    ]);
    const right = waitStatsOf([
      { intendedMs: 900, actualMs: 900 },
      { intendedMs: 900, actualMs: 950 },
    ]);
    const merged = mergeWaitStats(left, right);
    expect(merged.count).toBe(4);
    expect(merged.intendedTotalMs).toBe(2_000);
    expect(merged.actualTotalMs).toBe(2_150);
    expect(merged.minActualMs).toBe(100);
    expect(merged.maxActualMs).toBe(950);
    // A median of medians is not a median, and a summary that printed one would
    // be quoting a number nothing measured.
    expect(merged.medianActualMs).toBeNull();
  });
});

describe('the wall-clock time at least one bot was waiting', () => {
  it('is zero when nothing waited', () => {
    expect(unionSpanMs([])).toBe(0);
    // A zero-length span is a seat at 0%, which waited for nothing at all.
    expect(unionSpanMs([{ startMs: 40, endMs: 40 }])).toBe(0);
  });

  it('adds disjoint waits', () => {
    expect(
      unionSpanMs([
        { startMs: 0, endMs: 100 },
        { startMs: 500, endMs: 700 },
      ]),
    ).toBe(300);
  });

  it('counts overlapping waits once, which is what the table actually spent', () => {
    // Three bots offered one Reaction window wait concurrently (M09.12). The
    // window costs the slowest of them, not the sum of all three — and a summary
    // that added them would report a match that spent more time waiting than it
    // lasted.
    expect(
      unionSpanMs([
        { startMs: 0, endMs: 1_000 },
        { startMs: 100, endMs: 900 },
        { startMs: 200, endMs: 1_200 },
      ]),
    ).toBe(1_200);
  });

  it('joins waits that touch without overlapping', () => {
    expect(
      unionSpanMs([
        { startMs: 0, endMs: 500 },
        { startMs: 500, endMs: 800 },
      ]),
    ).toBe(800);
  });

  it('does not depend on the order the waits are given in', () => {
    const spans = [
      { startMs: 900, endMs: 1_000 },
      { startMs: 0, endMs: 400 },
      { startMs: 300, endMs: 950 },
    ];
    expect(unionSpanMs(spans)).toBe(1_000);
    expect(unionSpanMs([...spans].reverse())).toBe(1_000);
  });
});

/* ------------------------------------------------- engine versus wall clock */

describe('engine progress and wall-clock time', () => {
  it('are two objects that share no field name', () => {
    const engine = Object.keys(botSummaryEngineSchema.shape);
    const clock = Object.keys(botSummaryClockSchema.shape);
    expect(engine.filter((key) => clock.includes(key))).toEqual([]);
  });

  it('keep durations out of the engine and counts out of the clock', () => {
    // The separation is only useful if it is legible: every clock member is
    // measured in milliseconds and says so, and no engine member is.
    expect(Object.keys(botSummaryClockSchema.shape).every((key) => /Ms$|Percent$/.test(key))).toBe(
      true,
    );
    expect(Object.keys(botSummaryEngineSchema.shape).some((key) => /Ms$/.test(key))).toBe(false);
  });
});

/* --------------------------------------------------------------- the record */

const SUMMARY: BotMatchSummary = {
  summaryVersion: BOT_SUMMARY_SCHEMA_VERSION,
  versions: {
    protocol: CURRENT_VERSIONS.protocol,
    rules: CURRENT_VERSIONS.rules,
    cardSchema: CURRENT_VERSIONS.cardSchema,
    botConfig: CURRENT_BOT_CONFIG_VERSIONS.botConfig,
    difficultyRegistry: CURRENT_BOT_CONFIG_VERSIONS.difficultyRegistry,
    pacing: CURRENT_BOT_CONFIG_VERSIONS.pacing,
  },
  matchId: 'match_ABC123',
  budgets: DEFAULT_BOT_PACING_BUDGETS,
  engine: { turns: 9, actions: 120, events: 400, sequence: 400, complete: true },
  clock: {
    matchDurationMs: 60_000,
    botPacingMs: 30_000,
    botWaitSumMs: 30_000,
    botPacingPercent: 50,
  },
  seats: [
    {
      seatId: 'seat_2',
      botId: 'bot_1',
      displayName: 'AI 2',
      difficulty: 'normal',
      difficultyBehaviorVersion: '1.0.0',
      styleSetting: 'automatic',
      style: 'value',
      pilotId: 'value',
      pilotVersion: '1.1.0',
      deck: {
        source: { mode: 'exact_precon', preconId: 'precon_containment_control' },
        commanderId: 'prototype_commander_blue',
        deckHash: null,
        generatorVersion: null,
      },
      pacing: { percent: 50, reactionPercent: null },
      decisions: 40,
      decisionsByCategory: { ordinary: 36, pending_choice: 2, reaction: 2 },
      waits: waitStatsOf([{ intendedMs: 15_000, actualMs: 15_000 }]),
      waitsByCategory: {
        ordinary: waitStatsOf([{ intendedMs: 15_000, actualMs: 15_000 }]),
        pending_choice: EMPTY_BOT_WAIT_STATS,
        reaction: EMPTY_BOT_WAIT_STATS,
      },
      waitsCancelled: 1,
      waitsRescheduled: 0,
      pilotFailures: {},
      incidents: {},
      halted: null,
    },
  ],
  totals: {
    bots: 1,
    decisions: 40,
    decisionsByCategory: { ordinary: 36, pending_choice: 2, reaction: 2 },
    waits: waitStatsOf([{ intendedMs: 15_000, actualMs: 15_000 }]),
    pilotFailures: 0,
    incidents: 0,
  },
  stalled: null,
  crashed: null,
  limits: [...ALWAYS_TRUE_SUMMARY_LIMITS],
};

describe('a summary as an exported file', () => {
  it('round-trips through JSON without losing or changing a value', () => {
    const round = readBotMatchSummary(JSON.parse(JSON.stringify(SUMMARY)));
    expect(round.ok).toBe(true);
    if (round.ok) expect(round.value).toEqual(SUMMARY);
  });

  it('refuses a record written by a newer build rather than approximating it', () => {
    const read = readBotMatchSummary({
      ...SUMMARY,
      summaryVersion: BOT_SUMMARY_SCHEMA_VERSION + 1,
      somethingNewer: true,
    });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      // The version check runs before the parse, so the reader is told it is
      // from a newer build rather than handed complaints about a field this
      // build has not learned about yet.
      expect(read.error).toHaveLength(1);
      expect(read.error[0]?.code).toBe('bot_config/unsupported_version');
      expect(read.error[0]?.path).toBe('summaryVersion');
      expect(read.error[0]?.context).toMatchObject({ field: 'matchSummary' });
    }
  });

  it('refuses a record with no readable version at all', () => {
    const read = readBotMatchSummary({ ...SUMMARY, summaryVersion: 'one' });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error[0]?.code).toBe('bot_config/missing_summary_version');
  });

  it('refuses anything that is not an object', () => {
    for (const raw of [null, [], 'summary', 7]) {
      const read = readBotMatchSummary(raw);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error[0]?.code).toBe('bot_config/malformed');
    }
  });

  it('refuses an unknown field, because the record is strict', () => {
    const read = readBotMatchSummary({ ...SUMMARY, playerName: 'Tector' });
    expect(read.ok).toBe(false);
  });

  it('reads a record written by an older build', () => {
    // The point of the constant is to refuse a *newer* record. A two-week-old
    // note is readable by construction, and refusing it would be a version
    // check working against the person it exists for.
    const read = readBotMatchSummary({ ...SUMMARY, summaryVersion: 1 });
    expect(read.ok).toBe(true);
  });
});

describe('the summary on the wire', () => {
  it('decodes as a server message', () => {
    const decoded = decodeServerMessage(
      encode({ type: 'bot_pacing_summary', summary: SUMMARY } as never),
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.type).toBe('bot_pacing_summary');
      if (decoded.value.type === 'bot_pacing_summary') {
        expect(decoded.value.summary).toEqual(SUMMARY);
      }
    }
  });

  it('is a member of the union a client parses on receipt', () => {
    const types = serverMessageSchema.options.map((option) => option.shape.type.value);
    expect(types).toContain('bot_pacing_summary');
  });
});

describe('the recorded limits', () => {
  it('name the four that are always true, and one that is a measurement', () => {
    expect(BOT_SUMMARY_LIMITS).toEqual([
      'match_local',
      'wall_clock_not_engine',
      'measured_not_scheduled',
      'pacing_is_not_a_human_timer',
      'concurrent_waits_overlap',
    ]);
    // The conditional one is deliberately absent from the unconditional list:
    // its presence in a record is evidence that two bots overlapped, and a
    // constant that always included it would say nothing.
    expect(ALWAYS_TRUE_SUMMARY_LIMITS).not.toContain('concurrent_waits_overlap');
  });

  it('are all the schema accepts', () => {
    expect(botMatchSummarySchema.parse({ ...SUMMARY, limits: [] }).limits).toEqual([]);
    expect(() => botMatchSummarySchema.parse({ ...SUMMARY, limits: ['made_up'] })).toThrow();
  });
});
