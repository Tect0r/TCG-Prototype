import type { AbilityCost, CardDatabase, CardDefinition } from '@tcg/card-data';
import { err, ok, type Result } from '@tcg/shared';
import { defendersOf } from './combat.js';
import { DEFAULT_RULES_CONFIG, type RulesConfig } from './config.js';
import { createContext, emit, type MatchContext } from './context.js';
import { engineError, type EngineError } from './errors.js';
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
import { defeatUnit } from './effects.js';
import { advance, resolveMulligans, setPhase } from './flow.js';
import { settle } from './queue.js';
import { legalTargets, playerCandidates } from './targeting.js';
import { enqueue } from './triggers.js';
import { markLoss, runStateBasedChecks } from './state-based.js';
import { discardCard, moveToZone } from './zones.js';
import { actionSchema, type Action, type ActionInput } from './schema/action.js';
import type { GameEvent } from './schema/event.js';
import { MAIN_PHASES, type InstanceId, type PlayerId } from './schema/primitives.js';
import type { AttackDeclaration, CardInstance, MatchState } from './schema/state.js';

export interface ApplyContext {
  readonly database: CardDatabase;
  readonly config?: RulesConfig;
}

export interface ApplySuccess {
  readonly state: MatchState;
  readonly events: readonly GameEvent[];
}

type Outcome = Result<ApplySuccess, EngineError>;

/**
 * The single entry point for changing a match.
 *
 * Pure: the caller's state is never touched. Every path that returns an error
 * abandons the working clone entirely, which is what makes "invalid actions
 * never partially mutate match state, and never advance the RNG" structurally
 * true rather than a convention (CLAUDE.md §10).
 */
export function applyAction(
  state: MatchState,
  action: ActionInput,
  context: ApplyContext,
): Outcome {
  const parsed = actionSchema.safeParse(action);
  if (!parsed.success) {
    return err(
      engineError('engine/invalid_action', 'Action failed schema validation.', {
        detail: parsed.error.issues.map((issue) => issue.message).join('; '),
      }),
    );
  }
  const validated = parsed.data;
  const config = context.config ?? DEFAULT_RULES_CONFIG;

  if (state.status === 'complete') {
    return err(engineError('engine/match_over', 'The match has already ended.'));
  }
  const seat = state.players[validated.playerId];
  if (!seat) {
    return err(
      engineError('engine/wrong_player', `"${validated.playerId}" is not a seat in this match.`, {
        playerId: validated.playerId,
      }),
    );
  }
  // An eliminated player may watch but not act (CLAUDE.md §12). Conceding or
  // timing out again is accepted and harmlessly idempotent, which keeps a
  // duplicate server timeout from turning into an error.
  if (seat.lost && validated.type !== 'concede' && validated.type !== 'server_timeout') {
    return err(
      engineError('engine/eliminated', 'You have been eliminated and can only spectate.', {
        playerId: validated.playerId,
      }),
    );
  }

  const ctx = createContext(state, context.database, config, { actionType: validated.type });
  ctx.state.stepsSinceInput = 0;
  ctx.state.recentFingerprints = [];

  const problem = dispatch(ctx, validated);
  if (problem) return err(problem);

  ctx.state.actionLog.push({
    index: ctx.state.actionLog.length,
    action: validated,
    sequenceAfter: ctx.state.sequence,
  });

  return ok({ state: ctx.state, events: ctx.events });
}

