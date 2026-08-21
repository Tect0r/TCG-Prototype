import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOT_CONFIG_SCHEMA_VERSION,
  BOT_SUMMARY_SCHEMA_VERSION,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_BOT_PACING_BUDGETS,
  DIFFICULTY_REGISTRY_VERSION,
  IMMEDIATE_BOT_PACING,
  type BotPacing,
  type BotSeatConfig,
} from '@tcg/bot-config';
import {
  BOT_FAILURE_KINDS,
  createPilot,
  type BotObservation,
  type BotPolicy,
} from '@tcg/bot-interface';
import { loadFormatCardData, resolveFormatId } from '@tcg/card-data';
import { deckFormatOf } from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  encode,
  readBotMatchSummary,
  type BotMatchSummary,
  type ClientMessageInput,
  type SeatId,
  type ServerMessage,
} from '@tcg/protocol';
import {
  DEFAULT_RULES_CONFIG,
  createRngState,
  legalActions,
  playerView,
  type MatchState,
  type PlayerId,
  type RngState,
} from '@tcg/rules-engine';
import {
  buildBotMatchSummary,
  NO_DURABLE_SUMMARY_STORE,
  type BotSummarySink,
} from './bot-match-summary.js';
import {
  BOT_RUN_INCIDENTS,
  hasBotDecision,
  type BotDelayRecord,
  type BotRunIncident,
  type BotRunReport,
  type BotSeatActivity,
} from './bot-runner.js';
import { MatchServer, type ServerConnection } from './match-server.js';
import type { ScheduleTimer } from './scheduling.js';

/**
 * The pacing and bot-provenance summary, end to end (M09.17).
 *
 * Eight claims, and every duration in them is asserted to the millisecond
 * against an injected clock rather than to a tolerance against a real one —
 * which is the same discipline M09.12 established, for the same reason: a
 * summary nobody can assert exactly is a summary nobody can trust.
 *
 * 1. **The aggregate is the waits.** Totals, distributions and the wall-clock
 *    share are the arithmetic over exactly the waits the runner recorded.
 * 2. **Every bot is attributed separately**, and a table whose bots waited at the
 *    same instant reports the union it actually spent, the per-seat sum beside
 *    it, and the limit that says which is which.
 * 3. **An instant bot records no waits at all**, and still records its decisions.
 * 4. **A cancelled wait costs nothing.** It is counted as cancelled and
 *    contributes no millisecond to any total.
 * 5. **A pilot failure is in the record**, by kind, rather than disguised as an
 *    intentional play.
 * 6. **Engine metrics do not move when pacing does.** One seed at two
 *    percentages produces the same turns, actions and events and different
 *    seconds.
 * 7. **Nothing private crosses.** No seed, no saved-deck name, no saved-deck ID
 *    and no private fingerprint appears in a broadcast summary, in any mode.
 * 8. **It round-trips, and it goes to the seam.** The broadcast record reads back
 *    through `readBotMatchSummary` unchanged, and a sink receives it once.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);
const config = DEFAULT_RULES_CONFIG;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const BOT_PRECON_ID = 'precon_containment_control';
const HUMAN_PRECON_ID = 'precon_bastion_guardians';
/** The seed M09.4 named: it puts a real Reaction window and a real choice in the game. */
const BOT_FIRST_SEED = 's1';

function pacing(percent: number, reactionPercent: number | null = null): BotPacing {
  return { percent, reactionPercent };
}

function botSetup(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style: 'value' as const,
    deck: { mode: 'exact_precon' as const, preconId: BOT_PRECON_ID },
    pacing: IMMEDIATE_BOT_PACING,
    displayName: null,
    ...overrides,
  };
}

class FakeConnection implements ServerConnection {
  readonly sent: ServerMessage[] = [];
  closed = false;

  constructor(readonly id: string) {}

  send(message: ServerMessage): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
  }

  all<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((message) => message.type === type) as Extract<
      ServerMessage,
      { type: T }
    >[];
  }

  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return this.all(type).at(-1);
  }
}

/* ------------------------------------------------------------- fake time */

interface FakeTimer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
  cancelled: boolean;
  fired: boolean;
}

