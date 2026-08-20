import {
  CURRENT_VERSIONS,
  decodeServerMessage,
  encode,
  type BotSetup,
  type ClientMessageInput,
  type LobbyView,
  type ProtocolError,
  type RevealedBotDeck,
  type SeatId,
  type ServerMessage,
} from '@tcg/protocol';
import type { BotDeckSource, GeneratedDeckProvenance } from '@tcg/bot-config';
import type { SavedDeck } from '@tcg/deck';
import type { Action, EngineError, PlayerView } from '@tcg/rules-engine';
import { isOk } from '@tcg/shared';

/**
 * Client-side match session.
 *
 * Deliberately free of React: it owns the socket, the reconnect token, action
 * IDs and the "waiting for the server" flag, and publishes an immutable
 * snapshot. That keeps the rules of the network boundary testable without a
 * DOM, and keeps the components pure renderers of authoritative data.
 */

export interface TransportHandlers {
  onOpen(): void;
  onMessage(raw: string): void;
  onClose(): void;
}

export interface Transport {
  send(raw: string): void;
  close(): void;
}

export type TransportFactory = (handlers: TransportHandlers) => Transport;

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'closed';

/** Live connection state for one other seat at the table. */
export interface SeatConnection {
  readonly connected: boolean;
  readonly graceSeconds: number | null;
}

export interface MatchClientState {
  readonly connection: ConnectionStatus;
  readonly seatId: SeatId | null;
  readonly lobby: LobbyView | null;
  readonly view: PlayerView | null;
  /** Set while an action is in flight, so input can be locked. */
  readonly pendingActionId: string | null;
  readonly lastError: ProtocolError | EngineError | null;
  readonly deckError: ProtocolError | null;
  /**
   * Per seat, because a free-for-all has up to three other players and one of
   * them dropping does not stop the match (CLAUDE.md §12).
   */
  readonly seatConnections: Readonly<Partial<Record<SeatId, SeatConnection>>>;
  /**
   * The **private** half of each bot seat's configuration, as this client last
   * sent it and the server accepted it (M09.6).
   *
   * It is remembered here rather than read back off the wire because it is not
   * on the wire: a saved deck's name, list and fingerprint are deliberately
   * absent from the seat view every player receives, which carries the Commander
   * and nothing else (ADR 0024 §3). Without this the host could not be told
   * which of their decks a bot was frozen from, nor that the deck has changed
   * since — and it lives on the client rather than in a screen because the
   * screen is unmounted the moment the host goes to the Deck Builder, which is
   * exactly where that change gets made.
   *
   * It is memory of a request, not authority: the server owns what the bot
   * actually plays, and an entry is kept only while the seat still holds a bot
   * of the mode it describes.
   */
  readonly botDeckSources: Readonly<Partial<Record<SeatId, BotDeckSource>>>;
  /**
   * What the server built for each generated bot seat (M09.9).
   *
   * Sent to the host and to nobody else, because it carries the generator seed —
   * the one value that would turn "the Commander is public" back into "the list
   * is public" (ADR 0024 §3). Unlike `botDeckSources` above this is *not* a
   * memory of a request: it is the authoritative record of the deck the server
   * actually generated, which is why the host can be shown a hash and a reroll
   * count it could not have computed itself.
   */
  readonly botProvenance: Readonly<Partial<Record<SeatId, GeneratedDeckProvenance>>>;
  /**
   * Every bot's list, once the match is over.
   *
   * Empty until then, and the same for every seat: this is the other half of
   * "public at the Commander, private at the list", and the promise is only kept
   * if the opponents are the ones who eventually read it.
   */
  readonly revealedBotDecks: readonly RevealedBotDeck[];
}

const INITIAL: MatchClientState = {
  connection: 'idle',
  seatId: null,
  lobby: null,
  view: null,
  pendingActionId: null,
  lastError: null,
  deckError: null,
  seatConnections: {},
  botDeckSources: {},
  botProvenance: {},
  revealedBotDecks: [],
};

/** Where the reconnect token is kept so a refresh can reclaim the seat. */
export const RECONNECT_TOKEN_KEY = 'tcg.match.reconnectToken';

