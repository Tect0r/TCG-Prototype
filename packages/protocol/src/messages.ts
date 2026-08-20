import { z } from 'zod';
import {
  botDisplayNameSchema,
  botIdSchema,
  botPacingBudgetsSchema,
  botSeatConfigSchema,
  botSeatPublicSchema,
  botStyleSettingSchema,
  generatedDeckProvenanceSchema,
} from '@tcg/bot-config';
import { CARD_SCHEMA_VERSION } from '@tcg/card-data';
import { savedDeckSchema } from '@tcg/deck';
import {
  actionSchema,
  engineErrorSchema,
  gameEventSchema,
  playerViewSchema,
  RULES_VERSION,
} from '@tcg/rules-engine';

/**
 * The wire contract between the deck-builder client and the authoritative
 * server. Every message is validated on receipt at both ends: the network is an
 * external boundary like any other (CLAUDE.md §14).
 *
 * Bump `PROTOCOL_VERSION` whenever a message shape changes incompatibly. The
 * handshake compares versions and refuses to start rather than failing halfway
 * through a match with a confusing error.
 */
/**
 * 5 (M05.3): `PlayerView.pendingChoice` and the `choice_requested` event both
 * carry `provenance`, so the shape a server sends is not one a v4 client can
 * validate. The handshake refuses rather than letting a strict-object parse fail
 * mid-match on the first choice.
 *
 * 6 (M06.1): every `CardInstanceView` carries `barrierSpent`, so a client can
 * tell a unit that still has its Barrier from one that has spent it — which is
 * part of the Q42 grouping key and would otherwise put two units that answer
 * combat differently under one badge. `playerViewSchema` is a strict object, so
 * a v5 client would reject the first view it was sent; the handshake refuses
 * first, and says why. `MATCH_SCHEMA_VERSION` deliberately does **not** move:
 * `barrierSpent` has been on `CardInstance` since the keyword shipped, and it is
 * the projection that changed rather than the state.
 *
 * Deliberately **not** moved by `CARD_SCHEMA_VERSION` 4 → 5 (M07.9). Card schema
 * and protocol are separate contracts, and this is the case that shows why:
 * `entity_or_player` widened the *card definition* language, and no message
 * carries a card definition. `divide_damage` already sent a flat list of IDs and
 * `select_players` already put player IDs in `validEntityIds`, so a mixed pool is
 * a wider value in an unchanged field. A v6 client and a v6 server disagreeing
 * about card schema is not a message-shape problem, and it already has its own
 * answer: `cardSchema` is a separate entry in `versionsSchema` and the handshake
 * below refuses on it independently. Bumping this too would refuse the same pair
 * twice and, worse, would teach that the two versions move together.
 *
 * 7 (M09.2): a lobby seat now says what controls it. `lobbySeatViewSchema` is a
 * discriminated union on `controller`, and a bot seat carries the safe subset of
 * its configuration — difficulty, style, pacing and the Commander-level deck
 * projection — beside the fields a human seat already had. A v6 client validates
 * a seat view against a strict object with no `controller` member, so the first
 * lobby view a v7 server sent it would fail to parse in the middle of a lobby;
 * the handshake refuses first and says which side is older. The four host-only
 * bot messages travel the other way and a v6 server would reject them as
 * malformed for the same reason.
 *
 * It is made here rather than in M09.1 because M09.1 put nothing on a wire:
 * moving it then would have refused compatible builds over a shape they never
 * sent. The bot configuration's own versions — `BOT_CONFIG_SCHEMA_VERSION`,
 * `DIFFICULTY_REGISTRY_VERSION` and `PACING_CONFIG_VERSION` — stay separate and
 * deliberately do **not** move with it, because a difficulty can improve without
 * a message shape changing. `MATCH_SCHEMA_VERSION` and `RULES_VERSION` do not
 * move either: a bot seat is a controller above the engine, `MatchState` never
 * learns what a bot is, and a bot waiting is not a rules change.
 *
 * 8 (M09.9): a generated bot deck has two audiences the lobby view cannot serve.
 * The **host** needs the provenance of a deck the server built for them — seed,
 * generator version, mode, Commander, deck hash and the forced-inclusion floor
 * the format left — and that is private to the host, so it cannot ride on a
 * `lobbyView` every seat receives. **Everyone** may see a bot's list once the
 * match is over, which is the other half of the privacy rule
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §3) and is not
 * a lobby fact at all. Two new server messages carry them, and
 * `serverMessageSchema` is a discriminated union parsed on receipt: a v7 client
 * would fail to decode the first of either, mid-lobby or at the moment the match
 * ends. The handshake refuses first and says which side is older.
 *
 * ADR 0024 §7 predicted this constant would move **once** in M09, in M09.2. That
 * prediction did not survive contact with M09.9's own acceptance line — "the list
 * ... is revealed or exported after completion" cannot be delivered without a
 * message that carries a list — so the ADR now records the correction rather than
 * the guess. The principle it was expressing is unchanged and is what governs
 * here: the version moves where the *shape* moves, and nowhere else.
 *
 * 9 (M09.11): a lobby now has pacing budgets, and the host can change them.
 * `lobbyViewSchema` is a strict object and gains a required `botPacing` member,
 * so a v8 client would fail to parse the first lobby view a v9 server sent it —
 * the same failure mode M09.2's widened seat view had. `set_bot_pacing` travels
 * the other way and a v8 server would reject it as malformed for the same
 * reason.
 *
 * The budgets are on the *lobby view* rather than on each bot seat because they
 * belong to the table: every seat needs them to turn a bot's public percentage
 * into the seconds beside it, and a copy per seat would be three chances for
 * them to disagree. `PACING_CONFIG_VERSION` deliberately does **not** move with
 * this: the shape and the calculation `@tcg/bot-config` owns are exactly what
 * they were in M09.1, and this is the wire learning to carry them.
 * `RULES_VERSION` does not move either — a budget is lobby configuration, not a
 * rule, and open-questions.md Q8 is still open (ADR 0024 §4).
 *
 * 10 (M09.16): a bot seat now says where its style came from. `botSeatPublicSchema`
 * is a strict object and gains a required `styleSetting`, so a v9 client would
 * fail to parse the first lobby view a v10 server sent it that held a bot — the
 * same failure mode M09.2 and M09.11 both had. `botSetupSchema` travels the other
 * way with a widened `style`, and a v9 server would reject `style: "automatic"`
 * as an invalid enum member: it has no mapping to resolve it with, so refusing is
 * the correct answer rather than a compatibility gap to paper over.
 *
 * `BOT_CONFIG_SCHEMA_VERSION` moves 1 → 2 alongside it, and that is deliberately
 * *not* redundant: the two answer different questions. This constant refuses a
 * peer whose messages this build cannot decode; that one refuses a bot
 * configuration record written by a newer build. `DIFFICULTY_REGISTRY_VERSION`
 * stays 2 — no difficulty was added, removed, or changed status — and
 * `PACING_CONFIG_VERSION`, `MATCH_SCHEMA_VERSION` and `RULES_VERSION` stay where
 * they are, because deriving a style from an authored deck plan is a lobby
 * decision above the engine and no rule changed.
 */
