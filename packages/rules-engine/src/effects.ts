import {
  effectIntent,
  entitySelectorOf,
  isDistributedSelection,
  type Controller,
  type EffectDefinition,
  type PlayerSelector,
  type SignedValueExpression,
  type TargetDefinition,
  type TargetSelector,
  type ValueExpression,
  type ZoneId,
} from '@tcg/card-data';
import { emit, type MatchContext } from './context.js';
import { addDamageShield, damagePlayer, damageUnit, healPlayer, healUnit } from './damage.js';
import {
  commanderDeployCost,
  definitionOf,
  findInstance,
  hasKeyword,
  matchesCardFilter,
  playerOf,
} from './derive.js';
import {
  autoSelect,
  expandTokenGroup,
  legalTargets,
  playerCandidates,
  requestedCount,
  resolvePlayerSelector,
  type TargetScope,
} from './targeting.js';
import { counterTarget } from './reactions.js';
import { applyArrivalReplacements, applyReadySkip } from './replacement.js';
import { scheduleDelayed } from './delayed.js';
import { enqueue } from './triggers.js';
import { evaluateCondition, evaluateSignedValue, evaluateValue } from './values.js';
import { createInstance, discardCard, drawCards, moveToZone, shuffleDeck } from './zones.js';
import type {
  ChoiceReason,
  ChoiceTargetRelation,
  ChoiceType,
  PendingChoice,
} from './schema/choice.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';
import type { ResolutionItem } from './schema/state.js';

/**
 * The outcome of one atomic instruction.
 *
 * `awaiting_choice` pauses the whole resolution queue: nothing else resolves
 * until the expected player answers (CLAUDE.md §9).
 */
export type EffectOutcome =
  | { readonly kind: 'resolved' }
  | {
      readonly kind: 'fizzled';
      readonly reason: 'no_legal_target' | 'unsupported' | 'condition_unmet' | 'declined';
    }
  | { readonly kind: 'awaiting_choice'; readonly choice: PendingChoice };

const RESOLVED: EffectOutcome = { kind: 'resolved' };

function scopeOf(item: ResolutionItem): TargetScope {
  return {
    controllerId: item.controllerId,
    sourceInstanceId: item.sourceInstanceId,
    triggerSubjectInstanceId: item.triggerSubjectInstanceId,
    previousStepActed: item.previousStepActed,
  };
}

export function nextChoiceId(ctx: MatchContext): string {
  const id = `choice_${String(ctx.state.nextChoiceOrdinal).padStart(4, '0')}`;
  ctx.state.nextChoiceOrdinal += 1;
  return id;
}

/**
 * Whose entities the options are, read from the seat being asked (M05.3).
 *
 * A selector's `controller` is written relative to the ability's controller, and
 * the seat holding the question is not always that player: `chooser` can hand it
 * to somebody else, and an `each_player_choice` hands the same instruction to
 * every seat in turn. Re-reading it from the chooser's seat is what makes
 * "a Unit you control" mean the same thing to the pilot as it does to the
 * player, and it is the only reading a UI could put in a sentence.
 *
 * When the chooser is *not* the ability's controller, `opponent` stops being
 * answerable: "an opponent's Unit", handed to one of those opponents, names a
 * set holding that seat's own cards and possibly a third seat's. `any` is the
 * honest answer, not a guess dressed as one.
 */
function targetRelationFor(
  controller: Controller,
  chooserId: PlayerId,
  controllerId: PlayerId,
): ChoiceTargetRelation {
  if (controller === 'any') return 'any';
  if (chooserId === controllerId) return controller;
  return controller === 'self' ? 'opponent' : 'any';
}

function buildChoice(
  ctx: MatchContext,
  item: ResolutionItem,
  effectIndex: number,
  /** The instruction that is asking. Its own valence, not its card's (M05.3). */
  effect: EffectDefinition,
  options: {
    readonly playerId: PlayerId;
    readonly type: ChoiceType;
    readonly reason: ChoiceReason;
    readonly zone: ZoneId | null;
    readonly minimum: number;
    readonly maximum: number;
    readonly validEntityIds: readonly string[];
    readonly ordered?: boolean;
    /** Defaults to the effect index; set when one instruction asks twice. */
    readonly selectionKey?: string;
    /** Whose entities the options are, from the chooser's seat. */
    readonly targetRelation: ChoiceTargetRelation;
  },
): PendingChoice {
  return {
    id: nextChoiceId(ctx),
    playerId: options.playerId,
    type: options.type,
    reason: options.reason,
    zone: options.zone,
    minimum: options.minimum,
    maximum: options.maximum,
    validEntityIds: [...options.validEntityIds],
    ordered: options.ordered ?? false,
    sourceInstanceId: item.sourceInstanceId,
    provenance: {
      origin: 'instruction',
      itemId: item.id,
      effectIndex,
      effectType: effect.type,
      sourceControllerId: item.controllerId,
      chooser: options.playerId === item.controllerId ? 'source_controller' : 'opponent',
      targetRelation: options.targetRelation,
      intent: effectIntent(effect),
    },
    continuation: {
      kind: 'resolution',
      itemId: item.id,
      effectIndex,
      selectionKey: options.selectionKey ?? String(effectIndex),
    },
  };
}

/**
 * Whether an instruction has anything at all to act on, without asking anyone.
 *
 * Only used to decide whether a "you may" is worth offering, so it is a pure
 * read: it must not build a choice, and must not touch `nextChoiceOrdinal`.
 * Instructions with no target are always worth offering — a draw or a token
 * always has a recipient.
 */
function hasRecipient(ctx: MatchContext, item: ResolutionItem, effect: EffectDefinition): boolean {
  if (!('target' in effect)) return true;
  const target = effect.target;
  if (target.kind === 'player' || target.kind === 'players') {
    return playerCandidates(ctx, target, item.controllerId).length > 0;
  }
  // An optional selector already means "you may pick nothing", so the set being
  // empty is a legal outcome rather than a reason to skip the question.
  if (entitySelectorOf(target)?.optional === true) return true;
  // A mixed pool has a recipient as soon as *either* half does. Asking only the
  // entity half would skip "divide it among enemy Units and opponents" against an
  // empty enemy board, where the opponent is still a perfectly legal destination.
  if (target.kind === 'entity_or_player') {
    const players = resolvePlayerSelector(ctx, target.players, item.controllerId) ?? [];
    if (players.length > 0) return true;
  }
  return legalTargets(ctx, target, scopeOf(item)).length > 0;
}