/** The M09.12 clock, unchanged: a timer wheel and a reading a test drives by hand. */
class FakeClock {
  #now = 0;
  #nextId = 0;
  readonly timers: FakeTimer[] = [];

  constructor(private readonly lateBy = 0) {}

  get now(): number {
    return this.#now;
  }

  readonly schedule: ScheduleTimer = (delayMs, callback) => {
    this.#nextId += 1;
    const timer: FakeTimer = {
      id: this.#nextId,
      at: this.#now + delayMs,
      callback,
      cancelled: false,
      fired: false,
    };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  readonly monotonicNow = (): number => this.#now;

  pending(): FakeTimer[] {
    return this.timers.filter((timer) => !timer.cancelled && !timer.fired);
  }

  next(): FakeTimer | null {
    const [soonest] = this.pending().sort((a, b) => a.at - b.at || a.id - b.id);
    return soonest ?? null;
  }

  fireNext(): FakeTimer | null {
    const soonest = this.next();
    if (!soonest) return null;
    this.#now = soonest.at + this.lateBy;
    soonest.fired = true;
    soonest.callback();
    return soonest;
  }

  /** Moves the clock without firing anything, for the gaps between waits. */
  idle(ms: number): void {
    this.#now += ms;
  }
}

/* --------------------------------------------------------------- harness */

interface Harness {
  readonly server: MatchServer;
  readonly host: FakeConnection;
  readonly inviteCode: string;
  readonly clock: FakeClock;
  send(connection: FakeConnection, message: ClientMessageInput): void;
  state(): MatchState | null;
  summary(): BotMatchSummary | undefined;
}

interface HarnessOptions {
  readonly seed?: string;
  readonly maxSeats?: number;
  readonly lateBy?: number;
  readonly sink?: BotSummarySink;
  readonly pilotFor?: () => BotPolicy;
}

function createHarness(options: HarnessOptions = {}): Harness {
  let counter = 0;
  const clock = new FakeClock(options.lateBy ?? 0);
  const server = new MatchServer({
    database,
    deckFormat,
    random: () => {
      counter += 1;
      return ((counter * 2654435761) % 4294967296) / 4294967296;
    },
    schedule: clock.schedule,
    monotonicNow: clock.monotonicNow,
    seedFor: () => options.seed ?? BOT_FIRST_SEED,
    now: () => 1_000_000,
    ...(options.sink ? { summarySink: options.sink } : {}),
    ...(options.pilotFor ? { botPilotFor: options.pilotFor } : {}),
  });

  const send = (connection: FakeConnection, message: ClientMessageInput): void => {
    server.receive(connection, encode(message as never));
  };

  const host = new FakeConnection('conn_host');
  server.connect(host);
  send(host, {
    type: 'create_lobby',
    versions: CURRENT_VERSIONS,
    displayName: 'Host',
    maxSeats: options.maxSeats ?? 2,
  });
  const joined = host.last('lobby_joined');
  if (!joined) throw new Error('The host did not create a lobby.');

  return {
    server,
    host,
    clock,
    inviteCode: joined.lobby.inviteCode,
    send,
    state: () => server.lobbyByCode(joined.lobby.inviteCode)?.state ?? null,
    summary: () => host.last('bot_pacing_summary')?.summary,
  };
}

function startPacedMatch(harness: Harness, seatPacing: BotPacing, bots = 1): void {
  for (let index = 0; index < bots; index += 1) {
    harness.send(harness.host, { type: 'add_bot', setup: botSetup({ pacing: seatPacing }) });
  }
  harness.send(harness.host, { type: 'submit_precon', preconId: HUMAN_PRECON_ID });
  harness.send(harness.host, { type: 'set_ready', ready: true });
  if (harness.state() === null) harness.send(harness.host, { type: 'start_match' });
  if (harness.state() === null) throw new Error('The paced match did not start.');
}

/** The scripted opponent M09.4 established, acting through `submit_action`. */
class ScriptedHuman {
  readonly #pilot = createPilot({ id: 'aggressive' });
  #rng: RngState;
  #decisions = 0;

