import { emit, underCause, type MatchContext } from './context.js';
import { executeEffect } from './effects.js';
import { findInstance, playerOf } from './derive.js';
import { collectTriggers } from './triggers.js';
import { runStateBasedChecks, finishMatch } from './state-based.js';
import { moveToZone } from './zones.js';
import type { MatchState, ResolutionItem } from './schema/state.js';

/**
 * A cheap structural signature of the match. Used only by the loop safeguard:
 * it deliberately excludes sequence numbers and generated IDs, which always
 * change, so a genuinely stuck resolution looks identical pass after pass.
 */
function fingerprint(state: MatchState): string {
  const parts: (string | number)[] = [
    state.phase,
    state.turn,
    state.queue.length,
    state.queue.reduce((sum, item) => sum + item.effectIndex, 0),
    Object.keys(state.instances).length,
  ];
  for (const playerId of state.playerOrder) {
    const player = state.players[playerId];
    if (!player) continue;
    parts.push(
      player.health,
      player.energy,
      player.hand.length,
      player.deck.length,
      player.discard.length,
      player.units.length,
    );
  }
  return parts.join('|');
}

/**
 * Terminates a match that will not settle. Producing a structured error plus the
 * full log is required behaviour — hanging is not (CLAUDE.md §4).
 */
function fault(ctx: MatchContext, code: string, message: string): void {
  emit(ctx, { type: 'engine_fault', code, message });
  finishMatch(ctx, {
    outcome: 'draw',
    winnerId: null,
    loserIds: [...ctx.state.playerOrder],
    reason: 'engine_error',
    finalTurn: ctx.state.turn,
    finalSequence: ctx.state.sequence,
    diagnostics: `${code}: ${message} | fingerprint=${fingerprint(ctx.state)}`,
  });
}

function checkSafeguards(ctx: MatchContext): boolean {
  ctx.state.resolutionSteps += 1;
  ctx.state.stepsSinceInput += 1;

  if (ctx.state.stepsSinceInput > ctx.config.maxResolutionSteps) {
    fault(
      ctx,
      'engine/resolution_limit',
      `Resolution exceeded ${ctx.config.maxResolutionSteps} steps without returning control to a player.`,
    );
    return false;
  }

  const signature = fingerprint(ctx.state);
  ctx.state.recentFingerprints.push(signature);
  if (ctx.state.recentFingerprints.length > ctx.config.maxRepeatedStates * 2) {
    ctx.state.recentFingerprints.shift();
  }
  const repeats = ctx.state.recentFingerprints.filter((entry) => entry === signature).length;
  if (repeats > ctx.config.maxRepeatedStates) {
    fault(
      ctx,
      'engine/repeated_state',
      `The same match state recurred ${repeats} times without progress.`,
    );
    return false;
  }
  return true;
}

/**
 * Runs state-based checks and discovers triggers for everything emitted since
 * `fromEventIndex`. Called after every atomic instruction and after every
 * engine-driven step such as combat damage (CLAUDE.md §9).
 */
export function settle(ctx: MatchContext, fromEventIndex: number): void {
  let cursor = fromEventIndex;

  for (let pass = 0; pass < 64; pass += 1) {
    const lengthBefore = ctx.state.log.length;
    runStateBasedChecks(ctx);
    if (ctx.state.status === 'complete') return;

    const batch = ctx.events.slice(cursor);
    cursor = ctx.events.length;
    if (batch.length === 0) return;

    collectTriggers(ctx, batch);
    cursor = ctx.events.length;
    if (ctx.state.log.length === lengthBefore) return;
  }
}

function completeItem(ctx: MatchContext, item: ResolutionItem): void {
  if (!item.completesSpell || item.sourceInstanceId === null) return;
  const instance = findInstance(ctx.state, item.sourceInstanceId);
  if (!instance) return;
  emit(ctx, {
    type: 'spell_resolved',
    playerId: instance.owner,
    instanceId: instance.instanceId,
    definitionId: instance.definitionId,
  });
  moveToZone(ctx, instance.instanceId, 'discard', { silent: true });
}

/**
 * Resolves the queue until it is empty, a mandatory choice pauses it, or the
 * match ends.
 *
 * Strict FIFO: a trigger created while an item is mid-resolution is appended,
 * so the rest of that item's authored instructions still resolve first
 * (CLAUDE.md §4 — one queue, no stack, no priority).
 */
export function pumpQueue(ctx: MatchContext): void {
  for (;;) {
    if (ctx.state.status === 'complete') return;
    if (ctx.state.pendingChoice !== null) return;

    const item = ctx.state.queue[0];
    if (item === undefined) return;

    if (item.effectIndex >= item.effects.length) {
      const before = ctx.events.length;
      ctx.state.queue.shift();
      completeItem(ctx, item);
      settle(ctx, before);
      continue;
    }

    const effect = item.effects[item.effectIndex];
    if (effect === undefined) {
      ctx.state.queue.shift();
      continue;
    }

    const effectIndex = item.effectIndex;
    const before = ctx.events.length;

    const outcome = underCause(
      ctx,
      { sourceInstanceId: item.sourceInstanceId, resolutionId: item.id },
      () => executeEffect(ctx, item, effect, effectIndex),
    );

    if (outcome.kind === 'awaiting_choice') {
      ctx.state.pendingChoice = outcome.choice;
      ctx.state.status = 'waiting_for_choice';
      emit(ctx, {
        type: 'choice_requested',
        choiceId: outcome.choice.id,
        playerId: outcome.choice.playerId,
        choiceType: outcome.choice.type,
        reason: outcome.choice.reason,
        minimum: outcome.choice.minimum,
        maximum: outcome.choice.maximum,
        validEntityIds: [...outcome.choice.validEntityIds],
      });
      return;
    }

    item.effectIndex = effectIndex + 1;
    // What "If you do" reads. An instruction that emitted nothing changed
    // nothing, whether it was declined, found no target, or was already true of
    // the board — and all three answer "you did not". Recorded from the event
    // log rather than from `outcome.kind`, because `resolved` covers a
    // sacrifice of zero units just as happily as a sacrifice of one.
    item.previousStepActed = ctx.events.length > before;

    if (outcome.kind === 'fizzled') {
      emit(ctx, {
        type: 'effect_fizzled',
        resolutionId: item.id,
        effectType: effect.type,
        effectIndex,
        reason: outcome.reason,
      });
    } else {
      emit(ctx, {
        type: 'effect_resolved',
        resolutionId: item.id,
        effectType: effect.type,
        effectIndex,
      });
    }

    if (!checkSafeguards(ctx)) return;
    settle(ctx, before);
  }
}

/** True when no player input is outstanding and the queue is idle. */
export function isIdle(ctx: MatchContext): boolean {
  return ctx.state.pendingChoice === null && ctx.state.queue.length === 0;
}

/** Energy a player has left. Exposed for legal-action generation. */
export function availableEnergy(ctx: MatchContext, playerId: string): number {
  return playerOf(ctx.state, playerId).energy;
}
