import type { CardDefinition, ReactionWindow } from '@tcg/card-data';
import { emit, type MatchContext } from './context.js';
import { staticAbilityActive } from './continuous.js';
import { playCostOf } from './costs.js';
import { engineError, type EngineError } from './errors.js';
import {
  activeFirstOrder,
  definitionOf,
  findInstance,
  isAlive,
  matchesCardFilter,
  playerOf,
} from './derive.js';
import { enqueue } from './triggers.js';
import { moveToZone } from './zones.js';
import type { InstanceId, MatchPhase, PlayerId } from './schema/primitives.js';
import type { CardInstance, PendingReaction, ReactionWindowState } from './schema/state.js';

/**
 * Bounded Reaction windows (rule adjustment §5).
 *
 * This is deliberately **not** a priority system and **not** a stack. A window
 * opens around one named event, each eligible player may answer it at most once,
 * and the window closes the moment everybody has passed consecutively. The only
 * thing that resolves out of order is the window's own pending queue, which
 * drains last-in-first-out so a counter played on top of a Spell resolves before
 * the Spell it is answering.
 *
 * Two structural decisions carry most of the weight:
 *
 *  1. **A window only opens when somebody could actually use it.** Eligibility
 *     is a pure function of state — whose turn it is, who holds what, what they
 *     can pay — so this stays deterministic and replayable. It is also what
 *     keeps a match with no Reaction cards in it running the exact phase machine
 *     it ran before Reactions existed.
 *  2. **Closing and resolving are separate states.** The window survives its own
 *     priority round, because a counter has to be able to name what is still
 *     waiting below it in the queue.
 */

/** What a window is about, when it is about a card. */
export interface ReactionSubject {
  readonly instanceId: InstanceId;
  readonly definitionId: string;
  readonly controllerId: PlayerId;
}

export interface ReactionOpening {
  /** Every window label this opening admits. */
  readonly windows: readonly ReactionWindow[];
  /** The phase to return to once the window has closed and resolved. */
  readonly resumePhase: MatchPhase;
  /**
   * The card the window is about. It joins the pending queue at the bottom, so
   * it resolves last and can be countered by anything played above it.
   */
  readonly subject?: ReactionSubject | null;
}

/* ----------------------------------------------------------------- eligibility */

/**
 * The per-turn Reaction discount available to this player right now
 * (rule adjustment §6).
 *
 * Read at the moment a cost is computed rather than accumulated into a modifier
 * list, because the question is "is this the first Reaction since your turn
 * began?" — which is a fact about the player's turn cycle, not about any card.
 */
function reactionDiscountFor(
  ctx: MatchContext,
  playerId: PlayerId,
  definition: CardDefinition,
): { amount: number; minimum: number } {
  const player = playerOf(ctx.state, playerId);
  let amount = 0;
  let minimum = 0;

  const sources = [...player.units, ...player.relics, player.commanderInstanceId];
  for (const instanceId of sources) {
    const instance = findInstance(ctx.state, instanceId);
    if (!instance) continue;
    const source = ctx.database.get(instance.definitionId);
    if (!source) continue;
    for (const ability of source.staticAbilities) {
      if (ability.effect.type !== 'reaction_discount') continue;
      if (!staticAbilityActive(instance, ability)) continue;
      if (ability.effect.limit === 'first_each_turn' && player.reactionDiscountSpent) continue;
      if (ability.affects.filter) {
        if (!matchesCardFilter(definition, null, ability.affects.filter)) continue;
      }
      amount += ability.effect.amount;
      minimum = Math.max(minimum, ability.effect.minimum);
    }
  }
  return { amount, minimum };
}

export interface ReactionCost {
  readonly cost: number;
  /** How much of the printed cost the per-turn discount actually paid for. */
  readonly discount: number;
  /** Whether paying it would consume the once-per-turn-cycle discount. */
  readonly consumesDiscount: boolean;
}

/**
 * What playing this Reaction costs its controller right now.
 *
 * The floor is the discounting effect's own printed minimum, clamped so it can
 * never raise a cost that was already below it — "costs 1 less, to a minimum of
 * 1" must not make a free Reaction cost 1.
 *
 * The base is the ordinary play cost, not the printed one, so a Reaction
 * carrying a `cost_reduction` static ability is discounted the same way in a
 * window as it would be in a Main Phase (M02.3). The two reductions apply in
 * sequence — the derived one first, then the per-turn Reaction discount — and
 * each respects its own printed floor. No authored card carries both, so the
 * ordering is currently unobservable; it is pinned here rather than left to
 * whichever call site ran first.
 */
