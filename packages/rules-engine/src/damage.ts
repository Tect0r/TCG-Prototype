import { emit, type MatchContext } from './context.js';
import { currentHealth, definitionOf, findInstance, hasKeyword, playerOf } from './derive.js';
import type { DamageShield } from './schema/state.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';

export interface DamageOptions {
  readonly sourceInstanceId?: InstanceId | null;
  /** Combat damage is flagged so keywords and triggers can distinguish it. */
  readonly combat?: boolean;
  /** `venom`: any non-zero damage is lethal to a unit regardless of Health. */
  readonly lethal?: boolean;
}

/**
 * Spends prevention shields against an incoming hit and returns what is left.
 * Shields are consumed oldest-first so "prevent the next 3 damage" behaves
 * predictably when two are stacked.
 */
function applyShields(
  shields: DamageShield[],
  amount: number,
): { remaining: number; prevented: number } {
  let remaining = amount;
  let prevented = 0;
  for (const shield of shields) {
    if (remaining <= 0) break;
    const absorbed = Math.min(shield.amount, remaining);
    shield.amount -= absorbed;
    remaining -= absorbed;
    prevented += absorbed;
  }
  const emptied = shields.filter((shield) => shield.amount === 0);
  for (const shield of emptied) shields.splice(shields.indexOf(shield), 1);
  return { remaining, prevented };
}

/**
 * Marks damage on a unit. Damage persists across turns until healed or the unit
 * is defeated; defeat itself happens in the next state-based check, never here,
 * so simultaneous combat damage can defeat both combatants at once
 * (CLAUDE.md §4).
 *
 * Reduction order is `armored` first (a property of the unit), then prevention
 * shields (an effect placed on it). See open-questions.md Q4.
 */
export function damageUnit(
  ctx: MatchContext,
  targetInstanceId: InstanceId,
  amount: number,
  options: DamageOptions = {},
): number {
  const target = findInstance(ctx.state, targetInstanceId);
  if (!target || target.zone !== 'battlefield' || amount <= 0) return 0;

  const definition = definitionOf(ctx.database, target);
  let incoming = amount;
  let prevented = 0;

  if (hasKeyword(target, definition, 'armored')) {
    const reduced = Math.min(ctx.config.armoredReduction, incoming);
    incoming -= reduced;
    prevented += reduced;
  }

  const shielded = applyShields(target.damageShields, incoming);
  incoming = shielded.remaining;
  prevented += shielded.prevented;

  if (prevented > 0) {
    emit(ctx, {
      type: 'damage_prevented',
      targetInstanceId,
      targetPlayerId: null,
      amount: prevented,
    });
  }
  if (incoming <= 0) return 0;

  target.markedDamage += incoming;
  const lethal = options.lethal === true;
  if (lethal) {
    // `venom`: force the state-based check to see lethal damage regardless of
    // how much Health the unit actually has.
    target.markedDamage = Math.max(target.markedDamage, currentHealth(target, definition));
  }

  emit(ctx, {
    type: 'damage_dealt',
    targetInstanceId,
    targetPlayerId: null,
    amount: incoming,
    prevented,
    lethal,
    combat: options.combat === true,
    cause: { sourceInstanceId: options.sourceInstanceId ?? ctx.cause.sourceInstanceId },
  });
  return incoming;
}

export function damagePlayer(
  ctx: MatchContext,
  playerId: PlayerId,
  amount: number,
  options: DamageOptions = {},
): number {
  const player = playerOf(ctx.state, playerId);
  if (amount <= 0) return 0;

  const shielded = applyShields(player.damageShields, amount);
  if (shielded.prevented > 0) {
    emit(ctx, {
      type: 'damage_prevented',
      targetInstanceId: null,
      targetPlayerId: playerId,
      amount: shielded.prevented,
    });
  }
  if (shielded.remaining <= 0) return 0;

  player.health -= shielded.remaining;
  emit(ctx, {
    type: 'damage_dealt',
    targetInstanceId: null,
    targetPlayerId: playerId,
    amount: shielded.remaining,
    prevented: shielded.prevented,
    lethal: false,
    combat: options.combat === true,
    cause: { sourceInstanceId: options.sourceInstanceId ?? ctx.cause.sourceInstanceId },
  });
  emit(ctx, {
    type: 'player_damaged',
    playerId,
    amount: shielded.remaining,
    health: player.health,
  });
  return shielded.remaining;
}

/** Healing removes marked damage. It never raises a unit above its Health. */
export function healUnit(ctx: MatchContext, instanceId: InstanceId, amount: number): number {
  const target = findInstance(ctx.state, instanceId);
  if (!target || amount <= 0) return 0;
  const healed = Math.min(target.markedDamage, amount);
  if (healed === 0) return 0;
  target.markedDamage -= healed;
  emit(ctx, {
    type: 'healed',
    targetInstanceId: instanceId,
    targetPlayerId: null,
    amount: healed,
  });
  return healed;
}

/**
 * Player healing has no cap in v0.2. Whether a player may exceed their starting
 * Health is open — see open-questions.md.
 */
export function healPlayer(ctx: MatchContext, playerId: PlayerId, amount: number): number {
  if (amount <= 0) return 0;
  const player = playerOf(ctx.state, playerId);
  player.health += amount;
  emit(ctx, { type: 'healed', targetInstanceId: null, targetPlayerId: playerId, amount });
  emit(ctx, { type: 'player_healed', playerId, amount, health: player.health });
  return amount;
}

export function addDamageShield(
  ctx: MatchContext,
  target: { readonly instanceId: InstanceId } | { readonly playerId: PlayerId },
  amount: number,
  duration: DamageShield['duration'],
): void {
  if (amount <= 0) return;
  const shield: DamageShield = { amount, duration, appliedOnTurn: ctx.state.turn };
  if ('instanceId' in target) {
    const instance = findInstance(ctx.state, target.instanceId);
    if (!instance) return;
    instance.damageShields.push(shield);
    emit(ctx, {
      type: 'damage_shield_added',
      targetInstanceId: target.instanceId,
      targetPlayerId: null,
      amount,
    });
    return;
  }
  playerOf(ctx.state, target.playerId).damageShields.push(shield);
  emit(ctx, {
    type: 'damage_shield_added',
    targetInstanceId: null,
    targetPlayerId: target.playerId,
    amount,
  });
}