  constructor(
    private readonly harness: Harness,
    private readonly playerId: PlayerId = 'player_1',
    seed = 'scripted-human',
    /** The seat's own connection: an action arrives from the seat that owns it. */
    private readonly connection: FakeConnection = harness.host,
  ) {
    this.#rng = createRngState(seed);
  }

  act(state: MatchState): boolean {
    const legal = legalActions(state, this.playerId, { database, config });
    if (!hasBotDecision(legal)) return false;

    const view = playerView(state, this.playerId, database, config);
    const decision = this.#pilot.decide(
      {
        view,
        legal,
        history: view.log,
        database,
        rulesConfig: config,
        decisionIndex: this.#decisions,
      },
      this.#rng,
    );
    if (decision instanceof Promise) throw new Error('The scripted human must be synchronous.');
    this.#rng = decision.rng;
    this.#decisions += 1;

    this.harness.send(this.connection, {
      type: 'submit_action',
      actionId: `human_${this.#decisions}`,
      lastSequence: state.sequence,
      action: decision.action,
    });
    return true;
  }
}

/**
 * Plays a paced match out.
 *
 * `idle` between the human's moves is what makes the wall-clock duration bigger
 * than the waits: without it every human action would be instantaneous and a
 * "40% of the match was waiting" assertion would be measuring only the bots.
 */
async function playPaced(harness: Harness, humanThinkMs = 0) {
  const human = new ScriptedHuman(harness);
  for (let step = 0; step < 20_000; step += 1) {
    await harness.server.whenBotsIdle();
    const state = harness.state();
    if (!state || state.status === 'complete') return { state, blocked: false };
    if (harness.clock.next() !== null) {
      harness.clock.fireNext();
      continue;
    }
    if (humanThinkMs > 0) harness.clock.idle(humanThinkMs);
    if (!human.act(state)) return { state, blocked: true };
  }
  throw new Error('The paced match did not finish inside 20 000 steps.');
}

/* ------------------------------------------------- fixtures for the builder */

function seatConfig(overrides: Partial<BotSeatConfig> = {}): BotSeatConfig {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    controller: { botId: 'bot_1', displayName: 'Bot 2' },
    difficulty: DEFAULT_BOT_DIFFICULTY,
    styleSetting: 'value',
    style: 'value',
    deck: { mode: 'exact_precon', preconId: BOT_PRECON_ID },
    pacing: IMMEDIATE_BOT_PACING,
    ...overrides,
  };
}

function delay(overrides: Partial<BotDelayRecord> = {}): BotDelayRecord {
  return {
    decisionIndex: 0,
    category: 'ordinary',
    intendedMs: 1_000,
    actualMs: 1_000,
    startedAtMs: 0,
    ...overrides,
  };
}

function activity(overrides: Partial<BotSeatActivity> = {}): BotSeatActivity {
  return {
    seatId: 'seat_2',
    botId: 'bot_1',
    playerId: 'player_2',
    pilotId: 'value',
    pilotVersion: '1.1.0',
    difficulty: 'normal',
    difficultyBehaviorVersion: '1.0.0',
    styleSetting: 'value',
    style: 'value',
    seed: 'seed:bot:seat_2',
    decisions: 0,
    actions: {},
    decisionsByCategory: { ordinary: 0, pending_choice: 0, reaction: 0 },
    delays: [],
    delaysCancelled: 0,
    delaysRescheduled: 0,
    lastDelayCancellation: null,
    halted: null,
    ...overrides,
  };
}

function report(overrides: Partial<BotRunReport> = {}): BotRunReport {
  return { seats: [], incidents: [], stalled: null, waiting: [], crashed: null, ...overrides };
}

function build(input: {
  seats: readonly { seatId: SeatId; config: BotSeatConfig; commanderId: string | null }[];
  report: BotRunReport;
  startedAtMs?: number;
  endedAtMs?: number;
}): BotMatchSummary {
  return buildBotMatchSummary({
    matchId: 'match_TEST01',
    budgets: DEFAULT_BOT_PACING_BUDGETS,
    seats: input.seats,
    report: input.report,
    state: null,
    startedAtMs: input.startedAtMs ?? 0,
    endedAtMs: input.endedAtMs ?? 10_000,
  });
}