/** Selection key for the answer one specific player gave to one instruction. */
function perPlayerKey(effectIndex: number, playerId: PlayerId): string {
  return `${effectIndex}:${playerId}`;
}

/**
 * Selection key for one seat's share of an each-player choice (M02.5).
 *
 * Its own namespace rather than `perPlayerKey`'s, because the two answer
 * different questions about the same instruction — "what did you discard" and
 * "which of your units did you name" — and a future card that did both would
 * otherwise file them on top of each other.
 */
function perChooserKey(effectIndex: number, playerId: PlayerId): string {
  return `${effectIndex}:by:${playerId}`;
}

type PlayerResolution =
  | { readonly kind: 'players'; readonly ids: PlayerId[] }
  | { readonly kind: 'choice'; readonly choice: PendingChoice };

/**
 * Turns a `PlayerSelector` into concrete seats, asking the controller to pick
 * when `opponent` is ambiguous.
 *
 * With two seats "your opponent" has exactly one answer and nothing pauses;
 * with three or four the controller must say who they mean, because the engine
 * is not allowed to choose a victim on their behalf (CLAUDE.md §12).
 */
function resolveEffectPlayers(
  ctx: MatchContext,
  item: ResolutionItem,
  effectIndex: number,
  effect: EffectDefinition,
  selector: PlayerSelector,
  /**
   * Namespace for the stored answer. One instruction can resolve two different
   * player selectors — the recipients of a `discard`, and the seats a
   * distributed target selector asks — so they may not share a key.
   */
  keySuffix: 'player' | 'chooser' = 'player',
): PlayerResolution {
  const key = `${effectIndex}:${keySuffix}`;
  const stored = item.selections[key];
  if (stored !== undefined) {
    return { kind: 'players', ids: stored.filter((id) => ctx.state.players[id] !== undefined) };
  }

  const direct = resolvePlayerSelector(ctx, selector, item.controllerId);
  if (direct !== null) return { kind: 'players', ids: direct };

  const candidates = playerCandidates(
    ctx,
    { kind: 'player', relation: 'opponent', selection: 'player_choice' },
    item.controllerId,
  );
  return {
    kind: 'choice',
    choice: buildChoice(ctx, item, effectIndex, effect, {
      playerId: item.controllerId,
      type: 'select_players',
      reason: 'select_opponent',
      zone: null,
      minimum: 1,
      maximum: 1,
      validEntityIds: candidates,
      selectionKey: key,
      targetRelation: 'opponent',
    }),
  };
}

/** Which player answers a target choice. Falls back to the controller. */
function chooserFor(ctx: MatchContext, selector: TargetSelector, controllerId: PlayerId): PlayerId {
  const players = resolvePlayerSelector(ctx, selector.chooser, controllerId);
  return players?.[0] ?? controllerId;
}

/**
 * "**Each player** chooses …" — one selection made by several seats (M02.5).
 *
 * Three properties hold, and each of them is a rule rather than an
 * implementation detail:
 *
 *  - **Nothing is applied until every answer is in.** The function only ever
 *    returns targets once the last seat has answered, so a seat asked later
 *    decides against exactly the board the first seat saw. Resolving the
 *    selections one at a time would hand every seat after the first information
 *    the card never granted them, which is what M02.5 forbids.
 *  - **Each seat's legal set is computed from its own point of view.** That is
 *    the whole of "one Unit **they** control": the selector's `controller` is
 *    read relative to the seat being asked. With the default `self` chooser the
 *    seat being asked *is* the ability's controller, so nothing else changes.
 *  - **The order is the selector's own.** `all_players` is the controller then
 *    clockwise and `each_opponent` is clockwise, which is the ordering every
 *    other multi-seat effect already uses. It fixes both who is asked first and
 *    the order the collected targets are then acted on.
 *
 * A seat with no legal option is not asked and contributes nothing; a seat
 * eliminated before the collection finishes drops out of the selector and takes
 * its stored answer with it. An answer that has stopped being legal by the time
 * the last seat replies is dropped on the same re-validation every other stored
 * selection goes through.
 */
function resolveDistributed(
  ctx: MatchContext,
  item: ResolutionItem,
  effectIndex: number,
  effect: EffectDefinition,
  // Both kinds that carry a selector, because this function reads nothing else
  // off the target. A distributed `entity_or_player` is rejected by the card
  // schema today; widening the parameter is still cheaper and safer than a cast
  // that would go stale the moment that changes.
  target: Extract<TargetDefinition, { kind: 'entity' | 'entity_or_player' }>,
  scope: TargetScope,
): TargetResolution {
  const selector = target.selector;
  const resolved = resolveEffectPlayers(
    ctx,
    item,
    effectIndex,
    effect,
    selector.chooser,
    'chooser',
  );
  if (resolved.kind === 'choice') return { kind: 'choice', choice: resolved.choice };

  const collected: InstanceId[] = [];
  for (const chooserId of resolved.ids) {
    const chooserKey = perChooserKey(effectIndex, chooserId);
    const own = legalTargets(ctx, target, { ...scope, controllerId: chooserId });
    const answer = item.selections[chooserKey];
    if (answer !== undefined) {
      collected.push(...answer.filter((id) => own.includes(id)));
      continue;
    }
    if (own.length === 0) {
      // Nothing to name is not a refusal and not a failure: the seat simply has
      // no share in this instruction, and everyone else still answers.
      item.selections[chooserKey] = [];
      continue;
    }
    const wanted = requestedCount(selector, own.length);
    return {
      kind: 'choice',
      choice: buildChoice(ctx, item, effectIndex, effect, {
        playerId: chooserId,
        type: selector.zone === 'battlefield' ? 'select_units' : 'select_cards',
        reason: 'each_player_choice',
        zone: selector.zone,
        minimum: selector.optional ? 0 : wanted,
        maximum: wanted,
        validEntityIds: own,
        selectionKey: chooserKey,
        // The legal set was computed with this seat as the controller, so the
        // selector's own `controller` already reads from where it is sitting.
        targetRelation: selector.controller,
      }),
    };
  }
  return { kind: 'entities', ids: collected };
}

