import { beforeEach, describe, expect, it } from 'vitest';
import {
  isColorIdentityLegal,
  loadBundledCardData,
  type CardDatabase,
  type CardId,
} from '@tcg/card-data';
import { DECK_SCHEMA_VERSION, type SavedDeck } from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  encode,
  type ClientMessageInput,
  type ServerMessage,
} from '@tcg/protocol';
import type { Action, PlayerView } from '@tcg/rules-engine';
import { MatchServer, type ScheduleTimer, type ServerConnection } from './match-server.js';

/**
 * Protocol-level integration tests. They drive the real `MatchServer` through
 * encoded messages — the same path a socket takes — without opening a port, so
 * lobby, reconnection, idempotency and hidden-information behaviour are all
 * covered deterministically. The socket transport itself is covered separately
 * in `ws-integration.test.ts`.
 */

const database: CardDatabase = loadBundledCardData().database;

/** A legal 30-card deck built from whatever the bundled set offers. */
function legalDeckFor(commanderId: CardId, name: string): SavedDeck {
  const commander = database.getOrThrow(commanderId);
  const pool = database
    .deckable()
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

/** Deterministic replacement for Math.random. */
function sequenceRandom(): () => number {
  let counter = 0;
  return () => {
    counter += 1;
    return ((counter * 2654435761) % 4294967296) / 4294967296;
  };
}

interface Harness {
  readonly server: MatchServer;
  readonly host: FakeConnection;
  readonly guest: FakeConnection;
  readonly inviteCode: string;
  readonly tokens: { host: string; guest: string };
  readonly timers: { delayMs: number; fire: () => void }[];
  send(connection: FakeConnection, message: ClientMessageInput): void;
}

function createHarness(): Harness {
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
    random: sequenceRandom(),
    schedule,
    seedFor: () => 'fixed-server-seed',
    now: () => 1_000_000,
  });

  const send = (connection: FakeConnection, message: ClientMessageInput): void => {
    server.receive(connection, encode(message as never));
  };

  const host = new FakeConnection('conn_host');
  server.connect(host);
  send(host, { type: 'create_lobby', versions: CURRENT_VERSIONS, displayName: 'Host' });
  const hostJoined = host.last('lobby_joined');
  if (!hostJoined) throw new Error('Host did not join');

  const guest = new FakeConnection('conn_guest');
  server.connect(guest);
  send(guest, {
    type: 'join_lobby',
    versions: CURRENT_VERSIONS,
    inviteCode: hostJoined.lobby.inviteCode,
    displayName: 'Guest',
  });
  const guestJoined = guest.last('lobby_joined');
  if (!guestJoined) throw new Error('Guest did not join');

  return {
    server,
    host,
    guest,
    inviteCode: hostJoined.lobby.inviteCode,
    tokens: { host: hostJoined.reconnectToken, guest: guestJoined.reconnectToken },
    timers,
    send,
  };
}

function startMatch(harness: Harness): void {
  harness.send(harness.host, {
    type: 'submit_deck',
    deck: legalDeckFor('prototype_commander_blue_red', 'Host Deck'),
  });
  harness.send(harness.guest, {
    type: 'submit_deck',
    deck: legalDeckFor('prototype_commander_blue_red', 'Guest Deck'),
  });
  harness.send(harness.host, { type: 'set_ready', ready: true });
  harness.send(harness.guest, { type: 'set_ready', ready: true });
}

let actionCounter = 0;
function act(harness: Harness, connection: FakeConnection, action: Action): void {
  actionCounter += 1;
  harness.send(connection, {
    type: 'submit_action',
    actionId: `action_${actionCounter}`,
    lastSequence: connection.view().sequence,
    action,
  });
}

/**
 * Answers whatever choice is outstanding, from whichever seat owns it. Card
 * triggers pause the match legitimately, so a driver has to cope with that
 * rather than assume it can always pass a phase.
 */
function resolvePendingChoices(harness: Harness): void {
  for (let guard = 0; guard < 20; guard += 1) {
    const pending = [harness.host, harness.guest].find(
      (connection) => connection.view().pendingChoice !== null,
    );
    const choice = pending?.view().pendingChoice;
    if (!pending || !choice) return;
    act(harness, pending, {
      type: 'submit_choice',
      playerId: pending.view().viewerId,
      choiceId: choice.id,
      selectedIds: choice.ordered
        ? [...choice.validEntityIds]
        : choice.validEntityIds.slice(0, choice.minimum),
    });
  }
}

beforeEach(() => {
  actionCounter = 0;
});

