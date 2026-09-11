import { join } from 'node:path';

import {
  adminError,
  type AdminError,
  type CatalogJobDocument,
  type JobExecution,
  type JobId,
  type Progress,
  type ResultLocation,
  type RunIdentity,
} from '@tcg/admin-contracts';
import { err, isErr, ok } from '@tcg/shared';
import {
  adaptiveCheckpointSchema,
  adaptiveConfigHashOf,
  adaptiveRawRecordSchema,
  adaptiveResultSchema,
  buildAdaptiveResult,
  configHashOf,
  freshAdaptiveCheckpoint,
  isExperimentStopped,
  MatchStore,
  parseAdaptiveCheckpoint,
  pilotSpecsOf,
  resolveEnvironment,
  runAdaptiveExperiment,
  runAdaptiveFinalValidation,
  runExperiment as runExperimentDirectly,
  ADAPTIVE_RAW_SCHEMA_VERSION,
  ADAPTIVE_RESULT_SCHEMA_VERSION,
} from '@tcg/simulator';
import type {
  AdaptiveCheckpoint,
  AdaptiveConfig,
  AdaptiveGenerationRecord,
  AdaptiveRawEvent,
  AdaptiveScreeningRound,
  AdaptiveSeriesRecord,
  AdaptiveValidationRun,
  Environment,
  ExperimentConfig,
  RunAdaptiveExperimentOptions,
} from '@tcg/simulator';

import { readDocumentText, writeJsonAtomically } from '../catalog/files.js';
import { resolveResultLocation, type ResolvedCatalogRoots } from '../catalog/roots.js';
import type { CatalogResult, CatalogStore } from '../catalog/store.js';
import { estimateExperiment } from '../lab/estimate.js';
import { scrubRefusal } from '../lab/expand.js';
import { CHECKPOINT_DOCUMENT, RESULT_DOCUMENT } from '../service/adaptive-results.js';
import { settleActionFor, type RunControl, type StopReason } from './control.js';
import { readRunIdentity } from './manifest.js';
import { readCanonicalProgress, type CanonicalReading } from './progress.js';

/** The third document an Adaptive Counter run writes, beside the checkpoint and the result (`./job-runner.ts` is its only writer, `envelopes.ts`'s own doc comment). Not read back anywhere yet — M08.R5 is the crash-safe rewrite of how it accumulates. */
const RAW_DOCUMENT = 'adaptive-raw.json';

