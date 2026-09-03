import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DECKABLE_CARD_TYPES,
  formatCardPool,
  isColorIdentityLegal,
  loadBundledCardData,
  type CardDatabase,
  type CardId,
} from '@tcg/card-data';
import { DECK_SCHEMA_VERSION, DEVELOPMENT_DECK_FORMAT, type SavedDeck } from '@tcg/deck';
import type { LiveMatchRetentionConfig } from '@tcg/match-telemetry';
import {
  CURRENT_VERSIONS,
  encode,
  type ClientMessageInput,
  type ServerMessage,
} from '@tcg/protocol';
import type { Action, PlayerId, PlayerView } from '@tcg/rules-engine';
import { liveMatchTerminationOriginFor } from './live-match-record.js';
import type { LiveMatchRecord, LiveMatchSink } from './live-match-sink.js';
import { LiveMatchFileStore } from './live-match-store.js';
import { MatchServer, type ScheduleTimer, type ServerConnection } from './match-server.js';

/**
 * M08.22C: proves `publishLiveMatchRecord`'s wiring into the real lifecycle —
 * normal victory, reconnect, disconnect timeout, an explicit concede, a
 * leave-triggered concede, a free-for-all table the two-seat envelope does
 * not cover, and the two failure-containment paths — through the same
 * protocol harness `match-server.test.ts` already proves the rest of the
 * server with, rather than a hand-built `MatchState` fixture that would drift
 * from what the engine actually produces.
 */

const database: CardDatabase = loadBundledCardData().database;

function legalDeckFor(commanderId: CardId, name: string): SavedDeck {
  const commander = database.getOrThrow(commanderId);
  const pool = formatCardPool('development')
    .filter((card) => DECKABLE_CARD_TYPES.includes(card.type) && card.collectible)
    .filter((card) => isColorIdentityLegal(card.colorIdentity, commander.colorIdentity));

  const cards: { cardId: CardId; quantity: number }[] = [];
  let total = 0;
  for (const card of pool) {
    if (total >= 30) break;
    const limit = card.unique ? 1 : 2;
    const quantity = Math.min(limit, 30 - total);
    cards.push({ cardId: card.id, quantity });
    total += quantity;
  }
  if (total !== 30) throw new Error(`Could not build a 30-card deck for ${commanderId}`);

  return {
    schemaVersion: DECK_SCHEMA_VERSION,
    id: `deck_${name}`,
    name,
    commanderId,
    cards,
    createdAt: '2026-08-07T12:00:00.000Z',
    updatedAt: '2026-08-07T12:00:00.000Z',
  };
}

class FakeConnection implements ServerConnection {
  readonly sent: ServerMessage[] = [];
  closed = false;

  constructor(readonly id: string) {}

  send(message: ServerMessage): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
  }

  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const message = this.sent[i];
      if (message?.type === type) return message as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }

  view(): PlayerView {
    const message = this.last('match_state');
    if (!message) throw new Error(`${this.id} has not received a match state`);
    return message.view;
  }
}

function sequenceRandom(): () => number {
  let counter = 0;
  return () => {
    counter += 1;
    return ((counter * 2654435761) % 4294967296) / 4294967296;
  };
}

interface HarnessOptions {
  readonly liveMatchSink?: LiveMatchSink;
  readonly liveMatchRetention?: LiveMatchRetentionConfig;
}

interface Table {
  readonly server: MatchServer;
  readonly seats: FakeConnection[];
  readonly inviteCode: string;
  readonly timers: { delayMs: number; fire: () => void }[];
  send(connection: FakeConnection, message: ClientMessageInput): void;
}

