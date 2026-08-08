import { z } from 'zod';
import type { AbilityCost, CardDatabase } from '@tcg/card-data';
import { DEFAULT_RULES_CONFIG, type RulesConfig } from './config.js';
import { createContext, type MatchContext } from './context.js';
import {
  definitionOf,
  energyCostOf,
  findInstance,
  freeUnitSlots,
  hasKeyword,
  isSummoningSick,
  livingOpponents,
  matchesCardFilter,
  playerOf,
} from './derive.js';
import { spellHasLegalTargets } from './engine.js';
import {
  MAIN_PHASES,
  instanceIdSchema,
  playerIdSchema,
  type InstanceId,
  type PlayerId,
} from './schema/primitives.js';
import type { Action } from './schema/action.js';
import type { CardInstance, MatchState } from './schema/state.js';
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
  /**
   * Attack declaration for this seat: which of its units may attack, and which
   * opponents they may be pointed at. Both halves come from the engine, so the
   * client never works out for itself who is a legal defender (CLAUDE.md §12).
   */
  attacking: z
    .strictObject({
      legalAttackers: z.array(instanceIdSchema),
      legalDefenders: z.array(playerIdSchema),
    })
    .nullable(),
  /**
   * Blocking for this seat, populated only while this player still owes a
   * submission — and listing only the attackers aimed at them.
   */
  blocking: z
    .strictObject({
      attackerInstanceIds: z.array(instanceIdSchema),
      blockerInstanceIds: z.array(instanceIdSchema),
    })
    .nullable(),
  /** Defenders the match is still waiting on, without revealing their choices. */
  awaitingDefenders: z.array(playerIdSchema),
  pendingChoice: pendingChoiceSchema.nullable(),
  /** True once this seat is out: it may watch, but every action is rejected. */
  eliminated: z.boolean(),
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
    canConcede: state.status !== 'complete' && !player.lost,
    mulligan: null,
    playableCards: [],
    activatableAbilities: [],
    canPassPhase: false,
    attacking: null,
    blocking: null,
    awaitingDefenders: [...state.combat.awaitingDefenders],
    pendingChoice:
      state.pendingChoice?.playerId === playerId ? structuredClone(state.pendingChoice) : null,
    eliminated: player.lost,
  };

  if (state.status === 'complete') return { ...empty, canConcede: false };
  // An eliminated player is a spectator: nothing is legal for them
  // (CLAUDE.md §12).
  if (player.lost) return empty;
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
      // A spell with no legal target for a required target cannot be played at
      // all, so it must not be offered (CLAUDE.md §4).
      if (definition.type === 'spell' && !spellHasLegalTargets(ctx, definition, instance)) continue;

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
        if (!costsPayable(ctx, playerId, instance, ability.costs)) continue;
        activatableAbilities.push({
          sourceInstanceId,
          abilityId: ability.id,
          energyCost: energyPortionOf(ability.costs),
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
    return {
      ...empty,
      attacking: { legalAttackers, legalDefenders: livingOpponents(state, playerId) },
    };
  }

  // Only a player who is actually being attacked, and has not answered yet,
  // may assign blockers — and only against the attackers aimed at them
  // (CLAUDE.md §12).
  if (state.phase === 'assign_blockers' && state.combat.awaitingDefenders.includes(playerId)) {
    const attackerInstanceIds = state.combat.attacks
      .filter((attack) => attack.defenderPlayerId === playerId)
      .map((attack) => attack.attackerInstanceId)
      .filter((instanceId) => {
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

/** The energy portion of an activation cost, for display and for bots. */
function energyPortionOf(costs: readonly AbilityCost[]): number {
  return costs.reduce((sum, cost) => (cost.type === 'energy' ? sum + cost.amount : sum), 0);
}

/**
 * Whether every cost in an activation could be paid right now. Mirrors the
 * engine's own plan step, so an ability is only offered when activating it
 * would actually be accepted.
 */
function costsPayable(
  ctx: MatchContext,
  playerId: PlayerId,
  source: CardInstance,
  costs: readonly AbilityCost[],
): boolean {
  const player = playerOf(ctx.state, playerId);
  let energy = 0;
  let discards = 0;
  let sacrifices = 0;

  for (const cost of costs) {
    switch (cost.type) {
      case 'energy':
        energy += cost.amount;
        if (energy > player.energy) return false;
        break;
      case 'exhaust_source':
        if (source.exhausted) return false;
        break;
      case 'discard':
        discards += cost.amount;
        if (discards > player.hand.length) return false;
        break;
      case 'sacrifice': {
        const available = player.units.filter((id): id is InstanceId => {
          if (id === null) return false;
          if (!cost.filter) return true;
          const instance = findInstance(ctx.state, id);
          if (!instance) return false;
          return matchesCardFilter(definitionOf(ctx.database, instance), instance, cost.filter);
        });
        sacrifices += cost.amount;
        if (sacrifices > available.length) return false;
        break;
      }
      default:
        return false;
    }
  }
  return true;
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

  if (legal.attacking) {
    actions.push({ type: 'declare_attackers', playerId, attacks: [] });
    const defender = legal.attacking.legalDefenders[0];
    if (legal.attacking.legalAttackers.length > 0 && defender !== undefined) {
      // Deliberately conservative: "everyone attacks the first living
      // opponent", not every assignment of attackers to defenders.
      actions.push({
        type: 'declare_attackers',
        playerId,
        attacks: legal.attacking.legalAttackers.map((attackerInstanceId) => ({
          attackerInstanceId,
          defenderPlayerId: defender,
        })),
      });
    }
  }

  if (legal.blocking) {
    actions.push({ type: 'assign_blockers', playerId, blocks: [] });
  }

  return actions;
}