type TargetResolution =
  | { readonly kind: 'entities'; readonly ids: InstanceId[] }
  | { readonly kind: 'players'; readonly ids: PlayerId[] }
  | { readonly kind: 'choice'; readonly choice: PendingChoice }
  | { readonly kind: 'fizzle' };

/**
 * Turns a target definition into concrete recipients, asking the right player
 * when the definition calls for a choice.
 *
 * On resume, previously chosen targets are re-checked against the current legal
 * set: a target that has become invalid is dropped and the rest of the
 * instruction still resolves (CLAUDE.md §4). That is also what removes a player
 * who was eliminated between choosing and resolving.
 */
function resolveTargets(
  ctx: MatchContext,
  item: ResolutionItem,
  effectIndex: number,
  effect: EffectDefinition,
  target: TargetDefinition,
): TargetResolution {
  if (target.kind === 'player' || target.kind === 'players') {
    const candidates = playerCandidates(ctx, target, item.controllerId);
    const stored = item.selections[String(effectIndex)];
    if (stored !== undefined) {
      return { kind: 'players', ids: stored.filter((id) => candidates.includes(id)) };
    }
    if (candidates.length === 0) return { kind: 'fizzle' };
    if (target.kind === 'players') return { kind: 'players', ids: candidates };
    if (candidates.length === 1) return { kind: 'players', ids: candidates };

    return {
      kind: 'choice',
      choice: buildChoice(ctx, item, effectIndex, effect, {
        playerId: item.controllerId,
        type: 'select_players',
        reason: 'select_opponent',
        zone: null,
        minimum: 1,
        maximum: 1,
        validEntityIds: candidates,
        targetRelation: 'opponent',
      }),
    };
  }

  // "It", meaning whatever the step before this one acted on. Resolved here
  // rather than in `legalTargets` because only this function knows which step is
  // being executed, and the answer is a record on the item rather than a query
  // over the board (M02.4).
  const candidates =
    target.kind === 'previous_target'
      ? (item.selections[targetsKey(effectIndex - 1)] ?? []).filter(
          (id) => findInstance(ctx.state, id)?.zone === 'battlefield',
        )
      : legalTargets(ctx, target, scopeOf(item));
  const stored = item.selections[String(effectIndex)];
  /**
   * Files the instances an instruction actually acted on, so the instruction
   * after it can point at the same ones.
   *
   * This is what `previous_target` on a delayed ability reads — the "it" in
   * "Target friendly Unit gains +3 ATK. When **it** is defeated …" — and it is
   * kept in `selections` rather than in a new field for the reason `selections`
   * exists at all: it is the per-step, serializable, replay-safe record of what
   * this item resolved with, and a paused item has to resume with the same
   * answer after a JSON round trip. A derived key rather than an authored one,
   * under a namespace nothing else uses.
   */
  const remember = (ids: readonly InstanceId[]): InstanceId[] => {
    item.selections[targetsKey(effectIndex)] = [...ids];
    return [...ids];
  };
  // A Token-group target reaches every Token sharing the chosen one's
  // definition and controller. Expanded here, after the choice, because the
  // group is a consequence of naming one Token rather than a wider option set
  // (rule adjustment §8).
  const groupSelector = entitySelectorOf(target);
  const group = (ids: readonly InstanceId[]): InstanceId[] =>
    groupSelector ? expandTokenGroup(ctx, groupSelector, ids) : [...ids];

  if (stored !== undefined) {
    return {
      kind: 'entities',
      ids: remember(group(stored.filter((id) => candidates.includes(id)))),
    };
  }
  if (
    target.kind === 'source' ||
    target.kind === 'trigger_subject' ||
    // "Units blocked by this Unit" names a set the combat already decided;
    // there is nothing for a player to choose, and every member is affected.
    target.kind === 'blocked_by_source' ||
    // "It" was chosen one step ago. Asking again is the bug this exists to fix.
    target.kind === 'previous_target'
  ) {
    return candidates.length > 0
      ? { kind: 'entities', ids: remember(candidates) }
      : { kind: 'fizzle' };
  }

  const selector = target.selector;

  // "Each player chooses …". Handled before the legal set above is consulted at
  // all, because that set was computed from the controller's point of view and
  // a distributed selection has as many points of view as it has seats.
  if (isDistributedSelection(selector)) {
    const distributed = resolveDistributed(ctx, item, effectIndex, effect, target, scopeOf(item));
    return distributed.kind === 'entities'
      ? { kind: 'entities', ids: remember(group(distributed.ids)) }
      : distributed;
  }

  if (candidates.length === 0) {
    return selector.optional ? { kind: 'entities', ids: remember([]) } : { kind: 'fizzle' };
  }

  if (selector.selection === 'player_choice') {
    const maximum = requestedCount(selector, candidates.length);
    const chooserId = chooserFor(ctx, selector, item.controllerId);
    return {
      kind: 'choice',
      choice: buildChoice(ctx, item, effectIndex, effect, {
        playerId: chooserId,
        type: selector.zone === 'battlefield' ? 'select_units' : 'select_cards',
        reason: 'effect_target',
        zone: selector.zone,
        minimum: selector.optional ? 0 : maximum,
        maximum,
        validEntityIds: candidates,
        targetRelation: targetRelationFor(selector.controller, chooserId, item.controllerId),
      }),
    };
  }

  return { kind: 'entities', ids: remember(group(autoSelect(ctx, selector, candidates))) };
}

/** Selection key under which one instruction's resolved entity targets are filed. */
function targetsKey(effectIndex: number): string {
  return `${effectIndex}:targets`;
}

/** Whether a source's damage is lethal regardless of amount (Venom). */
function damageIsLethal(ctx: MatchContext, sourceInstanceId: InstanceId | null): boolean {
  const source = sourceInstanceId ? findInstance(ctx.state, sourceInstanceId) : undefined;
  return source !== undefined && hasKeyword(source, definitionOf(ctx.database, source), 'venom');
}

