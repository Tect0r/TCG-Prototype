import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOT_CONFIG_SCHEMA_VERSION,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_BOT_PACING_BUDGETS,
  DIFFICULTY_REGISTRY_VERSION,
  IMMEDIATE_BOT_PACING,
  MAX_BUDGET_SECONDS,
  MIN_BUDGET_SECONDS,
  PACING_CONFIG_VERSION,
  botDelayMs,
  type BotPacing,
  type BotPacingBudgets,
} from '@tcg/bot-config';
import { loadFormatCardData, resolveFormatId } from '@tcg/card-data';
import { deckFormatOf } from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  encode,
  type BotSetup,
  type ClientMessage,
  type ClientMessageInput,
  type LobbyView,
  type ServerMessage,
} from '@tcg/protocol';
import { DEFAULT_RULES_CONFIG } from '@tcg/rules-engine';
import { isBotSeat, type Lobby } from './lobby.js';
import { MatchServer, type ScheduleTimer, type ServerConnection } from './match-server.js';

/**
 * Bot pacing configuration (M09.11).
 *
 * Five claims, and none of them is that anything waits. This tranche configures
 * the numbers and records them; M09.12 owns the scheduler that spends them.
 *
 * 1. A table has budgets, they default to the milestone's dials, and only the
 *    host changes them — before the match, by name, through the same three
 *    refusals every other bot message shares.
 * 2. The budgets are the **table's** and the percentage is the **bot's**, so
 *    changing one never silently changes the other.
 * 3. They lock when the match starts, and what every seat is then shown is what
 *    the match locked rather than whatever the live record says afterwards.
 * 4. They survive everything short of the lobby: seats coming and going, a table
 *    resize, a reconfigured bot, and a host reconnecting.
 * 5. **Nothing waits yet.** A bot configured at 100% still acts inside the same
 *    wake, and the server schedules no timer to make it wait — which is the
 *    tranche's own exclusion, asserted rather than promised.
 *
 * And one non-regression: open-questions.md Q8 is still open, and no budget has
 * appeared in `RulesConfig`. A bot waiting is not a rules change (ADR 0024 §4).
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const PRECON_ID = 'precon_goblin_swarm';
const OTHER_PRECON_ID = 'precon_bastion_guardians';

function setupFor(overrides: Partial<BotSetup> = {}): BotSetup {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style: 'value',
    deck: { mode: 'exact_precon', preconId: PRECON_ID },
    pacing: IMMEDIATE_BOT_PACING,
    displayName: null,
    ...overrides,
  };
}

function budgets(ordinarySeconds: number, reactionSeconds: number): BotPacingBudgets {
  return { pacingVersion: PACING_CONFIG_VERSION, ordinarySeconds, reactionSeconds };
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

interface Harness {
  readonly server: MatchServer;
  readonly host: FakeConnection;
  readonly inviteCode: string;
  /** Every timer the server has scheduled, of any kind. */
  readonly scheduled: { count: number };
  send(connection: FakeConnection, message: ClientMessageInput): void;
  join(name: string): FakeConnection;
  lobby(): Lobby;
  view(connection?: FakeConnection): LobbyView;
}

function createHarness(maxSeats = 2): Harness {
  let counter = 0;
  const scheduled = { count: 0 };
  const schedule: ScheduleTimer = () => {
    scheduled.count += 1;
    return () => {};
  };
  const server = new MatchServer({
    database,
    deckFormat,
    random: () => {
      counter += 1;
      return ((counter * 2654435761) % 4294967296) / 4294967296;
    },
    schedule,
    seedFor: () => 'fixed-bot-pacing-seed',
    now: () => 1_000_000,
  });

  const send = (connection: FakeConnection, message: ClientMessageInput): void => {
    server.receive(connection, encode(message as never));
  };

  const host = new FakeConnection('conn_host');
  server.connect(host);
  send(host, { type: 'create_lobby', versions: CURRENT_VERSIONS, displayName: 'Host', maxSeats });
  const joined = host.last('lobby_joined');
  if (!joined) throw new Error('The host did not create a lobby.');
  const inviteCode = joined.lobby.inviteCode;

  let guests = 0;
  const join = (name: string): FakeConnection => {
    guests += 1;
    const guest = new FakeConnection(`conn_guest_${guests}`);
    server.connect(guest);
    send(guest, { type: 'join_lobby', versions: CURRENT_VERSIONS, inviteCode, displayName: name });
    return guest;
  };

  const lobby = (): Lobby => {
    const found = server.lobbyByCode(inviteCode);
    if (!found) throw new Error('The lobby is gone.');
    return found;
  };

  const view = (connection: FakeConnection = host): LobbyView => {
    const seen = connection.last('lobby_updated')?.lobby ?? connection.last('lobby_joined')?.lobby;
    if (!seen) throw new Error('That connection has never seen a lobby.');
    return seen;
  };

  return { server, host, inviteCode, scheduled, send, join, lobby, view };
}