export const PROTOCOL_VERSION = 10;

/** Everything a client and server must agree on before a match can start. */
export const versionsSchema = z.strictObject({
  protocol: z.number().int().min(1),
  rules: z.string().min(1),
  cardSchema: z.number().int().min(1),
});
export type Versions = z.infer<typeof versionsSchema>;

export const CURRENT_VERSIONS: Versions = {
  protocol: PROTOCOL_VERSION,
  rules: RULES_VERSION,
  cardSchema: CARD_SCHEMA_VERSION,
};

export const inviteCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]{6}$/, 'Invite codes are six upper-case letters and digits.');

export const displayNameSchema = z.string().trim().min(1).max(24);

/** Opaque: the client stores it and sends it back, and never interprets it. */
export const reconnectTokenSchema = z.string().min(16).max(128);

/** Up to four seats. Two is a 1v1; three or four is a free-for-all. */
export const SEAT_IDS = ['seat_1', 'seat_2', 'seat_3', 'seat_4'] as const;
export const seatIdSchema = z.enum(SEAT_IDS);
export type SeatId = z.infer<typeof seatIdSchema>;

export const MIN_SEATS = 2;
export const MAX_SEATS = 4;
export const seatCountSchema = z.number().int().min(MIN_SEATS).max(MAX_SEATS);