/* ------------------------------------------------------------ aggregation */

describe('the summary aggregates exactly the waits that happened', () => {
  it('reports totals, distribution and share off one seat’s recorded waits', () => {
    const summary = build({
      seats: [{ seatId: 'seat_2', config: seatConfig(), commanderId: 'prototype_commander_blue' }],
      report: report({
        seats: [
          activity({
            decisions: 3,
            decisionsByCategory: { ordinary: 2, pending_choice: 0, reaction: 1 },
            delays: [
              delay({ startedAtMs: 0, intendedMs: 1_000, actualMs: 1_004 }),
              delay({ startedAtMs: 3_000, intendedMs: 1_000, actualMs: 1_010 }),
              delay({ startedAtMs: 6_000, category: 'reaction', intendedMs: 500, actualMs: 502 }),
            ],
          }),
        ],
      }),
      endedAtMs: 10_000,
    });

    expect(summary.clock.matchDurationMs).toBe(10_000);
    // 1004 + 1010 + 502, none of them overlapping, so the union and the sum
    // agree and the record does not claim an overlap.
    expect(summary.clock.botWaitSumMs).toBe(2_516);
    expect(summary.clock.botPacingMs).toBe(2_516);
    expect(summary.clock.botPacingPercent).toBe(25);
    expect(summary.limits).not.toContain('concurrent_waits_overlap');

    const [seat] = summary.seats;
    expect(seat?.waits).toEqual({
      count: 3,
      intendedTotalMs: 2_500,
      actualTotalMs: 2_516,
      minActualMs: 502,
      medianActualMs: 1_004,
      maxActualMs: 1_010,
    });
    expect(seat?.waitsByCategory.reaction.count).toBe(1);
    expect(seat?.waitsByCategory.ordinary.count).toBe(2);
    // Total over the three categories, so a category that never came up is a
    // recorded zero rather than a missing key.
    expect(seat?.waitsByCategory.pending_choice.count).toBe(0);
    expect(seat?.decisionsByCategory).toEqual({ ordinary: 2, pending_choice: 0, reaction: 1 });
    expect(summary.totals.decisions).toBe(3);
    expect(summary.totals.waits.count).toBe(3);
  });

  it('never reports a share above 100%, even if a wait outlasts the match', () => {
    // Defensive rather than reachable: a wait cannot outlive the match that
    // cancels it. The clamp is here so that a future scheduling change reports
    // an odd number rather than an impossible one.
    const summary = build({
      seats: [{ seatId: 'seat_2', config: seatConfig(), commanderId: null }],
      report: report({
        seats: [activity({ delays: [delay({ startedAtMs: 0, actualMs: 9_000 })] })],
      }),
      endedAtMs: 1_000,
    });
    expect(summary.clock.botPacingPercent).toBe(100);
  });

  it('reports no share at all for a zero-length match', () => {
    const summary = build({
      seats: [{ seatId: 'seat_2', config: seatConfig(), commanderId: null }],
      report: report({ seats: [activity()] }),
      startedAtMs: 5_000,
      endedAtMs: 5_000,
    });
    // A percentage of nothing is not zero, it is undefined, and saying "0%"
    // would be a claim the measurement cannot support.
    expect(summary.clock.botPacingPercent).toBeNull();
  });
});

describe('a table whose bots wait at the same time', () => {
  it('reports the union it spent, the per-seat sum, and which is which', () => {
    const summary = build({
      seats: [
        { seatId: 'seat_2', config: seatConfig(), commanderId: null },
        {
          seatId: 'seat_3',
          config: seatConfig({ controller: { botId: 'bot_2', displayName: 'Bot 3' } }),
          commanderId: null,
        },
      ],
      report: report({
        seats: [
          activity({ delays: [delay({ startedAtMs: 0, actualMs: 1_000 })] }),
          activity({
            seatId: 'seat_3',
            botId: 'bot_2',
            playerId: 'player_3',
            delays: [delay({ startedAtMs: 500, actualMs: 1_000 })],
          }),
        ],
      }),
    });

    // Two one-second waits, half a second apart: the table spent 1.5 s waiting
    // and the bots spent 2 s between them. Both are true and they are different
    // questions, which is exactly why the record carries both.
    expect(summary.clock.botPacingMs).toBe(1_500);
    expect(summary.clock.botWaitSumMs).toBe(2_000);
    expect(summary.limits).toContain('concurrent_waits_overlap');
    expect(summary.totals.bots).toBe(2);
    expect(summary.seats.map((seat) => seat.seatId)).toEqual(['seat_2', 'seat_3']);
    // Attribution is per seat rather than pooled: each carries its own wait.
    expect(summary.seats.map((seat) => seat.waits.actualTotalMs)).toEqual([1_000, 1_000]);
  });
});

