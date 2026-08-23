import {
  catalogFilterSchema,
  type CatalogJobDocument,
  type JobId,
  type PageRequestInput,
} from '@tcg/admin-contracts';
import { isErr, ok } from '@tcg/shared';

import type { CatalogResult, CatalogStore } from '../catalog/store.js';
import { JobStopControl, type StopReason } from './control.js';
import type { ExperimentRunner } from './job-runner.js';
import {
  DEFAULT_RESOURCE_LIMITS,
  grantWorkers,
  parseResourceLimits,
  type ResourceLimits,
  type ResourceLimitsInput,
} from './limits.js';

/**
 * The queue: what runs, how much of the machine it may take, and the four verbs
 * an operator has over work that is already in flight.
 *
 * M08.4 built the bridge from one job to one run and stopped there deliberately —
 * it used exactly two lifecycle transitions, `start` and one of `complete` or
 * `fail`, and left the other eight alone. This is the tranche that uses them,
 * and the shape of it is: **the lifecycle table decides what is legal, the store
 * decides what is durable, and this class decides only what runs next.**
 *
 * ## Bounded, and bounded in two dimensions
 *
 * `limits.ts` says why one number is not enough. What this class adds is that
 * the budget is checked *before* a job is started and released only when its run
 * has settled, so the sum of the grants outstanding at any instant is the bound
 * rather than an average. A job that cannot be granted at least one worker is
 * not started at all — it stays `queued`, in its place in the order, and the
 * next completion is what lets it in.
 *
 * The order is `createdAt` then ID, which is what `listJobs` already sorts by
 * and is the order the jobs were created in. That is a floor rather than a
 * feature: **M08.9 owns batch ordering**, and nothing here sorts, reorders or
 * prioritises, so the tranche that gives an administrator control over the order
 * has nothing to undo first.
 *
 * ## Pause, resume, cancel and retry are the operator's, and each leaves a line
 *
 * Every verb goes through `applyJobAction`, so every one of them is refused by
 * the same table a screen would grey a button from and recorded in the same
 * append-only log. `cause` is `operator` — the default — which is what keeps an
 * administrator's cancel distinguishable from a crash-recovery interrupt in the
 * history, and what makes M08.2's promise about `retry` come true: a job that
 * failed, was retried and then succeeded spells `completed` on its document, and
 * only the log says it took two attempts.
 *
 * **Nothing here retries automatically.** `retry` exists as a method because an
 * operator presses it; no code path in this file calls it, and no failure
 * schedules one. That is the milestone's requirement stated as an absence, and
 * `queue.test.ts` checks the absence rather than trusting it.
 *
 * **Nothing here resumes an interrupted job automatically either**, for the same
 * reason. A restart interrupts in-flight work (M08.2, and the store does it while
 * opening), and what an operator sees afterwards is a job that says it was
 * interrupted. Quietly re-queueing it would be this class deciding that the
 * crash did not matter, which is the same class of claim as recovering `running`
 * work as `completed`.
 *
 * ## What a pause actually stops
 *
 * The ask reaches the simulator's own dispatch loop as a predicate, so what
 * stops is the *next* match being handed out; every match already playing runs
 * to its termination and its record is committed. The run then unwinds before it
 * writes a manifest, a summary or a report, and the job settles into `paused` or
 * `cancelled` depending on which state the document is in — not on which verb was
 * used, because an operator may have escalated in between.
 *
 * That is what makes `resume` cheap and honest: the stream on disk holds whole
 * matches under this configuration's own hash, and the next attempt asks for
 * `resume: true` and skips exactly those. Nothing is replayed and nothing is
 * lost.
 */

export interface JobQueueOptions {
  readonly store: CatalogStore;
  /**
   * The bridge one attempt goes through, built by the caller.
   *
   * Taken rather than constructed, and that is a boundary rather than a
   * convenience. `ExperimentRunner` is the only thing in this workspace that may
   * reach the simulator's experiment runner, and `boundary.test.ts` enforces it
   * by reading these sources. A queue that assembled its own would need the
   * runner's seams — its result root, its poll interval, its injectable
   * function — restated here, and the one-door property would then depend on
   * this file not using them rather than on it not having them.
   */
  readonly runner: ExperimentRunner;
  /** How much of the machine the queue may take. Defaults per `limits.ts`. */
  readonly limits?: ResourceLimitsInput;
}

/** What the queue is doing right now, for a caller that has to report it. */
export interface QueueSnapshot {
  readonly limits: ResourceLimits;
  /** Jobs this queue has started and not yet seen settle, in start order. */
  readonly inFlight: readonly JobId[];
  /** Worker grants currently outstanding. Never above `limits.maxWorkers`. */
  readonly workersInUse: number;
}

export class JobQueue {
  readonly #store: CatalogStore;
  readonly #runner: ExperimentRunner;
  readonly #limits: ResourceLimits;

