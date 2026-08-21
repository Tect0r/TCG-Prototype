import { describe, expect, it } from 'vitest';
import {
  BOT_CONFIG_SCHEMA_VERSION,
  DEFAULT_BOT_PACING_BUDGETS,
  DIFFICULTY_REGISTRY_VERSION,
  PACING_CONFIG_VERSION,
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
  botSeatProvenanceSchema,
  botSetupSchema,
  clientMessageSchema,
  humanLobbySeatViewSchema,
  isHostOnlyClientMessage,
  lobbySeatViewSchema,
  lobbyViewSchema,
  protocolErrorSchema,
  revealedBotDeckSchema,
  serverMessageSchema,
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
  styleSetting: 'value',
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
  it('moved for the shapes each bot tranche put on the wire', () => {
    // 7 was M09.2's seat view and host-only messages; 8 is M09.9's two
    // generated-deck messages, which is the correction ADR 0024 §7 now records
    // in place of its "moves once" prediction; 9 is M09.11's lobby pacing
    // budgets — a required member on a strict lobby view, and a fifth host-only
    // message travelling the other way; 10 is M09.16's `styleSetting`, a
    // required member on the strict public seat and a widened `style` on the
    // setup travelling back; 11 is M09.17's `bot_pacing_summary`, a sixth server
    // message in a discriminated union parsed on receipt.
    expect(PROTOCOL_VERSION).toBe(11);
    expect(CURRENT_VERSIONS.protocol).toBe(11);
  });

  it('refuses the build that came before it, by name', () => {
    const older: Versions = { ...CURRENT_VERSIONS, protocol: 10 };
    expect(versionMismatch(older, CURRENT_VERSIONS)).toEqual(['protocol 10 vs server 11']);
  });

  it('does not drag the bot configuration versions along with it', () => {
    // A difficulty can improve without a message shape changing, which is the
    // whole reason these are separate constants (ADR 0024 §7). M09.13 is the
    // demonstration rather than the theory: `easy` went from planned to
    // available, the registry version moved 1 → 2, and `PROTOCOL_VERSION` did
    // not — because `botDifficultySchema` already carried the ID and no shape
    // on any wire changed.
    //
    // M09.16 is the demonstration of the *other* direction, and of why the two
    // still are not one constant: the configuration's shape widened, so
    // `BOT_CONFIG_SCHEMA_VERSION` moved 1 → 2 and `PROTOCOL_VERSION` moved 9 →
    // 10 together — while `DIFFICULTY_REGISTRY_VERSION` sat still, because no
    // difficulty was added, removed, or changed status.
    //
    // M09.17 is the third direction: a message shape appeared and *neither* bot
    // configuration constant moved, because a summary is a record about a
    // configuration rather than a configuration. The summary's own
    // `BOT_SUMMARY_SCHEMA_VERSION` is what moves when its shape does.
    //
    // M09.20 is the first direction again, four tranches later: `hard` went from
    // planned to available and every definition gained a tactical profile, so
    // `DIFFICULTY_REGISTRY_VERSION` moved 2 - 3 on its own. No message shape
    // changed, because `botDifficultySchema` has carried the ID since M09.1 and
    // the profile is a fact about the server's registry rather than anything on
    // a wire, so `PROTOCOL_VERSION` and `BOT_CONFIG_SCHEMA_VERSION` both sat
    // still.
    expect(BOT_CONFIG_SCHEMA_VERSION).toBe(2);
    expect(DIFFICULTY_REGISTRY_VERSION).toBe(3);
    expect(PROTOCOL_VERSION).toBe(11);
    // And the handshake still compares three things, not five: a bot's
    // configuration is not something two builds must agree on to play at all.
    expect(Object.keys(CURRENT_VERSIONS).sort()).toEqual(['cardSchema', 'protocol', 'rules']);
  });
});

/* -------------------------------------------------------- pacing on the wire */

describe('a lobby view carries the table’s pacing budgets', () => {
  const view = {
    inviteCode: 'ABC123',
    status: 'waiting',
    maxSeats: 2,
    hostSeatId: 'seat_1',
    canStart: false,
    seats: [humanSeat()],
    botPacing: DEFAULT_BOT_PACING_BUDGETS,
  };

  it('requires them, because a percentage without a budget is unreadable', () => {
    expect(lobbyViewSchema.safeParse(view).success).toBe(true);
    const { botPacing, ...without } = view;
    expect(botPacing).toBeDefined();
    // A v8 view is not a v9 view: this is exactly the shape change the protocol
    // version moved for (M09.11).
    expect(lobbyViewSchema.safeParse(without).success).toBe(false);
  });

  it('refuses a budget this build would not honour', () => {
    for (const bad of [
      { ...DEFAULT_BOT_PACING_BUDGETS, ordinarySeconds: 0 },
      { ...DEFAULT_BOT_PACING_BUDGETS, reactionSeconds: 2.5 },
      { ...DEFAULT_BOT_PACING_BUDGETS, pacingVersion: PACING_CONFIG_VERSION + 1 },
      { ...DEFAULT_BOT_PACING_BUDGETS, ordinaryMinutes: 1 },
    ]) {
      expect(lobbyViewSchema.safeParse({ ...view, botPacing: bad }).success).toBe(false);
      expect(clientMessageSchema.safeParse({ type: 'set_bot_pacing', budgets: bad }).success).toBe(
        false,
      );
    }
  });

  it('is the table’s, and a seat’s percentage is the bot’s', () => {
    const seat = botSeat(PRIVATE_SAVED_DECK);
    // Two independent axes on one wire: the budget is not on the seat, and the
    // percentage is not on the lobby (ADR 0024 §5).
    expect(seat.bot?.pacing).toEqual(PRIVATE_SAVED_DECK.pacing);
    expect(JSON.stringify(seat)).not.toContain('ordinarySeconds');
    expect(JSON.stringify(view.botPacing)).not.toContain('percent');
  });
});