describe('an instant bot', () => {
  it('records no waits at all, and still records what it decided', () => {
    const summary = build({
      seats: [{ seatId: 'seat_2', config: seatConfig(), commanderId: null }],
      report: report({
        seats: [
          activity({
            decisions: 12,
            decisionsByCategory: { ordinary: 10, pending_choice: 1, reaction: 1 },
          }),
        ],
      }),
    });
    expect(summary.seats[0]?.waits.count).toBe(0);
    // Null rather than zero: an instant bot did not wait for zero milliseconds
    // twelve times, it did not wait.
    expect(summary.seats[0]?.waits.minActualMs).toBeNull();
    expect(summary.clock.botPacingMs).toBe(0);
    expect(summary.clock.botPacingPercent).toBe(0);
    expect(summary.totals.decisions).toBe(12);
    expect(summary.limits).not.toContain('concurrent_waits_overlap');
  });
});

describe('a cancelled wait', () => {
  it('is counted as cancelled and costs the summary no time', () => {
    const summary = build({
      seats: [{ seatId: 'seat_2', config: seatConfig(), commanderId: null }],
      report: report({
        seats: [
          activity({
            // The runner never pushes an abandoned wait into `delays` — it was
            // never served — so the exclusion is structural. What is recorded is
            // that it happened.
            delays: [delay({ startedAtMs: 0, actualMs: 1_000 })],
            delaysCancelled: 3,
            delaysRescheduled: 1,
            lastDelayCancellation: '15000 ms of ordinary pacing: the seat is out of the match',
          }),
        ],
      }),
    });
    expect(summary.seats[0]?.waitsCancelled).toBe(3);
    expect(summary.seats[0]?.waitsRescheduled).toBe(1);
    expect(summary.seats[0]?.waits.count).toBe(1);
    expect(summary.clock.botWaitSumMs).toBe(1_000);
  });
});

describe('a pilot failure', () => {
  it('is in the record by kind, rather than disguised as an intentional play', () => {
    const incidents: BotRunIncident[] = [
      {
        kind: 'pilot_fallback',
        seatId: 'seat_2',
        botId: 'bot_1',
        playerId: 'player_2',
        decisionIndex: 4,
        message: 'threw: the pilot exploded',
        pilotFailure: 'threw',
      },
      {
        kind: 'stale_decision',
        seatId: 'seat_2',
        botId: 'bot_1',
        playerId: 'player_2',
        decisionIndex: 5,
        message: 'the board moved',
        pilotFailure: null,
      },
    ];
    const summary = build({
      seats: [{ seatId: 'seat_2', config: seatConfig(), commanderId: null }],
      report: report({ seats: [activity({ decisions: 6 })], incidents }),
    });

    expect(summary.seats[0]?.pilotFailures).toEqual({ threw: 1 });
    expect(summary.seats[0]?.incidents).toEqual({ pilot_fallback: 1, stale_decision: 1 });
    expect(summary.totals.pilotFailures).toBe(1);
    expect(summary.totals.incidents).toBe(2);
  });

  it('carries every kind the runner and the pilot interface can produce', () => {
    // The record's `pilotFailures` and `incidents` are open string records,
    // because `@tcg/protocol` cannot import the two packages that own those
    // vocabularies without inverting the dependency direction. This is the check
    // that keeps the openness honest: every member of both closed sets survives
    // a round trip through the schema.
    const summary = build({
      seats: [{ seatId: 'seat_2', config: seatConfig(), commanderId: null }],
      report: report({
        seats: [activity()],
        incidents: [
          ...BOT_RUN_INCIDENTS.map((kind) => ({
            kind,
            seatId: 'seat_2' as const,
            botId: 'bot_1',
            playerId: 'player_2' as const,
            decisionIndex: 0,
            message: kind,
            pilotFailure: null,
          })),
          ...BOT_FAILURE_KINDS.map((failure) => ({
            kind: 'pilot_fallback' as const,
            seatId: 'seat_2' as const,
            botId: 'bot_1',
            playerId: 'player_2' as const,
            decisionIndex: 0,
            message: failure,
            pilotFailure: failure,
          })),
        ],
      }),
    });

    const round = readBotMatchSummary(JSON.parse(JSON.stringify(summary)));
    expect(round.ok).toBe(true);
    expect(Object.keys(summary.seats[0]?.pilotFailures ?? {}).sort()).toEqual(
      [...BOT_FAILURE_KINDS].sort(),
    );
    for (const kind of BOT_RUN_INCIDENTS) {
      expect(summary.seats[0]?.incidents[kind]).toBeGreaterThan(0);
    }
  });
});

