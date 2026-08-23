import type {
  AdminError,
  Annotations,
  BatchAction,
  BatchId,
  CatalogBatchDocument,
  CatalogFilter,
  CatalogJobDocument,
  ExperimentPurpose,
  JobAction,
  JobEventCause,
  JobEventLog,
  JobExecution,
  JobId,
  JobOrigin,
  JobStatus,
  PageInfo,
  PageRequestInput,
  Progress,
  SourceClass,
  StoredResultReference,
} from '@tcg/admin-contracts';
import type { Result } from '@tcg/shared';
import type { ExperimentConfig } from '@tcg/simulator';

/**
 * What the catalog can do, stated once and separately from how it does it.
 *
 * [ADR 0023](../../../../docs/architecture/0023-admin-lab-boundary.md) §3 chose
 * files, and then chose to keep the choice reversible: *if list-and-filter at
 * real sizes ever stops being answerable this way, the implementation changes
 * behind that interface and nothing above it moves.* That escape hatch is only
 * real if the interface is written against what a caller needs rather than
 * against what a directory of JSON happens to make easy, so three things below
 * are shaped by the successor rather than by the incumbent:
 *
 * - **Every method is asynchronous.** A database driver is, and so is the M08.6
 *   request handler that will call this.
 * - **No method takes or returns a path.** `StoredResultReference` carries a
 *   configured root's *identifier*; turning that into a real path is the file
 *   implementation's private business and is checked before it is used
 *   (ADR 0023 §5).
 * - **Identifiers are minted here, not passed in.** `admin/duplicate_id` exists
 *   in the contract because *minting one is the store's job, never a caller's*.
 *   A caller that supplied IDs could make two jobs the same job; the injectable
 *   `IdSources` in the file implementation is how a test forces the collision
 *   this refuses without one ever happening by chance.
 *
 * ## What is deliberately absent
 *
 * There is **no delete**, of an entry or of anything else. ADR 0023 §3 states
 * the consequence plainly — *deleting a catalog entry must not delete an
 * experiment directory* — and M08.28 is the tranche that decides whether a
 * deletion feature exists at all, with the standing preference that *omission is
 * preferable to an unsafe delete button*. A store with no way to express removal
 * cannot have an unsafe one.
 *
 * There is **no reorder, no duplicate and no removal of batch membership**.
 * M08.9 owns editing a batch before it starts. What M08.2 owns is that
 * membership is *ordered* and that the order is the administrator's — so jobs
 * are appended in creation order and no method sorts them.
 *
 * There is **no execution**. Nothing here starts a match, opens a socket or
 * spawns anything. `applyJobAction` moves a document from one lifecycle state to
 * another and writes the move down; whether a worker is actually running is
 * M08.4's and M08.5's, and this interface is what they record through.
 *
 * > **What M08.4 added, and what it deliberately did not.** A job is now created
 * > *with* a validated experiment configuration, which the store keeps beside the
 * > catalog and hands back on request, and it records where a run happened
 * > through `setJobExecution`. Holding a configuration is not running one: the
 * > store still starts nothing, and `run/job-runner.ts` is the only thing in this
 * > workspace that calls `runExperiment`.
 */

/** Every catalog answer is a value or a list of structured refusals, never a throw. */
export type CatalogResult<T> = Result<T, readonly AdminError[]>;

/* ------------------------------------------------------------------ inputs */

export interface NewBatchInput {
  readonly label: string;
  readonly annotations?: Annotations;
}

export interface NewJobInput {
  /** The batch this job joins. Its order in that batch is the order it was created in. */
  readonly batchId: BatchId;
  readonly label: string;
  readonly purpose: ExperimentPurpose;
  readonly sourceClasses: readonly SourceClass[];
  readonly annotations?: Annotations;
  /**
   * The experiment this job runs, already validated by the simulator.
   *
   * Required rather than optional, because `lifecycle.ts` says why there is no
   * job `draft` state: *M08.9 edits membership before start and a job is
   * validated when it is created*. A job with no configuration would be a job
   * nothing could ever start, and the queue would be holding a placeholder.
   *
   * The type is `@tcg/simulator`'s, so a caller cannot hand over a shape the
   * simulator would refuse — and the store re-parses it anyway on the way back
   * out, because a file on disk may not have come from this build.
   */
  readonly config: ExperimentConfig;
  /**
   * What asked for this job. Defaults to `direct`.
   *
   * Optional here and required on the document, which is the same asymmetry
   * `annotations` has and for the same reason: a caller that did not say made a
   * job from a configuration it assembled itself, and `DIRECT_JOB_ORIGIN` is what
   * that is. A preset expansion says so, and the run it produces can then be
   * shown beside the limitations `PRESET_REGISTRY` publishes for it.
   */
  readonly origin?: JobOrigin;
}