/**
 * The bridge from one catalog job to one canonical experiment directory — the
 * first thing in this workspace that runs anything.
 *
 * Everything before it assembled: M08.1 gave the lifecycle a language, M08.2
 * gave it a durable catalog, M08.3 gave it an honest match count. This is where a
 * queued job becomes a run, and the four things it owes are the four things it is
 * easiest to get quietly wrong.
 *
 * ## One job, one directory
 *
 * The directory a job writes into is **the job's own identifier**, under a
 * configured result root. That makes the mapping bijective by naming rather than
 * by discipline: two jobs cannot collide on a directory because two jobs cannot
 * share an ID, and one job cannot acquire a second directory because the location
 * is written to its document on the first start and reused by every later
 * attempt. A retry therefore resumes into the stream it already has, even if the
 * runner has since been configured with a different result root.
 *
 * The ID alphabet is what makes that safe rather than merely tidy:
 * `@tcg/admin-contracts` restricts an ID body to lowercase letters and digits
 * *because M08.2 uses these IDs as file names*, and the location is re-resolved
 * against its configured root — real path and all, so a symlink is seen — before
 * a single match is played.
 *
 * ## The simulator is called, never shelled out to
 *
 * ADR 0023 §2: *`apps/admin-server` depends on `@tcg/simulator` and calls its
 * exported functions … where a child process is genuinely required, it is spawned
 * with a fixed executable and a fixed argument vector. No admin input is ever
 * concatenated into a command string, and no shell is invoked.*
 *
 * No child process is genuinely required here, so there is no argument vector to
 * fix: `runExperiment` is an ordinary function call, and the only process
 * boundary underneath it is the simulator's own worker pool, which starts a fixed
 * bootstrap module with no argv at all and hands it a schema-validated setup
 * object. "The admin service cannot execute arbitrary commands" is therefore not
 * a property of how carefully this file builds a string; it is a property of
 * there being no string. `boundary.test.ts` holds both halves.
 *
 * ## Progress is read, not counted
 *
 * Nothing here subscribes to `onProgress`. A timer re-reads the canonical
 * directory while the run is in flight, and `progress.ts` says at length why that
 * is the honest measure rather than the convenient one. The consequence worth
 * stating here is the one a reader will notice: on a single-worker sequential
 * run inside this process, the timer cannot fire at all, because the match loop
 * never yields to the event loop between matches. The reading taken when the run
 * settles is therefore the only one such a job gets — which is correct rather
 * than merely acceptable, because it is still read from the directory, and
 * because ADR 0023 §1 puts real work in workers precisely so the loop is free.
 *
 * ## A failure leaves everything it wrote
 *
 * Nothing here deletes a directory, truncates a stream or clears an execution
 * record — there is no code in this file that removes anything. A failed job
 * keeps its partial `matches.jsonl`, its header, its checkpoints and its
 * location, so `retry` (an operator's action, M08.5) resumes rather than
 * restarts. The diagnostics are a structured `admin/run_failed` whose message
 * has been through `scrubRefusal`, because the failure that fell out of the
 * simulator has no idea it is about to cross an admin boundary and is quite
 * likely to be an `ENOENT` carrying a path.
 *
 * ## A stop is a third outcome, and it is neither of the other two (M08.5)
 *
 * An operator can ask a run in flight to stop, and the ask reaches the
 * simulator's own dispatch loop as a `shouldStop` predicate rather than reaching
 * this process's kill switch. So a stopped run is one whose matches all ran to
 * their termination and whose records are all committed; what stopped is the
 * *next* match being handed out. The simulator unwinds with `ExperimentStopped`
 * before it writes a manifest, a summary or a report, which is what keeps a
 * half-finished run from leaving behind a document that reads like a finished
 * one.
 *
 * This class does two things with that. It **settles the lifecycle from the
 * document rather than from the reason it was stopped for** — `pausing` settles
 * to `paused` and `cancelling` to `cancelled`, so an operator who escalated a
 * pause into a cancel gets the escalation rather than the first request. And it
 * **treats a run that finished anyway as finished**: a cancel that arrives after
 * the last match still settles the job as cancelled, because the document is the
 * authority, but the result it wrote is attached first so the catalog does not
 * pretend the evidence is not there.
 */

export type RunExperimentFn = typeof runExperimentDirectly;

export interface ExperimentRunnerOptions {
  readonly store: CatalogStore;
  readonly roots: ResolvedCatalogRoots;
  /** Which configured result root a job's directory is created under. */
  readonly resultRootId: string;
  /**
   * Simulator workers per run, when a caller has no per-attempt opinion.
   *
   * Non-semantic: `configHashOf` excludes it, so changing it cannot make a
   * resumed run into a different run. The bound that matters is the queue's —
   * `JobQueue` grants each attempt its share of one budget and passes it to
   * `run` — and this stays for a caller driving one job with no queue.
   */
  readonly workers?: number;
  /** How often the canonical directory is re-read while a run is in flight. */
  readonly pollEveryMs?: number;
  /**
   * Injectable so a test can drive a real failure through the real bridge.
   *
   * The same seam `FileCatalogStore` gives its clock and its ID minter, and for
   * the same reason: *a branch that exists for an event that should never happen*
   * has to be reachable deliberately. The default is the simulator's own
   * function, which `boundary.test.ts` asserts.
   */
  readonly runExperiment?: RunExperimentFn;
  readonly clock?: () => Date;
}

/** What one attempt at a job is given, as opposed to what the runner always has. */
export interface JobAttemptOptions {
  /**
   * Workers for this attempt, overriding the runner's default and the
   * configuration's request.
   *
   * A grant rather than a preference: `JobQueue` computes it from one budget
   * shared across every running job, so a run that ignored it would be a run
   * outside the bound.
   */
  readonly workers?: number;
  /** The switch an operator throws to pause or cancel this attempt while it runs. */
  readonly control?: RunControl;
}

export interface JobRunOutcome {
  readonly jobId: JobId;
  /**
   * How the attempt ended.
   *
   * `stopped` is neither of the other two and must not be folded into either: a
   * paused run has failed nothing, and a cancelled one completed nothing. The
   * lifecycle state the job settled into is on the document; this says which of
   * the three paths through `run` produced it.
   */
  readonly status: 'completed' | 'failed' | 'stopped';
  /** Why the run stopped, when it did. `null` for every other outcome. */
  readonly stopReason: StopReason | null;
  /** The last canonical reading taken, whichever way the run ended. */
  readonly progress: Progress;
  /** The run's identity, when it wrote a manifest to read one from. */
  readonly identity: RunIdentity | null;
  readonly failure: AdminError | null;
}

