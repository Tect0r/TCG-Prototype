import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOT_CONFIG_SCHEMA_VERSION,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_BOT_PACING_BUDGETS,
  DIFFICULTY_REGISTRY_VERSION,
  IMMEDIATE_BOT_PACING,
  PACING_SAFETY_MARGIN_MS,
  botDelayMs,
  type BotPacing,
  type BotSeatConfig,
} from '@tcg/bot-config';
import {
  createPilot,
  type BotDecision,
  type BotObservation,
  type BotPolicy,
} from '@tcg/bot-interface';
import { loadFormatCardData, resolveFormatId } from '@tcg/card-data';
import { deckFormatOf } from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  encode,
  type ClientMessageInput,
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
import { BotRunner, hasBotDecision, type BotRunReport } from './bot-runner.js';
import { MatchServer, type ServerConnection } from './match-server.js';
import type { ScheduleTimer } from './scheduling.js';

/**
 * The server bot-delay scheduler (M09.12).
 *
 * Six claims, and every one of them is about a wait that never actually happens
 * in wall-clock time: the whole suite runs on an injected timer and an injected
 * monotonic clock, so a 29.75-second decision costs the test nothing and is
 * asserted to the millisecond rather than to the nearest tolerance.
 *
 * 1. **The delay is the configured one.** 0%, 50% and 100% of a budget are 0 ms,
 *    15 000 ms and 29 750 ms, and the third of those is where the quarter-second
 *    safety margin is visible.
 * 2. **The category is classified from structured data**, so a Reaction window
 *    draws on the Reaction budget and a bot with an override waits its own
 *    shorter time inside one.
 * 3. **The decision is made at expiry.** The pilot is not asked while the timer
 *    runs, and what it is finally asked about is the board as it is *then* —
 *    not the board that offered the opportunity.
 * 4. **Obsolete work is cancelled**: elimination, a finished match, a discarded
 *    lobby and a stopped runner each end an outstanding wait without submitting
 *    anything out of it.
 * 5. **Independent waits overlap.** Two bots offered a decision at the same
 *    moment cost one budget between them, not two.
 * 6. **Pacing changes nothing about the match.** The same seed produces the
 *    identical game whether the bots waited or not, because no clock reading
 *    reaches a pilot's stream or the engine.
 *
 * And one non-regression: the simulator and Spectator have no pacing, no timer
 * and no clock, and a source scan says so rather than a sentence.
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

function botConfigFor(seatPacing: BotPacing): BotSeatConfig {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    controller: { botId: 'bot_1', displayName: 'Bot 2' },
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style: 'value',
    deck: { mode: 'exact_precon', preconId: BOT_PRECON_ID },
    pacing: seatPacing,
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

  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const message = this.sent[i];
      if (message?.type === type) return message as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }
}

/* ------------------------------------------------------------- fake time */

interface FakeTimer {
  readonly id: number;
  readonly at: number;
  readonly delayMs: number;
  readonly callback: () => void;
  cancelled: boolean;
  fired: boolean;
}

