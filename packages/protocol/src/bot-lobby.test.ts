import { describe, expect, it } from 'vitest';
import {
  BOT_CONFIG_SCHEMA_VERSION,
  DIFFICULTY_REGISTRY_VERSION,
  botSeatConfigSchema,
  publicBotSeatOf,
  type BotSeatConfig,
} from '@tcg/bot-config';
import { decodeClientMessage, decodeServerMessage, encode } from './codec.js';
import {
  BOT_LOBBY_CONDITIONS,
  BOT_LOBBY_ERROR_CODES,
  CURRENT_VERSIONS,
  HOST_ONLY_CLIENT_MESSAGE_TYPES,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_VERSION,
  botLobbyError,
  botLobbySeatViewSchema,
  botSetupSchema,
  clientMessageSchema,
  humanLobbySeatViewSchema,
  isHostOnlyClientMessage,
  lobbySeatViewSchema,
  lobbyViewSchema,
  protocolErrorSchema,
  versionMismatch,
  type BotSetup,
  type ClientMessage,
  type LobbySeatView,
  type Versions,
} from './messages.js';

/**
 * The bot lobby wire contract (M09.2).
 *
 * M09.1 defined what a bot seat *is*; this file is the first place any of it
 * crosses a boundary, so the tests here are about the boundary rather than about
 * the shapes: what survives a round trip, what an older build is told, what a
 * host may send, what an opponent is handed, and what each of the seven refusals
 * is called.
 *
 * The server does not act on any of these messages yet — M09.3 owns that — so
 * nothing below drives a lobby.
 */

/* --------------------------------------------------------------- fixtures */

/**
 * A private configuration carrying one of every secret the privacy rule is
 * about: a frozen card list, a saved-deck identity and a deck hash.
 */
const PRIVATE_SAVED_DECK: BotSeatConfig = {
  schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
  difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
  controller: { botId: 'bot_seat_2', displayName: 'Opponent 2' },
  difficulty: 'normal',
  style: 'value',
  deck: {
    mode: 'exact_saved_deck',
    deck: {
      sourceDeckId: 'saved_deck_zzz',
      name: 'Sacrifice, rebuilt',
      commanderId: 'commander_grave',
      cardIds: ['card_secret_one', 'card_secret_two'],
      deckHash: 'deadbeefcafef00d',
    },
  },
  pacing: { percent: 50, reactionPercent: null },
};

/** The other secret the rule is about: a generator seed. */
const PRIVATE_GENERATED: BotSeatConfig = {
  ...PRIVATE_SAVED_DECK,
  controller: { botId: 'bot_seat_3', displayName: 'Opponent 3' },
  deck: {
    mode: 'commander_generated',
    commanderId: 'commander_grave',
    seed: 'seed_that_must_not_travel',
    generated: null,
  },
};

const SETUP: BotSetup = {
  schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
  difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
  displayName: 'Opponent 2',
  difficulty: 'normal',
  style: 'aggressive',
  deck: { mode: 'exact_precon', preconId: 'wave_1_aggro' },
  pacing: { percent: 0, reactionPercent: null },
};

function humanSeat(): LobbySeatView {
  return {
    seatId: 'seat_1',
    displayName: 'Host',
    connected: true,
    ready: true,
    deckName: 'My deck',
    deckLegal: true,
    isHost: true,
    graceSeconds: null,
    eliminated: false,
    controller: 'human',
    bot: null,
  };
}

function botSeat(config: BotSeatConfig): LobbySeatView {
  return {
    seatId: 'seat_2',
    displayName: config.controller.displayName,
    connected: true,
    ready: true,
    deckName: 'Generated deck',
    deckLegal: true,
    isHost: false,
    graceSeconds: null,
    eliminated: false,
    controller: 'bot',
    bot: publicBotSeatOf(config),
  };
}

/* ---------------------------------------------------------------- versions */