/* ---------------------------------------------------------------- privacy */

describe('what a broadcast summary may say about a deck', () => {
  it('carries the Commander and never the private half of a saved deck', () => {
    const summary = build({
      seats: [
        {
          seatId: 'seat_2',
          config: seatConfig({
            deck: {
              mode: 'exact_saved_deck',
              deck: {
                sourceDeckId: 'deck_secret_id',
                name: 'My Secret Brew',
                commanderId: 'prototype_commander_blue',
                cardIds: ['goblin_scout'],
                deckHash: 'fingerprintvalue',
              },
            },
          }),
          commanderId: 'prototype_commander_blue',
        },
      ],
      report: report({ seats: [activity()] }),
    });

    const serialized = JSON.stringify(summary);
    // The three handles onto a list nobody else may see (M09.6): the name, the
    // ID it was frozen from, and the fingerprint of its contents.
    expect(serialized).not.toContain('My Secret Brew');
    expect(serialized).not.toContain('deck_secret_id');
    expect(serialized).not.toContain('fingerprintvalue');
    expect(serialized).not.toContain('goblin_scout');
    // What every seat already knew all match: the mode, and the Commander.
    expect(summary.seats[0]?.deck.source).toEqual({
      mode: 'exact_saved_deck',
      commanderId: 'prototype_commander_blue',
    });
    expect(summary.seats[0]?.deck.commanderId).toBe('prototype_commander_blue');
    expect(summary.seats[0]?.deck.deckHash).toBeNull();
  });

  it('never carries a generator seed, and does carry the content address', () => {
    const summary = build({
      seats: [
        {
          seatId: 'seat_2',
          config: seatConfig({
            deck: {
              mode: 'commander_generated',
              commanderId: 'prototype_commander_blue',
              seed: 'secret-generator-seed',
              generated: {
                generatorVersion: '1',
                mode: 'commander_generated',
                formatId: format.formatId,
                seed: 'secret-generator-seed',
                rerollCount: 2,
                commanderId: 'prototype_commander_blue',
                deckHash: 'contentaddress01',
                legalPoolSize: 41,
                forcedInclusionFloor: 39,
              },
            },
          }),
          commanderId: 'prototype_commander_blue',
        },
      ],
      report: report({ seats: [activity()] }),
    });

    // The seed is the one value that turns "the Commander is public" back into
    // "the list is public" (ADR 0024 §3), and it is absent by shape.
    expect(JSON.stringify(summary)).not.toContain('secret-generator-seed');
    expect(summary.seats[0]?.deck.deckHash).toBe('contentaddress01');
    expect(summary.seats[0]?.deck.generatorVersion).toBe('1');
  });

  it('resolves a precon bot’s Commander, which the configuration cannot name', () => {
    const summary = build({
      seats: [{ seatId: 'seat_2', config: seatConfig(), commanderId: 'prototype_commander_blue' }],
      report: report({ seats: [activity()] }),
    });
    expect(summary.seats[0]?.deck.source).toEqual({
      mode: 'exact_precon',
      preconId: BOT_PRECON_ID,
    });
    expect(summary.seats[0]?.deck.commanderId).toBe('prototype_commander_blue');
  });
});