function dispatch(ctx: MatchContext, action: Action): EngineError | null {
  // Conceding and a server timeout are always legal, including while a
  // mandatory choice is pending (CLAUDE.md §9).
  if (action.type === 'concede') return handleTermination(ctx, action.playerId, 'concede');
  if (action.type === 'server_timeout') return handleTermination(ctx, action.playerId, 'timeout');

  if (ctx.state.pendingChoice !== null && action.type !== 'submit_choice') {
    return engineError(
      'engine/choice_pending',
      'A mandatory choice is pending; no other action is accepted until it is answered.',
      { choiceId: ctx.state.pendingChoice.id, playerId: ctx.state.pendingChoice.playerId },
    );
  }

  switch (action.type) {
    case 'mulligan':
      return handleMulligan(ctx, action.playerId, action.returnInstanceIds);
    case 'submit_choice':
      return handleSubmitChoice(ctx, action.playerId, action.choiceId, action.selectedIds);
    case 'play_card':
      return handlePlayCard(ctx, action.playerId, action.instanceId, action.slot);
    case 'activate_ability':
      return handleActivateAbility(ctx, action.playerId, action.sourceInstanceId, action.abilityId);
    case 'pass_phase':
      return handlePassPhase(ctx, action.playerId);
    case 'declare_attackers':
      return handleDeclareAttackers(ctx, action.playerId, action.attacks);
    case 'assign_blockers':
      return handleAssignBlockers(ctx, action.playerId, action.blocks);
    default:
      return engineError('engine/invalid_action', 'Unrecognised action.');
  }
}

function handleTermination(
  ctx: MatchContext,
  playerId: PlayerId,
  reason: 'concede' | 'timeout',
): EngineError | null {
  markLoss(ctx, playerId, reason);
  // Not just `concludeIfOver`: with three or more seats the match carries on, so
  // the loss still has to run the full check that performs elimination cleanup
  // and hands the turn to the next living player (CLAUDE.md §12).
  runStateBasedChecks(ctx);
  return null;
}

/* ------------------------------------------------------------------ mulligan */

function handleMulligan(
  ctx: MatchContext,
  playerId: PlayerId,
  returnInstanceIds: readonly InstanceId[],
): EngineError | null {
  if (ctx.state.status !== 'mulligan') {
    return engineError('engine/wrong_phase', 'Opening hands have already been settled.', {
      phase: ctx.state.phase,
    });
  }

  const player = playerOf(ctx.state, playerId);
  if (player.mulligan.status !== 'pending') {
    return engineError(
      'engine/mulligan_already_submitted',
      'This seat has already submitted its opening-hand decision.',
      { playerId },
    );
  }

  const unique = new Set(returnInstanceIds);
  if (unique.size !== returnInstanceIds.length) {
    return engineError('engine/invalid_selection', 'A card cannot be returned twice.', {
      playerId,
    });
  }
  for (const instanceId of returnInstanceIds) {
    if (!player.hand.includes(instanceId)) {
      return engineError(
        'engine/invalid_selection',
        'Only cards in your opening hand may be returned.',
        { playerId, instanceId },
      );
    }
  }
  if (returnInstanceIds.length > 0 && player.mulligan.redrawsUsed >= ctx.config.openingRedraws) {
    return engineError('engine/invalid_action', 'No free redraws remain.', {
      playerId,
      allowed: ctx.config.openingRedraws,
    });
  }

  player.mulligan = {
    status: 'submitted',
    returnedInstanceIds: [...returnInstanceIds],
    redrawsUsed: player.mulligan.redrawsUsed + (returnInstanceIds.length > 0 ? 1 : 0),
  };
  // Only the count is public: both players submit before either result is
  // revealed, so the hand itself stays hidden (CLAUDE.md §4).
  emit(ctx, {
    type: 'mulligan_submitted',
    playerId,
    returnedCount: returnInstanceIds.length,
  });

  const allSubmitted = ctx.state.playerOrder.every(
    (id) => playerOf(ctx.state, id).mulligan.status === 'submitted',
  );
  if (allSubmitted) {
    resolveMulligans(ctx);
    advance(ctx);
  }
  return null;
}

/* -------------------------------------------------------------------- choice */

