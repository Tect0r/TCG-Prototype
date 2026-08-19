import { describe, expect, it } from 'vitest';
import {
  BOT_CONFIG_SCHEMA_VERSION,
  DEFAULT_BOT_DIFFICULTY,
  DIFFICULTY_REGISTRY_VERSION,
  IMMEDIATE_BOT_PACING,
  type BotSeatConfig,
  type BotStyle,
} from '@tcg/bot-config';
import { createPilot, type BotObservation } from '@tcg/bot-interface';
import { loadFormatCardData, resolveFormatId } from '@tcg/card-data';
import { deckFormatOf } from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  encode,
  type ClientMessageInput,
  type SeatId,
  type ServerMessage,
} from '@tcg/protocol';
import {
  createRngState,
  DEFAULT_RULES_CONFIG,
  legalActions,
  playerView,
  type MatchState,
  type PlayerId,
  type RngState,
} from '@tcg/rules-engine';
import { BotRunner, hasBotDecision, type BotRunReport } from './bot-runner.js';
import { MAX_BOT_SEATS, PLAYER_ID_BY_SEAT, freeBotSeats, isBotSeat } from './lobby.js';
import { MatchServer, type ServerConnection } from './match-server.js';

/**
 * Mixed human/bot tables (M09.7).
 *
 * Five claims, and all five are checked by playing real matches through
 * `receive` rather than against a fixture: every two-to-four-seat mixture with at
 * least one human finishes; several eligible bots are asked without duplicating a
 * decision; elimination, Reaction priority, disconnect, reconnect and
 * last-living-player behaviour are what they were; a bot never becomes host; and
 * the number of scheduler callbacks provably does not change the outcome.
 *
 * **What "concurrent" means here, precisely.** The runner interleaves bot seats
 * rather than running them in parallel: one pump asks the first bot the engine is
 * offering a move, submits, and comes back round. That is what makes duplication
 * structurally impossible — there is never a second decision in flight to
 * duplicate — and it is why the tests below assert *one committed decision per
 * opportunity in seat order* rather than asserting overlap. Actual concurrent
 * waiting is M09.12's, because until a bot waits there is nothing to overlap.
 *
 * **What order independence is promised for.** The scheduler callbacks the runner
 * controls: how many times it yields, and how many times it is woken. It is
 * emphatically *not* promised for the interleaving of genuine game actions — a
 * human acting before or after a bot is a different game, and that is the
 * engine's business rather than the runner's.
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

function botSetup(preconId: string, style: BotStyle = 'value') {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style,
    deck: { mode: 'exact_precon' as const, preconId },
    pacing: IMMEDIATE_BOT_PACING,
    displayName: null,
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

interface MixedOptions {
  readonly seed?: string;
  readonly maxSeats?: number;
  /** Extra microtask turns per stack-safety yield, for the order-independence test. */
  readonly yieldTicks?: number;
  /** Called after every committed bot decision, with the board it produced. */
  readonly onYield?: (state: MatchState | null) => void;
}

interface SeatedHuman {
  readonly connection: FakeConnection;
  readonly seatId: SeatId;
  readonly reconnectToken: string;
}

/** A lobby that can hold any mixture of people and bots. */
class MixedTable {
  readonly server: MatchServer;
  readonly humans: SeatedHuman[] = [];
  /** Pending timer callbacks, so a disconnect window can be fired on demand. */
  readonly timers: { seatHint: string; fire: () => void }[] = [];
  inviteCode = '';

