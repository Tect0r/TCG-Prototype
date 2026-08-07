import {
  CURRENT_VERSIONS,
  decodeServerMessage,
  encode,
  type ClientMessageInput,
  type LobbyView,
  type ProtocolError,
  type SeatId,
  type ServerMessage,
} from '@tcg/protocol';
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

export interface MatchClientState {
  readonly connection: ConnectionStatus;
  readonly seatId: SeatId | null;
  readonly lobby: LobbyView | null;
  readonly view: PlayerView | null;
  /** Set while an action is in flight, so input can be locked. */
  readonly pendingActionId: string | null;
  readonly lastError: ProtocolError | EngineError | null;
  readonly deckError: ProtocolError | null;
  readonly opponentConnected: boolean;
  readonly opponentGraceSeconds: number | null;
}

const INITIAL: MatchClientState = {
  connection: 'idle',
  seatId: null,
  lobby: null,
  view: null,
  pendingActionId: null,
  lastError: null,
  deckError: null,
  opponentConnected: true,
  opponentGraceSeconds: null,
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

  createLobby(displayName: string): void {
    this.#storage?.removeItem(RECONNECT_TOKEN_KEY);
    this.dispatch({ type: 'create_lobby', versions: CURRENT_VERSIONS, displayName });
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
        });
        return;

      case 'lobby_updated':
        this.patch({ lobby: message.lobby });
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

      case 'opponent_connection':
        this.patch({
          opponentConnected: message.connected,
          opponentGraceSeconds: message.graceSeconds,
        });
        return;

      case 'error':
        if (message.error.code === 'protocol/unknown_token') {
          // The session is gone: drop the stale token instead of retrying it.
          this.#storage?.removeItem(RECONNECT_TOKEN_KEY);
          this.patch({ lastError: null });
          return;
        }
        this.patch({ lastError: message.error, pendingActionId: null });
        return;

      case 'pong':
        return;

      default:
        return;
    }
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
