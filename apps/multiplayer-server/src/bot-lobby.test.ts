import { describe, expect, it } from 'vitest';
import {
  BOT_CONFIG_SCHEMA_VERSION,
  BOT_DECK_MODES,
  DECK_MODE_SUPPORT,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_BOT_PACING_BUDGETS,
  DIFFICULTY_REGISTRY,
  DIFFICULTY_REGISTRY_VERSION,
  FIELDS_A_BOT_CONTROLLER_NEVER_HAS,
  IMMEDIATE_BOT_PACING,
  PLANNED_DIFFICULTIES,
  type BotSeatConfig,
} from '@tcg/bot-config';
import {
  bundledPrecon,
  loadFormatCardData,
  preconsForFormat,
  resolveFormatId,
  type CardDatabase,
} from '@tcg/card-data';
import { deckFormatOf, preconToDeck, type DeckFormatConfig, type SavedDeck } from '@tcg/deck';
import {
  botLobbySeatViewSchema,
  CURRENT_VERSIONS,
  encode,
  HOST_ONLY_CLIENT_MESSAGE_TYPES,
  type BotSetup,
  type ClientMessageInput,
  type ServerMessage,
} from '@tcg/protocol';
import {
  canStart,
  createBotSeat,
  createHumanSeat,
  freeBotSeats,
  isBotSeat,
  lobbyView,
  seatByToken,
  type Lobby,
  type Seat,
} from './lobby.js';
import { MatchServer, type ScheduleTimer, type ServerConnection } from './match-server.js';

/**
 * Server-side bot lobby seats (M09.3).
 *
 * The claims under test are the five the tranche makes: a seat's controller is
 * explicit and a bot's has no connection identity; only the host mutates a bot
 * seat and only before the match starts; seats are allocated deterministically
 * and a human is never evicted; a mode this build cannot honour is refused **by
 * name** rather than accepted; and every existing human lobby behaviour is
 * exactly where it was.
 *
 * Most of it is driven through encoded messages — the same path a socket takes —
 * so the refusals are the ones a real host would see. The handful of states no
 * message can reach in this build (a bot holding a saved deck, a bot with no
 * deck at all) are built directly from `lobby.ts`, because the point of testing
 * them is that the *next* tranche cannot introduce them quietly.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);

const development = loadFormatCardData('development');
if (!development.ok) throw new Error('The development format did not resolve to a card pool.');

const PRECON_ID = 'precon_goblin_swarm';
const OTHER_PRECON_ID = 'precon_bastion_guardians';

function requirePrecon(preconId: string) {
  const precon = bundledPrecon(preconId);
  if (!precon) throw new Error(`${preconId} is missing from the bundle.`);
  return precon;
}

/** A complete, valid host setup — the shape `add_bot` and `update_bot` carry. */
function setupFor(preconId: string = PRECON_ID, overrides: Partial<BotSetup> = {}): BotSetup {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style: 'value',
    deck: { mode: 'exact_precon', preconId },
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
  /** How many timers the server has scheduled, of any kind. */
  readonly scheduled: { count: number };
  send(connection: FakeConnection, message: ClientMessageInput): void;
  join(name: string): FakeConnection;
  lobby(): Lobby;
}

function createHarness(
  pool: CardDatabase = database,
  limits: DeckFormatConfig = deckFormat,
  maxSeats = 2,
): Harness {
  let counter = 0;
  const scheduled = { count: 0 };
  const schedule: ScheduleTimer = (_delayMs, _callback) => {
    scheduled.count += 1;
    return () => {};
  };
  const server = new MatchServer({
    database: pool,
    deckFormat: limits,
    random: () => {
      counter += 1;
      return ((counter * 2654435761) % 4294967296) / 4294967296;
    },
    schedule,
    seedFor: () => 'fixed-bot-lobby-seed',
    now: () => 1_000_000,
  });

  const send = (connection: FakeConnection, message: ClientMessageInput): void => {
    server.receive(connection, encode(message as never));
  };

  const host = new FakeConnection('conn_host');
  server.connect(host);
  send(host, { type: 'create_lobby', versions: CURRENT_VERSIONS, displayName: 'Host', maxSeats });
  const joined = host.last('lobby_joined');
  if (!joined) throw new Error('Host did not create a lobby');
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

  return {
    server,
    host,
    inviteCode,
    scheduled,
    send,
    join,
    lobby,
  };
}