/**
 * A timer wheel and a monotonic clock a test drives by hand.
 *
 * Deliberately not `vi.useFakeTimers()`: this suite has to assert *which* delay
 * was scheduled, and that nothing was scheduled at all at 0%, and a global timer
 * mock would answer neither. `lateBy` exists so that the recorded actual delay is
 * a measurement rather than a copy of the intended one.
 */
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
      delayMs,
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

  /** Every timer that has been scheduled and neither fired nor been cancelled. */
  pending(): FakeTimer[] {
    return this.timers.filter((timer) => !timer.cancelled && !timer.fired);
  }

  /** The soonest outstanding expiry, or `null` when nothing is waiting. */
  next(): FakeTimer | null {
    const [soonest] = this.pending().sort((a, b) => a.at - b.at || a.id - b.id);
    return soonest ?? null;
  }

  /** Moves the clock, firing what falls due and nothing that does not. */
  advanceTo(target: number): void {
    for (;;) {
      const soonest = this.next();
      if (!soonest || soonest.at > target) break;
      this.#now = soonest.at + this.lateBy;
      soonest.fired = true;
      soonest.callback();
    }
    if (target > this.#now) this.#now = target;
  }

  /** Fires exactly the next expiry, whenever it is. */
  fireNext(): FakeTimer | null {
    const soonest = this.next();
    if (!soonest) return null;
    this.#now = soonest.at + this.lateBy;
    soonest.fired = true;
    soonest.callback();
    return soonest;
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
  report(): BotRunReport | undefined;
}

interface HarnessOptions {
  readonly seed?: string;
  readonly maxSeats?: number;
  readonly lateBy?: number;
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
  const inviteCode = joined.lobby.inviteCode;

  return {
    server,
    host,
    clock,
    inviteCode,
    send,
    state: () => server.lobbyByCode(inviteCode)?.state ?? null,
    report: () => server.botReport(inviteCode),
  };
}

/** Seats `bots` bots at the given pacing, submits the human deck, and starts. */
function startPacedMatch(harness: Harness, seatPacing: BotPacing, bots = 1): void {
  for (let index = 0; index < bots; index += 1) {
    harness.send(harness.host, { type: 'add_bot', setup: botSetup({ pacing: seatPacing }) });
  }
  harness.send(harness.host, { type: 'submit_precon', preconId: HUMAN_PRECON_ID });
  harness.send(harness.host, { type: 'set_ready', ready: true });
  // Only a two-seat table starts itself (open-questions.md Q36); a wider one
  // waits for the host to say so, and a bot never can.
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
  ) {
    this.#rng = createRngState(seed);
  }

  get decisions(): number {
    return this.#decisions;
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

    this.harness.send(this.harness.host, {
      type: 'submit_action',
      actionId: `human_${this.#decisions}`,
      lastSequence: state.sequence,
      action: decision.action,
    });
    return true;
  }
}

/**
 * Plays a paced match out: whenever a bot is waiting, time moves; otherwise the
 * human does. The order is what makes the comparison with an unpaced match fair
 * — neither side ever acts while the other is owed a turn.
 */
async function playPaced(harness: Harness, human = new ScriptedHuman(harness)) {
  for (let step = 0; step < 20_000; step += 1) {
    await harness.server.whenBotsIdle();
    const state = harness.state();
    if (!state || state.status === 'complete') return { state, human, blocked: false };
    if (harness.clock.next() !== null) {
      harness.clock.fireNext();
      continue;
    }
    if (!human.act(state)) return { state, human, blocked: true };
  }
  throw new Error('The paced match did not finish inside 20 000 steps.');
}

/** The whole observable result of one match, for comparison. */
function outcomeOf(played: Awaited<ReturnType<typeof playPaced>>, harness: Harness) {
  return {
    sequence: played.state?.sequence,
    turn: played.state?.turn,
    result: played.state?.result,
    humanDecisions: played.human.decisions,
    seats: (harness.report()?.seats ?? []).map((seat) => ({
      seatId: seat.seatId,
      seed: seat.seed,
      decisions: seat.decisions,
      actions: seat.actions,
    })),
    incidents: harness.report()?.incidents,
  };
}

/* --------------------------------------------------- the configured delay */