/* --------------------------------------------------- a real, paced match */

describe('a real match, on an injected clock', () => {
  it('broadcasts one summary to every seat when the match completes', async () => {
    const harness = createHarness();
    startPacedMatch(harness, pacing(50));
    const { state } = await playPaced(harness, 250);
    expect(state?.status).toBe('complete');

    const summaries = harness.host.all('bot_pacing_summary');
    expect(summaries).toHaveLength(1);
    const summary = summaries[0]?.summary;
    if (!summary) throw new Error('The match published no pacing summary.');

    expect(summary.summaryVersion).toBe(BOT_SUMMARY_SCHEMA_VERSION);
    expect(summary.versions.protocol).toBe(CURRENT_VERSIONS.protocol);
    expect(summary.budgets).toEqual(DEFAULT_BOT_PACING_BUDGETS);
    expect(summary.engine.complete).toBe(true);
    expect(summary.seats).toHaveLength(1);
    expect(summary.seats[0]?.waits.count).toBeGreaterThan(0);
    expect(summary.clock.matchDurationMs).toBeGreaterThan(0);
    expect(summary.clock.botPacingMs).toBeGreaterThan(0);
    // Every wait the runner served is in the total, and the whole thing fits
    // inside the match it happened in.
    expect(summary.clock.botPacingMs).toBeLessThanOrEqual(summary.clock.matchDurationMs);
    expect(summary.totals.decisions).toBe(summary.seats[0]?.decisions);
  });

  it('publishes nothing for a table that held no bot', async () => {
    const harness = createHarness();
    const guest = new FakeConnection('conn_guest');
    harness.server.connect(guest);
    harness.send(guest, {
      type: 'join_lobby',
      versions: CURRENT_VERSIONS,
      inviteCode: harness.inviteCode,
      displayName: 'Guest',
    });
    harness.send(harness.host, { type: 'submit_precon', preconId: HUMAN_PRECON_ID });
    harness.send(guest, { type: 'submit_precon', preconId: BOT_PRECON_ID });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    harness.send(guest, { type: 'set_ready', ready: true });
    expect(harness.state()).not.toBeNull();

    // An all-human match ends without a pacing summary at all: there is no
    // pacing to report, and a page of zeroes would assert that it waited.
    const human = new ScriptedHuman(harness);
    const second = new ScriptedHuman(harness, 'player_2', 'second-human', guest);
    for (let step = 0; step < 20_000; step += 1) {
      const state = harness.state();
      if (!state || state.status === 'complete') break;
      if (!human.act(state)) {
        const next = harness.state();
        if (!next || !second.act(next)) break;
      }
    }
    expect(harness.host.all('bot_pacing_summary')).toHaveLength(0);
  });

  it('reads back through the reader unchanged, which is what an export is', async () => {
    const harness = createHarness();
    startPacedMatch(harness, pacing(50));
    await playPaced(harness, 250);

    const summary = harness.summary();
    if (!summary) throw new Error('The match published no pacing summary.');
    const round = readBotMatchSummary(JSON.parse(JSON.stringify(summary)));
    expect(round.ok).toBe(true);
    if (round.ok) expect(round.value).toEqual(summary);
  });

  it('attributes three bots separately at one table', async () => {
    const harness = createHarness({ maxSeats: 4 });
    startPacedMatch(harness, pacing(50), 3);
    const { state } = await playPaced(harness, 250);
    expect(state?.status).toBe('complete');

    const summary = harness.summary();
    if (!summary) throw new Error('The match published no pacing summary.');
    expect(summary.seats.map((seat) => seat.seatId)).toEqual(['seat_2', 'seat_3', 'seat_4']);
    // Three separate streams, three separate records: no seat's decisions are
    // pooled into another's.
    expect(new Set(summary.seats.map((seat) => seat.botId)).size).toBe(3);
    expect(summary.totals.decisions).toBe(
      summary.seats.reduce((sum, seat) => sum + seat.decisions, 0),
    );
    expect(summary.totals.waits.count).toBe(
      summary.seats.reduce((sum, seat) => sum + seat.waits.count, 0),
    );
    // With three bots offered the same window, the per-seat sum outgrows the
    // wall-clock union — and the record says so rather than leaving a reader to
    // work out why the numbers disagree.
    expect(summary.clock.botWaitSumMs).toBeGreaterThanOrEqual(summary.clock.botPacingMs);
    if (summary.clock.botWaitSumMs > summary.clock.botPacingMs) {
      expect(summary.limits).toContain('concurrent_waits_overlap');
    }
  });

  it('records a pilot fallback that happened in a live match', async () => {
    let asked = 0;
    const harness = createHarness({
      pilotFor: () => ({
        id: 'value',
        version: '1.1.0',
        agentClass: 'generic_heuristic',
        config: {},
        decide: (_observation: BotObservation) => {
          asked += 1;
          if (asked === 1) throw new Error('the pilot exploded');
          return createPilot({ id: 'value' }).decide(_observation, createRngState('fallback'));
        },
      }),
    });
    startPacedMatch(harness, IMMEDIATE_BOT_PACING);
    await playPaced(harness);

    const summary = harness.summary();
    if (!summary) throw new Error('The match published no pacing summary.');
    expect(summary.seats[0]?.pilotFailures.threw).toBe(1);
    expect(summary.totals.pilotFailures).toBe(1);
  });
});