/** A lobby assembled by hand, for the states no message can reach in M09.3. */
function lobbyOf(inviteCode: string, seats: readonly Seat[]): Lobby {
  return {
    inviteCode,
    hostSeatId: 'seat_1',
    seats: new Map(seats.map((seat) => [seat.seatId, seat])),
    maxSeats: 2,
    botsCreated: seats.filter(isBotSeat).length,
    pacing: DEFAULT_BOT_PACING_BUDGETS,
    lockedPacing: null,
    status: 'waiting',
    state: null,
  };
}

/** The seat views the host most recently saw. */
function seatViews(connection: FakeConnection) {
  const view = connection.last('lobby_updated')?.lobby ?? connection.last('lobby_joined')?.lobby;
  if (!view) throw new Error('That connection has never seen a lobby.');
  return view;
}

function lastError(connection: FakeConnection) {
  return connection.last('error')?.error;
}

/* ------------------------------------------------------------ adding a bot */

describe('the host seats a bot', () => {
  it('puts it in the first free seat, ready, with the precon it was given', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });

    expect(lastError(harness.host)).toBeUndefined();
    const view = seatViews(harness.host);
    const seat = view.seats[1];
    expect(seat?.seatId).toBe('seat_2');
    expect(seat?.controller).toBe('bot');
    expect(seat?.ready).toBe(true);
    expect(seat?.deckLegal).toBe(true);
    expect(seat?.deckName).toBe(requirePrecon(PRECON_ID).name);
    expect(seat?.isHost).toBe(false);
    // The host is untouched, and still a human.
    expect(view.seats[0]?.controller).toBe('human');
  });

  it('names it after its seat, and takes the host name when given one', () => {
    const harness = createHarness(database, deckFormat, 4);
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor(OTHER_PRECON_ID, { displayName: 'Sparring partner' }),
    });

    const seats = seatViews(harness.host).seats;
    expect(seats[1]?.displayName).toBe('Bot 2');
    expect(seats[2]?.displayName).toBe('Sparring partner');
  });

  it('materialises the shipped list server-side, from nothing on the wire', () => {
    const precon = requirePrecon(PRECON_ID);
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });

    const seat = harness.lobby().seats.get('seat_2');
    const deck = seat?.deck as SavedDeck;
    expect(deck.commanderId).toBe(precon.commanderId);
    expect(deck.cards.map((entry) => entry.cardId)).toEqual([...precon.cardIds]);
    expect(deck.cards.every((entry) => entry.quantity === 1)).toBe(true);
  });

  it('publishes the bot seat as the wire variant for a bot, and nothing more', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor(PRECON_ID, { style: 'defensive' }),
    });

    const seat = seatViews(harness.host).seats[1];
    const parsed = botLobbySeatViewSchema.safeParse(seat);
    expect(parsed.success).toBe(true);
    expect(seat?.bot).toEqual({
      controller: 'bot',
      botId: 'bot_1',
      displayName: 'Bot 2',
      difficulty: 'normal',
      // The host named the style, so the setting is the style (M09.16).
      styleSetting: 'defensive',
      style: 'defensive',
      deck: { mode: 'exact_precon', preconId: PRECON_ID },
      pacing: IMMEDIATE_BOT_PACING,
    });
  });

  it('gives the server the bot ID, and refuses one a client tried to choose', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    // Removing and re-adding is a *different* bot: an identity is not inherited
    // by whatever configuration lands in the seat next.
    harness.send(harness.host, { type: 'remove_bot', seatId: 'seat_2' });
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    expect(seatViews(harness.host).seats[1]?.bot?.botId).toBe('bot_2');

    harness.send(harness.host, {
      type: 'add_bot',
      setup: { ...setupFor(), botId: 'bot_mine' },
    } as ClientMessageInput);
    expect(lastError(harness.host)?.code).toBe('protocol/malformed_message');
  });
});

