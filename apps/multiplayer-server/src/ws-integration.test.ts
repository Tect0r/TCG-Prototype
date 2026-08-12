import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundledPrecon, loadFormatCardData, resolveFormatId } from '@tcg/card-data';
import { deckFormatOf, preconToDeck, type SavedDeck } from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  decodeServerMessage,
  encode,
  type ClientMessageInput,
  type ServerMessage,
} from '@tcg/protocol';
import { isOk } from '@tcg/shared';
import { MatchServer } from './match-server.js';
import { startWebSocketServer, type WebSocketTransport } from './ws-adapter.js';

/**
 * Proves the socket transport itself works: two real clients, one real server,
 * over a real port. Protocol behaviour is covered exhaustively in
 * `match-server.test.ts` without the I/O.
 *
 * The server is wired the way `main.ts` wires it — the shared format-pool API,
 * scoped to the shipping format — so a deck or precon that crosses this socket
 * meets the same pool a real client would.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);

const PRECON_ID = 'precon_goblin_swarm';

/** A precon copy with one card swapped for a second copy of another. */
function tamperedCopy(preconId: string): SavedDeck {
  const precon = bundledPrecon(preconId);
  if (!precon) throw new Error(`${preconId} is missing from the bundle.`);
  const deck = preconToDeck(precon, {
    id: `deck_${preconId}_tampered`,
    name: precon.name,
    now: '2026-08-12T12:00:00.000Z',
  });
  const duplicated = deck.cards[0]?.cardId;
  if (!duplicated) throw new Error('The precon copy has no cards to duplicate.');
  return { ...deck, cards: [...deck.cards.slice(0, -1), { cardId: duplicated, quantity: 1 }] };
}

let transport: WebSocketTransport;

beforeAll(async () => {
  transport = await startWebSocketServer(new MatchServer({ database, deckFormat }), { port: 0 });
});

afterAll(async () => {
  await transport.close();
});

/** A minimal client built on Node's built-in WebSocket. */
class TestClient {
  readonly received: ServerMessage[] = [];
  #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const decoded = decodeServerMessage(String(event.data));
      if (isOk(decoded)) this.received.push(decoded.value);
    });
  }

  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      socket.addEventListener('open', () => resolve(new TestClient(socket)));
      socket.addEventListener('error', () => reject(new Error('Socket failed to open')));
    });
  }

  send(message: ClientMessageInput): void {
    this.#socket.send(encode(message as never));
  }

  close(): void {
    this.#socket.close();
  }

  /** Waits for a message of a given type, so tests never race the network. */
  async waitFor<T extends ServerMessage['type']>(
    type: T,
    timeoutMs = 2000,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = this.received.length - 1; i >= 0; i -= 1) {
        const message = this.received[i];
        if (message?.type === type) return message as Extract<ServerMessage, { type: T }>;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for "${type}"`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe('websocket transport', () => {
  it('answers a ping', async () => {
    const client = await TestClient.connect(transport.port);
    client.send({ type: 'ping' });
    await expect(client.waitFor('pong')).resolves.toBeDefined();
    client.close();
  });

  it('carries a lobby create/join round trip between two real clients', async () => {
    const host = await TestClient.connect(transport.port);
    host.send({ type: 'create_lobby', versions: CURRENT_VERSIONS, displayName: 'Host' });
    const joined = await host.waitFor('lobby_joined');

    expect(joined.lobby.inviteCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(joined.seatId).toBe('seat_1');

    const guest = await TestClient.connect(transport.port);
    guest.send({
      type: 'join_lobby',
      versions: CURRENT_VERSIONS,
      inviteCode: joined.lobby.inviteCode,
      displayName: 'Guest',
    });
    const guestJoined = await guest.waitFor('lobby_joined');
    expect(guestJoined.seatId).toBe('seat_2');

    // The host is told about the new arrival.
    const update = await host.waitFor('lobby_updated');
    expect(update.lobby.seats).toHaveLength(2);

    host.close();
    guest.close();
  });

  it('starts a match from two precons chosen by ID', async () => {
    const host = await TestClient.connect(transport.port);
    host.send({ type: 'create_lobby', versions: CURRENT_VERSIONS, displayName: 'Host' });
    const joined = await host.waitFor('lobby_joined');

    const guest = await TestClient.connect(transport.port);
    guest.send({
      type: 'join_lobby',
      versions: CURRENT_VERSIONS,
      inviteCode: joined.lobby.inviteCode,
      displayName: 'Guest',
    });
    await guest.waitFor('lobby_joined');

    // Only the ID crosses the wire. The server resolves and validates its own
    // copy of the definition (M03.2).
    host.send({ type: 'submit_precon', preconId: PRECON_ID });
    guest.send({ type: 'submit_precon', preconId: 'precon_bastion_guardians' });
    host.send({ type: 'set_ready', ready: true });
    guest.send({ type: 'set_ready', ready: true });

    const state = await host.waitFor('match_state');
    expect(state.view.viewerId).toBe('player_1');
    expect(state.view.hand.length).toBeGreaterThan(0);
    expect(await guest.waitFor('match_state')).toBeDefined();
    expect(host.received.some((message) => message.type === 'deck_rejected')).toBe(false);

    host.close();
    guest.close();
  });

  it('refuses a tampered precon copy over the wire', async () => {
    const client = await TestClient.connect(transport.port);
    client.send({ type: 'create_lobby', versions: CURRENT_VERSIONS, displayName: 'Cheat' });
    await client.waitFor('lobby_joined');

    // Edited, so it travels as a deck and is judged on its contents — the
    // precon's name buys it nothing.
    client.send({ type: 'submit_deck', deck: tamperedCopy(PRECON_ID) });
    const rejected = await client.waitFor('deck_rejected');
    expect(rejected.error.code).toBe('protocol/deck_illegal');

    client.send({ type: 'set_ready', ready: true });
    const error = await client.waitFor('error');
    expect(error.error.code).toBe('protocol/deck_required');

    client.close();
  });

  it('reports an incompatible client version over the wire', async () => {
    const client = await TestClient.connect(transport.port);
    client.send({
      type: 'create_lobby',
      versions: { ...CURRENT_VERSIONS, rules: '0.0.1-ancient' },
      displayName: 'Old',
    });
    const error = await client.waitFor('error');
    expect(error.error.code).toBe('protocol/version_mismatch');
    client.close();
  });
});
