import { emit, type MatchContext } from './context.js';
import { damagePlayer, damageUnit, healPlayer } from './damage.js';
import { currentAttack, definitionOf, findInstance, hasKeyword, opponentOf } from './derive.js';
import { settle } from './queue.js';
import type { CardInstance } from './schema/state.js';
import type { InstanceId } from './schema/primitives.js';

type DamageStep = 'quick_strike' | 'regular';

interface CombatHit {
  readonly sourceInstanceId: InstanceId;
  readonly targetInstanceId: InstanceId | null;
  readonly targetPlayerId: string | null;
  readonly amount: number;
  readonly lethal: boolean;
  readonly siphon: boolean;
  readonly controllerId: string;
}

function livingCombatant(ctx: MatchContext, instanceId: InstanceId): CardInstance | undefined {
  const instance = findInstance(ctx.state, instanceId);
  return instance && instance.zone === 'battlefield' ? instance : undefined;
}

/** Which damage step a combatant strikes in. `quick_strike` goes first. */
function stepOf(ctx: MatchContext, instance: CardInstance): DamageStep {
  return hasKeyword(instance, definitionOf(ctx.database, instance), 'quick_strike')
    ? 'quick_strike'
    : 'regular';
}

function buildHits(ctx: MatchContext, step: DamageStep): CombatHit[] {
  const hits: CombatHit[] = [];
  const defenderId = opponentOf(ctx.state, ctx.state.activePlayerId);
  const { attackerInstanceIds, blocks } = ctx.state.combat;

  for (const attackerId of attackerInstanceIds) {
    const attacker = livingCombatant(ctx, attackerId);
    if (!attacker || stepOf(ctx, attacker) !== step) continue;

    const definition = definitionOf(ctx.database, attacker);
    const amount = currentAttack(attacker, definition);
    const assigned = blocks.filter((block) => block.attackerInstanceId === attackerId);
    const livingBlockers = assigned
      .map((block) => livingCombatant(ctx, block.blockerInstanceId))
      .filter((instance): instance is CardInstance => instance !== undefined);

    if (assigned.length === 0) {
      // Unblocked: damage goes to the defending player.
      hits.push({
        sourceInstanceId: attackerId,
        targetInstanceId: null,
        targetPlayerId: defenderId,
        amount,
        lethal: false,
        siphon: hasKeyword(attacker, definition, 'siphon'),
        controllerId: attacker.controller,
      });
      continue;
    }

    // A blocker that left play before damage does not un-block the attacker:
    // it stays blocked and deals no player damage (CLAUDE.md §4).
    for (const blocker of livingBlockers) {
      hits.push({
        sourceInstanceId: attackerId,
        targetInstanceId: blocker.instanceId,
        targetPlayerId: null,
        amount,
        lethal: hasKeyword(attacker, definition, 'venom'),
        siphon: hasKeyword(attacker, definition, 'siphon'),
        controllerId: attacker.controller,
      });
    }
  }

  for (const block of blocks) {
    const blocker = livingCombatant(ctx, block.blockerInstanceId);
    if (!blocker || stepOf(ctx, blocker) !== step) continue;
    const attacker = livingCombatant(ctx, block.attackerInstanceId);
    if (!attacker) continue;

    const definition = definitionOf(ctx.database, blocker);
    hits.push({
      sourceInstanceId: blocker.instanceId,
      targetInstanceId: attacker.instanceId,
      targetPlayerId: null,
      amount: currentAttack(blocker, definition),
      lethal: hasKeyword(blocker, definition, 'venom'),
      siphon: hasKeyword(blocker, definition, 'siphon'),
      controllerId: blocker.controller,
    });
  }

  return hits;
}

function applyStep(ctx: MatchContext, step: DamageStep): void {
  const hits = buildHits(ctx, step);
  if (hits.length === 0) return;

  emit(ctx, { type: 'combat_damage_step', step });
  const before = ctx.events.length;

  // Amounts are computed for the whole step before any of it is applied, so
  // blocked units damage each other simultaneously (CLAUDE.md §4).
  const siphoned = new Map<string, number>();
  for (const hit of hits) {
    const dealt =
      hit.targetInstanceId !== null
        ? damageUnit(ctx, hit.targetInstanceId, hit.amount, {
            sourceInstanceId: hit.sourceInstanceId,
            combat: true,
            lethal: hit.lethal,
          })
        : damagePlayer(ctx, hit.targetPlayerId as string, hit.amount, {
            sourceInstanceId: hit.sourceInstanceId,
            combat: true,
          });

    if (hit.siphon && dealt > 0) {
      siphoned.set(hit.controllerId, (siphoned.get(hit.controllerId) ?? 0) + dealt);
    }
  }

  for (const [playerId, amount] of siphoned) healPlayer(ctx, playerId, amount);

  // Defeats resolve between steps so a unit killed by `quick_strike` never
  // deals its own combat damage.
  settle(ctx, before);
}

/**
 * Resolves the whole combat phase: quick-strike damage, then regular damage,
 * then survive-combat triggers.
 */
export function resolveCombat(ctx: MatchContext): void {
  const combatants = new Set<InstanceId>([
    ...ctx.state.combat.attackerInstanceIds,
    ...ctx.state.combat.blocks.map((block) => block.blockerInstanceId),
  ]);
  ctx.state.combat.combatantInstanceIds = [...combatants];

  applyStep(ctx, 'quick_strike');
  if (ctx.state.status !== 'complete') applyStep(ctx, 'regular');

  if (ctx.state.status !== 'complete') {
    const before = ctx.events.length;
    for (const instanceId of ctx.state.combat.combatantInstanceIds) {
      const instance = livingCombatant(ctx, instanceId);
      if (!instance) continue;
      emit(ctx, {
        type: 'combat_survived',
        instanceId,
        definitionId: instance.definitionId,
      });
    }
    settle(ctx, before);
  }

  ctx.state.combat.damageResolved = true;
}

/** Clears combat bookkeeping at the end of the turn. */
export function clearCombat(ctx: MatchContext): void {
  ctx.state.combat = {
    attackerInstanceIds: [],
    blocks: [],
    combatantInstanceIds: [],
    damageResolved: false,
  };
}