  /** Every job this queue started and has not yet seen settle. */
  readonly #inFlight = new Map<JobId, Promise<void>>();
  readonly #controls = new Map<JobId, JobStopControl>();
  readonly #grants = new Map<JobId, number>();
  #workersInUse = 0;

  /**
   * Jobs whose start this queue asked for and was refused.
   *
   * A spin guard rather than a policy. Every refusal `run` can return leaves the
   * job somewhere other than `queued` — the `start` transition is the first thing
   * it takes — so a job that is still queued after being refused should not exist.
   * If one ever did, the fill loop would pick it, be refused, release, fill
   * again, and saturate a core for as long as the process lived. Remembering the
   * refusal turns that into one skipped job, which an operator can see and act
   * on; `resume` and `retry` are the two verbs that say to try again.
   */
  readonly #unstartable = new Set<JobId>();

  /**
   * One fill at a time, chained rather than guarded.
   *
   * Two overlapping fills could both read the same first queued job and both try
   * to start it. The `start` transition would refuse the second — that defence is
   * M08.4's and it is the real one — but the queue would have counted a grant
   * against its budget for a job it never ran, and the bound would drift down
   * every time it happened. A chain makes the overlap impossible instead of
   * survivable.
   */
  #fills: Promise<void> = Promise.resolve();

  constructor(options: JobQueueOptions) {
    this.#store = options.store;
    const limits = parseResourceLimits(options.limits ?? {});
    // A queue built with a limit it cannot parse would be a queue whose bound is
    // whatever the last valid caller said. Falling back to the conservative
    // default is the only answer that is safe in the direction that matters; the
    // refusal is still available to a caller that wants it, and M08.6's request
    // handler will take it before anything is constructed.
    this.#limits = isErr(limits) ? DEFAULT_RESOURCE_LIMITS : limits.value;
    this.#runner = options.runner;
  }

  get limits(): ResourceLimits {
    return this.#limits;
  }

