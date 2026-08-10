import type {
  AbilityDefinition,
  CardDefinition,
  CardId,
  EffectDefinition,
  TriggerId,
} from '@tcg/card-data';
import { emit, type MatchContext } from './context.js';
import { activeFirstOrder, findInstance, matchesCardFilter, playerOf } from './derive.js';
import { evaluateCondition } from './values.js';
import type { GameEvent } from './schema/event.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';
import type { ResolutionItem } from './schema/state.js';

/**
 * Trigger discovery.
 *
 * A trigger names an **event**; an ability's `scope` says which occurrences of
 * that event it listens to (ruleset update §15). That separation is what lets
 * one `on_defeated` mean "when this dies", "when *another* friendly Unit dies"
 * and "when any Unit dies" without three trigger IDs — and it is what the
 * v0.2 vocabulary could not express at all, because every trigger was
 * hard-wired to the card it was printed on.
 *
 * An ability with no `scope` keeps exactly the old self-referential meaning, so
 * every card authored before this still behaves identically.
 *
 * Three gates decide whether a candidate fires, in order:
 *
 *  1. **scope** — was the event about a card this ability cares about?
 *  2. **limit** — has it already fired this turn, if it is a "first time each
 *     turn" ability?
 *  3. **condition** — is its `if` true *now*?
 *
 * The condition is last and is re-checked at discovery rather than cached,
 * because "if a friendly Unit was defeated this turn" is a question about the
 * board at the moment the trigger fires.
 */

/** The card an event was about, when it was about one. */
interface EventSubject {
  readonly instanceId: InstanceId;
  readonly definitionId: CardId;
  readonly controllerId: PlayerId;
}

interface TriggerHit {
  readonly triggerId: TriggerId;
  readonly sourceInstanceId: InstanceId;
  readonly definitionId: CardId;
  readonly controllerId: PlayerId;
  readonly causeSequence: number;
  /**
   * The card the event was about. `null` for turn-phase triggers, which are
   * about a phase rather than a card.
   */
  readonly subject: EventSubject | null;
  /** Provenance of the event, for `excludeSelfCaused`. */
  readonly causedBySourceInstanceId: InstanceId | null;
}

