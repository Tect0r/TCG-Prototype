import type {
  CardDefinition,
  KeywordId,
  ReplacementLimit,
  StaticAbilityDefinition,
} from '@tcg/card-data';
import { staticAbilityActive } from './continuous.js';
import { emit, type MatchContext } from './context.js';
import {
  activeFirstOrder,
  definitionOf,
  findInstance,
  matchesCardFilter,
  playerOf,
} from './derive.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';
import type { CardInstance } from './schema/state.js';

/**
 * The replacement layer (M02.4).
 *
 * A replacement rewrites an event *as it happens*, so nothing ever observes the
 * un-rewritten version: a unit that a Relic says arrives Exhausted is put onto
 * the battlefield Exhausted, and no state-based check, trigger or Reaction
 * window sits between the two states. That is the whole reason these cards are
 * not triggered abilities — "when a Unit is deployed, exhaust it" would be a
 * visibly different, answerable card.
 *
 * Two moments are replaceable, and only two:
 *
 *  - **an arrival on a battlefield**, rewritten by a `replace_arrival` static
 *    ability (`enters Exhausted`, `has Rush`);
 *  - **a permanent readying at its controller's Ready Step**, prevented either
 *    by a `replace_ready` static ability on somebody else's board or by a
 *    `skip_next_ready` already stored on the permanent itself.
 *
 * Four properties the milestone requires, and where each one lives:
 *
 *  - **Structured and source-scoped.** Every replacement is a static ability on
 *    a named card with a `ContinuousScope`; nothing is inferred from prose and
 *    nothing is keyed to a card ID.
 *  - **Deterministic ordering.** {@link replacementOrder} is the engine's
 *    existing trigger order — active seat first, then clockwise, then instance
 *    creation order, then ability index — reused rather than reinvented.
 *  - **No recursion.** A replacement may only set flags on the object the event
 *    is about. It cannot emit a replaceable event, so the layer can never
 *    re-enter itself and there is no loop to bound.
 *  - **Attribution.** Every rewrite emits an event naming the source instance,
 *    its definition and the ability ID, so a player and a replay both see which
 *    permanent did it.
 *
 * Nothing here is ever inferred from final state: a rewrite is decided from the
 * event and the board at the moment it happens, and announced.
 */

/** One active replacement, already bound to the source that provides it. */
interface ReplacementSource {
  readonly instance: CardInstance;
  readonly definition: CardDefinition;
  readonly ability: StaticAbilityDefinition;
  readonly abilityIndex: number;
}

/**
 * Every active replacement of one kind, in the engine's deterministic order.
 *
 * The same tiebreak chain triggered abilities use (CLAUDE.md §12): active player
 * first, then clockwise seat order, then instance creation order, then the
 * ability's index within its card. Deliberately *not* the plain instance-ordinal
 * order the continuous layer uses — that layer is a commutative sum where order
 * cannot be observed, and this one is a sequence of decisions where a
 * "first each turn" limit makes it observable.
 */
function replacementOrder(
  ctx: MatchContext,
  kind: 'replace_arrival' | 'replace_ready',
): ReplacementSource[] {
  const rank = new Map<PlayerId, number>();
  activeFirstOrder(ctx.state, false).forEach((playerId, index) => rank.set(playerId, index));

  const sources: ReplacementSource[] = [];
  for (const instance of Object.values(ctx.state.instances)) {
    // An eliminated player's permanents stop replacing immediately, before the
    // elimination cleanup has finished removing them (CLAUDE.md §12 step 3).
    if (playerOf(ctx.state, instance.controller).lost) continue;
    const definition = ctx.database.get(instance.definitionId);
    if (!definition) continue;
    definition.staticAbilities.forEach((ability, abilityIndex) => {
      if (ability.effect.type !== kind) return;
      if (!staticAbilityActive(instance, ability)) return;
      sources.push({ instance, definition, ability, abilityIndex });
    });
  }

  return sources.sort((left, right) => {
    const leftSeat = rank.get(left.instance.controller) ?? Number.MAX_SAFE_INTEGER;
    const rightSeat = rank.get(right.instance.controller) ?? Number.MAX_SAFE_INTEGER;
    if (leftSeat !== rightSeat) return leftSeat - rightSeat;
    if (left.instance.ordinal !== right.instance.ordinal) {
      return left.instance.ordinal - right.instance.ordinal;
    }
    return left.abilityIndex - right.abilityIndex;
  });
}

