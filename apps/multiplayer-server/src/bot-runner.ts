import { botStyleDefinition, difficultyDefinition, type BotSeatConfig } from '@tcg/bot-config';
import type { CardDatabase } from '@tcg/card-data';
import {
  createPilot,
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
 * Nothing here waits: M09.4 is 0% pacing only, and the delay scheduler is
 * M09.12's. The yield below is a stack-safety boundary, not a pacing dial.
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
  /** Why this seat stopped being asked, or `null` while it is still playing. */
  readonly halted: string | null;
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
 * Style chooses the weight vector; difficulty chooses how well the bot uses it.
 * `normal` is "the published heuristic for the chosen style, unchanged", which is
 * exactly why it adds nothing here. The switch is total over `BotDifficulty`, so
 * M09.13 and M09.15 cannot ship a difficulty without deciding what flies it.
 */
export function createBotPilot(config: BotSeatConfig): BotPolicy {
  const pilotId = pilotIdSchema.parse(botStyleDefinition(config.style).pilotId);
  switch (config.difficulty) {
    case 'normal':
      return createPilot({ id: pilotId });
    case 'easy':
    case 'hard': {
      const definition = difficultyDefinition(config.difficulty);
      throw new Error(
        `Difficulty "${definition.label}" is planned for ${definition.plannedIn ?? 'a later tranche'} ` +
          'and has no decision procedure behind it.',
      );
    }
    default: {
      const never: never = config.difficulty;
      throw new Error(`Unknown difficulty "${String(never)}".`);
    }
  }
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

interface BotSeatRuntime {
  readonly seatId: SeatId;
  readonly botId: string;
  readonly playerId: PlayerId;
  readonly pilot: BotPolicy | null;
  readonly seed: string;
  rng: RngState;
  decisions: number;
  readonly committed: Map<string, number>;
  halted: string | null;
}

export class BotRunner {
  readonly #database: CardDatabase;
  readonly #config: RulesConfig;
  readonly #state: () => MatchState | null;
  readonly #submit: BotRunnerOptions['submit'];
  readonly #decisionLimit: number;
  readonly #yield: () => Promise<void>;

  readonly #runtimes: BotSeatRuntime[] = [];
  readonly #incidents: BotRunIncident[] = [];
  #stalled: string | null = null;
  #crashed: string | null = null;

  #running = false;
  #pending: Promise<void> | null = null;
  #stopped = false;

  constructor(options: BotRunnerOptions) {
    this.#database = options.database;
    this.#config = options.config;
    this.#state = options.state;
    this.#submit = options.submit;
    this.#decisionLimit = options.decisionLimit ?? DEFAULT_BOT_DECISION_LIMIT;
    this.#yield = options.yieldToScheduler ?? (() => Promise.resolve());

    const pilotFor = options.pilotFor ?? ((seat: BotRunnerSeat) => createBotPilot(seat.config));
    for (const seat of options.seats) {
      const botId = seat.config.controller.botId;
      const runtime: BotSeatRuntime = {
        seatId: seat.seatId,
        botId,
        playerId: seat.playerId,
        pilot: null,
        seed: botSeedFor(options.matchSeed, seat.seatId),
        rng: createRngState(botSeedFor(options.matchSeed, seat.seatId)),
        decisions: 0,
        committed: new Map(),
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
    if (this.#stopped || this.#running) return;
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

  /** Cancels all further work. Called at match completion and lobby closure. */
  stop(): void {
    this.#stopped = true;
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
        seed: runtime.seed,
        decisions: runtime.decisions,
        actions: Object.fromEntries([...runtime.committed].sort(([a], [b]) => a.localeCompare(b))),
        halted: runtime.halted,
      })),
      incidents: [...this.#incidents],
      stalled: this.#stalled,
      crashed: this.#crashed,
    };
  }

  /* ------------------------------------------------------------- the pump */

  async #pump(): Promise<void> {
    while (!this.#stopped) {
      const state = this.#state();
      if (!state || state.status === 'complete') return;

      const next = this.#nextEligible(state);
      if (!next) {
        this.#noteStallIfStuck(state);
        return;
      }
      const { runtime, pilot, legal } = next;

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
      // iteration — never carried over from the iteration that scheduled it.
      const observation: BotObservation = this.#observationFor(state, runtime, legal);
      const sequenceBefore = state.sequence;

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

  /** The first bot seat, in seat order, the engine is currently offering a move. */
  #nextEligible(
    state: MatchState,
  ): { runtime: BotSeatRuntime; pilot: BotPolicy; legal: LegalActions } | null {
    for (const runtime of this.#runtimes) {
      const pilot = runtime.pilot;
      if (runtime.halted !== null || pilot === null) continue;
      if (state.players[runtime.playerId]?.lost !== false) continue;
      const legal = legalActions(state, runtime.playerId, {
        database: this.#database,
        config: this.#config,
      });
      if (hasBotDecision(legal)) return { runtime, pilot, legal };
    }
    return null;
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