describe('lobby lifecycle', () => {
  it('creates a private lobby with an invite code and seats two players', () => {
    const harness = createHarness();

    expect(harness.inviteCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(harness.tokens.host).not.toBe(harness.tokens.guest);

    const lobby = harness.host.last('lobby_updated')?.lobby;
    expect(lobby?.seats).toHaveLength(2);
    expect(lobby?.seats.map((seat) => seat.displayName)).toEqual(['Host', 'Guest']);
    expect(lobby?.seats[0]?.isHost).toBe(true);
  });

  it('rejects an unknown invite code', () => {
    const harness = createHarness();
    const stranger = new FakeConnection('conn_stranger');
    harness.server.connect(stranger);
    harness.send(stranger, {
      type: 'join_lobby',
      versions: CURRENT_VERSIONS,
      inviteCode: 'ZZZZZZ',
      displayName: 'Stranger',
    });
    expect(stranger.last('error')?.error.code).toBe('protocol/unknown_lobby');
  });

  it('rejects a third player', () => {
    const harness = createHarness();
    const third = new FakeConnection('conn_third');
    harness.server.connect(third);
    harness.send(third, {
      type: 'join_lobby',
      versions: CURRENT_VERSIONS,
      inviteCode: harness.inviteCode,
      displayName: 'Third',
    });
    expect(third.last('error')?.error.code).toBe('protocol/lobby_full');
  });

  it('reports a version mismatch with actionable detail', () => {
    const harness = createHarness();
    const outdated = new FakeConnection('conn_old');
    harness.server.connect(outdated);
    harness.send(outdated, {
      type: 'create_lobby',
      versions: { ...CURRENT_VERSIONS, protocol: CURRENT_VERSIONS.protocol + 1 },
      displayName: 'Old Client',
    });

    const error = outdated.last('error')?.error;
    expect(error?.code).toBe('protocol/version_mismatch');
    expect(error?.details?.[0]).toContain('protocol');
  });

  it('rejects a malformed frame without disturbing the lobby', () => {
    const harness = createHarness();
    harness.server.receive(harness.host, '{not json');
    expect(harness.host.last('error')?.error.code).toBe('protocol/malformed_message');
    expect(harness.server.lobbyCount).toBe(1);
  });
});

describe('deck validation', () => {
  it('rejects an illegal deck with the reasons, and blocks readying up', () => {
    const harness = createHarness();
    const short: SavedDeck = {
      ...legalDeckFor('prototype_commander_blue_red', 'Short'),
      cards: [],
    };

    harness.send(harness.host, { type: 'submit_deck', deck: short });
    const rejection = harness.host.last('deck_rejected');
    expect(rejection?.error.code).toBe('protocol/deck_illegal');
    expect(rejection?.error.details?.join(' ')).toContain('30');

    harness.send(harness.host, { type: 'set_ready', ready: true });
    expect(harness.host.last('error')?.error.code).toBe('protocol/deck_required');
  });

  it('starts the match once both seats submit a legal deck and ready up', () => {
    const harness = createHarness();
    startMatch(harness);

    expect(harness.host.last('lobby_updated')?.lobby.status).toBe('in_match');
    expect(harness.host.view().status).toBe('mulligan');
    expect(harness.guest.view().status).toBe('mulligan');
    expect(harness.host.view().viewerId).toBe('player_1');
    expect(harness.guest.view().viewerId).toBe('player_2');
  });
});

describe('hidden information', () => {
  it('never sends a seat the opponent hand or deck order', () => {
    const harness = createHarness();
    startMatch(harness);

    for (const [connection, ownId, opponentId] of [
      [harness.host, 'player_1', 'player_2'],
      [harness.guest, 'player_2', 'player_1'],
    ] as const) {
      const view = connection.view();
      expect(view.viewerId).toBe(ownId);
      expect(view.hand.length).toBeGreaterThan(0);

      const opponent = view.players.find((player) => player.playerId === opponentId);
      expect(opponent?.handCount).toBeGreaterThan(0);

      // Every instance the client can identify belongs to a public zone or the
      // viewer's own hand.
      for (const instance of Object.values(view.instances)) {
        const isOwnHand = instance.owner === ownId && instance.zone === 'hand';
        expect(isOwnHand || instance.zone !== 'hand').toBe(true);
        expect(instance.zone).not.toBe('deck');
      }
      expect(JSON.stringify(view)).not.toContain('"rng"');
    }
  });
});

describe('actions', () => {
  it('applies a legal action and broadcasts the new state to both seats', () => {
    const harness = createHarness();
    startMatch(harness);

    const before = harness.guest.view().sequence;
    act(harness, harness.host, { type: 'mulligan', playerId: 'player_1', returnInstanceIds: [] });

    expect(harness.guest.view().sequence).toBeGreaterThan(before);
    const guestEvents = harness.guest.last('match_state')?.events ?? [];
    expect(guestEvents.some((event) => event.type === 'mulligan_submitted')).toBe(true);
  });

  it('rejects an action submitted for the other seat', () => {
    const harness = createHarness();
    startMatch(harness);

    act(harness, harness.host, { type: 'mulligan', playerId: 'player_2', returnInstanceIds: [] });
    expect(harness.host.last('action_rejected')?.error.code).toBe('protocol/wrong_seat');
  });

  it('rejects an action decided on a stale view and resends the current one', () => {
    const harness = createHarness();
    startMatch(harness);

    harness.send(harness.host, {
      type: 'submit_action',
      actionId: 'stale_1',
      lastSequence: 0,
      action: { type: 'mulligan', playerId: 'player_1', returnInstanceIds: [] },
    });

    expect(harness.host.last('action_rejected')?.error.code).toBe('protocol/stale_revision');
    expect(harness.host.view().sequence).toBeGreaterThan(0);
  });

  it('treats a repeated action ID as a no-op', () => {
    const harness = createHarness();
    startMatch(harness);

    const sequenceBefore = harness.host.view().sequence;
    harness.send(harness.host, {
      type: 'submit_action',
      actionId: 'once',
      lastSequence: sequenceBefore,
      action: { type: 'mulligan', playerId: 'player_1', returnInstanceIds: [] },
    });
    const afterFirst = harness.host.view().sequence;
    expect(afterFirst).toBeGreaterThan(sequenceBefore);

    // The retry carries the original (now stale) sequence, exactly as a client
    // replaying after a reconnect would.
    harness.send(harness.host, {
      type: 'submit_action',
      actionId: 'once',
      lastSequence: sequenceBefore,
      action: { type: 'mulligan', playerId: 'player_1', returnInstanceIds: [] },
    });

    expect(harness.host.last('action_rejected')).toBeUndefined();
    expect(harness.host.view().sequence).toBe(afterFirst);
  });

  it('passes engine rejections through with their structured code', () => {
    const harness = createHarness();
    startMatch(harness);
    act(harness, harness.host, { type: 'mulligan', playerId: 'player_1', returnInstanceIds: [] });
    act(harness, harness.host, { type: 'mulligan', playerId: 'player_1', returnInstanceIds: [] });

    expect(harness.host.last('action_rejected')?.error.code).toBe(
      'engine/mulligan_already_submitted',
    );
  });
});

describe('reconnection', () => {
  it('restores the seat and the current view after a dropped connection', () => {
    const harness = createHarness();
    startMatch(harness);
    act(harness, harness.host, { type: 'mulligan', playerId: 'player_1', returnInstanceIds: [] });
    const sequenceBefore = harness.host.view().sequence;

    harness.server.disconnect(harness.host);
    expect(harness.guest.last('opponent_connection')?.connected).toBe(false);
    expect(harness.guest.last('opponent_connection')?.graceSeconds).toBeGreaterThan(0);

    const revived = new FakeConnection('conn_host_2');
    harness.server.connect(revived);
    harness.send(revived, {
      type: 'reconnect',
      versions: CURRENT_VERSIONS,
      reconnectToken: harness.tokens.host,
    });

    expect(revived.last('lobby_joined')?.seatId).toBe('seat_1');
    expect(revived.view().sequence).toBe(sequenceBefore);
    expect(revived.view().viewerId).toBe('player_1');
    expect(harness.guest.last('opponent_connection')?.connected).toBe(true);
    // The pending disconnect loss was cancelled.
    expect(harness.timers).toHaveLength(0);
  });

  it('does not replay an action across a reconnect', () => {
    const harness = createHarness();
    startMatch(harness);
    const sequenceBefore = harness.host.view().sequence;
    harness.send(harness.host, {
      type: 'submit_action',
      actionId: 'keep_hand',
      lastSequence: sequenceBefore,
      action: { type: 'mulligan', playerId: 'player_1', returnInstanceIds: [] },
    });
    const afterApply = harness.host.view().sequence;

    harness.server.disconnect(harness.host);
    const revived = new FakeConnection('conn_host_2');
    harness.server.connect(revived);
    harness.send(revived, {
      type: 'reconnect',
      versions: CURRENT_VERSIONS,
      reconnectToken: harness.tokens.host,
    });

    // The client retries the action it was unsure about.
    harness.send(revived, {
      type: 'submit_action',
      actionId: 'keep_hand',
      lastSequence: sequenceBefore,
      action: { type: 'mulligan', playerId: 'player_1', returnInstanceIds: [] },
    });

    expect(revived.view().sequence).toBe(afterApply);
    const submissions = revived
      .view()
      .log.filter((event) => event.type === 'mulligan_submitted' && event.playerId === 'player_1');
    expect(submissions).toHaveLength(1);
  });

  it('rejects an unknown reconnect token', () => {
    const harness = createHarness();
    const stranger = new FakeConnection('conn_stranger');
    harness.server.connect(stranger);
    harness.send(stranger, {
      type: 'reconnect',
      versions: CURRENT_VERSIONS,
      reconnectToken: 'a'.repeat(32),
    });
    expect(stranger.last('error')?.error.code).toBe('protocol/unknown_token');
  });

  it('loses the match when the disconnect window expires', () => {
    const harness = createHarness();
    startMatch(harness);

    harness.server.disconnect(harness.host);
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0]?.delayMs).toBe(90_000);

    harness.timers[0]?.fire();

    const view = harness.guest.view();
    expect(view.status).toBe('complete');
    expect(view.result?.reason).toBe('timeout');
    expect(view.result?.winnerId).toBe('player_2');
  });
});

