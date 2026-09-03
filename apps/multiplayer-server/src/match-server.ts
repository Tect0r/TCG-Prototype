import {
  DEFAULT_BOT_PACING_BUDGETS,
  deckModeGenerates,
  readBotPacingBudgets,
  type BotPacingBudgets,
  type GeneratedDeckProvenance,
} from '@tcg/bot-config';
import type { BotPolicy } from '@tcg/bot-interface';
import { bundledPrecon, preconsForFormat, type CardDatabase } from '@tcg/card-data';
import {
  DEFAULT_DECK_FORMAT,
  expandDeckCards,
  preconToDeck,
  reviewPrecon,
  validateDeck,
  type DeckFormatConfig,
  type SavedDeck,
} from '@tcg/deck';
import { decideLiveMatchRetention, type LiveMatchRetentionConfig } from '@tcg/match-telemetry';
import {
  botLobbyError,
  CURRENT_VERSIONS,
  decodeClientMessage,
  protocolError,
  versionMismatch,
  type BotLobbyCondition,
  type BotSetup,
  type ClientMessage,
  type ProtocolError,
  type BotMatchSummary,
  type RevealedBotDeck,
  type SeatId,
  type ServerMessage,
  type Versions,
} from '@tcg/protocol';
import {
  applyAction,
  createMatch,
  DEFAULT_RULES_CONFIG,
  eventsSince,
  playerView,
  type Action,
  type MatchDeck,
  type RulesConfig,
} from '@tcg/rules-engine';
import { errorsOf, isErr } from '@tcg/shared';
import {
  botIdFor,
  carriedRerollCount,
  rerollUnsupportedDetails,
  resolveBotSeat,
  setupOf,
  type BotSeatContext,
  type ResolvedBotSeat,
} from './bot-seats.js';
import {
  BotRunner,
  type BotRunnerSeat,
  type BotRunReport,
  type BotSubmitResult,
} from './bot-runner.js';
import { buildBotMatchSummary, type BotSummarySink } from './bot-match-summary.js';
import { buildLiveMatchRecord, liveMatchTerminationOriginFor } from './live-match-record.js';
import type { LiveMatchRecord, LiveMatchSink } from './live-match-sink.js';
import { capturePreActionState } from './pre-action-capture.js';
import { LIVE_MATCH_SOFTWARE_VERSION } from './version.js';
import {
  botSeatsOf,
  canStart,
  createBotSeat,
  createHumanSeat,
  freeBotSeats,
  freeSeats,
  generateInviteCode,
  generateReconnectToken,
  graceSecondsFor,
  isBotSeat,
  isHumanSeat,
  lobbyView,
  MAX_SEATS,
  MIN_SEATS,
  PLAYER_ID_BY_SEAT,
  seatByToken,
  seatsOf,
  type BotSeat,
  type HumanSeat,
  type Lobby,
  type Seat,
} from './lobby.js';
import {
  defaultMonotonicClock,
  defaultSchedule,
  type MonotonicClock,
  type ScheduleTimer,
} from './scheduling.js';

/**
 * The provenance a bot seat carries, or `null` when it plays a list it was given.
 *
 * One reader for both generated modes, because "was this deck built here" is a
 * question about the deck and not about who chose the Commander: a screen that
 * asked mode by mode would have to be edited again the next time a mode
 * generates (M09.10).
 */
function generatedProvenanceOf(seat: BotSeat): GeneratedDeckProvenance | null {
  const source = seat.config.deck;
  return deckModeGenerates(source.mode) && 'generated' in source ? source.generated : null;
}

/**
 * Transport-agnostic authoritative server.
 *
 * Everything about lobbies, matches, reconnection and idempotency lives here
 * and is driven by plain `receive(connection, rawMessage)` calls, so the whole
 * protocol is testable without opening a socket. `ws-adapter.ts` is the only
 * file that knows what a WebSocket is.
 */
export interface ServerConnection {
  readonly id: string;
  send(message: ServerMessage): void;
  close(): void;
}

export type { MonotonicClock, ScheduleTimer } from './scheduling.js';

export interface MatchServerOptions {
  readonly database: CardDatabase;
  readonly config?: RulesConfig;
  readonly deckFormat?: DeckFormatConfig;
  /** Injectable so invite codes and tokens are deterministic in tests. */
  readonly random?: () => number;
  /**
   * Injectable so the disconnect window and every bot delay can be driven
   * without waiting. One seam for both, because there is one server owning both
   * and a test that had to stub two of them would eventually stub one.
   */
  readonly schedule?: ScheduleTimer;
  /**
   * A monotonic reading, used only to record how long a bot actually waited
   * (M09.12). Separate from `now` on purpose: `now` is a wall clock, and a wall
   * clock adjusted mid-match measures an elapsed wait as a negative number.
   */
  readonly monotonicNow?: MonotonicClock;
  /** Injectable so a match seed is reproducible in tests. */
  readonly seedFor?: (inviteCode: string) => string;
  readonly now?: () => number;
  /**
   * The stack-safety boundary a live bot yields at between decisions (M09.4).
   * Injectable so a test can count the yields; it is not a pacing dial, and
   * waiting is M09.12's.
   */
  readonly yieldToScheduler?: () => Promise<void>;
  /** Hard per-seat ceiling on bot decisions in one match. */
  readonly botDecisionLimit?: number;
  /**
   * Builds a bot seat's pilot. Injectable so the runner's failure and fallback
   * paths can be driven through a real match; production derives the pilot from
   * the seat's own style and difficulty.
   */
  readonly botPilotFor?: (seat: BotRunnerSeat) => BotPolicy;
  /**
   * Where a finished match's pacing summary goes after it is broadcast (M09.17).
   *
   * The whole of the ingestion seam: one optional collaborator, called once per
   * match. M08's durable Player Meta is an implementation of it and a line in
   * whatever constructs this server; nothing about the summary, the broadcast or
   * the match loop has to change to accept one. Absent by default, because this
   * build keeps no summaries — see `NO_DURABLE_SUMMARY_STORE`.
   */
  readonly summarySink?: BotSummarySink;
  /**
   * Where a finished match's canonical live-match record goes (M08.22A).
   *
   * The general-purpose sibling of `summarySink`: an optional collaborator,
   * called once per match, of every source — not only matches with a bot seat.
   * `publishLiveMatchRecord` (M08.22C) is the one live call site.
   */
  readonly liveMatchSink?: LiveMatchSink;
  /**
   * What this deployment keeps beyond the mandatory envelope (M08.21C),
   * decided per match from its termination origin via
   * `decideLiveMatchRetention`. Defaults to keeping none of the three optional
   * tiers — the same "off unless configured" default
   * `liveMatchRetentionConfigSchema` itself declares — so a deployment that
   * never sets this records the envelope alone.
   */
  readonly liveMatchRetention?: LiveMatchRetentionConfig;
}

/**
 * A live connection and the seat it holds.
 *
 * The seat is a `HumanSeat` by type: a connection can only ever be attached to
 * a seat a person is sitting in, and a bot seat has no connection to attach
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §1). Every
 * handler below reads its seat from here, so "a bot cannot submit a deck, ready
 * up, reconnect or act as a client" is a property of the type rather than a
 * check each handler has to remember.
 */
interface Attachment {
  readonly lobby: Lobby;
  readonly seat: HumanSeat;
}

