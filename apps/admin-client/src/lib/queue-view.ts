import {
  BATCH_STATUSES,
  JOB_STATUSES,
  OPERATOR_JOB_ACTIONS,
  type BatchStatus,
  type CatalogJobView,
  type JobStatus,
  type OperatorJobAction,
  type Progress,
} from '@tcg/admin-contracts';

/**
 * How a queue screen prints lifecycle state, progress and time — and, more
 * often, how it declines to.
 *
 * Everything here is a pure function of an answer the service gave. Nothing
 * fetches, nothing decides what is legal, and nothing invents a number: the
 * lifecycle table is `@tcg/admin-contracts`', the progress figures are the
 * runner's readings of a canonical directory, and this module's whole job is to
 * turn them into sentences without adding a claim.
 *
 * Three of M08.9's four checklist items are decided in this file rather than in
 * the component, which is deliberate: *every lifecycle state visible and named*,
 * *remaining time shown only when it is honestly available* and *queue order
 * does not imply shared state* are all statements about wording, and wording
 * that lives in JSX is wording no test can be total over. `queue-view.test.ts`
 * walks `JOB_STATUSES` and `BATCH_STATUSES` and requires a label and a meaning
 * for every member, so a state added to the table later cannot reach a screen as
 * a raw token.
 */

/* ------------------------------------------------------------ the states */

export interface StatusWording {
  /** What a badge says. Two words at most. */
  readonly label: string;
  /** What the state actually means, for a legend and for a screen reader. */
  readonly meaning: string;
}

/**
 * The nine job states, in words.
 *
 * `cancelling` is here even though the milestone's own list names eight. It is
 * the window between asking a running job to stop and the run unwinding, and a
 * screen without a word for it would either show `running` after the operator
 * cancelled or show `cancelled` while matches were still being written.
 */
export const JOB_STATUS_WORDING: Readonly<Record<JobStatus, StatusWording>> = Object.freeze({
  queued: {
    label: 'Queued',
    meaning: 'Accepted and validated, waiting for a worker. Nothing has run yet.',
  },
  running: {
    label: 'Running',
    meaning: 'A worker owns it and matches are being played.',
  },
  pausing: {
    label: 'Pausing',
    meaning:
      'A pause was asked for. Matches already playing finish and are committed; no new match is handed out.',
  },
  paused: {
    label: 'Paused',
    meaning:
      'Stopped cleanly. Everything it played is on disk, and resuming continues that stream rather than replaying it.',
  },
  cancelling: {
    label: 'Cancelling',
    meaning:
      'A cancel was asked for. The run is unwinding and every partial record is being left inspectable.',
  },
  interrupted: {
    label: 'Interrupted',
    meaning:
      'The orchestration process went away while this was in flight. It is resumable, and it was never completed.',
  },
  completed: { label: 'Completed', meaning: 'Every scheduled match ran.' },
  failed: {
    label: 'Failed',
    meaning: 'It stopped because something went wrong. The diagnostics below say what.',
  },
  cancelled: {
    label: 'Cancelled',
    meaning: 'An administrator stopped it deliberately. It will not run.',
  },
});

/** The eight batch states, in words. A batch executes nothing; its jobs do. */
export const BATCH_STATUS_WORDING: Readonly<Record<BatchStatus, StatusWording>> = Object.freeze({
  draft: {
    label: 'Draft',
    meaning:
      'Being assembled. Jobs can be added, duplicated, withdrawn and reordered, and none of them will run until it is started.',
  },
  queued: {
    label: 'Queued',
    meaning: 'Started and ordered, waiting for its first job to be given a worker.',
  },
  running: {
    label: 'Running',
    meaning: 'At least one member has started and not all have finished.',
  },
  pausing: {
    label: 'Pausing',
    meaning: 'A pause was asked for; members are reaching their record boundaries.',
  },
  paused: { label: 'Paused', meaning: 'Every member job is stopped cleanly.' },
  cancelling: {
    label: 'Cancelling',
    meaning: 'A cancel was asked for; members are stopping gracefully.',
  },
  completed: {
    label: 'Completed',
    meaning:
      'Every member reached a terminal state. This says nothing about whether they succeeded — a batch of ten where two failed has not failed.',
  },
  cancelled: { label: 'Cancelled', meaning: 'An administrator stopped the batch deliberately.' },
});