/**
 * "Deal N damage … the damage may be divided among targets" (M02.5).
 *
 * The chooser allocates the total one point at a time, and the answer is the
 * allocation: a list with one entry per point, so `[a, a, b]` is two damage to
 * `a` and one to `b`. That shape is what makes the validation the tranche asks
 * for fall out of checks the engine already performs — every entry has to be a
 * legal target and the list has to be exactly as long as the total, which is the
 * same thing as "non-negative integers summing to N" — without a second payload
 * type crossing the protocol.
 *
 * Each target is damaged **once**, for its whole share. Two damage split off a
 * five-damage total is one two-damage event, not two one-damage events, because
 * Barrier and prevention are measured against a damage event and splitting it
 * further would let a shield absorb the same allocation twice.
 *
 * The targets are damaged in board order rather than in the order the chooser
 * happened to click, so two answers that describe the same allocation produce
 * the same match, event for event.
 *
 * An `entity_or_player` pool adds players to that same allocation — "divide it
 * among enemy Units **and opponents**" (M07.8). Nothing about the allocation
 * changes: every point still names one member of one pool, a member still takes
 * its whole share as a single event, and the players are damaged after the
 * entities in seat order, so the ordering stays fixed. Only the dispatch differs,
 * because a player takes damage through `damagePlayer` and a unit through
 * `damageUnit`.
 */
function divideDamage(
  ctx: MatchContext,
  item: ResolutionItem,
  effect: Extract<EffectDefinition, { type: 'deal_damage' }>,
  target: Extract<TargetDefinition, { kind: 'entity' | 'entity_or_player' }>,
  effectIndex: number,
  total: number,
): EffectOutcome {
  const entityCandidates = legalTargets(ctx, target, scopeOf(item));
  const playerPool =
    target.kind === 'entity_or_player'
      ? (resolvePlayerSelector(ctx, target.players, item.controllerId) ?? [])
      : [];
  const candidates = [...entityCandidates, ...playerPool];
  // Nothing to divide is not an error: "sacrifice up to five Units" that took
  // none leaves a total of zero, and the card simply deals no damage.
  if (total <= 0 || candidates.length === 0) return { kind: 'fizzled', reason: 'no_legal_target' };

  const stored = item.selections[String(effectIndex)];
  if (stored === undefined) {
    const chooserId = chooserFor(ctx, target.selector, item.controllerId);
    return {
      kind: 'awaiting_choice',
      choice: buildChoice(ctx, item, effectIndex, effect, {
        playerId: chooserId,
        type: 'divide_damage',
        reason: 'divide_damage',
        zone: target.selector.zone,
        minimum: total,
        maximum: total,
        validEntityIds: candidates,
        targetRelation: targetRelationFor(target.selector.controller, chooserId, item.controllerId),
      }),
    };
  }

  // Re-validated on resume like every other stored selection: a target that has
  // left the legal set drops out, and its share of the damage is simply not
  // dealt. The rest of the allocation still lands.
  //
  // The two pools are re-derived separately rather than classified by the shape
  // of the ID, so an entry is a seat only when it really is one of the seats this
  // instruction offered. The player pool is consulted first; seat IDs are chosen
  // by the lobby and instance IDs are minted by the engine as `inst_NNNN`, so the
  // two namespaces do not overlap in practice, and the precedence is written down
  // rather than left to whichever lookup ran first.
  const allocation = new Map<string, number>();
  for (const id of stored) {
    if (!playerPool.includes(id) && !entityCandidates.includes(id)) continue;
    allocation.set(id, (allocation.get(id) ?? 0) + 1);
  }
  if (allocation.size === 0) return { kind: 'fizzled', reason: 'no_legal_target' };

  const lethal = damageIsLethal(ctx, item.sourceInstanceId);
  const dealt: InstanceId[] = [];
  for (const instanceId of entityCandidates) {
    const amount = allocation.get(instanceId);
    if (amount === undefined) continue;
    dealt.push(instanceId);
    damageUnit(ctx, instanceId, amount, { sourceInstanceId: item.sourceInstanceId, lethal });
  }
  for (const playerId of playerPool) {
    const amount = allocation.get(playerId);
    if (amount === undefined) continue;
    damagePlayer(ctx, playerId, amount, { sourceInstanceId: item.sourceInstanceId });
  }
  // Filed like any other instruction's targets, so a following "it" or
  // `previous_targets` sees what this step actually hit. Players are left out
  // deliberately: the record is a list of instances, and a following "it" that
  // found a seat in it would be pointing at something with no card to act on.
  item.selections[targetsKey(effectIndex)] = dealt;
  return RESOLVED;
}

/**
 * Executes one instruction. Never loops, never resolves more than a single
 * atomic step, and never advances the queue: the caller owns sequencing.
 *
 * A multi-recipient instruction (`each_opponent`, `all_players`) resolves every
 * recipient inside this one call, so simultaneous loss is a draw rather than a
 * race decided by iteration order (CLAUDE.md §12).
 */
