import {
  botDelayMs,
  botStyleDefinition,
  DEFAULT_BOT_PACING_BUDGETS,
  difficultyDefinition,
  difficultySelection,
  type BotDecisionCategory,
  type BotDifficulty,
  type BotPacing,
  type BotPacingBudgets,
  type BotSeatConfig,
} from '@tcg/bot-config';
import type { CardDatabase } from '@tcg/card-data';
import {
  classifyDecisionCategory,
  createStyledPilot,
  decideSafely,
  pilotIdSchema,
  type BotFailureKind,
  type BotObservation,
  type BotPolicy,
} from '@tcg/bot-interface';
import type { SeatId } from '@tcg/protocol';
import {
  createRngState,
  legalActions,
  playerView,
  type Action,
  type LegalActions,
  type MatchState,
  type PlayerId,
  type RngState,
  type RulesConfig,
} from '@tcg/rules-engine';
import {
  defaultMonotonicClock,
  defaultSchedule,
  type MonotonicClock,
  type ScheduleTimer,
} from './scheduling.js';

/**
 * The live bot runner (M09.4) — what makes a configured bot seat actually play.
 *
 * Everything here is written against one sentence from
 * [ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §4: **a scheduled
 * decision is an opportunity, not a stored action.** Nothing in this file holds a
 * chosen action across a state change. Each turn of the pump reads the current
 * authoritative state, rebuilds that seat's redacted observation and the engine's
 * legal actions *then*, asks the pilot, checks that the board has not moved
 * underneath the answer, and submits it through the same `applyAction` path and
 * the same idempotent action-identity map a human's action uses.
 *
 * Four properties are structural rather than remembered.
 *
 * **A bot is only ever asked when the engine is offering it something.**
 * `hasBotDecision` reads the engine's own `LegalActions` and ignores `canConcede`,
 * which is offered to every living seat at all times. That is what contains the
 * case M09.0 found: `decideSafely` substitutes `createRandomLegalPilot()`, and
 * that pilot throws when it is asked to decide with nothing but a concession
 * available. A live bot in that state is simply not eligible, so nothing is
 * asked, nothing throws, and — the part that matters —
 * **nothing concedes**. If the whole match reaches that state it is recorded as a
 * stall, honestly, rather than ended by a bot giving up.
 *
 * **Two actions can never be submitted.** `ACTIONS_A_LIVE_BOT_NEVER_SUBMITS` is
 * checked after the pilot answers and before anything is applied, so ADR 0024 §2
 * survives a future pilot that starts offering itself a concession.
 *
 * **The pump iterates; it never recurses.** A whole match is a `while` loop with
 * an `await` in it, so a two-hundred-turn game costs one stack frame rather than
 * two hundred.
 *
 * **A pilot's generator stream advances only with a decision it actually made.**
 * A decision discarded because a human acted first leaves the stream where it
 * was, so the sequence of draws a bot makes is a function of the decisions it
 * committed and not of when someone else's message arrived.
 *
 * **A wait is an opportunity too** (M09.12). A bot with a non-zero pacing
 * percentage is not asked immediately: the opportunity is classified from the
 * engine's own `LegalActions`, a timer is scheduled from the applicable budget,
 * and when it expires the loop comes back around and rebuilds *everything* — the
 * state, the legality, the observation — before the pilot is asked anything at
 * all. `PendingDelay` has no member an action could be put in, which is the same
 * sentence as the paragraph above, enforced by a shape rather than by care.
 *
 * The yield below is a stack-safety boundary, not a pacing dial: a bot at 0%
 * still crosses it and still acts inside the wake that offered the opportunity,
 * which is why every match written before M09.12 runs exactly as it did.
 */

/* ------------------------------------------------------------- vocabulary */

/**
 * The two action types a live bot must never produce
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §2), named so
 * the claim is a check rather than a sentence.
 *
 * `checkActionOffered` already refuses `server_timeout` for a pilot, and every
 * shipped pilot defaults to `mayConcede: false` — this is the third line, on the
 * live path, where the consequence of getting it wrong is a player winning a
 * match the software handed them.
 */
export const ACTIONS_A_LIVE_BOT_NEVER_SUBMITS = ['concede', 'server_timeout'] as const;

/**
 * The members a scheduled wait must never grow, named so ADR 0024 §4's
 * "an opportunity, not a stored action" is a test rather than a sentence — the
 * treatment `FIELDS_A_BOT_CONTROLLER_NEVER_HAS` already gets.
 *
 * Every one of them would be a place to put a decision made *before* the wait,
 * and a decision made before the wait is a decision made against a board that no
 * longer exists by the time it is submitted.
 */
