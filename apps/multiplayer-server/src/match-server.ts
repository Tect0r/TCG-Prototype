import type { CardDatabase } from '@tcg/card-data';
import {
  DEFAULT_DECK_FORMAT,
  validateDeck,
  type DeckFormatConfig,
  type SavedDeck,
} from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  decodeClientMessage,
  protocolError,
  versionMismatch,
  type ClientMessage,
  type ProtocolError,
  type ServerMessage,
  type Versions,
} from '@tcg/protocol';
import {
  applyAction,
  createMatch,
  DEFAULT_RULES_CONFIG,
  eventsSince,
  playerView,
  type Action,
  type MatchDeck,
  type RulesConfig,
} from '@tcg/rules-engine';
import { errorsOf, isErr } from '@tcg/shared';
import {
  bothSeatsReady,
  createSeat,
  generateInviteCode,
  generateReconnectToken,
  lobbyView,
  PLAYER_ID_BY_SEAT,
  seatByToken,
  SEAT_IDS,
  type Lobby,
  type Seat,
} from './lobby.js';

/**
 * Transport-agnostic authoritative server.
 *
 * Everything about lobbies, matches, reconnection and idempotency lives here
 * and is driven by plain `receive(connection, rawMessage)` calls, so the whole
 * protocol is testable without opening a socket. `ws-adapter.ts` is the only
 * file that knows what a WebSocket is.
 */
export interface ServerConnection {
  readonly id: string;
  send(message: ServerMessage): void;
  close(): void;
}

export type ScheduleTimer = (delayMs: number, callback: () => void) => () => void;

export interface MatchServerOptions {
  readonly database: CardDatabase;
  readonly config?: RulesConfig;
  readonly deckFormat?: DeckFormatConfig;
  /** Injectable so invite codes and tokens are deterministic in tests. */
  readonly random?: () => number;
  /** Injectable so the disconnect window can be driven without waiting. */
  readonly schedule?: ScheduleTimer;
  /** Injectable so a match seed is reproducible in tests. */
  readonly seedFor?: (inviteCode: string) => string;
  readonly now?: () => number;
}

interface Attachment {
  readonly lobby: Lobby;
  readonly seat: Seat;
}

const defaultSchedule: ScheduleTimer = (delayMs, callback) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

export class MatchServer {
  readonly #database: CardDatabase;
  readonly #config: RulesConfig;
  readonly #deckFormat: DeckFormatConfig;
  readonly #random: () => number;
  readonly #schedule: ScheduleTimer;
  readonly #seedFor: (inviteCode: string) => string;
  readonly #now: () => number;

  readonly #lobbies = new Map<string, Lobby>();
  readonly #connections = new Map<string, ServerConnection>();
  readonly #attachments = new Map<string, Attachment>();

  constructor(options: MatchServerOptions) {
    this.#database = options.database;
    this.#config = options.config ?? DEFAULT_RULES_CONFIG;
    this.#deckFormat = options.deckFormat ?? DEFAULT_DECK_FORMAT;
    this.#random = options.random ?? Math.random;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#now = options.now ?? Date.now;
    this.#seedFor =
      options.seedFor ?? ((inviteCode) => `${inviteCode}-${this.#now()}-${this.#random()}`);
  }

  get lobbyCount(): number {
    return this.#lobbies.size;
  }

  /** Test/diagnostic access. The authoritative state never leaves the server otherwise. */
  lobbyByCode(inviteCode: string): Lobby | undefined {
    return this.#lobbies.get(inviteCode);
  }

  connect(connection: ServerConnection): void {
    this.#connections.set(connection.id, connection);
  }

  receive(connection: ServerConnection, raw: string): void {
    const decoded = decodeClientMessage(raw);
    if (isErr(decoded)) {
      connection.send({ type: 'error', error: decoded.error });
      return;
    }
    this.handle(connection, decoded.value);
  }

  handle(connection: ServerConnection, message: ClientMessage): void {
    switch (message.type) {
      case 'ping':
        connection.send({ type: 'pong' });
        return;
      case 'create_lobby':
        this.createLobby(connection, message.versions, message.displayName);
        return;
      case 'join_lobby':
        this.joinLobby(connection, message.versions, message.inviteCode, message.displayName);
        return;
      case 'reconnect':
        this.reconnect(connection, message.versions, message.reconnectToken);
        return;
      case 'submit_deck':
        this.submitDeck(connection, message.deck);
        return;
      case 'set_ready':
        this.setReady(connection, message.ready);
        return;
      case 'submit_action':
        this.submitAction(connection, message.actionId, message.lastSequence, message.action);
        return;
      case 'leave':
        this.leave(connection);
        return;
      default:
        connection.send({
          type: 'error',
          error: protocolError('protocol/malformed_message', 'Unrecognised message.'),
        });
    }
  }