/** Every job state, in the table's own order, for a legend that is total by construction. */
export const JOB_STATUS_LEGEND: readonly (StatusWording & { readonly status: JobStatus })[] =
  Object.freeze(JOB_STATUSES.map((status) => ({ status, ...JOB_STATUS_WORDING[status] })));

export const BATCH_STATUS_LEGEND: readonly (StatusWording & { readonly status: BatchStatus })[] =
  Object.freeze(BATCH_STATUSES.map((status) => ({ status, ...BATCH_STATUS_WORDING[status] })));

/* ----------------------------------------------------------- the four verbs */

export interface ActionWording {
  readonly label: string;
  /**
   * What a confirmation asks, or `null` when the action needs none.
   *
   * *Confirmations proportional to their consequences* is the milestone's
   * phrase, and the proportion is decided by one question: **can the operator
   * undo it from this screen?** `pause`, `resume` and `retry` all can — the
   * lifecycle table has a route back from every state they lead to, and nothing
   * they do is lost. `cancel` cannot: `cancelled` is terminal with no outgoing
   * transition at all, so a mis-click ends a run for good. A dialog on the three
   * reversible verbs would train an operator to dismiss the one that matters.
   */
  readonly confirm: string | null;
}

export const JOB_ACTION_WORDING: Readonly<Record<OperatorJobAction, ActionWording>> = Object.freeze(
  {
    pause: { label: 'Pause', confirm: null },
    resume: { label: 'Resume', confirm: null },
    cancel: {
      label: 'Cancel',
      confirm:
        'Cancelling stops this job for good. Every match it has already played stays on disk and is still readable, but a cancelled job cannot be resumed or retried. Cancel it?',
    },
    retry: { label: 'Retry', confirm: null },
  },
);

/**
 * How a *withdrawal* is worded, which is the same verb wearing the name of what
 * it does in a draft.
 *
 * M08.9 adds no removal address. Cancelling a job that has never started is
 * exactly "remove it from this batch before start": it will not run, it stays
 * where a reader can find it, and nothing is deleted — which is the rule ADR
 * 0023 §3 sets and the reason M08.28 still has a decision to make about deletion.
 * Calling the button *Withdraw* in a draft and *Cancel* elsewhere is naming the
 * consequence rather than the transition, and the confirmation says which it is.
 */
export const WITHDRAW_WORDING: ActionWording = Object.freeze({
  label: 'Withdraw',
  confirm:
    'Withdrawing marks this job cancelled so it will never run. It stays listed in this batch — nothing is deleted — but it cannot be put back. Withdraw it?',
});

export const START_BATCH_CONFIRM =
  'Starting this batch settles its order and releases every job in it to the queue. Jobs will begin playing matches under this lab’s own worker bound, and no job can be added, duplicated, withdrawn or reordered afterwards. Start it?';

/* ------------------------------------------------------------- progress */

/**
 * How many matches are done, and out of how many — in whichever of the three
 * honest forms the answer is in.
 *
 * `progressSchema` deliberately provides three states rather than a percentage:
 * an exact total, a total that is a **bound** rather than the figure, and no
 * total at all. A screen that rendered `24 / 48` for all three would be
 * inventing a denominator for two of them, which is the same class of claim the
 * milestone's result rules forbid about a win rate.
 */
export function matchProgressText(progress: Progress): string {
  const done = progress.completedMatches.toLocaleString('en');
  if (progress.scheduledMatches === null) {
    return `${done} matches committed; no scheduled total is recorded for this job yet.`;
  }
  const total = progress.scheduledMatches.toLocaleString('en');
  if (progress.scheduledIsBound) {
    return `${done} matches committed, against a bound of ${total} rather than an exact figure.`;
  }
  return `${done} of ${total} matches committed.`;
}

/** Which declared stage of a composite job is playing, when it has stages. */
export function stageText(progress: Progress): string | null {
  if (progress.stage === null) return null;
  const { stageId, ordinal, total } = progress.stage;
  const position =
    total === null
      ? `stage ${String(ordinal + 1)}`
      : `stage ${String(ordinal + 1)} of ${String(total)}`;
  return `Now on ${position}: ${stageId}.`;
}