/* --------------------------------------------------------- what is refused */

describe('a bot this build cannot honour is refused by name', () => {
  const unsupported = BOT_DECK_MODES.filter((mode) => !DECK_MODE_SUPPORT[mode].supported);

  it('has no deck mode left without a resolver, and would refuse one by name', () => {
    // M09.10 turned the fourth and last mode on. The loop below is what a fifth
    // mode would meet; asserting the list is empty is what stops this becoming a
    // test that iterates nothing and passes by vacuum.
    expect(unsupported).toEqual([]);
  });

  it.each(unsupported.length > 0 ? unsupported : ([] as never[]))(
    'refuses deck mode %s and names the tranche that owns it',
    (mode) => {
      const harness = createHarness();
      const deck =
        mode === 'exact_saved_deck'
          ? {
              mode,
              deck: {
                sourceDeckId: 'deck_1',
                name: 'Saved',
                commanderId: requirePrecon(PRECON_ID).commanderId,
                cardIds: [...requirePrecon(PRECON_ID).cardIds],
                deckHash: 'abcdef0123456789',
              },
            }
          : mode === 'commander_generated'
            ? {
                mode,
                commanderId: requirePrecon(PRECON_ID).commanderId,
                seed: 'seed_1',
                generated: null,
              }
            : { mode, seed: 'seed_1', generated: null };

      harness.send(harness.host, {
        type: 'add_bot',
        setup: setupFor(PRECON_ID, { deck: deck as BotSetup['deck'] }),
      });

      const error = lastError(harness.host);
      expect(error?.code).toBe('protocol/bot_mode_unsupported');
      expect(error?.details?.join(' ')).toContain(DECK_MODE_SUPPORT[mode].plannedIn as string);
      // Refused means refused: no seat was written.
      expect(harness.lobby().seats.has('seat_2')).toBe(false);
    },
  );

  it.each(PLANNED_DIFFICULTIES)('refuses difficulty %s until its tranche lands', (difficulty) => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(PRECON_ID, { difficulty }) });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_config_invalid');
    expect(error?.details?.join(' ')).toContain(
      DIFFICULTY_REGISTRY[difficulty].plannedIn as string,
    );
    expect(harness.lobby().seats.has('seat_2')).toBe(false);
  });

  it('refuses a precon ID no precon has, and lists the ones it could take', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor('precon_not_a_deck') });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_deck_illegal');
    expect(error?.details?.join(' ')).toContain(PRECON_ID);
    expect(harness.lobby().seats.has('seat_2')).toBe(false);
  });

  it('refuses a precon built for another format, judged by the review a person gets', () => {
    const harness = createHarness(
      development.value.database,
      deckFormatOf(development.value.format),
    );
    expect(preconsForFormat('development')).toHaveLength(0);

    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_deck_illegal');
    expect(error?.details?.join(' ')).toContain('precon_wave_1');
  });

  it('refuses a reroll on an exact list, because there is nothing to rebuild', () => {
    // M09.9 gave `commander_generated` a resolver, so a reroll is refused for
    // the reason that survives: a precon and a saved deck are lists the host
    // handed over, and rebuilding one would not be a reroll.
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, { type: 'reroll_bot', seatId: 'seat_2' });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_mode_unsupported');
    expect(error?.details?.join(' ')).toContain('exact_precon');
  });

  it.each(['update_bot', 'reroll_bot', 'remove_bot'] as const)(
    'refuses %s against a seat that holds no bot',
    (type) => {
      const harness = createHarness(database, deckFormat, 4);
      harness.join('Guest');

      harness.send(harness.host, {
        ...(type === 'update_bot'
          ? { type, seatId: 'seat_2', setup: setupFor() }
          : { type, seatId: 'seat_2' }),
      } as ClientMessageInput);
      expect(lastError(harness.host)?.code).toBe('protocol/unknown_bot_seat');

      harness.send(harness.host, {
        ...(type === 'update_bot'
          ? { type, seatId: 'seat_4', setup: setupFor() }
          : { type, seatId: 'seat_4' }),
      } as ClientMessageInput);
      expect(lastError(harness.host)?.code).toBe('protocol/unknown_bot_seat');
      // The guest is still sitting where they were.
      expect(harness.lobby().seats.get('seat_2')?.controller).toBe('human');
    },
  );

  it('refuses a bot when every seat is taken, whoever is in them', () => {
    const harness = createHarness();
    harness.join('Guest');
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/lobby_full');
    expect(error?.details?.join(' ')).toContain('2 seats');
    expect(harness.lobby().seats.get('seat_2')?.controller).toBe('human');
  });
});

