import { constants as osConstants, setPriority } from 'node:os';

/**
 * Makes simulator work yield to live multiplayer work on a shared machine
 * (M08.28A), by asking the OS scheduler rather than either event loop.
 *
 * ADR 0023 §1 already keeps `apps/admin-server` and `apps/multiplayer-server` as
 * two processes that never share an event loop, and `run/limits.ts` already
 * leaves one core free by default. Neither one answers the question this slice
 * closes: when both processes *do* compete for the same CPUs, which one the
 * scheduler favours. Process separation makes that a question the OS can
 * arbitrate at all; it does not by itself pick an answer.
 *
 * The fix is deliberately **not** teaching the simulator's match loop to yield
 * to a live event loop it does not share — there is no shared loop to yield
 * into, and inventing one here would reintroduce exactly the coupling ADR 0023
 * §1 exists to rule out. Instead this lowers the admin server's own OS process
 * priority once, at startup, before the queue can start a job. Every simulator
 * worker thread `workers/pool.ts` spawns afterward inherits that lowered
 * priority from the process that created it, so the whole simulator workload —
 * main thread and every worker — concedes CPU to a normal-priority process
 * (the multiplayer server, or anything else on the box) under contention,
 * without needing to touch `workers/pool.ts` at all.
 *
 * `PRIORITY_LOW` rather than `PRIORITY_BELOW_NORMAL`: this process runs
 * batch analysis nobody is waiting on synchronously — an operator reads a
 * finished report, not a frame budget — so it should concede as fully as the
 * platform allows, not merely a notch.
 *
 * Lowering one's own priority never requires elevated privileges on Windows or
 * POSIX, so failure here is expected to be rare. It is still not allowed to stop
 * the service from starting: an environment that refuses `setPriority` (a
 * restricted container, an unsupported platform) gets an admin server that
 * competes for CPU on equal terms, which is the pre-M08.28A behaviour, not a
 * reason to refuse the whole process.
 */
export interface ProcessPriorityOutcome {
  readonly applied: boolean;
  /** `null` when `applied` is `true`; otherwise the message from the thrown error. */
  readonly reason: string | null;
}

export function lowerSimulatorProcessPriority(): ProcessPriorityOutcome {
  try {
    setPriority(osConstants.priority.PRIORITY_LOW);
    return { applied: true, reason: null };
  } catch (error) {
    return { applied: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