export const FIELDS_A_SCHEDULED_DELAY_NEVER_HAS = [
  'action',
  'decision',
  'chosen',
  'observation',
  'legal',
] as const;

/**
 * Everything the runner records instead of hiding.
 *
 * A fallback is not an intentional play and a refused action is not a move, so
 * neither is allowed to look like one in the match record (CLAUDE.md §13.5).
 */
export const BOT_RUN_INCIDENTS = [
  /** `decideSafely` substituted its deterministic random-legal decision. */
  'pilot_fallback',
  /** `decideSafely` could not produce even that. The seat halts; nothing concedes. */
  'fallback_unavailable',
  /** The answer was a concession or a `server_timeout`, and was refused. */
  'forbidden_action',
  /** The board moved while the pilot was thinking, so the answer was thrown away. */
  'stale_decision',
  /** `applyAction` refused the revalidated answer. */
  'engine_rejected',
  /** An action identity that had already been applied for this seat. */
  'duplicate_action',
  /** The seat reached its hard per-match decision ceiling. */
  'decision_limit',
  /** No pilot could be built for this seat's configuration. */
  'pilot_unavailable',
] as const;
export type BotRunIncidentKind = (typeof BOT_RUN_INCIDENTS)[number];

export interface BotRunIncident {
  readonly kind: BotRunIncidentKind;
  readonly seatId: SeatId;
  readonly botId: string;
  readonly playerId: PlayerId;
  /** How many decisions this seat had already committed when it happened. */
  readonly decisionIndex: number;
  readonly message: string;
  /** The pilot-level failure behind a `pilot_fallback`, and `null` otherwise. */
  readonly pilotFailure: BotFailureKind | null;
}

/** What one bot seat did, for M09.17's summary and for tests today. */
export interface BotSeatActivity {
  readonly seatId: SeatId;
  readonly botId: string;
  readonly playerId: PlayerId;
  readonly pilotId: string;
  readonly pilotVersion: string;
  /**
   * Which difficulty this seat flew, and which version of it (M09.13).
   *
   * Two fields rather than one because they answer different questions and move
   * at different times: `difficulty` is the label a person picked and a lobby
   * printed, `difficultyBehaviorVersion` is the version of the decision
   * procedure behind that label. Easy improving bumps the second and not the
   * first, and a record that carried only the label could not tell two Easies
   * apart. Both are here beside `pilotId`/`pilotVersion` because the pair of
   * pairs is what actually determined every decision below.
   */
  readonly difficulty: BotDifficulty;
  readonly difficultyBehaviorVersion: string | null;
  /** This seat's own generator stream, derived from the match seed. */
  readonly seed: string;
  readonly decisions: number;
  /**
   * Committed decisions by action type — the cheapest honest answer to "did this
   * bot actually answer a pending choice or a Reaction window, or did the match
   * simply never present one?". A count rather than a log, because M09.17 owns
   * the summary and M09.4 only owes the evidence that every decision surface was
   * reached.
   */
  readonly actions: Readonly<Record<string, number>>;
  /**
   * Every wait this seat actually served (M09.12), in the order it served them.
   *
   * Only real waits: a seat at 0% waits for nothing and records nothing, which
   * is the honest record of a bot that never waited rather than a page of
   * zeroes. Both numbers are here because they answer different questions —
   * intended is what the configuration asked for, actual is what the clock saw —
   * and a summary that printed only one of them could not say whether a slow
   * table was slow because it was configured to be.
   */
  readonly delays: readonly BotDelayRecord[];
  /** Waits abandoned because the opportunity went away before they expired. */
  readonly delaysCancelled: number;
  /** Waits restarted because the opportunity changed which budget it draws on. */
  readonly delaysRescheduled: number;
  /** Why the last abandoned wait was abandoned, for diagnosis rather than for play. */
  readonly lastDelayCancellation: string | null;
  /** Why this seat stopped being asked, or `null` while it is still playing. */
  readonly halted: string | null;
}