export function executeEffect(
  ctx: MatchContext,
  item: ResolutionItem,
  effect: EffectDefinition,
  effectIndex: number,
): EffectOutcome {
  const key = String(effectIndex);
  const scope = scopeOf(item);

  // An instruction's own `if` is checked here, at resolution, not when its card
  // was played (ruleset update §15). A skipped instruction is not a failure: the
  // rest of the card still resolves, which is what "Draw a card. If …, draw
  // another" means.
  if (effect.condition && !evaluateCondition(ctx, effect.condition, scope)) {
    return { kind: 'fizzled', reason: 'condition_unmet' };
  }

  // "You may …". Asked after the condition, so a step whose `if` already failed
  // is never put to a player as a decision they might make (ruleset update
  // §15).
  if (effect.optional) {
    const mayKey = `${effectIndex}:may`;
    const answer = item.selections[mayKey];
    if (answer === undefined) {
      // Nothing to act on means nothing to decide. The same instinct that keeps
      // a Reaction window shut when nobody can use it: an offer with one
      // possible outcome is a pause, not a choice.
      if (!hasRecipient(ctx, item, effect)) return { kind: 'fizzled', reason: 'no_legal_target' };
      return {
        kind: 'awaiting_choice',
        choice: buildChoice(ctx, item, effectIndex, effect, {
          playerId: item.controllerId,
          type: 'confirm',
          reason: 'optional_effect',
          zone: null,
          minimum: 1,
          maximum: 1,
          validEntityIds: ['yes', 'no'],
          selectionKey: mayKey,
          // "Yes" is not a card anybody controls, so there is no entity for the
          // relation to be about. The intent recorded beside it is still the
          // instruction's own: it says what saying yes would go on to do.
          targetRelation: 'none',
        }),
      };
    }
    if (answer[0] !== 'yes') return { kind: 'fizzled', reason: 'declined' };
  }

  /**
   * Resolves an amount that may be a count of the board, or a number read off
   * the statline of the card this instruction is acting on.
   *
   * `targetInstanceId` is passed per recipient rather than once per instruction,
   * because "each friendly Unit gains Health equal to its ATK" is three
   * different numbers for three units — and because the statline is read here,
   * at resolution, not when the ability was queued or the target chosen (M02.3).
   */
  /**
   * How many entities the step before this one resolved with, for a
   * `previous_targets` amount — the "each Unit sacrificed" of a card whose first
   * sentence did the sacrificing (M02.5). Read from the same record the
   * `previous_target` target kind reads, so the two halves of such a card can
   * never disagree about what happened.
   */
  const previousTargetCount = (item.selections[targetsKey(effectIndex - 1)] ?? []).length;
  const value = (expression: ValueExpression, targetInstanceId?: InstanceId): number =>
    evaluateValue(ctx, expression, {
      ...scope,
      targetInstanceId: targetInstanceId ?? null,
      previousTargetCount,
    });
  const signed = (expression: SignedValueExpression, targetInstanceId?: InstanceId): number =>
    evaluateSignedValue(ctx, expression, {
      ...scope,
      targetInstanceId: targetInstanceId ?? null,
      previousTargetCount,
    });

  switch (effect.type) {
    case 'draw': {
      const players = resolveEffectPlayers(ctx, item, effectIndex, effect, effect.player);
      if (players.kind === 'choice') return { kind: 'awaiting_choice', choice: players.choice };
      for (const playerId of players.ids) drawCards(ctx, playerId, value(effect.amount));
      return RESOLVED;
    }

    case 'discard': {
      const players = resolveEffectPlayers(ctx, item, effectIndex, effect, effect.player);
      if (players.kind === 'choice') return { kind: 'awaiting_choice', choice: players.choice };

      // Each discarding player answers separately, in the order the selector
      // produced them (clockwise for `each_opponent`), and the answers are
      // filed under per-player keys so a reconnect resumes at the right one.
      for (const playerId of players.ids) {
        const playerKey = perPlayerKey(effectIndex, playerId);
        const stored = item.selections[playerKey];
        if (stored !== undefined) {
          for (const instanceId of stored) {
            const instance = findInstance(ctx.state, instanceId);
            if (instance && instance.zone === 'hand') discardCard(ctx, instance.owner, instanceId);
          }
          continue;
        }

        const hand = playerOf(ctx.state, playerId).hand;
        const amount = Math.min(value(effect.amount), hand.length);
        if (amount === 0) {
          item.selections[playerKey] = [];
          continue;
        }

        if (effect.selection === 'player_choice') {
          return {
            kind: 'awaiting_choice',
            choice: buildChoice(ctx, item, effectIndex, effect, {
              playerId,
              type: 'select_cards',
              reason: 'discard_effect',
              zone: 'hand',
              minimum: amount,
              maximum: amount,
              validEntityIds: hand,
              selectionKey: playerKey,
              // A discard is always out of the discarding seat's own hand,
              // whoever printed the instruction that is making them do it.
              targetRelation: 'self',
            }),
          };
        }

        const picked =
          effect.selection === 'random'
            ? autoSelect(ctx, { ...AUTO_SELECTOR, count: amount, selection: 'random' }, hand)
            : hand.slice(0, amount);
        for (const instanceId of picked) discardCard(ctx, playerId, instanceId);
        item.selections[playerKey] = [];
      }
      return RESOLVED;
    }

    case 'deal_damage': {
      // "The damage may be divided among targets" is a different instruction
      // underneath: one total, allocated by a player, rather than one amount
      // repeated at every recipient (M02.5).
      if (
        effect.divided === true &&
        (effect.target.kind === 'entity' || effect.target.kind === 'entity_or_player')
      ) {
        return divideDamage(ctx, item, effect, effect.target, effectIndex, value(effect.amount));
      }

      const resolution = resolveTargets(ctx, item, effectIndex, effect, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind === 'fizzle') return { kind: 'fizzled', reason: 'no_legal_target' };

      if (resolution.kind === 'players') {
        for (const playerId of resolution.ids) {
          damagePlayer(ctx, playerId, value(effect.amount), {
            sourceInstanceId: item.sourceInstanceId,
          });
        }
        return RESOLVED;
      }

      const lethal = damageIsLethal(ctx, item.sourceInstanceId);

      for (const targetId of resolution.ids) {
        damageUnit(ctx, targetId, value(effect.amount, targetId), {
          sourceInstanceId: item.sourceInstanceId,
          lethal,
        });
      }
      return RESOLVED;
    }

    case 'heal': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind === 'fizzle') return { kind: 'fizzled', reason: 'no_legal_target' };
      if (resolution.kind === 'players') {
        for (const playerId of resolution.ids) healPlayer(ctx, playerId, value(effect.amount));
        return RESOLVED;
      }
      for (const targetId of resolution.ids)
        healUnit(ctx, targetId, value(effect.amount, targetId));
      return RESOLVED;
    }

    case 'modify_stats': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind !== 'entities') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) {
        const instance = findInstance(ctx.state, targetId);
        if (!instance) continue;
        // Read once per recipient and reused for both the modifier and the
        // event, so the log can never report a different number from the one
        // that was applied.
        const attack = signed(effect.attack, targetId);
        const health = signed(effect.health, targetId);
        instance.statModifiers.push({
          attack,
          health,
          duration: effect.duration,
          sourceInstanceId: item.sourceInstanceId,
          appliedOnTurn: ctx.state.turn,
        });
        emit(ctx, {
          type: 'stats_modified',
          instanceId: targetId,
          attack,
          health,
          duration: effect.duration,
        });
      }
      return RESOLVED;
    }

    case 'grant_keyword':
    case 'remove_keyword': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind !== 'entities') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) {
        const instance = findInstance(ctx.state, targetId);
        if (!instance) continue;
        const modifier = {
          keyword: effect.keyword,
          duration: effect.duration,
          sourceInstanceId: item.sourceInstanceId,
          appliedOnTurn: ctx.state.turn,
        };
        if (effect.type === 'grant_keyword') {
          instance.grantedKeywords.push(modifier);
          emit(ctx, {
            type: 'keyword_granted',
            instanceId: targetId,
            keyword: effect.keyword,
            duration: effect.duration,
          });
        } else {
          instance.removedKeywords.push(modifier);
          emit(ctx, {
            type: 'keyword_removed',
            instanceId: targetId,
            keyword: effect.keyword,
            duration: effect.duration,
          });
        }
      }
      return RESOLVED;
    }

    case 'create_token': {
      const players = resolveEffectPlayers(ctx, item, effectIndex, effect, effect.controller);
      if (players.kind === 'choice') return { kind: 'awaiting_choice', choice: players.choice };
      const definition = ctx.database.get(effect.tokenCardId);
      if (!definition) return { kind: 'fizzled', reason: 'unsupported' };

      const tokenCount = value(effect.amount);
      for (const playerId of players.ids) {
        const created: InstanceId[] = [];
        for (let i = 0; i < tokenCount; i += 1) {
          const player = playerOf(ctx.state, playerId);
          // Every requested token is created. There is no battlefield limit to
          // run out of, so the old "not created at all" outcome is gone
          // (ruleset update §7).
          const token = createInstance(ctx, definition.id, playerId, 'battlefield', {
            isToken: true,
          });
          player.units.push(token.instanceId);
          created.push(token.instanceId);
          // A Token is created straight onto the battlefield rather than moved
          // there, so its arrival is put through the replacement layer here —
          // before either arrival event, so nothing ever sees the Token in the
          // state it would have arrived in (M02.4).
          applyArrivalReplacements(ctx, token.instanceId, 'token_created');
          emit(ctx, {
            type: 'token_created',
            playerId,
            instanceId: token.instanceId,
            definitionId: definition.id,
          });
          // A token arrives on the battlefield without being deployed: it was
          // never played and never paid for, so it fires the entry event and not
          // the deployment one (rule adjustment §7).
          emit(ctx, {
            type: 'unit_entered_battlefield',
            playerId,
            instanceId: token.instanceId,
            definitionId: definition.id,
            method: 'token_created',
          });

          // A token entering play resolves its own deploy effects, exactly as a
          // played unit does — one authoring form for deploy behaviour
          // (CLAUDE.md §17 Q1). Appended, so the rest of this instruction
          // finishes first (Q28).
          if (definition.effects.length > 0) {
            enqueue(ctx, {
              kind: 'card_effects',
              sourceInstanceId: token.instanceId,
              sourceDefinitionId: definition.id,
              controllerId: playerId,
              abilityId: null,
              effects: [...definition.effects],
              causeSequence: ctx.state.sequence,
              completesSpell: false,
            });
          }
        }

        // One event for the whole batch, after every token has arrived. "Whenever
        // you create one or more Tokens" fires once for a five-token instruction,
        // not five times, and the ability that reacts sees the finished board
        // rather than a partly-built one (ruleset update §13).
        if (created.length > 0) {
          emit(ctx, {
            type: 'tokens_created',
            playerId,
            definitionId: definition.id,
            instanceIds: created,
            count: created.length,
          });
        }
      }
      return RESOLVED;
    }

    case 'destroy':
    case 'sacrifice': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind !== 'entities') return { kind: 'fizzled', reason: 'no_legal_target' };

      for (const targetId of resolution.ids) defeatUnit(ctx, targetId, effect.type);
      return RESOLVED;
    }

    case 'return_to_hand': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind !== 'entities') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) moveToZone(ctx, targetId, 'hand');
      return RESOLVED;
    }

    case 'counter': {
      const entry = counterTarget(ctx);
      // Nothing left to counter: everything above this Reaction already
      // resolved, and there was nothing underneath it. The Reaction still goes
      // to the discard — a countered card and a card that found no target both
      // cost their controller the card.
      if (!entry || entry.instanceId === item.sourceInstanceId) {
        return { kind: 'fizzled', reason: 'no_legal_target' };
      }

      if (effect.unlessPays > 0) {
        const stored = item.selections[key];
        const controller = playerOf(ctx.state, entry.controllerId);

        if (stored === undefined) {
          // A controller who cannot pay is never asked: the offer would have
          // exactly one legal answer, and pausing the queue for it would be a
          // choice in name only.
          if (controller.energy >= effect.unlessPays) {
            return {
              kind: 'awaiting_choice',
              choice: buildChoice(ctx, item, effectIndex, effect, {
                playerId: entry.controllerId,
                type: 'confirm',
                reason: 'pay_additional_cost',
                zone: null,
                minimum: 1,
                maximum: 1,
                validEntityIds: ['yes', 'no'],
                targetRelation: 'none',
              }),
            };
          }
        } else if (stored[0] === 'yes' && controller.energy >= effect.unlessPays) {
          controller.energy -= effect.unlessPays;
          return RESOLVED;
        }
      }

      entry.countered = true;
      entry.counteredByInstanceId = item.sourceInstanceId;
      return RESOLVED;
    }

    case 'move_card': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind !== 'entities') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) {
        // `entersExhausted` is part of the arrival, not a step after it: the
        // card is put onto the battlefield already Exhausted, so nothing —
        // including a state-based check or a trigger discovered between two
        // instructions — ever sees it Ready (M02.2).
        moveToZone(ctx, targetId, effect.toZone, { exhausted: effect.entersExhausted === true });
      }
      return RESOLVED;
    }

    case 'exhaust':
    case 'ready': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind !== 'entities') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) {
        const instance = findInstance(ctx.state, targetId);
        if (!instance) continue;
        const shouldExhaust = effect.type === 'exhaust';
        if (instance.exhausted === shouldExhaust) continue;
        instance.exhausted = shouldExhaust;
        emit(ctx, {
          type: shouldExhaust ? 'unit_exhausted' : 'unit_readied',
          instanceId: targetId,
        });
      }
      return RESOLVED;
    }

    case 'skip_next_ready': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind !== 'entities') return { kind: 'fizzled', reason: 'no_legal_target' };
      for (const targetId of resolution.ids) {
        applyReadySkip(ctx, targetId, item.sourceInstanceId);
      }
      return RESOLVED;
    }

    case 'prevent_damage': {
      const resolution = resolveTargets(ctx, item, effectIndex, effect, effect.target);
      if (resolution.kind === 'choice')
        return { kind: 'awaiting_choice', choice: resolution.choice };
      if (resolution.kind === 'fizzle') return { kind: 'fizzled', reason: 'no_legal_target' };
      if (resolution.kind === 'players') {
        for (const playerId of resolution.ids) {
          addDamageShield(
            ctx,
            { playerId },
            value(effect.amount),
            effect.duration,
            item.sourceInstanceId,
          );
        }
        return RESOLVED;
      }
      for (const targetId of resolution.ids) {
        addDamageShield(
          ctx,
          { instanceId: targetId },
          value(effect.amount, targetId),
          effect.duration,
          item.sourceInstanceId,
        );
      }
      return RESOLVED;
    }

    case 'modify_cost': {
      const players = resolveEffectPlayers(ctx, item, effectIndex, effect, effect.player);
      if (players.kind === 'choice') return { kind: 'awaiting_choice', choice: players.choice };
      for (const playerId of players.ids) {
        playerOf(ctx.state, playerId).costModifiers.push({
          delta: effect.delta,
          filter: effect.filter ?? null,
          duration: effect.duration,
          appliedOnTurn: ctx.state.turn,
          sourceInstanceId: item.sourceInstanceId,
        });
        emit(ctx, {
          type: 'cost_modified',
          playerId,
          delta: effect.delta,
          duration: effect.duration,
        });
      }
      return RESOLVED;
    }

    case 'search_zone': {
      const players = resolveEffectPlayers(ctx, item, effectIndex, effect, effect.player);
      if (players.kind === 'choice') return { kind: 'awaiting_choice', choice: players.choice };
      const searcher = players.ids[0];
      if (searcher === undefined) return RESOLVED;

      // The window the search sees: the whole zone, or only the top few cards
      // when the card says "look at the top N" (ruleset update §16).
      const window = zoneContents(ctx, searcher, effect.zone);
      const looked = effect.fromTop === undefined ? window : window.slice(0, effect.fromTop);

      /**
       * Puts the cards that were looked at but not taken on the bottom, in the
       * order they were in.
       *
       * Deliberately not followed by a shuffle. A full-zone search shuffles
       * because it reordered a hidden zone by rummaging through it; a
       * look-at-the-top effect has *told* the player what is now on the bottom,
       * and shuffling it away would make the card say something it does not do.
       */
      const settleRemainder = (taken: readonly InstanceId[]): void => {
        // A look-at-the-top effect never shuffles, whatever the remainder rule
        // says. Shuffling exists because a full-zone search rummaged through a
        // hidden zone; looking at three cards told the player what is there, and
        // hiding it again would make the card say something it does not do.
        if (effect.fromTop !== undefined) {
          if (effect.remainder !== 'bottom') return;
          for (const instanceId of looked) {
            if (taken.includes(instanceId)) continue;
            // Already in the deck: move it within the zone, to the bottom.
            const player = playerOf(ctx.state, searcher);
            const index = player.deck.indexOf(instanceId);
            if (index >= 0) {
              player.deck.splice(index, 1);
              player.deck.push(instanceId);
            }
          }
          return;
        }
        // Searching a hidden zone reorders it, so it is shuffled afterwards.
        if (effect.zone === 'deck') shuffleDeck(ctx, searcher);
      };

      const stored = item.selections[key];
      if (stored !== undefined) {
        for (const instanceId of stored) {
          // "Put one on the bottom" keeps the card in the zone it came from, so
          // there is no zone change for `moveToZone` to make — it would see
          // deck-to-deck and return without doing anything. Reordering within
          // the zone is the whole effect here, so it is done directly.
          if (effect.destination === effect.zone && effect.zone === 'deck') {
            const player = playerOf(ctx.state, searcher);
            const index = player.deck.indexOf(instanceId);
            if (index >= 0) {
              player.deck.splice(index, 1);
              player.deck.push(instanceId);
            }
            continue;
          }
          moveToZone(ctx, instanceId, effect.destination);
        }
        if (effect.reveal && stored.length > 0) {
          emit(ctx, {
            type: 'cards_revealed',
            playerId: searcher,
            instanceIds: stored,
            definitionIds: stored.map(
              (id) => findInstance(ctx.state, id)?.definitionId ?? 'unknown_card',
            ),
          });
        }
        settleRemainder(stored);
        return RESOLVED;
      }

      const candidates = looked.filter((instanceId) => {
        if (!effect.filter) return true;
        const instance = findInstance(ctx.state, instanceId);
        if (!instance) return false;
        return matchesCardFilter(definitionOf(ctx.database, instance), instance, effect.filter);
      });

      if (candidates.length === 0) {
        // Nothing matched, but the cards were still looked at, so the remainder
        // clause still applies.
        settleRemainder([]);
        return RESOLVED;
      }

      const maximum = Math.min(effect.amount, candidates.length);
      // Searching a *public* zone is mandatory when a legal result exists; a
      // hidden zone may always legally find nothing (CLAUDE.md §17 Q25). A
      // look-at-the-top effect counts as public for this purpose: the cards were
      // shown to the chooser, so "put one on the bottom" with no "may" is a
      // decision they can and must make.
      const revealedByLooking = effect.fromTop !== undefined;
      const mandatory = (PUBLIC_ZONES.has(effect.zone) || revealedByLooking) && !effect.upTo;

      return {
        kind: 'awaiting_choice',
        choice: buildChoice(ctx, item, effectIndex, effect, {
          playerId: searcher,
          type: 'select_cards',
          reason: 'search_zone',
          zone: effect.zone,
          minimum: mandatory ? maximum : 0,
          maximum,
          validEntityIds: candidates,
          // A search always rummages through the searcher's own zone.
          targetRelation: 'self',
        }),
      };
    }

    case 'reorder_zone': {
      const players = resolveEffectPlayers(ctx, item, effectIndex, effect, effect.player);
      if (players.kind === 'choice') return { kind: 'awaiting_choice', choice: players.choice };
      const playerId = players.ids[0];
      if (playerId === undefined) return RESOLVED;

      const contents = zoneContents(ctx, playerId, effect.zone);
      const window = contents.slice(0, effect.amount);
      if (window.length <= 1) return RESOLVED;

      const stored = item.selections[key];
      if (stored !== undefined) {
        const player = playerOf(ctx.state, playerId);
        if (effect.zone === 'deck') {
          player.deck = [...stored, ...player.deck.slice(window.length)];
        }
        emit(ctx, {
          type: 'zone_reordered',
          playerId,
          zone: effect.zone,
          count: stored.length,
        });
        return RESOLVED;
      }

      return {
        kind: 'awaiting_choice',
        choice: buildChoice(ctx, item, effectIndex, effect, {
          playerId,
          type: 'order_cards',
          reason: 'reorder_zone',
          zone: effect.zone,
          minimum: window.length,
          maximum: window.length,
          validEntityIds: window,
          ordered: true,
          // The seat asked to order a zone is the seat whose zone it is.
          targetRelation: 'self',
        }),
      };
    }

    case 'schedule_delayed': {
      // The delayed body is read from the card that printed it, so a card whose
      // definition is missing schedules nothing rather than an empty promise.
      const definitionId = item.sourceDefinitionId;
      const definition = definitionId === null ? undefined : ctx.database.get(definitionId);
      const ability = definition?.delayedAbilities.find(
        (entry) => entry.id === effect.delayedAbilityId,
      );
      if (!definition || !ability) return { kind: 'fizzled', reason: 'unsupported' };

      // "It" is resolved now and stored as a concrete instance. `source` is the
      // card the text is printed on — which may already be in a discard pile,
      // because a `on_sacrifice` delayed clause is about the card that just
      // died. `previous_target` is whatever the instruction before this one
      // acted on, which the schema guarantees exists.
      const subjects: InstanceId[] =
        ability.subject === 'source'
          ? item.sourceInstanceId === null
            ? []
            : [item.sourceInstanceId]
          : ability.subject === 'previous_target'
            ? (item.selections[targetsKey(effectIndex - 1)] ?? [])
            : [];

      // A delayed clause that names a subject and found none is a clause about
      // nothing: the buff fizzled, or the source has ceased to exist. Scheduling
      // it anyway would promise the player an effect that can never fire.
      if (ability.subject !== undefined && subjects.length === 0) {
        return { kind: 'fizzled', reason: 'no_legal_target' };
      }

      // One entry per bound subject. With the single-target cards in the
      // catalog that is always one, and it is what keeps "when **it** is
      // defeated" honest if a future card buffs two units with one instruction.
      if (subjects.length === 0) {
        scheduleDelayed(ctx, {
          ability,
          sourceInstanceId: item.sourceInstanceId,
          sourceDefinitionId: definition.id,
          controllerId: item.controllerId,
          subjectInstanceId: null,
        });
        return RESOLVED;
      }
      for (const subjectInstanceId of subjects) {
        scheduleDelayed(ctx, {
          ability,
          sourceInstanceId: item.sourceInstanceId,
          sourceDefinitionId: definition.id,
          controllerId: item.controllerId,
          subjectInstanceId,
        });
      }
      return RESOLVED;
    }

    default: {
      // Exhaustiveness guard: a new effect type must be handled explicitly.
      const _never: never = effect;
      void _never;
      return { kind: 'fizzled', reason: 'unsupported' };
    }
  }
}

