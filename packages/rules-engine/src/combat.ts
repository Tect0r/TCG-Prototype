import { emit, type MatchContext } from './context.js';
import { damagePlayer, damageUnit, healPlayer } from './damage.js';
import { currentAttack, definitionOf, findInstance, hasKeyword, isAlive } from './derive.js';
import { settle } from './queue.js';
import { EMPTY_COMBAT, type CardInstance } from './schema/state.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';

type DamageStep = 'quick_strike' | 'regular';

interface CombatHit {
  readonly sourceInstanceId: InstanceId;
  readonly targetInstanceId: InstanceId | null;
  readonly targetPlayerId: PlayerId | null;
  readonly amount: number;
  readonly lethal: boolean;
  readonly siphon: boolean;
  readonly controllerId: PlayerId;
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

/**
 * Builds every hit for one damage step across *all* defenders at once.
 *
 * Multi-defender combat is still one combat: the amounts are computed for the
 * whole step before any of them is applied, so two players can be dealt lethal
 * damage simultaneously and the result is a draw rather than whoever the loop
 * reached first (CLAUDE.md §12).
 */
function buildHits(ctx: MatchContext, step: DamageStep): CombatHit[] {
  const hits: CombatHit[] = [];
  const { attacks, blocks } = ctx.state.combat;

  for (const attack of attacks) {
    const attacker = livingCombatant(ctx, attack.attackerInstanceId);
    if (!attacker || stepOf(ctx, attacker) !== step) continue;

    // An attack aimed at a player who has already been eliminated is removed
    // rather than retargeted; the attacker stays exhausted (CLAUDE.md §12 step 7).
    if (!isAlive(ctx.state, attack.defenderPlayerId)) continue;

    const definition = definitionOf(ctx.database, attacker);
    const amount = currentAttack(attacker, definition);
    const assigned = blocks.filter(
      (block) => block.attackerInstanceId === attack.attackerInstanceId,
    );
    const livingBlockers = assigned
      .map((block) => livingCombatant(ctx, block.blockerInstanceId))
      .filter((instance): instance is CardInstance => instance !== undefined);

    if (assigned.length === 0) {
      // Unblocked: damage goes to the player this attacker chose.
      hits.push({
        sourceInstanceId: attack.attackerInstanceId,
        targetInstanceId: null,
        targetPlayerId: attack.defenderPlayerId,
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
        sourceInstanceId: attack.attackerInstanceId,
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

  const siphoned = new Map<PlayerId, number>();
  for (const hit of hits) {
    const dealt =
      hit.targetInstanceId !== null
        ? damageUnit(ctx, hit.targetInstanceId, hit.amount, {
            sourceInstanceId: hit.sourceInstanceId,
            combat: true,
            lethal: hit.lethal,
          })
        : damagePlayer(ctx, hit.targetPlayerId as PlayerId, hit.amount, {
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
    ...ctx.state.combat.attacks.map((attack) => attack.attackerInstanceId),
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
    ...EMPTY_COMBAT,
    attacks: [],
    awaitingDefenders: [],
    submissions: [],
    blocks: [],
    combatantInstanceIds: [],
  };
}

/**
 * Drops everything an eliminated player owed or was owed by the current combat:
 * their outstanding blocker submission, any blocks they had already committed,
 * and every attack aimed at them (CLAUDE.md §12 step 7).
 */
export function removeFromCombat(ctx: MatchContext, playerId: PlayerId): void {
  const combat = ctx.state.combat;
  combat.awaitingDefenders = combat.awaitingDefenders.filter((id) => id !== playerId);
  combat.submissions = combat.submissions.filter(
    (submission) => submission.defenderPlayerId !== playerId,
  );
  combat.attacks = combat.attacks.filter((attack) => attack.defenderPlayerId !== playerId);

  const stillAttacking = new Set(combat.attacks.map((attack) => attack.attackerInstanceId));
  combat.blocks = combat.blocks.filter((block) => {
    if (!stillAttacking.has(block.attackerInstanceId)) return false;
    const blocker = findInstance(ctx.state, block.blockerInstanceId);
    return blocker !== undefined && blocker.controller !== playerId;
  });
}

/** Living players who have at least one attack pointed at them. */
export function defendersOf(ctx: MatchContext): PlayerId[] {
  const seen: PlayerId[] = [];
  for (const attack of ctx.state.combat.attacks) {
    if (!isAlive(ctx.state, attack.defenderPlayerId)) continue;
    if (!seen.includes(attack.defenderPlayerId)) seen.push(attack.defenderPlayerId);
  }
  // Clockwise from the attacker so the waiting list has a stable order.
  return ctx.state.seatOrder.filter((id) => seen.includes(id));
}
