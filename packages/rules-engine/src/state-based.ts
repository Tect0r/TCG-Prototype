import { emit, type MatchContext } from './context.js';
import { removeFromCombat } from './combat.js';
import { recalculateContinuous } from './continuous.js';
import {
  activeFirstOrder,
  currentHealth,
  definitionOf,
  findInstance,
  livingPlayers,
  playerOf,
} from './derive.js';
import { moveToZone } from './zones.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';
import type { MatchEndReason, MatchResult } from './schema/state.js';
import type { LossReason } from './schema/primitives.js';

const LOSS_TO_END_REASON: Record<LossReason, MatchEndReason> = {
  health_depleted: 'health_depleted',
  empty_deck: 'empty_deck',
  concede: 'concede',
  timeout: 'timeout',
  engine_error: 'engine_error',
};

/**
 * Marks a player as having lost. The match itself is not concluded here — that
 * happens in the next state-based check, so several players losing in the same
 * check produce a draw rather than a race (CLAUDE.md §4, §12).
 */
export function markLoss(ctx: MatchContext, playerId: PlayerId, reason: LossReason): void {
  const player = playerOf(ctx.state, playerId);
  if (player.lost) return;
  player.lost = true;
  player.lossReason = reason;
  emit(ctx, { type: 'player_lost', playerId, reason });
}

/**
 * Runs until the state is stable: eliminate players who have lost, defeat every
 * lethally damaged unit simultaneously, then check for new losses, then repeat
 * in case a defeat or an elimination changed something.
 */
export function runStateBasedChecks(ctx: MatchContext): void {
  if (ctx.state.status === 'complete') return;

  for (let pass = 0; pass < 64; pass += 1) {
    // Continuous effects first: losing a Health-granting lord has to be visible
    // to the very next lethal-damage check (CLAUDE.md §17 Q2).
    const continuousChanged = recalculateContinuous(ctx);
    const eliminated = runEliminations(ctx);
    const defeated = findDefeatedUnits(ctx);

    if (defeated.length > 0) {
      // Damage is already marked; defeat is simultaneous, and the resulting
      // events are emitted in a deterministic order (active player first, then
      // clockwise, then slot order).
      for (const instanceId of defeated) {
        const instance = findInstance(ctx.state, instanceId);
        if (!instance) continue;
        const definition = definitionOf(ctx.database, instance);
        emit(ctx, {
          type: 'unit_defeated',
          instanceId,
          definitionId: instance.definitionId,
          controllerId: instance.controller,
          reason:
            instance.markedDamage > 0 &&
            instance.markedDamage >= currentHealth(instance, definition)
              ? 'lethal_damage'
              : 'zero_health',
        });
      }
      for (const instanceId of defeated) {
        if (findInstance(ctx.state, instanceId)) {
          moveToZone(ctx, instanceId, 'discard', { silent: true });
        }
      }
    }

    let lossFound = false;
    for (const playerId of ctx.state.seatOrder) {
      const player = playerOf(ctx.state, playerId);
      if (!player.lost && player.health <= 0) {
        markLoss(ctx, playerId, 'health_depleted');
        lossFound = true;
      }
    }

    if (concludeIfOver(ctx)) return;
    if (defeated.length === 0 && !lossFound && eliminated.length === 0 && !continuousChanged) {
      return;
    }
  }
}

/* --------------------------------------------------------------- elimination */

/**
 * Clears the board of every player who has lost but not yet been cleaned up.
 *
 * The eight steps of CLAUDE.md §12, run once per player as a single batch:
 * state-based checks and trigger discovery happen after the whole cleanup, not
 * after each removed object, so a board wipe cannot fire another player's
 * death triggers one at a time.
 */
function runEliminations(ctx: MatchContext): PlayerId[] {
  const pending = ctx.state.seatOrder.filter((playerId) => {
    const player = playerOf(ctx.state, playerId);
    return player.lost && player.eliminatedOnTurn === null;
  });
  if (pending.length === 0) return [];

  for (const playerId of pending) {
    const player = playerOf(ctx.state, playerId);
    player.eliminatedOnTurn = ctx.state.turn;

    // 6. Cancel an unresolved choice assigned to them, and 3. drop queued work
    //    they control, before anything else can try to resume it.
    cancelWorkOwnedBy(ctx, playerId);
    // 7. Attacks aimed at them, and blocks they had committed.
    removeFromCombat(ctx, playerId);
    // 2/4/5. Every card, wherever it is and whoever controls it.
    clearCardsOf(ctx, playerId);

    emit(ctx, { type: 'player_eliminated', playerId, turn: ctx.state.turn });
  }

  return pending;
}