export interface MatchClientOptions {
  readonly createTransport: TransportFactory;
  /** Injected in tests; defaults to browser session storage. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly generateActionId?: () => string;
}

export class MatchClient {
  #state: MatchClientState = INITIAL;
  #transport: Transport | null = null;
  #listeners = new Set<(state: MatchClientState) => void>();
  #actionCounter = 0;

  readonly #createTransport: TransportFactory;
  readonly #storage: MatchClientOptions['storage'];
  readonly #generateActionId: () => string;
  /** Queued until the socket opens, so callers never have to await `connect`. */
  #pendingSends: ClientMessageInput[] = [];
  /**
   * The bot deck source of the request currently in flight, if any, and the seat
   * it named. `seatId` is `null` for `add_bot`, which carries none on purpose.
   */
  #sentBotDeck: { readonly seatId: SeatId | null; readonly deck: BotDeckSource } | null = null;

  constructor(options: MatchClientOptions) {
    this.#createTransport = options.createTransport;
    this.#storage = options.storage;
    this.#generateActionId =
      options.generateActionId ??
      (() => {
        this.#actionCounter += 1;
        return `act_${Date.now().toString(36)}_${this.#actionCounter}`;
      });
  }

  get state(): MatchClientState {
    return this.#state;
  }

  subscribe(listener: (state: MatchClientState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  connect(): void {
    if (this.#transport) return;
    this.patch({ connection: 'connecting', lastError: null });
    this.#transport = this.#createTransport({
      onOpen: () => {
        this.patch({ connection: 'open' });
        const token = this.#storage?.getItem(RECONNECT_TOKEN_KEY);
        if (token) {
          // A refresh mid-match reclaims the seat rather than starting over.
          this.dispatch({ type: 'reconnect', versions: CURRENT_VERSIONS, reconnectToken: token });
        }
        const queued = this.#pendingSends;
        this.#pendingSends = [];
        for (const message of queued) this.dispatch(message);
      },
      onMessage: (raw) => this.receive(raw),
      onClose: () => {
        this.#transport = null;
        this.patch({ connection: 'closed', pendingActionId: null });
      },
    });
  }

  disconnect(): void {
    this.#transport?.close();
    this.#transport = null;
    this.patch({ connection: 'closed' });
  }

  /** Forgets the seat entirely, so the next connect starts a fresh session. */
  forgetSession(): void {
    this.#storage?.removeItem(RECONNECT_TOKEN_KEY);
    this.#state = { ...INITIAL, connection: this.#state.connection };
    this.publish();
  }

  createLobby(displayName: string, maxSeats = 2): void {
    this.#storage?.removeItem(RECONNECT_TOKEN_KEY);
    this.dispatch({ type: 'create_lobby', versions: CURRENT_VERSIONS, displayName, maxSeats });
  }

  /** Host-only; the server rejects it from anyone else. */
  setMaxSeats(maxSeats: number): void {
    this.dispatch({ type: 'set_max_seats', maxSeats });
  }

  /** Host-only; needed for three- and four-seat tables (open-questions.md Q36). */
  startMatch(): void {
    this.dispatch({ type: 'start_match' });
  }

  /**
   * Host-only: seat a bot in the next free seat.
   *
   * No seat ID travels, because the server allocates one deterministically and a
   * bot never displaces anybody (ADR 0024 §1).
   */
  addBot(setup: BotSetup): void {
    // Held, not recorded: the seat it lands in is the server's choice, so the
    // configuration is bound to a seat only once a lobby view shows one.
    this.#sentBotDeck = { seatId: null, deck: setup.deck };
    this.dispatch({ type: 'add_bot', setup });
  }

  /** Host-only: replace one bot seat's configuration wholesale, keeping its seat. */
  updateBot(seatId: SeatId, setup: BotSetup): void {
    this.#sentBotDeck = { seatId, deck: setup.deck };
    this.dispatch({ type: 'update_bot', seatId, setup });
  }

  /**
   * Host-only: build this bot a new deck (M09.9).
   *
   * No seed travels. The server derives the next one from the seat's own base
   * seed and its reroll count, so the recorded transition is the server's and is
   * not something a client could invent; what comes back is a new lobby view and
   * a new provenance record. Nothing is remembered here, because the base seed —
   * the only half this client owns — is exactly what a reroll does not change.
   */
  rerollBot(seatId: SeatId): void {
    this.dispatch({ type: 'reroll_bot', seatId });
  }

  /** Host-only: free the seat. A human joining never does this implicitly. */
  removeBot(seatId: SeatId): void {
    this.#sentBotDeck = null;
    this.dispatch({ type: 'remove_bot', seatId });
  }

  joinLobby(inviteCode: string, displayName: string): void {
    this.#storage?.removeItem(RECONNECT_TOKEN_KEY);
    this.dispatch({
      type: 'join_lobby',
      versions: CURRENT_VERSIONS,
      inviteCode: inviteCode.trim().toUpperCase(),
      displayName,
    });
  }

  submitDeck(deck: SavedDeck): void {
    this.patch({ deckError: null });
    this.dispatch({ type: 'submit_deck', deck });
  }

  /**
   * Plays a built-in precon by permanent ID.
   *
   * Deliberately not `submitDeck(preconToDeck(...))`: the server resolves the ID
   * against its own content, so the list it validates is the shipped definition
   * rather than whatever this client happened to send (M03.2).
   */
  submitPrecon(preconId: string): void {
    this.patch({ deckError: null });
    this.dispatch({ type: 'submit_precon', preconId });
  }

  setReady(ready: boolean): void {
    this.dispatch({ type: 'set_ready', ready });
  }

  leave(): void {
    this.dispatch({ type: 'leave' });
    this.forgetSession();
  }

  /**
   * Submits an action against the exact revision the player was looking at. The
   * unique action ID makes a retry after a reconnect a no-op rather than a
   * second play (CLAUDE.md §11).
   */
  sendAction(action: Action): void {
    const view = this.#state.view;
    if (!view || this.#state.pendingActionId !== null) return;
    const actionId = this.#generateActionId();
    this.patch({ pendingActionId: actionId, lastError: null });
    this.dispatch({
      type: 'submit_action',
      actionId,
      lastSequence: view.sequence,
      action,
    });
  }

  private dispatch(message: ClientMessageInput): void {
    if (!this.#transport || this.#state.connection !== 'open') {
      this.#pendingSends.push(message);
      this.connect();
      return;
    }
    this.#transport.send(encode(message as never));
  }

  private receive(raw: string): void {
    const decoded = decodeServerMessage(raw);
    if (!isOk(decoded)) {
      this.patch({ lastError: decoded.error, pendingActionId: null });
      return;
    }
    this.apply(decoded.value);
  }

  private apply(message: ServerMessage): void {
    switch (message.type) {
      case 'lobby_joined':
        this.#storage?.setItem(RECONNECT_TOKEN_KEY, message.reconnectToken);
        this.patch({
          seatId: message.seatId,
          lobby: message.lobby,
          lastError: null,
          botDeckSources: this.reconcileBotDecks(message.lobby),
          botProvenance: this.reconcileProvenance(message.lobby, this.#state.botProvenance),
        });
        return;

      case 'lobby_updated':
        this.patch({
          lobby: message.lobby,
          botDeckSources: this.reconcileBotDecks(message.lobby),
          botProvenance: this.reconcileProvenance(message.lobby, this.#state.botProvenance),
        });
        return;

      case 'bot_seat_provenance': {
        // A complete replacement of what the host knows, then reconciled
        // against the seats the same way a remembered request is: the server
        // sends this beside a lobby update, and either order has to leave the
        // two agreeing.
        const next: Partial<Record<SeatId, GeneratedDeckProvenance>> = {};
        for (const seat of message.seats) next[seat.seatId] = seat.generated;
        this.patch({
          botProvenance: this.#state.lobby
            ? this.reconcileProvenance(this.#state.lobby, next)
            : next,
        });
        return;
      }

      case 'bot_decks_revealed':
        this.patch({ revealedBotDecks: message.decks });
        return;

      case 'deck_rejected':
        this.patch({ deckError: message.error });
        return;

      case 'match_state':
        this.patch({ view: message.view, pendingActionId: null });
        return;

      case 'action_rejected':
        // Clearing the pending flag re-enables input; the view the server sent
        // alongside (if any) is already authoritative.
        this.patch({ pendingActionId: null, lastError: message.error });
        return;

      case 'seat_connection':
        this.patch({
          seatConnections: {
            ...this.#state.seatConnections,
            [message.seatId]: {
              connected: message.connected,
              graceSeconds: message.graceSeconds,
            },
          },
        });
        return;

      case 'error':
        if (message.error.code === 'protocol/unknown_token') {
          // The session is gone: drop the stale token instead of retrying it.
          this.#storage?.removeItem(RECONNECT_TOKEN_KEY);
          this.patch({ lastError: null });
          return;
        }
        // A refusal applied nothing, so nothing new is remembered about a bot.
        this.#sentBotDeck = null;
        this.patch({ lastError: message.error, pendingActionId: null });
        return;

      case 'pong':
        return;

      default:
        return;
    }
  }

  /**
   * Binds what this client sent to the seats the server actually shows.
   *
   * Kept deliberately conservative. An entry survives only while its seat still
   * holds a bot **of the same deck mode**, so a seat the host reconfigured from
   * elsewhere, freed, or replaced with a person drops its record rather than
   * describing a bot that is no longer there. The in-flight request is attached
   * to the seat it named, or — for `add_bot`, which names none — to the first
   * bot seat this client has no record of, which is the seat the server just
   * allocated.
   */
  private reconcileBotDecks(lobby: LobbyView): Partial<Record<SeatId, BotDeckSource>> {
    const botSeats = lobby.seats.filter((seat) => seat.controller === 'bot');
    const next: Partial<Record<SeatId, BotDeckSource>> = {};
    for (const seat of botSeats) {
      const remembered = this.#state.botDeckSources[seat.seatId];
      if (remembered && remembered.mode === seat.bot.deck.mode) next[seat.seatId] = remembered;
    }

    const sent = this.#sentBotDeck;
    if (sent) {
      const target =
        sent.seatId === null
          ? botSeats.find((seat) => next[seat.seatId] === undefined)
          : botSeats.find((seat) => seat.seatId === sent.seatId);
      if (target && target.bot.deck.mode === sent.deck.mode) next[target.seatId] = sent.deck;
      this.#sentBotDeck = null;
    }
    return next;
  }

  /**
   * Drops provenance for a seat that no longer holds a generated bot.
   *
   * The same conservatism `reconcileBotDecks` applies to a remembered request,
   * for the same reason: a seat the host freed, replaced with a person, or moved
   * onto a precon has no generated deck to describe, and describing one anyway
   * is how a screen comes to show a hash for a deck nobody is playing.
   */
  private reconcileProvenance(
    lobby: LobbyView,
    source: Readonly<Partial<Record<SeatId, GeneratedDeckProvenance>>>,
  ): Partial<Record<SeatId, GeneratedDeckProvenance>> {
    const next: Partial<Record<SeatId, GeneratedDeckProvenance>> = {};
    for (const seat of lobby.seats) {
      const known = source[seat.seatId];
      if (!known) continue;
      if (seat.controller !== 'bot') continue;
      if (seat.bot.deck.mode !== 'commander_generated') continue;
      next[seat.seatId] = known;
    }
    return next;
  }

  private patch(changes: Partial<MatchClientState>): void {
    this.#state = { ...this.#state, ...changes };
    this.publish();
  }

  private publish(): void {
    for (const listener of this.#listeners) listener(this.#state);
  }
}

/** Real browser transport. Kept separate so tests can inject a fake. */
export function webSocketTransport(url: string): TransportFactory {
  return (handlers) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => handlers.onOpen());
    socket.addEventListener('message', (event) => handlers.onMessage(String(event.data)));
    socket.addEventListener('close', () => handlers.onClose());
    socket.addEventListener('error', () => handlers.onClose());
    return {
      send: (raw) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(raw);
      },
      close: () => socket.close(),
    };
  };
}

export const DEFAULT_SERVER_URL =
  (import.meta.env?.VITE_MATCH_SERVER_URL as string | undefined) ?? 'ws://127.0.0.1:8787';