export class ExperimentRunner {
  readonly #store: CatalogStore;
  readonly #roots: ResolvedCatalogRoots;
  readonly #resultRootId: string;
  readonly #workers: number | undefined;
  readonly #pollEveryMs: number;
  readonly #runExperiment: RunExperimentFn;
  readonly #clock: () => Date;

  constructor(options: ExperimentRunnerOptions) {
    this.#store = options.store;
    this.#roots = options.roots;
    this.#resultRootId = options.resultRootId;
    this.#workers = options.workers;
    this.#pollEveryMs = options.pollEveryMs ?? 500;
    this.#runExperiment = options.runExperiment ?? runExperimentDirectly;
    this.#clock = options.clock ?? (() => new Date());
  }

  /**
   * Runs one queued job to completion, to failure, or to the stop it was asked
   * for.
   *
   * The `start` transition is taken **first**, through the store, which is what
   * makes a second concurrent call refuse rather than double-run: the lifecycle
   * table has no `start` out of `running`, and the store serializes mutations of
   * one job on that job's own key. So the duplicate-start defence is the same
   * table a queue screen greys a button from, rather than a flag this class
   * keeps.
   */
  async run(jobId: JobId, attempt: JobAttemptOptions = {}): Promise<CatalogResult<JobRunOutcome>> {
    const before = await this.#store.readJob(jobId);
    if (isErr(before)) return before;

    const started = await this.#store.applyJobAction({ jobId, action: 'start', cause: 'runner' });
    if (isErr(started)) return started;

    if (before.value.spec.kind === 'adaptive_counter') {
      return this.#runAdaptive(jobId, before.value, started.value, attempt);
    }

    const prepared = await this.#prepare(before.value, started.value, attempt);
    if (isErr(prepared)) return this.#fail(jobId, prepared.error, before.value.progress);

    const { config, execution, directory } = prepared.value;
    const carriedElapsedMs = before.value.progress.elapsedMs ?? 0;
    const attemptStartedMs = this.#clock().getTime();

    const scheduled = scheduleOf(config);
    /**
     * Takes one reading and writes it down, and never lets the writing decide
     * whether the run continues.
     *
     * A progress counter that could not be persisted is a screen that is briefly
     * out of date. Abandoning an experiment over one would throw away hours of
     * real matches to protect a number that is re-read from the directory every
     * few hundred milliseconds anyway — and the directory, not this counter, is
     * the evidence.
     */
    let highWater = -1;
    let latest: Progress = before.value.progress;
    const record = async (reading: CanonicalReading): Promise<Progress> => {
      // A committed stream only grows, so a reading that is behind the last one
      // written is a *stale sample* rather than news — a poll that opened the
      // directory before the run settled and finished reading after it. Letting
      // one land would make the catalog report fewer matches than are on disk,
      // which is the one direction progress must never move.
      if (reading.completedMatches < highWater) return latest;
      highWater = reading.completedMatches;

      // The directory outranks the estimate. If the committed stream holds more
      // records than an *exact* schedule says exist, the estimate is not
      // describing this run — a stream carried over from a configuration that
      // scheduled more, say — and the honest denominator is the third state
      // `progressSchema` provides rather than a number the evidence contradicts.
      const exceedsSchedule =
        scheduled.matches !== null &&
        !scheduled.isBound &&
        reading.completedMatches > scheduled.matches;

      const progress: Progress = {
        completedMatches: reading.completedMatches,
        scheduledMatches: exceedsSchedule ? null : scheduled.matches,
        scheduledIsBound: exceedsSchedule ? false : scheduled.isBound,
        stage: reading.stage,
        elapsedMs: carriedElapsedMs + Math.max(0, this.#clock().getTime() - attemptStartedMs),
      };
      latest = progress;
      try {
        await this.#store.setJobProgress(jobId, progress);
      } catch {
        // Deliberately ignored; see above.
      }
      return progress;
    };

    await record(await readCanonicalProgress(directory));
    const poll = this.#startPolling(directory, record);

    const control = attempt.control;
    try {
      await this.#runExperiment(config, {
        outputDir: directory,
        workers: execution.workers,
        // Always. An empty directory makes this a no-op, and a directory with a
        // committed stream is exactly the retry case: `MatchStore` skips what it
        // already has and refuses outright if the configuration drifted.
        resume: true,
        // Absent when nobody can stop this attempt, so a run with no operator
        // behind it takes the code path it has always taken.
        ...(control === undefined ? {} : { shouldStop: () => control.stopRequested() }),
      });
    } catch (cause) {
      poll.stop();
      await record(await readCanonicalProgress(directory));
      // A stop is not a failure. The simulator unwound deliberately, every
      // record it played is committed, and the job settles into whichever state
      // the operator's request left the document in.
      if (isExperimentStopped(cause)) return this.#settle(jobId, latest, null);
      return this.#fail(jobId, [runFailed(cause, jobId)], latest);
    } finally {
      poll.stop();
    }