/**
 * Removes a unit from play as a destroy or a sacrifice.
 *
 * A sacrificed unit counts as defeated and fires both `on_sacrifice` and
 * `on_defeated`; the `reason` is retained so a future card can tell them apart
 * (CLAUDE.md §17 Q24). Shared with activation-cost payment, where sacrifice is
 * a cost rather than an effect (Q3).
 */
export function defeatUnit(
  ctx: MatchContext,
  instanceId: InstanceId,
  cause: 'destroy' | 'sacrifice',
): void {
  const instance = findInstance(ctx.state, instanceId);
  if (!instance || instance.zone !== 'battlefield') return;
  emit(ctx, {
    type: 'unit_defeated',
    instanceId,
    definitionId: instance.definitionId,
    controllerId: instance.controller,
    reason: cause === 'destroy' ? 'destroyed' : 'sacrificed',
  });
  restDefeated(ctx, instanceId);
}

/**
 * Puts a defeated permanent wherever it belongs.
 *
 * Ordinary cards go to the discard pile. A Commander goes back to its **Command
 * Zone** instead, its defeat count goes up by one, and its next deployment
 * therefore costs more (rule adjustment §2). That is the whole of the Commander
 * lifecycle: there is no Recovery Zone, no replay tax beyond the cost, and no
 * Commander-defeat loss condition.
 *
 * One function rather than a branch at each defeat site, because there are four
 * routes to a defeat — lethal damage, a state-based zero-Health check, `destroy`
 * and `sacrifice` — and a Commander that came back from three of them would be
 * worse than one that came back from none.
 */