/** Counter key recording the turn a `first_each_turn` replacement last acted on. */
function limitKey(abilityId: string): string {
  return `replacedTurn:${abilityId}`;
}

function limitAvailable(ctx: MatchContext, source: ReplacementSource): boolean {
  if (source.ability.effect.type === 'replace_arrival') {
    if (source.ability.effect.limit === 'unlimited') return true;
  } else if (
    source.ability.effect.type === 'replace_ready' &&
    source.ability.effect.limit === 'unlimited'
  ) {
    return true;
  }
  return source.instance.counters[limitKey(source.ability.id)] !== ctx.state.turn;
}

/**
 * Spends a `first_each_turn` limit.
 *
 * Recorded on the instance rather than the definition, so two copies of the same
 * Relic each get their own — the same per-copy bookkeeping a triggered ability's
 * `each_turn` limit uses.
 */
function spendLimit(ctx: MatchContext, source: ReplacementSource): void {
  source.instance.counters[limitKey(source.ability.id)] = ctx.state.turn;
}

/** Whether a replacement's scope covers a card controlled by `controllerId`. */
function scopeCovers(ctx: MatchContext, source: ReplacementSource, subject: CardInstance): boolean {
  const scope = source.ability.affects;
  if (scope.excludeSource && subject.instanceId === source.instance.instanceId) return false;
  if (scope.onlySource && subject.instanceId !== source.instance.instanceId) return false;

  const sameController = subject.controller === source.instance.controller;
  if (scope.controller === 'self' && !sameController) return false;
  if (scope.controller === 'opponent' && sameController) return false;

  if (scope.filter) {
    const definition = definitionOf(ctx.database, subject);
    if (!matchesCardFilter(definition, subject, scope.filter)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ arrival */

/**
 * How a card reached a battlefield, as the replacement layer sees it.
 *
 * The same four values `unit_entered_battlefield` reports, because they are the
 * same fact — a replacement that classified arrivals differently from the event
 * stream would be a second vocabulary for one distinction.
 */
export type ArrivalMethod = 'deployed' | 'token_created' | 'returned' | 'effect';

/** Whether an authored `on` covers an actual arrival method. */
function arrivalMatches(on: 'deployed' | 'entered_battlefield', method: ArrivalMethod): boolean {
  if (on === 'entered_battlefield') return true;
  // A Token arriving *is* a deployment — the trigger layer already says so, and
  // "the first enemy Unit deployed each turn" has always covered Tokens without
  // printing the word.
  return method === 'deployed' || method === 'token_created';
}

/**
 * Rewrites an arrival on the battlefield, in place, before it is announced.
 *
 * Called by every path that puts a card onto a battlefield and always *before*
 * the arrival events are emitted, which is what makes the rewrite part of the
 * arrival rather than something done to the card afterwards.
 *
 * Several replacements applying at once compose as a union: `entersExhausted`
 * is a set-to-true and each granted keyword is added once, so the result does
 * not depend on the order they are visited in. Order still decides which source
 * spends a `first_each_turn` limit on this arrival, which is why it is fixed.
 */
export function applyArrivalReplacements(
  ctx: MatchContext,
  instanceId: InstanceId,
  method: ArrivalMethod,
): void {
  const subject = findInstance(ctx.state, instanceId);
  if (!subject || subject.zone !== 'battlefield') return;

  for (const source of replacementOrder(ctx, 'replace_arrival')) {
    const effect = source.ability.effect;
    if (effect.type !== 'replace_arrival') continue;
    if (!arrivalMatches(effect.on, method)) continue;
    if (effect.onlyOnControllerTurn && ctx.state.activePlayerId !== source.instance.controller) {
      continue;
    }
    if (!scopeCovers(ctx, source, subject)) continue;
    if (!limitAvailable(ctx, source)) continue;

    const exhausted = effect.entersExhausted === true;
    const keyword: KeywordId | null = effect.grantKeyword ?? null;

    if (exhausted) subject.exhausted = true;
    if (keyword !== null && !subject.grantedKeywords.some((held) => held.keyword === keyword)) {
      subject.grantedKeywords.push({
        keyword,
        duration: effect.grantDuration,
        sourceInstanceId: source.instance.instanceId,
        appliedOnTurn: ctx.state.turn,
      });
    }

    spendLimit(ctx, source);
    emit(ctx, {
      type: 'arrival_replaced',
      playerId: subject.controller,
      instanceId: subject.instanceId,
      definitionId: subject.definitionId,
      sourceInstanceId: source.instance.instanceId,
      sourceDefinitionId: source.definition.id,
      abilityId: source.ability.id,
      exhausted,
      keyword,
    });
  }
}

/* -------------------------------------------------------------- readiness */

/** Arms a permanent's "does not Ready next Ready Step" state (M02.4). */
export function applyReadySkip(
  ctx: MatchContext,
  instanceId: InstanceId,
  sourceInstanceId: InstanceId | null,
): void {
  const instance = findInstance(ctx.state, instanceId);
  if (!instance) return;
  // Idempotent: two clauses naming "the next Ready Step" name the same one, and
  // the first source keeps the attribution.
  if (instance.readySkip !== null) return;
  instance.readySkip = { sourceInstanceId, appliedOnTurn: ctx.state.turn };
  emit(ctx, {
    type: 'ready_skip_applied',
    instanceId,
    playerId: instance.controller,
    sourceInstanceId,
  });
}

/**
 * One `replace_ready` offer waiting to be put to its controller.
 *
 * Recomputed from the board every time the Ready Step runs or resumes, rather
 * than snapshotted into the pending choice: the board is the authority, and a
 * stored list could disagree with it after a serialisation round trip.
 */
export interface ReadyReplacementOffer {
  readonly sourceInstanceId: InstanceId;
  readonly sourceDefinitionId: string;
  readonly abilityId: string;
  /** Who is asked, and who pays. */
  readonly controllerId: PlayerId;
  readonly energyCost: number;
  readonly limit: ReplacementLimit;
  /** Permanents this offer could keep Exhausted, in the readying player's order. */
  readonly candidateIds: readonly InstanceId[];
}

/**
 * Permanents that would become Ready at `playerId`'s Ready Step.
 *
 * Exhausted permanents only: a Ready one has no readying to replace. Relics are
 * included because a Relic or a deployed Commander can be Exhausted by a cost
 * just as a unit can.
 */
export function readyStepCandidates(ctx: MatchContext, playerId: PlayerId): InstanceId[] {
  const player = playerOf(ctx.state, playerId);
  return [...player.units, ...player.relics].filter((instanceId) => {
    const instance = findInstance(ctx.state, instanceId);
    return instance !== undefined && instance.exhausted;
  });
}

/**
 * The `replace_ready` offers open at one Ready Step, in deterministic order.
 *
 * An offer is listed only when it could actually be taken: its controller can
 * pay, its limit is available, and at least one permanent that has not already
 * been kept Exhausted is in scope. `excluded` carries the ones an earlier offer
 * in the same step already dealt with, so a second replacement is never asked
 * about a unit that is already staying Exhausted.
 */
export function readyReplacementOffers(
  ctx: MatchContext,
  playerId: PlayerId,
  excluded: readonly InstanceId[],
): ReadyReplacementOffer[] {
  const candidates = readyStepCandidates(ctx, playerId).filter((id) => !excluded.includes(id));
  if (candidates.length === 0) return [];

  const offers: ReadyReplacementOffer[] = [];
  for (const source of replacementOrder(ctx, 'replace_ready')) {
    const effect = source.ability.effect;
    if (effect.type !== 'replace_ready') continue;
    if (!limitAvailable(ctx, source)) continue;
    // A controller who cannot pay is never asked. Offering a choice that has
    // exactly one legal answer would be a prompt that decides nothing.
    if (playerOf(ctx.state, source.instance.controller).energy < effect.energyCost) continue;

    const inScope = candidates.filter((instanceId) => {
      const instance = findInstance(ctx.state, instanceId);
      return instance !== undefined && scopeCovers(ctx, source, instance);
    });
    if (inScope.length === 0) continue;

    offers.push({
      sourceInstanceId: source.instance.instanceId,
      sourceDefinitionId: source.definition.id,
      abilityId: source.ability.id,
      controllerId: source.instance.controller,
      energyCost: effect.energyCost,
      limit: effect.limit,
      candidateIds: inScope,
    });
  }
  return offers;
}

/**
 * Takes one `replace_ready` offer: pays for it and keeps the named permanent
 * Exhausted.
 *
 * Re-validated here rather than trusted from the offer that raised the choice,
 * because a match may have been serialised, reconnected and replayed in between.
 */
export function takeReadyReplacement(
  ctx: MatchContext,
  offer: ReadyReplacementOffer,
  instanceId: InstanceId,
): boolean {
  const instance = findInstance(ctx.state, instanceId);
  if (!instance || !instance.exhausted) return false;
  if (!offer.candidateIds.includes(instanceId)) return false;

  const controller = playerOf(ctx.state, offer.controllerId);
  if (controller.energy < offer.energyCost) return false;
  // Paid out of the controller's current pool. A replacement controlled by the
  // player whose Ready Step this is would be paying moments before their Energy
  // resets to full, and would therefore be free — that is the existing Energy
  // rule showing through, not a special case here. Every authored replacement is
  // scoped to an opponent's units, so it does not arise.
  controller.energy -= offer.energyCost;

  const source = findInstance(ctx.state, offer.sourceInstanceId);
  if (source) source.counters[limitKey(offer.abilityId)] = ctx.state.turn;

  if (offer.energyCost > 0) {
    emit(ctx, {
      type: 'energy_updated',
      playerId: offer.controllerId,
      energy: controller.energy,
      maxEnergy: controller.maxEnergy,
    });
  }
  emit(ctx, {
    type: 'ready_prevented',
    instanceId,
    playerId: instance.controller,
    sourceInstanceId: offer.sourceInstanceId,
    sourceDefinitionId: offer.sourceDefinitionId,
    abilityId: offer.abilityId,
    energySpent: offer.energyCost,
  });
  return true;
}

/**
 * Consumes a stored `skip_next_ready`, if the permanent has one.
 *
 * Consumed whether or not the permanent was Exhausted: "it does not Ready during
 * its controller's next Ready Step" describes one specific Ready Step, and that
 * Ready Step happens whether or not there was anything to stop. A unit readied
 * by an effect in the meantime has already had its reprieve.
 */
export function consumeReadySkip(ctx: MatchContext, instance: CardInstance): boolean {
  const skip = instance.readySkip;
  if (skip === null) return false;
  instance.readySkip = null;
  if (!instance.exhausted) return false;

  const source = skip.sourceInstanceId ? findInstance(ctx.state, skip.sourceInstanceId) : undefined;
  emit(ctx, {
    type: 'ready_prevented',
    instanceId: instance.instanceId,
    playerId: instance.controller,
    sourceInstanceId: skip.sourceInstanceId,
    sourceDefinitionId: source?.definitionId ?? null,
    abilityId: null,
    energySpent: 0,
  });
  return true;
}