export function reactionCostOf(
  ctx: MatchContext,
  playerId: PlayerId,
  instance: CardInstance,
): ReactionCost {
  const definition = definitionOf(ctx.database, instance);
  const base = playCostOf(ctx, playerId, instance, definition);
  const { amount, minimum } = reactionDiscountFor(ctx, playerId, definition);
  if (amount === 0) return { cost: base, discount: 0, consumesDiscount: false };

  const floor = Math.max(minimum, ctx.config.costReductionFloor);
  const cost = Math.max(0, Math.min(floor, base), base - amount);
  const discount = base - cost;
  return { cost, discount, consumesDiscount: discount > 0 };
}

/**
 * Whether this Reaction's printed timing admits the open window.
 *
 * `subjectFilter` is matched against the card the window is about — the Spell an
 * opponent played. A Reaction that filters its subject and finds no subject at
 * all is not playable: "Play when an opponent plays a Spell costing 2 or less"
 * has nothing to say about a combat window.
 */
function timingAdmits(
  ctx: MatchContext,
  definition: CardDefinition,
  window: ReactionWindowState,
): boolean {
  const timing = definition.reaction;
  if (!timing) return false;
  if (!timing.windows.some((name) => window.windows.includes(name))) return false;
  if (!timing.subjectFilter) return true;

  const subject = window.pending.find((entry) => entry.isSubject);
  if (!subject) return false;
  const subjectDefinition = ctx.database.get(subject.definitionId);
  if (!subjectDefinition) return false;
  const instance = findInstance(ctx.state, subject.instanceId) ?? null;
  return matchesCardFilter(subjectDefinition, instance, timing.subjectFilter);
}

/**
 * Reactions this player could legally play into the open window.
 *
 * Also used to decide whether opening a window is worth doing at all, which is
 * why it takes the window state rather than reading `ctx.state.reactionWindow`:
 * the prospective window does not exist yet at that point.
 */
export function playableReactions(
  ctx: MatchContext,
  playerId: PlayerId,
  window: ReactionWindowState,
): { instanceId: InstanceId; definitionId: string; energyCost: number }[] {
  if (!ctx.config.reactionsEnabled) return [];
  if (!isAlive(ctx.state, playerId)) return [];

  const plays = window.playsByPlayer[playerId] ?? 0;
  if (plays >= ctx.config.reactionsPerPlayerPerWindow) return [];

  const player = playerOf(ctx.state, playerId);
  const playable: { instanceId: InstanceId; definitionId: string; energyCost: number }[] = [];

  for (const instanceId of player.hand) {
    const instance = findInstance(ctx.state, instanceId);
    if (!instance) continue;
    const definition = definitionOf(ctx.database, instance);
    if (definition.type !== 'reaction') continue;
    if (!timingAdmits(ctx, definition, window)) continue;

    const { cost } = reactionCostOf(ctx, playerId, instance);
    if (cost > player.energy) continue;
    playable.push({ instanceId, definitionId: definition.id, energyCost: cost });
  }
  return playable;
}

/** Whether this player still holds priority they could actually use. */
function canAct(ctx: MatchContext, playerId: PlayerId, window: ReactionWindowState): boolean {
  if (window.passedPlayerIds.includes(playerId)) return false;
  return playableReactions(ctx, playerId, window).length > 0;
}

/* --------------------------------------------------------------- opening a window */

function draftWindow(ctx: MatchContext, opening: ReactionOpening): ReactionWindowState {
  const pending: PendingReaction[] = [];
  if (opening.subject) {
    pending.push({
      instanceId: opening.subject.instanceId,
      definitionId: opening.subject.definitionId,
      controllerId: opening.subject.controllerId,
      countered: false,
      counteredByInstanceId: null,
      isSubject: true,
    });
  }
  return {
    id: `rw_${String(ctx.state.nextReactionWindowOrdinal).padStart(4, '0')}`,
    windows: [...opening.windows],
    triggerSequence: ctx.state.sequence,
    // Active player first, then clockwise (rule adjustment §5.3). This
    // deliberately supersedes the earlier provisional "non-active player first".
    priorityOrder: activeFirstOrder(ctx.state),
    priorityIndex: 0,
    playsByPlayer: {},
    passedPlayerIds: [],
    pending,
    closed: false,
    resumePhase: opening.resumePhase,
  };
}

/**
 * Opens a Reaction window, if anybody could use one.
 *
 * Returns false when no window was opened, in which case the caller carries on
 * exactly as it did before Reactions existed — including enqueueing the subject
 * Spell itself, which this function deliberately does not touch.
 */
