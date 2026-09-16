import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deckFormatOf } from '@tcg/deck';
import { loadFormatCardData, resolveFormatId } from '@tcg/card-data';
import { liveMatchEnvelopeSchema } from '@tcg/match-telemetry';
import {
  CURRENT_VERSIONS,
  decodeServerMessage,
  encode,
  type ClientMessageInput,
  type ServerMessage,
} from '@tcg/protocol';
import { isOk } from '@tcg/shared';
import { composeMatchServer } from './compose.js';
import { LIVE_MATCH_TELEMETRY_ENVIRONMENT_KEYS } from './live-match-telemetry-config.js';
import { LiveMatchFileStore } from './live-match-store.js';
import type { LiveMatchSink } from './live-match-sink.js';
import { MatchServer, type ServerConnection } from './match-server.js';
import type { ScheduleTimer } from './scheduling.js';
import { startWebSocketServer, type WebSocketTransport } from './ws-adapter.js';

/**
 * M08.R9 — the production live-match sink wired all the way to disk.
 *
 * `compose.test.ts`-style unit coverage of `composeMatchServer` and
 * `live-match-store.test.ts`'s coverage of `LiveMatchFileStore` already prove
 * their own pieces in isolation. This file is the one place that proves they
 * still fit together end to end: a real production composition, a real
 * websocket, a real match played to a real terminal result, and a real file
 * on disk — the shape the admin process reads independently, over on its own
 * side of ADR 0023's process boundary (`apps/admin-server`'s own
 * `e2e-recovery-matrix.test.ts` proves that half, from realistic envelope
 * fixtures of this exact shape, since the two processes never share an
 * import graph — `boundary.test.ts` on both sides).
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);

const HOST_PRECON = 'precon_goblin_swarm';
const GUEST_PRECON = 'precon_bastion_guardians';

/** A minimal client built on Node's built-in WebSocket, matching `ws-integration.test.ts`. */
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

  /** Waits for the specific `match_state` that carries a terminal result. */
  async waitForResult(timeoutMs = 3000): Promise<Extract<ServerMessage, { type: 'match_state' }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = this.received.length - 1; i >= 0; i -= 1) {
        const message = this.received[i];
        if (message?.type === 'match_state' && message.view.result !== null) return message;
      }
      if (Date.now() > deadline) throw new Error('Timed out waiting for a terminal match_state');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

async function readEnvelope(root: string, matchId: string): Promise<unknown> {
  const raw = await readFile(join(root, matchId, 'envelope.json'), 'utf8');
  return JSON.parse(raw) as unknown;
}

describe('the production composition writes a real durable envelope over a real socket', () => {
  let root: string;
  let transport: WebSocketTransport;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tcg-live-match-e2e-'));
    const composed = composeMatchServer({
      [LIVE_MATCH_TELEMETRY_ENVIRONMENT_KEYS.enabled]: 'true',
      [LIVE_MATCH_TELEMETRY_ENVIRONMENT_KEYS.rootDirectory]: root,
    });
    if (!composed.ok) throw new Error('composeMatchServer refused a valid temp-root configuration.');
    expect(composed.value.liveMatchTelemetryEnabled).toBe(true);
    transport = await startWebSocketServer(composed.value.server, { port: 0 });
  });

  afterEach(async () => {
    await transport.close();
    await rm(root, { recursive: true, force: true });
  });

  it('plays a legal two-seat match to a terminal result and writes exactly one envelope', async () => {
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

    host.send({ type: 'submit_precon', preconId: HOST_PRECON });
    guest.send({ type: 'submit_precon', preconId: GUEST_PRECON });
    host.send({ type: 'set_ready', ready: true });
    guest.send({ type: 'set_ready', ready: true });

    const started = await host.waitFor('match_state');
    const matchId = started.view.matchId;
    expect(matchId).toMatch(/^match_[a-hjkmnp-tv-z0-9]{18}$/);

    // Drives the match to a genuine terminal result: `leave()` applies a
    // concede for the leaving seat and broadcasts the finished state, which is
    // the one call site that writes the live-match envelope.
    guest.send({ type: 'leave' });
    const finished = await host.waitForResult();
    expect(finished.view.matchId).toBe(matchId);
    expect(finished.view.result?.winnerId).toBe('player_1');

    const entries = await readdir(root);
    expect(entries).toEqual([matchId]);

    const envelope = await readEnvelope(root, matchId);
    expect(liveMatchEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect((envelope as { matchId: string }).matchId).toBe(matchId);

    host.close();
    guest.close();
  });
});

/** Sends a client message the same way `ws-adapter.ts` delivers one off the wire. */
function deliver(server: MatchServer, connection: ServerConnection, message: ClientMessageInput): void {
  server.receive(connection, encode(message as never));
}

class Client implements ServerConnection {
  readonly id: string;
  readonly sent: ServerMessage[] = [];

  constructor(id: string) {
    this.id = id;
  }

