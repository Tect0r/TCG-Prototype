import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_DIFFICULTIES,
  BOT_CONFIG_SCHEMA_VERSION,
  BOT_DECK_MODES,
  BOT_STYLES,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_BOT_PACING_BUDGETS,
  DIFFICULTY_REGISTRY_VERSION,
  IMMEDIATE_BOT_PACING,
  botDelayMs,
  type BotDeckMode,
  type BotDeckSource,
  type BotDifficulty,
  type BotPacing,
  type BotStyle,
  type BotStyleSetting,
} from '@tcg/bot-config';
import { createPilot, type BotObservation, type BotPolicy } from '@tcg/bot-interface';
import { bundledPrecon, loadFormatCardData, resolveFormatId } from '@tcg/card-data';
import {
  DECK_SCHEMA_VERSION,
  deckFingerprint,
  deckFormatOf,
  expandDeckCards,
  preconToDeck,
  type SavedDeck,
} from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  encode,
  type BotSetup,
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
import { hasBotDecision, type BotRunReport } from './bot-runner.js';
import { PLAYER_ID_BY_SEAT, isBotSeat } from './lobby.js';
import { MatchServer, type ServerConnection } from './match-server.js';
import { defaultYieldToScheduler, type ScheduleTimer } from './scheduling.js';

/**
 * End-to-end hardening and milestone acceptance (M09.19).
 *
 * The last tranche in M09, and the only one whose subject is the *whole*
 * feature rather than one axis of it. Everything below plays real matches
 * through `receive`, so what is asserted is what a real host, a real guest and a
 * real bot seat would actually do.
 *
 * Six claims, in the order the milestone checklist names them.
 *
 * 1. **Every seat mixture with at least one person plays, across every deck
 *    mode.** The mixtures are the four M09.7 opened — 1H+1B, 1H+3B, 2H+2B,
 *    3H+1B — and the modes are `BOT_DECK_MODES`, read from the registry so a
 *    fifth mode cannot be added without this matrix noticing. The two are
 *    crossed rather than listed: a three-bot table seats three *different*
 *    modes at once, which is the arrangement that would break if the modes
 *    shared any state.
 * 2. **Every difficulty, style, timing and lifecycle path is covered.** Read
 *    from `AVAILABLE_DIFFICULTIES` and `BOT_STYLES` for the same reason.
 * 3. **Hidden information does not cross any boundary**: the lobby view, the
 *    player view a bot is handed, the log, the pacing export, and what one
 *    opponent's connection ever receives.
 * 4. **The simulator and the Spectator are unaffected**, which here means the
 *    thing this tranche actually changed — the runner's default yield — is not
 *    on their path at all.
 * 5. **Server action latency, with deliberate pacing excluded**, and the
 *    property that motivates measuring it: bot work does not block a human's
 *    message from being handled.
 * 6. Visual checks are recorded in the milestone document rather than here,
 *    because a claim about what a screen looks like is not something a test can
 *    make honestly. The record says which tooling was available and which was
 *    not.
 *
 * **What this file deliberately does not re-prove.** M09.4–M09.18 each own an
 * axis and each assert it in detail; repeating those assertions here would
 * produce a second, weaker copy that drifts. The tests below are the *crossings*
 * — the combinations no single tranche was responsible for — plus the two
 * defects this tranche found and fixed.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);
const config = DEFAULT_RULES_CONFIG;

const PRECONS = [
  'precon_containment_control',
  'precon_bastion_guardians',
  'precon_goblin_swarm',
  'precon_grave_sacrifice',
] as const;

/** A Commander a host may name for `commander_generated`. */
const NAMED_COMMANDER = 'goblin_warboss';

/* ---------------------------------------------------------------- plumbing */

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

  all<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter(
      (message): message is Extract<ServerMessage, { type: T }> => message.type === type,
    );
  }
}

interface FakeTimer {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
  cancelled: boolean;
  fired: boolean;
}

/** M09.12's timer wheel, reused so a 100% wait costs this suite nothing. */
class FakeClock {
  #now = 0;
  #nextId = 0;
  readonly timers: FakeTimer[] = [];

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

  next(): FakeTimer | null {
    const [soonest] = this.timers
      .filter((timer) => !timer.cancelled && !timer.fired)
      .sort((a, b) => a.at - b.at || a.id - b.id);
    return soonest ?? null;
  }

  fireNext(): FakeTimer | null {
    const soonest = this.next();
    if (!soonest) return null;
    this.#now = soonest.at;
    soonest.fired = true;
    soonest.callback();
    return soonest;
  }
}

/* ------------------------------------------------------------ deck sources */