  constructor(private readonly options: MixedOptions = {}) {
    let counter = 0;
    const ticks = options.yieldTicks ?? 0;
    this.server = new MatchServer({
      database,
      deckFormat,
      random: () => {
        counter += 1;
        return ((counter * 2654435761) % 4294967296) / 4294967296;
      },
      schedule: (_delayMs, callback) => {
        const entry = { seatHint: `timer_${this.timers.length}`, fire: callback };
        this.timers.push(entry);
        return () => {
          const index = this.timers.indexOf(entry);
          if (index >= 0) this.timers.splice(index, 1);
        };
      },
      seedFor: () => options.seed ?? 'mixed-seed',
      now: () => 1_000_000,
      yieldToScheduler: async () => {
        options.onYield?.(this.state());
        for (let i = 0; i < ticks; i += 1) await Promise.resolve();
      },
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

  addBot(preconId: string, style: BotStyle = 'value'): void {
    this.send(this.host, { type: 'add_bot', setup: botSetup(preconId, style) });
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
    this.send(this.host, { type: 'start_match' });
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
    private readonly table: MixedTable,
    private readonly seat: SeatedHuman,
    readonly playerId: PlayerId,
    seed: string,
  ) {
    this.#rng = createRngState(seed);
  }

  get decisions(): number {
    return this.#decisions;
  }

  /** One move if the engine is offering this seat one. Says whether it acted. */
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

interface PlayedMatch {
  readonly table: MixedTable;
  readonly humans: ScriptedHuman[];
  readonly state: MatchState | null;
  readonly blocked: boolean;
}

async function playOut(table: MixedTable, humans: ScriptedHuman[]): Promise<PlayedMatch> {
  for (let step = 0; step < 8000; step += 1) {
    await table.server.whenBotsIdle();
    const state = table.state();
    if (!state || state.status === 'complete') return { table, humans, state, blocked: false };
    // In seat order, so the interleaving of human moves is itself deterministic.
    const acted = humans.some((human) => human.act(state));
    if (!acted) return { table, humans, state, blocked: true };
  }
  throw new Error('The match did not finish inside 8000 rounds.');
}

/** Plays until `done` is true of the board, or the match cannot move any further. */
async function playRounds(
  table: MixedTable,
  humans: ScriptedHuman[],
  done: (state: MatchState) => boolean,
): Promise<MatchState | null> {
  for (let step = 0; step < 8000; step += 1) {
    await table.server.whenBotsIdle();
    const state = table.state();
    if (!state || state.status === 'complete' || done(state)) return state;
    if (!humans.some((human) => human.act(state))) return state;
  }
  throw new Error('The board never reached the state the test was waiting for.');
}

/** Builds a table with the requested mixture, seated and started but not played. */
function seatMixed(humanCount: number, botCount: number, options: MixedOptions = {}): MixedTable {
  const table = new MixedTable({ maxSeats: humanCount + botCount, ...options });
  table.createLobby();
  for (let i = 1; i < humanCount; i += 1) table.joinHuman(`Guest${i}`);
  for (let i = 0; i < botCount; i += 1) {
    table.addBot(PRECONS[(humanCount + i) % PRECONS.length] as string);
  }
  table.readyHumans();
  // A two-seat table starts itself on the last `set_ready`; a larger one needs
  // the host to press start.
  if (table.state() === null) table.start();
  return table;
}

function scriptedFor(table: MixedTable): ScriptedHuman[] {
  return table.humans.map(
    (human, index) =>
      new ScriptedHuman(table, human, PLAYER_ID_BY_SEAT[human.seatId], `human-${index}`),
  );
}

async function playMixed(
  humanCount: number,
  botCount: number,
  options: MixedOptions = {},
): Promise<PlayedMatch> {
  const table = seatMixed(humanCount, botCount, options);
  return playOut(table, scriptedFor(table));
}

/** A four-seat board, for the runner-level tests that need a real state. */
function fourSeatState(): MatchState {
  const table = seatMixed(1, 3, { seed: 'runner-fixture' });
  const state = table.state();
  if (!state) throw new Error('The four-seat match did not start.');
  return state;
}

function botConfigFor(botId: string, style: BotStyle = 'value'): BotSeatConfig {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    controller: { botId, displayName: botId },
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style,
    deck: { mode: 'exact_precon', preconId: PRECONS[0] },
    pacing: IMMEDIATE_BOT_PACING,
  };
}

/* ------------------------------------------------- every legal mixture plays */

describe('every two-to-four-seat mixture with at least one human plays', () => {
  it('finishes a table of one human and three bots', async () => {
    const { table, state, blocked } = await playMixed(1, 3);

    expect(blocked).toBe(false);
    expect(state?.status).toBe('complete');
    expect(state?.result).not.toBeNull();
    expect(table.botSeatIds()).toEqual(['seat_2', 'seat_3', 'seat_4']);

    const report = table.report();
    expect(report?.seats).toHaveLength(3);
    expect(report?.incidents).toEqual([]);
    expect(report?.stalled).toBeNull();
    expect(report?.crashed).toBeNull();
    // Every bot played; none of them sat the match out because another one was
    // always chosen first.
    for (const seat of report?.seats ?? []) {
      expect(seat.decisions).toBeGreaterThan(0);
      expect(seat.halted).toBeNull();
    }
  });

  it('finishes a table of two humans and two bots', async () => {
    const { table, state, blocked } = await playMixed(2, 2);

    expect(blocked).toBe(false);
    expect(state?.status).toBe('complete');
    expect(table.botSeatIds()).toEqual(['seat_3', 'seat_4']);
    expect(table.report()?.seats).toHaveLength(2);
    expect(table.report()?.incidents).toEqual([]);
  });

  it('finishes a table of three humans and one bot', async () => {
    const { table, state, blocked } = await playMixed(3, 1);

    expect(blocked).toBe(false);
    expect(state?.status).toBe('complete');
    expect(table.botSeatIds()).toEqual(['seat_4']);
    expect(table.report()?.seats).toHaveLength(1);
    expect(table.report()?.incidents).toEqual([]);
  });

  it('seats two bots on the same precon as two independent players', async () => {
    const table = new MixedTable({ maxSeats: 3, seed: 'duplicate-precons' });
    table.createLobby();
    table.addBot(PRECONS[2]);
    table.addBot(PRECONS[2]);
    table.readyHumans();
    table.start();

    const seats = [...(table.lobby()?.seats.values() ?? [])].filter(isBotSeat);
    expect(seats).toHaveLength(2);
    // The same shipped list in both seats, materialised separately, and two
    // different bot identities holding it.
    expect(seats.map((seat) => seat.deck?.commanderId)).toEqual([
      seats[0]?.deck?.commanderId,
      seats[0]?.deck?.commanderId,
    ]);
    expect(seats.every((seat) => seat.deckLegal)).toBe(true);
    expect(new Set(seats.map((seat) => seat.config.controller.botId)).size).toBe(2);

    const { state, blocked } = await playOut(table, scriptedFor(table));
    expect(blocked).toBe(false);
    expect(state?.status).toBe('complete');

    const report = table.report();
    // One stream per seat, derived from the seat rather than from the deck, so
    // two identical decks are still two different players.
    expect(report?.seats[0]?.seed).not.toBe(report?.seats[1]?.seed);
    expect(report?.incidents).toEqual([]);
  });
});

/* ------------------------------------ several eligible bots, no duplication */

describe('several eligible bots are asked without duplicating a decision', () => {
  it('answers three simultaneous independent mulligans, one decision each', async () => {
    const table = seatMixed(1, 3, { seed: 'simultaneous-mulligans' });
    // Every seat has a pending mulligan the moment the match starts: three bots
    // are eligible at the same time, and their choices do not depend on each
    // other. This is the concurrency case the milestone names.
    await table.server.whenBotsIdle();

    const lobby = table.lobby();
    for (const seatId of table.botSeatIds()) {
      const seat = lobby?.seats.get(seatId);
      expect(seat?.appliedActions.size).toBeGreaterThan(0);
    }
    for (const seat of table.report()?.seats ?? []) {
      expect(seat.actions.mulligan).toBe(1);
    }
    // The human has answered nothing: a bot's mulligan does not wait on a
    // person's, and nothing decided one on their behalf.
    expect(lobby?.seats.get('seat_1')?.appliedActions.size).toBe(0);
  });

  it('gives every committed decision a distinct identity, per seat and across seats', async () => {
    const { table } = await playMixed(1, 3, { seed: 'identities' });

    const lobby = table.lobby();
    const all: string[] = [];
    for (const seat of table.report()?.seats ?? []) {
      const identities = [...(lobby?.seats.get(seat.seatId)?.appliedActions.keys() ?? [])];
      // Monotonic from zero, one per committed decision, and prefixed with this
      // seat's own bot identity — so two bots cannot collide even at the same
      // decision index.
      expect(identities).toEqual(
        Array.from({ length: seat.decisions }, (_unused, index) => `${seat.botId}#${index}`),
      );
      all.push(...identities);
    }
    expect(new Set(all).size).toBe(all.length);
  });

  it('takes one decision per opportunity however often it is woken', async () => {
    const state = fourSeatState();
    const submitted: string[] = [];
    const runner = new BotRunner({
      matchSeed: 'wake-storm',
      database,
      config,
      seats: (['seat_2', 'seat_3', 'seat_4'] as const).map((seatId, index) => ({
        seatId,
        playerId: PLAYER_ID_BY_SEAT[seatId],
        config: botConfigFor(`bot_${index + 1}`),
      })),
      state: () => state,
      submit: (_seatId, actionId) => {
        submitted.push(actionId);
        // Every broadcast could wake the runner, and a mixed table has more of
        // them. Re-entering must be a no-op, not a second pump per bot.
        runner.wake();
        runner.wake();
        return { ok: true };
      },
      decisionLimit: 4,
    });

    runner.wake();
    runner.wake();
    runner.wake();
    await runner.pending;

    // The board never moves, so each seat is offered the same opportunity until
    // its ceiling stops it. What matters is that no identity repeats and no seat
    // gets a second concurrent pump.
    expect(new Set(submitted).size).toBe(submitted.length);
    expect(submitted.filter((id) => id.startsWith('bot_1#'))).toHaveLength(4);
    expect(submitted.filter((id) => id.startsWith('bot_2#'))).toHaveLength(4);
    expect(submitted.filter((id) => id.startsWith('bot_3#'))).toHaveLength(4);
    // Seat order, exhaustively: the first eligible seat is asked until it stops
    // being eligible, which on a frozen board is when it hits the ceiling.
    expect(submitted.slice(0, 4).every((id) => id.startsWith('bot_1#'))).toBe(true);
    expect(submitted.slice(8).every((id) => id.startsWith('bot_3#'))).toBe(true);
  });
});

/* ----------------------------------- elimination, priority and last player */

describe('elimination, Reaction priority and the last living player', () => {
  it('offers an open Reaction window to exactly one seat at a time', async () => {
    const windows: string[] = [];
    const offers: number[] = [];
    const observe = (state: MatchState | null): void => {
      if (!state || state.reactionWindow === null || state.reactionWindow.closed) return;
      windows.push(state.reactionWindow.id);
      offers.push(
        state.seatOrder.filter(
          (playerId) => legalActions(state, playerId, { database, config }).reaction !== null,
        ).length,
      );
    };

    const { table, state } = await playMixed(1, 3, {
      seed: 'reaction-priority',
      onYield: observe,
    });
    expect(state?.status).toBe('complete');

    // Windows really opened at this table, so the assertion below is not passing
    // by looking at nothing.
    expect(windows.length).toBeGreaterThan(0);
    // Priority is the engine's: it offers the window to the seat whose turn it is
    // to answer and to nobody else, so the runner's seat-order scan cannot
    // reorder a Reaction window however many bots are eligible elsewhere.
    expect(offers.every((count) => count === 1)).toBe(true);

    const reacted = (table.report()?.seats ?? []).reduce(
      (total, seat) =>
        total + (seat.actions.play_reaction ?? 0) + (seat.actions.pass_reaction ?? 0),
      0,
    );
    expect(reacted).toBeGreaterThan(0);
  });

  it('stops asking an eliminated bot and plays on to a single survivor', async () => {
    const table = seatMixed(1, 3, { seed: 'elimination' });
    const humans = scriptedFor(table);

    // Played into the match proper first, because a concession *during* the
    // mulligan phase deadlocks the board — a pre-existing engine behaviour the
    // next test pins down and the milestone records rather than fixes here.
    await playRounds(table, humans, (state) => state.status !== 'mulligan' && state.turn >= 3);

    // The human then concedes: three bots are left in a free-for-all, and the
    // match must resolve between them rather than stalling on the seat that left.
    table.send(table.humans[0]!.connection, {
      type: 'submit_action',
      actionId: 'human_concede',
      lastSequence: table.state()?.sequence ?? 0,
      action: { type: 'concede', playerId: 'player_1' },
    });

    const { state } = await playOut(table, humans);
    expect(state?.status).toBe('complete');
    expect(state?.players.player_1?.lost).toBe(true);

    const survivors = state?.seatOrder.filter((playerId) => !state.players[playerId]?.lost) ?? [];
    expect(survivors).toHaveLength(1);

    // Every eliminated bot stopped being asked, and did so without an incident:
    // "this seat is out" is ordinary, not a failure.
    const report = table.report();
    expect(report?.incidents).toEqual([]);
    expect(report?.stalled).toBeNull();
    const winner = survivors[0];
    for (const seat of report?.seats ?? []) {
      expect(seat.halted).toBeNull();
      if (seat.playerId !== winner) expect(state?.players[seat.playerId]?.lost).toBe(true);
    }
  });

  /**
   * The finding this tranche records rather than fixes.
   *
   * `handleMulligan` advances only when **every** player in `playerOrder` has
   * submitted one, and `legalActions` returns nothing at all for an eliminated
   * seat — so a player who concedes or times out *during* the mulligan phase
   * leaves a mulligan nobody can ever answer. It is an engine behaviour on a
   * human-only path (two people, one of them closing the tab) and it predates
   * every bot; changing it is a rules decision, not a runner change.
   *
   * What M09.7 owes is that the runner meets it honestly: it records a stalled
   * board and never lets a bot concede to unstick one.
   */
  it('records a mulligan-phase concession as a stalled board, and concedes nothing', async () => {
    const table = seatMixed(1, 3, { seed: 'mulligan-concession' });
    table.send(table.humans[0]!.connection, {
      type: 'submit_action',
      actionId: 'human_concede',
      lastSequence: table.state()?.sequence ?? 0,
      action: { type: 'concede', playerId: 'player_1' },
    });

    const { state, blocked } = await playOut(table, scriptedFor(table));

    expect(blocked).toBe(true);
    expect(state?.status).toBe('mulligan');
    expect(state?.players.player_1?.mulligan.status).toBe('pending');

    const report = table.report();
    expect(report?.stalled).toContain('no seat has a legal action');
    expect(report?.crashed).toBeNull();
    for (const seat of report?.seats ?? []) {
      expect(Object.keys(seat.actions)).not.toContain('concede');
      // Every bot answered its own mulligan and then simply had nothing to do.
      expect(seat.actions.mulligan).toBe(1);
      expect(seat.halted).toBeNull();
    }
  });

  it('never lets a bot concede its way out of a mixed table', async () => {
    const { table, state } = await playMixed(2, 2, { seed: 'no-concessions' });
    expect(state?.status).toBe('complete');
    for (const seat of table.report()?.seats ?? []) {
      expect(Object.keys(seat.actions)).not.toContain('concede');
      expect(Object.keys(seat.actions)).not.toContain('server_timeout');
    }
  });
});

/* --------------------------------------------- disconnect, reconnect, host */

describe('human disconnect and reconnect at a mixed table', () => {
  it('opens a window only for the seat that lost a connection, and lets it back in', async () => {
    const table = seatMixed(2, 2, { seed: 'reconnect' });
    await table.server.whenBotsIdle();

    const guest = table.humans[1]!;
    table.server.disconnect(guest.connection);

    // One window, for one seat: a bot has no connection to lose, so a mixed
    // table opens exactly as many disconnect timers as it has dropped people.
    expect(table.timers).toHaveLength(1);
    const lobby = table.lobby();
    for (const seatId of table.botSeatIds()) {
      const seat = lobby?.seats.get(seatId);
      expect(seat && isBotSeat(seat) && 'disconnectDeadline' in seat).toBe(false);
    }

    const resumed = table.connect('conn_guest_again');
    table.send(resumed, {
      type: 'reconnect',
      versions: CURRENT_VERSIONS,
      reconnectToken: guest.reconnectToken,
    });

    // The seat is reclaimed, the window is cancelled, and the returning player is
    // sent the current board rather than a restarted match.
    expect(table.timers).toHaveLength(0);
    expect(resumed.last('lobby_joined')?.seatId).toBe(guest.seatId);
    expect(resumed.last('match_state')).toBeDefined();
    expect(table.state()?.status).not.toBe('complete');
    expect(table.report()?.incidents).toEqual([]);
  });

  it('carries on with the bots while a human is away, and times that human out', async () => {
    const table = seatMixed(1, 3, { seed: 'timeout' });
    const humans = scriptedFor(table);
    // Past the mulligan phase before dropping, for the reason the elimination
    // test above gives: a seat lost during it can never submit the mulligan the
    // engine is still waiting for.
    await playRounds(table, humans, (state) => state.status !== 'mulligan' && state.turn >= 3);
    const before = table.state()?.sequence ?? 0;

    table.server.disconnect(table.host);
    expect(table.timers).toHaveLength(1);
    table.timers[0]!.fire();
    const { state } = await playOut(table, []);

    // The timeout is the server's, submitted for the *human* seat; the bots then
    // carry on from the board it produced and finish the match between them.
    expect(state?.players.player_1?.lost).toBe(true);
    expect(state?.sequence).toBeGreaterThan(before);
    expect(state?.status).toBe('complete');
    const report = table.report();
    for (const seat of report?.seats ?? []) {
      expect(Object.keys(seat.actions)).not.toContain('server_timeout');
    }
    expect(report?.crashed).toBeNull();
    expect(report?.stalled).toBeNull();
  });
});

describe('a bot never becomes host', () => {
  it('keeps the host seat with the person who created the lobby', () => {
    const table = seatMixed(2, 2, { seed: 'host' });
    const lobby = table.lobby();

    expect(lobby?.hostSeatId).toBe('seat_1');
    expect(lobby?.seats.get('seat_1')?.controller).toBe('human');
    for (const seatId of table.botSeatIds()) {
      expect(lobby?.seats.get(seatId)?.controller).toBe('bot');
    }
    // The seat view says the same thing to every client.
    const view = table.view();
    expect(view?.seats.filter((seat) => seat.isHost).map((seat) => seat.controller)).toEqual([
      'human',
    ]);
  });

  it('does not hand the seat to a bot when the host drops but others remain', () => {
    const table = new MixedTable({ maxSeats: 4, seed: 'host-drops' });
    table.createLobby();
    table.joinHuman('Guest1');
    table.addBot(PRECONS[1]);
    table.addBot(PRECONS[2]);

    table.server.disconnect(table.host);

    // The current human rule is that there is no host migration at all. M09.7
    // changes nothing about it; what it adds is that the seat cannot drift to a
    // bot either, and that the lobby survives because a person is still in it.
    const lobby = table.lobby();
    expect(lobby).toBeDefined();
    expect(lobby?.hostSeatId).toBe('seat_1');
    expect(lobby?.seats.get('seat_1')?.controller).toBe('human');
    expect(freeBotSeats(lobby!)).not.toContain('seat_1');
  });

  it('closes a mixed lobby whose last human leaves, and drops its bots with it', async () => {
    const table = seatMixed(1, 3, { seed: 'abandoned' });
    await table.server.whenBotsIdle();
    // Finishing first, because a live match keeps its lobby: a disconnected
    // player has a window to come back to it.
    const { state } = await playOut(table, scriptedFor(table));
    expect(state?.status).toBe('complete');

    table.server.disconnect(table.host);
    await table.server.whenBotsIdle();

    expect(table.lobby()).toBeUndefined();
    expect(table.report()).toBeUndefined();
  });
});

/* -------------------------------------------- at least one human, at most three bots */

describe('at least one human, at most three bots', () => {
  it('never offers the host seat to a bot, and stops at the ceiling', () => {
    const table = new MixedTable({ maxSeats: 4, seed: 'ceiling' });
    table.createLobby();
    table.addBot(PRECONS[1]);
    table.addBot(PRECONS[2]);
    table.addBot(PRECONS[3]);

    const lobby = table.lobby()!;
    expect(table.botSeatIds()).toHaveLength(MAX_BOT_SEATS);
    expect(freeBotSeats(lobby)).toEqual([]);

    table.addBot(PRECONS[0]);
    expect(table.host.last('error')?.error.code).toBe('protocol/lobby_full');
    expect(table.botSeatIds()).toHaveLength(MAX_BOT_SEATS);
    // The one seat a bot can never take is the one the lobby takes its host
    // from, which is what "at least one human" is made of.
    expect(lobby.seats.get('seat_1')?.controller).toBe('human');
  });

  it('lets a person take a free seat rather than a bot filling the table first', () => {
    const table = new MixedTable({ maxSeats: 4, seed: 'human-first' });
    table.createLobby();
    table.addBot(PRECONS[1]);
    const guest = table.joinHuman('Guest1');

    // The bot took seat 2, so the joining human takes seat 3 — nobody is evicted
    // and nothing is silently replaced.
    expect(table.botSeatIds()).toEqual(['seat_2']);
    expect(guest.seatId).toBe('seat_3');

    table.addBot(PRECONS[2]);
    expect(table.botSeatIds()).toEqual(['seat_2', 'seat_4']);
    expect(table.lobby()?.seats.get('seat_3')?.controller).toBe('human');
  });

  it('counts bots as occupants when the host shrinks a mixed table', () => {
    const table = new MixedTable({ maxSeats: 4, seed: 'shrink' });
    table.createLobby();
    table.addBot(PRECONS[1]);
    table.addBot(PRECONS[2]);

    table.send(table.host, { type: 'set_max_seats', maxSeats: 2 });
    expect(table.host.last('error')?.error.code).toBe('protocol/lobby_full');
    expect(table.lobby()?.maxSeats).toBe(4);

    table.send(table.host, { type: 'remove_bot', seatId: 'seat_3' });
    table.send(table.host, { type: 'set_max_seats', maxSeats: 2 });
    expect(table.lobby()?.maxSeats).toBe(2);
    expect(table.botSeatIds()).toEqual(['seat_2']);
  });
});

/* --------------------------------------------------- order independence */

describe('scheduler callback order does not change the outcome', () => {
  /** The whole observable result of one match, for comparison. */
  function outcomeOf(played: PlayedMatch) {
    return {
      sequence: played.state?.sequence,
      turn: played.state?.turn,
      result: played.state?.result,
      humans: played.humans.map((human) => human.decisions),
      seats: (played.table.report()?.seats ?? []).map((seat) => ({
        seatId: seat.seatId,
        seed: seat.seed,
        decisions: seat.decisions,
        actions: seat.actions,
      })),
      incidents: played.table.report()?.incidents,
    };
  }

  it('produces the same match however many times the runner yields', async () => {
    const immediate = await playMixed(1, 3, { seed: 'order-independence', yieldTicks: 0 });
    const drawnOut = await playMixed(1, 3, { seed: 'order-independence', yieldTicks: 7 });

    // Seven extra microtask turns per decision is seven more chances for
    // something to interleave. The engine outcome, every bot's committed action
    // tally and every seat's stream are identical, which is the claim: the
    // runner's callbacks are a stack-safety boundary, not an input.
    expect(outcomeOf(drawnOut)).toEqual(outcomeOf(immediate));
    expect(immediate.state?.status).toBe('complete');
  });

  it('replays a mixed table exactly from the same seed, and differs from another', async () => {
    const first = await playMixed(2, 2, { seed: 'replay-mixed' });
    const second = await playMixed(2, 2, { seed: 'replay-mixed' });
    const other = await playMixed(2, 2, { seed: 'replay-mixed-other' });

    expect(outcomeOf(second)).toEqual(outcomeOf(first));
    expect(outcomeOf(other)).not.toEqual(outcomeOf(first));
  });
});
