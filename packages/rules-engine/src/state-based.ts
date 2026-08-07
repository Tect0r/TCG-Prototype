import { emit, type MatchContext } from './context.js';
import { currentHealth, definitionOf, findInstance, playerOf } from './derive.js';
import { moveToZone } from './zones.js';
import type { InstanceId } from './schema/primitives.js';
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
 * happens in the next state-based check, so two players losing in the same
 * check produce a draw rather than a race (CLAUDE.md §4).
 */
export function markLoss(ctx: MatchContext, playerId: string, reason: LossReason): void {
  const player = playerOf(ctx.state, playerId);
  if (player.lost) return;
  player.lost = true;
  player.lossReason = reason;
  emit(ctx, { type: 'player_lost', playerId, reason });
}

/**
 * Runs until the state is stable: defeat every lethally damaged unit
 * simultaneously, then check player losses, then repeat in case a defeat
 * changed something.
 */
export function runStateBasedChecks(ctx: MatchContext): void {
  if (ctx.state.status === 'complete') return;

  for (let pass = 0; pass < 64; pass += 1) {
    const defeated = findDefeatedUnits(ctx);

    if (defeated.length > 0) {
      // Damage is already marked; defeat is simultaneous, and the resulting
      // events are emitted in a deterministic order (slot order per player,
      // active player first).
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
    for (const playerId of ctx.state.playerOrder) {
      const player = playerOf(ctx.state, playerId);
      if (!player.lost && player.health <= 0) {
        markLoss(ctx, playerId, 'health_depleted');
        lossFound = true;
      }
    }

    if (concludeIfOver(ctx)) return;
    if (defeated.length === 0 && !lossFound) return;
  }
}

/**
 * Units whose marked damage has reached their current Health, or whose Health
 * has been reduced to zero or below by a modifier expiring.
 */
function findDefeatedUnits(ctx: MatchContext): InstanceId[] {
  const defeated: InstanceId[] = [];
  const order = orderedPlayers(ctx);

  for (const playerId of order) {
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

/** Active player first, then the rest in turn order. */
function orderedPlayers(ctx: MatchContext): string[] {
  const active = ctx.state.activePlayerId;
  return [active, ...ctx.state.playerOrder.filter((id) => id !== active)];
}

/**
 * Ends the match if any player has lost. Every player losing in the same check
 * is a draw; otherwise the surviving player wins.
 */
export function concludeIfOver(ctx: MatchContext): boolean {
  if (ctx.state.status === 'complete') return true;

  const losers = ctx.state.playerOrder.filter((id) => playerOf(ctx.state, id).lost);
  if (losers.length === 0) return false;

  const survivors = ctx.state.playerOrder.filter((id) => !playerOf(ctx.state, id).lost);
  const draw = survivors.length === 0;
  const firstLoser = losers[0];
  const lossReason = firstLoser ? playerOf(ctx.state, firstLoser).lossReason : null;

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