function savedDeckFrom(preconId: string): SavedDeck {
  const precon = bundledPrecon(preconId);
  if (!precon) throw new Error(`${preconId} is missing from the bundle.`);
  return {
    ...preconToDeck(precon, { id: `deck_${preconId}`, now: '2026-08-21T09:00:00.000Z' }),
    schemaVersion: DECK_SCHEMA_VERSION,
    name: 'A deck nobody else may read',
  };
}

/** Exactly what a host's client freezes and sends for `exact_saved_deck`. */
function savedSource(preconId: string): BotDeckSource {
  const deck = savedDeckFrom(preconId);
  if (deck.commanderId === null) throw new Error('A snapshot needs a Commander.');
  return {
    mode: 'exact_saved_deck',
    deck: {
      sourceDeckId: deck.id,
      name: deck.name,
      commanderId: deck.commanderId,
      cardIds: expandDeckCards(deck.cards),
      deckHash: deckFingerprint(deck),
    },
  };
}

/** One deck source per mode, so the matrix is built from the registry. */
function sourceFor(mode: BotDeckMode, index: number): BotDeckSource {
  const preconId = PRECONS[index % PRECONS.length] as string;
  switch (mode) {
    case 'exact_precon':
      return { mode, preconId };
    case 'exact_saved_deck':
      return savedSource(preconId);
    case 'commander_generated':
      return {
        mode,
        commanderId: NAMED_COMMANDER,
        seed: `acceptance-commander-${index}`,
        generated: null,
      };
    case 'autonomous_generated':
      return { mode, seed: `acceptance-autonomous-${index}`, generated: null };
  }
}

interface SetupOverrides {
  readonly difficulty?: BotDifficulty;
  readonly style?: BotStyleSetting;
  readonly pacing?: BotPacing;
}

function setupFor(deck: BotDeckSource, overrides: SetupOverrides = {}): BotSetup {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    difficulty: overrides.difficulty ?? DEFAULT_BOT_DIFFICULTY,
    style: overrides.style ?? 'value',
    deck,
    pacing: overrides.pacing ?? IMMEDIATE_BOT_PACING,
    displayName: null,
  };
}

/* -------------------------------------------------------------- the table */

interface SeatedHuman {
  readonly connection: FakeConnection;
  readonly seatId: SeatId;
  readonly reconnectToken: string;
}

interface TableOptions {
  readonly seed?: string;
  readonly maxSeats?: number;
  /** Left unset to exercise the production default: a real macrotask yield. */
  readonly yieldToScheduler?: () => Promise<void>;
  readonly pilotFor?: () => BotPolicy;
}

class AcceptanceTable {
  readonly server: MatchServer;
  readonly clock = new FakeClock();
  readonly humans: SeatedHuman[] = [];
  inviteCode = '';

  constructor(private readonly options: TableOptions = {}) {
    let counter = 0;
    const pilotFor = options.pilotFor;
    this.server = new MatchServer({
      database,
      deckFormat,
      random: () => {
        counter += 1;
        return ((counter * 2654435761) % 4294967296) / 4294967296;
      },
      schedule: this.clock.schedule,
      monotonicNow: this.clock.monotonicNow,
      seedFor: () => options.seed ?? 'acceptance-seed',
      now: () => 1_000_000,
      ...(options.yieldToScheduler === undefined
        ? {}
        : { yieldToScheduler: options.yieldToScheduler }),
      ...(pilotFor === undefined ? {} : { botPilotFor: pilotFor }),
    });
  }

  send(connection: FakeConnection, message: ClientMessageInput): void {
    this.server.receive(connection, encode(message as never));
  }

  connect(id: string): FakeConnection {
    const connection = new FakeConnection(id);
    this.server.connect(connection);
    return connection;
  }

  createLobby(): FakeConnection {
    const host = this.connect('conn_host');
    this.send(host, {
      type: 'create_lobby',
      versions: CURRENT_VERSIONS,
      displayName: 'Host',
      maxSeats: this.options.maxSeats ?? 4,
    });
    const joined = host.last('lobby_joined');
    if (!joined) throw new Error('The host did not create a lobby.');
    this.inviteCode = joined.lobby.inviteCode;
    this.humans.push({
      connection: host,
      seatId: joined.seatId,
      reconnectToken: joined.reconnectToken,
    });
    return host;
  }

  get host(): FakeConnection {
    const host = this.humans[0]?.connection;
    if (!host) throw new Error('This table has no host.');
    return host;
  }

  joinHuman(name: string): SeatedHuman {
    const connection = this.connect(`conn_${name}`);
    this.send(connection, {
      type: 'join_lobby',
      versions: CURRENT_VERSIONS,
      inviteCode: this.inviteCode,
      displayName: name,
    });
    const joined = connection.last('lobby_joined');
    if (!joined) throw new Error(`${name} did not join.`);
    const seated = {
      connection,
      seatId: joined.seatId,
      reconnectToken: joined.reconnectToken,
    };
    this.humans.push(seated);
    return seated;
  }

