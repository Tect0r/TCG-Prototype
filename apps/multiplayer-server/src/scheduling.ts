/**
 * The server's two time seams, in one place so there is one of each.
 *
 * The engine never reads a clock (CLAUDE.md §4): everything time-shaped on this
 * server is a timer the server owns and an explicit action it submits when the
 * timer expires. There are two such users — the human disconnect window, which
 * has been here since the online milestones, and the bot delay scheduler M09.12
 * adds — and both take their timer and their clock from here so that a test can
 * drive either without waiting.
 *
 * The two are deliberately separate values. `ScheduleTimer` says *when to run
 * something*; the clock says *what time it is now*, and is used only to record
 * how long a wait actually took. Nothing derived from either ever reaches a
 * pilot's generator stream or the engine's state
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §4).
 */

/** Schedules `callback` after `delayMs`, returning the cancel for it. */
export type ScheduleTimer = (delayMs: number, callback: () => void) => () => void;

/**
 * A monotonic millisecond reading, for measuring an elapsed wait.
 *
 * Monotonic rather than wall-clock: the only question asked of it is "how long
 * was that", and a wall clock adjusted by NTP mid-match would answer it with a
 * negative number. It is never used to decide *whether* to act — that is the
 * timer's job — so a coarse resolution is fine.
 */
export type MonotonicClock = () => number;

export const defaultSchedule: ScheduleTimer = (delayMs, callback) => {
  const handle = setTimeout(callback, delayMs);
  return () => clearTimeout(handle);
};

export const defaultMonotonicClock: MonotonicClock = () => performance.now();

/**
 * A boundary between two pieces of bot work that the event loop actually gets
 * to cross.
 *
 * The third seam, and the one M09.19 had to add. The bot runner already yields
 * between decisions, but it defaulted that yield to `Promise.resolve()` — a
 * *microtask*, which the runtime drains before it looks at a socket again. A
 * bot at 0% pacing takes every decision it is offered inside one wake, so on a
 * board wide enough for a decision to cost real time, an awaited microtask
 * chain is a table where nobody else's message is read until the bots have
 * finished the turn.
 *
 * `setImmediate` is a macrotask: control returns to the loop, queued I/O is
 * served, and the pump resumes on the next tick. Nothing about *what* a bot
 * decides changes — the runner re-reads the authoritative state at the top of
 * every iteration and discards an answer whose board has moved, which is
 * precisely the case a real yield makes more likely rather than less safe.
 */
export type YieldToScheduler = () => Promise<void>;

export const defaultYieldToScheduler: YieldToScheduler = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