/**
 * How many seats at one table may hold a bot (M09.7).
 *
 * One fewer than the table can hold, because every table keeps at least one
 * human: M09 exists so a person can play against the software, and a lobby of
 * nothing but bots is a match nobody asked for. It lives beside `MAX_SEATS`
 * rather than in the server because the host's screen has to know how many bots
 * it may still offer to seat, and two copies of that number would eventually
 * disagree. It is not on a wire — no message carries a bot count — so moving it
 * would not move `PROTOCOL_VERSION`.
 */
export const MAX_BOT_SEATS = MAX_SEATS - 1;

export const LOBBY_STATUSES = ['waiting', 'ready', 'in_match', 'finished', 'closed'] as const;
export const lobbyStatusSchema = z.enum(LOBBY_STATUSES);
export type LobbyStatus = z.infer<typeof lobbyStatusSchema>;

/** What a seat shows whatever is sitting in it. Never published on its own. */
const lobbySeatViewBase = z.strictObject({
  seatId: seatIdSchema,
  displayName: displayNameSchema,
  connected: z.boolean(),
  ready: z.boolean(),
  /** Name of the submitted deck, or null when nothing has been submitted yet. */
  deckName: z.string().nullable(),
  deckLegal: z.boolean(),
  isHost: z.boolean(),
  /** Seconds left in this seat's reconnect window, when it is disconnected. */
  graceSeconds: z.number().int().min(0).nullable(),
  /** Out of the match, watching only (CLAUDE.md §12). */
  eliminated: z.boolean(),
});

/**
 * A seat with a person in it. `bot` is `z.null()` rather than absent, so a human
 * seat cannot carry bot configuration even by accident.
 */
export const humanLobbySeatViewSchema = lobbySeatViewBase.extend({
  controller: z.literal('human'),
  bot: z.null(),
});
export type HumanLobbySeatView = z.infer<typeof humanLobbySeatViewSchema>;

/**
 * A seat with a bot in it, carrying **only** the safe subset of its
 * configuration: `botSeatPublicSchema` is the projection `publicBotSeatOf`
 * produces, and it has no card list, generator seed, deck hash or saved-deck
 * identity to leak — the privacy rule is a type rather than a habit
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §3).
 *
 * `connected` and `graceSeconds` are narrowed to `true` and `null`. A bot
 * controller lives inside the authoritative server: it has no connection to
 * lose and no reconnect window to count down, and pinning both here means a
 * disconnected bot is not something the wire can even describe (§1).
 */
export const botLobbySeatViewSchema = lobbySeatViewBase.extend({
  controller: z.literal('bot'),
  connected: z.literal(true),
  graceSeconds: z.null(),
  bot: botSeatPublicSchema,
});
export type BotLobbySeatView = z.infer<typeof botLobbySeatViewSchema>;

/**
 * A seat, discriminated by what controls it.
 *
 * A union rather than one object with an optional `bot` member, because the
 * invariant worth having — bot configuration appears exactly when the controller
 * is a bot — is then structural instead of a refinement somebody can forget to
 * run.
 */
export const lobbySeatViewSchema = z.discriminatedUnion('controller', [
  humanLobbySeatViewSchema,
  botLobbySeatViewSchema,
]);
export type LobbySeatView = z.infer<typeof lobbySeatViewSchema>;

export const lobbyViewSchema = z.strictObject({
  inviteCode: inviteCodeSchema,
  status: lobbyStatusSchema,
  /** Seats the host opened. Empty seats cannot be filled once the match starts. */
  maxSeats: seatCountSchema,
  /** Only the host may change the size or start the match (open-questions.md Q36). */
  hostSeatId: seatIdSchema,
  canStart: z.boolean(),
  seats: z.array(lobbySeatViewSchema),
  /**
   * This table's bot pacing budgets (M09.11), and the frozen ones once the match
   * has started.
   *
   * Public rather than host-only, because a bot's percentage already is: a
   * percentage without the budget it is a percentage *of* is not a number
   * anybody can read, and the seconds it implies are observable with a stopwatch
   * from the other side of the table anyway. They are **bot pacing references,
   * not human timers** — nothing in the protocol times out, passes for, or
   * defeats a person, and open-questions.md Q8 stays open (ADR 0024 §4).
   */
  botPacing: botPacingBudgetsSchema,
});
export type LobbyView = z.infer<typeof lobbyViewSchema>;

/* ---------------------------------------------------------------- bot setup */