function lastError(connection: FakeConnection) {
  return connection.last('error')?.error;
}

function botSeatView(view: LobbyView) {
  const seat = view.seats.find((entry) => entry.controller === 'bot');
  if (!seat || seat.controller !== 'bot') throw new Error('No bot is seated.');
  return seat;
}

/* --------------------------------------------------------- the table's budgets */

describe('a table has bot pacing budgets', () => {
  it('starts at the milestone dials, and says which pacing version they are', () => {
    const harness = createHarness();
    expect(harness.view().botPacing).toEqual({
      pacingVersion: PACING_CONFIG_VERSION,
      ordinarySeconds: 30,
      reactionSeconds: 5,
    });
    // The same record `@tcg/bot-config` calls the default, rather than two
    // copies of two numbers.
    expect(harness.view().botPacing).toEqual(DEFAULT_BOT_PACING_BUDGETS);
  });

  it('lets the host change them, and shows the change to every seat', () => {
    const harness = createHarness();
    const guest = harness.join('Guest');

    harness.send(harness.host, { type: 'set_bot_pacing', budgets: budgets(12, 3) });

    expect(lastError(harness.host)).toBeUndefined();
    expect(harness.view().botPacing).toEqual(budgets(12, 3));
    // A guest sees them too: a bot's percentage is public, and a percentage
    // without its budget is not a number anybody can read.
    expect(harness.view(guest).botPacing).toEqual(budgets(12, 3));
  });

  it('accepts the extremes of the supported range', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'set_bot_pacing',
      budgets: budgets(MAX_BUDGET_SECONDS, MIN_BUDGET_SECONDS),
    });
    expect(lastError(harness.host)).toBeUndefined();
    expect(harness.lobby().pacing).toEqual(budgets(MAX_BUDGET_SECONDS, MIN_BUDGET_SECONDS));
  });
});

/* ------------------------------------------------------------------ refusals */

describe('who may change the budgets, and when', () => {
  it('refuses a guest by name, and changes nothing', () => {
    const harness = createHarness();
    const guest = harness.join('Guest');

    harness.send(guest, { type: 'set_bot_pacing', budgets: budgets(9, 2) });

    expect(lastError(guest)?.code).toBe('protocol/not_host');
    expect(harness.lobby().pacing).toEqual(DEFAULT_BOT_PACING_BUDGETS);
  });

  it('refuses a change once the match has started', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, { type: 'submit_precon', preconId: OTHER_PRECON_ID });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    expect(harness.view().status).toBe('in_match');

    harness.send(harness.host, { type: 'set_bot_pacing', budgets: budgets(9, 2) });

    expect(lastError(harness.host)?.code).toBe('protocol/already_started');
    expect(harness.lobby().pacing).toEqual(DEFAULT_BOT_PACING_BUDGETS);
  });

  it('refuses a budget outside the range as a malformed message', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'set_bot_pacing',
      budgets: { ...DEFAULT_BOT_PACING_BUDGETS, ordinarySeconds: MAX_BUDGET_SECONDS + 1 },
    });

    // The wire carries `botPacingBudgetsSchema` itself, so the codec is what
    // refuses — the same treatment a future `BOT_CONFIG_SCHEMA_VERSION` gets
    // through `botSetupSchema`, and the same finding M09.3 recorded for it.
    expect(lastError(harness.host)?.code).toBe('protocol/malformed_message');
    expect(harness.lobby().pacing).toEqual(DEFAULT_BOT_PACING_BUDGETS);
  });

  it('refuses a record the pacing reader rejects, even past the codec', () => {
    const harness = createHarness();
    // Straight into `handle`, bypassing the codec, because the point is that the
    // server asks `@tcg/bot-config` rather than trusting a parse that already
    // happened somewhere else. A record from a newer build reaches here exactly
    // this way if the wire ever widens.
    harness.server.handle(harness.host, {
      type: 'set_bot_pacing',
      budgets: { ...DEFAULT_BOT_PACING_BUDGETS, pacingVersion: PACING_CONFIG_VERSION + 1 },
    } as ClientMessage);

    expect(lastError(harness.host)?.code).toBe('protocol/bot_config_invalid');
    expect(harness.lobby().pacing).toEqual(DEFAULT_BOT_PACING_BUDGETS);
  });
});

