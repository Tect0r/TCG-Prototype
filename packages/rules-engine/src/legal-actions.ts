import { z } from 'zod';
import type { AbilityCost, CardDatabase } from '@tcg/card-data';
import { DEFAULT_RULES_CONFIG, type RulesConfig } from './config.js';
import { createContext, type MatchContext } from './context.js';
import {
  attackCensus,
  commanderDeployCost,
  definitionOf,
  findInstance,
  hasKeyword,
  isNewlyDeployed,
  livingOpponents,
  matchesCardFilter,
  playerOf,
} from './derive.js';
import { playCostOf } from './costs.js';
import { spellHasLegalTargets } from './engine.js';
import { playableReactions } from './reactions.js';
import { reactionWindowSchema } from '@tcg/card-data';
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
  /**
   * Carries no slot information: the battlefield is unbounded, so "where does
   * it go" is not a decision anyone makes (ruleset update §7).
   */
  playableCards: z.array(
    z.strictObject({
      instanceId: instanceIdSchema,
      definitionId: z.string(),
      energyCost: z.number().int().min(0),
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
      /** This defender's ready Guardians, a subset of `blockerInstanceIds`. */
      guardianInstanceIds: z.array(instanceIdSchema).default([]),
      /**
       * How many attackers this defender is *obliged* to block, because they
       * control that many ready Guardians. The defender still picks which
       * attacker each Guardian blocks (ruleset update §9).
       */
      mustBlockCount: z.number().int().min(0).default(0),
    })
    .nullable(),
  /**
   * The open Reaction window as this seat may act in it, populated only while
   * this player holds priority (rule adjustment §5).
   *
   * `canPass` is always true when the block is present: declining is how a
   * window closes, so a seat that has been offered priority can always give it
   * back. The playable list is the engine's, never the client's — the timing
   * window, the subject filter and the per-turn discount are all engine rules.
   */
  reaction: z
    .strictObject({
      windowId: z.string(),
      windows: z.array(reactionWindowSchema),
      subjectInstanceId: instanceIdSchema.nullable(),
      playableCards: z.array(
        z.strictObject({
          instanceId: instanceIdSchema,
          definitionId: z.string(),
          energyCost: z.number().int().min(0),
        }),
      ),
      canPass: z.boolean(),
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
    reaction: null,
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

  // A Reaction window pre-empts everything else: while one is open the only
  // legal moves are playing a Reaction or passing priority, and only for the
  // seat that holds it (rule adjustment §5).
  const window = state.reactionWindow;
  if (window !== null && !window.closed) {
    if (window.priorityOrder[window.priorityIndex] !== playerId) return empty;
    return {
      ...empty,
      reaction: {
        windowId: window.id,
        windows: [...window.windows],
        subjectInstanceId: window.pending.find((entry) => entry.isSubject)?.instanceId ?? null,
        playableCards: playableReactions(ctx, playerId, window),
        canPass: true,
      },
    };
  }
  if (window !== null) return empty;

  const isActive = state.activePlayerId === playerId;

  if (isActive && MAIN_PHASES.includes(state.phase) && state.queue.length === 0) {
    const playableCards: PlayableCard[] = [];

    for (const instanceId of player.hand) {
      const instance = findInstance(state, instanceId);
      if (!instance) continue;
      const definition = definitionOf(options.database, instance);
      if (definition.type !== 'unit' && definition.type !== 'spell' && definition.type !== 'relic')
        continue;

      const cost = playCostOf(ctx, playerId, instance, definition);
      if (cost > player.energy) continue;
      // A relic at the limit is playable: it replaces the current one rather
      // than being refused (ruleset update §12). Only a format that allows no
      // relics at all makes one unplayable.
      if (definition.type === 'relic' && config.relicSlots < 1) continue;
      // A spell with no legal target for a required target cannot be played at
      // all, so it must not be offered (CLAUDE.md §4).
      if (definition.type === 'spell' && !spellHasLegalTargets(ctx, definition, instance)) continue;
      // "As an additional cost, sacrifice a Unit" with no Unit to sacrifice is
      // the same kind of unplayable, and would otherwise be offered and then
      // rejected.
      if (!costsPayable(ctx, playerId, instance, definition.additionalCosts)) continue;

      playableCards.push({ instanceId, definitionId: definition.id, energyCost: cost });
    }

    // The Commander is played out of its own zone rather than out of hand, so
    // it is offered alongside the hand rather than found in it (rule adjustment
    // §2). A Commander with no printed cost is not deployable and never appears.
    const commander = findInstance(state, player.commanderInstanceId);
    if (commander && commander.zone === 'commander_zone') {
      const definition = definitionOf(options.database, commander);
      const cost = commanderDeployCost(player, definition, config);
      if (cost !== null && cost <= player.energy) {
        playableCards.push({
          instanceId: commander.instanceId,
          definitionId: definition.id,
          energyCost: cost,
        });
      }
    }

    const activatableAbilities: ActivatableAbility[] = [];
    const sources = [...player.units, ...player.relics, player.commanderInstanceId];
    for (const sourceInstanceId of sources) {
      const instance = findInstance(state, sourceInstanceId);
      if (!instance) continue;
      const definition = definitionOf(options.database, instance);
      for (const ability of definition.activatedAbilities) {
        // The ability's own declared zone, never where the card happens to be
        // (rule adjustment §3).
        if (instance.zone !== ability.activeZone) continue;
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
    // The same census the engine records as `attack_opportunity` (M04.2), so what
    // a seat is offered and what the telemetry says it could have done are one
    // answer rather than two implementations of the same rule.
    const { legalAttackers } = attackCensus(state, options.database, playerId);
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
    const blockerInstanceIds = player.units.filter((instanceId) => {
      const instance = findInstance(state, instanceId);
      if (!instance) return false;
      return config.exhaustedUnitsMayBlock || !instance.exhausted;
    });

    // Guardian: while this defender controls a *ready* Guardian that could block
    // an attacker, that attacker may not be left unblocked. Each Guardian
    // covers at most one attack, so with more attackers than Guardians only
    // that many blocks are compulsory — the defender still chooses which
    // Guardian blocks which attacker (ruleset update §9).
    const readyGuardians = blockerInstanceIds.filter((instanceId) => {
      const instance = findInstance(state, instanceId);
      if (!instance || instance.exhausted) return false;
      return hasKeyword(instance, definitionOf(options.database, instance), 'guardian');
    });
    const mustBlockCount = Math.min(readyGuardians.length, attackerInstanceIds.length);

    return {
      ...empty,
      blocking: {
        attackerInstanceIds,
        blockerInstanceIds,
        guardianInstanceIds: readyGuardians,
        mustBlockCount,
      },
    };
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
      case 'exhaust_source': {
        if (source.exhausted) return false;
        // Newly Deployed blocks an Exhaust cost exactly as it blocks an attack,
        // unless the card has Rush (rule adjustment §4).
        if (isNewlyDeployed(source)) {
          if (!hasKeyword(source, definitionOf(ctx.database, source), 'rush')) return false;
        }
        break;
      }
      case 'discard':
        discards += cost.amount;
        if (discards > player.hand.length) return false;
        break;
      case 'sacrifice': {
        const available = player.units.filter((id) => {
          // Mirrors the engine's own "sacrifice another Unit" exclusion; without
          // it a lone Carrion Feeder would offer an ability it cannot pay for.
          if (cost.excludeSource && id === source.instanceId) return false;
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
 * conservative: attacks are "all legal" or "none" rather than every subset.
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
    } else if (choice.type === 'divide_damage') {
      // An allocation needs one entry per point, so the slice below would be
      // short whenever there is more damage than there are targets. Everything
      // on the first legal target is the one answer that is always valid
      // (M02.5).
      const first = choice.validEntityIds[0];
      if (first !== undefined) {
        actions.push({
          type: 'submit_choice',
          playerId,
          choiceId: choice.id,
          selectedIds: Array.from({ length: choice.minimum }, () => first),
        });
      }
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

  if (legal.reaction) {
    // Passing is listed first, and always: it is the only answer that is legal
    // in every window, and it is what closes one.
    actions.push({ type: 'pass_reaction', playerId });
    for (const card of legal.reaction.playableCards) {
      actions.push({ type: 'play_reaction', playerId, instanceId: card.instanceId });
    }
    return actions;
  }

  for (const card of legal.playableCards) {
    actions.push({ type: 'play_card', playerId, instanceId: card.instanceId });
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
    // Blocking nothing is only legal when no ready Guardian obliges a block.
    // Where one does, the minimum legal answer puts Guardians in front of the
    // first attackers, which is also the simplest deterministic assignment
    // (ruleset update §9).
    const blocking = legal.blocking;
    const blocks: { attackerInstanceId: InstanceId; blockerInstanceId: InstanceId }[] = [];
    for (let index = 0; index < blocking.mustBlockCount; index += 1) {
      const attackerInstanceId = blocking.attackerInstanceIds[index];
      const blockerInstanceId = blocking.guardianInstanceIds[index];
      if (attackerInstanceId === undefined || blockerInstanceId === undefined) break;
      blocks.push({ attackerInstanceId, blockerInstanceId });
    }
    actions.push({ type: 'assign_blockers', playerId, blocks });
  }

  return actions;
}