/** One wait, as it was configured and as it actually happened. */
export interface BotDelayRecord {
  /** Decisions this seat had already committed when the wait was served. */
  readonly decisionIndex: number;
  readonly category: BotDecisionCategory;
  /** `botDelayMs` of the applicable budget and percentage. */
  readonly intendedMs: number;
  /**
   * What the monotonic clock made of it — timer resolution, event-loop latency
   * and all. Recorded and never fed back: no pilot's generator stream and no
   * engine state has ever seen a clock reading
   * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §4).
   */
  readonly actualMs: number;
}

/** A wait that has been scheduled and has not expired yet. */
export interface BotWaitingDelay {
  readonly seatId: SeatId;
  readonly category: BotDecisionCategory;
  readonly intendedMs: number;
}

export interface BotRunReport {
  readonly seats: readonly BotSeatActivity[];
  readonly incidents: readonly BotRunIncident[];
  /**
   * Set when the match could not continue: it is not complete and no seat, human
   * or bot, has a legal action. Recorded rather than resolved — the one thing it
   * must never become is a bot conceding to unstick the board.
   */
  readonly stalled: string | null;
  /**
   * Waits outstanding right now, one per seat at most.
   *
   * More than one means more than one bot is waiting at the same time, which is
   * what "independent bot delays run concurrently" means in practice: the
   * timers overlap rather than queue, so three bots answering one Reaction
   * window take as long as the slowest of them and not as long as all three.
   */
  readonly waiting: readonly BotWaitingDelay[];
  /**
   * Set if the pump itself threw somewhere nothing else caught it.
   *
   * Every decision path below is already guarded, so this should stay `null` —
   * but a rejected promise nobody awaits ends a Node process by default, and
   * "the server died because a bot did something unexpected" is not an outcome a
   * live match may have. It is recorded, and the runner stops.
   */
  readonly crashed: string | null;
}

/* ------------------------------------------------------------ construction */

/**
 * One bot seat's generator stream.
 *
 * Derived from the match seed and the seat, so the same match seed and the same
 * seating reproduce the same bot play exactly, and two bots at one table never
 * share a stream. `createRngState` hashes the string and discards a warm-up run,
 * which is what keeps `…:bot:seat_2` and `…:bot:seat_3` from starting adjacent —
 * so no separate hash step is needed here, and
 * `SEED_DERIVATION_VERSION` does not move because no existing derivation
 * changed.
 */
export function botSeedFor(matchSeed: string, seatId: SeatId): string {
  return `${matchSeed}:bot:${seatId}`;
}

/**
 * The pilot a bot seat flies.
 *
 * Style chooses the weight vector; difficulty chooses which of the scored
 * candidates that vector produces the bot actually takes. Since M09.13 both come
 * out of their own registry — `botStyleDefinition(...).pilotId` and
 * `difficultySelection(...)` — rather than out of a switch here, so a difficulty
 * cannot be added to the registry and forgotten in the runner, and a difficulty
 * with nothing behind it is refused by `difficultySelection` in one place with
 * one wording rather than in every caller that builds a pilot.
 *
 * The two axes stay independent by construction: nothing below lets a difficulty
 * reach the weights or a style reach the selection.
 */
export function createBotPilot(config: BotSeatConfig): BotPolicy {
  const pilotId = pilotIdSchema.parse(botStyleDefinition(config.style).pilotId);
  return createStyledPilot({ pilotId, selection: difficultySelection(config.difficulty) });
}

/**
 * Whether the engine is currently offering this seat a decision.
 *
 * `canConcede` is deliberately not in the list. The engine offers it to every
 * living seat in every state, so treating it as a decision would make a bot
 * permanently eligible and would make "nothing else is available" indistinguishable
 * from "it is this seat's turn" — which is precisely the confusion that ends with
 * a live bot conceding to a board it merely had nothing to do on.
 */
export function hasBotDecision(legal: LegalActions): boolean {
  if (legal.eliminated) return false;
  return (
    legal.pendingChoice !== null ||
    legal.mulligan !== null ||
    legal.reaction !== null ||
    legal.blocking !== null ||
    legal.attacking !== null ||
    legal.canPassPhase ||
    legal.playableCards.length > 0 ||
    legal.activatableAbilities.length > 0
  );
}

/* ----------------------------------------------------------------- runner */

/** One bot seat, as the runner needs to know it. */
export interface BotRunnerSeat {
  readonly seatId: SeatId;
  readonly playerId: PlayerId;
  readonly config: BotSeatConfig;
}

export type BotSubmitResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'duplicate' | 'rejected';
      readonly message: string;
    };