/* ------------------------------------------------------------ the per-bot dial */

describe('a bot carries its own percentage', () => {
  it('publishes the percentage the host configured, and the override with it', () => {
    const harness = createHarness();
    const pacing: BotPacing = { percent: 50, reactionPercent: 10 };
    harness.send(harness.host, { type: 'add_bot', setup: setupFor({ pacing }) });

    expect(botSeatView(harness.view()).bot.pacing).toEqual(pacing);
  });

  it('keeps 0, 50 and 100 exactly, and turns each into the delay it implies', () => {
    const harness = createHarness(4);
    for (const percent of [0, 50, 100]) {
      harness.send(harness.host, {
        type: 'add_bot',
        setup: setupFor({ pacing: { percent, reactionPercent: null } }),
      });
    }

    const seats = harness.view().seats.filter((seat) => seat.controller === 'bot');
    expect(seats.map((seat) => (seat.controller === 'bot' ? seat.bot.pacing.percent : -1))).toEqual(
      [0, 50, 100],
    );

    const table = harness.view().botPacing;
    const delays = seats.map((seat) =>
      seat.controller === 'bot' ? botDelayMs(seat.bot.pacing, table, 'ordinary') : -1,
    );
    // 0% is exactly nothing; 50% is half of 30 seconds; 100% stops one safety
    // margin short of the budget, which is why it is not 30000.
    expect(delays).toEqual([0, 15_000, 29_750]);
  });

  it('inherits the Reaction percentage unless the seat overrides it', () => {
    const harness = createHarness(4);
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor({ pacing: { percent: 40, reactionPercent: null } }),
    });
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor({
        deck: { mode: 'exact_precon', preconId: OTHER_PRECON_ID },
        pacing: { percent: 40, reactionPercent: 0 },
      }),
    });

    const table = harness.view().botPacing;
    const [inherit, override] = harness
      .view()
      .seats.filter((seat) => seat.controller === 'bot')
      .map((seat): BotPacing =>
        seat.controller === 'bot' ? seat.bot.pacing : IMMEDIATE_BOT_PACING,
      );
    if (!inherit || !override) throw new Error('Both bots should be seated.');

    // 40% of the 5-second Reaction budget, inherited from the ordinary dial.
    expect(botDelayMs(inherit, table, 'reaction')).toBe(2000);
    // An override of 0 is not "inherit": it is a bot that answers a Reaction
    // window instantly while still thinking about its own turn.
    expect(botDelayMs(override, table, 'reaction')).toBe(0);
    expect(botDelayMs(override, table, 'ordinary')).toBe(12_000);
  });

  it('does not move a percentage when the budget moves, or the other way round', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor({ pacing: { percent: 50, reactionPercent: 20 } }),
    });

    harness.send(harness.host, { type: 'set_bot_pacing', budgets: budgets(10, 2) });
    expect(botSeatView(harness.view()).bot.pacing).toEqual({ percent: 50, reactionPercent: 20 });

    harness.send(harness.host, {
      type: 'update_bot',
      seatId: 'seat_2',
      setup: setupFor({ pacing: { percent: 100, reactionPercent: null } }),
    });
    expect(harness.view().botPacing).toEqual(budgets(10, 2));
  });
});

/* ------------------------------------------------------------------- the lock */