function handleSubmitChoice(
  ctx: MatchContext,
  playerId: PlayerId,
  choiceId: string,
  selectedIds: readonly string[],
): EngineError | null {
  const choice = ctx.state.pendingChoice;
  if (!choice) {
    return engineError('engine/no_choice_pending', 'There is no choice awaiting an answer.');
  }
  if (choice.id !== choiceId) {
    return engineError('engine/unknown_choice', 'That choice is no longer the pending one.', {
      expected: choice.id,
      received: choiceId,
    });
  }
  if (choice.playerId !== playerId) {
    return engineError('engine/wrong_player', 'This choice belongs to the other player.', {
      expected: choice.playerId,
      received: playerId,
    });
  }

  const unique = new Set(selectedIds);
  if (unique.size !== selectedIds.length) {
    return engineError('engine/invalid_selection', 'The same option was selected twice.');
  }
  for (const id of selectedIds) {
    if (!choice.validEntityIds.includes(id)) {
      return engineError('engine/invalid_selection', 'That option is not legal for this choice.', {
        choiceId,
        entityId: id,
      });
    }
  }
  if (choice.ordered) {
    if (selectedIds.length !== choice.validEntityIds.length) {
      return engineError(
        'engine/invalid_selection',
        'An ordering must include every option exactly once.',
        { choiceId, expected: choice.validEntityIds.length, received: selectedIds.length },
      );
    }
  } else if (selectedIds.length < choice.minimum || selectedIds.length > choice.maximum) {
    return engineError(
      'engine/invalid_selection',
      `This choice needs between ${choice.minimum} and ${choice.maximum} selections.`,
      { choiceId, minimum: choice.minimum, maximum: choice.maximum, received: selectedIds.length },
    );
  }

  ctx.state.pendingChoice = null;
  ctx.state.status = 'playing';
  emit(ctx, { type: 'choice_resolved', choiceId, playerId, selectedIds: [...selectedIds] });

  const continuation = choice.continuation;
  if (continuation.kind === 'turn_end_discard') {
    for (const instanceId of selectedIds) discardCard(ctx, playerId, instanceId);
  } else {
    const item = ctx.state.queue.find((entry) => entry.id === continuation.itemId);
    if (item) {
      item.selections[continuation.selectionKey] = [...selectedIds];
    }
  }

  advance(ctx);
  return null;
}

/* ------------------------------------------------------------------ playing */

function requireMainPhase(ctx: MatchContext, playerId: PlayerId): EngineError | null {
  if (ctx.state.activePlayerId !== playerId) {
    return engineError('engine/wrong_player', 'It is not your turn.', {
      activePlayerId: ctx.state.activePlayerId,
    });
  }
  if (!MAIN_PHASES.includes(ctx.state.phase)) {
    return engineError(
      'engine/wrong_phase',
      'Cards and activated abilities may only be used during your Main Phases.',
      { phase: ctx.state.phase },
    );
  }
  if (ctx.state.queue.length > 0) {
    return engineError(
      'engine/wrong_phase',
      'The effect queue must be empty before another card is played.',
      { queued: ctx.state.queue.length },
    );
  }
  return null;
}

/**
 * A spell with no legal target for a required target selector cannot be played
 * at all (CLAUDE.md §4). Units and relics are not checked the same way: their
 * deploy effects simply fizzle, because the card itself still enters play.
 */
export function spellHasLegalTargets(
  ctx: MatchContext,
  definition: CardDefinition,
  instance: CardInstance,
): boolean {
  for (const effect of definition.effects) {
    if (!('target' in effect)) continue;
    const target = effect.target;

    if (target.kind === 'player' || target.kind === 'players') {
      // A player target needs at least one living recipient; in a free-for-all
      // that is normally true right up until the match ends.
      if (playerCandidates(ctx, target, instance.controller).length === 0) return false;
      continue;
    }
    if (target.kind === 'entity' && target.selector.optional) continue;

    const targets = legalTargets(ctx, target, {
      controllerId: instance.controller,
      sourceInstanceId: instance.instanceId,
    });
    if (targets.length === 0) return false;
  }
  return true;
}