export function openReactionWindow(ctx: MatchContext, opening: ReactionOpening): boolean {
  if (!ctx.config.reactionsEnabled) return false;
  if (ctx.state.status === 'complete') return false;
  if (ctx.state.reactionWindow !== null) return false;

  const draft = draftWindow(ctx, opening);
  const anyone = draft.priorityOrder.some((playerId) => canAct(ctx, playerId, draft));
  if (!anyone) return false;

  ctx.state.nextReactionWindowOrdinal += 1;
  ctx.state.reactionWindow = draft;
  const from = ctx.state.phase;
  ctx.state.phase = 'reaction_window';
  emit(ctx, { type: 'phase_changed', from, to: 'reaction_window' });
  emit(ctx, {
    type: 'reaction_window_opened',
    windowId: draft.id,
    windows: [...draft.windows],
    priorityOrder: [...draft.priorityOrder],
    subjectInstanceId: opening.subject?.instanceId ?? null,
  });

  advancePriority(ctx);
  return true;
}

/* ------------------------------------------------------------------ priority */

/**
 * Moves priority to the next player who could use it, or closes the window.
 *
 * Termination is structural rather than a guard: every play permanently removes
 * its player from eligibility (one Reaction per player per window), and between
 * plays each player may pass at most once, so the number of steps is bounded by
 * seats × (plays + 1).
 */
function advancePriority(ctx: MatchContext): void {
  const window = ctx.state.reactionWindow;
  if (!window || window.closed) return;

  const order = window.priorityOrder;
  for (let step = 0; step < order.length; step += 1) {
    const index = (window.priorityIndex + step) % order.length;
    const playerId = order[index];
    if (playerId === undefined) continue;
    if (!canAct(ctx, playerId, window)) continue;
    window.priorityIndex = index;
    return;
  }
  closeWindow(ctx);
}

/** Everybody has passed consecutively: stop offering priority and start resolving. */
function closeWindow(ctx: MatchContext): void {
  const window = ctx.state.reactionWindow;
  if (!window || window.closed) return;
  window.closed = true;
  emit(ctx, {
    type: 'reaction_window_closed',
    windowId: window.id,
    // The order they will actually resolve in: last in, first out.
    resolutionOrder: [...window.pending].reverse().map((entry) => entry.instanceId),
  });
}

/** The seat the match is waiting on inside an open window, if any. */
export function reactionPriorityHolder(ctx: MatchContext): PlayerId | null {
  const window = ctx.state.reactionWindow;
  if (!window || window.closed) return null;
  return window.priorityOrder[window.priorityIndex] ?? null;
}

/* ------------------------------------------------------------------- actions */

export function handlePassReaction(ctx: MatchContext, playerId: PlayerId): EngineError | null {
  const window = ctx.state.reactionWindow;
  if (!window || window.closed) {
    return engineError('engine/no_reaction_window', 'No Reaction window is open.');
  }
  const holder = window.priorityOrder[window.priorityIndex];
  if (holder !== playerId) {
    return engineError('engine/wrong_player', 'You do not hold priority in this window.', {
      expected: holder ?? '',
    });
  }

  window.passedPlayerIds.push(playerId);
  emit(ctx, { type: 'reaction_passed', windowId: window.id, playerId });
  window.priorityIndex = (window.priorityIndex + 1) % window.priorityOrder.length;
  advancePriority(ctx);
  return null;
}

export function handlePlayReaction(
  ctx: MatchContext,
  playerId: PlayerId,
  instanceId: InstanceId,
): EngineError | null {
  const window = ctx.state.reactionWindow;
  if (!window || window.closed) {
    return engineError('engine/no_reaction_window', 'No Reaction window is open.');
  }
  const holder = window.priorityOrder[window.priorityIndex];
  if (holder !== playerId) {
    return engineError('engine/wrong_player', 'You do not hold priority in this window.', {
      expected: holder ?? '',
    });
  }
  // The one-per-player limit is validated per window, so priority returning to a
  // player who has already acted still refuses them (rule adjustment §5).
  if ((window.playsByPlayer[playerId] ?? 0) >= ctx.config.reactionsPerPlayerPerWindow) {
    return engineError(
      'engine/reaction_limit',
      `You may play at most ${ctx.config.reactionsPerPlayerPerWindow} Reaction per window.`,
      { windowId: window.id },
    );
  }

  const offered = playableReactions(ctx, playerId, window).find(
    (entry) => entry.instanceId === instanceId,
  );
  if (!offered) {
    return engineError(
      'engine/illegal_reaction',
      'That card cannot be played into this Reaction window.',
      { instanceId, windowId: window.id },
    );
  }

  const instance = findInstance(ctx.state, instanceId);
  if (!instance) {
    return engineError('engine/unknown_instance', 'No such card in this match.', { instanceId });
  }
  const definition = definitionOf(ctx.database, instance);
  const { cost, discount, consumesDiscount } = reactionCostOf(ctx, playerId, instance);

  // ---- committed
  const player = playerOf(ctx.state, playerId);
  player.energy -= cost;
  if (consumesDiscount) player.reactionDiscountSpent = true;

  const handIndex = player.hand.indexOf(instanceId);
  if (handIndex >= 0) player.hand.splice(handIndex, 1);

  window.playsByPlayer[playerId] = (window.playsByPlayer[playerId] ?? 0) + 1;
  // A play restarts the round: everyone who had declined gets to answer the new
  // card, which is what lets a counter be countered.
  window.passedPlayerIds = [];
  window.pending.push({
    instanceId,
    definitionId: definition.id,
    controllerId: playerId,
    countered: false,
    counteredByInstanceId: null,
    isSubject: false,
  });

  emit(ctx, {
    type: 'card_played',
    playerId,
    instanceId,
    definitionId: definition.id,
    energySpent: cost,
  });
  emit(ctx, {
    type: 'reaction_played',
    windowId: window.id,
    playerId,
    instanceId,
    definitionId: definition.id,
    energySpent: cost,
    discountApplied: discount,
  });

  window.priorityIndex = (window.priorityIndex + 1) % window.priorityOrder.length;
  advancePriority(ctx);
  return null;
}

