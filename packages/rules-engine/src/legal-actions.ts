import { z } from 'zod';
import type { CardDatabase } from '@tcg/card-data';
import { DEFAULT_RULES_CONFIG, type RulesConfig } from './config.js';
import { createContext } from './context.js';
import {
  definitionOf,
  energyCostOf,
  findInstance,
  freeUnitSlots,
  hasKeyword,
  isSummoningSick,
  opponentOf,
  playerOf,
} from './derive.js';
import { legalTargets } from './targeting.js';
import {
  MAIN_PHASES,
  instanceIdSchema,
  playerIdSchema,
  type InstanceId,
  type PlayerId,
} from './schema/primitives.js';
import type { Action } from './schema/action.js';
import type { MatchState } from './schema/state.js';
import { pendingChoiceSchema } from './schema/choice.js';

/**
 * What a seat may legally do right now, computed by the engine.
 *
 * The client renders from this and never derives legality itself; a bot picks
 * from it. It is a structured description rather than a flat list because the
 * combinatorics of "every legal set of attackers" or "every legal mulligan" are
 * exponential and useless to enumerate (CLAUDE.md §10).
 */
/** A card the seat can pay for and legally play right now. */
export type PlayableCard = LegalActions['playableCards'][number];
export type ActivatableAbility = LegalActions['activatableAbilities'][number];

/**
 * Serialisable because it travels to the client inside `PlayerView`: the UI
 * highlights what the engine says is legal and never derives legality itself
 * (CLAUDE.md §11).
 */
export const legalActionsSchema = z.strictObject({
  playerId: playerIdSchema,
  canConcede: z.boolean(),
  mulligan: z
    .strictObject({
      handInstanceIds: z.array(instanceIdSchema),
      maxReturn: z.number().int().min(0),
    })
    .nullable(),
  playableCards: z.array(
    z.strictObject({
      instanceId: instanceIdSchema,
      definitionId: z.string(),
      energyCost: z.number().int().min(0),
      freeSlots: z.array(z.number().int().min(0)),
    }),
  ),
  activatableAbilities: z.array(
    z.strictObject({
      sourceInstanceId: instanceIdSchema,
      abilityId: z.string(),
      energyCost: z.number().int().min(0),
    }),
  ),
  canPassPhase: z.boolean(),
  legalAttackers: z.array(instanceIdSchema).nullable(),
  blocking: z
    .strictObject({
      attackerInstanceIds: z.array(instanceIdSchema),
      blockerInstanceIds: z.array(instanceIdSchema),
    })
    .nullable(),
  pendingChoice: pendingChoiceSchema.nullable(),
});

export type LegalActions = z.infer<typeof legalActionsSchema>;

export interface LegalActionOptions {
  readonly database: CardDatabase;
  readonly config?: RulesConfig;
}