export interface BotRunnerOptions {
  readonly seats: readonly BotRunnerSeat[];
  /** The match seed every bot stream is derived from. */
  readonly matchSeed: string;
  readonly database: CardDatabase;
  readonly config: RulesConfig;
  /** Read fresh every iteration: the runner never caches authoritative state. */
  readonly state: () => MatchState | null;
  /** Submits one action through the ordinary engine path. */
  readonly submit: (seatId: SeatId, actionId: string, action: Action) => BotSubmitResult;
  /**
   * Builds one seat's pilot. Injectable for the same reason the clock and the
   * scheduler are: the failure and fallback paths below cannot be reached from
   * outside otherwise, and a defect that only shows up when a pilot misbehaves
   * is exactly the one worth a test. Production uses `createBotPilot`.
   */
  readonly pilotFor?: (seat: BotRunnerSeat) => BotPolicy;
  readonly decisionLimit?: number;
  /** The stack-safety boundary between decisions. Injectable so a test can count it. */
  readonly yieldToScheduler?: () => Promise<void>;
  /**
   * The budgets this match locked at its start (M09.11).
   *
   * Passed in rather than read from a lobby because the runner has no lobby: it
   * is given the frozen record, so a budget cannot change under a match that is
   * already being paced by it. Defaulted, so every caller written before M09.12
   * keeps compiling and keeps its 0% bots instant.
   */
  readonly budgets?: BotPacingBudgets;
  /** Where a wait actually happens. Injectable so a delay is asserted, not waited out. */
  readonly schedule?: ScheduleTimer;
  /** Only ever asked how long a wait took. Never reaches a pilot or the engine. */
  readonly now?: MonotonicClock;
}

/**
 * A hard per-seat ceiling on decisions in one match.
 *
 * Generous — a long precon game is a few hundred decisions — because its job is
 * to stop a pathological loop pinning a server process, not to cut a real match
 * short. It is per seat rather than per match so one bot spinning cannot silence
 * another.
 */
export const DEFAULT_BOT_DECISION_LIMIT = 4000;

/**
 * A wait in flight.
 *
 * Note what is *not* here: no action, no decision, no observation and no
 * legality — see `FIELDS_A_SCHEDULED_DELAY_NEVER_HAS`. All this record knows is
 * which budget it drew on, how long it asked for, when it started, and how to
 * call the whole thing off. Everything needed to decide is rebuilt at expiry.
 */
interface PendingDelay {
  readonly category: BotDecisionCategory;
  readonly intendedMs: number;
  /** A monotonic reading, used for `actualMs` and for nothing else. */
  readonly startedAt: number;
  readonly cancel: () => void;
  /** Set by the timer. Null while the wait is still running. */
  expired: boolean;
}

/** What the pump gets back when a seat may act this instant. */
interface ActionableBotSeat {
  readonly runtime: BotSeatRuntime;
  readonly pilot: BotPolicy;
  readonly legal: LegalActions;
  readonly delay: ServedDelay;
}

/** A wait that is over — or never was, for a seat configured at 0%. */
interface ServedDelay {
  readonly category: BotDecisionCategory;
  readonly intendedMs: number;
  readonly actualMs: number;
}

interface BotSeatRuntime {
  readonly seatId: SeatId;
  readonly botId: string;
  readonly playerId: PlayerId;
  readonly pilot: BotPolicy | null;
  /** The difficulty this seat was configured with, frozen at match start. */
  readonly difficulty: BotDifficulty;
  /** This seat's own timing dial, frozen with the rest of its configuration. */
  readonly pacing: BotPacing;
  readonly seed: string;
  rng: RngState;
  decisions: number;
  readonly committed: Map<string, number>;
  delay: PendingDelay | null;
  readonly delays: BotDelayRecord[];
  delaysCancelled: number;
  delaysRescheduled: number;
  lastDelayCancellation: string | null;
  halted: string | null;
}

export class BotRunner {
  readonly #database: CardDatabase;
  readonly #config: RulesConfig;
  readonly #state: () => MatchState | null;
  readonly #submit: BotRunnerOptions['submit'];
  readonly #decisionLimit: number;
  readonly #yield: () => Promise<void>;
  readonly #budgets: BotPacingBudgets;
  readonly #schedule: ScheduleTimer;
  readonly #now: MonotonicClock;

  readonly #runtimes: BotSeatRuntime[] = [];
  readonly #incidents: BotRunIncident[] = [];
  #stalled: string | null = null;
  #crashed: string | null = null;

