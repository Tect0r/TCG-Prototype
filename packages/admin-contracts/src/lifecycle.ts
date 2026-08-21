import { z } from 'zod';

import { adminError, type AdminError } from './errors.js';
import { stageRefSchema } from './identity.js';

/**
 * The legal states of a batch and of a job, and every legal move between them —
 * **once**.
 *
 * The rule this module exists to enforce is that the transition policy has one
 * implementation. A queue UI that greys out "pause", a store that refuses to
 * write a state it cannot have reached, and a runner that has just been told a
 * worker died are three readers of the same table; three copies of it would
 * disagree the first time a state was added, and the disagreement would show up
 * as a job stuck in a state nobody can leave. Everything below is derived from
 * `JOB_LIFECYCLE` and `BATCH_LIFECYCLE`, including the terminal-state lists and
 * the tests.
 *
 * The vocabulary was chosen against M08.2, M08.4, M08.5 and M08.9 rather than
 * against M08.1 alone, because a state those tranches cannot honestly use is
 * worse than a state that is missing.
 *
 * **Batch and job stay distinguishable, and the difference is real.** A job
 * executes and a batch does not: a batch is an ordered collection its member
 * jobs run inside. So `failed` and `interrupted` are job states with no batch
 * counterpart — a batch does not fail, its jobs do — and `draft` is a batch
 * state with no job counterpart, because M08.9 edits batch membership *before
 * start* and a job is validated at the moment it is created. The two are not the
 * same enum with different spellings, and a reader who assumed they were would
 * be wrong in both directions.
 */

/* ------------------------------------------------------------ the machinery */

/** One legal move: this action, from this state, lands here. */
export interface LifecycleTransition<S extends string, A extends string> {
  readonly action: A;
  readonly from: S;
  readonly to: S;
}

/**
 * A complete lifecycle: where an entry starts, every move it may make, and which
 * states it may never leave.
 *
 * `terminal` is declared rather than derived from "has no outgoing transition",
 * because `failed` has exactly one outgoing transition and is still terminal —
 * see `JOB_LIFECYCLE` below. Deriving it would silently reclassify a state the
 * moment somebody gave it an escape hatch, which is the opposite of what naming
 * a terminal state is for.
 */
export interface LifecycleModel<S extends string, A extends string> {
  readonly name: string;
  readonly initial: S;
  readonly states: readonly S[];
  readonly actions: readonly A[];
  readonly transitions: readonly LifecycleTransition<S, A>[];
  readonly terminal: readonly S[];
}

/** Where `action` leads from `from`, or `null` when the model has no such move. */
export function nextState<S extends string, A extends string>(
  model: LifecycleModel<S, A>,
  from: S,
  action: A,
): S | null {
  return model.transitions.find((t) => t.from === from && t.action === action)?.to ?? null;
}

/** Every action legal from `from`, in the order the table declares them. */
export function legalActions<S extends string, A extends string>(
  model: LifecycleModel<S, A>,
  from: S,
): A[] {
  return model.transitions.filter((t) => t.from === from).map((t) => t.action);
}

export function isTerminal<S extends string, A extends string>(
  model: LifecycleModel<S, A>,
  state: S,
): boolean {
  return model.terminal.includes(state);
}

/**
 * Applies a transition, or refuses it structurally.
 *
 * A `Result`-shaped answer rather than a thrown error, for the reason every
 * other external boundary in this repository gives one: the caller is usually a
 * request handler that wants to *report* the refusal, and the refusal names the
 * state it was in and what it could have done instead — which is the difference
 * between a UI that can explain itself and one that can only say no.
 */
export function applyTransition<S extends string, A extends string>(
  model: LifecycleModel<S, A>,
  from: S,
  action: A,
): { readonly ok: true; readonly to: S } | { readonly ok: false; readonly error: AdminError } {
  const to = nextState(model, from, action);
  if (to !== null) return { ok: true, to };
  const available = legalActions(model, from);
  return {
    ok: false,
    error: adminError(
      'admin/illegal_transition',
      isTerminal(model, from)
        ? `A ${model.name} in \`${from}\` has finished, so \`${action}\` is not available.`
        : `A ${model.name} in \`${from}\` has no \`${action}\` transition.`,
      {
        context: {
          entry: model.name,
          from,
          action,
          available,
          terminal: isTerminal(model, from),
        },
      },
    ),
  };
}

/**
 * Every state reachable from the initial one, optionally without ever taking a
 * named action.
 *
 * The plain form proves the table has no state that is declared and then never
 * mentioned. The `without` form answers a question `catalog.ts` needs and no
 * hand-written list can be trusted with: which states a job can only be in
 * *because it started*. A state that is unreachable without `start` is a state
 * that has a start instant, and a state added to the table later joins or leaves
 * that set on its own.
 */
