import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBundledCardData } from '@tcg/card-data';
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
 */

const database = loadBundledCardData().database;
let transport: WebSocketTransport;

beforeAll(async () => {
  transport = await startWebSocketServer(new MatchServer({ database }), { port: 0 });
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