describe('a bot waits for exactly the fraction it was configured for', () => {
  it('schedules 50% of the ordinary budget and acts at the millisecond it expires', async () => {
    const harness = createHarness();
    startPacedMatch(harness, pacing(50));
    await harness.server.whenBotsIdle();

    expect(harness.report()?.waiting).toEqual([
      { seatId: 'seat_2', category: 'ordinary', intendedMs: 15_000 },
    ]);
    expect(harness.clock.pending().map((timer) => timer.delayMs)).toEqual([15_000]);

    // One millisecond short of the wait, the bot has done nothing at all.
    harness.clock.advanceTo(14_999);
    await harness.server.whenBotsIdle();
    expect(harness.report()?.seats[0]?.decisions).toBe(0);

    harness.clock.advanceTo(15_000);
    await harness.server.whenBotsIdle();
    expect(harness.report()?.seats[0]?.decisions).toBe(1);
  });

  it.each([
    { percent: 0, intendedMs: 0, timers: 0 },
    { percent: 50, intendedMs: 15_000, timers: 1 },
    { percent: 100, intendedMs: 29_750, timers: 1 },
  ])('waits $intendedMs ms at $percent%', async ({ percent, intendedMs, timers }) => {
    const harness = createHarness();
    startPacedMatch(harness, pacing(percent));
    await harness.server.whenBotsIdle();

    expect(harness.clock.pending()).toHaveLength(timers);
    // The same arithmetic the lobby prints beside the dial rather than a second
    // copy of it, and the literals as well, so a change to either has to be
    // argued for rather than absorbed.
    expect(botDelayMs(pacing(percent), DEFAULT_BOT_PACING_BUDGETS, 'ordinary')).toBe(intendedMs);
    if (timers === 0) {
      // The M09.4 path, unchanged: an immediate bot acts inside the wake that
      // offered the opportunity, and schedules nothing.
      expect(harness.report()?.seats[0]?.decisions).toBeGreaterThan(0);
      expect(harness.report()?.seats[0]?.delays).toEqual([]);
    } else {
      expect(harness.clock.pending()[0]?.delayMs).toBe(intendedMs);
      expect(harness.report()?.seats[0]?.decisions).toBe(0);
    }
  });

  it('keeps a quarter of a second of every budget back, whatever the budget is', async () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'set_bot_pacing',
      budgets: { ...DEFAULT_BOT_PACING_BUDGETS, ordinarySeconds: 4 },
    });
    startPacedMatch(harness, pacing(100));
    await harness.server.whenBotsIdle();

    // 100% of four seconds is four seconds less the margin, not four seconds:
    // the decision still has to be made and submitted inside the budget the
    // owner is measuring.
    expect(harness.clock.pending()[0]?.delayMs).toBe(4_000 - PACING_SAFETY_MARGIN_MS);
  });

  it('records what it intended and what the clock actually saw', async () => {
    // Every timer fires 7 ms late, which is what a real event loop does and what
    // a recorded actual delay is for.
    const harness = createHarness({ lateBy: 7 });
    startPacedMatch(harness, pacing(50));
    await harness.server.whenBotsIdle();
    harness.clock.fireNext();
    await harness.server.whenBotsIdle();

    const [first] = harness.report()?.seats[0]?.delays ?? [];
    expect(first).toEqual({
      decisionIndex: 0,
      category: 'ordinary',
      intendedMs: 15_000,
      actualMs: 15_007,
    });
  });
});

/* -------------------------------------------------------- classification */

describe('the budget follows the kind of opportunity, from structured data', () => {
  it('times a Reaction window on the Reaction budget, with the bot own override', async () => {
    const harness = createHarness();
    // Slow in its own turn and quick in somebody else's — the configuration the
    // override exists for.
    const seatPacing = pacing(100, 20);
    startPacedMatch(harness, seatPacing);
    const { state } = await playPaced(harness);
    expect(state?.status).toBe('complete');

    const delays = harness.report()?.seats[0]?.delays ?? [];
    const categories = new Set(delays.map((delay) => delay.category));
    // The match really did present all three, which is what makes the mapping
    // worth asserting rather than a table nothing exercises.
    expect(categories).toContain('ordinary');
    expect(categories).toContain('reaction');
    expect(categories).toContain('pending_choice');

    for (const delay of delays) {
      expect(delay.intendedMs).toBe(
        botDelayMs(seatPacing, DEFAULT_BOT_PACING_BUDGETS, delay.category),
      );
    }
    // 20% of the five-second Reaction budget, and 100% of the thirty-second one
    // less the margin. A pending choice draws on the ordinary budget, which is
    // `PACING_BUDGET_BY_CATEGORY`'s decision and not this scheduler's.
    const intendedFor = (category: string): number[] =>
      delays.filter((delay) => delay.category === category).map((delay) => delay.intendedMs);
    expect(new Set(intendedFor('reaction'))).toEqual(new Set([1_000]));
    expect(new Set(intendedFor('ordinary'))).toEqual(new Set([29_750]));
    expect(new Set(intendedFor('pending_choice'))).toEqual(new Set([29_750]));
  });
});

/* ---------------------------------------- decided at expiry, never before */