describe('the protocol version', () => {
  it('moved once, for the shapes this tranche put on the wire', () => {
    expect(PROTOCOL_VERSION).toBe(7);
    expect(CURRENT_VERSIONS.protocol).toBe(7);
  });

  it('refuses the build that came before it, by name', () => {
    const older: Versions = { ...CURRENT_VERSIONS, protocol: 6 };
    expect(versionMismatch(older, CURRENT_VERSIONS)).toEqual(['protocol 6 vs server 7']);
  });

  it('does not drag the bot configuration versions along with it', () => {
    // A difficulty can improve without a message shape changing, which is the
    // whole reason these are separate constants (ADR 0024 §7).
    expect(BOT_CONFIG_SCHEMA_VERSION).toBe(1);
    expect(DIFFICULTY_REGISTRY_VERSION).toBe(1);
    // And the handshake still compares three things, not five: a bot's
    // configuration is not something two builds must agree on to play at all.
    expect(Object.keys(CURRENT_VERSIONS).sort()).toEqual(['cardSchema', 'protocol', 'rules']);
  });
});

/* ------------------------------------------------------------ the messages */

describe('the four host-only bot messages', () => {
  const messages: readonly ClientMessage[] = [
    { type: 'add_bot', setup: SETUP },
    { type: 'update_bot', seatId: 'seat_2', setup: SETUP },
    { type: 'reroll_bot', seatId: 'seat_2' },
    { type: 'remove_bot', seatId: 'seat_2' },
  ];

  it('round trip through the codec unchanged', () => {
    for (const message of messages) {
      const decoded = decodeClientMessage(encode(message));
      expect(decoded.ok, `${message.type} failed to decode`).toBe(true);
      if (decoded.ok) expect(decoded.value).toEqual(message);
    }
  });

  it('are all declared host-only', () => {
    for (const message of messages) {
      expect(isHostOnlyClientMessage(message.type)).toBe(true);
      expect(HOST_ONLY_CLIENT_MESSAGE_TYPES).toContain(message.type);
    }
    // The two that were host-only before M09.2 still are.
    expect(isHostOnlyClientMessage('set_max_seats')).toBe(true);
    expect(isHostOnlyClientMessage('start_match')).toBe(true);
    // And nothing else became host-only by accident.
    expect(isHostOnlyClientMessage('submit_deck')).toBe(false);
    expect(isHostOnlyClientMessage('submit_action')).toBe(false);
  });

  it('refuse an unknown member, at the message and inside the setup', () => {
    expect(clientMessageSchema.safeParse({ ...messages[0], seatId: 'seat_2' }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...messages[2], seed: 'chosen' }).success).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        type: 'add_bot',
        setup: { ...SETUP, botId: 'bot_seat_2' },
      }).success,
    ).toBe(false);
    expect(
      clientMessageSchema.safeParse({
        type: 'add_bot',
        setup: { ...SETUP, deck: { mode: 'exact_precon', preconId: 'wave_1_aggro', extra: 1 } },
      }).success,
    ).toBe(false);
  });

  it('never let a client choose the seat a bot is added to, or its ID', () => {
    // The server allocates seats deterministically and owns the bot ID; a
    // client able to name either could collide with a joining human or with
    // another seat.
    expect(clientMessageSchema.safeParse({ type: 'add_bot', setup: SETUP }).success).toBe(true);
    expect(Object.keys(botSetupSchema.shape)).not.toContain('botId');
    expect(Object.keys(botSetupSchema.shape)).not.toContain('seatId');
  });

  it('reroll carries no seed, because the server derives the next one', () => {
    expect(clientMessageSchema.safeParse({ type: 'reroll_bot', seatId: 'seat_2' }).success).toBe(
      true,
    );
    // A client-supplied seed would make the recorded seed transition something
    // a client could invent, so there is nowhere on this message to put one.
    expect(
      clientMessageSchema.safeParse({ type: 'reroll_bot', seatId: 'seat_2', seed: 'chosen' })
        .success,
    ).toBe(false);
    expect(clientMessageSchema.safeParse({ type: 'reroll_bot' }).success).toBe(false);
  });

  it('refuse a configuration written by a newer build', () => {
    const future = { ...SETUP, schemaVersion: BOT_CONFIG_SCHEMA_VERSION + 1 };
    expect(clientMessageSchema.safeParse({ type: 'add_bot', setup: future }).success).toBe(false);
  });
});