/** Instances still in `state.instances` expose their ordinal; defeated tokens do not. */
function ordinalOf(ctx: MatchContext, instanceId: InstanceId): number {
  const instance = findInstance(ctx.state, instanceId);
  if (instance) return instance.ordinal;
  const parsed = Number.parseInt(instanceId.replace(/^\D+/, ''), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function permanentsOf(ctx: MatchContext, playerId: PlayerId): InstanceId[] {
  const player = playerOf(ctx.state, playerId);
  return [
    ...player.units,
    ...player.relics,
    // Commander passives function from the Commander zone (CLAUDE.md §4).
    player.commanderInstanceId,
  ];
}

/**
 * One occurrence of a trigger, before anybody has decided who listens to it.
 *
 * Separating "what happened" from "who cares" is the whole point: the old
 * discovery pass produced hits already bound to the card the event was about,
 * which is precisely why a scope was impossible to express.
 */
interface TriggerOccurrence {
  readonly triggerId: TriggerId;
  /** The card the event was about, or `null` for a turn-phase trigger. */
  readonly subject: EventSubject | null;
  /**
   * Whose turn it is, for the turn-phase triggers. A listener controlled by
   * this player hears `on_turn_*`; everyone else hears `on_opponent_turn_*`.
   */
  readonly turnPlayerId: PlayerId | null;
  readonly causeSequence: number;
  readonly causedBySourceInstanceId: InstanceId | null;
}

/** Turns one emitted event into the trigger occurrences it represents. */
function occurrencesFromEvent(ctx: MatchContext, event: GameEvent): TriggerOccurrence[] {
  const base = {
    causeSequence: event.sequence,
    causedBySourceInstanceId: event.cause.sourceInstanceId,
    turnPlayerId: null,
  } as const;

  const about = (
    triggerId: TriggerId,
    instanceId: InstanceId,
    definitionId: CardId,
    controllerId: PlayerId,
  ): TriggerOccurrence => ({
    ...base,
    triggerId,
    subject: { instanceId, definitionId, controllerId },
  });

  switch (event.type) {
    case 'attackers_declared':
      return event.instanceIds.flatMap((instanceId) => {
        const instance = findInstance(ctx.state, instanceId);
        return instance
          ? [about('on_attack', instanceId, instance.definitionId, instance.controller)]
          : [];
      });

    case 'blockers_assigned':
      return event.blocks.flatMap((block) => {
        const instance = findInstance(ctx.state, block.blockerInstanceId);
        return instance
          ? [about('on_block', block.blockerInstanceId, instance.definitionId, instance.controller)]
          : [];
      });

    case 'combat_survived': {
      const instance = findInstance(ctx.state, event.instanceId);
      if (!instance) return [];
      const occurrences = [
        about('on_survive_combat', event.instanceId, event.definitionId, instance.controller),
      ];
      // "Survived combat *as a blocker*" is a fact about the combat, not about
      // the card: the same unit surviving an attack it declared must not fire it
      // (ruleset update §15).
      if (event.asBlocker) {
        occurrences.push(
          about(
            'on_survive_combat_as_blocker',
            event.instanceId,
            event.definitionId,
            instance.controller,
          ),
        );
      }
      return occurrences;
    }

    case 'unit_defeated': {
      const occurrences = [
        about('on_defeated', event.instanceId, event.definitionId, event.controllerId),
      ];
      // A sacrifice fires both, sacrifice-first (CLAUDE.md §17 Q24).
      if (event.reason === 'sacrificed') {
        occurrences.unshift(
          about('on_sacrifice', event.instanceId, event.definitionId, event.controllerId),
        );
      }
      return occurrences;
    }

    case 'unit_deployed':
      return [about('on_deployed', event.instanceId, event.definitionId, event.playerId)];

    case 'unit_entered_battlefield':
      // The wider event: every arrival, however it happened. A normal
      // deployment produces both this and `on_deployed`, and the two stay
      // separate rather than one being folded into the other — the update
      // requires each existing card's intent to be reviewed individually
      // (rule adjustment §7).
      return [
        about('on_entered_battlefield', event.instanceId, event.definitionId, event.playerId),
      ];

    case 'token_created':
      // A token arriving is a deployment like any other, so "the first enemy
      // Unit deployed each turn" covers tokens without saying so.
      return [about('on_deployed', event.instanceId, event.definitionId, event.playerId)];

    case 'tokens_created': {
      const first = event.instanceIds[0];
      if (first === undefined) return [];
      // The batch is "about" the token definition that was created, so a scope
      // filtered to Goblins matches on the token's own card data.
      return [about('on_tokens_created', first, event.definitionId, event.playerId)];
    }

    case 'turn_started':
      return [{ ...base, triggerId: 'on_turn_start', subject: null, turnPlayerId: event.playerId }];

    case 'phase_changed':
      if (event.to !== 'turn_end') return [];
      return [
        {
          ...base,
          triggerId: 'on_turn_end',
          subject: null,
          turnPlayerId: ctx.state.activePlayerId,
        },
      ];

    default:
      return [];
  }
}

/** Whether a listening ability cares about this occurrence. */
function scopeMatches(
  ctx: MatchContext,
  ability: AbilityDefinition,
  listener: {
    readonly instanceId: InstanceId;
    readonly controllerId: PlayerId;
    /** False for a card that has already left play — the dying source itself. */
    readonly inPlay: boolean;
  },
  occurrence: TriggerOccurrence,
): boolean {
  const { subject } = occurrence;

  // Turn-phase triggers are about a phase. Which of the four an ability hears
  // depends only on whether its controller owns the turn.
  if (occurrence.turnPlayerId !== null) {
    const own = listener.controllerId === occurrence.turnPlayerId;
    const wanted: TriggerId =
      occurrence.triggerId === 'on_turn_start'
        ? own
          ? 'on_turn_start'
          : 'on_opponent_turn_start'
        : own
          ? 'on_turn_end'
          : 'on_opponent_turn_end';
    return ability.trigger === wanted;
  }

  if (ability.trigger !== occurrence.triggerId) return false;
  if (subject === null) return false;

  const { scope } = ability;
  // No scope is the classic self-referential reading: this card, and nothing
  // else. Every ability authored before scopes existed means exactly this — and
  // it is the one case that still works from outside play, because a unit's
  // own `on_defeated` has to fire after it has died (CLAUDE.md §10).
  if (!scope) return subject.instanceId === listener.instanceId;

  // A *scoped* ability is a standing effect of a card on the board. A card that
  // has already left play does not watch the battlefield on its way out, so it
  // never hears about somebody else's event.
  if (!listener.inPlay) return false;

  if (scope.excludeSource && subject.instanceId === listener.instanceId) return false;
  if (scope.excludeSelfCaused && occurrence.causedBySourceInstanceId === listener.instanceId) {
    return false;
  }

  if (scope.controller === 'self' && subject.controllerId !== listener.controllerId) return false;
  if (scope.controller === 'opponent' && subject.controllerId === listener.controllerId) {
    return false;
  }

  if (scope.filter) {
    const definition = ctx.database.get(subject.definitionId);
    if (!definition) return false;
    // The instance may already be gone — a defeated unit is the common case —
    // so instance-dependent predicates simply do not apply rather than being
    // guessed at.
    const instance = findInstance(ctx.state, subject.instanceId) ?? null;
    if (!matchesCardFilter(definition, instance, scope.filter)) return false;
  }

  return true;
}

/** A card that might hear an occurrence, in deterministic order. */
interface TriggerListener {
  readonly instanceId: InstanceId;
  readonly definitionId: CardId;
  readonly controllerId: PlayerId;
  readonly inPlay: boolean;
}

/**
 * Every card that could react to one occurrence.
 *
 * Two groups. Everything currently in play, because a scoped ability watches
 * the board; and the card the event was *about*, even if it has already left —
 * a unit's own `on_defeated` fires after it has died, and it is no longer on
 * any battlefield to be found (CLAUDE.md §10).
 */
function listenersFor(ctx: MatchContext, occurrence: TriggerOccurrence): TriggerListener[] {
  const listeners: TriggerListener[] = [];
  const seen = new Set<InstanceId>();

  for (const playerId of ctx.state.seatOrder) {
    for (const instanceId of permanentsOf(ctx, playerId)) {
      const instance = findInstance(ctx.state, instanceId);
      if (!instance || seen.has(instanceId)) continue;
      seen.add(instanceId);
      listeners.push({
        instanceId,
        definitionId: instance.definitionId,
        controllerId: playerId,
        inPlay: true,
      });
    }
  }

  const { subject } = occurrence;
  if (subject && !seen.has(subject.instanceId)) {
    listeners.push({
      instanceId: subject.instanceId,
      definitionId: subject.definitionId,
      controllerId: subject.controllerId,
      inPlay: false,
    });
  }
  return listeners;
}

/** Counter key recording the turn a `limit: each_turn` ability last fired on. */
function limitKey(abilityId: string): string {
  return `triggeredTurn:${abilityId}`;
}

interface QueuedTrigger {
  readonly hit: TriggerHit;
  readonly abilityId: string;
  readonly abilityIndex: number;
  readonly effects: readonly EffectDefinition[];
}

/**
 * Discovers triggers for a batch of events and appends them to the resolution
 * queue in the deterministic order required by CLAUDE.md §12: active player
 * first, then clockwise seat order, then source instance creation order, then
 * trigger index within the card definition.
 *
 * There is no player-controlled ordering and no priority: with three or four
 * seats the clockwise tier is what stops the answer depending on who happened
 * to be looked at first.
 */
export function collectTriggers(ctx: MatchContext, events: readonly GameEvent[]): void {
  const queued: QueuedTrigger[] = [];

  for (const event of events) {
    for (const occurrence of occurrencesFromEvent(ctx, event)) {
      // Every permanent in play is a candidate listener, not just the card the
      // event was about. That is what "another friendly Unit was defeated" needs
      // and what the old discovery pass structurally could not do.
      for (const listener of listenersFor(ctx, occurrence)) {
        // A trigger controlled by an eliminated player never fires: their
        // static, delayed and queued effects all end with them (§12 step 3).
        if (playerOf(ctx.state, listener.controllerId).lost) continue;

        const listenerId = listener.controllerId;
        const instanceId = listener.instanceId;
        const instance = findInstance(ctx.state, instanceId);
        const definition: CardDefinition | undefined = ctx.database.get(listener.definitionId);
        if (!definition || definition.abilities.length === 0) continue;

        definition.abilities.forEach((ability, abilityIndex) => {
          if (!scopeMatches(ctx, ability, listener, occurrence)) return;

          // "The first time … each turn". Recorded on the instance so it
          // survives serialisation and is per-copy, not per-card-name.
          // A card that has left play has no counters to consult; its own
          // death trigger is a one-shot anyway.
          if (ability.limit === 'each_turn' && instance) {
            if (instance.counters[limitKey(ability.id)] === ctx.state.turn) return;
          }

          // The `if` is re-checked here rather than cached: a condition that
          // was true when the event happened and false now must not fire.
          if (
            ability.condition &&
            !evaluateCondition(ctx, ability.condition, {
              controllerId: listenerId,
              sourceInstanceId: instanceId,
            })
          ) {
            return;
          }

          if (ability.limit === 'each_turn' && instance) {
            instance.counters[limitKey(ability.id)] = ctx.state.turn;
          }

          queued.push({
            hit: {
              triggerId: occurrence.triggerId,
              sourceInstanceId: instanceId,
              definitionId: listener.definitionId,
              controllerId: listenerId,
              causeSequence: occurrence.causeSequence,
              subject: occurrence.subject,
              causedBySourceInstanceId: occurrence.causedBySourceInstanceId,
            },
            abilityId: ability.id,
            abilityIndex,
            effects: ability.effects,
          });
        });
      }
    }
  }

  if (queued.length === 0) return;

  // Precomputed seat ranks: active player is 0, then clockwise around the table.
  const rank = new Map<PlayerId, number>();
  activeFirstOrder(ctx.state, false).forEach((playerId, index) => rank.set(playerId, index));

  queued.sort((left, right) => {
    const leftSeat = rank.get(left.hit.controllerId) ?? Number.MAX_SAFE_INTEGER;
    const rightSeat = rank.get(right.hit.controllerId) ?? Number.MAX_SAFE_INTEGER;
    if (leftSeat !== rightSeat) return leftSeat - rightSeat;

    const leftOrdinal = ordinalOf(ctx, left.hit.sourceInstanceId);
    const rightOrdinal = ordinalOf(ctx, right.hit.sourceInstanceId);
    if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;

    return left.abilityIndex - right.abilityIndex;
  });

  for (const entry of queued) {
    enqueue(ctx, {
      kind: 'triggered_ability',
      sourceInstanceId: entry.hit.sourceInstanceId,
      sourceDefinitionId: entry.hit.definitionId,
      controllerId: entry.hit.controllerId,
      abilityId: entry.abilityId,
      effects: [...entry.effects],
      causeSequence: entry.hit.causeSequence,
      completesSpell: false,
      triggerSubjectInstanceId: entry.hit.subject?.instanceId ?? null,
    });
    const item = ctx.state.queue[ctx.state.queue.length - 1];
    if (!item) continue;
    emit(ctx, {
      type: 'trigger_queued',
      sourceInstanceId: entry.hit.sourceInstanceId,
      definitionId: entry.hit.definitionId,
      controllerId: entry.hit.controllerId,
      abilityId: entry.abilityId,
      triggerId: entry.hit.triggerId,
      resolutionId: item.id,
    });
  }
}

export type EnqueueInput = Omit<
  ResolutionItem,
  'id' | 'effectIndex' | 'selections' | 'triggerSubjectInstanceId'
> & {
  /** Defaults to `null`: only a triggered ability has a subject. */
  readonly triggerSubjectInstanceId?: InstanceId | null;
};

/** Appends work to the FIFO resolution queue. There is no stack and no priority. */
export function enqueue(ctx: MatchContext, input: EnqueueInput): ResolutionItem {
  const id = `res_${String(ctx.state.nextResolutionOrdinal).padStart(4, '0')}`;
  ctx.state.nextResolutionOrdinal += 1;
  const item: ResolutionItem = {
    triggerSubjectInstanceId: null,
    ...input,
    id,
    effectIndex: 0,
    selections: {},
  };
  ctx.state.queue.push(item);
  return item;
}