export function reachableStates<S extends string, A extends string>(
  model: LifecycleModel<S, A>,
  without?: A,
): S[] {
  const seen = new Set<S>([model.initial]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const transition of model.transitions) {
      if (transition.action === without) continue;
      if (seen.has(transition.from) && !seen.has(transition.to)) {
        seen.add(transition.to);
        grew = true;
      }
    }
  }
  return model.states.filter((state) => seen.has(state));
}

/* ------------------------------------------------------------------- a job */

/**
 * The nine states one experiment job can be in.
 *
 * Eight of them are the list M08.9 requires a queue screen to show by name. The
 * ninth, `cancelling`, is the one M08.5 requires without listing: cancel there is
 * *graceful* and preserves inspectable partial output, which means there is a
 * window between asking and stopping. Without a state for it a screen would
 * either show `running` after the operator cancelled, or show `cancelled` while
 * matches were still being written — and the second is the same class of lie as
 * recovering `running` work as `completed`.
 */
export const JOB_STATUSES = [
  /** Accepted, validated, waiting for a worker. The only state a job starts in. */
  'queued',
  /** A runner owns it and matches are being played. */
  'running',
  /** Pause asked for; in-flight matches are reaching their normal record boundary. */
  'pausing',
  /** Stopped cleanly and durably. Survives a restart as itself. */
  'paused',
  /** Cancel asked for; partial output is being left inspectable. */
  'cancelling',
  /** The orchestration process went away mid-flight. Resumable, and never completed. */
  'interrupted',
  /** Every scheduled match ran. */
  'completed',
  /** It stopped because something went wrong, and the diagnostics say what. */
  'failed',
  /** An administrator stopped it deliberately. */
  'cancelled',
] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** The verbs a job understands. Named for the button or event that causes each. */
export const JOB_ACTIONS = [
  'start',
  'pause',
  'pause_settled',
  'resume',
  'cancel',
  'cancel_settled',
  'interrupt',
  'complete',
  'fail',
  'retry',
] as const;
export const jobActionSchema = z.enum(JOB_ACTIONS);
export type JobAction = z.infer<typeof jobActionSchema>;

/**
 * The job transition table.
 *
 * Four decisions in here are worth stating rather than leaving to be read out of
 * the rows.
 *
 * **`resume` returns to `queued`, not to `running`.** M08.5 bounds concurrency
 * and worker counts; a job that resumed straight into `running` would be
 * claiming a worker it has not been given. Going back to the queue means the one
 * thing that starts work is `start`, and the bound holds by construction.
 *
 * **A restart interrupts all three in-flight states uniformly.** `running`,
 * `pausing` and `cancelling` all become `interrupted`, because after a crash
 * nothing is in flight and none of them knows where it stopped. Letting
 * `cancelling` settle into `cancelled` on recovery would be inferring that the
 * cancellation completed, which is the same guess as inferring completion.
 * The operator's intent is not lost: `cancel` is legal from `interrupted`.
 *
 * **`paused` and `queued` have no `interrupt` row on purpose.** Both are settled
 * and durable — a restart finds them exactly as they were, so recovering them is
 * reading a file, not deciding anything.
 *
 * **`retry` is the milestone's one explicit exception to terminality.** M08.5
 * requires retry to be a visible lifecycle action with its own record and never
 * a silent automatic success, and M08.4 requires a failed job to preserve its
 * partial results and resume identity. Both only mean something if the same job
 * can be run again, so `failed → queued` exists and `completed` and `cancelled`
 * have no outgoing row at all.
 */
export const JOB_TRANSITIONS: readonly LifecycleTransition<JobStatus, JobAction>[] = Object.freeze([
  { action: 'start', from: 'queued', to: 'running' },

  { action: 'pause', from: 'running', to: 'pausing' },
  { action: 'pause_settled', from: 'pausing', to: 'paused' },
  { action: 'resume', from: 'paused', to: 'queued' },
  { action: 'resume', from: 'interrupted', to: 'queued' },

  { action: 'cancel', from: 'queued', to: 'cancelled' },
  { action: 'cancel', from: 'running', to: 'cancelling' },
  { action: 'cancel', from: 'pausing', to: 'cancelling' },
  { action: 'cancel', from: 'paused', to: 'cancelled' },
  { action: 'cancel', from: 'interrupted', to: 'cancelled' },
  { action: 'cancel_settled', from: 'cancelling', to: 'cancelled' },

  { action: 'interrupt', from: 'running', to: 'interrupted' },
  { action: 'interrupt', from: 'pausing', to: 'interrupted' },
  { action: 'interrupt', from: 'cancelling', to: 'interrupted' },

  { action: 'complete', from: 'running', to: 'completed' },

  { action: 'fail', from: 'running', to: 'failed' },
  { action: 'fail', from: 'pausing', to: 'failed' },
  { action: 'fail', from: 'cancelling', to: 'failed' },

  { action: 'retry', from: 'failed', to: 'queued' },
]);