describe('the bot setup shape', () => {
  it('is a bot configuration minus the identity the server owns', () => {
    const configured = new Set(Object.keys(botSeatConfigSchema.shape));
    const sent = new Set(Object.keys(botSetupSchema.shape));

    expect(configured.has('controller')).toBe(true);
    expect(sent.has('controller')).toBe(false);
    // Everything else the configuration has, the wire carries — derived by
    // omission rather than restated, so widening one cannot leave the other
    // behind.
    for (const field of configured) {
      if (field === 'controller') continue;
      expect(sent.has(field), `\`${field}\` is configured but never sent`).toBe(true);
    }
    expect([...sent].filter((field) => !configured.has(field))).toEqual(['displayName']);
  });

  it('lets the host decline to name the seat', () => {
    expect(botSetupSchema.safeParse({ ...SETUP, displayName: null }).success).toBe(true);
    expect(botSetupSchema.safeParse({ ...SETUP, displayName: '' }).success).toBe(false);
  });
});

/* --------------------------------------------------------------- seat views */

describe('the lobby seat view', () => {
  it('accepts a human seat and a bot seat', () => {
    expect(lobbySeatViewSchema.safeParse(humanSeat()).success).toBe(true);
    expect(lobbySeatViewSchema.safeParse(botSeat(PRIVATE_SAVED_DECK)).success).toBe(true);
  });

  it('refuses a human seat carrying bot configuration', () => {
    const smuggled = { ...humanSeat(), bot: publicBotSeatOf(PRIVATE_SAVED_DECK) };
    expect(lobbySeatViewSchema.safeParse(smuggled).success).toBe(false);
    expect(humanLobbySeatViewSchema.safeParse(smuggled).success).toBe(false);
  });

  it('refuses a bot seat with no configuration behind it', () => {
    expect(lobbySeatViewSchema.safeParse({ ...humanSeat(), controller: 'bot' }).success).toBe(
      false,
    );
  });

  it('refuses a seat that will not say what controls it', () => {
    const { controller: _controller, ...anonymous } = humanSeat();
    expect(lobbySeatViewSchema.safeParse(anonymous).success).toBe(false);
  });

  it('cannot describe a bot that disconnected or is counting down a window', () => {
    // A bot controller lives inside the server: it has nothing to disconnect
    // from and no reconnect window (ADR 0024 §1), so neither state is
    // expressible rather than merely never sent.
    const seat = botSeat(PRIVATE_SAVED_DECK);
    expect(botLobbySeatViewSchema.safeParse({ ...seat, connected: false }).success).toBe(false);
    expect(botLobbySeatViewSchema.safeParse({ ...seat, graceSeconds: 30 }).success).toBe(false);
    // A human seat still can be both, exactly as before.
    expect(
      lobbySeatViewSchema.safeParse({ ...humanSeat(), connected: false, graceSeconds: 30 }).success,
    ).toBe(true);
  });

  it('refuses an unknown member on either kind of seat', () => {
    expect(lobbySeatViewSchema.safeParse({ ...humanSeat(), pilotId: 'value' }).success).toBe(false);
    expect(
      lobbySeatViewSchema.safeParse({ ...botSeat(PRIVATE_SAVED_DECK), pilotId: 'value' }).success,
    ).toBe(false);
  });
});

/* ----------------------------------------------------------------- privacy */

describe('what a lobby view never carries', () => {
  /** Every private value in the two fixtures above, by name. */
  const SECRETS = [
    'card_secret_one',
    'card_secret_two',
    'saved_deck_zzz',
    'deadbeefcafef00d',
    'seed_that_must_not_travel',
  ] as const;

  it('is searching for values the private configuration really holds', () => {
    // Without this, the search below would pass for the wrong reason the day
    // somebody renamed a fixture field.
    const priv = JSON.stringify([PRIVATE_SAVED_DECK, PRIVATE_GENERATED]);
    for (const secret of SECRETS) {
      expect(priv, `"${secret}" is not in the private fixture`).toContain(secret);
    }
  });

  it('keeps the card list, saved-deck identity, hash and seed off the wire', () => {
    const view = {
      inviteCode: 'ABC123',
      status: 'waiting',
      maxSeats: 4,
      hostSeatId: 'seat_1',
      canStart: false,
      seats: [humanSeat(), botSeat(PRIVATE_SAVED_DECK), botSeat(PRIVATE_GENERATED)],
    };
    const parsed = lobbyViewSchema.safeParse(view);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    // Serialised and searched rather than field-checked, because the failure
    // being guarded against is a field being *added* later. The parsed value is
    // what is encoded, so this is the shape a server would actually send.
    const wire = encode({ type: 'lobby_updated', lobby: parsed.data });
    for (const secret of SECRETS) {
      expect(wire, `"${secret}" reached a lobby view`).not.toContain(secret);
    }
  });

  it('still publishes the Commander, which is the fact an opponent needs', () => {
    const seat = botSeat(PRIVATE_SAVED_DECK);
    expect(seat.bot?.deck).toEqual({
      mode: 'exact_saved_deck',
      commanderId: 'commander_grave',
    });
  });

  it('refuses a bot seat whose deck projection grew a card list', () => {
    const seat = botSeat(PRIVATE_SAVED_DECK);
    const widened = {
      ...seat,
      bot: {
        ...seat.bot,
        deck: { mode: 'exact_saved_deck', commanderId: 'commander_grave', cardIds: ['card_a'] },
      },
    };
    expect(lobbySeatViewSchema.safeParse(widened).success).toBe(false);
  });

  it('refuses a bot seat whose deck projection grew a seed', () => {
    const seat = botSeat(PRIVATE_GENERATED);
    const widened = {
      ...seat,
      bot: {
        ...seat.bot,
        deck: { mode: 'commander_generated', commanderId: 'commander_grave', seed: 'leaked' },
      },
    };
    expect(lobbySeatViewSchema.safeParse(widened).success).toBe(false);
  });
});