    await record(await readCanonicalProgress(directory));

    const identity = await readRunIdentity(directory, { jobId });
    if (isErr(identity)) return this.#fail(jobId, identity.error, latest);

    if (identity.value.configHash !== before.value.spec.configHash) {
      return this.#fail(jobId, [identityDrifted(jobId)], latest);
    }

    const attached = await this.#store.attachJobResult(jobId, {
      identity: identity.value,
      location: execution.location,
    });
    if (isErr(attached)) return this.#fail(jobId, attached.error, latest);

    // The run finished every match it had. If an operator's pause or cancel
    // landed while the last one was playing, the document is already in an
    // in-flight settling state and `complete` is not a move it has — so the
    // request wins, and the result above is attached either way. A queue screen
    // can then say "cancelled, and it had already finished", which is what
    // happened, rather than reporting a failure that did not.
    const settlement = await this.#settleIfRequested(jobId, latest, identity.value);
    if (settlement !== null) return settlement;

    const completed = await this.#store.applyJobAction({
      jobId,
      action: 'complete',
      cause: 'runner',
    });
    if (isErr(completed)) return completed;

    return ok({
      jobId,
      status: 'completed',
      stopReason: null,
      progress: latest,
      identity: identity.value,
      failure: null,
    });
  }

  /* ------------------------------------------------------------ internals */

  /**
   * Everything that has to be true before a match is played, in the order that
   * makes each failure cheap.
   *
   * The location is resolved before the configuration is read, because a
   * reference that escapes its root must be refused whether or not the
   * configuration is any good; and the configuration's hash is checked against
   * the spec before anything is written, because a stored configuration that no
   * longer matches the job's recorded address would produce a run this catalog
   * entry does not describe.
   */
  async #prepare(
    before: CatalogJobDocument,
    started: CatalogJobDocument,
    attempt: JobAttemptOptions,
  ): Promise<
    CatalogResult<{
      readonly config: ExperimentConfig;
      readonly execution: JobExecution;
      readonly directory: string;
    }>
  > {
    const location: ResultLocation = before.execution?.location ?? {
      rootId: this.#resultRootId,
      directory: before.jobId,
    };

    const resolved = await resolveResultLocation(this.#roots, location);
    if (isErr(resolved)) return resolved;

    const config = await this.#store.readJobConfig(before.jobId);
    if (isErr(config)) return config;

    if (configHashOf(config.value) !== before.spec.configHash) {
      return err([configDrifted(before.jobId)]);
    }

    const reading = await readCanonicalProgress(resolved.value);
    if (
      reading.streamIdentity !== null &&
      reading.streamIdentity.configHash !== before.spec.configHash
    ) {
      return err([streamDrifted(before.jobId)]);
    }

    const execution: JobExecution = {
      location,
      mode: 'in_process_workers',
      // The queue's grant outranks both, because it is the only one of the three
      // that knows what every *other* running job is already using.
      workers: attempt.workers ?? this.#workers ?? config.value.workers,
      attempts: (before.execution?.attempts ?? 0) + 1,
      lastStartedAt: started.timestamps.updatedAt,
      resumedMatches: reading.completedMatches,
    };

    const recorded = await this.#store.setJobExecution(before.jobId, execution);
    if (isErr(recorded)) return recorded;

    return ok({ config: config.value, execution, directory: resolved.value });
  }

  /**
   * The adaptive counterpart to `run`'s body (M08.R4).
   *
   * Structured the same way — prepare, drive, settle — but an Adaptive Counter
   * job has no `runExperiment` to call: it drives `runAdaptiveExperiment` and
   * `runAdaptiveFinalValidation` directly, accumulates the raw events they
   * report, and writes the three documents `envelopes.ts` names (raw,
   * checkpoint, result) itself. There is no manifest and no
   * `StoredResultReference` — an Adaptive Counter job's `result` field stays
   * `null` forever; `AdaptiveResultReader` reads its own two canonical
   * documents from the same directory this method resolves, keyed on
   * `experimentId` exactly as `#prepareAdaptive` resolves it, which is what
   * keeps the runner and the reader pointed at the same evidence.
   */
  async #runAdaptive(
    jobId: JobId,
    before: CatalogJobDocument,
    started: CatalogJobDocument,
    attempt: JobAttemptOptions,
  ): Promise<CatalogResult<JobRunOutcome>> {
    const prepared = await this.#prepareAdaptive(before, started, attempt);
    if (isErr(prepared)) return this.#fail(jobId, prepared.error, before.progress);

    const { config, environment, sink, execution, directory } = prepared.value;
    const checkpoint = prepared.value.checkpoint;

    const carriedElapsedMs = before.progress.elapsedMs ?? 0;
    const attemptStartedMs = this.#clock().getTime();

    /**
     * An Adaptive Counter run discovers how many evaluation blocks it needs
     * rather than scheduling them up front (`planAdaptiveBudget`'s own
     * `gamesScheduled` only covers whole learning blocks, never the screening
     * games the same budget also pays for), so the one honest exact figure is
     * the two budgets a run can never exceed: the learning series and the
     * frozen final validation. `scheduleAdaptiveValidation` plays
     * `finalValidationGames` per seat orientation, so a mirrored run doubles
     * it, exactly as `validate.ts`'s own doc comment says. `isBound: true`
     * says a completed run's `completedMatches` may land under this figure —
     * most of it is screening, which does not have to spend every game the
     * budget allows — but never over it.
     */
    const scheduled = {
      matches:
        config.totalLearningBudget + config.finalValidationGames * (config.mirrorSeats ? 2 : 1),
      isBound: true,
    };

    // Seeded from the checkpoint this attempt starts from, then kept current
    // by `onRawEvent` below — the same "generation, and whether it is still
    // being decided" pair `stageRefSchema`'s own doc comment asks an adaptive
    // job to report, without a second formula that recomputes it from scratch.
    let stageGeneration = checkpoint.nextGeneration;
    let stagePending = checkpoint.pendingGeneration !== null;
    const stageOf = (): Progress['stage'] => ({
      stageId: `gen-${String(stageGeneration)}-${stagePending ? 'pending' : 'active'}`,
      ordinal: stageGeneration - 1,
      total: null,
    });

    let highWater = -1;
    let latest: Progress = before.progress;
    const record = async (reading: CanonicalReading): Promise<Progress> => {
      if (reading.completedMatches < highWater) return latest;
      highWater = reading.completedMatches;

      const exceedsSchedule = reading.completedMatches > scheduled.matches;
      const progress: Progress = {
        completedMatches: reading.completedMatches,
        scheduledMatches: exceedsSchedule ? null : scheduled.matches,
        scheduledIsBound: exceedsSchedule ? false : scheduled.isBound,
        stage: stageOf(),
        elapsedMs: carriedElapsedMs + Math.max(0, this.#clock().getTime() - attemptStartedMs),
      };
      latest = progress;
      try {
        await this.#store.setJobProgress(jobId, progress);
      } catch {
        // Deliberately ignored; see `run`'s own `record`.
      }
      return progress;
    };

    await record(await readCanonicalProgress(directory));
    const poll = this.#startPolling(directory, record);

    const series: AdaptiveSeriesRecord[] = [];
    const generations: AdaptiveGenerationRecord[] = [];
    const screeningRounds: AdaptiveScreeningRound[] = [];
    const onRawEvent = (event: AdaptiveRawEvent): void => {
      switch (event.kind) {
        case 'series':
          series.push(event.record);
          stageGeneration = event.record.generation;
          stagePending = false;
          break;
        case 'generation':
          generations.push(event.record);
          stageGeneration = event.record.generation;
          stagePending = true;
          break;
        case 'screeningRound':
          screeningRounds.push(event.record);
          stageGeneration = event.record.generation;
          stagePending = false;
          break;
      }
    };

    const control = attempt.control;
    const runOptions: RunAdaptiveExperimentOptions = {
      environment,
      config,
      experimentKind: 'adaptive_counter',
      pilots: pilotSpecsOf(config),
      limits: config.limits,
      retention: config.retention,
      workers: execution.workers,
      sink,
      checkpoint,
      onRawEvent,
      ...(control === undefined ? {} : { shouldStop: () => control.stopRequested() }),
    };

    let finalCheckpoint: AdaptiveCheckpoint;
    try {
      finalCheckpoint = await runAdaptiveExperiment(runOptions);
    } catch (cause) {
      sink.flush?.();
      poll.stop();
      await record(await readCanonicalProgress(directory));
      if (isExperimentStopped(cause)) {
        // Nothing decided since `checkpoint` was loaded — the caller's own
        // copy is exactly what a retry replays, the same guarantee
        // `run.test.ts` documents for `runAdaptiveExperiment` itself. Written
        // back so a first attempt's freshly constructed checkpoint is on disk
        // for the restart that resumes it, not only reconstructible from it.
        await this.#writeAdaptiveCheckpoint(directory, checkpoint);
        return this.#settle(jobId, latest, null);
      }
      return this.#fail(jobId, [runFailed(cause, jobId)], latest);
    } finally {
      poll.stop();
    }

    sink.flush?.();
    await record(await readCanonicalProgress(directory));

    let validation: AdaptiveValidationRun | null = null;
    if (finalCheckpoint.pendingGeneration === null) {
      try {
        validation = await runAdaptiveFinalValidation({ ...runOptions, checkpoint: finalCheckpoint });
      } catch (cause) {
        sink.flush?.();
        poll.stop();
        await record(await readCanonicalProgress(directory));
        if (isExperimentStopped(cause)) {
          // The learning series is fully decided either way; validation never
          // mutates a checkpoint (`run.ts`'s own doc comment), so the final one
          // is exactly what a retry resumes into.
          await this.#writeAdaptiveCheckpoint(directory, finalCheckpoint);
          return this.#settle(jobId, latest, null);
        }
        return this.#fail(jobId, [runFailed(cause, jobId)], latest);
      }
      sink.flush?.();
      await record(await readCanonicalProgress(directory));
    }

    const result = buildAdaptiveResult({
      informationPolicy: config.informationPolicy,
      checkpoint: finalCheckpoint,
      series,
      screeningRounds,
      validation,
    });
    const configHash = adaptiveConfigHashOf(config);

    await writeJsonAtomically(
      join(directory, RAW_DOCUMENT),
      adaptiveRawRecordSchema.parse({
        schemaVersion: ADAPTIVE_RAW_SCHEMA_VERSION,
        experimentId: config.id,
        configHash,
        generations,
        series,
        screeningRounds,
      }),
    );
    await this.#writeAdaptiveCheckpoint(directory, finalCheckpoint);
    await writeJsonAtomically(
      join(directory, RESULT_DOCUMENT),
      adaptiveResultSchema.parse({
        schemaVersion: ADAPTIVE_RESULT_SCHEMA_VERSION,
        experimentId: config.id,
        configHash,
        ...result,
      }),
    );

    // No `attachJobResult`: an Adaptive Counter job's `result` field stays
    // `null` forever, and `AdaptiveResultReader` reads the two documents just
    // written, directory-keyed, independent of this job document.
    const settlement = await this.#settleIfRequested(jobId, latest, null);
    if (settlement !== null) return settlement;

    const completed = await this.#store.applyJobAction({
      jobId,
      action: 'complete',
      cause: 'runner',
    });
    if (isErr(completed)) return completed;

    return ok({
      jobId,
      status: 'completed',
      stopReason: null,
      progress: latest,
      identity: null,
      failure: null,
    });
  }

  async #writeAdaptiveCheckpoint(directory: string, checkpoint: AdaptiveCheckpoint): Promise<void> {
    await writeJsonAtomically(
      join(directory, CHECKPOINT_DOCUMENT),
      adaptiveCheckpointSchema.parse(checkpoint),
    );
  }

  /**
   * The adaptive counterpart to `#prepare`.
   *
   * Two deliberate divergences from the experiment path, both required by
   * M08.R4's own acceptance: the directory is keyed on the configuration's own
   * `experimentId`, not `jobId`, because that is the address
   * `AdaptiveResultReader` already resolves a run at — matching it is what
   * makes this job's provenance point at the exact output the dashboard reads,
   * rather than a second, job-keyed copy of the same run. And there is no
   * `config.value.workers` to fall back to — `AdaptiveConfig` has none, per
   * Q53 — so a caller with no opinion gets the same default-of-one every other
   * `workers` field in this codebase declares.
   */
  async #prepareAdaptive(
    before: CatalogJobDocument,
    started: CatalogJobDocument,
    attempt: JobAttemptOptions,
  ): Promise<
    CatalogResult<{
      readonly config: AdaptiveConfig;
      readonly environment: Environment;
      readonly checkpoint: AdaptiveCheckpoint;
      readonly sink: MatchStore;
      readonly execution: JobExecution;
      readonly directory: string;
    }>
  > {
    const spec = before.spec;
    if (spec.kind !== 'adaptive_counter') {
      return err([runFailed(new Error('not an Adaptive Counter job'), before.jobId)]);
    }

    const location: ResultLocation = before.execution?.location ?? {
      rootId: this.#resultRootId,
      directory: spec.experimentId,
    };

    const resolved = await resolveResultLocation(this.#roots, location);
    if (isErr(resolved)) return resolved;

    const config = await this.#store.readAdaptiveJobConfig(before.jobId);
    if (isErr(config)) return config;

    const configHash = adaptiveConfigHashOf(config.value);
    if (configHash !== spec.configHash) {
      return err([configDrifted(before.jobId)]);
    }

    const reading = await readCanonicalProgress(resolved.value);
    if (reading.streamIdentity !== null && reading.streamIdentity.configHash !== spec.configHash) {
      return err([streamDrifted(before.jobId)]);
    }

    let environment: Environment;
    let checkpoint: AdaptiveCheckpoint;
    let sink: MatchStore;
    try {
      environment = resolveEnvironment(config.value.environment);
      checkpoint = await this.#loadOrCreateAdaptiveCheckpoint(
        resolved.value,
        config.value,
        configHash,
        environment,
      );
      sink = new MatchStore(resolved.value, {
        experimentId: config.value.id,
        experimentKind: 'adaptive_counter',
        configHash,
        resume: true,
      });
    } catch (cause) {
      return err([runFailed(cause, before.jobId)]);
    }

    const execution: JobExecution = {
      location,
      mode: 'in_process_workers',
      workers: attempt.workers ?? this.#workers ?? 1,
      attempts: (before.execution?.attempts ?? 0) + 1,
      lastStartedAt: started.timestamps.updatedAt,
      resumedMatches: reading.completedMatches,
    };

    const recorded = await this.#store.setJobExecution(before.jobId, execution);
    if (isErr(recorded)) return recorded;

    return ok({
      config: config.value,
      environment,
      checkpoint,
      sink,
      execution,
      directory: resolved.value,
    });
  }

  /** Reads `adaptive-checkpoint.json` if this job has one, or constructs a fresh one otherwise — never both. */
  async #loadOrCreateAdaptiveCheckpoint(
    directory: string,
    config: AdaptiveConfig,
    configHash: string,
    environment: Environment,
  ): Promise<AdaptiveCheckpoint> {
    const text = await readDocumentText(join(directory, CHECKPOINT_DOCUMENT));
    if (text === null) return freshAdaptiveCheckpoint(config, environment);

    const checkpoint = parseAdaptiveCheckpoint(JSON.parse(text));
    if (checkpoint.experimentId !== config.id || checkpoint.configHash !== configHash) {
      throw new Error(
        'This job’s checkpoint was written for a different configuration, so resuming into it ' +
          'would produce a run that is neither. Nothing was played.',
      );
    }
    return checkpoint;
  }

  /**
   * Re-reads the canonical directory on a timer until told to stop.
   *
   * A recursive `setTimeout` rather than an interval, so a slow reading can never
   * overlap the next one, and `unref` so a poller can never be the reason a
   * process stays alive. A failure to read or to record is swallowed: a progress
   * counter that could not be written is not a reason to abandon an experiment
   * that is running perfectly well.
   */
  #startPolling(
    directory: string,
    onReading: (reading: CanonicalReading) => Promise<unknown>,
  ): { stop: () => void } {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = (): void => {
      timer = setTimeout(() => {
        void (async () => {
          if (stopped) return;
          try {
            const reading = await readCanonicalProgress(directory);
            // Checked again *after* the read: a directory that was opened while
            // the run was still going can finish being read after it settled,
            // and the settled reading is the one that must stand.
            if (!stopped) await onReading(reading);
          } catch {
            // Deliberately ignored: a reading that failed is one missed sample.
          }
          if (!stopped) tick();
        })();
      }, this.#pollEveryMs);
      timer.unref?.();
    };

    tick();
    return {
      stop: () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
      },
    };
  }

  /**
   * Finishes a run that stopped because it was asked to.
   *
   * The action is read from the **document's** current status rather than from
   * the reason the control carries, so an operator who escalated a pause into a
   * cancel between the request and the stop gets the cancel. `control.ts` gives
   * the argument at length.
   *
   * A stop with no settling state under it is a genuine failure rather than a
   * confusing success: the only way to reach it is for something to have moved
   * the document out of `pausing` or `cancelling` while a run that had been asked
   * to stop was unwinding, and a job left in `running` with no process behind it
   * is exactly the state M08.2 refuses to let a restart resolve quietly.
   */
  async #settle(
    jobId: JobId,
    progress: Progress,
    identity: RunIdentity | null,
  ): Promise<CatalogResult<JobRunOutcome>> {
    const settled = await this.#settleIfRequested(jobId, progress, identity);
    if (settled !== null) return settled;
    return this.#fail(jobId, [stoppedWithoutRequest(jobId)], progress);
  }

  /** The same settlement, or `null` when the document is not asking for one. */
  async #settleIfRequested(
    jobId: JobId,
    progress: Progress,
    identity: RunIdentity | null,
  ): Promise<CatalogResult<JobRunOutcome> | null> {
    const current = await this.#store.readJob(jobId);
    if (isErr(current)) return current;

    const action = settleActionFor(current.value.status);
    if (action === null) return null;

    const moved = await this.#store.applyJobAction({ jobId, action, cause: 'runner' });
    if (isErr(moved)) return moved;

    return ok({
      jobId,
      status: 'stopped',
      stopReason: action === 'cancel_settled' ? 'cancel' : 'pause',
      progress,
      identity,
      failure: null,
    });
  }

  async #fail(
    jobId: JobId,
    errors: readonly AdminError[],
    progress: Progress,
  ): Promise<CatalogResult<JobRunOutcome>> {
    const failure = errors[0] ?? runFailed(new Error('unknown failure'), jobId);
    const moved = await this.#store.applyJobAction({
      jobId,
      action: 'fail',
      cause: 'runner',
      failure,
    });
    if (isErr(moved)) return moved;
    return ok({ jobId, status: 'failed', stopReason: null, progress, identity: null, failure });
  }
}