/* ---------------------------------------------------------------- resolution */

/**
 * The entry a counter resolving right now would hit: the next one still waiting
 * below it (rule adjustment §5.5).
 *
 * By the time a counter resolves, everything played above it has already
 * resolved and been removed, so "the top of what is left" is precisely the card
 * it was played in answer to — which may be the original Spell or another
 * Reaction Spell.
 */
export function counterTarget(ctx: MatchContext): PendingReaction | null {
  const window = ctx.state.reactionWindow;
  if (!window) return null;
  for (let index = window.pending.length - 1; index >= 0; index -= 1) {
    const entry = window.pending[index];
    if (entry && !entry.countered) return entry;
  }
  return null;
}

/**
 * Resolves the next pending card, or ends the window when none is left.
 *
 * Returns true when it did something, so the phase machine can keep pumping.
 * Only ever called with an empty resolution queue: a card's own instructions
 * finish before the next one begins, exactly as they do outside a window.
 */
export function resumeReactionWindow(ctx: MatchContext): boolean {
  const window = ctx.state.reactionWindow;
  if (!window || !window.closed) return false;

  const entry = window.pending.pop();
  if (entry === undefined) {
    ctx.state.reactionWindow = null;
    const from = ctx.state.phase;
    ctx.state.phase = window.resumePhase;
    if (from !== window.resumePhase) {
      emit(ctx, { type: 'phase_changed', from, to: window.resumePhase });
    }
    return true;
  }

  const instance = findInstance(ctx.state, entry.instanceId);
  if (!instance) return true;

  if (entry.countered) {
    // A countered card has no effect and moves to its owner's discard. It never
    // reaches the battlefield, and its instructions are never enqueued — which
    // is why this is a move rather than a resolution that does nothing.
    emit(ctx, {
      type: 'card_countered',
      instanceId: entry.instanceId,
      definitionId: entry.definitionId,
      playerId: instance.owner,
      counteredByInstanceId: entry.counteredByInstanceId,
    });
    moveToZone(ctx, entry.instanceId, 'discard', { silent: true });
    return true;
  }

  const definition = definitionOf(ctx.database, instance);
  enqueue(ctx, {
    kind: 'card_effects',
    sourceInstanceId: entry.instanceId,
    sourceDefinitionId: definition.id,
    controllerId: entry.controllerId,
    abilityId: null,
    effects: [...definition.effects],
    causeSequence: ctx.state.sequence,
    completesSpell: true,
  });
  return true;
}

/**
 * Drops an eliminated player out of an open window.
 *
 * Their pending Reactions go with them — a card owned by an eliminated player is
 * removed from every zone (CLAUDE.md §12) — and priority moves on rather than
 * stalling on a seat that can no longer answer.
 */
export function removeFromReactionWindow(ctx: MatchContext, playerId: PlayerId): void {
  const window = ctx.state.reactionWindow;
  if (!window) return;

  window.pending = window.pending.filter((entry) => entry.controllerId !== playerId);
  window.priorityOrder = window.priorityOrder.filter((id) => id !== playerId);
  window.passedPlayerIds = window.passedPlayerIds.filter((id) => id !== playerId);

  if (window.priorityOrder.length === 0) {
    ctx.state.reactionWindow = null;
    ctx.state.phase = window.resumePhase;
    return;
  }
  if (window.priorityIndex >= window.priorityOrder.length) window.priorityIndex = 0;
  if (!window.closed) advancePriority(ctx);
}