/* ------------------------------------------------------- who, and when */

describe('only the host, and only before the match', () => {
  it.each(HOST_ONLY_CLIENT_MESSAGE_TYPES)('refuses %s from a seat that is not the host', (type) => {
    const harness = createHarness();
    const guest = harness.join('Guest');

    const message: Record<string, unknown> = { type };
    if (type === 'set_max_seats') message.maxSeats = 4;
    if (type === 'add_bot' || type === 'update_bot') message.setup = setupFor();
    if (type === 'set_bot_pacing') message.budgets = DEFAULT_BOT_PACING_BUDGETS;
    if (type === 'update_bot' || type === 'reroll_bot' || type === 'remove_bot') {
      message.seatId = 'seat_2';
    }

    harness.send(guest, message as ClientMessageInput);
    expect(lastError(guest)?.code).toBe('protocol/not_host');
  });

  it.each(['add_bot', 'update_bot', 'reroll_bot', 'remove_bot'] as const)(
    'locks %s once the match has started',
    (type) => {
      const harness = createHarness();
      harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
      harness.send(harness.host, { type: 'submit_precon', preconId: OTHER_PRECON_ID });
      harness.send(harness.host, { type: 'set_ready', ready: true });
      expect(seatViews(harness.host).status).toBe('in_match');

      const message: Record<string, unknown> = { type };
      if (type === 'add_bot' || type === 'update_bot') message.setup = setupFor();
      if (type !== 'add_bot') message.seatId = 'seat_2';

      harness.send(harness.host, message as ClientMessageInput);
      expect(lastError(harness.host)?.code).toBe('protocol/already_started');
      expect(harness.lobby().seats.get('seat_2')?.controller).toBe('bot');
    },
  );

  it('tells someone who is in no lobby at all to join one first', () => {
    const harness = createHarness();
    const stranger = new FakeConnection('conn_stranger');
    harness.server.connect(stranger);
    harness.send(stranger, { type: 'add_bot', setup: setupFor() });
    expect(lastError(stranger)?.code).toBe('protocol/not_in_lobby');
  });
});

/* ---------------------------------------------------- updating and removing */

describe('the host reconfigures and removes a bot', () => {
  it('replaces the configuration wholesale and keeps the seat and its identity', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, {
      type: 'update_bot',
      seatId: 'seat_2',
      setup: setupFor(OTHER_PRECON_ID, { style: 'aggressive', displayName: 'Renamed' }),
    });

    const seat = seatViews(harness.host).seats[1];
    expect(seat?.bot?.botId).toBe('bot_1');
    expect(seat?.bot?.style).toBe('aggressive');
    expect(seat?.displayName).toBe('Renamed');
    expect(seat?.deckName).toBe(requirePrecon(OTHER_PRECON_ID).name);
    expect(harness.lobby().seats.get('seat_2')?.deck?.commanderId).toBe(
      requirePrecon(OTHER_PRECON_ID).commanderId,
    );
  });

  it('leaves the previous configuration alone when the new one is refused', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, {
      type: 'update_bot',
      seatId: 'seat_2',
      setup: setupFor(PRECON_ID, { difficulty: 'hard' }),
    });

    expect(lastError(harness.host)?.code).toBe('protocol/bot_config_invalid');
    const seat = seatViews(harness.host).seats[1];
    expect(seat?.bot?.difficulty).toBe('normal');
    expect(seat?.bot?.deck).toEqual({ mode: 'exact_precon', preconId: PRECON_ID });
    expect(seat?.ready).toBe(true);
  });

  it('frees the seat, and lets a human take it afterwards', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, { type: 'remove_bot', seatId: 'seat_2' });
    expect(harness.lobby().seats.has('seat_2')).toBe(false);

    const guest = harness.join('Guest');
    expect(guest.last('lobby_joined')?.seatId).toBe('seat_2');
  });
});

