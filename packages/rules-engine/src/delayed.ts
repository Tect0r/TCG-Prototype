import type { CardId, DelayedAbilityDefinition, DelayedBoundary, TriggerId } from '@tcg/card-data';
import { emit, type MatchContext } from './context.js';
import { findInstance } from './derive.js';
import { enqueue } from './triggers.js';
import { evaluateCondition } from './values.js';
import type { GameEvent } from './schema/event.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';
import type { DelayedEffect } from './schema/state.js';

/**
 * Delayed effects (M02.1).
 *
 * "Return it to your hand **at the end of the turn**" and "**when it is
 * defeated this turn**, create two Thrall Tokens" are the same piece of
 * bookkeeping seen from two angles: a bounded promise, made when an instruction
 * resolved, that something will happen later in the same turn. One entry shape
 * covers both, and the only difference between them is whether the entry names
 * an event to wait for.
 *
 * Four rules hold the whole thing together, and none of them is keyed to a card
 * ID:
 *
 *  1. **The boundary is explicit and always the turn it was made in.** Nothing
 *     survives into a turn that belongs to somebody else, which is what stops a
 *     free-for-all accumulating promises from three seats ago.
 *  2. **The subject is bound once.** Whatever "it" meant when the instruction
 *     resolved is what the entry stores, as a concrete instance. It is never
 *     re-chosen and never re-targeted.
 *  3. **A subject that changes zone ends the entry.** This engine already treats
 *     a card leaving a zone as shedding what it was — `moveToZone` clears its
 *     damage, its modifiers and its counters — so a card that has moved is no
 *     longer the object the delayed text was about.
 *  4. **A watch fires from the event, not from the board afterwards.** The
 *     defeat a `marked_for_death` waits for *is* the zone change rule 3 would
 *     otherwise cancel it on, so the events of a settle pass are matched before
 *     the pass prunes anything. Firing beats pruning, always.
 *
 * A replay re-derives every entry from the same action log, because scheduling
 * happens inside ordinary instruction resolution and firing happens at
 * boundaries the phase machine already drives. Nothing here reads a clock, and
 * nothing here is decided by the client.
 */

/** Effects a delayed entry appends to the queue when it fires. */
export interface ScheduleInput {
  readonly ability: DelayedAbilityDefinition;
  readonly sourceInstanceId: InstanceId | null;
  readonly sourceDefinitionId: CardId;
  readonly controllerId: PlayerId;
  /** Already-resolved instance the delayed text calls "it", if it names one. */
  readonly subjectInstanceId: InstanceId | null;
}

function nextDelayedId(ctx: MatchContext): string {
  const id = `delayed_${String(ctx.state.nextDelayedOrdinal).padStart(4, '0')}`;
  ctx.state.nextDelayedOrdinal += 1;
  return id;
}

/**
 * Registers one delayed effect and reports it.
 *
 * The instructions are copied onto the entry rather than looked up from the card
 * when it fires: by then the source is usually somewhere else, and a delayed
 * effect that could be silently changed by a card-data edit mid-match would not
 * be replayable.
 */
export function scheduleDelayed(ctx: MatchContext, input: ScheduleInput): DelayedEffect {
  const subject = input.subjectInstanceId
    ? findInstance(ctx.state, input.subjectInstanceId)
    : undefined;

  const entry: DelayedEffect = {
    id: nextDelayedId(ctx),
    sourceInstanceId: input.sourceInstanceId,
    sourceDefinitionId: input.sourceDefinitionId,
    abilityId: input.ability.id,
    controllerId: input.controllerId,
    subjectInstanceId: subject?.instanceId ?? null,
    subjectZone: subject?.zone ?? null,
    boundary: input.ability.boundary,
    trigger: input.ability.trigger ?? null,
    condition: input.ability.condition ?? null,
    effects: [...input.ability.effects],
    createdOnTurn: ctx.state.turn,
    causeSequence: ctx.state.sequence,
  };

  ctx.state.delayedEffects.push(entry);
  emit(ctx, {
    type: 'delayed_effect_scheduled',
    delayedId: entry.id,
    sourceInstanceId: entry.sourceInstanceId,
    definitionId: entry.sourceDefinitionId,
    controllerId: entry.controllerId,
    abilityId: entry.abilityId,
    subjectInstanceId: entry.subjectInstanceId,
    boundary: entry.boundary,
    triggerId: entry.trigger,
  });
  return entry;
}

