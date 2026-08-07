import { loadBundledCardData, type CardDatabase, type CardId } from '@tcg/card-data';
import { isErr, unwrap } from '@tcg/shared';
import { DEFAULT_RULES_CONFIG, type RulesConfig } from '../config.js';
import { applyAction } from '../engine.js';
import { enumerateActions } from '../legal-actions.js';
import { createMatch, type MatchDeck } from '../setup.js';
import type { Action } from '../schema/action.js';
import type { GameEvent } from '../schema/event.js';
import type { MatchState } from '../schema/state.js';

/**
 * A deterministic test harness: two scripted pilots play a complete match with
 * no browser, no network and no clock. Required by CLAUDE.md §10 so a full
 * match and its structured event log can be produced from a single seed.
 *
 * The pilots are intentionally dumb. They are here to exercise the engine, not
 * to play well — real heuristic pilots belong to the Phase 4 simulator.
 */

/** Preference order used by the scripted pilot. Earlier is stronger. */
const ACTION_PRIORITY: Record<Action['type'], number> = {
  submit_choice: 0,
  mulligan: 1,
  play_card: 2,
  activate_ability: 3,
  declare_attackers: 4,
  assign_blockers: 5,
  pass_phase: 6,
  concede: 98,
  server_timeout: 99,
};

function chooseAction(actions: readonly Action[]): Action | undefined {
  const ranked = [...actions].sort(
    (left, right) => ACTION_PRIORITY[left.type] - ACTION_PRIORITY[right.type],
  );
  // Prefer attacking with everything over attacking with nothing.
  const attacks = ranked.filter((action) => action.type === 'declare_attackers');
  if (attacks.length > 0 && ranked[0]?.type === 'declare_attackers') {
    return (
      attacks.find(
        (action) => action.type === 'declare_attackers' && action.attackerInstanceIds.length > 0,
      ) ?? attacks[0]
    );
  }
  return ranked[0];
}

export interface ScriptedMatchOptions {
  readonly seed: string;
  readonly database?: CardDatabase;
  readonly config?: RulesConfig;
  /** Hard stop so a harness bug cannot spin forever. */
  readonly maxActions?: number;
  readonly decks?: readonly [MatchDeck, MatchDeck];
}

export interface ScriptedMatchOutcome {
  readonly state: MatchState;
  readonly events: readonly GameEvent[];
  readonly actions: readonly Action[];
  readonly stoppedEarly: boolean;
}

/** A 30-card deck built by repeating a short list. Legality is not the point here. */
export function repeatDeck(commanderId: CardId, cardIds: readonly CardId[], size = 30): MatchDeck {
  const counts = new Map<CardId, number>();
  for (let i = 0; i < size; i += 1) {
    const cardId = cardIds[i % cardIds.length];
    if (cardId === undefined) break;
    counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  }
  return {
    commanderId,
    cards: [...counts].map(([cardId, quantity]) => ({ cardId, quantity })),
  };
}

export const DEFAULT_SCRIPT_DECKS: readonly [MatchDeck, MatchDeck] = [
  repeatDeck('prototype_commander_red', [
    'goblin_scout',
    'powder_keg_runner',
    'scorch',
    'pyre_champion',
    'prototype_scout',
    'unstable_construct',
  ]),
  repeatDeck('prototype_commander_green', [
    'thornback_calf',
    'wildgrowth_shaman',
    'root_snare',
    'bramble_titan',
    'prototype_guard',
    'pack_summons',
  ]),
];

export function runScriptedMatch(options: ScriptedMatchOptions): ScriptedMatchOutcome {
  const database = options.database ?? loadBundledCardData().database;
  const config = options.config ?? DEFAULT_RULES_CONFIG;
  const [deckA, deckB] = options.decks ?? DEFAULT_SCRIPT_DECKS;

  const start = unwrap(
    createMatch({
      matchId: `scripted_${options.seed}`,
      seed: options.seed,
      database,
      config,
      seats: [
        { playerId: 'player_1', name: 'Pilot One', deck: deckA },
        { playerId: 'player_2', name: 'Pilot Two', deck: deckB },
      ],
    }),
    'Scripted match setup failed',
  );

  let state = start.state;
  const taken: Action[] = [];
  const limit = options.maxActions ?? 4000;

  for (let step = 0; step < limit; step += 1) {
    if (state.status === 'complete') {
      return { state, events: state.log, actions: taken, stoppedEarly: false };
    }

    // Ask each seat in turn order; the first with something to do acts.
    let acted = false;
    for (const playerId of state.playerOrder) {
      const action = chooseAction(enumerateActions(state, playerId, { database, config }));
      if (!action) continue;

      const result = applyAction(state, action, { database, config });
      if (isErr(result)) {
        throw new Error(
          `Scripted pilot produced an illegal action ${action.type}: ${result.error.code} ${result.error.message}`,
        );
      }
      state = result.value.state;
      taken.push(action);
      acted = true;
      break;
    }

    if (!acted) {
      // Nobody has a legal action: concede on behalf of the active player so the
      // harness terminates loudly instead of silently spinning.
      const result = applyAction(
        state,
        { type: 'concede', playerId: state.activePlayerId },
        { database, config },
      );
      if (isErr(result)) break;
      state = result.value.state;
    }
  }

  return { state, events: state.log, actions: taken, stoppedEarly: state.status !== 'complete' };
}