describe('a wait holds no decision', () => {
  /** A pilot that records every board it is asked about, and otherwise plays. */
  function recordingPilot(seen: number[]): BotPolicy {
    const inner = createPilot({ id: 'value' });
    return {
      id: inner.id,
      version: inner.version,
      config: inner.config,
      decide: (observation: BotObservation, rng: RngState): BotDecision | Promise<BotDecision> => {
        seen.push(observation.view.sequence);
        return inner.decide(observation, rng);
      },
    };
  }

  it('asks the pilot nothing until expiry, and then asks about the board as it is then', async () => {
    const seen: number[] = [];
    const clock = new FakeClock();
    const harness = createHarness();
    // Paced, so the board below is one the bot seat has not already played out.
    startPacedMatch(harness, pacing(50));
    await harness.server.whenBotsIdle();

    // Two real boards, one strictly later than the other.
    const before = harness.state();
    if (!before) throw new Error('The match did not start.');
    const after: MatchState = { ...structuredClone(before), sequence: before.sequence + 5 };

    let current: MatchState = before;
    const runner = new BotRunner({
      matchSeed: 'expiry',
      database,
      config,
      seats: [{ seatId: 'seat_2', playerId: 'player_2', config: botConfigFor(pacing(50)) }],
      budgets: DEFAULT_BOT_PACING_BUDGETS,
      schedule: clock.schedule,
      now: clock.monotonicNow,
      state: () => current,
      submit: () => ({ ok: true }),
      pilotFor: () => recordingPilot(seen),
      decisionLimit: 1,
    });

    runner.wake();
    await runner.pending;
    // The wait is running and the pilot has been asked nothing: there is no
    // stored answer for a later board to invalidate.
    expect(clock.pending()).toHaveLength(1);
    expect(seen).toEqual([]);

    // The board moves while the timer runs — which is what a human acting looks
    // like from in here.
    current = after;
    clock.fireNext();
    await runner.pending;

    expect(seen).toEqual([after.sequence]);
  });

  it('names no field a decision could be stored in', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'apps/multiplayer-server/src/bot-runner.ts'),
      'utf8',
    );
    const start = source.indexOf('interface PendingDelay {');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('}', start));
    for (const field of ['action', 'decision', 'chosen', 'observation', 'legal']) {
      expect(`${field}: ${body.includes(`${field}:`)}`).toBe(`${field}: false`);
    }
  });
});

/* ----------------------------------------------------------- cancellation */