export function restDefeated(ctx: MatchContext, instanceId: InstanceId): void {
  const instance = findInstance(ctx.state, instanceId);
  if (!instance) return;

  const owner = playerOf(ctx.state, instance.owner);
  if (owner.commanderInstanceId !== instanceId) {
    moveToZone(ctx, instanceId, 'discard', { silent: true });
    return;
  }

  owner.commanderDefeats += 1;
  moveToZone(ctx, instanceId, 'commander_zone', { silent: true });

  const definition = ctx.database.get(instance.definitionId);
  emit(ctx, {
    type: 'commander_returned',
    playerId: instance.owner,
    instanceId,
    definitionId: instance.definitionId,
    defeatCount: owner.commanderDefeats,
    deploymentCost: definition ? (commanderDeployCost(owner, definition, ctx.config) ?? 0) : 0,
  });
}

/** Zones every player can already see, where a search cannot be declined. */
const PUBLIC_ZONES = new Set<ZoneId>(['discard', 'battlefield', 'commander_zone']);

export function zoneContents(ctx: MatchContext, playerId: PlayerId, zone: ZoneId): InstanceId[] {
  const player = playerOf(ctx.state, playerId);
  switch (zone) {
    case 'deck':
      return [...player.deck];
    case 'hand':
      return [...player.hand];
    case 'discard':
      return [...player.discard];
    case 'battlefield':
      return [...player.units, ...player.relics];
    case 'commander_zone':
      return [player.commanderInstanceId];
    default:
      return [];
  }
}

/** Selector shape used when a non-target effect needs `autoSelect`'s randomness. */
const AUTO_SELECTOR: TargetSelector = {
  zone: 'hand',
  controller: 'self',
  count: 1,
  selection: 'random',
  chooser: 'self',
  optional: false,
  excludeSource: false,
};