/** Queued effects and pending choices belonging to an eliminated player. */
function cancelWorkOwnedBy(ctx: MatchContext, playerId: PlayerId): void {
  const remaining = ctx.state.queue.filter((item) => item.controllerId !== playerId);
  if (remaining.length !== ctx.state.queue.length) {
    emit(ctx, {
      type: 'effects_cancelled',
      playerId,
      count: ctx.state.queue.length - remaining.length,
    });
    ctx.state.queue = remaining;
  }

  const choice = ctx.state.pendingChoice;
  if (choice && choice.playerId === playerId) {
    // The containing effect is gone with the queue above, so the documented
    // no-selection result is simply "nothing was chosen".
    ctx.state.pendingChoice = null;
    if (ctx.state.status === 'waiting_for_choice') ctx.state.status = 'playing';
    emit(ctx, { type: 'choice_cancelled', choiceId: choice.id, playerId });
  }
}

/**
 * Removes every card the player owns, and hands back every card they merely
 * controlled.
 *
 * Ownership is explicit on the instance and never inferred from which
 * battlefield a card is sitting on, which is what makes "remove their cards
 * even from another player's board" a lookup rather than a guess
 * (CLAUDE.md §12).
 */
function clearCardsOf(ctx: MatchContext, playerId: PlayerId): void {
  for (const instance of Object.values(ctx.state.instances)) {
    if (instance.owner === playerId) {
      // Tokens cease to exist; real cards go to a terminal zone.
      moveToZone(ctx, instance.instanceId, 'removed', { silent: true });
      continue;
    }
    if (instance.controller === playerId) {
      // Someone else's card that they had taken control of goes home. There is
      // no "originating zone" to restore, so it lands in the owner's discard.
      instance.controller = instance.owner;
      moveToZone(ctx, instance.instanceId, 'discard', { silent: true });
      emit(ctx, {
        type: 'control_returned',
        instanceId: instance.instanceId,
        playerId: instance.owner,
      });
    }
  }

  const player = playerOf(ctx.state, playerId);
  player.costModifiers = [];
  player.damageShields = [];
}

/* ------------------------------------------------------------------ defeats */

/**
 * Units whose marked damage has reached their current Health, or whose Health
 * has been reduced to zero or below by a modifier expiring.
 */
function findDefeatedUnits(ctx: MatchContext): InstanceId[] {
  const defeated: InstanceId[] = [];

  for (const playerId of activeFirstOrder(ctx.state, false)) {
    const player = playerOf(ctx.state, playerId);
    for (const instanceId of player.units) {
      if (instanceId === null) continue;
      const instance = findInstance(ctx.state, instanceId);
      if (!instance) continue;
      const health = currentHealth(instance, definitionOf(ctx.database, instance));
      if (health <= 0 || instance.markedDamage >= health) defeated.push(instanceId);
    }
  }
  return defeated;
}

/**
 * Ends the match once at most one player is left. The last living player wins;
 * every remaining player losing in the same check is a draw (CLAUDE.md §12).
 */
export function concludeIfOver(ctx: MatchContext): boolean {
  if (ctx.state.status === 'complete') return true;

  const losers = ctx.state.seatOrder.filter((id) => playerOf(ctx.state, id).lost);
  if (losers.length === 0) return false;

  const survivors = livingPlayers(ctx.state);
  if (survivors.length > 1) return false;

  const draw = survivors.length === 0;
  const lastLoser = losers[losers.length - 1];
  const lossReason = lastLoser ? playerOf(ctx.state, lastLoser).lossReason : null;

  const result: MatchResult = {
    outcome: draw ? 'draw' : 'win',
    winnerId: draw ? null : (survivors[0] ?? null),
    loserIds: losers,
    reason: draw ? 'simultaneous_loss' : lossReason ? LOSS_TO_END_REASON[lossReason] : 'concede',
    finalTurn: ctx.state.turn,
    finalSequence: ctx.state.sequence,
    diagnostics: null,
  };

  finishMatch(ctx, result);
  return true;
}

/** Terminates the match: clears pending work so nothing can resolve afterwards. */
export function finishMatch(ctx: MatchContext, result: MatchResult): void {
  ctx.state.queue = [];
  ctx.state.pendingChoice = null;
  ctx.state.status = 'complete';
  ctx.state.phase = 'complete';
  ctx.state.result = { ...result, finalSequence: ctx.state.sequence + 1 };
  emit(ctx, {
    type: 'match_ended',
    outcome: result.outcome,
    winnerId: result.winnerId,
    reason: result.reason,
  });
}
