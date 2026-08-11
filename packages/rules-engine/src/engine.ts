import type { AbilityCost, CardDatabase, CardDefinition, ZoneId } from '@tcg/card-data';
import { err, ok, type Result } from '@tcg/shared';
import { defendersOf } from './combat.js';
import { DEFAULT_RULES_CONFIG, type RulesConfig } from './config.js';
import { createContext, emit, underCause, type MatchContext } from './context.js';
import { engineError, type EngineError } from './errors.js';
import {
  commanderDeployCost,
  definitionOf,
  energyCostOf,
  findInstance,
  hasKeyword,
  isNewlyDeployed,
  isSummoningSick,
  isUnitInPlay,
  livingOpponents,
  matchesCardFilter,
  playerOf,
} from './derive.js';
import { defeatUnit, nextChoiceId } from './effects.js';
import { advance, resolveMulligans, setPhase } from './flow.js';
import { handlePassReaction, handlePlayReaction, openReactionWindow } from './reactions.js';
import { settle } from './queue.js';
import { legalTargets, playerCandidates } from './targeting.js';
import { enqueue } from './triggers.js';
import { markLoss, runStateBasedChecks } from './state-based.js';
import { discardCard, moveToZone } from './zones.js';
import { actionSchema, type Action, type ActionInput } from './schema/action.js';
import type { Continuation, PendingChoice } from './schema/choice.js';
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
      return handlePlayCard(ctx, action.playerId, action.instanceId);
    case 'activate_ability':
      return handleActivateAbility(ctx, action.playerId, action.sourceInstanceId, action.abilityId);
    case 'pass_phase':
      return handlePassPhase(ctx, action.playerId);
    case 'declare_attackers':
      return handleDeclareAttackers(ctx, action.playerId, action.attacks);
    case 'assign_blockers':
      return handleAssignBlockers(ctx, action.playerId, action.blocks);
    case 'play_reaction': {
      const problem = handlePlayReaction(ctx, action.playerId, action.instanceId);
      if (problem) return problem;
      advance(ctx);
      return null;
    }
    case 'pass_reaction': {
      const problem = handlePassReaction(ctx, action.playerId);
      if (problem) return problem;
      advance(ctx);
      return null;
    }
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
  // (CLAUDE.md §12).
  runStateBasedChecks(ctx);
  // …and then the match has to keep moving. Whoever just left may have been the
  // active player, or the last defender a combat was waiting on; either way the
  // remaining seats must not be stranded on a turn that can no longer be taken.
  advance(ctx);
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
  } else if (continuation.kind === 'cost_selection') {
    // Nothing was spent when the question was asked, so this is not a resume —
    // it is the original action run again with one more answer in hand. Every
    // check it made the first time is made again, and a re-run that no longer
    // validates is rejected as an ordinary illegal action, taking the whole
    // clone with it (see `applyAction`). Advancing is the re-run's job, so this
    // path returns straight from it.
    const paid = { ...continuation.paid, [String(continuation.costIndex)]: [...selectedIds] };
    return continuation.intent.kind === 'play_card'
      ? handlePlayCard(ctx, playerId, continuation.intent.instanceId, paid)
      : handleActivateAbility(
          ctx,
          playerId,
          continuation.intent.instanceId,
          continuation.intent.abilityId,
          paid,
        );
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
    // "You may …" is not a required target. A step the controller can decline
    // outright cannot be the reason a card is unplayable, exactly as a selector
    // marked optional cannot.
    if (effect.optional) continue;
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
  paid: CostSelections = {},
): EngineError | null {
  const phaseProblem = requireMainPhase(ctx, playerId);
  if (phaseProblem) return phaseProblem;

  const player = playerOf(ctx.state, playerId);
  const instance = findInstance(ctx.state, instanceId);
  if (!instance) {
    return engineError('engine/unknown_instance', 'No such card in this match.', { instanceId });
  }

  const definition = definitionOf(ctx.database, instance);

  // A Commander is played out of its own zone rather than out of hand, and is
  // never drawn (rule adjustment §2). Everything after this point — cost,
  // deployment, Newly Deployed, triggers — is the same as for any other unit,
  // which is what "a deployed Commander behaves as a Unit" has to mean.
  if (definition.type === 'commander') {
    return handleDeployCommander(ctx, playerId, instance, definition);
  }

  if (!player.hand.includes(instanceId)) {
    return engineError('engine/wrong_zone', 'That card is not in your hand.', { instanceId });
  }

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

  // A unit is never refused for lack of room: the battlefield is unbounded, and
  // energy is the only intended constraint (ruleset update §7).

  // A relic at the limit is *replaced*, not refused (ruleset update §12), so the
  // only unplayable case left is a format that allows no relics at all.
  if (definition.type === 'relic' && ctx.config.relicSlots < 1) {
    return engineError('engine/relic_limit', 'Relics cannot be played in this format.', {
      instanceId,
      limit: ctx.config.relicSlots,
    });
  }

  if (definition.type === 'spell' && !spellHasLegalTargets(ctx, definition, instance)) {
    return engineError(
      'engine/no_legal_target',
      `"${definition.name}" has no legal target and cannot be played.`,
      { instanceId },
    );
  }

  // "As an additional cost, sacrifice a Unit." Planned here, with the rest of
  // the validation, so a card whose extra cost cannot be paid is refused before
  // a single point of Energy moves.
  const payment = planCosts(ctx, playerId, instance, definition.additionalCosts, paid);
  if ('code' in payment) return payment;
  if ('needsSelection' in payment) {
    return requestCostSelection(
      ctx,
      payment.needsSelection,
      { kind: 'play_card', instanceId },
      paid,
    );
  }

  // ---- committed from here: everything above is validation only.
  let before = ctx.events.length;

  player.energy -= cost;
  emit(ctx, {
    type: 'card_played',
    playerId,
    instanceId,
    definitionId: definition.id,
    energySpent: cost,
  });

  if (definition.additionalCosts.length > 0) {
    // Stamped with the card being played, so telemetry can attribute the
    // sacrifice to the card that demanded it rather than to nothing at all
    // (CLAUDE.md §13.6).
    underCause(ctx, { sourceInstanceId: instanceId }, () =>
      payCosts(ctx, playerId, instance, payment),
    );
    // An additional cost is paid *before* the card is queued (CLAUDE.md §4), so
    // whatever it triggers is discovered before the card's own effects join the
    // queue — "sacrifice a Unit" and a "whenever a Unit is sacrificed" trigger
    // must not resolve in the other order. Settling here rather than only at the
    // end is what puts them in that order, and the cursor moves with it so the
    // final settle does not rediscover the same events.
    settle(ctx, before);
    before = ctx.events.length;
    // Paying the cost can end the match — the sacrifice may have been the last
    // thing keeping somebody alive — and a completed match takes no more plays.
    if (ctx.state.status === 'complete') return null;
  }

  if (definition.type === 'spell') {
    // The spell leaves the hand immediately but only reaches the discard once
    // its instructions have resolved, so it cannot target itself mid-resolution.
    const index = player.hand.indexOf(instanceId);
    if (index >= 0) player.hand.splice(index, 1);

    // An opponent may answer it. When a window opens, the spell waits at the
    // bottom of that window's pending queue instead of being enqueued now —
    // that is what makes countering it possible, and what makes the answering
    // Reaction resolve first (rule adjustment §5.6).
    const answered = openReactionWindow(ctx, {
      windows: ['when_opponent_plays_spell'],
      resumePhase: ctx.state.phase,
      subject: { instanceId, definitionId: definition.id, controllerId: playerId },
    });
    if (!answered) {
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
    }
  } else if (definition.type === 'unit') {
    moveToZone(ctx, instanceId, 'battlefield', { row: 'units', silent: true, entry: 'suppress' });
    emit(ctx, {
      type: 'unit_deployed',
      playerId,
      instanceId,
      definitionId: definition.id,
    });
    emit(ctx, {
      type: 'unit_entered_battlefield',
      playerId,
      instanceId,
      definitionId: definition.id,
      method: 'deployed',
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
    replaceActiveRelics(ctx, playerId, instance, definition.id);
    moveToZone(ctx, instanceId, 'battlefield', { row: 'relics', silent: true, entry: 'suppress' });
    emit(ctx, { type: 'relic_deployed', playerId, instanceId, definitionId: definition.id });
    emit(ctx, {
      type: 'unit_entered_battlefield',
      playerId,
      instanceId,
      definitionId: definition.id,
      method: 'deployed',
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
  }

  // Deploy events are emitted here rather than by the queue, so trigger
  // discovery has to be run explicitly for them.
  settle(ctx, before);
  advance(ctx);
  return null;
}

/**
 * Deploys a Commander from its Command Zone (rule adjustment §2).
 *
 * The escalating cost is the whole mechanic: defeat sends the Commander home
 * rather than to a discard pile, and the only lasting consequence is that the
 * next deployment costs more. Nothing else about the card changes — once it is
 * on the battlefield it is a Unit for ready/exhaust, combat, targeting, damage
 * and activation costs, which is why this shares the deploy path rather than
 * inventing a parallel one.
 */
function handleDeployCommander(
  ctx: MatchContext,
  playerId: PlayerId,
  instance: CardInstance,
  definition: CardDefinition,
): EngineError | null {
  const player = playerOf(ctx.state, playerId);
  if (instance.instanceId !== player.commanderInstanceId) {
    return engineError('engine/not_your_card', 'That is not your Commander.', {
      instanceId: instance.instanceId,
    });
  }
  if (instance.zone !== 'commander_zone') {
    return engineError('engine/wrong_zone', 'Your Commander is not in the Command Zone.', {
      instanceId: instance.instanceId,
      zone: instance.zone,
    });
  }

  const cost = commanderDeployCost(player, definition, ctx.config);
  if (cost === null) {
    return engineError(
      'engine/commander_not_deployable',
      `"${definition.name}" has no printed cost and stays in the Command Zone.`,
      { instanceId: instance.instanceId },
    );
  }
  if (cost > player.energy) {
    return engineError(
      'engine/insufficient_energy',
      `Deploying "${definition.name}" costs ${cost} energy; you have ${player.energy}.`,
      { instanceId: instance.instanceId, cost, energy: player.energy },
    );
  }

  // ---- committed
  const before = ctx.events.length;
  player.energy -= cost;

  emit(ctx, {
    type: 'card_played',
    playerId,
    instanceId: instance.instanceId,
    definitionId: definition.id,
    energySpent: cost,
  });
  moveToZone(ctx, instance.instanceId, 'battlefield', {
    row: 'units',
    silent: true,
    entry: 'suppress',
  });
  emit(ctx, {
    type: 'commander_deployed',
    playerId,
    instanceId: instance.instanceId,
    definitionId: definition.id,
    energySpent: cost,
    defeatCount: player.commanderDefeats,
  });
  emit(ctx, {
    type: 'unit_deployed',
    playerId,
    instanceId: instance.instanceId,
    definitionId: definition.id,
  });
  emit(ctx, {
    type: 'unit_entered_battlefield',
    playerId,
    instanceId: instance.instanceId,
    definitionId: definition.id,
    method: 'deployed',
  });

  if (definition.effects.length > 0) {
    enqueue(ctx, {
      kind: 'card_effects',
      sourceInstanceId: instance.instanceId,
      sourceDefinitionId: definition.id,
      controllerId: playerId,
      abilityId: null,
      effects: [...definition.effects],
      causeSequence: ctx.state.sequence,
      completesSpell: false,
    });
  }

  settle(ctx, before);
  advance(ctx);
  return null;
}

/**
 * Makes room for a relic about to be played, by replacing the ones already out.
 *
 * Replacement is a **rules action** (ruleset update §12, ADR 0016 §3): the old
 * relic moves to its owner's discard, and that is all. It is not destruction and
 * not a sacrifice, so it fires neither `on_defeated` nor `on_sacrifice` — which
 * is exactly why the move is silent and the only event emitted is
 * `relic_replaced`.
 *
 * Written as a loop over "however many are one too many" rather than "the one",
 * so raising `relicSlots` above 1 stays a config change. The oldest goes first,
 * because `relics` is in arrival order and a player who has been at the limit
 * all game should not have their choice of relic silently reshuffled.
 */
function replaceActiveRelics(
  ctx: MatchContext,
  playerId: PlayerId,
  incoming: CardInstance,
  incomingDefinitionId: string,
): void {
  const player = playerOf(ctx.state, playerId);
  const surplus = player.relics.length - ctx.config.relicSlots + 1;
  if (surplus <= 0) return;

  for (const replacedId of player.relics.slice(0, surplus)) {
    const replaced = findInstance(ctx.state, replacedId);
    if (!replaced) continue;
    emit(ctx, {
      type: 'relic_replaced',
      playerId,
      instanceId: replacedId,
      definitionId: replaced.definitionId,
      replacedByInstanceId: incoming.instanceId,
      replacedByDefinitionId: incomingDefinitionId,
    });
    moveToZone(ctx, replacedId, 'discard', { silent: true });
  }
}

function handleActivateAbility(
  ctx: MatchContext,
  playerId: PlayerId,
  sourceInstanceId: InstanceId,
  abilityId: string,
  paid: CostSelections = {},
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
  const definition = definitionOf(ctx.database, instance);
  const ability = definition.activatedAbilities.find((entry) => entry.id === abilityId);
  if (!ability) {
    return engineError('engine/invalid_action', 'That card has no such activated ability.', {
      sourceInstanceId,
      abilityId,
    });
  }

  // The zone is the ability's own data, never inferred from where the card
  // happens to be or from what its rules text says (rule adjustment §3). A
  // Commander ability is battlefield-only unless its definition says
  // `commander_zone`, which is what makes deploying the Commander mean
  // something.
  if (instance.zone !== ability.activeZone) {
    return engineError(
      'engine/wrong_zone',
      `"${ability.name}" can only be activated from the ${ability.activeZone.replace('_', ' ')}.`,
      { sourceInstanceId, zone: instance.zone, requiredZone: ability.activeZone },
    );
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
  const payment = planCosts(ctx, playerId, instance, ability.costs, paid);
  if ('code' in payment) return payment;
  if ('needsSelection' in payment) {
    return requestCostSelection(
      ctx,
      payment.needsSelection,
      { kind: 'activate_ability', instanceId: sourceInstanceId, abilityId },
      paid,
    );
  }

  // ---- committed: costs are paid atomically before the ability is queued.
  // Same provenance stamp as a card's additional cost: what the ability ate is
  // part of what the ability did.
  underCause(ctx, { sourceInstanceId }, () => payCosts(ctx, playerId, instance, payment));
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

/** Answers already given for the interactive entries of one cost list. */
export type CostSelections = Readonly<Record<string, readonly InstanceId[]>>;

/**
 * One cost entry the payer still has to choose the victims for.
 *
 * Returned instead of a plan, so the caller can pause **before** committing.
 * Everything needed to build the pending choice is here; nothing is spent, and
 * no choice ordinal has been consumed yet.
 */
interface CostSelectionRequest {
  readonly costIndex: number;
  readonly chooserId: PlayerId;
  readonly reason: 'sacrifice_cost' | 'discard_cost';
  readonly zone: ZoneId;
  readonly candidates: readonly InstanceId[];
  readonly amount: number;
  readonly sourceInstanceId: InstanceId;
}

/**
 * Works out exactly what a card or activation would cost, or returns why it
 * cannot be paid, or asks who should die for it. Nothing is spent here.
 *
 * A cost is paid *before* anything is queued, and the resolution queue is the
 * only thing that can pause for a choice — so an interactive cost cannot be a
 * paused resolution. It is a paused **action** instead: this returns a
 * `CostSelectionRequest`, the caller stores the intent in the pending choice,
 * and answering re-runs the whole action with the answer supplied. That is what
 * keeps "costs are validated and paid atomically" true (CLAUDE.md §4) while
 * still letting a player pick which Unit they feed to the pit.
 *
 * Nobody is asked when there is only one legal answer: a cost with exactly as
 * many candidates as it needs is settled here, exactly as `automatic` is.
 */
function planCosts(
  ctx: MatchContext,
  playerId: PlayerId,
  source: CardInstance,
  costs: readonly AbilityCost[],
  chosen: CostSelections = {},
): CostPlan | EngineError | { readonly needsSelection: CostSelectionRequest } {
  const player = playerOf(ctx.state, playerId);
  const plan: CostPlan = { energy: 0, exhaustSource: false, discards: [], sacrifices: [] };

  for (const [costIndex, cost] of costs.entries()) {
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
        // A Newly Deployed card cannot pay an Exhaust cost unless it has Rush
        // (rule adjustment §4). This is the same restriction that stops it
        // attacking, and it was missing here: Rush was widened to cover
        // activation costs but nothing was checking them.
        if (isNewlyDeployed(source)) {
          const sourceDefinition = definitionOf(ctx.database, source);
          if (!hasKeyword(source, sourceDefinition, 'rush')) {
            return engineError(
              'engine/cost_unpayable',
              `"${sourceDefinition.name}" is Newly Deployed and cannot pay an Exhaust cost.`,
              { sourceInstanceId: source.instanceId },
            );
          }
        }
        plan.exhaustSource = true;
        break;
      }

      case 'discard': {
        const available = player.hand.filter((id) => !plan.discards.includes(id));
        if (available.length < cost.amount) {
          return engineError(
            'engine/cost_unpayable',
            `That costs ${cost.amount} discarded card(s); you have ${available.length}.`,
            { required: cost.amount, available: available.length },
          );
        }
        const picked = settleCostEntry(cost, costIndex, available, chosen);
        if ('code' in picked) return picked;
        if ('needsSelection' in picked) {
          return {
            needsSelection: {
              costIndex,
              chooserId: playerId,
              reason: 'discard_cost',
              zone: 'hand',
              candidates: available,
              amount: cost.amount,
              sourceInstanceId: source.instanceId,
            },
          };
        }
        plan.discards.push(...picked.ids);
        break;
      }

      case 'sacrifice': {
        const available = player.units
          .filter((id) => !plan.sacrifices.includes(id))
          // "Sacrifice **another** Unit": the card paying the cost is not one of
          // the candidates. A no-op for a Spell, which is in hand rather than on
          // the battlefield and was never in this list.
          .filter((id) => !(cost.excludeSource && id === source.instanceId))
          .filter((id) => {
            if (!cost.filter) return true;
            const instance = findInstance(ctx.state, id);
            if (!instance) return false;
            return matchesCardFilter(definitionOf(ctx.database, instance), instance, cost.filter);
          });
        if (available.length < cost.amount) {
          return engineError(
            'engine/cost_unpayable',
            `That costs ${cost.amount} sacrificed unit(s); you have ${available.length}.`,
            { required: cost.amount, available: available.length },
          );
        }
        const picked = settleCostEntry(cost, costIndex, available, chosen);
        if ('code' in picked) return picked;
        if ('needsSelection' in picked) {
          return {
            needsSelection: {
              costIndex,
              chooserId: playerId,
              reason: 'sacrifice_cost',
              zone: 'battlefield',
              candidates: available,
              amount: cost.amount,
              sourceInstanceId: source.instanceId,
            },
          };
        }
        plan.sacrifices.push(...picked.ids);
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

/**
 * Decides which candidates one cost entry consumes: the answer already given,
 * a question to ask, or a deterministic pick.
 *
 * Shared by the discard and sacrifice entries because the decision is the same
 * one — "which of these do you spend" — and only the zone differs. A stored
 * answer is re-validated against the candidate list computed a moment ago, not
 * against the one that existed when the question was asked: the re-run is a
 * fresh look at the board, and an answer that has stopped being legal must be
 * rejected rather than honoured.
 */
function settleCostEntry(
  cost: Extract<AbilityCost, { type: 'discard' | 'sacrifice' }>,
  costIndex: number,
  available: readonly InstanceId[],
  chosen: CostSelections,
): { readonly ids: InstanceId[] } | EngineError | { readonly needsSelection: true } {
  const answer = chosen[String(costIndex)];
  if (answer !== undefined) {
    if (answer.length !== cost.amount) {
      return engineError('engine/invalid_selection', `Choose exactly ${cost.amount} to pay this.`, {
        required: cost.amount,
        received: answer.length,
      });
    }
    for (const id of answer) {
      if (available.includes(id)) continue;
      return engineError('engine/invalid_selection', 'That card can no longer pay this cost.', {
        instanceId: id,
      });
    }
    return { ids: [...answer] };
  }

  // Only a genuine decision is worth a pause. With exactly as many candidates as
  // the cost needs there is one legal answer, so asking would be a pause in
  // place of a choice — the same rule the Reaction windows follow.
  if (cost.selection === 'player_choice' && available.length > cost.amount) {
    return { needsSelection: true };
  }
  return { ids: available.slice(0, cost.amount) };
}

/**
 * Pauses an action for a cost selection. Nothing has been spent at this point
 * and nothing is spent here: the choice carries the intent, and answering runs
 * the action again from the top.
 */
function requestCostSelection(
  ctx: MatchContext,
  request: CostSelectionRequest,
  intent: Extract<Continuation, { kind: 'cost_selection' }>['intent'],
  paid: CostSelections,
): null {
  const choice: PendingChoice = {
    id: nextChoiceId(ctx),
    playerId: request.chooserId,
    type: request.zone === 'battlefield' ? 'select_units' : 'select_cards',
    reason: request.reason,
    zone: request.zone,
    minimum: request.amount,
    maximum: request.amount,
    validEntityIds: [...request.candidates],
    ordered: false,
    sourceInstanceId: request.sourceInstanceId,
    continuation: {
      kind: 'cost_selection',
      intent,
      // Answers to the earlier entries of the same cost list ride along, so a
      // card with two interactive costs asks two questions rather than asking
      // the first one forever.
      paid: Object.fromEntries(Object.entries(paid).map(([key, ids]) => [key, [...ids]])),
      costIndex: request.costIndex,
    },
  };
  ctx.state.pendingChoice = choice;
  ctx.state.status = 'waiting_for_choice';
  emit(ctx, {
    type: 'choice_requested',
    choiceId: choice.id,
    playerId: choice.playerId,
    choiceType: choice.type,
    reason: choice.reason,
    minimum: choice.minimum,
    maximum: choice.maximum,
    validEntityIds: [...choice.validEntityIds],
  });
  return null;
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
  const next =
    ctx.state.combat.awaitingDefenders.length === 0 ? 'resolve_combat' : 'assign_blockers';

  // "Play after attackers are declared" and "play before blockers are declared"
  // name the same moment in the phase machine, so they share one window rather
  // than two consecutive ones that nothing could tell apart.
  const opened = openReactionWindow(ctx, {
    windows: ['after_attackers_declared', 'before_blockers_declared'],
    resumePhase: next,
  });
  if (!opened) setPhase(ctx, next);

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
  if (!isUnitInPlay(ctx.state, instance)) {
    return engineError('engine/illegal_attacker', 'Relics cannot attack.', { instanceId });
  }
  if (instance.exhausted) {
    return engineError('engine/illegal_attacker', 'An exhausted unit cannot attack.', {
      instanceId,
    });
  }
  const definition = definitionOf(ctx.database, instance);
  if (isSummoningSick(instance, ctx.state) && !hasKeyword(instance, definition, 'rush')) {
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
/**
 * Enforces the Guardian must-block rule for one defender's submission.
 *
 * The obligation is expressed as a *count*, not as a per-attacker requirement:
 * `min(ready Guardians, attackers aimed at this defender)` attacks must be
 * blocked, and any legal blocker may satisfy any of them. That is what keeps
 * "the defender chooses which Guardian blocks it" true while still making
 * Guardian compulsory. Evasive attackers are excluded because no Guardian could
 * legally block them in the first place.
 */
function validateGuardianObligation(
  ctx: MatchContext,
  playerId: PlayerId,
  blocks: readonly { readonly attackerInstanceId: InstanceId }[],
): EngineError | null {
  const player = playerOf(ctx.state, playerId);

  const readyGuardians = player.units.filter((id) => {
    const instance = findInstance(ctx.state, id);
    if (!instance || instance.exhausted) return false;
    return hasKeyword(instance, definitionOf(ctx.database, instance), 'guardian');
  });
  if (readyGuardians.length === 0) return null;

  const blockableAttackers = ctx.state.combat.attacks
    .filter((attack) => attack.defenderPlayerId === playerId)
    .map((attack) => attack.attackerInstanceId)
    .filter((instanceId) => {
      const instance = findInstance(ctx.state, instanceId);
      if (!instance) return false;
      return !hasKeyword(instance, definitionOf(ctx.database, instance), 'evasive');
    });

  const required = Math.min(readyGuardians.length, blockableAttackers.length);
  const blocked = new Set(
    blocks
      .map((block) => block.attackerInstanceId)
      .filter((instanceId) => blockableAttackers.includes(instanceId)),
  );

  if (blocked.size >= required) return null;

  return engineError(
    'engine/guardian_must_block',
    `You control ${readyGuardians.length} ready Guardian(s), so at least ${required} attacker(s) must be blocked; you blocked ${blocked.size}.`,
    { required, blocked: blocked.size, guardians: readyGuardians.length },
  );
}

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

  // Guardian: a ready Guardian may not stand by while an attacker goes
  // unblocked. Each Guardian can only cover one attack, so the obligation is
  // capped by whichever there are fewer of; which Guardian blocks which
  // attacker stays the defender's choice (ruleset update §9).
  const guardianProblem = validateGuardianObligation(ctx, playerId, blocks);
  if (guardianProblem) return guardianProblem;

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
  if (blocker.controller !== playerId || !isUnitInPlay(ctx.state, blocker)) {
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