describe('obsolete work is cancelled rather than left to expire', () => {
  function runnerOver(state: () => MatchState | null, submitted: string[]) {
    const clock = new FakeClock();
    const runner = new BotRunner({
      matchSeed: 'cancel',
      database,
      config,
      seats: [{ seatId: 'seat_2', playerId: 'player_2', config: botConfigFor(pacing(50)) }],
      budgets: DEFAULT_BOT_PACING_BUDGETS,
      schedule: clock.schedule,
      now: clock.monotonicNow,
      state,
      submit: (_seatId, actionId) => {
        submitted.push(actionId);
        return { ok: true };
      },
    });
    return { runner, clock };
  }

  /**
   * A real opening board on which `player_2` is still owed a decision.
   *
   * Paced rather than immediate on purpose: an immediate bot has already played
   * every move it was offered by the time `whenBotsIdle` resolves, and a board
   * offering the seat nothing schedules nothing, so the cancellations below
   * would all pass without a wait ever existing to cancel.
   */
  async function startedMatch(): Promise<MatchState> {
    const harness = createHarness();
    startPacedMatch(harness, pacing(50));
    await harness.server.whenBotsIdle();
    const state = harness.state();
    if (!state) throw new Error('The match did not start.');
    expect(hasBotDecision(legalActions(state, 'player_2', { database, config }))).toBe(true);
    return state;
  }

  it('drops the wait when the seat is eliminated', async () => {
    const live = await startedMatch();
    const eliminated: MatchState = structuredClone(live);
    const player = eliminated.players.player_2;
    if (!player) throw new Error('There is no second seat.');
    player.lost = true;

    const submitted: string[] = [];
    let current: MatchState = live;
    const { runner, clock } = runnerOver(() => current, submitted);

    runner.wake();
    await runner.pending;
    expect(clock.pending()).toHaveLength(1);

    current = eliminated;
    runner.wake();
    await runner.pending;

    expect(runner.report().waiting).toEqual([]);
    expect(runner.report().seats[0]?.delaysCancelled).toBe(1);
    expect(runner.report().seats[0]?.lastDelayCancellation).toContain('out of the match');
    expect(submitted).toEqual([]);
  });

  it('drops the wait when the match ends underneath it', async () => {
    const live = await startedMatch();
    const finished: MatchState = { ...structuredClone(live), status: 'complete' };

    const submitted: string[] = [];
    let current: MatchState = live;
    const { runner, clock } = runnerOver(() => current, submitted);

    runner.wake();
    await runner.pending;
    expect(clock.pending()).toHaveLength(1);

    current = finished;
    runner.wake();
    await runner.pending;

    expect(runner.report().waiting).toEqual([]);
    // The timer itself is gone rather than merely ignored: nothing is left
    // holding a finished `MatchState` alive on a long-running process.
    expect(clock.pending()).toHaveLength(0);
    expect(submitted).toEqual([]);
  });

  it('drops the wait when the lobby the bot was playing in goes away', async () => {
    const live = await startedMatch();
    const submitted: string[] = [];
    let current: MatchState | null = live;
    const { runner, clock } = runnerOver(() => current, submitted);

    runner.wake();
    await runner.pending;
    // Asserted before the lobby disappears, so the emptiness below is a wait
    // that was cancelled rather than a wait that never started.
    expect(clock.pending()).toHaveLength(1);

    current = null;
    runner.wake();
    await runner.pending;

    expect(clock.pending()).toHaveLength(0);
    expect(submitted).toEqual([]);
  });

  it('cancels every outstanding wait when the runner is stopped', async () => {
    const live = await startedMatch();
    const submitted: string[] = [];
    const { runner, clock } = runnerOver(() => live, submitted);

    runner.wake();
    await runner.pending;
    expect(clock.pending()).toHaveLength(1);

    runner.stop();
    expect(clock.pending()).toHaveLength(0);
    expect(runner.report().waiting).toEqual([]);
  });

  it('leaves nothing waiting once a real paced match has finished', async () => {
    const harness = createHarness();
    startPacedMatch(harness, pacing(50));
    const { state } = await playPaced(harness);

    expect(state?.status).toBe('complete');
    expect(harness.report()?.waiting).toEqual([]);
    expect(harness.clock.pending()).toEqual([]);
  });

  /** A real board on which `player_2` is offered nothing at all. */
  async function quietBoard(): Promise<MatchState> {
    const harness = createHarness();
    startPacedMatch(harness, IMMEDIATE_BOT_PACING);
    await harness.server.whenBotsIdle();
    const state = harness.state();
    if (!state) throw new Error('The match did not start.');
    // An immediate bot has played everything it was offered, so the board is now
    // owed a move by the human and by nobody else.
    expect(hasBotDecision(legalActions(state, 'player_2', { database, config }))).toBe(false);
    return state;
  }

  it('drops the wait when the window it was about closes', async () => {
    const live = await startedMatch();
    const quiet = await quietBoard();

    const submitted: string[] = [];
    let current: MatchState = live;
    const { runner, clock } = runnerOver(() => current, submitted);

    runner.wake();
    await runner.pending;
    expect(clock.pending()).toHaveLength(1);

    // What a human acting looks like from in here: the board moved and the seat
    // is no longer being offered anything.
    current = quiet;
    runner.wake();
    await runner.pending;

    expect(clock.pending()).toHaveLength(0);
    expect(runner.report().seats[0]?.delaysCancelled).toBe(1);
    expect(runner.report().seats[0]?.lastDelayCancellation).toContain('stopped offering');
    expect(submitted).toEqual([]);
  });

  it('does not restart a still-valid wait because somebody else acted', async () => {
    const live = await startedMatch();
    const moved: MatchState = { ...structuredClone(live), sequence: live.sequence + 3 };

    const submitted: string[] = [];
    let current: MatchState = live;
    const { runner, clock } = runnerOver(() => current, submitted);

    runner.wake();
    await runner.pending;
    const [scheduled] = clock.pending();
    expect(scheduled?.delayMs).toBe(15_000);

    // Halfway through, and a different seat commits something that leaves this
    // seat's opportunity exactly as it was.
    clock.advanceTo(7_000);
    current = moved;
    runner.wake();
    await runner.pending;

    // The same timer, still due at the same instant. Restarting here would
    // starve a slow bot at a busy table of ever acting at all, which is why the
    // decision is deliberately made at expiry against whatever board exists then
    // rather than by counting again from every sequence change.
    expect(clock.pending().map((timer) => timer.id)).toEqual([scheduled?.id]);
    expect(clock.pending()[0]?.at).toBe(15_000);
    expect(runner.report().seats[0]?.delaysCancelled).toBe(0);
    expect(runner.report().seats[0]?.delaysRescheduled).toBe(0);

    clock.advanceTo(15_000);
    await runner.pending;
    expect(submitted).toHaveLength(1);
  });

  /**
   * A real board on which `player_2` is inside an open Reaction window.
   *
   * Played to rather than written: a Reaction window is opened by an opponent's
   * declaration, and a hand-built `MatchState` claiming one would prove the
   * scheduler agrees with the fixture rather than with the engine.
   */
  async function reactionBoard(): Promise<MatchState> {
    const harness = createHarness();
    startPacedMatch(harness, pacing(50));
    const human = new ScriptedHuman(harness);
    for (let step = 0; step < 20_000; step += 1) {
      await harness.server.whenBotsIdle();
      if (harness.report()?.waiting[0]?.category === 'reaction') {
        const state = harness.state();
        if (!state) throw new Error('The match vanished mid-window.');
        return state;
      }
      const state = harness.state();
      if (!state || state.status === 'complete') break;
      if (harness.clock.next() !== null) {
        harness.clock.fireNext();
        continue;
      }
      if (!human.act(state)) break;
    }
    throw new Error('No Reaction window was offered to the bot seat.');
  }

  it('restarts the countdown when the opportunity changes budget', async () => {
    const live = await startedMatch();
    const reacting = await reactionBoard();

    const submitted: string[] = [];
    let current: MatchState = live;
    const { runner, clock } = runnerOver(() => current, submitted);

    runner.wake();
    await runner.pending;
    expect(clock.pending()[0]?.delayMs).toBe(15_000);

    // An ordinary decision became a Reaction window, which draws on the other
    // budget. The countdown in flight is for the wrong number, so it is dropped
    // and restarted rather than allowed to expire into a delay nothing on the
    // screen predicted.
    current = reacting;
    runner.wake();
    await runner.pending;

    expect(clock.pending()).toHaveLength(1);
    // 50% of the five-second Reaction budget, from the same `botDelayMs` the
    // lobby prints.
    expect(clock.pending()[0]?.delayMs).toBe(
      botDelayMs(pacing(50), DEFAULT_BOT_PACING_BUDGETS, 'reaction'),
    );
    expect(runner.report().waiting).toEqual([
      { seatId: 'seat_2', category: 'reaction', intendedMs: 2_500 },
    ]);
    expect(runner.report().seats[0]?.delaysRescheduled).toBe(1);
    // Restarted, not abandoned: the two counters answer different questions and
    // a reschedule must not be reported as both.
    expect(runner.report().seats[0]?.delaysCancelled).toBe(0);
    expect(runner.report().seats[0]?.lastDelayCancellation).toBeNull();
    expect(submitted).toEqual([]);
  });

  it('cannot be reconfigured or removed out from under a wait at all', async () => {
    const harness = createHarness();
    startPacedMatch(harness, pacing(50));
    await harness.server.whenBotsIdle();
    expect(harness.report()?.waiting).toHaveLength(1);

    // The milestone names reconfiguration and bot removal as cancellation
    // triggers. In this build they are not triggers that fire and get handled,
    // they are triggers that cannot arise: every bot message goes through one
    // host-and-before-start preamble, and a started lobby refuses all of them by
    // name. Asserted here rather than assumed, because the day that preamble
    // grows a fifth caller is the day the scheduler needs a cancellation path.
    const before = harness.host.sent.length;
    harness.send(harness.host, {
      type: 'update_bot',
      seatId: 'seat_2',
      setup: botSetup({ pacing: pacing(100) }),
    });
    harness.send(harness.host, { type: 'remove_bot', seatId: 'seat_2' });
    harness.send(harness.host, {
      type: 'set_bot_pacing',
      budgets: { ...DEFAULT_BOT_PACING_BUDGETS, ordinarySeconds: 1 },
    });

    const refusals = harness.host.sent
      .slice(before)
      .flatMap((message) => (message.type === 'error' ? [message.error.code] : []));
    expect(refusals).toEqual([
      'protocol/already_started',
      'protocol/already_started',
      'protocol/already_started',
    ]);
    // Refused, so the wait in flight is exactly the one that was scheduled: the
    // 15 000 ms the locked budgets and the seat's own 50% imply, not the 1 000
    // the refused message asked for.
    expect(harness.report()?.waiting).toEqual([
      { seatId: 'seat_2', category: 'ordinary', intendedMs: 15_000 },
    ]);
    expect(harness.report()?.seats[0]?.delaysCancelled).toBe(0);
  });

  it('never reports a paced table as stalled just because it is waiting', async () => {
    const harness = createHarness();
    startPacedMatch(harness, pacing(50));
    await harness.server.whenBotsIdle();

    expect(harness.report()?.waiting).toHaveLength(1);
    expect(harness.report()?.stalled).toBeNull();
  });
});

