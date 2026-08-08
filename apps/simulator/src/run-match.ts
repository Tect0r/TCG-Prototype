import {
  applyAction,
  createMatch,
  legalActions,
  playerView,
  type Action,
  type GameEvent,
  type MatchDeck,
  type MatchState,
  type PlayerId,
} from '@tcg/rules-engine';
import { isErr } from '@tcg/shared';
import {
  createPilot,
  decideSafely,
  type BotDiagnostics,
  type BotFailure,
  type BotObservation,
  type BotPolicy,
  type PilotSpec,
} from '@tcg/bot-interface';
import type { Environment } from './environment.js';
import { digestOf } from './hash.js';
import { rngFor, type SeedBundle } from './seed.js';
import { TelemetryCollector, type SeatSetup } from './telemetry/collector.js';
import {
  TELEMETRY_SCHEMA_VERSION,
  isAbnormal,
  type MatchRecord,
  type TerminationKind,
} from './telemetry/schema.js';

/**
 * Plays exactly one headless match (CLAUDE.md §13.5).
 *
 * The engine's own resolution-step and repeated-state safeguards stay
 * authoritative; the limits here sit *outside* them and catch the other failure
 * mode — a match that is resolving perfectly legally and simply never ends
 * because two pilots refuse to attack. Every stop is classified, and an abnormal
 * stop always keeps a replay rather than quietly polluting the statistics.
 */

export interface RunMatchSeat {
  readonly playerId: PlayerId;
  readonly deckId: string;
  readonly deckHash: string;
  readonly deck: MatchDeck;
  readonly pilot: PilotSpec;
}

export interface MatchLimits {
  readonly maxTurns: number;
  readonly maxActions: number;
  readonly maxDecisionsPerSeat: number;
  /**
   * How many consecutive identical public-state-and-action signatures count as
   * "no progress". Never triggered by matching states alone: hidden deck and
   * generator state can differ behind an identical board, so the signature
   * includes the action each seat just took (CLAUDE.md §13.5).
   */
  readonly noProgressWindow: number;
}

export const DEFAULT_LIMITS: MatchLimits = Object.freeze({
  maxTurns: 200,
  maxActions: 6000,
  maxDecisionsPerSeat: 4000,
  noProgressWindow: 60,
});

export interface RunMatchOptions {
  readonly experimentId: string;
  readonly environment: Environment;
  /** Identity of the match, as decided by the schedule. */
  readonly matchId: string;
  readonly orderKey: string;
  readonly deckPairId: string;
  /** Identity of everything that varies besides the decks: the pilot tuple. */
  readonly variantKey: string;
  readonly gameIndex: number;
  readonly orientation: number;
  readonly seeds: SeedBundle;
  readonly seats: readonly RunMatchSeat[];
  readonly limits?: MatchLimits;
  readonly softwareCommit?: string | null;
}

/**
 * The logs are always collected and always returned.
 *
 * Whether a match deserves a replay is only knowable once it has ended — an
 * abnormal termination is discovered at the last step — so deciding up front not
 * to record would produce exactly the useless artefact the requirement exists to
 * prevent: a replay bundle for a broken match with nothing in it. The cost is
 * one match's logs held at a time and released immediately; what §13.14 asks us
 * not to retain is the logs of *every* match across a large run, which is the
 * caller's decision (see `runOne`).
 */
export interface RunMatchResult {
  readonly record: MatchRecord;
  readonly state: MatchState;
  readonly actions: readonly Action[];
  readonly events: readonly GameEvent[];
  readonly decisions: readonly DecisionTrace[];
  readonly abnormal: boolean;
}

export interface DecisionTrace {
  readonly index: number;
  readonly playerId: PlayerId;
  readonly turn: number;
  readonly phase: string;
  readonly action: Action;
  readonly diagnostics: BotDiagnostics | null;
  readonly usedFallback: boolean;
}

