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

/* ------------------------------------------------------ seats and turn order */

/**
 * Seat helpers.
 *
 * Every "who else is in this match" question goes through one of these, so no
 * rule can quietly assume two players. Eliminated seats stay in `seatOrder`
 * forever and are skipped rather than removed, which is what keeps the circle
 * stable as players drop out (CLAUDE.md §12).
 */

export function isAlive(state: MatchState, playerId: PlayerId): boolean {
  return !playerOf(state, playerId).lost;
}

/** Every seat still in the match, in stable seat order. */
export function livingPlayers(state: MatchState): PlayerId[] {
  return state.seatOrder.filter((id) => isAlive(state, id));
}

/**
 * Seats clockwise from `playerId`, excluding `playerId` itself. This is the
 * order `each_opponent` resolves in (CLAUDE.md §12).
 */
export function clockwiseFrom(
  state: MatchState,
  playerId: PlayerId,
  options: { readonly includeSelf?: boolean; readonly livingOnly?: boolean } = {},
): PlayerId[] {
  const { seatOrder } = state;
  const start = seatOrder.indexOf(playerId);
  if (start < 0) return [];

  const ordered: PlayerId[] = [];
  for (let step = options.includeSelf ? 0 : 1; step < seatOrder.length; step += 1) {
    const id = seatOrder[(start + step) % seatOrder.length];
    if (id === undefined) continue;
    if (options.livingOnly !== false && !isAlive(state, id)) continue;
    ordered.push(id);
  }
  return ordered;
}

/** Living opponents of `playerId`, clockwise. Empty once they have won. */
export function livingOpponents(state: MatchState, playerId: PlayerId): PlayerId[] {
  return clockwiseFrom(state, playerId);
}

/**
 * The single opponent, for the two-player case.
 *
 * Throws with three or more living seats rather than picking one: a rule that
 * needs "the" opponent in a free-for-all is a rule that has not been written
 * yet, and silently choosing a seat would be a hidden game decision.
 */
export function opponentOf(state: MatchState, playerId: PlayerId): PlayerId {
  const opponents = state.seatOrder.filter((id) => id !== playerId);
  const [only, extra] = opponents;
  if (only === undefined) throw new Error(`Match state has no opponent for "${playerId}"`);
  if (extra !== undefined) {
    throw new Error(
      `opponentOf is only meaningful with two seats; this match has ${state.seatOrder.length}.`,
    );
  }
  return only;
}

/** The next living seat to take a turn after `playerId`, or null if none is left. */
export function nextLivingPlayer(state: MatchState, playerId: PlayerId): PlayerId | null {
  const order = state.playerOrder;
  const start = order.indexOf(playerId);
  if (start < 0) return null;
  for (let step = 1; step <= order.length; step += 1) {
    const id = order[(start + step) % order.length];
    if (id !== undefined && isAlive(state, id)) return id;
  }
  return null;
}

/**
 * Every seat ordered active-player-first, then clockwise. The tiebreak for
 * simultaneous triggers and for deterministic event ordering (CLAUDE.md §12).
 */
export function activeFirstOrder(state: MatchState, livingOnly = true): PlayerId[] {
  const active = state.activePlayerId;
  const ordered = clockwiseFrom(state, active, { includeSelf: true, livingOnly });
  return ordered.length > 0 ? ordered : [...state.seatOrder];
}

/**
 * Current stats and keywords are always derived from the printed definition
 * plus the applied modifiers plus the continuous layer — never stored. Removing
 * a temporary Health bonus therefore defeats a damaged unit on the very next
 * state-based check (CLAUDE.md §4), and a lord leaving play takes its bonus with
 * it on the next recalculation (§17 Q2).
 */
export function currentAttack(instance: CardInstance, definition: CardDefinition): number {
  const base = definition.attack ?? 0;
  const bonus = instance.statModifiers.reduce((sum, mod) => sum + mod.attack, 0);
  // Negative Attack is treated as 0 when dealing damage (CLAUDE.md §4).
  return Math.max(0, base + bonus + instance.continuous.attack);
}

export function currentHealth(instance: CardInstance, definition: CardDefinition): number {
  const base = definition.health ?? 0;
  const bonus = instance.statModifiers.reduce((sum, mod) => sum + mod.health, 0);
  return base + bonus + instance.continuous.health;
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
  for (const keyword of instance.continuous.grantedKeywords) keywords.add(keyword);
  for (const removal of instance.removedKeywords) keywords.delete(removal.keyword);
  for (const keyword of instance.continuous.removedKeywords) keywords.delete(keyword);
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