  send(message: ServerMessage): void {
    this.sent.push(message);
  }

  close(): void {}

  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const message = this.sent[i];
      if (message?.type === type) return message as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }
}

const NO_OP_SCHEDULE: ScheduleTimer = () => () => {};

describe('invite-code reuse produces two distinct durable records (M08.R9, protocol boundary)', () => {
  it('writes a fresh envelope per match and leaves no stale artifacts behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tcg-live-match-reuse-'));
    try {
      let nowMs = 1_000_000;
      const server = new MatchServer({
        database,
        deckFormat,
        // Constant, so the invite-code pool mints the identical code for both
        // matches below once the first lobby's code is freed (M08.R8's own
        // pattern) — the second match must land in the very directory the
        // first one used, proving the record identity is `matchId`, not the
        // reusable invite code.
        random: () => 0.25,
        schedule: NO_OP_SCHEDULE,
        seedFor: () => 'fixed-server-seed',
        now: () => {
          nowMs += 1;
          return nowMs;
        },
        liveMatchSink: new LiveMatchFileStore({ rootDirectory: root }),
      });

      function playOneMatchAndFreeItsInviteCode(): { inviteCode: string; matchId: string } {
        const host = new Client('conn_host');
        server.connect(host);
        deliver(server, host, { type: 'create_lobby', versions: CURRENT_VERSIONS, displayName: 'Host' });
        const hostJoined = host.last('lobby_joined');
        if (!hostJoined) throw new Error('Host did not join');

        const guest = new Client('conn_guest');
        server.connect(guest);
        deliver(server, guest, {
          type: 'join_lobby',
          versions: CURRENT_VERSIONS,
          inviteCode: hostJoined.lobby.inviteCode,
          displayName: 'Guest',
        });
        if (!guest.last('lobby_joined')) throw new Error('Guest did not join');

        deliver(server, host, { type: 'submit_precon', preconId: HOST_PRECON });
        deliver(server, guest, { type: 'submit_precon', preconId: GUEST_PRECON });
        deliver(server, host, { type: 'set_ready', ready: true });
        deliver(server, guest, { type: 'set_ready', ready: true });

        const matchId = host.last('match_state')?.view.matchId;
        if (!matchId) throw new Error('Match did not start');

        deliver(server, guest, { type: 'leave' });
        server.disconnect(host);

        return { inviteCode: hostJoined.lobby.inviteCode, matchId };
      }

      const first = playOneMatchAndFreeItsInviteCode();
      const second = playOneMatchAndFreeItsInviteCode();

      expect(second.inviteCode).toBe(first.inviteCode);
      expect(second.matchId).not.toBe(first.matchId);

      const entries = (await readdir(root)).sort();
      expect(entries).toEqual([first.matchId, second.matchId].sort());

      const firstEnvelope = await readEnvelope(root, first.matchId);
      const secondEnvelope = await readEnvelope(root, second.matchId);
      expect((firstEnvelope as { matchId: string }).matchId).toBe(first.matchId);
      expect((secondEnvelope as { matchId: string }).matchId).toBe(second.matchId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('a telemetry write failure never corrupts match authority (M08.R9)', () => {
  it('keeps the real result while recording the sink failure in health diagnostics', () => {
    const explodingSink: LiveMatchSink = {
      sinkId: 'exploding_sink',
      receive: () => {
        throw new Error('disk offline');
      },
    };

    const server = new MatchServer({
      database,
      deckFormat,
      random: () => 0.5,
      schedule: NO_OP_SCHEDULE,
      seedFor: () => 'fixed-server-seed',
      now: () => 2_000_000,
      liveMatchSink: explodingSink,
    });

    const host = new Client('conn_host');
    server.connect(host);
    deliver(server, host, { type: 'create_lobby', versions: CURRENT_VERSIONS, displayName: 'Host' });
    const hostJoined = host.last('lobby_joined');
    if (!hostJoined) throw new Error('Host did not join');

    const guest = new Client('conn_guest');
    server.connect(guest);
    deliver(server, guest, {
      type: 'join_lobby',
      versions: CURRENT_VERSIONS,
      inviteCode: hostJoined.lobby.inviteCode,
      displayName: 'Guest',
    });
    if (!guest.last('lobby_joined')) throw new Error('Guest did not join');

    deliver(server, host, { type: 'submit_precon', preconId: HOST_PRECON });
    deliver(server, guest, { type: 'submit_precon', preconId: GUEST_PRECON });
    deliver(server, host, { type: 'set_ready', ready: true });
    deliver(server, guest, { type: 'set_ready', ready: true });
    expect(host.last('match_state')?.view.matchId).toBeDefined();

    deliver(server, guest, { type: 'leave' });

    const finished = host.last('match_state');
    expect(finished?.view.result?.winnerId).toBe('player_1');
    expect(finished?.view.result?.reason).toBe('concede');

    expect(server.liveMatchSinkFailures).toEqual(['exploding_sink: disk offline']);
  });
});