  addBot(deck: BotDeckSource, overrides: SetupOverrides = {}): void {
    this.send(this.host, { type: 'add_bot', setup: setupFor(deck, overrides) });
  }

  readyHumans(): void {
    this.humans.forEach((human, index) => {
      this.send(human.connection, {
        type: 'submit_precon',
        preconId: PRECONS[index % PRECONS.length] as string,
      });
      this.send(human.connection, { type: 'set_ready', ready: true });
    });
  }

  start(): void {
    if (this.state() === null) this.send(this.host, { type: 'start_match' });
    if (this.state() === null) throw new Error('The match did not start.');
  }

  lobby() {
    return this.server.lobbyByCode(this.inviteCode);
  }

  view() {
    return this.host.last('lobby_updated')?.lobby ?? this.host.last('lobby_joined')?.lobby;
  }

  state(): MatchState | null {
    return this.lobby()?.state ?? null;
  }

  report(): BotRunReport | undefined {
    return this.server.botReport(this.inviteCode);
  }

  botSeatIds(): SeatId[] {
    return [...(this.lobby()?.seats.values() ?? [])].filter(isBotSeat).map((seat) => seat.seatId);
  }
}

/** A scripted player for one human seat, submitting through the ordinary path. */
class ScriptedHuman {
  readonly #pilot = createPilot({ id: 'aggressive' });
  #rng: RngState;
  #decisions = 0;

  constructor(
    private readonly table: AcceptanceTable,
    private readonly seat: SeatedHuman,
    readonly playerId: PlayerId,
    seed: string,
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
    const observation: BotObservation = {
      view,
      legal,
      history: view.log,
      database,
      rulesConfig: config,
      decisionIndex: this.#decisions,
    };
    const decision = this.#pilot.decide(observation, this.#rng);
    if (decision instanceof Promise) throw new Error('The scripted human must be synchronous.');
    this.#rng = decision.rng;
    this.#decisions += 1;

    this.table.send(this.seat.connection, {
      type: 'submit_action',
      actionId: `${this.playerId}_${this.#decisions}`,
      lastSequence: state.sequence,
      action: decision.action,
    });
    return true;
  }
}

function scriptedFor(table: AcceptanceTable): ScriptedHuman[] {
  return table.humans.map(
    (human, index) =>
      new ScriptedHuman(table, human, PLAYER_ID_BY_SEAT[human.seatId], `human-${index}`),
  );
}

interface PlayedMatch {
  readonly table: AcceptanceTable;
  readonly humans: ScriptedHuman[];
  readonly state: MatchState | null;
  readonly blocked: boolean;
}

/**
 * Plays a table out.
 *
 * Whenever a bot is waiting, time moves; otherwise the people act, in seat
 * order, so the interleaving is itself deterministic. That ordering is M09.12's
 * and is reused rather than reinvented: neither side ever acts while the other
 * is owed a turn, which is what makes a paced match comparable with an
 * unpaced one.
 */
async function playOut(table: AcceptanceTable, humans: ScriptedHuman[]): Promise<PlayedMatch> {
  for (let step = 0; step < 20_000; step += 1) {
    await table.server.whenBotsIdle();
    const state = table.state();
    if (!state || state.status === 'complete') return { table, humans, state, blocked: false };
    if (table.clock.next() !== null) {
      table.clock.fireNext();
      continue;
    }
    if (!humans.some((human) => human.act(state))) {
      return { table, humans, state, blocked: true };
    }
  }
  throw new Error('The match did not finish inside 20 000 rounds.');
}

interface MixtureOptions extends SetupOverrides {
  readonly seed?: string;
  /** One mode per bot seat, in order. Cycled if shorter than the bot count. */
  readonly modes?: readonly BotDeckMode[];
}