function handlePlayCard(
  ctx: MatchContext,
  playerId: PlayerId,
  instanceId: InstanceId,
  slot: number | null,
): EngineError | null {
  const phaseProblem = requireMainPhase(ctx, playerId);
  if (phaseProblem) return phaseProblem;

  const player = playerOf(ctx.state, playerId);
  const instance = findInstance(ctx.state, instanceId);
  if (!instance) {
    return engineError('engine/unknown_instance', 'No such card in this match.', { instanceId });
  }
  if (!player.hand.includes(instanceId)) {
    return engineError('engine/wrong_zone', 'That card is not in your hand.', { instanceId });
  }

  const definition = definitionOf(ctx.database, instance);
  if (definition.type !== 'unit' && definition.type !== 'spell' && definition.type !== 'relic') {
    return engineError('engine/invalid_action', `A ${definition.type} cannot be played.`, {
      instanceId,
      cardType: definition.type,
    });
  }

  const cost = energyCostOf(player, definition);
  if (cost > player.energy) {
    return engineError(
      'engine/insufficient_energy',
      `"${definition.name}" costs ${cost} energy; you have ${player.energy}.`,
      { instanceId, cost, energy: player.energy },
    );
  }

  let targetSlot: number | null = null;
  if (definition.type === 'unit') {
    const free = freeUnitSlots(player);
    if (slot === null) {
      const first = free[0];
      if (first === undefined) {
        return engineError('engine/no_free_slot', 'You have no free unit slot.', {
          instanceId,
          slots: player.units.length,
        });
      }
      targetSlot = first;
    } else {
      if (slot >= player.units.length) {
        return engineError('engine/no_free_slot', 'That unit slot does not exist.', { slot });
      }
      if (!free.includes(slot)) {
        return engineError('engine/slot_occupied', 'That unit slot is already occupied.', { slot });
      }
      targetSlot = slot;
    }
  }

  if (definition.type === 'relic' && player.relics.length >= ctx.config.relicSlots) {
    return engineError(
      'engine/relic_limit',
      `You already control ${ctx.config.relicSlots} relics.`,
      { instanceId, limit: ctx.config.relicSlots },
    );
  }

  if (definition.type === 'spell' && !spellHasLegalTargets(ctx, definition, instance)) {
    return engineError(
      'engine/no_legal_target',
      `"${definition.name}" has no legal target and cannot be played.`,
      { instanceId },
    );
  }

  // ---- committed from here: everything above is validation only.
  const before = ctx.events.length;

  player.energy -= cost;
  emit(ctx, {
    type: 'card_played',
    playerId,
    instanceId,
    definitionId: definition.id,
    energySpent: cost,
  });

  if (definition.type === 'spell') {
    // The spell leaves the hand immediately but only reaches the discard once
    // its instructions have resolved, so it cannot target itself mid-resolution.
    const index = player.hand.indexOf(instanceId);
    if (index >= 0) player.hand.splice(index, 1);
    enqueue(ctx, {
      kind: 'card_effects',
      sourceInstanceId: instanceId,
      sourceDefinitionId: definition.id,
      controllerId: playerId,
      abilityId: null,
      effects: [...definition.effects],
      causeSequence: ctx.state.sequence,
      completesSpell: true,
    });
  } else if (definition.type === 'unit') {
    moveToZone(ctx, instanceId, 'battlefield', { slot: targetSlot ?? 0, silent: true });
    emit(ctx, {
      type: 'unit_deployed',
      playerId,
      instanceId,
      definitionId: definition.id,
      slot: targetSlot ?? 0,
    });
    if (definition.effects.length > 0) {
      enqueue(ctx, {
        kind: 'card_effects',
        sourceInstanceId: instanceId,
        sourceDefinitionId: definition.id,
        controllerId: playerId,
        abilityId: null,
        effects: [...definition.effects],
        causeSequence: ctx.state.sequence,
        completesSpell: false,
      });
    }
  } else {
    moveToZone(ctx, instanceId, 'battlefield', { silent: true });
    emit(ctx, { type: 'relic_deployed', playerId, instanceId, definitionId: definition.id });
    if (definition.effects.length > 0) {
      enqueue(ctx, {
        kind: 'card_effects',
        sourceInstanceId: instanceId,
        sourceDefinitionId: definition.id,
        controllerId: playerId,
        abilityId: null,
        effects: [...definition.effects],
        causeSequence: ctx.state.sequence,
        completesSpell: false,
      });
    }
  }

  // Deploy events are emitted here rather than by the queue, so trigger
  // discovery has to be run explicitly for them.
  settle(ctx, before);
  advance(ctx);
  return null;
}