export function legalActions(
  state: MatchState,
  playerId: PlayerId,
  options: LegalActionOptions,
): LegalActions {
  const config = options.config ?? DEFAULT_RULES_CONFIG;
  const ctx = createContext(state, options.database, config);
  const player = playerOf(state, playerId);

  const empty: LegalActions = {
    playerId,
    canConcede: state.status !== 'complete',
    mulligan: null,
    playableCards: [],
    activatableAbilities: [],
    canPassPhase: false,
    legalAttackers: null,
    blocking: null,
    pendingChoice:
      state.pendingChoice?.playerId === playerId ? structuredClone(state.pendingChoice) : null,
  };

  if (state.status === 'complete') return { ...empty, canConcede: false };
  if (state.pendingChoice !== null) return empty;

  if (state.status === 'mulligan') {
    return {
      ...empty,
      mulligan:
        player.mulligan.status === 'pending'
          ? { handInstanceIds: [...player.hand], maxReturn: player.hand.length }
          : null,
    };
  }

  const isActive = state.activePlayerId === playerId;

  if (isActive && MAIN_PHASES.includes(state.phase) && state.queue.length === 0) {
    const playableCards: PlayableCard[] = [];
    const free = freeUnitSlots(player);

    for (const instanceId of player.hand) {
      const instance = findInstance(state, instanceId);
      if (!instance) continue;
      const definition = definitionOf(options.database, instance);
      if (definition.type !== 'unit' && definition.type !== 'spell' && definition.type !== 'relic')
        continue;

      const cost = energyCostOf(player, definition);
      if (cost > player.energy) continue;
      if (definition.type === 'unit' && free.length === 0) continue;
      if (definition.type === 'relic' && player.relics.length >= config.relicSlots) continue;
      if (definition.type === 'spell') {
        const blocked = definition.effects.some((effect) => {
          if (!('target' in effect) || effect.target.optional) return false;
          return (
            legalTargets(ctx, effect.target, {
              controllerId: playerId,
              sourceInstanceId: instanceId,
            }).length === 0
          );
        });
        if (blocked) continue;
      }

      playableCards.push({
        instanceId,
        definitionId: definition.id,
        energyCost: cost,
        freeSlots: definition.type === 'unit' ? [...free] : [],
      });
    }

    const activatableAbilities: ActivatableAbility[] = [];
    const sources = [
      ...player.units.filter((id): id is InstanceId => id !== null),
      ...player.relics,
      player.commanderInstanceId,
    ];
    for (const sourceInstanceId of sources) {
      const instance = findInstance(state, sourceInstanceId);
      if (!instance) continue;
      const definition = definitionOf(options.database, instance);
      for (const ability of definition.activatedAbilities) {
        if (ability.energyCost > player.energy) continue;
        if (ability.exhaustsSource && instance.exhausted) continue;
        if (
          ability.usageLimit === 'once_per_match' &&
          (instance.counters[`used:${ability.id}`] ?? 0) > 0
        )
          continue;
        if (
          ability.usageLimit === 'once_per_turn' &&
          instance.counters[`usedTurn:${ability.id}`] === state.turn
        )
          continue;
        activatableAbilities.push({
          sourceInstanceId,
          abilityId: ability.id,
          energyCost: ability.energyCost,
        });
      }
    }

    return { ...empty, playableCards, activatableAbilities, canPassPhase: true };
  }

  if (isActive && state.phase === 'declare_attackers') {
    const legalAttackers = player.units
      .filter((id): id is InstanceId => id !== null)
      .filter((instanceId) => {
        const instance = findInstance(state, instanceId);
        if (!instance || instance.exhausted) return false;
        const definition = definitionOf(options.database, instance);
        return !isSummoningSick(instance, state) || hasKeyword(instance, definition, 'swift');
      });
    return { ...empty, legalAttackers };
  }

  if (state.phase === 'assign_blockers' && playerId === opponentOf(state, state.activePlayerId)) {
    const attackerInstanceIds = state.combat.attackerInstanceIds.filter((instanceId) => {
      const instance = findInstance(state, instanceId);
      if (!instance) return false;
      return !hasKeyword(instance, definitionOf(options.database, instance), 'evasive');
    });
    const blockerInstanceIds = player.units
      .filter((id): id is InstanceId => id !== null)
      .filter((instanceId) => {
        const instance = findInstance(state, instanceId);
        if (!instance) return false;
        return config.exhaustedUnitsMayBlock || !instance.exhausted;
      });
    return { ...empty, blocking: { attackerInstanceIds, blockerInstanceIds } };
  }

  return empty;
}

/**
 * A concrete, finite list of actions — enough for a random-legal bot or a
 * scripted test to drive a match without understanding the game. Deliberately
 * conservative: units go into the first free slot, and attacks are "all legal"
 * or "none" rather than every subset.
 */
export function enumerateActions(
  state: MatchState,
  playerId: PlayerId,
  options: LegalActionOptions,
): Action[] {
  const legal = legalActions(state, playerId, options);
  const actions: Action[] = [];

  if (legal.mulligan) {
    actions.push({ type: 'mulligan', playerId, returnInstanceIds: [] });
  }

  if (legal.pendingChoice) {
    const choice = legal.pendingChoice;
    if (choice.ordered) {
      actions.push({
        type: 'submit_choice',
        playerId,
        choiceId: choice.id,
        selectedIds: [...choice.validEntityIds],
      });
    } else {
      actions.push({
        type: 'submit_choice',
        playerId,
        choiceId: choice.id,
        selectedIds: choice.validEntityIds.slice(0, choice.minimum),
      });
    }
    return actions;
  }

  for (const card of legal.playableCards) {
    actions.push({
      type: 'play_card',
      playerId,
      instanceId: card.instanceId,
      slot: card.freeSlots[0] ?? null,
    });
  }
  for (const ability of legal.activatableAbilities) {
    actions.push({
      type: 'activate_ability',
      playerId,
      sourceInstanceId: ability.sourceInstanceId,
      abilityId: ability.abilityId,
    });
  }
  if (legal.canPassPhase) actions.push({ type: 'pass_phase', playerId });

  if (legal.legalAttackers) {
    actions.push({ type: 'declare_attackers', playerId, attackerInstanceIds: [] });
    if (legal.legalAttackers.length > 0) {
      actions.push({
        type: 'declare_attackers',
        playerId,
        attackerInstanceIds: [...legal.legalAttackers],
      });
    }
  }

  if (legal.blocking) {
    actions.push({ type: 'assign_blockers', playerId, blocks: [] });
  }

  return actions;
}