export async function runMatch(options: RunMatchOptions): Promise<RunMatchResult> {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const { environment } = options;
  const { database, rulesConfig } = environment;
  const diagnostics: string[] = [];

  const pilots: BotPolicy[] = options.seats.map((seat) => createPilot(seat.pilot));

  const created = createMatch({
    matchId: options.matchId,
    seed: options.seeds.matchSeed,
    database,
    config: rulesConfig,
    // Seat order is decided by the schedule, not re-rolled inside the engine:
    // a mirrored schedule is only mirrored if the seats stay where it put them.
    preserveSeatOrder: true,
    seats: options.seats.map((seat) => ({
      playerId: seat.playerId,
      name: seat.playerId,
      deck: seat.deck,
    })),
  });

  if (isErr(created)) {
    throw new Error(`Match setup failed: ${created.error.code} — ${created.error.message}`);
  }

  let state = created.value.state;
  const events: GameEvent[] = [...created.value.events];
  const actions: Action[] = [];
  const decisions: DecisionTrace[] = [];
  const failures: BotFailure[] = [];

  const setups: SeatSetup[] = options.seats.map((seat, index) => ({
    playerId: seat.playerId,
    seatIndex: index,
    deckId: seat.deckId,
    deckHash: seat.deckHash,
    deck: seat.deck,
    pilotId: pilots[index]?.id ?? seat.pilot.id,
    pilotVersion: pilots[index]?.version ?? '0',
    pilotConfigHash: digestOf(pilots[index]?.config ?? {}),
    pilotSeed: options.seeds.pilotSeeds[index] ?? '',
  }));

  const collector = new TelemetryCollector(database, setups, state);
  const rngs = setups.map((setup) => rngFor(setup.pilotSeed));
  const decisionCounts = setups.map(() => 0);

  const signatures: string[] = [];
  let termination: TerminationKind | null = null;

  while (termination === null) {
    if (state.status === 'complete') break;

    if (state.turn > limits.maxTurns) {
      termination = 'turn_limit';
      diagnostics.push(`turn limit ${limits.maxTurns} exceeded at turn ${state.turn}`);
      break;
    }
    if (actions.length >= limits.maxActions) {
      termination = 'action_limit';
      diagnostics.push(`action limit ${limits.maxActions} reached`);
      break;
    }

    const playerId = seatToAct(state);
    if (playerId === null) {
      termination = 'no_progress';
      diagnostics.push(`no seat could act in phase "${state.phase}"`);
      break;
    }
    const seatIndex = setups.findIndex((setup) => setup.playerId === playerId);
    const policy = pilots[seatIndex];
    const rng = rngs[seatIndex];
    if (seatIndex < 0 || !policy || !rng) {
      termination = 'no_progress';
      diagnostics.push(`no pilot is seated as "${playerId}"`);
      break;
    }

    const legal = legalActions(state, playerId, { database, config: rulesConfig });
    collector.observeDecision(state, playerId, legal);

    const view = playerView(state, playerId, database, rulesConfig);
    const observation: BotObservation = {
      view,
      legal,
      history: view.log,
      database,
      rulesConfig,
      decisionIndex: decisionCounts[seatIndex] ?? 0,
    };

    const outcome = await decideSafely(policy, observation, rng, {
      config: rulesConfig,
      decisionBudget: limits.maxDecisionsPerSeat,
    });
    if (outcome.failure) {
      failures.push(outcome.failure);
      diagnostics.push(
        `pilot "${outcome.failure.botId}" (${playerId}) ${outcome.failure.kind}: ${outcome.failure.message}`,
      );
    }
    rngs[seatIndex] = outcome.decision.rng;
    decisionCounts[seatIndex] = (decisionCounts[seatIndex] ?? 0) + 1;

    const before = state;
    const applied = applyAction(state, outcome.decision.action, {
      database,
      config: rulesConfig,
    });
    if (isErr(applied)) {
      // `decideSafely` already checked the action against `LegalActions`, so a
      // rejection here means the pilot and the engine disagree about legality —
      // a genuine defect, kept as a replay rather than swallowed.
      termination = 'illegal_bot_action';
      diagnostics.push(
        `engine rejected ${outcome.decision.action.type} from ${playerId}: ${applied.error.code} — ${applied.error.message}`,
      );
      failures.push({
        kind: 'illegal_action',
        botId: policy.id,
        playerId,
        decisionIndex: decisionCounts[seatIndex] ?? 0,
        message: `${applied.error.code}: ${applied.error.message}`,
      });
      break;
    }

    state = applied.value.state;
    actions.push(outcome.decision.action);
    events.push(...applied.value.events);

    collector.observeAction(outcome.decision.action, before, state);
    collector.observeEvents(applied.value.events, state);

    decisions.push({
      index: decisions.length,
      playerId,
      turn: before.turn,
      phase: before.phase,
      action: outcome.decision.action,
      diagnostics: outcome.decision.diagnostics,
      usedFallback: outcome.usedFallback,
    });

    // No-progress detection: the same public board *and* the same action from
    // the same seat, repeated. Matching boards alone are normal in a stalled
    // match where both players are still drawing cards.
    signatures.push(progressSignature(state, playerId, outcome.decision.action));
    if (signatures.length > limits.noProgressWindow) signatures.shift();
    if (signatures.length === limits.noProgressWindow && new Set(signatures).size === 1) {
      termination = 'no_progress';
      diagnostics.push(
        `no progress: the same board and action repeated ${limits.noProgressWindow} times`,
      );
      break;
    }
  }

  if (termination === null) {
    if (state.result?.reason === 'engine_error') termination = 'engine_error';
    else if (state.result?.outcome === 'draw') termination = 'draw';
    else if (state.status === 'complete') termination = 'victory';
    else termination = 'no_progress';
  }
  if (failures.length > 0 && termination === 'victory') {
    // A match that finished normally but needed a fallback is still a match with
    // a defect in it, and must be separable from a clean one.
    termination = 'pilot_error';
  }

  const collected = collector.finish(state, failures);

  const record: MatchRecord = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    matchId: options.matchId,
    orderKey: options.orderKey,
    experimentId: options.experimentId,
    environmentId: environment.id,
    environmentHash: environment.hash,
    cardPoolHash: environment.cardPoolHash,
    deckPairId: options.deckPairId,
    variantKey: options.variantKey,
    gameIndex: options.gameIndex,
    orientation: options.orientation,
    rulesVersion: rulesConfig.version,
    seeds: options.seeds,
    softwareCommit: options.softwareCommit ?? null,
    playerCount: options.seats.length,
    seats: [...collected.seats],
    startingPlayerId: created.value.state.activePlayerId,
    termination,
    outcome: state.result?.outcome ?? 'none',
    winnerId: state.result?.winnerId ?? null,
    endReason: state.result?.reason ?? null,
    turns: state.turn,
    actions: actions.length,
    decisions: collected.decisions,
    events: state.sequence,
    resolutionSteps: state.resolutionSteps,
    cards: [...collected.cards],
    botFailures: failures,
    diagnostics,
    replayPath: null,
  };

  return { record, state, actions, events, decisions, abnormal: isAbnormal(termination) };
}