describe('match termination', () => {
  it('ends the match when a player leaves', () => {
    const harness = createHarness();
    startMatch(harness);

    harness.send(harness.guest, { type: 'leave' });

    const view = harness.host.view();
    expect(view.status).toBe('complete');
    expect(view.result?.reason).toBe('concede');
    expect(view.result?.winnerId).toBe('player_1');
  });

  it('plays a complete match through the protocol and reports a winner', () => {
    const harness = createHarness();
    startMatch(harness);

    act(harness, harness.host, { type: 'mulligan', playerId: 'player_1', returnInstanceIds: [] });
    act(harness, harness.guest, { type: 'mulligan', playerId: 'player_2', returnInstanceIds: [] });

    expect(harness.host.view().turn).toBe(1);
    resolvePendingChoices(harness);
    expect(harness.host.view().status).toBe('playing');

    // Pass a few turns back and forth, then concede.
    for (let i = 0; i < 4; i += 1) {
      const view = harness.host.view();
      if (view.status === 'complete') break;
      const activeConnection = view.activePlayerId === 'player_1' ? harness.host : harness.guest;
      const activeId = view.activePlayerId;
      act(harness, activeConnection, { type: 'pass_phase', playerId: activeId });
      resolvePendingChoices(harness);
      act(harness, activeConnection, {
        type: 'declare_attackers',
        playerId: activeId,
        attackerInstanceIds: [],
      });
      resolvePendingChoices(harness);
      act(harness, activeConnection, { type: 'pass_phase', playerId: activeId });
      resolvePendingChoices(harness);
    }

    act(harness, harness.guest, { type: 'concede', playerId: 'player_2' });
    expect(harness.host.view().result?.winnerId).toBe('player_1');
    expect(harness.host.last('lobby_updated')?.lobby.status).toBe('finished');
  });

  it('plays a full match to a natural finish, driven only by server-supplied legality', () => {
    const harness = createHarness();
    startMatch(harness);

    // Both "clients" decide purely from `view.legalActions`, exactly as the UI
    // does: nothing here knows a single game rule.
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
      if (legal.legalAttackers) {
        act(harness, connection, {
          type: 'declare_attackers',
          playerId: me,
          attackerInstanceIds: [...legal.legalAttackers],
        });
        return true;
      }
      if (legal.blocking) {
        act(harness, connection, { type: 'assign_blockers', playerId: me, blocks: [] });
        return true;
      }
      const card = legal.playableCards[0];
      if (card) {
        act(harness, connection, {
          type: 'play_card',
          playerId: me,
          instanceId: card.instanceId,
          slot: card.freeSlots[0] ?? null,
        });
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
      if (harness.host.view().status === 'complete') break;
      progressed = step(harness.host) || step(harness.guest);
    }

    const view = harness.host.view();
    expect(view.status).toBe('complete');
    expect(view.result).not.toBeNull();
    // A real ending, not a concession or an engine fault.
    expect(['health_depleted', 'empty_deck', 'simultaneous_loss']).toContain(view.result?.reason);
    expect(harness.guest.view().result?.winnerId).toBe(view.result?.winnerId);
  });
});