/**
 * What a host sends to configure a bot seat: a bot's whole configuration except
 * the identity the server owns.
 *
 * Derived from `botSeatConfigSchema` by omission rather than restated, so the
 * shape has exactly one definition and widening it in `@tcg/bot-config` cannot
 * leave the wire behind. `botId` is deliberately not on this wire at all — it is
 * server-generated and stable for the life of the seat, and a client able to
 * choose one could collide with another seat's. `displayName` is nullable
 * because naming the seat is the server's job when the host does not care.
 *
 * `.omit` and `.extend` both preserve the strict object, so an unknown member is
 * still a parse failure rather than a field that survives to be read later by
 * something that trusts it.
 *
 * **`style` here is the host's *setting*, not the bot's style** (M09.16). The
 * configured `styleSetting`/`style` pair is one question at this end of the wire
 * and two at the other: a host sets one control, and the server resolves what it
 * means once it knows the Commander the bot will actually lead — which for an
 * `autonomous_generated` seat it does not know until it has generated the deck.
 * Both configured members are therefore omitted and one settable `style` put
 * back, so a client cannot state a resolved style and a server cannot receive
 * one it did not derive.
 */
export const botSetupSchema = botSeatConfigSchema
  .omit({ controller: true, style: true, styleSetting: true })
  .extend({
    displayName: botDisplayNameSchema.nullable(),
    style: botStyleSettingSchema,
  });
export type BotSetup = z.infer<typeof botSetupSchema>;