/** Removes an entry from the live list. Returns false when it had already gone. */
function take(ctx: MatchContext, entry: DelayedEffect): boolean {
  const index = ctx.state.delayedEffects.indexOf(entry);
  if (index < 0) return false;
  ctx.state.delayedEffects.splice(index, 1);
  return true;
}

function expire(
  ctx: MatchContext,
  entry: DelayedEffect,
  reason: 'boundary_passed' | 'subject_moved' | 'controller_eliminated',
): void {
  if (!take(ctx, entry)) return;
  emit(ctx, {
    type: 'delayed_effect_expired',
    delayedId: entry.id,
    definitionId: entry.sourceDefinitionId,
    controllerId: entry.controllerId,
    abilityId: entry.abilityId,
    reason,
  });
}

/**
 * Queues a delayed effect's instructions.
 *
 * Appended to the same FIFO queue as everything else, with the bound subject as
 * the resolution item's `triggerSubjectInstanceId` — so a delayed instruction
 * points at "it" through the ordinary `trigger_subject` target and needs no
 * targeting vocabulary of its own.
 *
 * The entry's condition is re-checked here rather than when it was scheduled,
 * for the same reason an ability's is: a gate that was true when the promise was
 * made and false when it comes due must not fire.
 */
function fire(ctx: MatchContext, entry: DelayedEffect): void {
  if (!take(ctx, entry)) return;

  if (
    entry.condition &&
    !evaluateCondition(ctx, entry.condition, {
      controllerId: entry.controllerId,
      sourceInstanceId: entry.sourceInstanceId,
    })
  ) {
    emit(ctx, {
      type: 'delayed_effect_expired',
      delayedId: entry.id,
      definitionId: entry.sourceDefinitionId,
      controllerId: entry.controllerId,
      abilityId: entry.abilityId,
      reason: 'boundary_passed',
    });
    return;
  }

  const item = enqueue(ctx, {
    kind: 'triggered_ability',
    sourceInstanceId: entry.sourceInstanceId,
    sourceDefinitionId: entry.sourceDefinitionId,
    controllerId: entry.controllerId,
    abilityId: entry.abilityId,
    effects: [...entry.effects],
    causeSequence: entry.causeSequence,
    completesSpell: false,
    triggerSubjectInstanceId: entry.subjectInstanceId,
  });

  emit(ctx, {
    type: 'delayed_effect_fired',
    delayedId: entry.id,
    definitionId: entry.sourceDefinitionId,
    controllerId: entry.controllerId,
    abilityId: entry.abilityId,
    subjectInstanceId: entry.subjectInstanceId,
    resolutionId: item.id,
  });
}

/** Which delayed trigger, if any, an emitted event represents for one instance. */
function watchedTriggers(event: GameEvent): { trigger: TriggerId; instanceId: InstanceId }[] {
  switch (event.type) {
    case 'unit_defeated': {
      const hits: { trigger: TriggerId; instanceId: InstanceId }[] = [
        { trigger: 'on_defeated', instanceId: event.instanceId },
      ];
      // A sacrifice is also a defeat, exactly as it is for ordinary triggers.
      if (event.reason === 'sacrificed') {
        hits.unshift({ trigger: 'on_sacrifice', instanceId: event.instanceId });
      }
      return hits;
    }
    case 'unit_deployed':
      return [{ trigger: 'on_deployed', instanceId: event.instanceId }];
    case 'token_created':
      return [{ trigger: 'on_deployed', instanceId: event.instanceId }];
    case 'unit_entered_battlefield':
      return [{ trigger: 'on_entered_battlefield', instanceId: event.instanceId }];
    case 'attackers_declared':
      return event.instanceIds.map((instanceId) => ({ trigger: 'on_attack', instanceId }));
    case 'blockers_assigned':
      return event.blocks.map((block) => ({
        trigger: 'on_block',
        instanceId: block.blockerInstanceId,
      }));
    case 'combat_survived': {
      const hits: { trigger: TriggerId; instanceId: InstanceId }[] = [
        { trigger: 'on_survive_combat', instanceId: event.instanceId },
      ];
      if (event.asBlocker) {
        hits.push({ trigger: 'on_survive_combat_as_blocker', instanceId: event.instanceId });
      }
      return hits;
    }
    case 'tokens_created': {
      const first = event.instanceIds[0];
      return first === undefined ? [] : [{ trigger: 'on_tokens_created', instanceId: first }];
    }
    default:
      return [];
  }
}