/* ----------------------------------------------- allocation and human seats */

describe('seat allocation stays deterministic and never evicts a human', () => {
  it('fills seats in order and stops at the table size', () => {
    const harness = createHarness(database, deckFormat, 4);
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });

    expect([...harness.lobby().seats.keys()]).toEqual(['seat_1', 'seat_2', 'seat_3', 'seat_4']);
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    expect(lastError(harness.host)?.code).toBe('protocol/lobby_full');
  });

  it('never offers the host seat to a bot, even when it is empty', () => {
    const lobby = lobbyOf('AAAAAA', []);
    lobby.maxSeats = 4;
    expect(freeBotSeats(lobby)).toEqual(['seat_2', 'seat_3', 'seat_4']);
  });

  it('gives a joining human the next empty seat, never the one a bot holds', () => {
    const harness = createHarness(database, deckFormat, 4);
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });

    const guest = harness.join('Guest');
    expect(guest.last('lobby_joined')?.seatId).toBe('seat_3');
    expect(harness.lobby().seats.get('seat_2')?.controller).toBe('bot');
  });

  it('counts a bot as an occupant when the host shrinks the table', () => {
    const harness = createHarness(database, deckFormat, 4);
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, { type: 'set_max_seats', maxSeats: 2 });

    expect(lastError(harness.host)?.code).toBe('protocol/lobby_full');
    expect(harness.lobby().maxSeats).toBe(4);
  });

  it('lets the host grow the table and seat another bot in the new seat', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, { type: 'set_max_seats', maxSeats: 3 });
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(OTHER_PRECON_ID) });

    expect([...harness.lobby().seats.keys()]).toEqual(['seat_1', 'seat_2', 'seat_3']);
  });
});

/* ------------------------------------------------------- no connection at all */

describe('a bot seat has no connection identity', () => {
  it('carries none of the four fields a bot controller never has', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });

    const seat = harness.lobby().seats.get('seat_2');
    if (!seat || !isBotSeat(seat)) throw new Error('seat_2 is not a bot seat.');
    for (const field of FIELDS_A_BOT_CONTROLLER_NEVER_HAS) {
      expect(Object.hasOwn(seat, field)).toBe(false);
    }
    expect(seatByToken(harness.lobby(), '')).toBeUndefined();
  });

  it('is always connected, never counting down, and never reclaimable by token', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });

    const seat = seatViews(harness.host).seats[1];
    expect(seat?.connected).toBe(true);
    expect(seat?.graceSeconds).toBeNull();

    const stranger = new FakeConnection('conn_stranger');
    harness.server.connect(stranger);
    harness.send(stranger, {
      type: 'reconnect',
      versions: CURRENT_VERSIONS,
      reconnectToken: 'a'.repeat(32),
    });
    expect(lastError(stranger)?.code).toBe('protocol/unknown_token');
  });

  it('starts no disconnect timer of its own when a human drops', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, { type: 'submit_precon', preconId: OTHER_PRECON_ID });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    expect(seatViews(harness.host).status).toBe('in_match');

    expect(harness.scheduled.count).toBe(0);
    harness.server.disconnect(harness.host);
    // Exactly one window opened, for the one seat that can lose a connection.
    expect(harness.scheduled.count).toBe(1);
  });

  it('closes a lobby whose last human leaves, rather than leaving bots sitting', () => {
    const harness = createHarness(database, deckFormat, 4);
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.server.disconnect(harness.host);

    expect(harness.server.lobbyByCode(harness.inviteCode)).toBeUndefined();
  });
});

