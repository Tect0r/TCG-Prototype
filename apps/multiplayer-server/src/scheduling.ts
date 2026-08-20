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