export interface JobActionInput {
  readonly jobId: JobId;
  readonly action: JobAction;
  /**
   * Which authority decided it. Defaults to `operator`, because a caller that
   * did not say is a request, and the two that are not requests — a runner
   * reporting an outcome and a restart recovering in-flight work — are both
   * places that know what they are.
   */
  readonly cause?: JobEventCause;
  /** The diagnostics of a `fail`. Recorded on the document and on the log line. */
  readonly failure?: AdminError;
}

/* ----------------------------------------------------------------- listings */

/**
 * One page of entries, plus what the store could not read.
 *
 * `unreadable` is on the page rather than thrown, because one damaged document
 * must not make a catalog unlistable, and dropping it silently would make a
 * corrupt entry indistinguishable from an entry that was never created. It is
 * the same rule the event log applies to a damaged final line, applied to a
 * directory instead of to a file.
 */
export interface CatalogPage<T> {
  readonly items: readonly T[];
  readonly page: PageInfo;
  readonly unreadable: readonly UnreadableEntry[];
}

export interface UnreadableEntry {
  /** The ID the file name claims, when the name is a legal one. */
  readonly id: string | null;
  readonly errors: readonly AdminError[];
}

/* ----------------------------------------------------------------- recovery */

export interface RecoveredJob {
  readonly jobId: JobId;
  /** The in-flight state the restart found it in. */
  readonly from: JobStatus;
  /** Where the lifecycle table sent it. Never a terminal state. */
  readonly to: JobStatus;
}

/**
 * What a restart found and what it did about it.
 *
 * Returned rather than logged, because M08.5 has to *show* an operator that work
 * was interrupted, and M08.9 has to name every lifecycle state on screen. A
 * recovery that only wrote to standard output would leave both reading a status
 * with no explanation of how it got there.
 */
export interface RecoveryReport {
  readonly scannedJobs: number;
  readonly recovered: readonly RecoveredJob[];
  readonly unreadable: readonly UnreadableEntry[];
}

/* ---------------------------------------------------------------- the store */

export interface CatalogStore {
  /* batches */
  createBatch(input: NewBatchInput): Promise<CatalogResult<CatalogBatchDocument>>;
  readBatch(batchId: BatchId): Promise<CatalogResult<CatalogBatchDocument>>;
  listBatches(page?: PageRequestInput): Promise<CatalogResult<CatalogPage<CatalogBatchDocument>>>;
  applyBatchAction(
    batchId: BatchId,
    action: BatchAction,
  ): Promise<CatalogResult<CatalogBatchDocument>>;

  /* jobs */
  createJob(input: NewJobInput): Promise<CatalogResult<CatalogJobDocument>>;
  readJob(jobId: JobId): Promise<CatalogResult<CatalogJobDocument>>;
  listJobs(
    filter?: CatalogFilter,
    page?: PageRequestInput,
  ): Promise<CatalogResult<CatalogPage<CatalogJobDocument>>>;
  /** The member jobs of one batch, in the batch's own order rather than in any sort. */
  readBatchJobs(batchId: BatchId): Promise<CatalogResult<readonly CatalogJobDocument[]>>;

  applyJobAction(input: JobActionInput): Promise<CatalogResult<CatalogJobDocument>>;
  setJobProgress(jobId: JobId, progress: Progress): Promise<CatalogResult<CatalogJobDocument>>;
  /**
   * The configuration this job was created with, re-validated on the way out.
   *
   * A read rather than a field on the document: the configuration is
   * `experimentConfigSchema`'s and a catalog document cannot hold a shape it
   * cannot validate. What the document holds is the *address* of the run
   * (`spec`), which is what a listing, a filter and a queue screen actually need.
   */
  readJobConfig(jobId: JobId): Promise<CatalogResult<ExperimentConfig>>;
  /**
   * Records where and how this job ran.
   *
   * Separate from `applyJobAction` for the reason `setJobProgress` is: starting a
   * job is a lifecycle decision and belongs in the event log, while *which
   * directory it owns and how many attempts it has had* is a fact about the run
   * that the document answers exactly and cheaply.
   */
  setJobExecution(
    jobId: JobId,
    execution: JobExecution,
  ): Promise<CatalogResult<CatalogJobDocument>>;
  setJobAnnotations(
    jobId: JobId,
    annotations: Annotations,
  ): Promise<CatalogResult<CatalogJobDocument>>;
  /** Links the canonical experiment directory this job produced, after checking it. */
  attachJobResult(
    jobId: JobId,
    reference: StoredResultReference,
  ): Promise<CatalogResult<CatalogJobDocument>>;

  /* history and recovery */
  readJobEvents(jobId: JobId): Promise<CatalogResult<JobEventLog>>;
  recover(): Promise<CatalogResult<RecoveryReport>>;
}