function handleActivateAbility(
  ctx: MatchContext,
  playerId: PlayerId,
  sourceInstanceId: InstanceId,
  abilityId: string,
): EngineError | null {
  const phaseProblem = requireMainPhase(ctx, playerId);
  if (phaseProblem) return phaseProblem;

  const instance = findInstance(ctx.state, sourceInstanceId);
  if (!instance) {
    return engineError('engine/unknown_instance', 'No such card in this match.', {
      sourceInstanceId,
    });
  }
  if (instance.controller !== playerId) {
    return engineError('engine/not_your_card', 'You do not control that card.', {
      sourceInstanceId,
    });
  }
  if (instance.zone !== 'battlefield' && instance.zone !== 'commander_zone') {
    return engineError(
      'engine/wrong_zone',
      'Abilities may only be activated from the battlefield or the Commander zone.',
      { sourceInstanceId, zone: instance.zone },
    );
  }

  const definition = definitionOf(ctx.database, instance);
  const ability = definition.activatedAbilities.find((entry) => entry.id === abilityId);
  if (!ability) {
    return engineError('engine/invalid_action', 'That card has no such activated ability.', {
      sourceInstanceId,
      abilityId,
    });
  }

  const usedKey = `used:${abilityId}`;
  const turnKey = `usedTurn:${abilityId}`;
  const timesUsed = instance.counters[usedKey] ?? 0;
  const lastTurnUsed = instance.counters[turnKey];

  if (ability.usageLimit === 'once_per_match' && timesUsed > 0) {
    return engineError('engine/invalid_action', 'That ability may only be used once per match.', {
      abilityId,
    });
  }
  if (ability.usageLimit === 'once_per_turn' && lastTurnUsed === ctx.state.turn) {
    return engineError('engine/invalid_action', 'That ability has already been used this turn.', {
      abilityId,
    });
  }

  // Every cost is checked before any of it is paid, so a half-payable ability
  // never leaves the player short (CLAUDE.md §17 Q3).
  const payment = planCosts(ctx, playerId, instance, ability.costs);
  if ('code' in payment) return payment;

  // ---- committed: costs are paid atomically before the ability is queued.
  payCosts(ctx, playerId, instance, payment);
  instance.counters[usedKey] = timesUsed + 1;
  instance.counters[turnKey] = ctx.state.turn;

  enqueue(ctx, {
    kind: 'triggered_ability',
    sourceInstanceId,
    sourceDefinitionId: definition.id,
    controllerId: playerId,
    abilityId,
    effects: [...ability.effects],
    causeSequence: ctx.state.sequence,
    completesSpell: false,
  });

  advance(ctx);
  return null;
}

/* ------------------------------------------------------------ ability costs */

interface CostPlan {
  energy: number;
  exhaustSource: boolean;
  readonly discards: InstanceId[];
  readonly sacrifices: InstanceId[];
}

/**
 * Works out exactly what an activation would cost, or returns why it cannot be
 * paid. Nothing is spent here.
 *
 * Discards and sacrifices are chosen deterministically rather than by asking:
 * a cost is paid *before* the ability is queued, and the queue is the only
 * thing that can pause for a choice. Making a cost interactive means giving it
 * its own pending-choice state, which no bundled card needs yet.
 */