function createTable(seatCount: number, options: HarnessOptions = {}): Table {
  const timers: { delayMs: number; fire: () => void }[] = [];
  const schedule: ScheduleTimer = (delayMs, callback) => {
    const entry = { delayMs, fire: callback };
    timers.push(entry);
    return () => {
      const index = timers.indexOf(entry);
      if (index >= 0) timers.splice(index, 1);
    };
  };

  const server = new MatchServer({
    database,
    deckFormat: DEVELOPMENT_DECK_FORMAT,
    random: sequenceRandom(),
    schedule,
    seedFor: () => 'fixed-server-seed',
    now: () => 1_000_000,
    ...(options.liveMatchSink ? { liveMatchSink: options.liveMatchSink } : {}),
    ...(options.liveMatchRetention ? { liveMatchRetention: options.liveMatchRetention } : {}),
  });

  const send = (connection: FakeConnection, message: ClientMessageInput): void => {
    server.receive(connection, encode(message as never));
  };

  const host = new FakeConnection('conn_seat_1');
  server.connect(host);
  send(host, {
    type: 'create_lobby',
    versions: CURRENT_VERSIONS,
    displayName: 'Seat 1',
    maxSeats: seatCount,
  });
  const hostJoined = host.last('lobby_joined');
  if (!hostJoined) throw new Error('Host did not join');
  const inviteCode = hostJoined.lobby.inviteCode;

  const seats = [host];
  for (let index = 1; index < seatCount; index += 1) {
    const connection = new FakeConnection(`conn_seat_${index + 1}`);
    server.connect(connection);
    send(connection, {
      type: 'join_lobby',
      versions: CURRENT_VERSIONS,
      inviteCode,
      displayName: `Seat ${index + 1}`,
    });
    if (!connection.last('lobby_joined')) throw new Error(`Seat ${index + 1} did not join`);
    seats.push(connection);
  }

  return { server, seats, inviteCode, timers, send };
}

function startTable(table: Table): void {
  table.seats.forEach((connection, index) => {
    table.send(connection, {
      type: 'submit_deck',
      deck: legalDeckFor('prototype_commander_blue_red', `Deck ${index + 1}`),
    });
    table.send(connection, { type: 'set_ready', ready: true });
  });
  if (table.seats.length > 2) table.send(table.seats[0] as FakeConnection, { type: 'start_match' });
}

function keepAllHands(table: Table): void {
  table.seats.forEach((connection, index) => {
    act(table, connection, {
      type: 'mulligan',
      playerId: `player_${index + 1}` as PlayerId,
      returnInstanceIds: [],
    });
  });
}

let actionCounter = 0;
function act(table: Table, connection: FakeConnection, action: Action): void {
  actionCounter += 1;
  table.send(connection, {
    type: 'submit_action',
    actionId: `action_${actionCounter}`,
    lastSequence: connection.view().sequence,
    action,
  });
}

function createHarness(options: HarnessOptions = {}): Table {
  const table = createTable(2, options);
  return table;
}

function startMatch(table: Table): void {
  startTable(table);
}

function capturingSink(): { sink: LiveMatchSink; records: LiveMatchRecord[] } {
  const records: LiveMatchRecord[] = [];
  return {
    sink: { sinkId: 'test_capture', receive: (record) => records.push(record) },
    records,
  };
}

describe('liveMatchTerminationOriginFor (pure mapping, M08.22C)', () => {
  it.each([
    ['concede', 'concede_action', 'concede_action'],
    ['concede', 'concede_leave', 'concede_leave'],
    ['concede', null, 'concede_action'],
    ['timeout', null, 'disconnect_timeout'],
    ['health_depleted', null, 'rules_victory'],
    ['empty_deck', null, 'rules_victory'],
    ['simultaneous_loss', null, 'rules_victory'],
    ['engine_error', null, 'server_failure'],
  ] as const)('maps reason %s with concedeOrigin %s to %s', (reason, concedeOrigin, expected) => {
    expect(liveMatchTerminationOriginFor(reason, concedeOrigin)).toBe(expected);
  });
});