/**
 * A duration a person reads, from a figure the runner measured.
 *
 * Never rounded up to a unit that hides the number: a run that has been going
 * for 90 seconds says `1m 30s` rather than `2 minutes`, because the figure is
 * used to judge whether something has stalled.
 */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60)}m`;
}

/**
 * Fewer committed matches than this and no rate is reported.
 *
 * A rate taken from one or two matches is not a measurement of anything: match
 * length in this game varies by a large multiple, and the first matches of a run
 * also carry the process's own warm-up. Ten is the smallest count at which the
 * arithmetic stops being dominated by whichever match happened to be first, and
 * it is stated as a constant so the screen can say the number out loud rather
 * than leaving a reader to guess why nothing is shown.
 */
export const MIN_MATCHES_FOR_RATE = 10;

export type RemainingTime =
  | { readonly available: true; readonly text: string; readonly basis: string }
  | { readonly available: false; readonly reason: string };

/**
 * How much longer this job has, or why that cannot honestly be said.
 *
 * The milestone's rule is *honest remaining-time availability*, and the honest
 * answer is available in exactly one situation: the job is **running**, its
 * schedule is **exact** rather than a bound, it has committed enough matches for
 * a rate to mean anything, and the runner has measured how long that took. Then
 * the extrapolation is from this run's own measured pace on its own machine —
 * not from a table of expected match lengths, which this build has never
 * produced and which M08.8 declined to invent for the same reason.
 *
 * Every other case gets a sentence saying which condition failed, because "no
 * estimate" and "no estimate *because the total for this kind of run is a bound*"
 * are different facts and an operator can act on the second.
 */
export function remainingTime(job: CatalogJobView): RemainingTime {
  const { progress, status } = job;

  if (status !== 'running') {
    return {
      available: false,
      reason: 'Remaining time is only extrapolated while a job is running.',
    };
  }
  if (progress.scheduledMatches === null) {
    return {
      available: false,
      reason: 'No scheduled total is recorded for this job, so there is nothing to count down to.',
    };
  }
  if (progress.scheduledIsBound) {
    return {
      available: false,
      reason:
        'This job’s scheduled total is a bound rather than an exact figure, so a remaining time computed from it would be a guess dressed as arithmetic.',
    };
  }
  if (progress.completedMatches < MIN_MATCHES_FOR_RATE) {
    return {
      available: false,
      reason: `Fewer than ${String(MIN_MATCHES_FOR_RATE)} matches have been committed, which is too few for a rate that is not mostly noise.`,
    };
  }
  if (progress.elapsedMs === null || progress.elapsedMs <= 0) {
    return {
      available: false,
      reason: 'No elapsed time has been measured for this job yet.',
    };
  }
  const left = progress.scheduledMatches - progress.completedMatches;
  if (left <= 0) {
    return {
      available: false,
      reason: 'Every scheduled match has been committed; this job is settling.',
    };
  }

  const perMatch = progress.elapsedMs / progress.completedMatches;
  return {
    available: true,
    text: formatDuration(perMatch * left),
    basis: `Extrapolated from this run’s own pace: ${formatDuration(perMatch)} per match across ${String(progress.completedMatches)} committed matches, with ${String(left)} to go.`,
  };
}

/* ------------------------------------------------------------ the ordering */

/**
 * The sentence that keeps queue order from being read as a relationship.
 *
 * The milestone's fourth checklist item, and it is a real hazard rather than a
 * pedantry: a list of rows in a chosen order looks like a pipeline, and a reader
 * who assumed one would expect the second job to inherit something from the
 * first — a population, a deck, a calibration. It inherits nothing. Every job is
 * a whole experiment with its own configuration, its own seed and its own
 * canonical directory, and the order decides only which of them a worker is
 * given first.
 */
export const ORDER_IS_NOT_STATE =
  'Order decides which job a worker is offered first, and nothing else. Each job is a whole experiment with its own configuration, its own seed family and its own canonical directory: nothing is carried from one job in a batch to the next, and running them in one batch pools no evidence between them.';

/** Moves one entry of an ordering, returning a new array. */
export function moveInOrder<T>(order: readonly T[], from: number, to: number): T[] {
  const next = [...order];
  if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
  const [held] = next.splice(from, 1);
  if (held === undefined) return [...order];
  next.splice(to, 0, held);
  return next;
}

/** Every operator verb, for a test that has to be total over the wording map. */
export const OPERATOR_ACTIONS: readonly OperatorJobAction[] = OPERATOR_JOB_ACTIONS;
