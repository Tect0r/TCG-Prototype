import type { SavedDeck } from '@tcg/deck';
import type { LobbySeatView, LobbyStatus, LobbyView, SeatId } from '@tcg/protocol';
import type { MatchState, PlayerId } from '@tcg/rules-engine';

/** Seat-to-engine-player mapping. Fixed, so logs and replays are stable. */
export const PLAYER_ID_BY_SEAT: Record<SeatId, PlayerId> = {
  seat_1: 'player_1',
  seat_2: 'player_2',
};

export const SEAT_IDS: readonly SeatId[] = ['seat_1', 'seat_2'];

export interface Seat {
  readonly seatId: SeatId;
  displayName: string;
  /** Opaque token the client stores to reclaim this seat after a refresh. */
  readonly reconnectToken: string;
  connectionId: string | null;
  deck: SavedDeck | null;
  deckLegal: boolean;
  ready: boolean;
  /**
   * Action IDs already applied, mapped to the sequence they produced. Replaying
   * one is answered with the current view instead of applying it twice.
   */
  readonly appliedActions: Map<string, number>;
  /** Highest event sequence this seat has been sent. */
  lastSentSequence: number;
  /** Cancels the pending disconnect-timeout loss, when one is scheduled. */
  cancelDisconnectTimer: (() => void) | null;
  disconnectDeadline: number | null;
}

export interface Lobby {
  readonly inviteCode: string;
  readonly hostSeatId: SeatId;
  readonly seats: Map<SeatId, Seat>;
  status: LobbyStatus;
  state: MatchState | null;
}

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TOKEN_ALPHABET = 'abcdef0123456789';

function pick(alphabet: string, length: number, random: () => number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(random() * alphabet.length)] ?? alphabet[0];
  }
  return out;
}

export function generateInviteCode(random: () => number, taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const code = pick(CODE_ALPHABET, 6, random);
    if (!taken.has(code)) return code;
  }
  throw new Error('Could not allocate a free invite code.');
}

export function generateReconnectToken(random: () => number): string {
  return pick(TOKEN_ALPHABET, 32, random);
}

export function createSeat(seatId: SeatId, displayName: string, token: string): Seat {
  return {
    seatId,
    displayName,
    reconnectToken: token,
    connectionId: null,
    deck: null,
    deckLegal: false,
    ready: false,
    appliedActions: new Map(),
    lastSentSequence: 0,
    cancelDisconnectTimer: null,
    disconnectDeadline: null,
  };
}

function seatView(seat: Seat, hostSeatId: SeatId): LobbySeatView {
  return {
    seatId: seat.seatId,
    displayName: seat.displayName,
    connected: seat.connectionId !== null,
    ready: seat.ready,
    deckName: seat.deck?.name ?? null,
    deckLegal: seat.deckLegal,
    isHost: seat.seatId === hostSeatId,
  };
}

/** The public lobby picture. Contains no deck contents — only that a deck exists. */
export function lobbyView(lobby: Lobby): LobbyView {
  return {
    inviteCode: lobby.inviteCode,
    status: lobby.status,
    seats: SEAT_IDS.map((seatId) => lobby.seats.get(seatId))
      .filter((seat): seat is Seat => seat !== undefined)
      .map((seat) => seatView(seat, lobby.hostSeatId)),
  };
}

export function seatByToken(lobby: Lobby, token: string): Seat | undefined {
  for (const seat of lobby.seats.values()) {
    if (seat.reconnectToken === token) return seat;
  }
  return undefined;
}

export function bothSeatsReady(lobby: Lobby): boolean {
  if (lobby.seats.size < 2) return false;
  for (const seat of lobby.seats.values()) {
    if (!seat.ready || !seat.deckLegal || seat.deck === null) return false;
  }
  return true;
}