  snapshot(): QueueSnapshot {
    return {
      limits: this.#limits,
      inFlight: [...this.#inFlight.keys()],
      workersInUse: this.#workersInUse,
    };
  }

  /**
   * Starts as many queued jobs as the bound allows, and returns when no more
   * can start.
   *
   * It does **not** wait for the jobs it started; `drain` does. Separating the
   * two is what lets a caller add work to a running queue without blocking on
   * everything already in it.
   */
  async pump(): Promise<void> {
    await this.#schedule();
  }

  /**
   * Runs the queue until nothing is in flight and nothing more can start.
   *
   * The loop is necessary rather than defensive: a job settling frees its grant
   * and schedules another fill, so "nothing in flight" is only stable once a
   * fill has run afterwards and started nothing.
   */
  async drain(): Promise<void> {
    for (;;) {
      await this.#schedule();
      const running = [...this.#inFlight.values()];
      if (running.length === 0) return;
      await Promise.allSettled(running);
    }
  }

  /* --------------------------------------------------------- operator verbs */

  /**
   * Asks a running job to stop at its next match boundary and settle as
   * `paused`.
   *
   * The transition is taken first and the switch is thrown second, so a job that
   * the table refuses to pause is never asked to stop. The reverse order would
   * stop a run whose document then said it should not have been.
   */
  async pause(jobId: JobId): Promise<CatalogResult<CatalogJobDocument>> {
    return this.#ask(jobId, 'pause', 'pause');
  }

  /**
   * Puts a paused or interrupted job back in the queue.
   *
   * `resume` lands in `queued` rather than `running` — the lifecycle table's
   * decision, and it is what makes the bound hold: a job that resumed straight
   * into `running` would be claiming a worker nobody granted it. The pump that
   * follows is the ordinary one, so a resumed job waits its turn behind whatever
   * the budget is already paying for.
   */
  async resume(jobId: JobId): Promise<CatalogResult<CatalogJobDocument>> {
    this.#unstartable.delete(jobId);
    const moved = await this.#store.applyJobAction({ jobId, action: 'resume' });
    if (isErr(moved)) return moved;
    void this.#schedule();
    return ok(moved.value);
  }

  /**
   * Stops a job for good, gracefully.
   *
   * From `queued`, `paused` or `interrupted` this is immediate: there is no run
   * to stop. From `running` or `pausing` it is a request — the job enters
   * `cancelling`, the in-flight matches finish and are committed, and the run
   * settles as `cancelled` with every partial record still on disk. Nothing in
   * this workspace deletes an experiment directory, which is what makes
   * "preserves inspectable partial output" a property rather than a promise.
   */
  async cancel(jobId: JobId): Promise<CatalogResult<CatalogJobDocument>> {
    return this.#ask(jobId, 'cancel', 'cancel');
  }

  /**
   * Puts a failed job back in the queue, as an operator's deliberate act.
   *
   * The one exception the lifecycle table makes to terminality, and the reason it
   * makes it. The attempt that follows resumes: the location was written on the
   * first start and is reused, `resume: true` is always asked for, and the
   * stream on disk decides what is left to play. So a retry continues a run
   * rather than starting a second one, and the event log keeps both attempts
   * even though the document will end up spelling only the outcome of the last.
   */
  async retry(jobId: JobId): Promise<CatalogResult<CatalogJobDocument>> {
    this.#unstartable.delete(jobId);
    const moved = await this.#store.applyJobAction({ jobId, action: 'retry' });
    if (isErr(moved)) return moved;
    void this.#schedule();
    return ok(moved.value);
  }

  /* ------------------------------------------------------------- internals */

  /**
   * Applies a stopping verb and, if this process is the one running the job,
   * throws the switch.
   *
   * A job that is `running` with no control here is one this process did not
   * start. It cannot happen in the deployment ADR 0023 §4 describes — one
   * administrator, one orchestration process, and a restart interrupts in-flight
   * work while the store is opened — and if it ever did, the job would sit in
   * `pausing` or `cancelling` until a restart recovered it as `interrupted`,
   * which is truthful: a stop was asked for and has not settled.
   */
  async #ask(
    jobId: JobId,
    action: 'pause' | 'cancel',
    reason: StopReason,
  ): Promise<CatalogResult<CatalogJobDocument>> {
    const moved = await this.#store.applyJobAction({ jobId, action });
    if (isErr(moved)) return moved;
    this.#controls.get(jobId)?.request(reason);
    return ok(moved.value);
  }

  #schedule(): Promise<void> {
    this.#fills = this.#fills.then(
      () => this.#fill(),
      () => this.#fill(),
    );
    return this.#fills;
  }

  async #fill(): Promise<void> {
    for (;;) {
      const next = await this.#nextStartable();
      if (next === null) return;
      this.#launch(next.jobId, next.workers);
    }
  }

  /**
   * The first queued job the bound has room for, with the workers it may have.
   *
   * The page is one row longer than the concurrency bound on purpose: at most
   * `maxConcurrentJobs` jobs can be in flight, so if any queued job is not one of
   * them it is inside the first `maxConcurrentJobs + 1` rows of the ordering. A
   * shorter page could be entirely in-flight rows and would report an empty queue
   * that is not empty.
   */
  async #nextStartable(): Promise<{ jobId: JobId; workers: number } | null> {
    if (this.#inFlight.size >= this.#limits.maxConcurrentJobs) return null;
    if (this.#workersInUse >= this.#limits.maxWorkers) return null;

    const page: PageRequestInput = { limit: this.#limits.maxConcurrentJobs + 1 };
    const listed = await this.#store.listJobs(
      catalogFilterSchema.parse({ status: ['queued'] }),
      page,
    );
    if (isErr(listed)) return null;

    for (const job of listed.value.items) {
      if (this.#inFlight.has(job.jobId)) continue;
      if (this.#unstartable.has(job.jobId)) continue;
      const config = await this.#store.readJobConfig(job.jobId);
      // A job whose stored configuration cannot be read is left where it is
      // rather than started or failed. Reading it is `run`'s first job anyway,
      // and refusing it from here would move a job to `failed` without the event
      // log ever recording that it was started.
      if (isErr(config)) continue;
      const workers = grantWorkers(this.#limits, config.value.workers, {
        jobs: this.#inFlight.size,
        workers: this.#workersInUse,
      });
      if (workers === null) return null;
      return { jobId: job.jobId, workers };
    }
    return null;
  }

  /**
   * Reserves the grant, starts the attempt, and releases the grant when it
   * settles.
   *
   * The reservation is taken **before** the promise is created, so no interleaving
   * can observe a started job whose workers are not yet counted; the release is
   * in a `finally`, so a run that threw releases as surely as one that returned.
   * `run` reports refusals as values rather than throwing, but a `finally` costs
   * nothing and a leaked grant would shrink the budget permanently.
   */
  #launch(jobId: JobId, workers: number): void {
    const control = new JobStopControl();
    this.#controls.set(jobId, control);
    this.#grants.set(jobId, workers);
    this.#workersInUse += workers;

    const attempt = (async (): Promise<void> => {
      try {
        const outcome = await this.#runner.run(jobId, { workers, control });
        if (isErr(outcome)) this.#unstartable.add(jobId);
      } finally {
        this.#release(jobId);
        void this.#schedule();
      }
    })();

    this.#inFlight.set(jobId, attempt);
  }

  #release(jobId: JobId): void {
    this.#workersInUse -= this.#grants.get(jobId) ?? 0;
    this.#grants.delete(jobId);
    this.#controls.delete(jobId);
    this.#inFlight.delete(jobId);
  }
}