export class MatchServer {
  readonly #database: CardDatabase;
  readonly #config: RulesConfig;
  readonly #deckFormat: DeckFormatConfig;
  readonly #random: () => number;
  readonly #schedule: ScheduleTimer;
  readonly #seedFor: (inviteCode: string) => string;
  readonly #now: () => number;
  readonly #monotonicNow: MonotonicClock;
  readonly #yieldToScheduler: (() => Promise<void>) | undefined;
  readonly #botDecisionLimit: number | undefined;
  readonly #botPilotFor: ((seat: BotRunnerSeat) => BotPolicy) | undefined;
  readonly #summarySink: BotSummarySink | undefined;
  readonly #summarySinkFailures: string[] = [];
  readonly #liveMatchSink: LiveMatchSink | undefined;
  readonly #liveMatchSinkFailures: string[] = [];
  readonly #liveMatchRetention: LiveMatchRetentionConfig;

  readonly #lobbies = new Map<string, Lobby>();
  readonly #connections = new Map<string, ServerConnection>();
  readonly #attachments = new Map<string, Attachment>();
  /** One live bot runner per lobby that started a match holding bot seats. */
  readonly #botRunners = new Map<string, BotRunner>();
  /** Cancelled pumps whose lobby has gone, tracked only until they settle. */
  readonly #detachedBotWork = new Set<Promise<void>>();