  #running = false;
  #pending: Promise<void> | null = null;
  #stopped = false;
  /**
   * Set by `wake()` while a pump is already in flight.
   *
   * A timer can expire in the gap between the pump deciding it has nothing to do
   * and the pump actually returning. Without this the wake that expiry sent
   * would be swallowed as "already running" and the seat would wait forever, so
   * the loop re-scans instead of returning whenever it was woken mid-scan.
   */
  #woken = false;

  constructor(options: BotRunnerOptions) {
    this.#database = options.database;
    this.#config = options.config;
    this.#state = options.state;
    this.#submit = options.submit;
    this.#decisionLimit = options.decisionLimit ?? DEFAULT_BOT_DECISION_LIMIT;
    this.#yield = options.yieldToScheduler ?? (() => Promise.resolve());
    this.#budgets = options.budgets ?? DEFAULT_BOT_PACING_BUDGETS;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#now = options.now ?? defaultMonotonicClock;

    const pilotFor = options.pilotFor ?? ((seat: BotRunnerSeat) => createBotPilot(seat.config));
    for (const seat of options.seats) {
      const botId = seat.config.controller.botId;
      const runtime: BotSeatRuntime = {
        seatId: seat.seatId,
        botId,
        playerId: seat.playerId,
        pilot: null,
        difficulty: seat.config.difficulty,
        seed: botSeedFor(options.matchSeed, seat.seatId),
        rng: createRngState(botSeedFor(options.matchSeed, seat.seatId)),
        pacing: seat.config.pacing,
        decisions: 0,
        committed: new Map(),
        delay: null,
        delays: [],
        delaysCancelled: 0,
        delaysRescheduled: 0,
        lastDelayCancellation: null,
        halted: null,
      };
      try {
        // One pilot instance per bot seat, built once at match start: two seats
        // flying the same style are two objects with two streams, never one
        // shared chooser.
        this.#runtimes.push({ ...runtime, pilot: pilotFor(seat) });
      } catch (error) {
        // Unreachable while the lobby refuses every unavailable difficulty, and
        // caught anyway: a throw here would escape `start_match` and take a
        // human's match with it, for a seat that could simply sit out.
        this.#runtimes.push({ ...runtime, halted: 'pilot_unavailable' });
        this.#record(runtime, 'pilot_unavailable', messageOf(error), null);
      }
    }
  }

  /** The in-flight pump, if any. Tests await it; nothing else needs it. */
  get pending(): Promise<void> | null {
    return this.#pending;
  }

  /**
   * Offers every bot seat the chance to act, once.
   *
   * Idempotent by design: this is called after *every* accepted action and every
   * state transition, and a pump already in flight is not started a second time.
   * That, plus the fact that the pump re-reads the state at the top of each
   * iteration, is what makes "every newly eligible decision is scheduled exactly
   * once" true without a queue of opportunities to keep de-duplicated.
   */
  wake(): void {
    if (this.#stopped) return;
    // Recorded before the early return, so an expiry that lands while the pump
    // is mid-await is re-scanned rather than swallowed.
    this.#woken = true;
    if (this.#running) return;
    this.#running = true;
    this.#pending = this.#pump()
      .catch((error: unknown) => {
        // Nothing awaits this promise in production, and an unhandled rejection
        // ends a Node process by default. A bot misbehaving must cost the match
        // its bot, never the server its humans.
        this.#crashed = messageOf(error);
        this.#stopped = true;
      })
      .finally(() => {
        this.#running = false;
        this.#pending = null;
      });
  }

  /**
   * Cancels all further work. Called at match completion and lobby closure.
   *
   * Outstanding waits are cancelled here rather than left to expire into a
   * finished match: a timer that fires after the result has been broadcast is a
   * bot deciding about a board nobody is playing, and on a long-running process
   * it is also a live handle holding a whole `MatchState`.
   */
  stop(): void {
    this.#stopped = true;
    this.#cancelAllDelays('the runner stopped');
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  report(): BotRunReport {
    return {
      seats: this.#runtimes.map((runtime) => ({
        seatId: runtime.seatId,
        botId: runtime.botId,
        playerId: runtime.playerId,
        pilotId: runtime.pilot?.id ?? 'none',
        pilotVersion: runtime.pilot?.version ?? '',
        difficulty: runtime.difficulty,
        // Read from the registry rather than from the pilot, because the pilot
        // carries the *style's* version. A difficulty with no procedure behind
        // it never reaches here — no pilot is built for one — so a `null` in a
        // record is a seat that halted before it ever played.
        difficultyBehaviorVersion: difficultyDefinition(runtime.difficulty).behaviorVersion,
        seed: runtime.seed,
        decisions: runtime.decisions,
        actions: Object.fromEntries([...runtime.committed].sort(([a], [b]) => a.localeCompare(b))),
        delays: [...runtime.delays],
        delaysCancelled: runtime.delaysCancelled,
        delaysRescheduled: runtime.delaysRescheduled,
        lastDelayCancellation: runtime.lastDelayCancellation,
        halted: runtime.halted,
      })),
      incidents: [...this.#incidents],
      stalled: this.#stalled,
      waiting: this.#runtimes.flatMap((runtime) =>
        runtime.delay && !runtime.delay.expired
          ? [
              {
                seatId: runtime.seatId,
                category: runtime.delay.category,
                intendedMs: runtime.delay.intendedMs,
              },
            ]
          : [],
      ),
      crashed: this.#crashed,
    };
  }