/* --------------------------------------------------------- readiness and start */

describe('readiness and start gating', () => {
  it('is ready the moment it is configured, and does not make the lobby startable alone', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });

    let view = seatViews(harness.host);
    expect(view.seats[1]?.ready).toBe(true);
    expect(view.canStart).toBe(false);
    expect(view.status).toBe('waiting');

    harness.send(harness.host, { type: 'submit_precon', preconId: OTHER_PRECON_ID });
    view = seatViews(harness.host);
    expect(view.canStart).toBe(false);

    harness.send(harness.host, { type: 'set_ready', ready: true });
    expect(seatViews(harness.host).status).toBe('in_match');
  });

  it('starts a match that seats the bot as an ordinary player', async () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor() });
    harness.send(harness.host, { type: 'submit_precon', preconId: OTHER_PRECON_ID });
    harness.send(harness.host, { type: 'set_ready', ready: true });

    const view = harness.host.last('match_state')?.view;
    expect(view?.viewerId).toBe('player_1');
    expect(view?.seatOrder).toEqual(['player_1', 'player_2']);
    expect(view?.players.map((player) => player.name)).toContain('Bot 2');

    // Since M09.4 the bot then plays: it acts through the seat's own idempotent
    // action-identity map, which is the same one a human's `submit_action`
    // writes to. What the bot *does* with the opportunity is
    // `bot-runner.test.ts`; what matters here is that starting the match seated
    // an ordinary player and nothing about the lobby had to know more than that.
    await harness.server.whenBotsIdle();
    expect(harness.lobby().seats.get('seat_2')?.appliedActions.size).toBeGreaterThan(0);
  });

  it('says a lobby cannot start when a bot seat holds no legal deck', () => {
    const host = createHumanSeat('seat_1', 'Host', 'a'.repeat(32));
    host.deck = preconDeck(PRECON_ID);
    host.deckLegal = true;
    host.ready = true;

    const deckless = createBotSeat('seat_2', savedDeckBotConfig(), null);
    const lobby = lobbyOf('BBBBBB', [host, deckless]);

    expect(deckless.ready).toBe(false);
    expect(deckless.deckLegal).toBe(false);
    expect(canStart(lobby)).toBe(false);
    expect(lobbyView(lobby, () => 0).seats[1]?.ready).toBe(false);
  });

  it('publishes no deck name for a mode whose list is private', () => {
    // No message can reach this state in M09.3 — `exact_saved_deck` is refused —
    // so it is built directly. The claim is about M09.6: a saved list's name is
    // its tranche's decision, and defaulting to "publish it" would make that
    // decision by accident, in the direction that leaks.
    const seat = createBotSeat('seat_2', savedDeckBotConfig(), {
      ...preconDeck(PRECON_ID),
      name: 'My secret brew',
    });
    const view = lobbyView(lobbyOf('CCCCCC', [seat]), () => 0);
    expect(view.seats[0]?.deckName).toBeNull();
    expect(JSON.stringify(view)).not.toContain('My secret brew');
  });
});

function preconDeck(preconId: string): SavedDeck {
  return preconToDeck(requirePrecon(preconId), { id: preconId, now: '2026-08-14T12:00:00.000Z' });
}

/** A saved-deck bot configuration, for the states no message can produce yet. */
function savedDeckBotConfig(): BotSeatConfig {
  const precon = requirePrecon(PRECON_ID);
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    controller: { botId: 'bot_1', displayName: 'Bot 2' },
    difficulty: DEFAULT_BOT_DIFFICULTY,
    styleSetting: 'value',
    style: 'value',
    deck: {
      mode: 'exact_saved_deck',
      deck: {
        sourceDeckId: 'deck_1',
        name: 'My secret brew',
        commanderId: precon.commanderId,
        cardIds: [...precon.cardIds],
        deckHash: 'abcdef0123456789',
      },
    },
    pacing: IMMEDIATE_BOT_PACING,
  };
}
