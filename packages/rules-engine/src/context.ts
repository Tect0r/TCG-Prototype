import type { CardDatabase } from '@tcg/card-data';
import type { RulesConfig } from './config.js';
import type { EventCause, EventDraft, GameEvent } from './schema/event.js';
import type { MatchState } from './schema/state.js';

/**
 * Working context for one `applyAction` call.
 *
 * `state` is always a *clone* of the caller's state: the engine mutates the
 * clone freely and only the successful path is ever returned, which is how
 * "invalid actions never partially mutate match state" is guaranteed
 * structurally rather than by discipline (CLAUDE.md §10).
 */
/**
 * Everything a *derived* value needs and nothing it may change.
 *
 * Counts, conditions, costs and target filters are pure reads of the current
 * state, and several of their callers have no action in flight at all — the
 * simulator's telemetry asks what a card in hand would cost, and a client-side
 * view asks the same question. Cloning a whole match into a `MatchContext` for
 * a question that mutates nothing would be both wasteful and misleading about
 * what the caller is allowed to do (M02.3).
 *
 * `MatchContext` extends it, so every existing caller keeps working unchanged.
 */
export interface ReadContext {
  readonly database: CardDatabase;
  readonly config: RulesConfig;
  readonly state: MatchState;
}

export interface MatchContext extends ReadContext {
  /** Mutable draft. Never hand this to a caller before the action succeeds. */
  state: MatchState;
  /** Events produced by this action, in order. */
  events: GameEvent[];
  /** Causal provenance stamped onto events emitted from here on. */
  cause: EventCause;
}

export const NO_CAUSE: EventCause = {
  actionType: null,
  sourceInstanceId: null,
  resolutionId: null,
};

export function createContext(
  state: MatchState,
  database: CardDatabase,
  config: RulesConfig,
  cause: Partial<EventCause> = {},
): MatchContext {
  return {
    database,
    config,
    state: structuredClone(state),
    events: [],
    cause: { ...NO_CAUSE, ...cause },
  };
}

/** Temporarily stamps a different cause onto everything emitted inside `body`. */
export function underCause<T>(ctx: MatchContext, cause: Partial<EventCause>, body: () => T): T {
  const previous = ctx.cause;
  ctx.cause = { ...previous, ...cause };
  try {
    return body();
  } finally {
    ctx.cause = previous;
  }
}

/**
 * Appends an event to the authoritative log and stamps it with the next
 * sequence number. Sequence numbers are dense and monotonic so a client can ask
 * for "everything after N" and a replay can stop at an exact point.
 */
export function emit(ctx: MatchContext, draft: EventDraft): GameEvent {
  ctx.state.sequence += 1;
  const { cause: overrides, ...rest } = draft as EventDraft & { cause?: Partial<EventCause> };
  const event = {
    ...rest,
    sequence: ctx.state.sequence,
    cause: { ...ctx.cause, ...(overrides ?? {}) },
    // The spread above reassembles a valid member of the union; TypeScript
    // cannot see that through the distributive Omit, so assert once here.
  } as GameEvent;
  ctx.state.log.push(event);
  ctx.events.push(event);
  recordEventDerivedState(ctx, event);
  return event;
}

/**
 * Keeps the state a card can *ask about what has happened* in step with the log.
 *
 * That is `state.turnEvents` plus the one instance flag with the same
 * character, `survivedAsBlocker`. Driven off the emitted event rather than
 * written at each call site, for the same reason the simulator's telemetry is:
 * there are four ways a unit can be defeated and one of them is a state-based
 * check, so any hand-maintained tally would eventually disagree with the log a
 * replay produces. Cheap enough to run on every event — it is one switch and,
 * for a handful of event types, one push or one assignment.
 */
function recordEventDerivedState(ctx: MatchContext, event: GameEvent): void {
  switch (event.type) {
    case 'unit_defeated': {
      const entry = {
        instanceId: event.instanceId,
        definitionId: event.definitionId,
        controller: event.controllerId,
      };
      ctx.state.turnEvents.defeated.push(entry);
      // A sacrifice is also a defeat (CLAUDE.md §17 Q24), so it lands in both
      // lists and "Units defeated this turn" includes it.
      if (event.reason === 'sacrificed') ctx.state.turnEvents.sacrificed.push(entry);
      break;
    }
    case 'unit_deployed':
      ctx.state.turnEvents.deployed.push({
        instanceId: event.instanceId,
        definitionId: event.definitionId,
        controller: event.playerId,
      });
      break;
    case 'token_created': {
      const entry = {
        instanceId: event.instanceId,
        definitionId: event.definitionId,
        controller: event.playerId,
      };
      // A token arriving *is* a deployment, so it counts for both. Keeping the
      // narrower list as well is what lets a card ask about tokens specifically.
      ctx.state.turnEvents.deployed.push(entry);
      ctx.state.turnEvents.tokensCreated.push(entry);
      break;
    }
    case 'combat_survived': {
      if (!event.asBlocker) break;
      const instance = ctx.state.instances[event.instanceId];
      if (!instance) break;
      // Two windows, one event. The list answers "…that turn"; the flag answers
      // "…since your previous turn" and is cleared on a different boundary.
      ctx.state.turnEvents.survivedAsBlocker.push({
        instanceId: event.instanceId,
        definitionId: event.definitionId,
        controller: instance.controller,
      });
      instance.survivedAsBlocker = true;
      break;
    }
    default:
      break;
  }
}
