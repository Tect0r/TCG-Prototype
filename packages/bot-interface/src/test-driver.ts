import { loadBundledCardData, type CardDatabase, type CardId } from '@tcg/card-data';
import { unwrap } from '@tcg/shared';
import {
  applyAction,
  createMatch,
  createRngState,
  DEFAULT_RULES_CONFIG,
  legalActions,
  playerView,
  type Action,
  type MatchDeck,
  type MatchState,
  type RulesConfig,
} from '@tcg/rules-engine';
import { decideSafely } from './run-pilot.js';
import type { BotFailure, BotObservation, BotPolicy, DecisionFamily } from './types.js';

/**
 * A minimal in-package match driver for the contract tests.
 *
 * Deliberately *not* the simulator's runner: this package must not depend on
 * `apps/simulator` (CLAUDE.md §13.2), and the contract tests need to prove the
 * boundary holds with nothing but the engine's public API in the room. The real
 * runner, with telemetry and safeguards, lives in the simulator.
 */

let cachedDatabase: CardDatabase | undefined;

export function botTestDatabase(): CardDatabase {
  cachedDatabase ??= loadBundledCardData().database;
  return cachedDatabase;
}

/** A 30-card deck built by repeating a short list. */
export function repeatDeck(commanderId: CardId, cardIds: readonly CardId[], size = 30): MatchDeck {
  const counts = new Map<CardId, number>();
  for (let index = 0; index < size; index += 1) {
    const cardId = cardIds[index % cardIds.length];
    if (cardId === undefined) break;
    counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  }
  return { commanderId, cards: [...counts].map(([cardId, quantity]) => ({ cardId, quantity })) };
}

export const RED_DECK: MatchDeck = repeatDeck('prototype_commander_red', [
  'goblin_scout',
  'powder_keg_runner',
  'scorch',
  'pyre_champion',
  'warband_horn',
  'unstable_construct',
  'prototype_scout',
]);

export const GREEN_DECK: MatchDeck = repeatDeck('prototype_commander_green', [
  'thornback_calf',
  'wildgrowth_shaman',
  'root_snare',
  'bramble_titan',
  'pack_summons',
  'verdant_ward',
  'prototype_guard',
]);

export const BLUE_DECK: MatchDeck = repeatDeck('prototype_commander_blue', [
  'tidepool_apprentice',
  'desperate_insight',
  'arcane_recall',
  'mistveil_stalker',
  'tide_binder',
  'field_survey',
  'surveyors_lens',
]);

export interface DriveOptions {
  readonly seed: string;
  readonly pilots: readonly BotPolicy[];
  readonly decks?: readonly MatchDeck[];
  readonly database?: CardDatabase;
  readonly config?: RulesConfig;
  readonly maxActions?: number;
  /** Called for every observation handed to a pilot, before it decides. */
  readonly onObservation?: (observation: BotObservation, policy: BotPolicy) => void;
}

export interface DriveOutcome {
  readonly state: MatchState;
  readonly actions: readonly Action[];
  readonly families: ReadonlySet<DecisionFamily>;
  readonly failures: readonly BotFailure[];
  readonly stoppedEarly: boolean;
}

/** Plays one complete match, returning everything the contract tests assert on. */
export async function driveMatch(options: DriveOptions): Promise<DriveOutcome> {
  const database = options.database ?? botTestDatabase();
  const config = options.config ?? DEFAULT_RULES_CONFIG;
  const decks = options.decks ?? [RED_DECK, GREEN_DECK];
  const limit = options.maxActions ?? 3000;

  let state = unwrap(
    createMatch({
      matchId: `bot_test_${options.seed}`,
      seed: options.seed,
      database,
      config,
      preserveSeatOrder: true,
      seats: options.pilots.map((_, index) => ({
        playerId: `player_${index + 1}`,
        name: `Seat ${index + 1}`,
        deck: decks[index % decks.length] as MatchDeck,
      })),
    }),
    'bot test match setup failed',
  ).state;

  const rngs = options.pilots.map((policy, index) =>
    createRngState(`${options.seed}:${policy.id}:${index}`),
  );
  const decisions = options.pilots.map(() => 0);
  const actions: Action[] = [];
  const families = new Set<DecisionFamily>();
  const failures: BotFailure[] = [];

  for (let step = 0; step < limit; step += 1) {
    if (state.status === 'complete') {
      return { state, actions, families, failures, stoppedEarly: false };
    }

    const seatIndex = seatToAct(state, options.pilots.length);
    const policy = seatIndex === null ? undefined : options.pilots[seatIndex];
    const seatRng = seatIndex === null ? undefined : rngs[seatIndex];
    if (seatIndex === null || policy === undefined || seatRng === undefined) break;
    const playerId = `player_${seatIndex + 1}`;

    const view = playerView(state, playerId, database, config);
    const observation: BotObservation = {
      view,
      legal: legalActions(state, playerId, { database, config }),
      history: view.log,
      database,
      rulesConfig: config,
      decisionIndex: decisions[seatIndex] ?? 0,
    };
    options.onObservation?.(observation, policy);

    const result = await decideSafely(policy, observation, seatRng, {
      config,
      decisionBudget: 5000,
    });
    if (result.failure) failures.push(result.failure);
    rngs[seatIndex] = result.decision.rng;
    decisions[seatIndex] = (decisions[seatIndex] ?? 0) + 1;
    if (result.decision.diagnostics) families.add(result.decision.diagnostics.family);

    const applied = applyAction(state, result.decision.action, { database, config });
    if (!applied.ok) {
      throw new Error(
        `Pilot "${policy.id}" produced an action the engine rejected: ${applied.error.code} ${applied.error.message}`,
      );
    }
    state = applied.value.state;
    actions.push(result.decision.action);
  }

  return { state, actions, families, failures, stoppedEarly: state.status !== 'complete' };
}

/**
 * Whose turn it is to make a decision.
 *
 * Mirrors the engine's own ordering: a pending choice belongs to exactly one
 * seat, an open Reaction window belongs to whoever currently holds priority in
 * it, an unfinished blocker submission belongs to a specific defender, and
 * otherwise the active player acts.
 *
 * The Reaction case was missing until M09.15, which is why this driver could not
 * play a deck that contains one: it went on asking the active player while the
 * engine was waiting on the seat holding priority, and that seat's only legal
 * moves were inside a window the driver never mentioned. Every deck the contract
 * tests fly is built from `prototype_core`, which prints no Reaction, so nothing
 * had ever asked.
 */
function seatToAct(state: MatchState, seats: number): number | null {
  const indexOf = (playerId: string): number | null => {
    const index = state.seatOrder.indexOf(playerId);
    return index >= 0 && index < seats ? Number(playerId.replace('player_', '')) - 1 : null;
  };

  if (state.pendingChoice) return indexOf(state.pendingChoice.playerId);
  const window = state.reactionWindow;
  if (window && !window.closed) {
    const holder = window.priorityOrder[window.priorityIndex];
    return holder === undefined ? null : indexOf(holder);
  }
  if (state.status === 'mulligan') {
    const pending = state.seatOrder.find(
      (playerId) => state.players[playerId]?.mulligan.status === 'pending',
    );
    return pending ? indexOf(pending) : null;
  }
  const awaiting = state.combat.awaitingDefenders[0];
  if (state.phase === 'assign_blockers' && awaiting !== undefined) return indexOf(awaiting);
  return indexOf(state.activePlayerId);
}