/**
 * The three states a job has finished in.
 *
 * `failed` is here despite having an outgoing `retry` row, and that is the whole
 * reason `terminal` is declared rather than derived: a failed job *is* over —
 * it has a completion instant, it is out of the queue, and nothing will happen
 * to it unless a person asks. Retry is that person asking.
 */
export const JOB_TERMINAL_STATUSES: readonly JobStatus[] = Object.freeze([
  'completed',
  'failed',
  'cancelled',
]);

export const JOB_LIFECYCLE: LifecycleModel<JobStatus, JobAction> = Object.freeze({
  name: 'job',
  initial: 'queued',
  states: JOB_STATUSES,
  actions: JOB_ACTIONS,
  transitions: JOB_TRANSITIONS,
  terminal: JOB_TERMINAL_STATUSES,
});

export const jobTransition = (from: JobStatus, action: JobAction): JobStatus | null =>
  nextState(JOB_LIFECYCLE, from, action);
export const legalJobActions = (from: JobStatus): JobAction[] => legalActions(JOB_LIFECYCLE, from);
export const isTerminalJobStatus = (status: JobStatus): boolean =>
  isTerminal(JOB_LIFECYCLE, status);
export const applyJobTransition = (from: JobStatus, action: JobAction) =>
  applyTransition(JOB_LIFECYCLE, from, action);

/* ----------------------------------------------------------------- a batch */

/**
 * The eight states a test batch can be in.
 *
 * Shorter than the job list by design, and the two omissions carry the meaning.
 * There is no batch `failed`: a batch of ten jobs where two failed has not
 * failed, and rolling its members' outcomes into one word would destroy exactly
 * the distinction the M08 result rules require every view to show. There is no
 * batch `interrupted` either: a batch owns no worker and plays no match, so a
 * restart interrupts its jobs and finds the batch where it left it.
 *
 * `draft` is the state the job list has no counterpart for. M08.9 adds,
 * duplicates, removes and reorders jobs *before start*; `draft` is the state in
 * which that is legal, and leaving it is what makes an ordering final.
 */
export const BATCH_STATUSES = [
  /** Being assembled. Membership and order may still change. */
  'draft',
  /** Submitted and ordered, waiting for its first job to start. */
  'queued',
  /** At least one member job has started and not every member has finished. */
  'running',
  /** Pause asked for; member jobs are reaching their record boundaries. */
  'pausing',
  /** Every member job is stopped cleanly. */
  'paused',
  /** Cancel asked for; member jobs are being stopped gracefully. */
  'cancelling',
  /** Every member job reached a terminal state. Says nothing about whether they succeeded. */
  'completed',
  /** An administrator stopped the batch deliberately. */
  'cancelled',
] as const;
export const batchStatusSchema = z.enum(BATCH_STATUSES);
export type BatchStatus = z.infer<typeof batchStatusSchema>;

export const BATCH_ACTIONS = [
  'enqueue',
  'start',
  'pause',
  'pause_settled',
  'resume',
  'cancel',
  'cancel_settled',
  'complete',
] as const;
export const batchActionSchema = z.enum(BATCH_ACTIONS);
export type BatchAction = z.infer<typeof batchActionSchema>;

/**
 * The batch transition table.
 *
 * `enqueue` is the move a job has no counterpart for: it is the moment the
 * ordered membership stops being editable, which is why M08.9's reordering
 * controls are legal in exactly one state. Everything after that mirrors the job
 * verbs, because an administrator pausing a batch and pausing a job means the
 * same thing by the same button — but the states those verbs move between are
 * the batch's own.
 */
