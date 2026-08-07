import type {
  CardDatabase,
  CardDefinition,
  CardFilter,
  KeywordId,
  NumericRange,
} from '@tcg/card-data';
import type { RulesConfig } from './config.js';
import type { CardInstance, CostModifier, MatchState, PlayerState } from './schema/state.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';

/**
 * Derived, never-stored values. Current Attack/Health, effective keywords and
 * modified costs are always computed from the printed definition plus the
 * modifier lists, so removing a temporary Health bonus can immediately defeat a
 * damaged unit on the next state-based check (CLAUDE.md §4).
 */

export function playerOf(state: MatchState, playerId: PlayerId): PlayerState {
  const player = state.players[playerId];
  if (!player) throw new Error(`Match state has no player "${playerId}"`);
  return player;
}

export function instanceOf(state: MatchState, instanceId: InstanceId): CardInstance {
  const instance = state.instances[instanceId];
  if (!instance) throw new Error(`Match state has no instance "${instanceId}"`);
  return instance;
}

export function findInstance(state: MatchState, instanceId: InstanceId): CardInstance | undefined {
  return state.instances[instanceId];
}

export function definitionOf(database: CardDatabase, instance: CardInstance): CardDefinition {
  return database.getOrThrow(instance.definitionId);
}

/** The other seat. 1v1 only; free-for-all turn order arrives in Phase 3. */
export function opponentOf(state: MatchState, playerId: PlayerId): PlayerId {
  const other = state.playerOrder.find((id) => id !== playerId);
  if (!other) throw new Error(`Match state has no opponent for "${playerId}"`);
  return other;
}

export function currentAttack(instance: CardInstance, definition: CardDefinition): number {
  const base = definition.attack ?? 0;
  const bonus = instance.statModifiers.reduce((sum, mod) => sum + mod.attack, 0);
  // Negative Attack is treated as 0 when dealing damage (CLAUDE.md §4).
  return Math.max(0, base + bonus);
}

export function currentHealth(instance: CardInstance, definition: CardDefinition): number {
  const base = definition.health ?? 0;
  return base + instance.statModifiers.reduce((sum, mod) => sum + mod.health, 0);
}

export function remainingHealth(instance: CardInstance, definition: CardDefinition): number {
  return currentHealth(instance, definition) - instance.markedDamage;
}

export function effectiveKeywords(
  instance: CardInstance,
  definition: CardDefinition,
): ReadonlySet<KeywordId> {
  const keywords = new Set<KeywordId>(definition.keywords);
  for (const grant of instance.grantedKeywords) keywords.add(grant.keyword);
  for (const removal of instance.removedKeywords) keywords.delete(removal.keyword);
  return keywords;
}

export function hasKeyword(
  instance: CardInstance,
  definition: CardDefinition,
  keyword: KeywordId,
): boolean {
  return effectiveKeywords(instance, definition).has(keyword);
}

/**
 * A unit entering play is ready but summoning sick: it cannot attack this turn
 * unless a keyword permits it (CLAUDE.md §4).
 */
export function isSummoningSick(instance: CardInstance, state: MatchState): boolean {
  return instance.enteredZoneOnTurn === state.turn;
}

function costModifierApplies(modifier: CostModifier, definition: CardDefinition): boolean {
  if (modifier.filter === null) return true;
  return matchesCardFilter(definition, null, modifier.filter);
}

/** Printed cost after every applicable cost modifier. Never below zero. */
export function energyCostOf(player: PlayerState, definition: CardDefinition): number {
  const printed = definition.cost ?? 0;
  const delta = player.costModifiers
    .filter((modifier) => costModifierApplies(modifier, definition))
    .reduce((sum, modifier) => sum + modifier.delta, 0);
  return Math.max(0, printed + delta);
}

function inRange(value: number, range: NumericRange | undefined): boolean {
  if (!range) return true;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

/**
 * Structured target filtering. `instance` is null when filtering a definition
 * that has no in-match instance yet (a cost modifier against a card in hand),
 * in which case instance-dependent predicates are simply not applied.
 */
export function matchesCardFilter(
  definition: CardDefinition,
  instance: CardInstance | null,
  filter: CardFilter,
): boolean {
  if (filter.cardTypes && !filter.cardTypes.includes(definition.type)) return false;
  if (filter.cardIds && !filter.cardIds.includes(definition.id)) return false;
  if (filter.colors && !definition.colorIdentity.some((c) => filter.colors?.includes(c)))
    return false;
  if (filter.tags && !definition.tags.some((t) => filter.tags?.includes(t))) return false;
  if (filter.unique !== undefined && definition.unique !== filter.unique) return false;

  if (filter.keywords) {
    const keywords = instance
      ? effectiveKeywords(instance, definition)
      : new Set<KeywordId>(definition.keywords);
    if (!filter.keywords.some((k) => keywords.has(k))) return false;
  }

  if (!inRange(definition.cost ?? 0, filter.cost)) return false;

  if (instance) {
    if (!inRange(currentAttack(instance, definition), filter.attack)) return false;
    if (!inRange(currentHealth(instance, definition), filter.health)) return false;
    if (filter.damaged !== undefined && instance.markedDamage > 0 !== filter.damaged) return false;
    if (filter.exhausted !== undefined && instance.exhausted !== filter.exhausted) return false;
  } else {
    if (!inRange(definition.attack ?? 0, filter.attack)) return false;
    if (!inRange(definition.health ?? 0, filter.health)) return false;
    if (filter.damaged !== undefined && filter.damaged) return false;
    if (filter.exhausted !== undefined && filter.exhausted) return false;
  }

  return true;
}

/** Unit instances the player controls, in slot order. */
export function unitsOf(state: MatchState, playerId: PlayerId): CardInstance[] {
  return playerOf(state, playerId)
    .units.filter((id): id is InstanceId => id !== null)
    .map((id) => instanceOf(state, id));
}

export function relicsOf(state: MatchState, playerId: PlayerId): CardInstance[] {
  return playerOf(state, playerId).relics.map((id) => instanceOf(state, id));
}

export function freeUnitSlots(player: PlayerState): number[] {
  const slots: number[] = [];
  player.units.forEach((occupant, index) => {
    if (occupant === null) slots.push(index);
  });
  return slots;
}

export function isMatchOver(state: MatchState): boolean {
  return state.status === 'complete';
}

/** Convenience for handlers that need both halves of the config-driven pair. */
export interface EngineContext {
  readonly database: CardDatabase;
  readonly config: RulesConfig;
}