/* ------------------------------------------------------------ concurrency */

describe('independent waits overlap', () => {
  it('costs one budget for two bots offered a decision at the same moment', async () => {
    const harness = createHarness({ maxSeats: 3 });
    startPacedMatch(harness, pacing(50), 2);
    await harness.server.whenBotsIdle();

    // Two timers, both running, both for the same budget: the second bot is not
    // queued behind the first.
    expect(harness.report()?.waiting).toEqual([
      { seatId: 'seat_2', category: 'ordinary', intendedMs: 15_000 },
      { seatId: 'seat_3', category: 'ordinary', intendedMs: 15_000 },
    ]);

    harness.clock.advanceTo(15_000);
    await harness.server.whenBotsIdle();

    const seats = harness.report()?.seats ?? [];
    expect(seats.map((seat) => seat.decisions)).toEqual([1, 1]);
    // Fifteen seconds of clock bought two decisions rather than one.
    expect(harness.clock.now).toBe(15_000);
  });
});

/* ------------------------------------------------------------ determinism */

describe('pacing changes how long a match takes and nothing else', () => {
  it('plays the identical match paced and unpaced, from the same seed', async () => {
    const unpaced = createHarness({ seed: 'paced-determinism' });
    startPacedMatch(unpaced, IMMEDIATE_BOT_PACING);
    const withoutDelay = await playPaced(unpaced);

    const paced = createHarness({ seed: 'paced-determinism', lateBy: 3 });
    startPacedMatch(paced, pacing(100, 20));
    const withDelay = await playPaced(paced);

    expect(withoutDelay.state?.status).toBe('complete');
    // Same seed, same seating, same decisions, same result. No clock reading has
    // reached a pilot's stream or the engine, which is the only way this can be
    // true of a match whose bot waited half a minute a move.
    expect(outcomeOf(withDelay, paced)).toEqual(outcomeOf(withoutDelay, unpaced));
    // And the paced one really did wait: the claim is not that pacing did
    // nothing, only that it changed nothing about the game.
    expect(paced.clock.now).toBeGreaterThan(0);
    expect(unpaced.clock.now).toBe(0);
  });
});

/* ------------------------------------------ the simulator and the Spectator */

describe('simulation stays full speed', () => {
  function sourceFilesUnder(relative: string): string[] {
    const found: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') || full.endsWith('.tsx')) found.push(full);
      }
    };
    walk(join(REPO_ROOT, relative));
    return found;
  }

  it('gives the simulator and the Spectator no pacing, no timer and no clock', () => {
    const files = [
      ...sourceFilesUnder('apps/simulator/src'),
      ...sourceFilesUnder('packages/spectator/src'),
    ];
    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of ['botDelayMs', 'BotPacing', 'BotRunner', 'scheduling.js']) {
        expect(`${file} mentions ${forbidden}: ${source.includes(forbidden)}`).toBe(
          `${file} mentions ${forbidden}: false`,
        );
      }
    }
  });
});