function planCosts(
  ctx: MatchContext,
  playerId: PlayerId,
  source: CardInstance,
  costs: readonly AbilityCost[],
): CostPlan | EngineError {
  const player = playerOf(ctx.state, playerId);
  const plan: CostPlan = { energy: 0, exhaustSource: false, discards: [], sacrifices: [] };

  for (const cost of costs) {
    switch (cost.type) {
      case 'energy': {
        const total = plan.energy + cost.amount;
        if (total > player.energy) {
          return engineError(
            'engine/insufficient_energy',
            `That ability costs ${total} energy; you have ${player.energy}.`,
            { cost: total, energy: player.energy },
          );
        }
        plan.energy = total;
        break;
      }

      case 'exhaust_source': {
        if (source.exhausted || plan.exhaustSource) {
          return engineError('engine/cost_unpayable', 'That card is already exhausted.', {
            sourceInstanceId: source.instanceId,
          });
        }
        plan.exhaustSource = true;
        break;
      }

      case 'discard': {
        const available = player.hand.filter((id) => !plan.discards.includes(id));
        if (available.length < cost.amount) {
          return engineError(
            'engine/cost_unpayable',
            `That ability costs ${cost.amount} discarded card(s); you have ${available.length}.`,
            { required: cost.amount, available: available.length },
          );
        }
        plan.discards.push(...available.slice(0, cost.amount));
        break;
      }

      case 'sacrifice': {
        const available = player.units
          .filter((id): id is InstanceId => id !== null && !plan.sacrifices.includes(id))
          .filter((id) => {
            if (!cost.filter) return true;
            const instance = findInstance(ctx.state, id);
            if (!instance) return false;
            return matchesCardFilter(definitionOf(ctx.database, instance), instance, cost.filter);
          });
        if (available.length < cost.amount) {
          return engineError(
            'engine/cost_unpayable',
            `That ability costs ${cost.amount} sacrificed unit(s); you have ${available.length}.`,
            { required: cost.amount, available: available.length },
          );
        }
        plan.sacrifices.push(...available.slice(0, cost.amount));
        break;
      }

      default: {
        const _never: never = cost;
        void _never;
        return engineError('engine/cost_unpayable', 'Unsupported activation cost.');
      }
    }
  }

  return plan;
}

/** Spends a validated plan. Only ever called once the plan is known payable. */
function payCosts(
  ctx: MatchContext,
  playerId: PlayerId,
  source: CardInstance,
  plan: CostPlan,
): void {
  if (plan.energy > 0) playerOf(ctx.state, playerId).energy -= plan.energy;
  if (plan.exhaustSource) {
    source.exhausted = true;
    emit(ctx, { type: 'unit_exhausted', instanceId: source.instanceId });
  }
  for (const instanceId of plan.discards) discardCard(ctx, playerId, instanceId);
  // A sacrifice paid as a cost is still a defeat: it fires `on_sacrifice` and
  // `on_defeated` exactly as the effect does (CLAUDE.md §17 Q3, Q24).
  for (const instanceId of plan.sacrifices) defeatUnit(ctx, instanceId, 'sacrifice');
}

function handlePassPhase(ctx: MatchContext, playerId: PlayerId): EngineError | null {
  if (ctx.state.activePlayerId !== playerId) {
    return engineError('engine/wrong_player', 'Only the active player passes a phase.', {
      activePlayerId: ctx.state.activePlayerId,
    });
  }
  if (ctx.state.phase === 'main_1') {
    setPhase(ctx, 'declare_attackers');
  } else if (ctx.state.phase === 'main_2') {
    setPhase(ctx, 'turn_end');
  } else {
    return engineError('engine/wrong_phase', 'There is nothing to pass in this phase.', {
      phase: ctx.state.phase,
    });
  }
  advance(ctx);
  return null;
}

/* -------------------------------------------------------------------- combat */