/* ------------------------------------------------------------ the messages */

describe('the five host-only bot messages', () => {
  const messages: readonly ClientMessage[] = [
    { type: 'add_bot', setup: SETUP },
    { type: 'update_bot', seatId: 'seat_2', setup: SETUP },
    { type: 'reroll_bot', seatId: 'seat_2' },
    { type: 'remove_bot', seatId: 'seat_2' },
    { type: 'set_bot_pacing', budgets: DEFAULT_BOT_PACING_BUDGETS },
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
    //
    // `styleSetting` is the one exception, and it is an omission in the same
    // spirit rather than a hole in the rule: the pair `styleSetting`/`style` is
    // one question at the sending end, so the wire carries one settable `style`
    // and the server derives the other member from the Commander it resolves
    // (M09.16). A client that could send both could state a resolved style.
    for (const field of configured) {
      if (field === 'controller' || field === 'styleSetting') continue;
      expect(sent.has(field), `\`${field}\` is configured but never sent`).toBe(true);
    }
    expect([...sent].filter((field) => !configured.has(field))).toEqual(['displayName']);
    // And the settable one really is wider than the configured one.
    expect(botSetupSchema.safeParse({ ...SETUP, style: 'automatic' }).success).toBe(true);
    expect(botSeatConfigSchema.shape.style.safeParse('automatic').success).toBe(false);
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
      botPacing: DEFAULT_BOT_PACING_BUDGETS,
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

/* ----------------------------------------- the two generated-deck messages */

/**
 * What a generated bot deck puts on the wire (M09.9), and to whom.
 *
 * Two messages with deliberately different audiences, which is the whole reason
 * neither of them is a field on the lobby view every seat receives: provenance
 * goes to the host, the list goes to everybody once there is nothing left to
 * protect (ADR 0024 §3).
 */
const PROVENANCE = {
  generatorVersion: '1',
  mode: 'commander_generated',
  formatId: 'precon_wave_1',
  seed: 'lobby-seed:reroll:2',
  rerollCount: 2,
  commanderId: 'goblin_warboss',
  deckHash: 'abcdef0123456789',
  legalPoolSize: 41,
  forcedInclusionFloor: 39,
} as const;

describe('bot_seat_provenance', () => {
  it('carries everything a generated deck is identified by, and survives the wire', () => {
    const message = {
      type: 'bot_seat_provenance' as const,
      seats: [{ seatId: 'seat_2' as const, generated: PROVENANCE }],
    };
    const decoded = decodeServerMessage(encode(message));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toEqual(message);

    // Seed, generator version, construction mode, Commander and hash: the five
    // things M09.9 promises a generated deck can be identified by, plus the pool
    // report the forced-inclusion warning is read from.
    expect(Object.keys(PROVENANCE).sort()).toEqual(
      [
        'commanderId',
        'deckHash',
        'forcedInclusionFloor',
        'formatId',
        'generatorVersion',
        'legalPoolSize',
        'mode',
        'rerollCount',
        'seed',
      ].sort(),
    );
  });

  it('is strict, so a field nothing validated cannot ride along', () => {
    expect(
      botSeatProvenanceSchema.safeParse({
        seatId: 'seat_2',
        generated: PROVENANCE,
        cardIds: ['goblin_scout'],
      }).success,
    ).toBe(false);
  });
});

describe('bot_decks_revealed', () => {
  it('carries a list, and only after the match is what sends it', () => {
    const message = {
      type: 'bot_decks_revealed' as const,
      decks: [
        {
          seatId: 'seat_2' as const,
          botId: 'bot_1',
          displayName: 'Bot 2',
          commanderId: 'goblin_warboss',
          cardIds: ['throwing_knife', 'ashen_vermin'],
          generated: PROVENANCE,
        },
      ],
    };
    const decoded = decodeServerMessage(encode(message));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toEqual(message);
  });

  it('says `null` rather than inventing provenance for an exact list', () => {
    const parsed = revealedBotDeckSchema.safeParse({
      seatId: 'seat_3',
      botId: 'bot_2',
      displayName: 'Bot 3',
      commanderId: 'bastion_commander',
      cardIds: ['throwing_knife'],
      generated: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('carries no hash beside the cards it already contains', () => {
    expect(Object.keys(revealedBotDeckSchema.shape)).not.toContain('deckHash');
  });
});

describe('the server message union', () => {
  it('names both new messages, so an older client fails to decode rather than ignore', () => {
    const types = serverMessageSchema.options.map((option) => option.shape.type.value);
    expect(types).toContain('bot_seat_provenance');
    expect(types).toContain('bot_decks_revealed');
    // A discriminated union has no fallthrough: an unknown type is a refusal.
    expect(decodeServerMessage(encode({ type: 'bot_deck_secret' } as never)).ok).toBe(false);
  });

  it('keeps both of them server-to-client only', () => {
    for (const type of ['bot_seat_provenance', 'bot_decks_revealed']) {
      expect(decodeClientMessage(encode({ type } as never)).ok).toBe(false);
    }
  });
});