  /* ------------------------------------------------------------- the pump */

  async #pump(): Promise<void> {
    while (!this.#stopped) {
      this.#woken = false;
      const state = this.#state();
      if (!state || state.status === 'complete') {
        // Match end and lobby closure are both cancellation triggers: nothing
        // may still be counting down towards a board that has stopped moving.
        this.#cancelAllDelays(state ? 'the match is over' : 'the match is gone');
        return;
      }

      const next = this.#nextActionable(state);
      if (!next) {
        // Something expired while this scan was running; look again rather than
        // returning and leaving the seat that woke us waiting on nothing.
        if (this.#woken) continue;
        // A table with a wait outstanding is not stuck, it is paced. Reporting a
        // stall here would turn every configured delay into a defect report.
        if (this.#runtimes.every((runtime) => runtime.delay === null)) {
          this.#noteStallIfStuck(state);
        }
        return;
      }
      const { runtime, pilot, legal, delay } = next;

      if (runtime.decisions >= this.#decisionLimit) {
        runtime.halted = 'decision_limit';
        this.#record(
          runtime,
          'decision_limit',
          `this seat reached its ${this.#decisionLimit}-decision ceiling for one match`,
          null,
        );
        continue;
      }

      // Rebuilt here, at decision time, from the state read at the top of this
      // iteration — never carried over from the iteration that scheduled it, and
      // in particular never carried across a wait that has just expired.
      const observation: BotObservation = this.#observationFor(state, runtime, legal);
      const sequenceBefore = state.sequence;
      if (delay.intendedMs > 0 || delay.actualMs > 0) {
        runtime.delays.push({ decisionIndex: runtime.decisions, ...delay });
      }

      let outcome;
      try {
        outcome = await decideSafely(pilot, observation, runtime.rng, {
          config: this.#config,
          decisionBudget: this.#decisionLimit,
        });
      } catch (error) {
        // The M09.0 finding, contained: the substituted random-legal pilot can
        // itself throw. The seat stops being asked and the incident is recorded.
        // It is emphatically **not** answered by conceding on the bot's behalf.
        runtime.halted = 'fallback_unavailable';
        this.#record(runtime, 'fallback_unavailable', messageOf(error), null);
        continue;
      }

      if (outcome.failure) {
        this.#record(
          runtime,
          'pilot_fallback',
          `${outcome.failure.kind}: ${outcome.failure.message}`,
          outcome.failure.kind,
        );
      }

      // The match may have finished, or the lobby closed, inside that await. A
      // cancelled runner submits nothing at all, not one last action.
      if (this.#stopped) return;

      const action = outcome.decision.action;

      // Revalidation, in the only order that is safe: the board must not have
      // moved while the pilot was thinking. It has not been chosen in advance and
      // held — it was chosen a microtask ago — but a human message can land
      // inside that microtask, and an answer to the previous board is not an
      // answer to this one.
      const current = this.#state();
      if (!current || current.sequence !== sequenceBefore) {
        this.#record(
          runtime,
          'stale_decision',
          `the board moved from sequence ${sequenceBefore} to ` +
            `${current ? current.sequence : 'no match'} while the pilot was deciding; ` +
            `the ${action.type} was discarded and the seat will be asked again`,
          null,
        );
        // The stream is deliberately not advanced: a decision that was never
        // submitted must not change what the next one draws, or a bot's play
        // would depend on when an opponent's message arrived.
        await this.#yield();
        continue;
      }