function handleDeclareAttackers(
  ctx: MatchContext,
  playerId: PlayerId,
  attacks: readonly AttackDeclaration[],
): EngineError | null {
  if (ctx.state.phase !== 'declare_attackers') {
    return engineError('engine/wrong_phase', 'Attackers are declared in the attack phase.', {
      phase: ctx.state.phase,
    });
  }
  if (ctx.state.activePlayerId !== playerId) {
    return engineError('engine/wrong_player', 'Only the active player declares attackers.');
  }

  const opponents = livingOpponents(ctx.state, playerId);
  const seen = new Set<InstanceId>();

  for (const attack of attacks) {
    if (seen.has(attack.attackerInstanceId)) {
      return engineError('engine/duplicate_attacker', 'A unit cannot attack twice.', {
        instanceId: attack.attackerInstanceId,
      });
    }
    seen.add(attack.attackerInstanceId);

    // Units attack players, never other units, and never a seat that is out
    // of the match (CLAUDE.md §12).
    if (!opponents.includes(attack.defenderPlayerId)) {
      return engineError(
        'engine/illegal_defender',
        'That is not a living opponent you can attack.',
        { defenderPlayerId: attack.defenderPlayerId },
      );
    }

    const problem = validateAttacker(ctx, playerId, attack.attackerInstanceId);
    if (problem) return problem;
  }

  // ---- committed
  ctx.state.combat.attacks = attacks.map((attack) => ({ ...attack }));
  for (const attack of attacks) {
    const instance = findInstance(ctx.state, attack.attackerInstanceId);
    if (!instance) continue;
    // Declared attackers exhaust immediately (CLAUDE.md §4).
    instance.exhausted = true;
    emit(ctx, { type: 'unit_exhausted', instanceId: attack.attackerInstanceId });
  }

  const before = ctx.events.length;
  emit(ctx, {
    type: 'attackers_declared',
    playerId,
    instanceIds: attacks.map((attack) => attack.attackerInstanceId),
    attacks: ctx.state.combat.attacks.map((attack) => ({ ...attack })),
  });
  // `on_attack` triggers are discovered now and resolve before blockers are
  // assigned, because `advance` pumps the queue before yielding to a player.
  settle(ctx, before);

  ctx.state.combat.awaitingDefenders = defendersOf(ctx);
  ctx.state.combat.submissions = [];

  // Skip blocker assignment entirely when nobody is being attacked (CLAUDE.md §4).
  setPhase(
    ctx,
    ctx.state.combat.awaitingDefenders.length === 0 ? 'resolve_combat' : 'assign_blockers',
  );
  advance(ctx);
  return null;
}

function validateAttacker(
  ctx: MatchContext,
  playerId: PlayerId,
  instanceId: InstanceId,
): EngineError | null {
  const instance = findInstance(ctx.state, instanceId);
  if (!instance) {
    return engineError('engine/unknown_instance', 'No such card in this match.', { instanceId });
  }
  if (instance.controller !== playerId || instance.zone !== 'battlefield') {
    return engineError('engine/illegal_attacker', 'That is not one of your units in play.', {
      instanceId,
    });
  }
  if (instance.slot === null) {
    return engineError('engine/illegal_attacker', 'Relics cannot attack.', { instanceId });
  }
  if (instance.exhausted) {
    return engineError('engine/illegal_attacker', 'An exhausted unit cannot attack.', {
      instanceId,
    });
  }
  const definition = definitionOf(ctx.database, instance);
  if (isSummoningSick(instance, ctx.state) && !hasKeyword(instance, definition, 'swift')) {
    return engineError(
      'engine/illegal_attacker',
      `"${definition.name}" entered play this turn and cannot attack.`,
      { instanceId },
    );
  }
  return null;
}

/**
 * One defender's blocker submission.
 *
 * A defender may only answer for attacks aimed at them, and may only block with
 * their own units — third-party blocking is not allowed (CLAUDE.md §12). The
 * submission is stored privately; nothing becomes public and no damage happens
 * until every attacked player has answered.
 */