describe('the budgets lock when the match starts', () => {
  function startedTable(): Harness {
    const harness = createHarness();
    harness.send(harness.host, { type: 'set_bot_pacing', budgets: budgets(20, 4) });
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor({ pacing: { percent: 50, reactionPercent: null } }),
    });
    harness.send(harness.host, { type: 'submit_precon', preconId: OTHER_PRECON_ID });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    return harness;
  }

  it('records what the match started under', () => {
    const harness = startedTable();
    expect(harness.view().status).toBe('in_match');
    expect(harness.lobby().lockedPacing).toEqual(budgets(20, 4));
    expect(harness.view().botPacing).toEqual(budgets(20, 4));
  });

  it('publishes the locked record even if the live one is changed underneath it', () => {
    const harness = startedTable();
    // No message can do this — every path is refused once the lobby has started
    // — so it is done by hand, which is exactly the failure the second lock
    // exists to catch.
    harness.lobby().pacing = budgets(300, 300);

    harness.send(harness.host, { type: 'set_ready', ready: true });
    expect(harness.view().botPacing).toEqual(budgets(20, 4));
  });

  it('locks the per-bot percentages with them', () => {
    const harness = startedTable();
    harness.send(harness.host, {
      type: 'update_bot',
      seatId: 'seat_2',
      setup: setupFor({ pacing: { percent: 0, reactionPercent: null } }),
    });

    expect(lastError(harness.host)?.code).toBe('protocol/already_started');
    expect(botSeatView(harness.view()).bot.pacing).toEqual({ percent: 50, reactionPercent: null });
  });
});

/* ------------------------------------------------------------- persistence */

describe('the budgets outlive everything short of the lobby', () => {
  it('survives seats arriving and leaving, a resize, and a reconfigured bot', () => {
    const harness = createHarness(4);
    harness.send(harness.host, { type: 'set_bot_pacing', budgets: budgets(45, 7) });

    harness.join('Guest');
    harness.send(harness.host, { type: 'set_max_seats', maxSeats: 4 });
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, {
      type: 'update_bot',
      seatId: 'seat_3',
      setup: setupFor({ style: 'aggressive' }),
    });
    harness.send(harness.host, { type: 'remove_bot', seatId: 'seat_3' });

    expect(harness.view().botPacing).toEqual(budgets(45, 7));
  });

  it('is still there when the host reconnects', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'set_bot_pacing', budgets: budgets(15, 2) });
    const token = harness.host.last('lobby_joined')?.reconnectToken;
    if (!token) throw new Error('The host has no reconnect token.');

    const returning = new FakeConnection('conn_host_again');
    harness.server.connect(returning);
    harness.send(returning, {
      type: 'reconnect',
      versions: CURRENT_VERSIONS,
      reconnectToken: token,
    });

    expect(harness.view(returning).botPacing).toEqual(budgets(15, 2));
  });
});

/* -------------------------------------------------- nothing waits yet (M09.12) */

describe('configuring a delay does not create one', () => {
  it('acts inside the same wake at 100%, and schedules no timer to wait', async () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor({ pacing: { percent: 100, reactionPercent: 100 } }),
    });
    harness.send(harness.host, { type: 'submit_precon', preconId: OTHER_PRECON_ID });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    expect(harness.view().status).toBe('in_match');

    await harness.server.whenBotsIdle();

    const seat = harness.lobby().seats.get('seat_2');
    if (!seat || !isBotSeat(seat)) throw new Error('Seat 2 does not hold a bot.');
    // It decided, and it did so without anything having been scheduled: the
    // only timer this server owns is the disconnect window, and nobody has
    // disconnected. M09.12 is what turns the configured 29.75 s into a wait.
    expect(seat.appliedActions.size).toBeGreaterThan(0);
    expect(harness.scheduled.count).toBe(0);
  });
});

/* ------------------------------------------------------- Q8 is still open */

describe('pacing is configuration, not a rule', () => {
  it('puts no budget in the rules configuration', () => {
    const keys = Object.keys(DEFAULT_RULES_CONFIG);
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain('pacing');
      expect(key.toLowerCase()).not.toContain('budget');
    }
    // The one time-shaped value in there is the disconnect window, and it is a
    // rule about a person rather than a dial for a bot.
    expect(keys).toContain('disconnectGraceSeconds');
  });

  it('leaves open-questions.md Q8 open, and does not answer it', () => {
    const questions = readFileSync(join(REPO_ROOT, 'docs/open-questions.md'), 'utf8');
    const heading = '### Q8. What is the turn/action timeout policy?';
    expect(questions).toContain(heading);

    const answered = questions.indexOf('\n## Answered');
    const q8 = questions.indexOf(heading);
    // Answered questions are compressed into their own section rather than
    // deleted, so "still open" is "above that section", not "still mentioned".
    expect(q8).toBeGreaterThan(-1);
    if (answered >= 0) expect(q8).toBeLessThan(answered);
    expect(questions.slice(q8, q8 + 800)).toContain('**Still open:**');
  });
});