  constructor(options: MatchServerOptions) {
    this.#database = options.database;
    this.#config = options.config ?? DEFAULT_RULES_CONFIG;
    this.#deckFormat = options.deckFormat ?? DEFAULT_DECK_FORMAT;
    this.#random = options.random ?? Math.random;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#now = options.now ?? Date.now;
    this.#monotonicNow = options.monotonicNow ?? defaultMonotonicClock;
    this.#yieldToScheduler = options.yieldToScheduler;
    this.#botDecisionLimit = options.botDecisionLimit;
    this.#botPilotFor = options.botPilotFor;
    this.#summarySink = options.summarySink;
    this.#liveMatchSink = options.liveMatchSink;
    this.#liveMatchRetention = options.liveMatchRetention ?? {
      rawEvent: false,
      replay: false,
      preActionCapture: false,
    };
    this.#seedFor =
      options.seedFor ?? ((inviteCode) => `${inviteCode}-${this.#now()}-${this.#random()}`);
  }

  get lobbyCount(): number {
    return this.#lobbies.size;
  }

  /** Test/diagnostic access. The authoritative state never leaves the server otherwise. */
  lobbyByCode(inviteCode: string): Lobby | undefined {
    return this.#lobbies.get(inviteCode);
  }

  connect(connection: ServerConnection): void {
    this.#connections.set(connection.id, connection);
  }

  receive(connection: ServerConnection, raw: string): void {
    const decoded = decodeClientMessage(raw);
    if (isErr(decoded)) {
      connection.send({ type: 'error', error: decoded.error });
      return;
    }
    this.handle(connection, decoded.value);
  }

  handle(connection: ServerConnection, message: ClientMessage): void {
    switch (message.type) {
      case 'ping':
        connection.send({ type: 'pong' });
        return;
      case 'create_lobby':
        this.createLobby(connection, message.versions, message.displayName, message.maxSeats);
        return;
      case 'join_lobby':
        this.joinLobby(connection, message.versions, message.inviteCode, message.displayName);
        return;
      case 'set_max_seats':
        this.setMaxSeats(connection, message.maxSeats);
        return;
      case 'start_match':
        this.requestStart(connection);
        return;
      case 'add_bot':
        this.addBot(connection, message.setup);
        return;
      case 'update_bot':
        this.updateBot(connection, message.seatId, message.setup);
        return;
      case 'reroll_bot':
        this.rerollBot(connection, message.seatId);
        return;
      case 'remove_bot':
        this.removeBot(connection, message.seatId);
        return;
      case 'set_bot_pacing':
        this.setBotPacing(connection, message.budgets);
        return;
      case 'reconnect':
        this.reconnect(connection, message.versions, message.reconnectToken);
        return;
      case 'submit_deck':
        this.submitDeck(connection, message.deck);
        return;
      case 'submit_precon':
        this.submitPrecon(connection, message.preconId);
        return;
      case 'set_ready':
        this.setReady(connection, message.ready);
        return;
      case 'submit_action':
        this.submitAction(connection, message.actionId, message.lastSequence, message.action);
        return;
      case 'leave':
        this.leave(connection);
        return;
      default:
        connection.send({
          type: 'error',
          error: protocolError('protocol/malformed_message', 'Unrecognised message.'),
        });
    }
  }

  /** Called by the transport when a socket closes for any reason. */
  disconnect(connection: ServerConnection): void {
    this.#connections.delete(connection.id);
    const attachment = this.#attachments.get(connection.id);
    this.#attachments.delete(connection.id);
    if (!attachment) return;

    const { lobby, seat } = attachment;
    if (seat.connectionId !== connection.id) return;
    seat.connectionId = null;

    if (lobby.status === 'in_match' && lobby.state && lobby.state.status !== 'complete') {
      // A disconnected player has a fixed window to come back. Expiry submits an
      // explicit timeout action — the engine never reads a clock (CLAUDE.md §4).
      const graceMs = this.#config.disconnectGraceSeconds * 1000;
      seat.disconnectDeadline = this.#now() + graceMs;
      seat.cancelDisconnectTimer = this.#schedule(graceMs, () => {
        seat.cancelDisconnectTimer = null;
        seat.disconnectDeadline = null;
        this.timeOutSeat(lobby, seat);
      });
    }

    this.broadcastConnection(lobby, seat);
    this.broadcastLobby(lobby);
    this.closeIfAbandoned(lobby);
  }

  /* --------------------------------------------------------------- lobbies */

  private rejectVersions(connection: ServerConnection, versions: Versions): boolean {
    const problems = versionMismatch(versions, CURRENT_VERSIONS);
    if (problems.length === 0) return false;
    connection.send({
      type: 'error',
      error: protocolError(
        'protocol/version_mismatch',
        'This client is not compatible with the server. Reload to pick up the current version.',
        problems,
      ),
    });
    return true;
  }

  private createLobby(
    connection: ServerConnection,
    versions: Versions,
    displayName: string,
    maxSeats: number,
  ): void {
    if (this.rejectVersions(connection, versions)) return;

    const inviteCode = generateInviteCode(this.#random, new Set(this.#lobbies.keys()));
    const seat = createHumanSeat('seat_1', displayName, generateReconnectToken(this.#random));
    const lobby: Lobby = {
      inviteCode,
      hostSeatId: 'seat_1',
      seats: new Map([['seat_1', seat]]),
      maxSeats: Math.min(MAX_SEATS, Math.max(MIN_SEATS, maxSeats)),
      botsCreated: 0,
      // The milestone's own dials — 30 seconds and 5 — until the host moves
      // them. They are bot pacing references, not human timers (M09.11).
      pacing: DEFAULT_BOT_PACING_BUDGETS,
      lockedPacing: null,
      matchStartedAtMs: null,
      status: 'waiting',
      state: null,
      lastConcedeOrigin: null,
      lastPreActionCapture: null,
    };
    this.#lobbies.set(inviteCode, lobby);
    this.attach(connection, lobby, seat);
    connection.send({
      type: 'lobby_joined',
      versions: CURRENT_VERSIONS,
      seatId: seat.seatId,
      reconnectToken: seat.reconnectToken,
      lobby: this.viewOf(lobby),
    });
  }

  /**
   * Host-only table resize. The size can never drop below the seats that are
   * already occupied — nobody is evicted from a lobby they joined
   * (open-questions.md Q36).
   */
  private setMaxSeats(connection: ServerConnection, maxSeats: number): void {
    const attachment = this.#attachments.get(connection.id);
    if (!attachment) {
      this.fail(connection, 'protocol/not_in_lobby', 'Join a lobby first.');
      return;
    }
    const { lobby, seat } = attachment;
    if (seat.seatId !== lobby.hostSeatId) {
      this.fail(connection, 'protocol/not_host', 'Only the host can resize the table.');
      return;
    }
    if (lobby.status === 'in_match' || lobby.status === 'finished') {
      this.fail(connection, 'protocol/already_started', 'The match has already started.');
      return;
    }

    const occupied = seatsOf(lobby).length;
    if (maxSeats < occupied) {
      this.fail(
        connection,
        'protocol/lobby_full',
        `${occupied} players have already joined; the table cannot shrink below that.`,
      );
      return;
    }

    lobby.maxSeats = Math.min(MAX_SEATS, Math.max(MIN_SEATS, maxSeats));
    this.broadcastLobby(lobby);
  }

  /**
   * Host-only start. A free-for-all does not start itself the moment everyone
   * present is ready, because "two of four seats ready" is a legal state the
   * host may still be filling (CLAUDE.md §12).
   */
  private requestStart(connection: ServerConnection): void {
    const attachment = this.#attachments.get(connection.id);
    if (!attachment) {
      this.fail(connection, 'protocol/not_in_lobby', 'Join a lobby first.');
      return;
    }
    const { lobby, seat } = attachment;
    if (seat.seatId !== lobby.hostSeatId) {
      this.fail(connection, 'protocol/not_host', 'Only the host can start the match.');
      return;
    }
    if (lobby.status === 'in_match' || lobby.status === 'finished') {
      this.fail(connection, 'protocol/already_started', 'The match has already started.');
      return;
    }
    if (!canStart(lobby)) {
      this.fail(
        connection,
        'protocol/not_enough_players',
        'The match needs at least two seated players, each with a legal deck and marked ready.',
      );
      return;
    }
    this.startMatch(lobby);
  }

  /* ------------------------------------------------------------- bot seats */

  private refuseBot(
    connection: ServerConnection,
    condition: BotLobbyCondition,
    details?: readonly string[],
  ): void {
    connection.send({ type: 'error', error: botLobbyError(condition, details) });
  }

  /**
   * The preamble every bot message shares: the sender is seated, is the host,
   * and the lobby has not started.
   *
   * One helper rather than four copies, because these three conditions are the
   * ones a fifth bot message would be most likely to forget — and because
   * `HOST_ONLY_CLIENT_MESSAGE_TYPES` names the messages that must pass through
   * it, so the list and the check can be tested against each other.
   */
  private hostLobbyFor(connection: ServerConnection): Lobby | null {
    const attachment = this.#attachments.get(connection.id);
    if (!attachment) {
      this.fail(connection, 'protocol/not_in_lobby', 'Join a lobby first.');
      return null;
    }
    const { lobby, seat } = attachment;
    if (seat.seatId !== lobby.hostSeatId) {
      this.refuseBot(connection, 'not_host');
      return null;
    }
    if (lobby.status === 'in_match' || lobby.status === 'finished') {
      this.refuseBot(connection, 'lobby_locked');
      return null;
    }
    return lobby;
  }

  /** The seat named by a bot message, or a refusal saying it holds no bot. */
  private botSeatIn(connection: ServerConnection, lobby: Lobby, seatId: SeatId): BotSeat | null {
    const seat = lobby.seats.get(seatId);
    if (!seat || !isBotSeat(seat)) {
      this.refuseBot(connection, 'unknown_bot_seat', [
        seat ? `${seatId} holds a player, not a bot.` : `${seatId} is empty.`,
      ]);
      return null;
    }
    return seat;
  }

  private botSeatContext(): BotSeatContext {
    return { database: this.#database, deckFormat: this.#deckFormat, now: this.#now };
  }

  /**
   * Host-only: seat a bot.
   *
   * The seat is chosen by the server, deterministically, from the seats that are
   * genuinely free — the message carries no seat ID precisely so that a client
   * cannot race a joining human for one. Nothing is written until the setup has
   * resolved completely, so a refused configuration leaves the lobby exactly as
   * it was.
   */
  private addBot(connection: ServerConnection, setup: BotSetup): void {
    const lobby = this.hostLobbyFor(connection);
    if (!lobby) return;

    const seatId = freeBotSeats(lobby)[0];
    if (!seatId) {
      this.refuseBot(connection, 'table_full', [
        `This table has ${lobby.maxSeats} seats and every one of them is taken.`,
      ]);
      return;
    }

    const botId = botIdFor(lobby.botsCreated + 1);
    const resolved = resolveBotSeat(setup, { botId, seatId }, this.botSeatContext());
    if (isErr(resolved)) {
      connection.send({ type: 'error', error: resolved.error });
      return;
    }

    lobby.botsCreated += 1;
    lobby.seats.set(seatId, createBotSeat(seatId, resolved.value.config, resolved.value.deck));
    this.restatus(lobby);
    this.broadcastLobby(lobby);
  }

  /**
   * Host-only: replace one bot seat's configuration wholesale.
   *
   * The seat keeps its identity — the same `botId`, the same seat — because
   * identity and configuration are separate halves of a bot on purpose. A
   * refused setup leaves the previous configuration in place rather than
   * emptying the seat.
   */
  private updateBot(connection: ServerConnection, seatId: SeatId, setup: BotSetup): void {
    const lobby = this.hostLobbyFor(connection);
    if (!lobby) return;
    const seat = this.botSeatIn(connection, lobby, seatId);
    if (!seat) return;

    const resolved = resolveBotSeat(
      setup,
      { botId: seat.config.controller.botId, seatId },
      this.botSeatContext(),
      // A generated seat keeps its place in its own stream unless the host
      // changed what names that stream. Rebuilding at reroll 0 here would mean
      // that renaming a bot silently handed back a deck the host had rerolled
      // away from.
      { rerollCount: carriedRerollCount(seat.config, setup.deck) },
    );
    if (isErr(resolved)) {
      connection.send({ type: 'error', error: resolved.error });
      return;
    }

    this.seatResolvedBot(lobby, seat, resolved.value);
  }

  /**
   * Writes a resolved configuration onto a seat that already exists.
   *
   * Shared by `update_bot` and `reroll_bot` because they differ only in where
   * the setup came from: one is the host's new configuration, the other is the
   * seat's own configuration one step further along its generation stream. Both
   * keep the seat, its identity and its readiness rule identical.
   */
  private seatResolvedBot(lobby: Lobby, seat: BotSeat, resolved: ResolvedBotSeat): void {
    const { config, deck } = resolved;
    seat.config = config;
    seat.displayName = config.controller.displayName;
    seat.deck = deck;
    seat.deckLegal = deck !== null;
    seat.ready = deck !== null;
    this.restatus(lobby);
    this.broadcastLobby(lobby);
  }

  /**
   * Host-only: build this bot a new deck (M09.9).
   *
   * Rerolling is only meaningful for a mode that *generates* a list, so a seat
   * playing an exact one is refused by name rather than treated as a harmless
   * no-op — a host who asked for a new deck and silently got the old one has
   * been told nothing.
   *
   * For a generated seat this is one step along the seat's own stream: the
   * configuration is rebuilt from what the seat already holds, the reroll count
   * goes up by exactly one, and the new seed follows from the base seed and that
   * count. No seed travels on this message, so the recorded transition is the
   * server's and is reproducible from the provenance the host is sent. A refused
   * generation leaves the previous deck in place: rerolling never empties a
   * seat.
   */
  private rerollBot(connection: ServerConnection, seatId: SeatId): void {
    const lobby = this.hostLobbyFor(connection);
    if (!lobby) return;
    const seat = this.botSeatIn(connection, lobby, seatId);
    if (!seat) return;

    const source = seat.config.deck;
    if (!deckModeGenerates(source.mode)) {
      this.refuseBot(connection, 'mode_unsupported', rerollUnsupportedDetails(seatId, source.mode));
      return;
    }

    const resolved = resolveBotSeat(
      setupOf(seat.config),
      { botId: seat.config.controller.botId, seatId },
      this.botSeatContext(),
      { rerollCount: (('generated' in source ? source.generated?.rerollCount : 0) ?? 0) + 1 },
    );
    if (isErr(resolved)) {
      connection.send({ type: 'error', error: resolved.error });
      return;
    }

    this.seatResolvedBot(lobby, seat, resolved.value);
  }

  /** Host-only: free the seat. A human joining never does this implicitly. */
  private removeBot(connection: ServerConnection, seatId: SeatId): void {
    const lobby = this.hostLobbyFor(connection);
    if (!lobby) return;
    const seat = this.botSeatIn(connection, lobby, seatId);
    if (!seat) return;

    lobby.seats.delete(seatId);
    this.restatus(lobby);
    this.broadcastLobby(lobby);
  }

  /**
   * Host-only: set this table's bot pacing budgets (M09.11).
   *
   * It goes through `hostLobbyFor` like every other bot message, so the three
   * refusals it shares with them are the same three refusals by name: a guest
   * gets `not_host`, and a lobby that has started gets `lobby_locked` — which is
   * what "locked at match start" means at the wire.
   *
   * The record is read with `readBotPacingBudgets` even though the codec has
   * already parsed it against the same schema, for the reason `add_bot` re-reads
   * an assembled configuration: the authority on what a budget record means is
   * `@tcg/bot-config`, and a shape this server stores without asking it is a
   * second opinion waiting to disagree. Nothing is written until it answers.
   *
   * Changing a budget is a **configuration** change and moves no version
   * constant. `PACING_CONFIG_VERSION` pins the calculation, not the values, and
   * `RULES_VERSION` does not move because a bot waited (ADR 0024 §4).
   */
  private setBotPacing(connection: ServerConnection, budgets: BotPacingBudgets): void {
    const lobby = this.hostLobbyFor(connection);
    if (!lobby) return;

    const read = readBotPacingBudgets(budgets);
    if (isErr(read)) {
      this.refuseBot(
        connection,
        'config_invalid',
        errorsOf(read.error).map((issue) => issue.message),
      );
      return;
    }

    lobby.pacing = read.value;
    this.broadcastLobby(lobby);
  }

  /**
   * Keeps `status` agreeing with `canStart` after a seat appears or changes.
   *
   * The same line `set_ready` runs, for the same reason: a lobby that says
   * `ready` while the host cannot start is lying to its own header.
   */
  private restatus(lobby: Lobby): void {
    if (lobby.status === 'in_match' || lobby.status === 'finished') return;
    lobby.status = canStart(lobby) ? 'ready' : 'waiting';
  }

  private joinLobby(
    connection: ServerConnection,
    versions: Versions,
    inviteCode: string,
    displayName: string,
  ): void {
    if (this.rejectVersions(connection, versions)) return;

    const lobby = this.#lobbies.get(inviteCode);
    if (!lobby) {
      this.fail(connection, 'protocol/unknown_lobby', `No lobby with code ${inviteCode}.`);
      return;
    }
    // Once the match starts an empty seat stays empty: joining a match in
    // progress would mean dealing a deck mid-game (CLAUDE.md §12).
    if (lobby.status === 'in_match' || lobby.status === 'finished') {
      this.fail(connection, 'protocol/already_started', 'That match has already started.');
      return;
    }
    const freeSeat = freeSeats(lobby)[0];
    if (!freeSeat) {
      this.fail(connection, 'protocol/lobby_full', `That lobby is full (${lobby.maxSeats} seats).`);
      return;
    }

    // A configured bot already occupies its seat, so `freeSeats` never offers
    // one: a joining human takes the next genuinely empty seat, and never
    // silently replaces a bot the host set up (ADR 0024 §1). Freeing a bot's
    // seat is the host's explicit `remove_bot`.
    const seat = createHumanSeat(freeSeat, displayName, generateReconnectToken(this.#random));
    lobby.seats.set(freeSeat, seat);
    this.attach(connection, lobby, seat);

    connection.send({
      type: 'lobby_joined',
      versions: CURRENT_VERSIONS,
      seatId: seat.seatId,
      reconnectToken: seat.reconnectToken,
      lobby: this.viewOf(lobby),
    });
    this.broadcastLobby(lobby);
  }

  /**
   * Reclaims a seat with its opaque token. The match is not restarted and no
   * action is replayed: the client simply receives the current view.
   */
  private reconnect(connection: ServerConnection, versions: Versions, token: string): void {
    if (this.rejectVersions(connection, versions)) return;

    for (const lobby of this.#lobbies.values()) {
      const seat = seatByToken(lobby, token);
      if (!seat) continue;

      seat.cancelDisconnectTimer?.();
      seat.cancelDisconnectTimer = null;
      seat.disconnectDeadline = null;

      if (seat.connectionId && seat.connectionId !== connection.id) {
        // A second live connection for one seat: the newest wins, so a stale tab
        // cannot keep acting.
        this.#connections.get(seat.connectionId)?.close();
        this.#attachments.delete(seat.connectionId);
      }

      this.attach(connection, lobby, seat);
      connection.send({
        type: 'lobby_joined',
        versions: CURRENT_VERSIONS,
        seatId: seat.seatId,
        reconnectToken: seat.reconnectToken,
        lobby: this.viewOf(lobby),
      });
      if (lobby.state) {
        seat.lastSentSequence = 0;
        this.sendMatchState(lobby, seat);
      }
      this.broadcastConnection(lobby, seat);
      this.broadcastLobby(lobby);
      return;
    }

    this.fail(connection, 'protocol/unknown_token', 'That session has expired.');
  }

  private submitDeck(connection: ServerConnection, deck: SavedDeck): void {
    const attachment = this.#attachments.get(connection.id);
    if (!attachment) {
      this.fail(connection, 'protocol/not_in_lobby', 'Join a lobby first.');
      return;
    }
    const { lobby, seat } = attachment;
    if (lobby.status === 'in_match') {
      this.fail(connection, 'protocol/already_started', 'The match has already started.');
      return;
    }

    // The server validates against its own card database. A client-side
    // legality check is a convenience, never the authority (CLAUDE.md §11).
    const report = validateDeck(deck, this.#database, this.#deckFormat);
    this.recordSubmission(
      connection,
      lobby,
      seat,
      deck,
      report.legal,
      `"${deck.name}" is not legal in this format.`,
      errorsOf(report.issues).map((issue) => issue.message),
    );
  }

  /**
   * Seats a built-in precon named by its permanent ID.
   *
   * The client sends the ID and nothing else. The definition is resolved here,
   * from this server's own bundled content, and reviewed with the same
   * `reviewPrecon` the deck builder and lobby show the player — so the server
   * validates the definition the UI presented, and a client cannot smuggle an
   * edited list in under a precon's name (M03.2). A precon a player has edited
   * is an ordinary saved deck and arrives through `submit_deck`, where it is
   * judged on its contents.
   *
   * A precon built for another format is *resolved* and then refused by
   * `reviewPrecon`, which says so; only an ID that names nothing at all is an
   * unknown precon.
   */
  private submitPrecon(connection: ServerConnection, preconId: string): void {
    const attachment = this.#attachments.get(connection.id);
    if (!attachment) {
      this.fail(connection, 'protocol/not_in_lobby', 'Join a lobby first.');
      return;
    }
    const { lobby, seat } = attachment;
    if (lobby.status === 'in_match') {
      this.fail(connection, 'protocol/already_started', 'The match has already started.');
      return;
    }

    const precon = bundledPrecon(preconId);
    if (!precon) {
      // Answered as a deck rejection rather than a bare error so it lands in the
      // client's deck panel, next to the picker the ID came from. The seat keeps
      // whatever it had submitted before: a bad ID is not a submission.
      const published = preconsForFormat(this.#deckFormat.formatId).map((entry) => entry.id);
      connection.send({
        type: 'deck_rejected',
        error: protocolError(
          'protocol/unknown_precon',
          `No built-in precon has the ID "${preconId}".`,
          [`Published for ${this.#deckFormat.formatId}: ${published.join(', ') || 'none'}.`],
        ),
      });
      return;
    }

    const review = reviewPrecon(precon, this.#database, this.#deckFormat);
    // Materialised server-side from the resolved definition, never from the
    // wire. `preconToDeck` is the same copy the builder makes.
    const deck = preconToDeck(precon, {
      id: precon.id,
      now: new Date(this.#now()).toISOString(),
    });
    this.recordSubmission(
      connection,
      lobby,
      seat,
      deck,
      review.legal,
      `"${precon.name}" cannot be played in this format.`,
      errorsOf(review.issues).map((issue) => issue.message),
    );
  }

  /** The one place a seat's deck and its legality verdict are written. */
  private recordSubmission(
    connection: ServerConnection,
    lobby: Lobby,
    seat: Seat,
    deck: SavedDeck,
    legal: boolean,
    rejection: string,
    details: readonly string[],
  ): void {
    seat.deck = deck;
    seat.deckLegal = legal;
    if (!legal) {
      seat.ready = false;
      connection.send({
        type: 'deck_rejected',
        error: protocolError('protocol/deck_illegal', rejection, [...details]),
      });
    }
    this.broadcastLobby(lobby);
  }

  private setReady(connection: ServerConnection, ready: boolean): void {
    const attachment = this.#attachments.get(connection.id);
    if (!attachment) {
      this.fail(connection, 'protocol/not_in_lobby', 'Join a lobby first.');
      return;
    }
    const { lobby, seat } = attachment;
    if (lobby.status === 'in_match') {
      this.fail(connection, 'protocol/already_started', 'The match has already started.');
      return;
    }
    if (ready && (!seat.deck || !seat.deckLegal)) {
      this.fail(connection, 'protocol/deck_required', 'Submit a legal deck before readying up.');
      return;
    }

    seat.ready = ready;
    lobby.status = canStart(lobby) ? 'ready' : 'waiting';
    this.broadcastLobby(lobby);

    // A two-seat table still starts by itself, exactly as it did in Phase 2B:
    // there is nobody else the host could be waiting for. Larger tables wait
    // for an explicit `start_match` (open-questions.md Q36).
    if (lobby.maxSeats === MIN_SEATS && canStart(lobby)) this.startMatch(lobby);
  }

  private startMatch(lobby: Lobby): void {
    const seats = seatsOf(lobby).filter((entry) => entry.deck !== null);
    if (seats.length < MIN_SEATS) return;

    const toMatchDeck = (deck: SavedDeck): MatchDeck => ({
      commanderId: deck.commanderId as string,
      cards: deck.cards.map((entry) => ({ cardId: entry.cardId, quantity: entry.quantity })),
    });

    // Held rather than passed inline: every bot seat's generator stream is
    // derived from it, so the same seed and the same seating reproduce the same
    // bot play (ADR 0010, ADR 0024 §4).
    const seed = this.#seedFor(lobby.inviteCode);
    const created = createMatch({
      matchId: `match_${lobby.inviteCode}`,
      seed,
      database: this.#database,
      config: this.#config,
      seats: seats.map((entry) => ({
        playerId: PLAYER_ID_BY_SEAT[entry.seatId],
        name: entry.displayName,
        // `entry.deck` is non-null by the filter above.
        deck: toMatchDeck(entry.deck as SavedDeck),
      })),
    });

    if (isErr(created)) {
      this.broadcast(lobby, {
        type: 'error',
        error: protocolError('protocol/internal', created.error.message),
      });
      return;
    }

    lobby.state = created.value.state;
    lobby.status = 'in_match';
    // What this match runs under, frozen at the instant it starts, so the result
    // can be read off a value rather than inferred from nothing having changed
    // it (M09.11).
    lobby.lockedPacing = lobby.pacing;
    // Taken before the bots are started, so the first wait a bot serves can only
    // ever sit inside the match rather than before it (M09.17).
    lobby.matchStartedAtMs = this.#monotonicNow();
    this.startBots(lobby, seed);
    this.broadcastLobby(lobby);
    this.broadcastMatchState(lobby);
    // The first opportunity of the match, offered after the state has been sent:
    // a bot may be the very first seat to act, at the mulligan.
    this.wakeBots(lobby);
  }

  /* ------------------------------------------------------------ bot runner */

  /**
   * Instantiates one pilot and one generator stream per bot seat, once, at match
   * start (M09.4).
   *
   * The runner is given a `submit` that goes through exactly the same three steps
   * `submit_action` takes for a person — the seat's own idempotent action-identity
   * map, `applyAction`, then a broadcast — because "a bot acts through the same
   * path a human does" is only true if there is one path
   * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §2).
   *
   * It is also given the budgets this match **locked** a moment ago (M09.12),
   * rather than the lobby's live record. `startMatch` freezes them immediately
   * before calling this, and passing the frozen value means a bot cannot be paced
   * by a number the result will not be able to quote.
   */
  private startBots(lobby: Lobby, seed: string): void {
    const bots = botSeatsOf(lobby);
    if (bots.length === 0) return;

    const runner = new BotRunner({
      matchSeed: seed,
      database: this.#database,
      config: this.#config,
      budgets: lobby.lockedPacing ?? lobby.pacing,
      schedule: this.#schedule,
      now: this.#monotonicNow,
      seats: bots.map((seat) => ({
        seatId: seat.seatId,
        playerId: PLAYER_ID_BY_SEAT[seat.seatId],
        config: seat.config,
      })),
      state: () => lobby.state,
      submit: (seatId, actionId, action) => this.applyBotAction(lobby, seatId, actionId, action),
      ...(this.#botDecisionLimit === undefined ? {} : { decisionLimit: this.#botDecisionLimit }),
      ...(this.#yieldToScheduler === undefined ? {} : { yieldToScheduler: this.#yieldToScheduler }),
      ...(this.#botPilotFor === undefined ? {} : { pilotFor: this.#botPilotFor }),
    });
    this.#botRunners.set(lobby.inviteCode, runner);
  }

  /** The bot half of `submitAction`, deliberately the same three steps. */
  private applyBotAction(
    lobby: Lobby,
    seatId: SeatId,
    actionId: string,
    action: Action,
  ): BotSubmitResult {
    const seat = lobby.seats.get(seatId);
    if (!seat || !isBotSeat(seat)) {
      return { ok: false, reason: 'rejected', message: `${seatId} no longer holds a bot.` };
    }
    if (!lobby.state || lobby.state.status === 'complete') {
      return { ok: false, reason: 'rejected', message: 'the match is not running.' };
    }
    // The same replay guard a human action gets, over the same map: an action
    // identity is applied once or not at all.
    if (seat.appliedActions.has(actionId)) {
      return { ok: false, reason: 'duplicate', message: `${actionId} was already applied.` };
    }

    const result = applyAction(lobby.state, action, {
      database: this.#database,
      config: this.#config,
    });
    if (isErr(result)) {
      return {
        ok: false,
        reason: 'rejected',
        message: `${result.error.code} — ${result.error.message}`,
      };
    }

    lobby.state = result.value.state;
    seat.appliedActions.set(actionId, lobby.state.sequence);
    this.broadcastMatchState(lobby);
    return { ok: true };
  }

  /** Offers every bot in this lobby the chance to act. Safe to call at any time. */
  private wakeBots(lobby: Lobby): void {
    this.#botRunners.get(lobby.inviteCode)?.wake();
  }

  private stopBots(lobby: Lobby): void {
    this.#botRunners.get(lobby.inviteCode)?.stop();
  }

  /**
   * Cancels a lobby's bot work and lets the runner go.
   *
   * The runner holds the lobby and its whole `MatchState`, so a closed lobby has
   * to drop it or a long-running process accumulates finished matches. Any pump
   * still in flight is tracked until it settles, so `whenBotsIdle` stays exact
   * across the closure rather than returning while a detached decision is
   * mid-await.
   */
  private discardBots(lobby: Lobby): void {
    const runner = this.#botRunners.get(lobby.inviteCode);
    if (!runner) return;
    runner.stop();
    this.#botRunners.delete(lobby.inviteCode);

    const pending = runner.pending;
    if (!pending) return;
    this.#detachedBotWork.add(pending);
    void pending.finally(() => this.#detachedBotWork.delete(pending));
  }

  /**
   * What the bots in a finished or running match actually did.
   *
   * Test and diagnostic access, in the shape `lobbyByCode` already established.
   * M09.17 is what turns this into a summary a playtest note can quote; M09.4
   * only has to make sure the failures are written down rather than disguised as
   * intentional play.
   */
  botReport(inviteCode: string): BotRunReport | undefined {
    return this.#botRunners.get(inviteCode)?.report();
  }

  /**
   * Resolves once no bot has work in flight.
   *
   * A bot decision is asynchronous — `decideSafely` is — while `receive` is not,
   * so a test that sends a message and looks at the board immediately would be
   * reading it mid-turn. This is the join point, and it exists for tests and for
   * an orderly shutdown; nothing in the protocol path waits on it.
   */
  async whenBotsIdle(): Promise<void> {
    for (let guard = 0; guard < 10_000; guard += 1) {
      const pending = [
        ...[...this.#botRunners.values()]
          .map((runner) => runner.pending)
          .filter((promise): promise is Promise<void> => promise !== null),
        ...this.#detachedBotWork,
      ];
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  /* --------------------------------------------------------------- actions */

  private submitAction(
    connection: ServerConnection,
    actionId: string,
    lastSequence: number,
    action: Action,
  ): void {
    const attachment = this.#attachments.get(connection.id);
    if (!attachment) {
      this.fail(connection, 'protocol/not_in_lobby', 'Join a lobby first.');
      return;
    }
    const { lobby, seat } = attachment;
    if (!lobby.state) {
      connection.send({
        type: 'action_rejected',
        actionId,
        error: protocolError('protocol/not_started', 'The match has not started.'),
      });
      return;
    }

    // Replaying an action ID is answered with the current view, never applied
    // twice — this is what makes reconnect and retry safe (CLAUDE.md §11).
    if (seat.appliedActions.has(actionId)) {
      seat.lastSentSequence = 0;
      this.sendMatchState(lobby, seat);
      return;
    }

    if (action.playerId !== PLAYER_ID_BY_SEAT[seat.seatId]) {
      connection.send({
        type: 'action_rejected',
        actionId,
        error: protocolError('protocol/wrong_seat', 'That action belongs to the other player.'),
      });
      return;
    }

    if (lastSequence !== lobby.state.sequence) {
      // The client decided using a view that is no longer current.
      connection.send({
        type: 'action_rejected',
        actionId,
        error: protocolError(
          'protocol/stale_revision',
          'The match moved on before this action arrived. Try again from the current state.',
          [`client saw ${lastSequence}, server is at ${lobby.state.sequence}`],
        ),
      });
      this.sendMatchState(lobby, seat);
      return;
    }

    // `submit_action` carries an explicit concede through the same generic
    // path every other action takes, so this is the one point that can tell
    // it apart from `leave()`'s (below) before the engine sees only
    // `reason: 'concede'` either way.
    if (action.type === 'concede') {
      lobby.lastConcedeOrigin = 'concede_action';
      lobby.lastPreActionCapture = this.capturePreActionStateContained(
        lobby.state,
        action.playerId,
        {
          softwareVersion: LIVE_MATCH_SOFTWARE_VERSION,
          deck: { commanderId: seat.deck?.commanderId ?? null, cards: seat.deck?.cards ?? [] },
          origin: 'concede_action',
        },
      );
    }

    const result = applyAction(lobby.state, action, {
      database: this.#database,
      config: this.#config,
    });
    if (isErr(result)) {
      connection.send({ type: 'action_rejected', actionId, error: result.error });
      return;
    }

    lobby.state = result.value.state;
    seat.appliedActions.set(actionId, lobby.state.sequence);
    this.broadcastMatchState(lobby);
    // A human move is the commonest way a bot becomes newly eligible. The wake
    // is idempotent, so calling it after every accepted action is what makes
    // "scheduled exactly once" hold without a queue to de-duplicate.
    this.wakeBots(lobby);
  }

  private leave(connection: ServerConnection): void {
    const attachment = this.#attachments.get(connection.id);
    if (!attachment) return;
    const { lobby, seat } = attachment;

    if (lobby.status === 'in_match' && lobby.state && lobby.state.status !== 'complete') {
      // Leaving a live match is a concession, not a disconnect.
      lobby.lastConcedeOrigin = 'concede_leave';
      lobby.lastPreActionCapture = this.capturePreActionStateContained(
        lobby.state,
        PLAYER_ID_BY_SEAT[seat.seatId],
        {
          softwareVersion: LIVE_MATCH_SOFTWARE_VERSION,
          deck: { commanderId: seat.deck?.commanderId ?? null, cards: seat.deck?.cards ?? [] },
          origin: 'concede_leave',
        },
      );
      const result = applyAction(
        lobby.state,
        { type: 'concede', playerId: PLAYER_ID_BY_SEAT[seat.seatId] },
        { database: this.#database, config: this.#config },
      );
      if (!isErr(result)) {
        lobby.state = result.value.state;
        this.broadcastMatchState(lobby);
        this.wakeBots(lobby);
      }
    }
    this.disconnect(connection);
  }

  private timeOutSeat(lobby: Lobby, seat: HumanSeat): void {
    if (!lobby.state || lobby.state.status === 'complete') return;
    const result = applyAction(
      lobby.state,
      { type: 'server_timeout', playerId: PLAYER_ID_BY_SEAT[seat.seatId] },
      { database: this.#database, config: this.#config },
    );
    if (isErr(result)) return;
    lobby.state = result.value.state;
    this.broadcastMatchState(lobby);
    // `server_timeout` stays server-originated (ADR 0024 §2) — this is the
    // server submitting one for a *human* seat, and the bots simply carry on
    // from whatever board it produced.
    this.wakeBots(lobby);
  }

  /* ---------------------------------------------------------------- output */

  private attach(connection: ServerConnection, lobby: Lobby, seat: HumanSeat): void {
    this.#connections.set(connection.id, connection);
    this.#attachments.set(connection.id, { lobby, seat });
    seat.connectionId = connection.id;
  }

  /**
   * The socket a seat's messages go to, if it has one.
   *
   * A bot seat never has one, which is what makes every existing broadcast
   * correct for a bot table without a bot-shaped branch: the loops still visit
   * the seat, and there is simply nowhere to send.
   */
  private connectionFor(seat: Seat): ServerConnection | undefined {
    if (!isHumanSeat(seat) || !seat.connectionId) return undefined;
    return this.#connections.get(seat.connectionId);
  }

  private fail(connection: ServerConnection, code: ProtocolError['code'], message: string): void {
    connection.send({ type: 'error', error: protocolError(code, message) });
  }

  private broadcast(lobby: Lobby, message: ServerMessage): void {
    for (const seat of lobby.seats.values()) this.connectionFor(seat)?.send(message);
  }

  private viewOf(lobby: Lobby) {
    return lobbyView(lobby, this.#now);
  }

  private broadcastLobby(lobby: Lobby): void {
    this.broadcast(lobby, { type: 'lobby_updated', lobby: this.viewOf(lobby) });
    this.sendBotProvenance(lobby);
  }

  /**
   * Tells the host what the server built for them, and tells nobody else.
   *
   * Sent beside every lobby update rather than only after a mutation, so the
   * host's picture cannot drift out of step with the seats it describes — a
   * reconnecting host gets it back, and a host who has just removed a bot gets a
   * list without it. It is a complete replacement, not a delta.
   *
   * It travels down the host's own connection because a generator seed is the
   * one value that turns "the Commander is public" back into "the list is
   * public": with the seed, the Commander and this build, anyone can rebuild the
   * deck card for card. The seat view every player receives therefore has no
   * seed in it to strip
   * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §3).
   */
  private sendBotProvenance(lobby: Lobby): void {
    const hostSeat = lobby.seats.get(lobby.hostSeatId);
    const connection = hostSeat ? this.connectionFor(hostSeat) : undefined;
    if (!connection) return;

    const seats = botSeatsOf(lobby).flatMap((seat) => {
      const generated = generatedProvenanceOf(seat);
      return generated ? [{ seatId: seat.seatId, generated }] : [];
    });
    // Nothing generated means nothing to say. A host whose lobby has never held
    // a generated bot is not sent an empty list on every seat change; a client
    // drops what it remembers about a seat that stops being one, so a removal
    // needs no message of its own.
    if (seats.length === 0) return;
    connection.send({ type: 'bot_seat_provenance', seats });
  }

  /**
   * Publishes every bot's list, once, at the moment the match completes.
   *
   * The second half of "public at the Commander, private at the list": during
   * the match a bot's list is hidden from its opponents, and the promise is only
   * kept if those opponents are the ones who eventually read it. It is therefore
   * broadcast to every seat, not sent to the host — who chose the deck and knew
   * it all along.
   *
   * Every bot seat is revealed, whatever its mode, because the rule ADR 0024 §3
   * states covers a generated list *and* a saved deck the host selected. A
   * precon is revealed too: its list was never private, and leaving it out would
   * make the message's meaning depend on the mode of each seat rather than on
   * the match being over. No hash rides along — the cards are right here, and a
   * second fingerprint beside them would only be something to disagree with.
   */
  private revealBotDecks(lobby: Lobby): void {
    const decks: RevealedBotDeck[] = botSeatsOf(lobby).flatMap((seat) => {
      const deck = seat.deck;
      if (!deck || deck.commanderId === null) return [];
      return [
        {
          seatId: seat.seatId,
          botId: seat.config.controller.botId,
          displayName: seat.displayName,
          commanderId: deck.commanderId,
          cardIds: expandDeckCards(deck.cards),
          generated: generatedProvenanceOf(seat),
        },
      ];
    });
    if (decks.length === 0) return;
    this.broadcast(lobby, { type: 'bot_decks_revealed', decks });
  }

  /**
   * Publishes what the bots at this table cost the match in waiting (M09.17).
   *
   * Broadcast to every seat rather than to the host, because the person who most
   * needs to know how long they spent waiting is the one who was waiting, and at
   * a mixed table that is usually not the host. Sent once, at the same moment
   * the decks are revealed, which is the earliest instant at which nothing in the
   * record is still secret — and the record is built from the public deck
   * projection anyway, so it would have been safe earlier and is not sent
   * earlier only because a summary of a match still being played is not a
   * summary.
   *
   * A table with no bots publishes nothing at all. There is no pacing to report
   * and no provenance to cite, and an empty summary would be a page of zeroes
   * asserting that a human match waited for none of the time.
   */
  private publishPacingSummary(lobby: Lobby): void {
    const report = this.#botRunners.get(lobby.inviteCode)?.report();
    if (!report || report.seats.length === 0) return;

    const summary = buildBotMatchSummary({
      matchId: lobby.state?.matchId ?? `match_${lobby.inviteCode}`,
      // The frozen budgets, so the percentages in the record are percentages of
      // the numbers the match actually ran under rather than of whatever the
      // lobby holds now.
      budgets: lobby.lockedPacing ?? lobby.pacing,
      seats: botSeatsOf(lobby).map((seat) => ({
        seatId: seat.seatId,
        config: seat.config,
        // Resolved from the deck the server built, because `exact_precon` names
        // a precon rather than a Commander and the precon owns that fact.
        commanderId: seat.deck?.commanderId ?? null,
      })),
      report,
      state: lobby.state,
      startedAtMs: lobby.matchStartedAtMs ?? this.#monotonicNow(),
      endedAtMs: this.#monotonicNow(),
    });

    this.broadcast(lobby, { type: 'bot_pacing_summary', summary });
    this.ingestSummary(summary);
  }

  /**
   * Hands the summary to whatever is downstream of this match, once.
   *
   * Guarded, and that is the whole point of the guard: a match that has just
   * ended must not fail to publish its result because something downstream was
   * unavailable. A sink that throws is stepped over and the failure is reported
   * to the table as an ordinary protocol error rather than swallowed, so a
   * misbehaving ingestion path is visible without being fatal.
   */
  private ingestSummary(summary: BotMatchSummary): void {
    const sink = this.#summarySink;
    if (!sink) return;
    try {
      sink.receive(summary);
    } catch (error) {
      this.#summarySinkFailures.push(
        `${sink.sinkId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Ingestion failures, for a test and for a diagnostic — never for a player.
   *
   * In the shape `botReport` already established: the server keeps the fact that
   * a sink refused a summary, and nothing about the match changes because of it.
   */
  get summarySinkFailures(): readonly string[] {
    return [...this.#summarySinkFailures];
  }

  /**
   * Hands a completed match's canonical record to whatever is downstream
   * (M08.22A).
   *
   * The general-purpose sibling of `ingestSummary`: same guard, same shape of
   * failure containment, a different record and a different sink, because
   * `BotSummarySink` stays scoped to bot pacing (M09.17) and never grows a
   * second meaning. Public, and called from nowhere inside this class yet —
   * building the canonical `LiveMatchRecord` from a finished match is
   * M08.22B's job and the lifecycle that calls into it is M08.22C's; this
   * method is the boundary and the failure policy those slices call into,
   * proven here by a unit test rather than a live call site.
   */
  ingestLiveMatch(record: LiveMatchRecord): void {
    const sink = this.#liveMatchSink;
    if (!sink) return;
    try {
      sink.receive(record);
    } catch (error) {
      this.#liveMatchSinkFailures.push(
        `${sink.sinkId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Ingestion failures, for a test and for a diagnostic — never for a player.
   *
   * In the shape `summarySinkFailures` already established: the server keeps
   * the fact that a sink refused a record, and nothing about the match
   * changes because of it.
   */
  get liveMatchSinkFailures(): readonly string[] {
    return [...this.#liveMatchSinkFailures];
  }

  /**
   * `capturePreActionState`, contained the same way `publishLiveMatchRecord`
   * contains its own builder (M08.23E): a telemetry contract refusal (the
   * schema's own cross-field checks) must be no more able to block the
   * concede it is capturing context for than a downstream sink failure is
   * able to block a finished match's broadcast. Failure collapses to `null`
   * — the same "nothing captured" shape a missing Commander already produces
   * — and is recorded into the shared `#liveMatchSinkFailures` list rather
   * than thrown into `submit_action`'s or `leave()`'s caller.
   */
  private capturePreActionStateContained(
    ...args: Parameters<typeof capturePreActionState>
  ): ReturnType<typeof capturePreActionState> {
    try {
      return capturePreActionState(...args);
    } catch (error) {
      this.#liveMatchSinkFailures.push(
        `pre_action_capture: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Builds and ingests a finished match's canonical live-match record
   * (M08.22C).
   *
   * Called once, from `broadcastMatchState`'s finished branch — the same
   * one-shot gate `publishPacingSummary` already relies on, so "exactly once
   * per match, regardless of how it ended" is one guard rather than two. The
   * whole build-and-ingest sequence runs inside its own `try`/`catch`,
   * separate from `ingestLiveMatch`'s own: a bug in the builder (a bad seat
   * shape, a schema refusal) must be no more able to break a just-finished
   * match's broadcast than a sink that throws is, so it is recorded into the
   * same `#liveMatchSinkFailures` list and stepped over rather than left to
   * propagate out of `broadcastMatchState`.
   *
   * `buildLiveMatchRecord` returning `null` — a 3-/4-seat match, or a seat
   * whose deck never resolved a Commander — is not a failure and is not
   * recorded as one: nothing to publish is exactly what `publishPacingSummary`
   * does for a table with no bots.
   */
  private publishLiveMatchRecord(lobby: Lobby): void {
    const { state } = lobby;
    if (!state || state.status !== 'complete' || state.result === null) return;

    try {
      const seats = seatsOf(lobby).flatMap((seat) => {
        if (!seat.deck) return [];
        return [
          {
            playerId: PLAYER_ID_BY_SEAT[seat.seatId],
            kind: isBotSeat(seat) ? ('bot' as const) : ('human' as const),
            deck: { commanderId: seat.deck.commanderId, cards: seat.deck.cards },
          },
        ];
      });

      const terminationOrigin = liveMatchTerminationOriginFor(
        state.result.reason,
        lobby.lastConcedeOrigin,
      );
      const retention = decideLiveMatchRetention(terminationOrigin, this.#liveMatchRetention);

      const record = buildLiveMatchRecord({
        state,
        formatId: this.#deckFormat.formatId,
        softwareVersion: LIVE_MATCH_SOFTWARE_VERSION,
        seats,
        terminationOrigin,
        retention,
        preActionCapture: lobby.lastPreActionCapture,
      });
      if (record) this.ingestLiveMatch(record);
    } catch (error) {
      this.#liveMatchSinkFailures.push(
        `live_match_record_builder: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Tells every *other* seat that one seat's connection changed. */
  private broadcastConnection(lobby: Lobby, changed: HumanSeat): void {
    const graceSeconds = graceSecondsFor(changed, this.#now);
    for (const seat of lobby.seats.values()) {
      if (seat.seatId === changed.seatId) continue;
      this.connectionFor(seat)?.send({
        type: 'seat_connection',
        seatId: changed.seatId,
        connected: changed.connectionId !== null,
        graceSeconds: changed.connectionId === null ? graceSeconds : null,
      });
    }
  }

  private broadcastMatchState(lobby: Lobby): void {
    // A finished match is also a lobby-state change: clients watching the lobby
    // header need to see it, not just the board.
    const finished = lobby.state?.status === 'complete' && lobby.status !== 'finished';
    if (finished) {
      lobby.status = 'finished';
      // Cancelled here rather than left to notice on its own, so no bot work
      // outlives the match that justified it (ADR 0024 §4).
      this.stopBots(lobby);
    }

    for (const seat of lobby.seats.values()) this.sendMatchState(lobby, seat);
    if (finished) {
      this.broadcastLobby(lobby);
      // After the board and the lobby, so a client that renders the reveal
      // beside the result already has both when it arrives.
      this.revealBotDecks(lobby);
      // And after the reveal, for the same reason one step further along: the
      // summary is what a playtest note quotes, and a note is written with the
      // result and the decks already on the screen (M09.17).
      this.publishPacingSummary(lobby);
      // Last of the four, and independent of it: Player Meta's record is not
      // a playtest note, so it does not need to wait on one — it is ordered
      // here only because "after the match is fully broadcast" is the
      // simplest invariant to keep (M08.22C).
      this.publishLiveMatchRecord(lobby);
    }
  }

  /** Sends one seat its redacted view plus the events it has not seen yet. */
  private sendMatchState(lobby: Lobby, seat: Seat): void {
    const connection = this.connectionFor(seat);
    if (!connection || !lobby.state) return;

    const playerId = PLAYER_ID_BY_SEAT[seat.seatId];
    const view = playerView(lobby.state, playerId, this.#database, this.#config);
    const events = eventsSince(lobby.state, playerId, seat.lastSentSequence);
    seat.lastSentSequence = lobby.state.sequence;
    connection.send({ type: 'match_state', view, events });
  }

  /**
   * Drops a lobby once nobody is connected and nothing is in progress.
   *
   * "Nobody" means no *person*: a bot seat is not company, and a lobby holding
   * only bots is an abandoned one. It is the back half of M09.7's "at least one
   * human at every table" — `MAX_BOT_SEATS` and the host seat keep a table from
   * ever being seated without a person, and this keeps one from outliving them.
   */
  private closeIfAbandoned(lobby: Lobby): void {
    const anyConnected = [...lobby.seats.values()].some(
      (seat) => isHumanSeat(seat) && seat.connectionId !== null,
    );
    if (anyConnected) return;
    if (lobby.status === 'in_match') return;
    lobby.status = 'closed';
    this.discardBots(lobby);
    this.#lobbies.delete(lobby.inviteCode);
  }
}