/**
 * Whose decision the engine is waiting on.
 *
 * Mirrors the engine's own ordering exactly: a pending choice belongs to one
 * seat, an outstanding blocker submission belongs to a named defender, and
 * otherwise it is the active player's move.
 */
export function seatToAct(state: MatchState): PlayerId | null {
  if (state.status === 'complete') return null;
  if (state.pendingChoice) return state.pendingChoice.playerId;
  if (state.status === 'mulligan') {
    return (
      state.seatOrder.find((playerId) => state.players[playerId]?.mulligan.status === 'pending') ??
      null
    );
  }
  if (state.phase === 'assign_blockers') {
    const awaiting = state.combat.awaitingDefenders[0];
    if (awaiting !== undefined) return awaiting;
  }
  const active = state.players[state.activePlayerId];
  if (!active || active.lost) return null;
  return state.activePlayerId;
}

/** Compact signature of the public position plus the move that produced it. */
function progressSignature(state: MatchState, playerId: PlayerId, action: Action): string {
  const board = state.seatOrder
    .map((id) => {
      const player = state.players[id];
      if (!player) return '';
      const units = player.units.map((slot) => slot ?? '-').join(',');
      return `${id}:${player.health}:${player.hand.length}:${player.deck.length}:${units}`;
    })
    .join('|');
  return `${state.turn}/${state.phase}/${playerId}/${action.type}/${board}`;
}