function handleAssignBlockers(
  ctx: MatchContext,
  playerId: PlayerId,
  blocks: readonly {
    readonly attackerInstanceId: InstanceId;
    readonly blockerInstanceId: InstanceId;
  }[],
): EngineError | null {
  if (ctx.state.phase !== 'assign_blockers') {
    return engineError('engine/wrong_phase', 'Blockers are assigned in the block phase.', {
      phase: ctx.state.phase,
    });
  }
  if (!ctx.state.combat.awaitingDefenders.includes(playerId)) {
    return engineError(
      'engine/wrong_player',
      'Only a player who is being attacked assigns blockers, and only once.',
      { expected: ctx.state.combat.awaitingDefenders.join(', ') },
    );
  }

  const usedBlockers = new Set<InstanceId>();
  const perAttacker = new Map<InstanceId, number>();

  for (const block of blocks) {
    const attack = ctx.state.combat.attacks.find(
      (entry) => entry.attackerInstanceId === block.attackerInstanceId,
    );
    if (!attack) {
      return engineError('engine/illegal_blocker', 'That unit is not attacking.', {
        attackerInstanceId: block.attackerInstanceId,
      });
    }
    // The heart of "no third-party blocking": you may only interpose your own
    // units between an attacker and yourself.
    if (attack.defenderPlayerId !== playerId) {
      return engineError(
        'engine/illegal_blocker',
        'That attacker is not attacking you; you cannot block for another player.',
        { attackerInstanceId: block.attackerInstanceId, defenderPlayerId: attack.defenderPlayerId },
      );
    }
    if (usedBlockers.has(block.blockerInstanceId)) {
      return engineError('engine/duplicate_blocker', 'A unit can block at most one attacker.', {
        blockerInstanceId: block.blockerInstanceId,
      });
    }
    usedBlockers.add(block.blockerInstanceId);

    const count = (perAttacker.get(block.attackerInstanceId) ?? 0) + 1;
    perAttacker.set(block.attackerInstanceId, count);
    if (count > ctx.config.blockersPerAttacker) {
      return engineError(
        'engine/blocker_limit',
        `An attacker can receive at most ${ctx.config.blockersPerAttacker} blocker(s).`,
        { attackerInstanceId: block.attackerInstanceId, limit: ctx.config.blockersPerAttacker },
      );
    }

    const problem = validateBlocker(
      ctx,
      playerId,
      block.attackerInstanceId,
      block.blockerInstanceId,
    );
    if (problem) return problem;
  }

  // ---- committed
  ctx.state.combat.submissions.push({
    defenderPlayerId: playerId,
    blocks: blocks.map((block) => ({ ...block })),
  });
  ctx.state.combat.awaitingDefenders = ctx.state.combat.awaitingDefenders.filter(
    (id) => id !== playerId,
  );

  // Only the *count* is public until everyone has answered, so no defender can
  // see what another has committed to (CLAUDE.md §12).
  emit(ctx, {
    type: 'blockers_submitted',
    playerId,
    blockCount: blocks.length,
    awaitingPlayerIds: [...ctx.state.combat.awaitingDefenders],
  });

  advance(ctx);
  return null;
}

function validateBlocker(
  ctx: MatchContext,
  playerId: PlayerId,
  attackerInstanceId: InstanceId,
  blockerInstanceId: InstanceId,
): EngineError | null {
  const blocker = findInstance(ctx.state, blockerInstanceId);
  if (!blocker) {
    return engineError('engine/unknown_instance', 'No such card in this match.', {
      blockerInstanceId,
    });
  }
  if (blocker.controller !== playerId || blocker.zone !== 'battlefield' || blocker.slot === null) {
    return engineError('engine/illegal_blocker', 'That is not one of your units in play.', {
      blockerInstanceId,
    });
  }
  if (blocker.exhausted && !ctx.config.exhaustedUnitsMayBlock) {
    return engineError('engine/illegal_blocker', 'An exhausted unit cannot block.', {
      blockerInstanceId,
    });
  }

  const attacker = findInstance(ctx.state, attackerInstanceId);
  if (attacker) {
    const definition = definitionOf(ctx.database, attacker);
    if (hasKeyword(attacker, definition, 'evasive')) {
      return engineError(
        'engine/illegal_blocker',
        `"${definition.name}" is evasive and cannot be blocked.`,
        { attackerInstanceId },
      );
    }
  }
  return null;
}
