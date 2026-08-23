import type { JobAction, JobStatus } from '@tcg/admin-contracts';

/**
 * The one-way switch an operator throws at a run that is already in flight.
 *
 * M08.5 gives `pause` and `cancel` the same mechanism and different meanings:
 * both *stop scheduling new match work and let in-flight matches reach their
 * normal record boundary*, and they differ only in the lifecycle state the job
 * settles into afterwards. So the switch carries a reason rather than being a
 * boolean, and the reason is what the settle transition is derived from.
 *
 * ## Why it latches, and why cancel wins
 *
 * **It latches** because the simulator asks it once per match on the hot path of
 * a run that may play thousands. A switch that could be turned back off would
 * mean a run that stopped dispatching, then started again, then stopped — and a
 * job in `pausing` that quietly went on playing matches is exactly the lie the
 * `pausing` state exists to prevent.
 *
 * **Cancel supersedes pause** because an operator who cancels a pausing job has
 * asked for something strictly stronger, and the lifecycle table agrees:
 * `cancel` is legal from `pausing` and there is no route back. Nothing supersedes
 * `cancel`, because there is nothing stronger to ask for that still lets the
 * in-flight matches finish.
 *
 * The settle transition is nevertheless read from the **document's** status
 * rather than from this object when the run stops, because the document is the
 * authority and this is a process's memory of it. What this reason decides is
 * whether a stop was asked for at all.
 */
export type StopReason = 'pause' | 'cancel';

/** What the runner is allowed to ask. Read-only on purpose: the queue throws the switch. */
export interface RunControl {
  /** The reason a stop was asked for, or `null` while the run may keep dispatching. */
  stopRequested(): StopReason | null;
}

export class JobStopControl implements RunControl {
  #reason: StopReason | null = null;

  stopRequested(): StopReason | null {
    return this.#reason;
  }

  /** Records the request. A later `pause` cannot undo an earlier `cancel`. */
  request(reason: StopReason): void {
    if (this.#reason === 'cancel') return;
    this.#reason = reason;
  }
}

/**
 * How a stopped run finishes, given the state the catalog says it is in.
 *
 * Derived from the lifecycle table's two settling transitions rather than from
 * the reason the run was stopped for, because between asking and stopping an
 * operator may have escalated: a job asked to pause and then cancelled is in
 * `cancelling`, and settling it as `paused` would discard the second request.
 * Two entries, and `control.test.ts` checks them against the table itself so a
 * third in-flight state cannot be added without this being noticed.
 */
export const SETTLE_ACTIONS: Readonly<Partial<Record<JobStatus, JobAction>>> = Object.freeze({
  pausing: 'pause_settled',
  cancelling: 'cancel_settled',
});

/** The action that settles a stopped run out of `status`, or `null` when none does. */
export function settleActionFor(status: JobStatus): JobAction | null {
  return SETTLE_ACTIONS[status] ?? null;
}