      if (isForbiddenBotAction(action)) {
        runtime.rng = outcome.decision.rng;
        runtime.decisions += 1;
        runtime.halted = 'forbidden_action';
        this.#record(
          runtime,
          'forbidden_action',
          `a live bot never submits "${action.type}" (ADR 0024 §2)`,
          null,
        );
        continue;
      }

      const actionId = `${runtime.botId}#${runtime.decisions}`;
      const submitted = this.#submit(runtime.seatId, actionId, action);
      runtime.rng = outcome.decision.rng;
      runtime.decisions += 1;

      if (!submitted.ok) {
        runtime.halted = submitted.reason === 'duplicate' ? 'duplicate_action' : 'engine_rejected';
        this.#record(
          runtime,
          submitted.reason === 'duplicate' ? 'duplicate_action' : 'engine_rejected',
          `${action.type} (${actionId}): ${submitted.message}`,
          null,
        );
        continue;
      }

      runtime.committed.set(action.type, (runtime.committed.get(action.type) ?? 0) + 1);

      // Iteration, not recursion: the loop comes back around to the next
      // opportunity, so a whole match costs one stack frame.
      await this.#yield();
    }
  }

  #observationFor(state: MatchState, runtime: BotSeatRuntime, legal: LegalActions): BotObservation {
    // Exactly what a human in this seat would receive, and nothing else: the
    // redacted `PlayerView` and the engine's legality (ADR 0009, ADR 0024 §2).
    const view = playerView(state, runtime.playerId, this.#database, this.#config);
    return {
      view,
      legal,
      history: view.log,
      database: this.#database,
      rulesConfig: this.#config,
      decisionIndex: runtime.decisions,
    };
  }

  /**
   * The first bot seat, in seat order, that may act *right now* — and, on the way
   * past, the reconciliation of every other seat's wait.
   *
   * One scan does both jobs deliberately. Deciding whether a seat may act and
   * deciding whether its outstanding wait is still about anything are the same
   * question asked of the same freshly computed `LegalActions`, and splitting
   * them into two passes would be two chances to disagree about one board.
   *
   * A seat that is waiting is skipped rather than returned, so the scan carries
   * on to the next one: that is what makes independent waits *concurrent*. Three
   * bots offered the same Reaction window get three timers running at once, and
   * the window costs the slowest of them rather than the sum.
   */
  #nextActionable(state: MatchState): ActionableBotSeat | null {
    let actionable: ActionableBotSeat | null = null;
    for (const runtime of this.#runtimes) {
      const pilot = runtime.pilot;
      if (runtime.halted !== null || pilot === null) {
        this.#cancelDelay(runtime, 'the seat stopped being asked');
        continue;
      }
      if (state.players[runtime.playerId]?.lost !== false) {
        // Elimination, which is one of the named cancellation triggers: a seat
        // that is out of the match is not owed the rest of its countdown.
        this.#cancelDelay(runtime, 'the seat is out of the match');
        continue;
      }
      const legal = legalActions(state, runtime.playerId, {
        database: this.#database,
        config: this.#config,
      });
      if (!hasBotDecision(legal)) {
        // Eligibility change: somebody else's action closed the window this wait
        // was about, so the wait is obsolete rather than merely early.
        this.#cancelDelay(runtime, 'the engine stopped offering this seat a decision');
        continue;
      }

      const category = classifyDecisionCategory(legal);
      const waiting = runtime.delay;
      if (waiting === null) {
        const intendedMs = this.#delayFor(runtime, category);
        if (intendedMs <= 0) {
          // Unchanged from M09.4: a 0% bot acts inside the wake that offered it
          // the opportunity, and nothing is scheduled at all.
          actionable ??= { runtime, pilot, legal, delay: { category, intendedMs: 0, actualMs: 0 } };
          continue;
        }
        this.#startDelay(runtime, category, intendedMs);
        continue;
      }

      if (waiting.expired) {
        actionable ??= { runtime, pilot, legal, delay: this.#takeDelay(runtime, waiting) };
        continue;
      }

      if (waiting.category !== category) {
        // The opportunity changed which budget it draws on — an ordinary turn
        // became a Reaction window, say — so the countdown it was serving is for
        // the wrong number. Cancelled and restarted rather than left to expire
        // into a delay nothing on the screen predicted.
        // Dropped rather than *cancelled*: the opportunity did not go away, it
        // changed budget, so it is counted under `delaysRescheduled` alone and a
        // reader can still tell a restart from an abandonment.
        this.#dropDelay(runtime);
        runtime.delaysRescheduled += 1;
        const intendedMs = this.#delayFor(runtime, category);
        if (intendedMs <= 0) {
          actionable ??= { runtime, pilot, legal, delay: { category, intendedMs: 0, actualMs: 0 } };
          continue;
        }
        this.#startDelay(runtime, category, intendedMs);
      }
      // Otherwise it is still waiting, and a still-valid wait is deliberately
      // *not* restarted by somebody else's action. The decision is made at
      // expiry against whatever board exists then, so a changed sequence is a
      // reason to re-check eligibility — which this scan just did — and not a
      // reason to make the bot start counting again. Restarting would starve a
      // slow bot at a busy table of ever acting at all.
    }
    return actionable;
  }

  /** What this seat's configuration and the match's locked budgets ask for. */
  #delayFor(runtime: BotSeatRuntime, category: BotDecisionCategory): number {
    return botDelayMs(runtime.pacing, this.#budgets, category);
  }

  #startDelay(runtime: BotSeatRuntime, category: BotDecisionCategory, intendedMs: number): void {
    const delay: PendingDelay = {
      category,
      intendedMs,
      startedAt: this.#now(),
      expired: false,
      cancel: this.#schedule(intendedMs, () => {
        delay.expired = true;
        // Nothing is decided in here: the timer's whole job is to put the seat
        // back in front of the pump, which then rebuilds the board from scratch.
        this.wake();
      }),
    };
    runtime.delay = delay;
  }

  /** Consumes an expired wait and measures it. */
  #takeDelay(runtime: BotSeatRuntime, delay: PendingDelay): ServedDelay {
    delay.cancel();
    runtime.delay = null;
    return {
      category: delay.category,
      intendedMs: delay.intendedMs,
      // Measured to the moment the decision is actually taken rather than to the
      // moment the timer fired, so the number is what a stopwatch would have
      // seen and not what the scheduler intended.
      actualMs: Math.max(0, Math.round(this.#now() - delay.startedAt)),
    };
  }

  /** Stops a wait and forgets it, counting nothing. */
  #dropDelay(runtime: BotSeatRuntime): PendingDelay | null {
    const delay = runtime.delay;
    if (delay === null) return null;
    delay.cancel();
    runtime.delay = null;
    return delay;
  }

  #cancelDelay(runtime: BotSeatRuntime, why: string): void {
    const delay = this.#dropDelay(runtime);
    // An expired wait was already served rather than abandoned: the timer fired,
    // the pump simply reached the seat after something else had ended it.
    if (delay === null || delay.expired) return;
    runtime.delaysCancelled += 1;
    runtime.lastDelayCancellation = `${delay.intendedMs} ms of ${delay.category} pacing: ${why}`;
  }

  #cancelAllDelays(why: string): void {
    for (const runtime of this.#runtimes) this.#cancelDelay(runtime, why);
  }

  /**
   * Records the case M09.0 named, when it is genuinely the whole match rather
   * than one seat with nothing to do.
   *
   * A bot with no move is ordinary — it is somebody else's turn. A *match* where
   * no seat has a legal action and the game is not over is a defect, and the only
   * honest thing to do with it is write it down. Once per match, because a
   * stalled board stays stalled and a log full of it would say no more than one
   * line does.
   */
  #noteStallIfStuck(state: MatchState): void {
    if (this.#stalled !== null || state.status === 'complete') return;
    for (const playerId of state.seatOrder) {
      const legal = legalActions(state, playerId, {
        database: this.#database,
        config: this.#config,
      });
      if (hasBotDecision(legal)) return;
    }
    this.#stalled =
      `no seat has a legal action other than conceding at sequence ${state.sequence}, ` +
      `turn ${state.turn}, phase "${state.phase}", and the match is not complete`;
  }

  #record(
    runtime: BotSeatRuntime,
    kind: BotRunIncidentKind,
    message: string,
    pilotFailure: BotFailureKind | null,
  ): void {
    this.#incidents.push({
      kind,
      seatId: runtime.seatId,
      botId: runtime.botId,
      playerId: runtime.playerId,
      decisionIndex: runtime.decisions,
      message,
      pilotFailure,
    });
  }
}

function isForbiddenBotAction(action: Action): boolean {
  return (ACTIONS_A_LIVE_BOT_NEVER_SUBMITS as readonly string[]).includes(action.type);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