/**
 * Advances every live delayed effect against one batch of events.
 *
 * Called from `settle`, beside trigger discovery, so a delayed watch sees
 * exactly the events an ordinary triggered ability sees — including the defeats
 * a state-based check produced, which are emitted inside the same pass.
 *
 * Order within the pass is fixed and deliberate:
 *
 *  1. **fire** every watch whose event is in this batch, oldest entry first;
 *  2. **then** prune the entries whose subject has moved.
 *
 * That order is the whole of rule 4 above. A defeat both satisfies a
 * `marked_for_death` watch and moves its subject out of the battlefield, and
 * pruning first would cancel the entry with the event it was waiting for
 * already in hand.
 */
export function advanceDelayedEffects(ctx: MatchContext, events: readonly GameEvent[]): void {
  if (ctx.state.delayedEffects.length === 0) return;

  for (const event of events) {
    const hits = watchedTriggers(event);
    if (hits.length === 0) continue;
    for (const hit of hits) {
      // Snapshotted: firing an entry can schedule nothing new (a delayed body
      // may not schedule another), but it does mutate the list underneath us.
      for (const entry of [...ctx.state.delayedEffects]) {
        if (entry.trigger !== hit.trigger) continue;
        if (entry.subjectInstanceId !== hit.instanceId) continue;
        fire(ctx, entry);
      }
    }
  }

  for (const entry of [...ctx.state.delayedEffects]) {
    if (entry.subjectInstanceId === null) continue;
    const subject = findInstance(ctx.state, entry.subjectInstanceId);
    // Gone entirely — a token that stopped existing — or somewhere else. Either
    // way it is not the object the delayed text named.
    if (!subject || subject.zone !== entry.subjectZone) expire(ctx, entry, 'subject_moved');
  }
}

/**
 * Fires everything tied to a boundary the match has just reached, and discards
 * the watches that were waiting on an event which never happened.
 *
 * Entries created on a later turn are left alone. In practice there are none —
 * a delayed effect is always scheduled during the turn it belongs to — but the
 * guard is what makes the statement "an entry never outlives its own turn" true
 * of the code rather than only of the current call sites.
 */
export function reachDelayedBoundary(ctx: MatchContext, boundary: DelayedBoundary): void {
  for (const entry of [...ctx.state.delayedEffects]) {
    if (entry.boundary !== boundary) continue;
    if (entry.createdOnTurn > ctx.state.turn) continue;
    // A watch that reaches its boundary unfired simply did not happen: "when it
    // is defeated **this turn**" is a window, and the window has closed.
    if (entry.trigger !== null) expire(ctx, entry, 'boundary_passed');
    else fire(ctx, entry);
  }
}

/**
 * Ends every delayed effect belonging to an eliminated player.
 *
 * CLAUDE.md §12 step 3: a departing seat's static, delayed and queued effects
 * all end with them. Keyed on the controller recorded when the entry was
 * scheduled, never on where the subject has ended up.
 */
export function cancelDelayedEffectsOf(ctx: MatchContext, playerId: PlayerId): void {
  for (const entry of [...ctx.state.delayedEffects]) {
    if (entry.controllerId !== playerId) continue;
    expire(ctx, entry, 'controller_eliminated');
  }
}