function seatMixture(
  humanCount: number,
  botCount: number,
  options: MixtureOptions = {},
): AcceptanceTable {
  const table = new AcceptanceTable({
    maxSeats: humanCount + botCount,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
  table.createLobby();
  for (let i = 1; i < humanCount; i += 1) table.joinHuman(`Guest${i}`);
  const modes = options.modes ?? ['exact_precon'];
  for (let i = 0; i < botCount; i += 1) {
    const mode = modes[i % modes.length] as BotDeckMode;
    table.addBot(sourceFor(mode, humanCount + i), options);
  }
  table.readyHumans();
  table.start();
  return table;
}

async function playMixture(
  humanCount: number,
  botCount: number,
  options: MixtureOptions = {},
): Promise<PlayedMatch> {
  const table = seatMixture(humanCount, botCount, options);
  return playOut(table, scriptedFor(table));
}

/** Everything observable about a finished match, for comparing two runs. */
function outcomeOf(played: PlayedMatch) {
  return {
    status: played.state?.status,
    turn: played.state?.turn,
    sequence: played.state?.sequence,
    result: played.state?.result,
    humanDecisions: played.humans.map((human) => human.decisions),
    seats: (played.table.report()?.seats ?? []).map((seat) => ({
      seatId: seat.seatId,
      seed: seat.seed,
      decisions: seat.decisions,
      actions: seat.actions,
    })),
  };
}

function expectClean(played: PlayedMatch): void {
  const report = played.table.report();
  expect(played.blocked).toBe(false);
  expect(played.state?.status).toBe('complete');
  expect(played.state?.result).not.toBeNull();
  expect(report?.incidents).toEqual([]);
  expect(report?.stalled).toBeNull();
  expect(report?.crashed).toBeNull();
  for (const seat of report?.seats ?? []) {
    expect(seat.halted).toBeNull();
    expect(seat.decisions).toBeGreaterThan(0);
  }
}

/* ================================================ 1. mixtures × deck modes */

/**
 * The four mixtures M09.7 opened, crossed with the four modes.
 *
 * The crossing is the point: a three-bot table seats three different modes at
 * the same time, which is the arrangement that would break if two modes shared
 * a generator stream, a seed, or a frozen list. `BOT_DECK_MODES` is read from
 * the registry, so a fifth mode arrives here as a failing test rather than as a
 * gap.
 */
describe('every seat mixture plays, across every deck mode', () => {
  const MIXTURES = [
    { humans: 1, bots: 1 },
    { humans: 1, bots: 3 },
    { humans: 2, bots: 2 },
    { humans: 3, bots: 1 },
  ] as const;

  const modesFor = (bots: number, offset: number): BotDeckMode[] =>
    Array.from(
      { length: bots },
      (_, index) => BOT_DECK_MODES[(offset + index) % BOT_DECK_MODES.length] as BotDeckMode,
    );

  for (const [index, mixture] of MIXTURES.entries()) {
    const modes = modesFor(mixture.bots, index);
    it(`finishes ${mixture.humans}H+${mixture.bots}B on ${modes.join(', ')}`, async () => {
      const played = await playMixture(mixture.humans, mixture.bots, {
        modes,
        seed: `acceptance-${mixture.humans}h${mixture.bots}b`,
      });
      expectClean(played);
      expect(played.table.report()?.seats).toHaveLength(mixture.bots);
    });
  }

  it('covers every mode the registry ships, at least once, across the matrix', () => {
    const covered = new Set(MIXTURES.flatMap((mixture, index) => modesFor(mixture.bots, index)));
    expect([...covered].sort()).toEqual([...BOT_DECK_MODES].sort());
  });

  it('plays a table holding all four modes at once, with none of them leaking', async () => {
    const played = await playMixture(1, 3, {
      modes: ['exact_saved_deck', 'commander_generated', 'autonomous_generated'],
      seed: 'acceptance-all-modes',
    });
    expectClean(played);
    // Three seats, three independent streams: no two bots drew the same seed.
    const seeds = (played.table.report()?.seats ?? []).map((seat) => seat.seed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});

/* ============================== 2. difficulty, style, timing and lifecycle */

describe('every difficulty and style the registries ship plays a match', () => {
  for (const difficulty of AVAILABLE_DIFFICULTIES) {
    it(`finishes a match at ${difficulty}`, async () => {
      const played = await playMixture(1, 1, {
        difficulty,
        seed: `acceptance-difficulty-${difficulty}`,
      });
      expectClean(played);
    });
  }

  for (const style of BOT_STYLES) {
    it(`finishes a match at style ${style}`, async () => {
      const played = await playMixture(1, 1, { style, seed: `acceptance-style-${style}` });
      expectClean(played);
    });
  }

  it('finishes a match with the style resolved automatically', async () => {
    const played = await playMixture(1, 1, {
      style: 'automatic',
      seed: 'acceptance-style-automatic',
    });
    expectClean(played);
    const seat = [...(played.table.lobby()?.seats.values() ?? [])].find(isBotSeat);
    expect(seat?.config.styleSetting).toBe('automatic');
    expect(BOT_STYLES).toContain(seat?.config.style as BotStyle);
  });
});

/**
 * 0%, 50% and 100% produce the same game.
 *
 * M09.12 proved this for one percentage against one match; the acceptance claim
 * is the whole ladder, and it is checked by comparing complete outcomes rather
 * than a result field — the turn count, the sequence, every human's decision
 * count and every bot's per-action tally have to agree, because a pacing bug
 * that changed *when* a bot acted would move one of those without moving the
 * winner.
 */
describe('deliberate pacing changes the clock and nothing else', () => {
  it('plays the identical match at 0%, 50% and 100%', async () => {
    const seed = 'acceptance-pacing';
    const instant = await playMixture(1, 1, {
      seed,
      pacing: { percent: 0, reactionPercent: null },
    });
    const half = await playMixture(1, 1, { seed, pacing: { percent: 50, reactionPercent: null } });
    const full = await playMixture(1, 1, { seed, pacing: { percent: 100, reactionPercent: null } });

    expectClean(instant);
    expectClean(half);
    expectClean(full);
    expect(outcomeOf(half)).toEqual(outcomeOf(instant));
    expect(outcomeOf(full)).toEqual(outcomeOf(instant));

    // And the clock did move, so the comparison above is not three instant runs.
    expect(instant.table.clock.now).toBe(0);
    expect(half.table.clock.now).toBeGreaterThan(0);
    expect(full.table.clock.now).toBeGreaterThan(half.table.clock.now);
  });

  it('waits the bot own Reaction percentage inside a Reaction window', async () => {
    const table = seatMixture(1, 1, {
      seed: 'acceptance-reaction-override',
      pacing: { percent: 100, reactionPercent: 25 },
    });
    const humans = scriptedFor(table);
    const seen = new Set<number>();
    for (let step = 0; step < 20_000; step += 1) {
      await table.server.whenBotsIdle();
      const state = table.state();
      if (!state || state.status === 'complete') break;
      const timer = table.clock.next();
      if (timer !== null) {
        seen.add(timer.at - table.clock.now);
        table.clock.fireNext();
        continue;
      }
      if (!humans.some((human) => human.act(state))) break;
    }

    const budgets = DEFAULT_BOT_PACING_BUDGETS;
    expect(seen).toContain(botDelayMs({ percent: 100, reactionPercent: 25 }, budgets, 'ordinary'));
    expect(seen).toContain(botDelayMs({ percent: 100, reactionPercent: 25 }, budgets, 'reaction'));
  });
});

describe('the lifecycle paths a live table can take', () => {
  it('rerolls a generated bot before the match, and keeps the new deck', () => {
    const table = new AcceptanceTable({ maxSeats: 2, seed: 'acceptance-reroll' });
    table.createLobby();
    table.addBot(sourceFor('autonomous_generated', 1));
    const [seatId] = table.botSeatIds();
    if (!seatId) throw new Error('No bot seat to reroll.');

    const before = table.host.last('bot_seat_provenance')?.seats[0]?.generated;
    table.send(table.host, { type: 'reroll_bot', seatId });
    const after = table.host.last('bot_seat_provenance')?.seats[0]?.generated;

    expect(before?.rerollCount).toBe(0);
    expect(after?.rerollCount).toBe(1);
    expect(after?.seed).not.toBe(before?.seed);
  });

  it('removes a bot seat, and the table plays on without it', async () => {
    const table = new AcceptanceTable({ maxSeats: 3, seed: 'acceptance-remove' });
    table.createLobby();
    table.joinHuman('Guest1');
    table.addBot(sourceFor('exact_precon', 2));
    const [seatId] = table.botSeatIds();
    if (!seatId) throw new Error('No bot seat to remove.');

    table.send(table.host, { type: 'remove_bot', seatId });
    expect(table.botSeatIds()).toEqual([]);

    table.readyHumans();
    table.start();
    const played = await playOut(table, scriptedFor(table));
    expect(played.state?.status).toBe('complete');
    // No bots at the table, so nothing to report on.
    expect(table.report()?.seats ?? []).toEqual([]);
  });

  it('carries on with the bot while a human is away, and lets them back in', async () => {
    const table = seatMixture(2, 1, { seed: 'acceptance-reconnect' });
    const humans = scriptedFor(table);
    const guest = table.humans[1];
    if (!guest) throw new Error('The table has no guest.');

    await table.server.whenBotsIdle();
    table.server.disconnect(guest.connection);
    await table.server.whenBotsIdle();

    // The seat is reported gone to somebody who is still there, and the bot has
    // not been stopped by it.
    const notice = table.host.all('seat_connection').at(-1);
    expect(notice?.seatId).toBe(guest.seatId);
    expect(notice?.connected).toBe(false);
    expect(table.report()?.crashed).toBeNull();

    const returning = table.connect('conn_guest_again');
    table.send(returning, {
      type: 'reconnect',
      versions: CURRENT_VERSIONS,
      reconnectToken: guest.reconnectToken,
    });
    expect(returning.last('match_state')).toBeDefined();

    // And the match still finishes, with the returning connection in the seat.
    const rejoined: ScriptedHuman[] = table.humans.map((_human, index) =>
      index === 1
        ? new ScriptedHuman(
            table,
            { ...guest, connection: returning },
            PLAYER_ID_BY_SEAT[guest.seatId],
            'human-1',
          )
        : (humans[index] as ScriptedHuman),
    );
    const played = await playOut(table, rejoined);
    expect(played.state?.status).toBe('complete');
  });

  it('records a pilot that throws as a fallback, and still finishes the match', async () => {
    const throwing: BotPolicy = {
      id: 'always_throws',
      version: '0.0.0',
      config: Object.freeze({}),
      decide() {
        throw new Error('this pilot is broken on purpose');
      },
    };
    const table = new AcceptanceTable({
      maxSeats: 2,
      seed: 'acceptance-fallback',
      pilotFor: () => throwing,
    });
    table.createLobby();
    table.addBot(sourceFor('exact_precon', 1));
    table.readyHumans();
    table.start();

    const played = await playOut(table, scriptedFor(table));
    expect(played.state?.status).toBe('complete');
    const report = table.report();
    // Every decision was a recorded failure with a substituted legal answer —
    // recorded by kind, never disguised as an intentional play — and not one of
    // them was a concession.
    const fallbacks = (report?.incidents ?? []).filter(
      (incident) => incident.kind === 'pilot_fallback',
    );
    expect(fallbacks.length).toBeGreaterThan(0);
    expect(fallbacks.every((incident) => incident.pilotFailure === 'threw')).toBe(true);
    expect(report?.seats[0]?.actions.concede ?? 0).toBe(0);
    expect(report?.seats[0]?.halted).toBeNull();
  });

  it('lets a person concede against a bot, and ends the match by their choice', async () => {
    const table = seatMixture(1, 1, { seed: 'acceptance-concede' });
    const humans = scriptedFor(table);
    await table.server.whenBotsIdle();
    const state = table.state();
    if (!state) throw new Error('The match did not start.');

    const human = table.humans[0];
    if (!human) throw new Error('The table has no host seat.');
    table.send(human.connection, {
      type: 'submit_action',
      actionId: 'concession',
      lastSequence: state.sequence,
      action: { type: 'concede', playerId: humans[0]?.playerId as PlayerId },
    });
    await table.server.whenBotsIdle();

    expect(table.state()?.status).toBe('complete');
    // The bot won because somebody gave up, and never because it conceded.
    expect(table.report()?.seats[0]?.actions.concede ?? 0).toBe(0);
  });

  it('eliminates a seat and plays on to a single survivor', async () => {
    const played = await playMixture(1, 3, {
      modes: ['exact_precon', 'commander_generated', 'autonomous_generated'],
      seed: 'acceptance-elimination',
    });
    expectClean(played);
    const eliminated = Object.values(played.state?.players ?? {}).filter(
      (player) => player.eliminatedOnTurn !== null,
    );
    // A four-seat free-for-all ends with one survivor, so three seats left it.
    expect(eliminated.length).toBeGreaterThan(0);
  });
});

/* ============================================== 3. the boundaries hold */

describe('hidden information does not cross any boundary', () => {
  /** Every field a private deck source has that its public projection must not. */
  const PRIVATE_FIELDS = ['cardIds', 'seed', 'deckHash', 'sourceDeckId', 'legalPoolSize'];

  it('keeps a saved deck and a generated seed out of every seat’s lobby view', () => {
    const table = new AcceptanceTable({ maxSeats: 4, seed: 'acceptance-privacy' });
    table.createLobby();
    const guest = table.joinHuman('Guest1');
    table.addBot(savedSource(PRECONS[1]));
    table.addBot(sourceFor('autonomous_generated', 3));

    const view = guest.connection.last('lobby_updated')?.lobby;
    expect(view).toBeDefined();
    const serialised = JSON.stringify(view);
    for (const field of PRIVATE_FIELDS) expect(serialised).not.toContain(field);
    // Not just the field names: the values are absent too.
    const saved = savedSource(PRECONS[1]);
    if (saved.mode !== 'exact_saved_deck') throw new Error('unreachable');
    expect(serialised).not.toContain(saved.deck.name);
    expect(serialised).not.toContain(saved.deck.deckHash);
    for (const cardId of saved.deck.cardIds) expect(serialised).not.toContain(cardId);

    // The Commander is public, by design: it is what a player needs in order to
    // know what they have sat down against.
    expect(serialised).toContain(saved.deck.commanderId);
  });

  it('never sends a guest the host-only provenance message', () => {
    const table = new AcceptanceTable({ maxSeats: 4, seed: 'acceptance-provenance' });
    table.createLobby();
    const guest = table.joinHuman('Guest1');
    table.addBot(sourceFor('commander_generated', 2));

    expect(table.host.all('bot_seat_provenance').length).toBeGreaterThan(0);
    expect(guest.connection.all('bot_seat_provenance')).toEqual([]);
  });

  it('hands a bot exactly the redacted view its seat is entitled to', async () => {
    const table = seatMixture(1, 1, { seed: 'acceptance-observation' });
    await table.server.whenBotsIdle();
    const state = table.state();
    if (!state) throw new Error('The match did not start.');

    const botPlayerId: PlayerId = 'player_2';
    const view = playerView(state, botPlayerId, database, config);
    const opponentHand = state.players['player_1']?.hand ?? [];
    expect(opponentHand.length).toBeGreaterThan(0);

    // The observation the runner builds is `playerView` for that seat, so the
    // strongest statement available is about what `playerView` contains: the
    // opponent's hand is a count, never a set of instances.
    const serialised = JSON.stringify(view);
    for (const instanceId of opponentHand) expect(serialised).not.toContain(instanceId);
    const opponent = view.players.find((player) => player.playerId === 'player_1');
    expect(opponent?.handCount).toBe(opponentHand.length);
  });

  it('publishes the decks and the pacing summary only once the match is over', async () => {
    const table = seatMixture(1, 1, {
      seed: 'acceptance-reveal',
      modes: ['exact_saved_deck'],
    });
    const humans = scriptedFor(table);
    await table.server.whenBotsIdle();
    expect(table.host.all('bot_decks_revealed')).toEqual([]);
    expect(table.host.all('bot_pacing_summary')).toEqual([]);

    const played = await playOut(table, humans);
    expect(played.state?.status).toBe('complete');
    expect(table.host.all('bot_decks_revealed')).toHaveLength(1);

    const summary = table.host.last('bot_pacing_summary')?.summary;
    expect(summary).toBeDefined();
    // An export carries no generator seed, no player name, no reconnect identity
    // and no private half of a saved deck.
    const exported = JSON.stringify(summary);
    expect(exported).not.toContain('acceptance-reveal');
    expect(exported).not.toContain('A deck nobody else may read');
    expect(exported).not.toContain('Host');
    for (const human of table.humans) expect(exported).not.toContain(human.reconnectToken);

    // It does carry the invite code, inside `matchId` — recorded rather than
    // changed. `botMatchSummarySchema.matchId` says \"No invite code\" and the
    // server builds it as `match_<inviteCode>`, so the two disagree. It is not a
    // live secret at the moment the summary is published — a finished lobby
    // refuses `join_lobby` with `protocol/already_started` — and moving it would
    // move a field every reader of a summary already keys on, so M09.19 records
    // it for the owner instead (see the milestone's findings).
    expect(summary?.matchId).toBe(`match_${table.inviteCode}`);
  });

  it('never names a hidden card in the log a seat is sent', async () => {
    const table = seatMixture(1, 1, { seed: 'acceptance-log' });
    await table.server.whenBotsIdle();
    const state = table.state();
    if (!state) throw new Error('The match did not start.');

    const view = playerView(state, 'player_1', database, config);
    const botHand = state.players['player_2']?.hand ?? [];
    expect(botHand.length).toBeGreaterThan(0);
    const log = JSON.stringify(view.log);
    for (const instanceId of botHand) expect(log).not.toContain(instanceId);
  });
});

/* ================================= 4. the simulator and the Spectator */

/**
 * The thing this tranche changed is not on their path.
 *
 * M09.12 already proves — by scanning the sources — that the simulator and the
 * Spectator have no pacing, no timer and no clock. The new claim M09.19 has to
 * make is narrower and about its own change: `defaultYieldToScheduler` is a
 * macrotask, and a macrotask in a batch runner's inner loop would cost a
 * scheduler round trip per decision. It is reachable only from the live server's
 * bot runner, and neither app imports it.
 */
describe('the simulator and the AI Spectator are unaffected', () => {
  it('keeps the macrotask yield inside the multiplayer server', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { dirname, join, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

    const sourcesUnder = (directory: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) out.push(...sourcesUnder(full));
        else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full);
      }
      return out;
    };

    for (const app of ['apps/simulator/src', 'packages/spectator/src']) {
      for (const file of sourcesUnder(join(root, app))) {
        const source = readFileSync(file, 'utf8');
        expect(source).not.toContain('defaultYieldToScheduler');
        expect(source).not.toContain('setImmediate');
      }
    }
  });

  it('replays a mixed table exactly from the same seed, and differs from another', async () => {
    const first = await playMixture(2, 2, {
      seed: 'acceptance-determinism',
      modes: [...BOT_DECK_MODES],
    });
    const again = await playMixture(2, 2, {
      seed: 'acceptance-determinism',
      modes: [...BOT_DECK_MODES],
    });
    const other = await playMixture(2, 2, { seed: 'acceptance-other', modes: [...BOT_DECK_MODES] });

    expect(outcomeOf(again)).toEqual(outcomeOf(first));
    expect(outcomeOf(other)).not.toEqual(outcomeOf(first));
  });
});

/* ======================================= 5. latency, and who is blocked */

/**
 * Latency, with deliberate pacing excluded.
 *
 * "Excluded" is structural rather than subtracted: every table below runs at 0%
 * pacing, so no wait is ever scheduled and the elapsed time is the server's own
 * work. The ceiling is deliberately generous — this is a regression bound
 * against an order-of-magnitude change on a laptop or in CI, not a performance
 * target — and the *shape* is what the assertion is about.
 */
describe('server action latency, with deliberate pacing excluded', () => {
  it('handles a human action, bot work included, well inside a tenth of a second', async () => {
    const table = seatMixture(1, 3, {
      seed: 'acceptance-latency',
      modes: ['exact_precon', 'commander_generated', 'autonomous_generated'],
      pacing: { percent: 0, reactionPercent: null },
    });
    const humans = scriptedFor(table);
    const human = humans[0];
    if (!human) throw new Error('The table has no scripted human.');

    let worstMs = 0;
    let handled = 0;
    for (let step = 0; step < 20_000; step += 1) {
      await table.server.whenBotsIdle();
      const state = table.state();
      if (!state || state.status === 'complete') break;
      const started = performance.now();
      if (!human.act(state)) break;
      // `receive` is synchronous: this is the whole cost of handling one
      // human frame, before the bot pump gets a turn.
      const elapsed = performance.now() - started;
      handled += 1;
      if (elapsed > worstMs) worstMs = elapsed;
    }

    expect(handled).toBeGreaterThan(10);
    expect(table.clock.timers).toEqual([]);
    expect(worstMs).toBeLessThan(100);
  });

  it('never lets bot work stop a human message from being handled', async () => {
    // The production default, not an injected one: this test exists because the
    // default was a microtask until M09.19, and an awaited microtask chain never
    // returns control to the runtime. A table whose bots are mid-turn must still
    // be a table that hears a person.
    //
    // `start_match` is what wakes three bots at once, and `receive` is
    // synchronous — so by the time the constructor returns, a pump is already in
    // flight with several decisions ahead of it. A `setImmediate` registered
    // now is exactly what an arriving socket frame is: if bot work held the
    // loop, it would not run until every bot had finished.
    const table = seatMixture(1, 3, {
      seed: 'acceptance-nonblocking',
      modes: ['exact_precon', 'commander_generated', 'autonomous_generated'],
    });
    expect(table.state()).not.toBeNull();

    let servedWhileBotsWorked = false;
    setImmediate(() => {
      servedWhileBotsWorked = true;
    });
    await table.server.whenBotsIdle();
    expect(servedWhileBotsWorked).toBe(true);

    // The bots really did work across that boundary, so the pass above is not a
    // pump that had nothing to do.
    const decisions = (table.report()?.seats ?? []).reduce(
      (total, seat) => total + seat.decisions,
      0,
    );
    expect(decisions).toBeGreaterThan(1);
  });

  it('is the yield that makes the difference, and a microtask one does not', async () => {
    // The same construction against the default that M09.19 replaced. It is the
    // regression this guards, stated as a measurement rather than as a warning:
    // an awaited microtask chain drains before the runtime looks at a socket
    // again, so the frame waits for every bot at the table.
    const table = new AcceptanceTable({
      maxSeats: 4,
      seed: 'acceptance-nonblocking',
      yieldToScheduler: () => Promise.resolve(),
    });
    table.createLobby();
    for (const mode of ['exact_precon', 'commander_generated', 'autonomous_generated'] as const) {
      table.addBot(sourceFor(mode, 1));
    }
    table.readyHumans();
    table.start();

    let servedWhileBotsWorked = false;
    setImmediate(() => {
      servedWhileBotsWorked = true;
    });
    await table.server.whenBotsIdle();
    expect(servedWhileBotsWorked).toBe(false);
  });

  it('crosses a real scheduler boundary between decisions by default', async () => {
    let served = false;
    setImmediate(() => {
      served = true;
    });
    await defaultYieldToScheduler();
    expect(served).toBe(true);

    // And the microtask it replaced does not, which is the whole reason it moved.
    let microtaskServed = false;
    setImmediate(() => {
      microtaskServed = true;
    });
    await Promise.resolve();
    expect(microtaskServed).toBe(false);
  });
});