  /** Called by the transport when a socket closes for any reason. */
  disconnect(connection: ServerConnection): void {
    this.#connections.delete(connection.id);
    const attachment = this.#attachments.get(connection.id);
    this.#attachments.delete(connection.id);
    if (!attachment) return;

    const { lobby, seat } = attachment;
    if (seat.connectionId !== connection.id) return;
    seat.connectionId = null;

    if (lobby.status === 'in_match' && lobby.state && lobby.state.status !== 'complete') {
      // A disconnected player has a fixed window to come back. Expiry submits an
      // explicit timeout action — the engine never reads a clock (CLAUDE.md §4).
      const graceMs = this.#config.disconnectGraceSeconds * 1000;
      seat.disconnectDeadline = this.#now() + graceMs;
      seat.cancelDisconnectTimer = this.#schedule(graceMs, () => {
        seat.cancelDisconnectTimer = null;
        seat.disconnectDeadline = null;
        this.timeOutSeat(lobby, seat);
      });
    }

    this.broadcastConnection(lobby, seat);
    this.broadcastLobby(lobby);
    this.closeIfAbandoned(lobby);
  }

  /* --------------------------------------------------------------- lobbies */

  private rejectVersions(connection: ServerConnection, versions: Versions): boolean {
    const problems = versionMismatch(versions, CURRENT_VERSIONS);
    if (problems.length === 0) return false;
    connection.send({
      type: 'error',
      error: protocolError(
        'protocol/version_mismatch',
        'This client is not compatible with the server. Reload to pick up the current version.',
        problems,
      ),
    });
    return true;
  }

  private createLobby(connection: ServerConnection, versions: Versions, displayName: string): void {
    if (this.rejectVersions(connection, versions)) return;

    const inviteCode = generateInviteCode(this.#random, new Set(this.#lobbies.keys()));
    const seat = createSeat('seat_1', displayName, generateReconnectToken(this.#random));
    const lobby: Lobby = {
      inviteCode,
      hostSeatId: 'seat_1',
      seats: new Map([['seat_1', seat]]),
      status: 'waiting',
      state: null,
    };
    this.#lobbies.set(inviteCode, lobby);
    this.attach(connection, lobby, seat);
    connection.send({
      type: 'lobby_joined',
      versions: CURRENT_VERSIONS,
      seatId: seat.seatId,
      reconnectToken: seat.reconnectToken,
      lobby: lobbyView(lobby),
    });
  }

  private joinLobby(
    connection: ServerConnection,
    versions: Versions,
    inviteCode: string,
    displayName: string,
  ): void {
    if (this.rejectVersions(connection, versions)) return;

    const lobby = this.#lobbies.get(inviteCode);
    if (!lobby) {
      this.fail(connection, 'protocol/unknown_lobby', `No lobby with code ${inviteCode}.`);
      return;
    }
    const freeSeat = SEAT_IDS.find((seatId) => !lobby.seats.has(seatId));
    if (!freeSeat) {
      this.fail(connection, 'protocol/lobby_full', 'That lobby already has two players.');
      return;
    }

    const seat = createSeat(freeSeat, displayName, generateReconnectToken(this.#random));
    lobby.seats.set(freeSeat, seat);
    this.attach(connection, lobby, seat);

    connection.send({
      type: 'lobby_joined',
      versions: CURRENT_VERSIONS,
      seatId: seat.seatId,
      reconnectToken: seat.reconnectToken,
      lobby: lobbyView(lobby),
    });
    this.broadcastLobby(lobby);
  }

  /**
   * Reclaims a seat with its opaque token. The match is not restarted and no
   * action is replayed: the client simply receives the current view.
   */
  private reconnect(connection: ServerConnection, versions: Versions, token: string): void {
    if (this.rejectVersions(connection, versions)) return;

    for (const lobby of this.#lobbies.values()) {
      const seat = seatByToken(lobby, token);
      if (!seat) continue;

      seat.cancelDisconnectTimer?.();
      seat.cancelDisconnectTimer = null;
      seat.disconnectDeadline = null;

      if (seat.connectionId && seat.connectionId !== connection.id) {
        // A second live connection for one seat: the newest wins, so a stale tab
        // cannot keep acting.
        this.#connections.get(seat.connectionId)?.close();
        this.#attachments.delete(seat.connectionId);
      }

      this.attach(connection, lobby, seat);
      connection.send({
        type: 'lobby_joined',
        versions: CURRENT_VERSIONS,
        seatId: seat.seatId,
        reconnectToken: seat.reconnectToken,
        lobby: lobbyView(lobby),
      });
      if (lobby.state) {
        seat.lastSentSequence = 0;
        this.sendMatchState(lobby, seat);
      }
      this.broadcastConnection(lobby, seat);
      this.broadcastLobby(lobby);
      return;
    }

    this.fail(connection, 'protocol/unknown_token', 'That session has expired.');
  }

  private submitDeck(connection: ServerConnection, deck: SavedDeck): void {
    const attachment = this.#attachments.get(connection.id);
    if (!attachment) {
      this.fail(connection, 'protocol/not_in_lobby', 'Join a lobby first.');
      return;
    }
    const { lobby, seat } = attachment;
    if (lobby.status === 'in_match') {
      this.fail(connection, 'protocol/already_started', 'The match has already started.');
      return;
    }

    // The server validates against its own card database. A client-side
    // legality check is a convenience, never the authority (CLAUDE.md §11).
    const report = validateDeck(deck, this.#database, this.#deckFormat);
    seat.deck = deck;
    seat.deckLegal = report.legal;
    if (!report.legal) {
      seat.ready = false;
      connection.send({
        type: 'deck_rejected',
        error: protocolError(
          'protocol/deck_illegal',
          `"${deck.name}" is not legal in this format.`,
          errorsOf(report.issues).map((issue) => issue.message),
        ),
      });
    }
    this.broadcastLobby(lobby);
  }

  private setReady(connection: ServerConnection, ready: boolean): void {
    const attachment = this.#attachments.get(connection.id);
    if (!attachment) {
      this.fail(connection, 'protocol/not_in_lobby', 'Join a lobby first.');
      return;
    }
    const { lobby, seat } = attachment;
    if (lobby.status === 'in_match') {
      this.fail(connection, 'protocol/already_started', 'The match has already started.');
      return;
    }
    if (ready && (!seat.deck || !seat.deckLegal)) {
      this.fail(connection, 'protocol/deck_required', 'Submit a legal deck before readying up.');
      return;
    }

    seat.ready = ready;
    lobby.status = bothSeatsReady(lobby) ? 'ready' : 'waiting';
    this.broadcastLobby(lobby);

    if (bothSeatsReady(lobby)) this.startMatch(lobby);
  }

  private startMatch(lobby: Lobby): void {
    const seat1 = lobby.seats.get('seat_1');
    const seat2 = lobby.seats.get('seat_2');
    if (!seat1?.deck || !seat2?.deck) return;

    const toMatchDeck = (deck: SavedDeck): MatchDeck => ({
      commanderId: deck.commanderId as string,
      cards: deck.cards.map((entry) => ({ cardId: entry.cardId, quantity: entry.quantity })),
    });

    const created = createMatch({
      matchId: `match_${lobby.inviteCode}`,
      seed: this.#seedFor(lobby.inviteCode),
      database: this.#database,
      config: this.#config,
      seats: [
        {
          playerId: PLAYER_ID_BY_SEAT.seat_1,
          name: seat1.displayName,
          deck: toMatchDeck(seat1.deck),
        },
        {
          playerId: PLAYER_ID_BY_SEAT.seat_2,
          name: seat2.displayName,
          deck: toMatchDeck(seat2.deck),
        },
      ],
    });

    if (isErr(created)) {
      this.broadcast(lobby, {
        type: 'error',
        error: protocolError('protocol/internal', created.error.message),
      });
      return;
    }

    lobby.state = created.value.state;
    lobby.status = 'in_match';
    this.broadcastLobby(lobby);
    this.broadcastMatchState(lobby);
  }

  /* --------------------------------------------------------------- actions */

  private submitAction(
    connection: ServerConnection,
    actionId: string,
    lastSequence: number,
    action: Action,
  ): void {
    const attachment = this.#attachments.get(connection.id);
    if (!attachment) {
      this.fail(connection, 'protocol/not_in_lobby', 'Join a lobby first.');
      return;
    }
    const { lobby, seat } = attachment;
    if (!lobby.state) {
      connection.send({
        type: 'action_rejected',
        actionId,
        error: protocolError('protocol/not_started', 'The match has not started.'),
      });
      return;
    }

    // Replaying an action ID is answered with the current view, never applied
    // twice — this is what makes reconnect and retry safe (CLAUDE.md §11).
    if (seat.appliedActions.has(actionId)) {
      seat.lastSentSequence = 0;
      this.sendMatchState(lobby, seat);
      return;
    }

    if (action.playerId !== PLAYER_ID_BY_SEAT[seat.seatId]) {
      connection.send({
        type: 'action_rejected',
        actionId,
        error: protocolError('protocol/wrong_seat', 'That action belongs to the other player.'),
      });
      return;
    }

    if (lastSequence !== lobby.state.sequence) {
      // The client decided using a view that is no longer current.
      connection.send({
        type: 'action_rejected',
        actionId,
        error: protocolError(
          'protocol/stale_revision',
          'The match moved on before this action arrived. Try again from the current state.',
          [`client saw ${lastSequence}, server is at ${lobby.state.sequence}`],
        ),
      });
      this.sendMatchState(lobby, seat);
      return;
    }

    const result = applyAction(lobby.state, action, {
      database: this.#database,
      config: this.#config,
    });
    if (isErr(result)) {
      connection.send({ type: 'action_rejected', actionId, error: result.error });
      return;
    }

    lobby.state = result.value.state;
    seat.appliedActions.set(actionId, lobby.state.sequence);
    this.broadcastMatchState(lobby);
  }

  private leave(connection: ServerConnection): void {
    const attachment = this.#attachments.get(connection.id);
    if (!attachment) return;
    const { lobby, seat } = attachment;

    if (lobby.status === 'in_match' && lobby.state && lobby.state.status !== 'complete') {
      // Leaving a live match is a concession, not a disconnect.
      const result = applyAction(
        lobby.state,
        { type: 'concede', playerId: PLAYER_ID_BY_SEAT[seat.seatId] },
        { database: this.#database, config: this.#config },
      );
      if (!isErr(result)) {
        lobby.state = result.value.state;
        this.broadcastMatchState(lobby);
      }
    }
    this.disconnect(connection);
  }

  private timeOutSeat(lobby: Lobby, seat: Seat): void {
    if (!lobby.state || lobby.state.status === 'complete') return;
    const result = applyAction(
      lobby.state,
      { type: 'server_timeout', playerId: PLAYER_ID_BY_SEAT[seat.seatId] },
      { database: this.#database, config: this.#config },
    );
    if (isErr(result)) return;
    lobby.state = result.value.state;
    this.broadcastMatchState(lobby);
  }

  /* ---------------------------------------------------------------- output */

  private attach(connection: ServerConnection, lobby: Lobby, seat: Seat): void {
    this.#connections.set(connection.id, connection);
    this.#attachments.set(connection.id, { lobby, seat });
    seat.connectionId = connection.id;
  }

  private connectionFor(seat: Seat): ServerConnection | undefined {
    return seat.connectionId ? this.#connections.get(seat.connectionId) : undefined;
  }

  private fail(connection: ServerConnection, code: ProtocolError['code'], message: string): void {
    connection.send({ type: 'error', error: protocolError(code, message) });
  }

  private broadcast(lobby: Lobby, message: ServerMessage): void {
    for (const seat of lobby.seats.values()) this.connectionFor(seat)?.send(message);
  }

  private broadcastLobby(lobby: Lobby): void {
    this.broadcast(lobby, { type: 'lobby_updated', lobby: lobbyView(lobby) });
  }

  private broadcastConnection(lobby: Lobby, changed: Seat): void {
    const graceSeconds =
      changed.disconnectDeadline === null
        ? null
        : Math.max(0, Math.round((changed.disconnectDeadline - this.#now()) / 1000));
    for (const seat of lobby.seats.values()) {
      if (seat.seatId === changed.seatId) continue;
      this.connectionFor(seat)?.send({
        type: 'opponent_connection',
        seatId: changed.seatId,
        connected: changed.connectionId !== null,
        graceSeconds: changed.connectionId === null ? graceSeconds : null,
      });
    }
  }

  private broadcastMatchState(lobby: Lobby): void {
    // A finished match is also a lobby-state change: clients watching the lobby
    // header need to see it, not just the board.
    const finished = lobby.state?.status === 'complete' && lobby.status !== 'finished';
    if (finished) lobby.status = 'finished';

    for (const seat of lobby.seats.values()) this.sendMatchState(lobby, seat);
    if (finished) this.broadcastLobby(lobby);
  }

  /** Sends one seat its redacted view plus the events it has not seen yet. */
  private sendMatchState(lobby: Lobby, seat: Seat): void {
    const connection = this.connectionFor(seat);
    if (!connection || !lobby.state) return;

    const playerId = PLAYER_ID_BY_SEAT[seat.seatId];
    const view = playerView(lobby.state, playerId, this.#database, this.#config);
    const events = eventsSince(lobby.state, playerId, seat.lastSentSequence);
    seat.lastSentSequence = lobby.state.sequence;
    connection.send({ type: 'match_state', view, events });
  }

  /** Drops a lobby once nobody is connected and nothing is in progress. */
  private closeIfAbandoned(lobby: Lobby): void {
    const anyConnected = [...lobby.seats.values()].some((seat) => seat.connectionId !== null);
    if (anyConnected) return;
    if (lobby.status === 'in_match') return;
    lobby.status = 'closed';
    this.#lobbies.delete(lobby.inviteCode);
  }
}
