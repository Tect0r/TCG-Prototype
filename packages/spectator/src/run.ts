import type { CardDatabase, CardId } from '@tcg/card-data';
import {
  createPilot,
  decideSafely,
  type BotObservation,
  type BotPolicy,
  type PilotId,
} from '@tcg/bot-interface';
import {
  applyAction,
  createMatch,
  createRngState,
  DEFAULT_RULES_CONFIG,
  legalActions,
  playerView,
  type Action,
  type GameEvent,
  type MatchDeck,
  type MatchState,
  type PlayerId,
  type RulesConfig,
} from '@tcg/rules-engine';
import { isErr } from '@tcg/shared';
import { collectTelemetry } from './telemetry.js';
import { derivePilotSeed, hashString } from './seed.js';
import {
  SPECTATOR_REPLAY_VERSION,
  type SpectatorDecision,
  type SpectatorReplay,
  type SpectatorSeat,
} from './schema.js';

/**
 * Runs one complete AI match and records it as a spectator replay.
 *
 * The match is played at full simulation speed with no delays anywhere: the
 * spectator's playback timing lives entirely in the UI and never reaches this
 * function (rule adjustment, "Architecture"). That separation is what keeps
 * "playback delay does not alter game state, bot decisions, replay contents or
 * telemetry" true by construction rather than by care.
 *
 * It is deliberately in a shared package rather than in the simulator app: the
 * web client has to run it too, and the alternative — a second driver in the
 * browser — is exactly the duplicate rules path the update forbids.
 */

export interface SpectatorSeatConfig {
  readonly playerId?: PlayerId;
  readonly name: string;
  /** The precon this seat plays, recorded in the replay for provenance. */
  readonly preconId?: string | null;
  readonly commanderId: CardId;
  readonly cardIds: readonly CardId[];
  readonly pilotId: PilotId;
}

export interface RunSpectatorMatchOptions {
  readonly matchId?: string;
  /** Any string. The same seed and seats reproduce the match exactly. */
  readonly seed: string;
  readonly seats: readonly SpectatorSeatConfig[];
  readonly database: CardDatabase;
  readonly config?: RulesConfig;
  /** Digest of the card pool, recorded so an incompatible replay fails loudly. */
  readonly cardDataHash: string;
  readonly limits?: SpectatorLimits;
}

export interface SpectatorLimits {
  readonly maxTurns: number;
  readonly maxActions: number;
}

/**
 * Generous, because a spectator match is watched rather than batched: the point
 * of the ceiling is to stop a pathological match hanging a browser tab, not to
 * cut short a long game somebody is enjoying.
 */
export const DEFAULT_SPECTATOR_LIMITS: SpectatorLimits = Object.freeze({
  maxTurns: 200,
  maxActions: 8000,
});

/** A decklist as `createMatch` wants it: singleton lists become quantity 1. */
function toMatchDeck(seat: SpectatorSeatConfig): MatchDeck {
  const counts = new Map<CardId, number>();
  for (const cardId of seat.cardIds) counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  return {
    commanderId: seat.commanderId,
    cards: [...counts].map(([cardId, quantity]) => ({ cardId, quantity })),
  };
}