describe('lifecycle integration (M08.22C)', () => {
  it('records rules_victory for a match that finishes on its own', () => {
    const { sink, records } = capturingSink();
    const harness = createHarness({ liveMatchSink: sink });
    startMatch(harness);
    const [host, guest] = harness.seats as [FakeConnection, FakeConnection];

    const step = (connection: FakeConnection): boolean => {
      const view = connection.view();
      if (view.status === 'complete') return false;
      const legal = view.legalActions;
      const me = view.viewerId;

      if (view.pendingChoice) {
        const choice = view.pendingChoice;
        act(harness, connection, {
          type: 'submit_choice',
          playerId: me,
          choiceId: choice.id,
          selectedIds: choice.ordered
            ? [...choice.validEntityIds]
            : choice.validEntityIds.slice(0, choice.minimum),
        });
        return true;
      }
      if (legal.mulligan) {
        act(harness, connection, { type: 'mulligan', playerId: me, returnInstanceIds: [] });
        return true;
      }
      if (legal.attacking) {
        const defender = legal.attacking.legalDefenders[0];
        act(harness, connection, {
          type: 'declare_attackers',
          playerId: me,
          attacks:
            defender === undefined
              ? []
              : legal.attacking.legalAttackers.map((attackerInstanceId) => ({
                  attackerInstanceId,
                  defenderPlayerId: defender,
                })),
        });
        return true;
      }
      if (legal.blocking) {
        const blocking = legal.blocking;
        const blocks = Array.from({ length: blocking.mustBlockCount }, (_, index) => ({
          attackerInstanceId: blocking.attackerInstanceIds[index],
          blockerInstanceId: blocking.guardianInstanceIds[index],
        })).filter(
          (block): block is { attackerInstanceId: string; blockerInstanceId: string } =>
            block.attackerInstanceId !== undefined && block.blockerInstanceId !== undefined,
        );
        act(harness, connection, { type: 'assign_blockers', playerId: me, blocks });
        return true;
      }
      const card = legal.playableCards[0];
      if (card) {
        act(harness, connection, { type: 'play_card', playerId: me, instanceId: card.instanceId });
        return true;
      }
      if (legal.canPassPhase) {
        act(harness, connection, { type: 'pass_phase', playerId: me });
        return true;
      }
      return false;
    };

    let progressed = true;
    for (let guard = 0; guard < 3000 && progressed; guard += 1) {
      if (host.view().status === 'complete') break;
      progressed = step(host) || step(guest);
    }

    expect(host.view().status).toBe('complete');
    expect(records).toHaveLength(1);
    expect(records[0]?.envelope.terminationOrigin).toBe('rules_victory');
    expect(['health_depleted', 'empty_deck', 'simultaneous_loss']).toContain(
      records[0]?.envelope.outcome?.reason,
    );
    expect(records[0]?.envelope.seats.map((seat) => seat.kind)).toEqual(['human', 'human']);
    expect(harness.server.liveMatchSinkFailures).toEqual([]);
  });

  it('records concede_leave when a seat leaves', () => {
    const { sink, records } = capturingSink();
    const harness = createHarness({ liveMatchSink: sink });
    startMatch(harness);
    const [, guest] = harness.seats as [FakeConnection, FakeConnection];

    harness.send(guest, { type: 'leave' });

    expect(records).toHaveLength(1);
    expect(records[0]?.envelope.terminationOrigin).toBe('concede_leave');
    expect(records[0]?.envelope.outcome?.reason).toBe('concede');
  });

  it('records concede_action for an explicit concede', () => {
    const { sink, records } = capturingSink();
    const harness = createHarness({ liveMatchSink: sink });
    startMatch(harness);
    const [, guest] = harness.seats as [FakeConnection, FakeConnection];

    act(harness, guest, { type: 'concede', playerId: 'player_2' });

    expect(records).toHaveLength(1);
    expect(records[0]?.envelope.terminationOrigin).toBe('concede_action');
  });

  it('records disconnect_timeout when the grace window expires', () => {
    const { sink, records } = capturingSink();
    const harness = createHarness({ liveMatchSink: sink });
    startMatch(harness);
    const [host] = harness.seats as [FakeConnection, FakeConnection];

    harness.server.disconnect(host);
    expect(harness.timers).toHaveLength(1);
    harness.timers[0]?.fire();

    expect(records).toHaveLength(1);
    expect(records[0]?.envelope.terminationOrigin).toBe('disconnect_timeout');
  });

  it('still records the right origin after a mid-match reconnect', () => {
    const { sink, records } = capturingSink();
    const harness = createHarness({ liveMatchSink: sink });
    startMatch(harness);
    const [host, guest] = harness.seats as [FakeConnection, FakeConnection];

    harness.server.disconnect(host);
    const revived = new FakeConnection('conn_host_2');
    harness.server.connect(revived);
    harness.send(revived, {
      type: 'reconnect',
      versions: CURRENT_VERSIONS,
      reconnectToken: host.last('lobby_joined')?.reconnectToken as string,
    });

    harness.send(guest, { type: 'leave' });

    expect(records).toHaveLength(1);
    expect(records[0]?.envelope.terminationOrigin).toBe('concede_leave');
  });

  it('contains a throwing sink without losing the gameplay outcome', () => {
    const sink: LiveMatchSink = {
      sinkId: 'broken_lifecycle_sink',
      receive: () => {
        throw new Error('store unreachable');
      },
    };
    const harness = createHarness({ liveMatchSink: sink });
    startMatch(harness);
    const [host, guest] = harness.seats as [FakeConnection, FakeConnection];

    act(harness, guest, { type: 'concede', playerId: 'player_2' });

    expect(host.view().status).toBe('complete');
    expect(host.view().result?.winnerId).toBe('player_1');
    expect(harness.server.liveMatchSinkFailures).toEqual([
      'broken_lifecycle_sink: store unreachable',
    ]);
  });

  it('skips a free-for-all table the two-seat envelope does not cover, without recording a failure', () => {
    const { sink, records } = capturingSink();
    const table = createTable(3, { liveMatchSink: sink });
    startTable(table);
    keepAllHands(table);

    act(table, table.seats[1] as FakeConnection, { type: 'concede', playerId: 'player_2' });
    act(table, table.seats[2] as FakeConnection, { type: 'concede', playerId: 'player_3' });

    expect((table.seats[0] as FakeConnection).view().status).toBe('complete');
    expect(records).toEqual([]);
    expect(table.server.liveMatchSinkFailures).toEqual([]);
  });

  it('honours a configured retention policy', () => {
    const { sink, records } = capturingSink();
    const harness = createHarness({
      liveMatchSink: sink,
      liveMatchRetention: { rawEvent: true, replay: true },
    });
    startMatch(harness);
    const [, guest] = harness.seats as [FakeConnection, FakeConnection];

    act(harness, guest, { type: 'concede', playerId: 'player_2' });

    expect(records[0]?.rawEvent).not.toBeNull();
    expect(records[0]?.replay).not.toBeNull();
  });

  it('records no artifacts by default', () => {
    const { sink, records } = capturingSink();
    const harness = createHarness({ liveMatchSink: sink });
    startMatch(harness);
    const [, guest] = harness.seats as [FakeConnection, FakeConnection];

    act(harness, guest, { type: 'concede', playerId: 'player_2' });

    expect(records[0]?.rawEvent).toBeNull();
    expect(records[0]?.replay).toBeNull();
  });

  it('preserves the outcome across a simulated server restart delivering the same completion twice', () => {
    const { sink, records } = capturingSink();
    const harness = createHarness({ liveMatchSink: sink });
    startMatch(harness);
    const [, guest] = harness.seats as [FakeConnection, FakeConnection];

    act(harness, guest, { type: 'concede', playerId: 'player_2' });
    const record = records[0];
    if (!record) throw new Error('expected a record');

    const root = mkdtempSync(join(tmpdir(), 'tcg-live-match-lifecycle-'));
    try {
      // First delivery, as if the server persisted it before restarting.
      new LiveMatchFileStore({ rootDirectory: root }).receive(record);
      // A fresh store instance against the same directory, standing in for
      // the process that comes back up after the restart and redelivers the
      // same completion rather than losing it.
      expect(() => new LiveMatchFileStore({ rootDirectory: root }).receive(record)).not.toThrow();

      const matchDirectory = join(root, record.envelope.matchId);
      expect(existsSync(join(matchDirectory, 'envelope.json'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