/* ------------------------------------------- engine metrics versus the clock */

describe('pacing changes the clock and nothing else', () => {
  it('produces identical engine metrics at 0% and at 50% from one seed', async () => {
    const instant = createHarness();
    startPacedMatch(instant, IMMEDIATE_BOT_PACING);
    await playPaced(instant);

    const paced = createHarness();
    startPacedMatch(paced, pacing(50));
    await playPaced(paced);

    const a = instant.summary();
    const b = paced.summary();
    if (!a || !b) throw new Error('One of the two matches published no summary.');

    // The whole separation, in one assertion: the engine's count of the match is
    // the same game, and the clock's is a different experience of it.
    expect(b.engine).toEqual(a.engine);
    expect(b.totals.decisionsByCategory).toEqual(a.totals.decisionsByCategory);
    expect(a.clock.botPacingMs).toBe(0);
    expect(b.clock.botPacingMs).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------- the ingestion seam */

describe('the ingestion seam', () => {
  it('hands the finished summary to a sink exactly once', async () => {
    const received: BotMatchSummary[] = [];
    const sink: BotSummarySink = {
      sinkId: 'test_sink',
      receive: (summary) => {
        received.push(summary);
      },
    };
    const harness = createHarness({ sink });
    startPacedMatch(harness, IMMEDIATE_BOT_PACING);
    await playPaced(harness);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(harness.summary());
    expect(harness.server.summarySinkFailures).toEqual([]);
  });

  it('survives a sink that throws, and records that it did', async () => {
    const sink: BotSummarySink = {
      sinkId: 'broken_sink',
      receive: () => {
        throw new Error('the store was unavailable');
      },
    };
    const harness = createHarness({ sink });
    startPacedMatch(harness, IMMEDIATE_BOT_PACING);
    const { state } = await playPaced(harness);

    // A match that has just ended must not fail to publish its result because
    // something downstream of it was unavailable.
    expect(state?.status).toBe('complete');
    expect(harness.summary()).toBeDefined();
    expect(harness.server.summarySinkFailures).toEqual(['broken_sink: the store was unavailable']);
  });

  it('claims nothing durable, and the source says so rather than a comment', () => {
    expect(NO_DURABLE_SUMMARY_STORE).toContain('held nowhere');
    // The seam is one call site and nothing more. A second producer, or a hook
    // inside the match loop, is exactly what would make M08 a rewrite of this
    // rather than an implementation of the interface.
    const source = readFileSync(
      join(REPO_ROOT, 'apps/multiplayer-server/src/match-server.ts'),
      'utf8',
    );
    expect(source.match(/sink\.receive\(/g) ?? []).toHaveLength(1);
    expect(source.match(/buildBotMatchSummary\(/g) ?? []).toHaveLength(1);
  });
});