/**
 * Whose decision the engine is waiting on.
 *
 * Mirrors the engine's own ordering: a pending choice belongs to one seat, an
 * open Reaction window belongs to whoever holds priority, an outstanding
 * blocker submission belongs to a named defender, and otherwise it is the
 * active player's move.
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
  const window = state.reactionWindow;
  if (window && !window.closed) {
    return window.priorityOrder[window.priorityIndex] ?? null;
  }
  if (state.phase === 'assign_blockers') {
    const awaiting = state.combat.awaitingDefenders[0];
    if (awaiting !== undefined) return awaiting;
  }
  const active = state.players[state.activePlayerId];
  if (!active || active.lost) return null;
  return state.activePlayerId;
}

export async function runSpectatorMatch(
  options: RunSpectatorMatchOptions,
): Promise<SpectatorReplay> {
  const config = options.config ?? DEFAULT_RULES_CONFIG;
  const limits = options.limits ?? DEFAULT_SPECTATOR_LIMITS;
  const { database } = options;
  const matchId = options.matchId ?? `spectate_${hashString(options.seed).slice(0, 8)}`;
  const diagnostics: string[] = [];

  const seats: SpectatorSeat[] = options.seats.map((seat, index) => ({
    playerId: seat.playerId ?? `player_${index + 1}`,
    name: seat.name,
    seatIndex: index,
    preconId: seat.preconId ?? null,
    commanderId: seat.commanderId,
    cardIds: [...seat.cardIds],
    pilotId: seat.pilotId,
    pilotVersion: '',
    pilotSeed: derivePilotSeed(options.seed, index),
  }));

  const pilots: BotPolicy[] = options.seats.map((seat) => createPilot({ id: seat.pilotId }));
  pilots.forEach((pilot, index) => {
    const seat = seats[index];
    if (seat) seats[index] = { ...seat, pilotVersion: pilot.version };
  });

  const created = createMatch({
    matchId,
    seed: options.seed,
    database,
    config,
    // Seat order is the order the user configured. The spectator screen shows
    // four named boards, and shuffling them would make the labels wrong.
    preserveSeatOrder: true,
    seats: options.seats.map((seat, index) => ({
      playerId: seats[index]?.playerId ?? `player_${index + 1}`,
      name: seat.name,
      deck: toMatchDeck(seat),
    })),
  });
  if (isErr(created)) {
    throw new Error(
      `Spectator match setup failed: ${created.error.code} — ${created.error.message}`,
    );
  }

  let state = created.value.state;
  const events: GameEvent[] = [...created.value.events];
  const actions: Action[] = [];
  const decisions: SpectatorDecision[] = [];

  const rngs = seats.map((seat) => createRngState(seat.pilotSeed));
  const decisionCounts = seats.map(() => 0);
  let termination: SpectatorReplay['termination'] | null = null;
  let sawFallback = false;

  while (termination === null && state.status !== 'complete') {
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
      termination = 'engine_error';
      diagnostics.push(`no seat could act in phase "${state.phase}"`);
      break;
    }
    const seatIndex = seats.findIndex((seat) => seat.playerId === playerId);
    const policy = pilots[seatIndex];
    const rng = rngs[seatIndex];
    if (seatIndex < 0 || !policy || !rng) {
      termination = 'engine_error';
      diagnostics.push(`no pilot is seated as "${playerId}"`);
      break;
    }

    const legal = legalActions(state, playerId, { database, config });
    // A pilot sees exactly what a human at that seat would: its own redacted
    // view and the engine's legality. Analysis Mode reveals hands *to the
    // viewer* afterwards; it never hands a bot anything extra.
    const view = playerView(state, playerId, database, config);
    const observation: BotObservation = {
      view,
      legal,
      history: view.log,
      database,
      rulesConfig: config,
      decisionIndex: decisionCounts[seatIndex] ?? 0,
    };

    const outcome = await decideSafely(policy, observation, rng, {
      config,
      decisionBudget: limits.maxActions,
    });
    rngs[seatIndex] = outcome.decision.rng;
    decisionCounts[seatIndex] = (decisionCounts[seatIndex] ?? 0) + 1;
    if (outcome.failure) {
      sawFallback = true;
      diagnostics.push(
        `pilot "${outcome.failure.botId}" (${playerId}) ${outcome.failure.kind}: ${outcome.failure.message}`,
      );
    }

    const turnBefore = state.turn;
    const phaseBefore = state.phase;
    const applied = applyAction(state, outcome.decision.action, { database, config });
    if (isErr(applied)) {
      termination = 'engine_error';
      diagnostics.push(
        `engine rejected ${outcome.decision.action.type} from ${playerId}: ` +
          `${applied.error.code} — ${applied.error.message}`,
      );
      break;
    }

    state = applied.value.state;
    actions.push(outcome.decision.action);
    events.push(...applied.value.events);
    decisions.push({
      index: decisions.length,
      playerId,
      turn: turnBefore,
      phase: phaseBefore,
      sequenceAfter: state.sequence,
      chosenKey: outcome.decision.diagnostics?.chosenKey ?? null,
      candidateCount: outcome.decision.diagnostics?.candidateCount ?? 0,
      scores: [...(outcome.decision.diagnostics?.scores ?? [])],
      notes: [...(outcome.decision.diagnostics?.notes ?? [])],
      usedFallback: outcome.usedFallback,
    });
  }

  if (termination === null) {
    if (state.result?.reason === 'engine_error') termination = 'engine_error';
    else if (state.result?.outcome === 'draw') termination = 'draw';
    else termination = 'victory';
  }
  // A match that finished normally but needed a fallback still has a defect in
  // it, and must be separable from a clean one.
  if (sawFallback && termination === 'victory') termination = 'pilot_error';

  return {
    schemaVersion: SPECTATOR_REPLAY_VERSION,
    matchSchemaVersion: state.schemaVersion,
    rulesVersion: config.version,
    cardDataHash: options.cardDataHash,
    matchId,
    seed: options.seed,
    seats,
    playerOrder: [...state.playerOrder],
    seatOrder: [...state.seatOrder],
    actions,
    events,
    decisions,
    result: state.result ? structuredClone(state.result) : null,
    termination,
    diagnostics,
    telemetry: collectTelemetry(state, events, decisions, database, config, seats),
  };
}
