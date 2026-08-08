import { z } from 'zod';
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
export const PROTOCOL_VERSION = 2;

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

export const LOBBY_STATUSES = ['waiting', 'ready', 'in_match', 'finished', 'closed'] as const;
export const lobbyStatusSchema = z.enum(LOBBY_STATUSES);
export type LobbyStatus = z.infer<typeof lobbyStatusSchema>;

export const lobbySeatViewSchema = z.strictObject({
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
});
export type LobbyView = z.infer<typeof lobbyViewSchema>;

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
  'protocol/not_started',
  'protocol/already_started',
  'protocol/stale_revision',
  'protocol/wrong_seat',
  'protocol/not_host',
  'protocol/not_enough_players',
  'protocol/internal',
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