/* ------------------------------------------------------------ the refusals */

describe('the seven bot refusals', () => {
  it('name every condition a bot-seat request can fail on', () => {
    expect([...BOT_LOBBY_CONDITIONS]).toEqual([
      'table_full',
      'not_host',
      'unknown_bot_seat',
      'config_invalid',
      'deck_illegal',
      'mode_unsupported',
      'lobby_locked',
    ]);
    expect(Object.keys(BOT_LOBBY_ERROR_CODES).sort()).toEqual([...BOT_LOBBY_CONDITIONS].sort());
  });

  it('each produce a structured error a client can parse and act on', () => {
    for (const condition of BOT_LOBBY_CONDITIONS) {
      const built = botLobbyError(condition, [`about ${condition}`]);
      expect(built.code).toBe(BOT_LOBBY_ERROR_CODES[condition]);
      expect(PROTOCOL_ERROR_CODES).toContain(built.code);
      expect(protocolErrorSchema.safeParse(built).success).toBe(true);
      expect(built.message.length).toBeGreaterThan(0);
      expect(built.details).toEqual([`about ${condition}`]);

      const decoded = decodeServerMessage(encode({ type: 'error', error: built }));
      expect(decoded.ok, `${condition} did not survive the wire`).toBe(true);
    }
  });

  it('omit details entirely when there are none, rather than sending an empty list', () => {
    expect(botLobbyError('not_host')).toEqual({
      code: 'protocol/not_host',
      message: 'Only the host can add, configure, reroll or remove a bot.',
    });
  });

  it('reuse a code only where the condition is identical for a person', () => {
    // Sender and lobby conditions are the same fact whoever wanted the seat, so
    // a second name for them would be a vocabulary a client has to learn twice.
    expect(BOT_LOBBY_ERROR_CODES.table_full).toBe('protocol/lobby_full');
    expect(BOT_LOBBY_ERROR_CODES.not_host).toBe('protocol/not_host');
    expect(BOT_LOBBY_ERROR_CODES.lobby_locked).toBe('protocol/already_started');
  });

  it('mint a new code where the condition is about a bot seat', () => {
    expect(BOT_LOBBY_ERROR_CODES.unknown_bot_seat).toBe('protocol/unknown_bot_seat');
    expect(BOT_LOBBY_ERROR_CODES.config_invalid).toBe('protocol/bot_config_invalid');
    expect(BOT_LOBBY_ERROR_CODES.mode_unsupported).toBe('protocol/bot_mode_unsupported');
    // Distinct from `protocol/deck_illegal`, which is about the deck the
    // recipient submitted themselves and travels in `deck_rejected`. A host
    // must be able to tell whose deck the server means.
    expect(BOT_LOBBY_ERROR_CODES.deck_illegal).toBe('protocol/bot_deck_illegal');
    expect(BOT_LOBBY_ERROR_CODES.deck_illegal).not.toBe('protocol/deck_illegal');
    expect(PROTOCOL_ERROR_CODES).toContain('protocol/deck_illegal');
  });
});