export const BATCH_TRANSITIONS: readonly LifecycleTransition<BatchStatus, BatchAction>[] =
  Object.freeze([
    { action: 'enqueue', from: 'draft', to: 'queued' },
    { action: 'start', from: 'queued', to: 'running' },

    { action: 'pause', from: 'running', to: 'pausing' },
    { action: 'pause_settled', from: 'pausing', to: 'paused' },
    { action: 'resume', from: 'paused', to: 'queued' },

    { action: 'cancel', from: 'draft', to: 'cancelled' },
    { action: 'cancel', from: 'queued', to: 'cancelled' },
    { action: 'cancel', from: 'running', to: 'cancelling' },
    { action: 'cancel', from: 'pausing', to: 'cancelling' },
    { action: 'cancel', from: 'paused', to: 'cancelled' },
    { action: 'cancel_settled', from: 'cancelling', to: 'cancelled' },

    { action: 'complete', from: 'running', to: 'completed' },
  ]);

/** Both absolutely terminal: a batch has no retry, because retrying is a job's move. */
export const BATCH_TERMINAL_STATUSES: readonly BatchStatus[] = Object.freeze([
  'completed',
  'cancelled',
]);

export const BATCH_LIFECYCLE: LifecycleModel<BatchStatus, BatchAction> = Object.freeze({
  name: 'batch',
  initial: 'draft',
  states: BATCH_STATUSES,
  actions: BATCH_ACTIONS,
  transitions: BATCH_TRANSITIONS,
  terminal: BATCH_TERMINAL_STATUSES,
});

export const batchTransition = (from: BatchStatus, action: BatchAction): BatchStatus | null =>
  nextState(BATCH_LIFECYCLE, from, action);
export const legalBatchActions = (from: BatchStatus): BatchAction[] =>
  legalActions(BATCH_LIFECYCLE, from);
export const isTerminalBatchStatus = (status: BatchStatus): boolean =>
  isTerminal(BATCH_LIFECYCLE, status);
export const applyBatchTransition = (from: BatchStatus, action: BatchAction) =>
  applyTransition(BATCH_LIFECYCLE, from, action);

/**
 * The states a job can only be in because it started.
 *
 * Genuinely derived, not a list that happens to match one: a state is here when
 * the table offers no route to it from `queued` that avoids `start`. That makes
 * `cancelled` absent — a queued job can be cancelled without ever running — and
 * `completed` and `failed` present, which is the answer `catalog.ts` needs when
 * it decides which timestamps a status requires. A state added to the table
 * later joins or leaves this set by itself.
 */
export const JOB_STATUSES_REQUIRING_START: readonly JobStatus[] = Object.freeze(
  ((): JobStatus[] => {
    const withoutStarting = new Set(reachableStates(JOB_LIFECYCLE, 'start'));
    return JOB_STATUSES.filter((status) => !withoutStarting.has(status));
  })(),
);

/* --------------------------------------------------------------- progress */

/**
 * How far along a job is, in the only units that are always defined: matches
 * played, and which stage is playing them.
 *
 * `scheduledMatches` is nullable and carries `scheduledIsBound` beside it,
 * because M08.3 requires a search or adaptive total to be labelled as a bound
 * rather than presented as exact. Three states, all of them honest: a known
 * exact total, a known bound, and no answer yet.
 *
 * The `completed ≤ scheduled` invariant is enforced only when the total is
 * exact. A bound is not asserted here to be an upper one: which direction an
 * adaptive schedule bounds is M08.3's to decide from `buildSchedule`, and
 * guessing it here would be the second formula ADR 0023 §2 refuses.
 *
 * There is no percentage and no estimated remaining time. Both are derivable
 * where they are defined and dishonest where they are not, and M08.9's rule is
 * that remaining time is shown only when it is honestly available.
 */
export const progressSchema = z
  .strictObject({
    completedMatches: z.number().int().min(0),
    scheduledMatches: z.number().int().min(0).nullable(),
    /** Whether `scheduledMatches` is a bound rather than the exact figure. */
    scheduledIsBound: z.boolean(),
    /** Which declared stage of a composite job is running, when the job has stages. */
    stage: stageRefSchema.nullable(),
    /** Wall-clock time the job has spent running, summed across attempts. */
    elapsedMs: z.number().int().min(0).nullable(),
  })
  .refine(
    (progress) =>
      progress.scheduledMatches === null ||
      progress.scheduledIsBound ||
      progress.completedMatches <= progress.scheduledMatches,
    'A job cannot complete more matches than an exact schedule holds.',
  )
  .refine(
    (progress) => progress.scheduledMatches !== null || !progress.scheduledIsBound,
    'Nothing can be a bound when there is no figure to bound.',
  );
export type Progress = z.infer<typeof progressSchema>;

/** What a job's progress is before anything has run. */
export const NO_PROGRESS: Progress = Object.freeze({
  completedMatches: 0,
  scheduledMatches: null,
  scheduledIsBound: false,
  stage: null,
  elapsedMs: null,
});