/* ----------------------------------------------------------- client → server */

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('create_lobby'),
    versions: versionsSchema,
    displayName: displayNameSchema,
    /** How many seats the table has. Defaults to a 1v1. */
    maxSeats: seatCountSchema.default(MIN_SEATS),
  }),
  /** Host-only: resize the table before the match starts. */
  z.strictObject({
    type: z.literal('set_max_seats'),
    maxSeats: seatCountSchema,
  }),
  /**
   * Host-only: begin with everyone who is seated and ready. A free-for-all does
   * not start by itself, because "everyone ready" is a legal state at two of
   * four seats and only the host knows whether they are still waiting.
   */
  z.strictObject({ type: z.literal('start_match') }),
  /**
   * Host-only: put a bot in a free seat.
   *
   * No seat ID, because the server allocates seats deterministically in seat
   * order and a client picking one could race a joining human for it — and
   * because a bot never displaces anybody: a full table is refused rather than
   * resolved (ADR 0024 §1).
   */
  z.strictObject({
    type: z.literal('add_bot'),
    setup: botSetupSchema,
  }),
  /**
   * Host-only: replace one bot seat's configuration wholesale.
   *
   * A whole configuration rather than a patch, so that "what this seat is set to"
   * has one representation on the wire and a partial update cannot leave a seat
   * in a combination nothing validated.
   */
  z.strictObject({
    type: z.literal('update_bot'),
    seatId: seatIdSchema,
    setup: botSetupSchema,
  }),
  /**
   * Host-only: build this bot a new deck. Meaningful only for the generated
   * modes, and the new seed is derived by the server — a client-supplied seed
   * would make the recorded seed transition something a client could invent.
   */
  z.strictObject({
    type: z.literal('reroll_bot'),
    seatId: seatIdSchema,
  }),
  /** Host-only: free the seat. A human joining never does this implicitly. */
  z.strictObject({
    type: z.literal('remove_bot'),
    seatId: seatIdSchema,
  }),
  /**
   * Host-only: set this table's bot pacing budgets (M09.11).
   *
   * A whole budget record rather than one field, for the reason `update_bot`
   * carries a whole configuration: "what this table is set to" then has one
   * representation on the wire, and a partial update cannot leave a lobby in a
   * combination nothing validated.
   *
   * It is a lobby message rather than part of a bot's setup because the budgets
   * are the table's: three bots at 50% are three bots waiting half of *one*
   * number, and a copy per seat would be three chances for them to disagree.
   * Per-bot percentages travel in `botSetupSchema.pacing`, where they already
   * have since M09.2.
   */
  z.strictObject({
    type: z.literal('set_bot_pacing'),
    budgets: botPacingBudgetsSchema,
  }),
  z.strictObject({
    type: z.literal('join_lobby'),
    versions: versionsSchema,
    inviteCode: inviteCodeSchema,
    displayName: displayNameSchema,
  }),
  z.strictObject({
    type: z.literal('reconnect'),
    versions: versionsSchema,
    reconnectToken: reconnectTokenSchema,
  }),
  z.strictObject({
    type: z.literal('submit_deck'),
    deck: savedDeckSchema,
  }),
  /**
   * Play a built-in precon, by permanent ID rather than by contents.
   *
   * The list is never sent: the server resolves the ID against its own bundled
   * precons and materialises the deck itself, so the definition it validates is
   * the definition the client displayed and a client cannot smuggle an edited
   * list in under a precon's name (M03.2). An edited copy is an ordinary deck
   * and goes back through `submit_deck`, where it is validated on its contents.
   */
  z.strictObject({
    type: z.literal('submit_precon'),
    preconId: z.string().min(1).max(64),
  }),
  z.strictObject({
    type: z.literal('set_ready'),
    ready: z.boolean(),
  }),
  z.strictObject({
    type: z.literal('submit_action'),
    /**
     * Client-generated and unique. Replaying the same ID is a no-op, so a
     * reconnect or a retry can never play a card twice (CLAUDE.md §11).
     */
    actionId: z.string().min(1).max(64),
    /** Sequence number of the last event the client had when it decided. */
    lastSequence: z.number().int().min(0),
    action: actionSchema,
  }),
  z.strictObject({ type: z.literal('leave') }),
  z.strictObject({ type: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type ClientMessageInput = z.input<typeof clientMessageSchema>;

/**
 * The messages only the host may send, in one place rather than in a condition
 * per handler.
 *
 * It was a two-member list of comments until M09.2 tripled it, and a rule about
 * who may send what is worth stating once: the server checks membership here, so
 * adding a host-only message and forgetting the check is not a thing that can
 * happen quietly. Every member is refused from another seat with
 * `protocol/not_host`.
 */
export const HOST_ONLY_CLIENT_MESSAGE_TYPES = [
  'set_max_seats',
  'start_match',
  'add_bot',
  'update_bot',
  'reroll_bot',
  'remove_bot',
  'set_bot_pacing',
] as const satisfies readonly ClientMessage['type'][];
export type HostOnlyClientMessageType = (typeof HOST_ONLY_CLIENT_MESSAGE_TYPES)[number];

export function isHostOnlyClientMessage(type: ClientMessage['type']): boolean {
  return (HOST_ONLY_CLIENT_MESSAGE_TYPES as readonly string[]).includes(type);
}

/* ----------------------------------------------------------- server → client */

export const PROTOCOL_ERROR_CODES = [
  'protocol/malformed_message',
  'protocol/version_mismatch',
  'protocol/unknown_lobby',
  'protocol/lobby_full',
  'protocol/not_in_lobby',
  'protocol/unknown_token',
  'protocol/seat_taken',
  'protocol/deck_illegal',
  'protocol/deck_required',
  'protocol/unknown_precon',
  'protocol/not_started',
  'protocol/already_started',
  'protocol/stale_revision',
  'protocol/wrong_seat',
  'protocol/not_host',
  'protocol/not_enough_players',
  'protocol/internal',
  /* --- bot seats (M09.2). See `BOT_LOBBY_ERROR_CODES` for why only four. --- */
  'protocol/unknown_bot_seat',
  'protocol/bot_config_invalid',
  'protocol/bot_deck_illegal',
  'protocol/bot_mode_unsupported',
] as const;
export const protocolErrorCodeSchema = z.enum(PROTOCOL_ERROR_CODES);
export type ProtocolErrorCode = z.infer<typeof protocolErrorCodeSchema>;

export const protocolErrorSchema = z.strictObject({
  code: protocolErrorCodeSchema,
  message: z.string().min(1),
  /** Deck legality issues, version details, and similar actionable context. */
  details: z.array(z.string()).optional(),
});
export type ProtocolError = z.infer<typeof protocolErrorSchema>;

/* ------------------------------------------------- the seven bot refusals */

/**
 * Every way a bot-seat request can be refused, named by the condition rather
 * than by the code, because the condition is what the host has to fix.
 *
 * M09.3 acts on these; M09.2 owns the vocabulary so that the server does not
 * have to invent a wording per call site, and so that "the seven refusals" is a
 * list something can be tested against.
 */
export const BOT_LOBBY_CONDITIONS = [
  'table_full',
  'not_host',
  'unknown_bot_seat',
  'config_invalid',
  'deck_illegal',
  'mode_unsupported',
  'lobby_locked',
] as const;
export const botLobbyConditionSchema = z.enum(BOT_LOBBY_CONDITIONS);
export type BotLobbyCondition = z.infer<typeof botLobbyConditionSchema>;

/**
 * The code each condition is reported with. Seven conditions, four new codes.
 *
 * Three reuse a code that already means exactly this, because the condition is
 * about the **sender or the lobby** and is identical whether the request was
 * about a bot or a person: a table with no free seat is `protocol/lobby_full`
 * whoever wanted the seat, a sender who is not the host is `protocol/not_host`
 * whatever they asked for, and a lobby that has started is
 * `protocol/already_started` regardless. Minting `protocol/bot_not_host` beside
 * `protocol/not_host` would be a second name for one fact, and a client would
 * have to learn both to handle either.
 *
 * The other four are about a **bot seat or its configuration**, and have no
 * existing equivalent. `protocol/bot_deck_illegal` is deliberately not
 * `protocol/deck_illegal`: that one is about the deck the *recipient themselves*
 * submitted and travels in `deck_rejected`, so reusing it would leave a host
 * unable to tell whose deck the server is complaining about without remembering
 * which message they sent last.
 */
export const BOT_LOBBY_ERROR_CODES: Readonly<Record<BotLobbyCondition, ProtocolErrorCode>> =
  Object.freeze({
    table_full: 'protocol/lobby_full',
    not_host: 'protocol/not_host',
    unknown_bot_seat: 'protocol/unknown_bot_seat',
    config_invalid: 'protocol/bot_config_invalid',
    deck_illegal: 'protocol/bot_deck_illegal',
    mode_unsupported: 'protocol/bot_mode_unsupported',
    lobby_locked: 'protocol/already_started',
  });

/** What each refusal says. Written for the host, who is the only one who sees it. */
const BOT_LOBBY_MESSAGES: Readonly<Record<BotLobbyCondition, string>> = Object.freeze({
  table_full:
    'Every seat at this table is taken. Open more seats or remove one before adding a bot.',
  not_host: 'Only the host can add, configure, reroll or remove a bot.',
  unknown_bot_seat: 'That seat does not hold a bot.',
  config_invalid: 'That bot configuration cannot be read.',
  deck_illegal: "That bot's deck is not legal in this format.",
  mode_unsupported: 'This build cannot play that bot deck mode yet.',
  lobby_locked: 'The match has started, so bot seats are locked.',
});

/**
 * The one place a bot refusal is built.
 *
 * `details` carries the actionable specifics the condition alone cannot — which
 * deck rules failed, which tranche owns the unsupported mode, which version a
 * configuration was written against.
 */
export function botLobbyError(
  condition: BotLobbyCondition,
  details?: readonly string[],
): ProtocolError {
  return protocolError(BOT_LOBBY_ERROR_CODES[condition], BOT_LOBBY_MESSAGES[condition], details);
}

/* ------------------------------------------- generated bot decks (M09.9) */

/**
 * What the **host alone** learns about a bot seat whose deck the server built.
 *
 * Every field is already defined by `generatedDeckProvenanceSchema` in
 * `@tcg/bot-config`, which has been asking for exactly these since M09.1: the
 * generator version and construction mode that produced the list, the seed after
 * any rerolls and how many there were, the Commander, the deck's content hash,
 * and the size of the legal pool with the forced-inclusion floor it implies.
 *
 * It is a separate message rather than a field on the seat view because of who
 * may read it. A `LobbyView` goes to every seat, and a seed is the one value
 * that turns "the Commander is public" back into "the list is public": anybody
 * holding the seed, the Commander and the generator can rebuild the deck card
 * for card. The public projection therefore has no seed to strip
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §3), and this
 * travels down the host's own connection instead.
 */
export const botSeatProvenanceSchema = z.strictObject({
  seatId: seatIdSchema,
  generated: generatedDeckProvenanceSchema,
});
export type BotSeatProvenance = z.infer<typeof botSeatProvenanceSchema>;

/**
 * One bot's actual list, published after the match is over.
 *
 * `cardIds` lists every copy separately, exactly as `botDeckSnapshotSchema`
 * does, so a reader never has to know whether a format is singleton to count a
 * deck. `generated` is `null` for a bot playing an exact list — a precon or one
 * of the host's saved decks — because there is no generator to cite.
 *
 * There is deliberately no hash here. The cards are in the message, so anybody
 * who wants a fingerprint can take one; carrying a second one beside them would
 * only create something to disagree with, and the two the project already has —
 * `DECK_FINGERPRINT_VERSION` in `@tcg/deck` and `HASH_VERSION` in
 * `@tcg/deck-generator` — answer different questions and would not match.
 */
export const revealedBotDeckSchema = z.strictObject({
  seatId: seatIdSchema,
  botId: botIdSchema,
  displayName: botDisplayNameSchema,
  commanderId: z.string().min(1),
  cardIds: z.array(z.string().min(1)),
  generated: generatedDeckProvenanceSchema.nullable(),
});
export type RevealedBotDeck = z.infer<typeof revealedBotDeckSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('lobby_joined'),
    versions: versionsSchema,
    seatId: seatIdSchema,
    reconnectToken: reconnectTokenSchema,
    lobby: lobbyViewSchema,
  }),
  z.strictObject({
    type: z.literal('lobby_updated'),
    lobby: lobbyViewSchema,
  }),
  z.strictObject({
    type: z.literal('deck_rejected'),
    error: protocolErrorSchema,
  }),
  z.strictObject({
    type: z.literal('match_state'),
    /** The seat's redacted view. Authoritative state is never sent. */
    view: playerViewSchema,
    /** Events since the client's last known sequence, already redacted. */
    events: z.array(gameEventSchema),
  }),
  z.strictObject({
    type: z.literal('action_rejected'),
    actionId: z.string(),
    error: z.union([engineErrorSchema, protocolErrorSchema]),
  }),
  /**
   * One other seat's connection changed. Named per seat rather than
   * "the opponent" because a free-for-all has up to three of them, and one
   * dropping does not stop the match (CLAUDE.md §12).
   */
  z.strictObject({
    type: z.literal('seat_connection'),
    seatId: seatIdSchema,
    connected: z.boolean(),
    /** Seconds left before a disconnect becomes a loss, when disconnected. */
    graceSeconds: z.number().int().min(0).nullable(),
  }),
  /**
   * Host-only: the provenance of every bot seat whose deck this server built.
   *
   * A complete replacement rather than a delta, and sent beside every lobby
   * update the host receives, so the host's picture cannot drift out of step
   * with the seats it describes. A seat playing an exact list contributes no
   * entry, because it has no generator to cite (M09.9).
   */
  z.strictObject({
    type: z.literal('bot_seat_provenance'),
    seats: z.array(botSeatProvenanceSchema),
  }),
  /**
   * Every bot's list, once the match is complete — the second half of "public at
   * the Commander, private at the list" (ADR 0024 §3).
   *
   * Broadcast to every seat rather than to the host, because the host already
   * knows: the promise the privacy rule makes is to the *opponents*, and it is
   * only kept if they are the ones who eventually get to read the list. Sent
   * once, at the moment the match's status becomes complete, which is the
   * earliest instant at which no hidden information is left to protect.
   */
  z.strictObject({
    type: z.literal('bot_decks_revealed'),
    decks: z.array(revealedBotDeckSchema),
  }),
  z.strictObject({
    type: z.literal('error'),
    error: protocolErrorSchema,
  }),
  z.strictObject({ type: z.literal('pong') }),
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function protocolError(
  code: ProtocolErrorCode,
  message: string,
  details?: readonly string[],
): ProtocolError {
  return details === undefined ? { code, message } : { code, message, details: [...details] };
}

/**
 * Two version sets are compatible only when they match exactly. There is no
 * negotiation in v0.1: a mismatch is a clear, actionable message rather than a
 * silent behaviour difference between the two sides of a match.
 */
export function versionMismatch(client: Versions, server: Versions): string[] {
  const problems: string[] = [];
  if (client.protocol !== server.protocol) {
    problems.push(`protocol ${client.protocol} vs server ${server.protocol}`);
  }
  if (client.rules !== server.rules) {
    problems.push(`rules ${client.rules} vs server ${server.rules}`);
  }
  if (client.cardSchema !== server.cardSchema) {
    problems.push(`card schema ${client.cardSchema} vs server ${server.cardSchema}`);
  }
  return problems;
}