/**
 * The denominator, taken from `buildSchedule` through M08.3's estimator.
 *
 * Not a canonical reading, and it does not pretend to be: how many matches a
 * configuration schedules is a property of the configuration, and the estimator
 * is the one place that answer is derived. An estimate this build cannot compute
 * — an unresolvable deck source, say — leaves the denominator `null`, which is
 * exactly what `progressSchema` means by it: *three states, all of them honest —
 * a known exact total, a known bound, and no answer yet.*
 */
function scheduleOf(config: ExperimentConfig): {
  readonly matches: number | null;
  readonly isBound: boolean;
} {
  try {
    const estimate = estimateExperiment(config);
    return { matches: estimate.totalMatches, isBound: estimate.basis !== 'exact' };
  } catch {
    return { matches: null, isBound: false };
  }
}

function runFailed(cause: unknown, jobId: JobId): AdminError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return adminError('admin/run_failed', scrubRefusal(`This run stopped: ${message}`), {
    context: { jobId },
  });
}

function configDrifted(jobId: JobId): AdminError {
  return adminError(
    'admin/run_failed',
    'The stored experiment configuration no longer hashes to the address this job records, so it was not run. The job’s own output was left where it is.',
    { path: 'spec.configHash', context: { jobId } },
  );
}

function streamDrifted(jobId: JobId): AdminError {
  return adminError(
    'admin/run_failed',
    'This job’s directory already holds a raw-record stream from a different configuration, so resuming into it would produce a run that is neither. Nothing was played.',
    { path: 'spec.configHash', context: { jobId } },
  );
}

function stoppedWithoutRequest(jobId: JobId): AdminError {
  return adminError(
    'admin/run_failed',
    'This run stopped as though it had been asked to, but the job is in no state that a stop settles into. Everything it played is on disk and nothing was written over it.',
    { path: 'status', context: { jobId } },
  );
}

function identityDrifted(jobId: JobId): AdminError {
  return adminError(
    'admin/run_failed',
    'The manifest this run wrote names a different configuration than the job that started it, so it was not indexed as this job’s result.',
    { path: 'spec.configHash', context: { jobId } },
  );
}
