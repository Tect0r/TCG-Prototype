import { publicBotSeatOf, type BotPacingBudgets, type BotSeatConfig } from '@tcg/bot-config';
import type { SavedDeck } from '@tcg/deck';
import {
  MAX_BOT_SEATS,
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

/**
 * `MAX_BOT_SEATS` is one fewer than the table can hold, because **every table
 * keeps at least one human** (M09.7). It is defined in `@tcg/protocol` beside
 * the other seat counts so the host's screen and the authoritative lobby read
 * one number rather than two copies of it.
 *
 * Here the guarantee is already structural — `freeBotSeats` never offers the
 * host's seat, and the host seat is created with a person in it and is never
 * deleted — so the ceiling is not what stops the fourth bot today. It is checked
 * anyway, so that a later change to seat allocation cannot produce an all-bot
 * table by accident and call it a bug in something else.
 */
export { SEAT_IDS, MIN_SEATS, MAX_SEATS, MAX_BOT_SEATS };

/**
 * What every seat has, whoever or whatever is in it: a name, a deck and a
 * verdict on it, a readiness flag, and the action bookkeeping the match needs.
 *
 * `appliedActions` and `lastSentSequence` are here rather than on the human seat
 * because a bot submits through the same `applyAction` path with the same
 * idempotent action identity (ADR 0024 §2). M09.4 is what starts using them for
 * a bot; the shape says now that a bot is not a second kind of actor.
 */
interface SeatBase {
  readonly seatId: SeatId;
  displayName: string;
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
}

/**
 * A seat with a person in it — the only kind that existed before M09.3, and the
 * only kind that owns a connection.
 */
export interface HumanSeat extends SeatBase {
  readonly controller: 'human';
  /** Opaque token the client stores to reclaim this seat after a refresh. */
  readonly reconnectToken: string;
  connectionId: string | null;
  /**
   * Cancels this seat's pending disconnect-timeout loss. Each seat has its own
   * window: one player dropping does not stop the match (CLAUDE.md §12).
   */
  cancelDisconnectTimer: (() => void) | null;
  disconnectDeadline: number | null;
}

/**
 * A seat the server itself occupies.
 *
 * The four fields above that a human seat carries — reconnect token, connection
 * ID, disconnect timer and deadline — are **absent by type**, not null. Every
 * one of them describes a network participant that can go away, and a bot
 * controller lives inside this process: it cannot disconnect because there is
 * nothing for it to disconnect from ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md)
 * §1, and `FIELDS_A_BOT_CONTROLLER_NEVER_HAS` in `@tcg/bot-config`). Writing
 * `seat.connectionId` on a bot seat is a compile error rather than a review
 * note, which is the whole reason this is a union and not one widened object.
 *
 * `config` is the private configuration. It never reaches a client as it is;
 * `publicBotSeatOf` is the only route to what other seats may see.
 */
export interface BotSeat extends SeatBase {
  readonly controller: 'bot';
  config: BotSeatConfig;
}

export type Seat = HumanSeat | BotSeat;

export function isHumanSeat(seat: Seat): seat is HumanSeat {
  return seat.controller === 'human';
}

export function isBotSeat(seat: Seat): seat is BotSeat {
  return seat.controller === 'bot';
}

export interface Lobby {
  readonly inviteCode: string;
  readonly hostSeatId: SeatId;
  readonly seats: Map<SeatId, Seat>;
  /** Table size, host-controlled until the match starts. */
  maxSeats: number;
  /**
   * How many bot seats this lobby has ever created. Only ever increases, so a
   * removed-and-re-added bot is a *different* bot with a different ID rather
   * than the previous one's identity handed to a new configuration.
   */
  botsCreated: number;
  /**
   * This table's bot pacing budgets (M09.11).
   *
   * Lobby state rather than per-seat state, because the budget is the table's
   * and the percentage is the bot's: three bots at 50% wait half of one number.
   * It lives here rather than in `RulesConfig` because it is **configuration,
   * not a rule** — putting it beside the match rules would quietly pre-answer
   * open-questions.md Q8 in the direction of "yes, phases have timers"
   * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §4).
   *
   * It survives everything short of the lobby: seats coming and going, bots
   * being reconfigured, and the host reconnecting all leave it where it was.
   */
  pacing: BotPacingBudgets;
  /**
   * The budgets as they were when the match started, or `null` before it does.
   *
   * The lock is structural rather than a promise about the handlers. Every path
   * that could change `pacing` is already refused once the lobby has started, so
   * this is a second lock and not the only one — but it is the one that makes
   * "the match ran under these budgets" a value the result can be read off,
   * rather than an inference from the absence of a mutation.
   */
  lockedPacing: BotPacingBudgets | null;
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

export function createHumanSeat(seatId: SeatId, displayName: string, token: string): HumanSeat {
  return {
    controller: 'human',
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

/**
 * A configured bot seat.
 *
 * A bot with a legal deck is ready the moment it is configured: there is nobody
 * to press a button, and a seat the server has already validated has nothing
 * left to wait for. A bot with **no** deck is deliberately not ready and not
 * legal, so it is visibly unstartable rather than quietly holding the table up —
 * the state the generated modes pass through before M09.9 builds their list.
 */
export function createBotSeat(
  seatId: SeatId,
  config: BotSeatConfig,
  deck: SavedDeck | null,
): BotSeat {
  return {
    controller: 'bot',
    seatId,
    displayName: config.controller.displayName,
    config,
    deck,
    deckLegal: deck !== null,
    ready: deck !== null,
    appliedActions: new Map(),
    lastSentSequence: 0,
  };
}

/** Occupied seats, always in seat order. */
export function seatsOf(lobby: Lobby): Seat[] {
  return SEAT_IDS.map((seatId) => lobby.seats.get(seatId)).filter(
    (seat): seat is Seat => seat !== undefined,
  );
}

export function humanSeatsOf(lobby: Lobby): HumanSeat[] {
  return seatsOf(lobby).filter(isHumanSeat);
}

export function botSeatsOf(lobby: Lobby): BotSeat[] {
  return seatsOf(lobby).filter(isBotSeat);
}

/** The seat IDs a new player could take, within the host's chosen table size. */
export function freeSeats(lobby: Lobby): SeatId[] {
  return SEAT_IDS.slice(0, lobby.maxSeats).filter((seatId) => !lobby.seats.has(seatId));
}

/**
 * The seat IDs a bot could take: the free ones, minus the host's.
 *
 * Free seats are allocated deterministically in seat order, and an *occupied*
 * seat is never in the list — so adding a bot cannot evict anybody, and a human
 * joining later takes the next free seat rather than the bot's. The host seat is
 * excluded even when it is vacant, because a bot must never end up holding the
 * seat the lobby takes its host from — which is also what keeps at least one
 * human at every table (M09.7), with `MAX_BOT_SEATS` stating the same limit as a
 * number rather than leaving it to be inferred from the two rules above.
 */
export function freeBotSeats(lobby: Lobby): SeatId[] {
  if (botSeatsOf(lobby).length >= MAX_BOT_SEATS) return [];
  return freeSeats(lobby).filter((seatId) => seatId !== lobby.hostSeatId);
}

export function seatByToken(lobby: Lobby, token: string): HumanSeat | undefined {
  for (const seat of lobby.seats.values()) {
    if (isHumanSeat(seat) && seat.reconnectToken === token) return seat;
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
 * Everyone who *is* seated must be ready, so nobody is dragged in mid-setup —
 * and a bot seat is judged by exactly the same three conditions, so one that
 * holds no legal deck gates the start instead of stalling the match later.
 */
export function canStart(lobby: Lobby): boolean {
  if (lobby.status === 'in_match' || lobby.status === 'finished') return false;
  const seats = seatsOf(lobby);
  if (seats.length < MIN_SEATS) return false;
  return seats.every(isSeatReady);
}

/**
 * The deck name a bot seat publishes.
 *
 * A precon is shipped public content — every client already has the list — so
 * naming it says nothing an opponent could not read off the ID that is public
 * anyway. Every other mode publishes nothing here: a saved deck's name is
 * M09.6's decision and a generated list's is M09.9's, and defaulting to "show
 * it" would make that decision by accident, in the direction that leaks
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §3).
 */
function botDeckNameOf(seat: BotSeat): string | null {
  return seat.config.deck.mode === 'exact_precon' ? (seat.deck?.name ?? null) : null;
}

function seatView(
  seat: Seat,
  lobby: Lobby,
  graceSeconds: number | null,
  eliminated: boolean,
): LobbySeatView {
  const shared = {
    seatId: seat.seatId,
    displayName: seat.displayName,
    ready: seat.ready,
    deckLegal: seat.deckLegal,
    isHost: seat.seatId === lobby.hostSeatId,
    eliminated,
  };

  if (isBotSeat(seat)) {
    return {
      ...shared,
      // A bot is always connected and never counting down a reconnect window.
      // The wire narrows both to these values; the server states them because
      // they are facts about the controller, not defaults.
      connected: true,
      graceSeconds: null,
      deckName: botDeckNameOf(seat),
      controller: 'bot',
      bot: publicBotSeatOf(seat.config),
    };
  }

  return {
    ...shared,
    connected: seat.connectionId !== null,
    graceSeconds,
    deckName: seat.deck?.name ?? null,
    controller: 'human',
    bot: null,
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
    // The frozen budgets once there are any: after the match starts, what every
    // seat is shown is what the match locked, whatever a later change to the
    // live record might do (M09.11).
    botPacing: lobby.lockedPacing ?? lobby.pacing,
  };
}

export function graceSecondsFor(seat: Seat, now: () => number = Date.now): number | null {
  if (!isHumanSeat(seat) || seat.disconnectDeadline === null) return null;
  return Math.max(0, Math.round((seat.disconnectDeadline - now()) / 1000));
}

export function isEliminated(lobby: Lobby, seat: Seat): boolean {
  const player = lobby.state?.players[PLAYER_ID_BY_SEAT[seat.seatId]];
  return player?.lost ?? false;
}
