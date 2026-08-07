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
export interface MatchContext {
  readonly database: CardDatabase;
  readonly config: RulesConfig;
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
  return event;
}
