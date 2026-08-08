import type { SavedDeck } from '@tcg/deck';
import {
  MAX_SEATS,
  MIN_SEATS,
  SEAT_IDS,
  type LobbySeatView,
  type LobbyStatus,
  type LobbyView,
  type SeatId,
} from '@tcg/protocol';
import type { MatchState, PlayerId } from '@tcg/rules-engine';

/**
 * Seat-to-engine-player mapping. Fixed, so logs and replays are stable — and
 * one-to-one, so a seat ID never has to be parsed out of a player ID.
 */
export const PLAYER_ID_BY_SEAT: Record<SeatId, PlayerId> = {
  seat_1: 'player_1',
  seat_2: 'player_2',
  seat_3: 'player_3',
  seat_4: 'player_4',
};

export const SEAT_BY_PLAYER_ID: Record<PlayerId, SeatId> = Object.fromEntries(
  SEAT_IDS.map((seatId) => [PLAYER_ID_BY_SEAT[seatId], seatId]),
) as Record<PlayerId, SeatId>;

export { SEAT_IDS, MIN_SEATS, MAX_SEATS };

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
  /**
   * Cancels this seat's pending disconnect-timeout loss. Each seat has its own
   * window: one player dropping does not stop the match (CLAUDE.md §12).
   */
  cancelDisconnectTimer: (() => void) | null;
  disconnectDeadline: number | null;
}

export interface Lobby {
  readonly inviteCode: string;
  readonly hostSeatId: SeatId;
  readonly seats: Map<SeatId, Seat>;
  /** Table size, host-controlled until the match starts. */
  maxSeats: number;
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

/** Occupied seats, always in seat order. */
export function seatsOf(lobby: Lobby): Seat[] {
  return SEAT_IDS.map((seatId) => lobby.seats.get(seatId)).filter(
    (seat): seat is Seat => seat !== undefined,
  );
}

/** The seat IDs a new player could take, within the host's chosen table size. */
export function freeSeats(lobby: Lobby): SeatId[] {
  return SEAT_IDS.slice(0, lobby.maxSeats).filter((seatId) => !lobby.seats.has(seatId));
}

export function seatByToken(lobby: Lobby, token: string): Seat | undefined {
  for (const seat of lobby.seats.values()) {
    if (seat.reconnectToken === token) return seat;
  }
  return undefined;
}

function isSeatReady(seat: Seat): boolean {
  return seat.ready && seat.deckLegal && seat.deck !== null;
}

/**
 * Whether the host could start right now.
 *
 * A free-for-all needs at least two ready seats but does not need every opened
 * seat filled: a four-seat lobby may legally start with three (CLAUDE.md §12).
 * Everyone who *is* seated must be ready, so nobody is dragged in mid-setup.
 */
export function canStart(lobby: Lobby): boolean {
  if (lobby.status === 'in_match' || lobby.status === 'finished') return false;
  const seats = seatsOf(lobby);
  if (seats.length < MIN_SEATS) return false;
  return seats.every(isSeatReady);
}

function seatView(
  seat: Seat,
  lobby: Lobby,
  graceSeconds: number | null,
  eliminated: boolean,
): LobbySeatView {
  return {
    seatId: seat.seatId,
    displayName: seat.displayName,
    connected: seat.connectionId !== null,
    ready: seat.ready,
    deckName: seat.deck?.name ?? null,
    deckLegal: seat.deckLegal,
    isHost: seat.seatId === lobby.hostSeatId,
    graceSeconds,
    eliminated,
  };
}

/** The public lobby picture. Contains no deck contents — only that a deck exists. */
export function lobbyView(lobby: Lobby, now: () => number = Date.now): LobbyView {
  return {
    inviteCode: lobby.inviteCode,
    status: lobby.status,
    maxSeats: lobby.maxSeats,
    hostSeatId: lobby.hostSeatId,
    canStart: canStart(lobby),
    seats: seatsOf(lobby).map((seat) =>
      seatView(seat, lobby, graceSecondsFor(seat, now), isEliminated(lobby, seat)),
    ),
  };
}

export function graceSecondsFor(seat: Seat, now: () => number = Date.now): number | null {
  if (seat.disconnectDeadline === null) return null;
  return Math.max(0, Math.round((seat.disconnectDeadline - now()) / 1000));
}

export function isEliminated(lobby: Lobby, seat: Seat): boolean {
  const player = lobby.state?.players[PLAYER_ID_BY_SEAT[seat.seatId]];
  return player?.lost ?? false;
}
