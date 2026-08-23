import { join } from 'node:path';

import {
  CATALOG_DOCUMENT_VERSION,
  DIRECT_JOB_ORIGIN,
  JOB_EVENT_VERSION,
  NO_ANNOTATIONS,
  NO_CATALOG_FILTER,
  NO_PROGRESS,
  adminError,
  adminSchemaErrors,
  applyBatchTransition,
  applyJobTransition,
  batchIdSchema,
  catalogBatchDocumentSchema,
  catalogJobDocumentSchema,
  fullContentHashesOf,
  isTerminalJobStatus,
  jobEventSchema,
  jobExecutionSchema,
  jobIdSchema,
  jobTransition,
  pageRequestSchema,
  storedResultReferenceSchema,
  JOB_STATUSES,
  type AdminError,
  type Annotations,
  type BatchAction,
  type BatchId,
  type CatalogBatchDocument,
  type CatalogFilter,
  type CatalogJobDocument,
  type EntryTimestamps,
  type JobEvent,
  type JobEventLog,
  type JobExecution,
  type JobId,
  type JobStatus,
  type PageRequestInput,
  type Progress,
  type StoredResultReference,
} from '@tcg/admin-contracts';
import { err, generateId, isErr, ok, type IdSources } from '@tcg/shared';
import type { ExperimentConfig } from '@tcg/simulator';

import { encodeCursor, comparePositions, decodeCursor, isAfter } from './cursor.js';
import {
  appendJsonLine,
  documentExists,
  documentPath,
  ensureDirectory,
  listDocumentNames,
  readDocument,
  readJsonLines,
  writeJsonAtomically,
} from './files.js';
import { prepareJobConfig, readJobConfig, writeJobConfig } from './job-config.js';
import { resolveResultLocation, type ResolvedCatalogRoots } from './roots.js';
import { KeyedMutex } from './serialize.js';
import type {
  CatalogPage,
  CatalogResult,
  CatalogStore,
  JobActionInput,
  NewBatchInput,
  NewJobInput,
  RecoveredJob,
  RecoveryReport,
  UnreadableEntry,
} from './store.js';

/**
 * The catalog, as a directory of validated JSON documents and one append-only
 * log per job.
 *
 * ```
 * <catalogRoot>/
 *   batches/batch_<id>.json    one document per test batch, ordered membership
 *   jobs/job_<id>.json         one document per experiment job, independent
 *   configs/job_<id>.json      the experiment configuration that job runs (M08.4)
 *   events/job_<id>.jsonl      one append-only history per job
 * ```
 *
 * The configuration is a fourth file rather than a field, and it is written in
 * the simulator's own schema: it is byte-shaped exactly like the `config.json` a
 * run writes into its own directory, because it *is* that document. A catalog
 * document cannot hold a shape `@tcg/admin-contracts` cannot validate, and
 * restating `experimentConfigSchema` there would be the second copy of the
 * experiment schema this milestone forbids.
 *
 * Flat directories keyed by ID, because the ID alphabet was chosen for exactly
 * this: `@tcg/admin-contracts` restricts an ID body to `[a-z0-9]` and says why —
 * *M08.2 uses these IDs as file and directory names, so the set of characters an
 * ID may contain is the set a traversal would have to be built from*. There is
 * no `.`, no separator, no `..` and no uppercase, so a document name is safe by
 * construction rather than by escaping, and two IDs cannot collide on a
 * case-insensitive filesystem.
 *
 * ## What the store guarantees
 *
 * - **A reader never sees half a document.** Every write is a temporary file and
 *   a `rename`; a crash leaves the previous document intact and at most one
 *   `.tmp` file that no listing reads.
 * - **Nothing is trusted on the way in or on the way out.** A document is parsed
 *   by its schema before it is written *and* after it is read. A file edited by
 *   hand, restored from a backup, or written by a build that is not this one is
 *   refused with a reason rather than loaded.
 * - **Recovered work is never finished work.** `recover()` moves in-flight jobs
 *   to `interrupted` through the lifecycle table, and `interrupted` has no route
 *   to `completed` at all.
 * - **Jobs are independent.** Mutations are serialized per document, so two jobs
 *   in one batch never wait for each other, and moving one rewrites nothing else.
 * - **The catalog indexes; it never owns a run.** A job holds a reference to an
 *   experiment directory. There is no method that deletes, moves or writes
 *   inside one, and a reference that does not resolve inside a configured result
 *   root is refused rather than followed (ADR 0023 §3, §5).
 *
 * ## The cost this accepts
 *
 * `listJobs` reads every job document. ADR 0023 §3 accepted that trade
 * deliberately — the volume is bounded by how many experiments a person starts —
 * and put the escape hatch behind `CatalogStore` for the day the trade stops
 * paying. Because every document is in hand anyway, `total` is reported exactly
 * rather than left null; a successor that cannot count cheaply is free to return
 * null, which is why the contract makes it nullable.
 */
export interface FileCatalogStoreOptions {
  readonly roots: ResolvedCatalogRoots;
  /** Injectable so a test can mint a colliding ID deliberately. */
  readonly idSources?: IdSources;
  /** Injectable so timestamps in a test are the test's. */
  readonly clock?: () => Date;
}

/** The three statuses a restart finds work in, derived rather than listed. */
const INTERRUPTIBLE_STATUSES: readonly JobStatus[] = JOB_STATUSES.filter(
  (status) => jobTransition(status, 'interrupt') !== null,
);

export class FileCatalogStore implements CatalogStore {
  readonly #roots: ResolvedCatalogRoots;
  readonly #idSources: IdSources | undefined;
  readonly #clock: () => Date;
  readonly #locks = new KeyedMutex();

  readonly #batchDir: string;
  readonly #jobDir: string;
  readonly #configDir: string;
  readonly #eventDir: string;

  constructor(options: FileCatalogStoreOptions) {
    this.#roots = options.roots;
    this.#idSources = options.idSources;
    this.#clock = options.clock ?? (() => new Date());
    this.#batchDir = join(options.roots.catalogRoot, 'batches');
    this.#jobDir = join(options.roots.catalogRoot, 'jobs');
    this.#configDir = join(options.roots.catalogRoot, 'configs');
    this.#eventDir = join(options.roots.catalogRoot, 'events');
  }

  /** Creates the catalog layout. Separate from the constructor because it does I/O. */
  async open(): Promise<void> {
    for (const directory of [this.#batchDir, this.#jobDir, this.#configDir, this.#eventDir]) {
      await ensureDirectory(directory);
    }
  }

  /* ------------------------------------------------------------- batches */

  async createBatch(input: NewBatchInput): Promise<CatalogResult<CatalogBatchDocument>> {
    const batchId = this.#mint('batch');
    if (!batchIdSchema.safeParse(batchId).success) return err([mintingFailed('batch')]);

    const now = this.#now();
    const document: CatalogBatchDocument = {
      documentVersion: CATALOG_DOCUMENT_VERSION,
      batchId,
      label: input.label,
      status: 'draft',
      timestamps: freshTimestamps(now),
      annotations: input.annotations ?? NO_ANNOTATIONS,
      jobIds: [],
    };

    const path = documentPath(this.#batchDir, batchId);
    return this.#locks.run(path, async () => {
      if (await documentExists(path)) return err([duplicateId('batch', batchId)]);
      const validated = catalogBatchDocumentSchema.safeParse(document);
      if (!validated.success) return err(adminSchemaErrors(validated.error));
      await writeJsonAtomically(path, validated.data);
      return ok(validated.data);
    });
  }

  /**
   * Reads a batch under its own lock.
   *
   * Locking a *read* looks like caution and is not. On Windows a `rename` over a
   * destination another handle has open fails outright with `EPERM`, so a reader
   * and a writer of the same document genuinely collide there — the store's own
   * reads are the collision most likely to happen, and taking the lock removes
   * that class entirely rather than retrying through it. Out-of-process readers
   * remain, and `writeJsonAtomically` handles those.
   */
  async readBatch(batchId: BatchId): Promise<CatalogResult<CatalogBatchDocument>> {
    return this.#locks.run(documentPath(this.#batchDir, batchId), () =>
      this.#readBatchDocument(batchId),
    );
  }

  async listBatches(
    page?: PageRequestInput,
  ): Promise<CatalogResult<CatalogPage<CatalogBatchDocument>>> {
    const loaded = await this.#loadAll(
      this.#batchDir,
      catalogBatchDocumentSchema,
      'admin/unknown_batch',
    );
    return this.#paginate(
      loaded.documents,
      loaded.unreadable,
      (document) => ({ createdAt: document.timestamps.createdAt, id: document.batchId }),
      page,
    );
  }

  async applyBatchAction(
    batchId: BatchId,
    action: BatchAction,
  ): Promise<CatalogResult<CatalogBatchDocument>> {
    const path = documentPath(this.#batchDir, batchId);
    return this.#locks.run(path, async () => {
      const current = await this.#readBatchDocument(batchId);
      if (isErr(current)) return current;

      const moved = applyBatchTransition(current.value.status, action);
      if (!moved.ok) return err([moved.error]);

      const now = this.#now();
      const next: CatalogBatchDocument = {
        ...current.value,
        status: moved.to,
        timestamps: {
          ...current.value.timestamps,
          updatedAt: now,
          startedAt: current.value.timestamps.startedAt ?? (moved.to === 'running' ? now : null),
          completedAt: batchIsFinished(moved.to)
            ? (current.value.timestamps.completedAt ?? now)
            : null,
        },
      };
      return this.#writeBatch(path, next);
    });
  }

  /* ---------------------------------------------------------------- jobs */

  /**
   * Creates a job and appends it to its batch, in that order.
   *
   * The batch's lock is held for the whole operation and the job's is not,
   * because the job file is brand new: no other caller can hold a reference to
   * an ID that has not been returned yet. That also keeps the lock order
   * single-level — nothing here takes two locks — so two concurrent creations
   * cannot deadlock on each other.
   *
   * Membership is editable only while the batch is a `draft`. `enqueue` is the
   * moment an ordering becomes final (`BATCH_LIFECYCLE`), and a job appearing in
   * a batch that had already started would change what "the scheduled work" meant
   * after a person had read it.
   */
  async createJob(input: NewJobInput): Promise<CatalogResult<CatalogJobDocument>> {
    const batchPath = documentPath(this.#batchDir, input.batchId);

    return this.#locks.run(batchPath, async () => {
      const batch = await this.#readBatchDocument(input.batchId);
      if (isErr(batch)) return batch;

      if (batch.value.status !== 'draft') {
        return err([
          adminError(
            'admin/illegal_transition',
            `A batch in \`${batch.value.status}\` has a settled ordering, so a job cannot be added to it.`,
            {
              path: 'batchId',
              context: { entry: 'batch', from: batch.value.status, action: 'add_job' },
            },
          ),
        ]);
      }

      const jobId = this.#mint('job');
      if (!jobIdSchema.safeParse(jobId).success) return err([mintingFailed('job')]);

      const jobPath = documentPath(this.#jobDir, jobId);
      if (await documentExists(jobPath)) return err([duplicateId('job', jobId)]);

      // Before anything is minted or written: a configuration that cannot be
      // stored and read back as itself is refused, so a job is never queued
      // against a run nobody asked for.
      const prepared = prepareJobConfig(input.config);
      if (isErr(prepared)) return prepared;

      const now = this.#now();
      const document: CatalogJobDocument = {
        documentVersion: CATALOG_DOCUMENT_VERSION,
        jobId,
        batchId: input.batchId,
        label: input.label,
        spec: prepared.value.spec,
        origin: input.origin ?? DIRECT_JOB_ORIGIN,
        purpose: input.purpose,
        sourceClasses: [...input.sourceClasses],
        status: 'queued',
        progress: NO_PROGRESS,
        timestamps: freshTimestamps(now),
        annotations: input.annotations ?? NO_ANNOTATIONS,
        failure: null,
        execution: null,
        result: null,
      };

      const validated = catalogJobDocumentSchema.safeParse(document);
      if (!validated.success) return err(adminSchemaErrors(validated.error));

      // The configuration first, then the job, then its membership. Each step
      // leaves the catalog readable if the next one never happens: a
      // configuration nothing points at is invisible, a job whose batch has not
      // listed it yet is a job the next append will list, and a batch naming a
      // job with no document would be the one dangling reference of the three.
      await writeJobConfig(this.#configPath(jobId), prepared.value.stored);
      await writeJsonAtomically(jobPath, validated.data);

      const withMember: CatalogBatchDocument = {
        ...batch.value,
        jobIds: [...batch.value.jobIds, jobId],
        timestamps: { ...batch.value.timestamps, updatedAt: now },
      };
      const written = await this.#writeBatch(batchPath, withMember);
      if (isErr(written)) return written;

      await this.#append(jobId, {
        eventVersion: JOB_EVENT_VERSION,
        jobId,
        at: now,
        kind: 'created',
        batchId: input.batchId,
        label: input.label,
        purpose: input.purpose,
        sourceClasses: validated.data.sourceClasses,
      });

      return ok(validated.data);
    });
  }

  /** Reads a job under its own lock, for the reason `readBatch` gives. */
  async readJob(jobId: JobId): Promise<CatalogResult<CatalogJobDocument>> {
    return this.#locks.run(documentPath(this.#jobDir, jobId), () => this.#readJobDocument(jobId));
  }

  async listJobs(
    filter?: CatalogFilter,
    page?: PageRequestInput,
  ): Promise<CatalogResult<CatalogPage<CatalogJobDocument>>> {
    const active = filter ?? NO_CATALOG_FILTER;
    const loaded = await this.#loadAll(this.#jobDir, catalogJobDocumentSchema, 'admin/unknown_job');
    const matching = loaded.documents.filter((document) => jobMatchesFilter(document, active));
    return this.#paginate(
      matching,
      loaded.unreadable,
      (document) => ({ createdAt: document.timestamps.createdAt, id: document.jobId }),
      page,
    );
  }

  /**
   * The batch's members, in the batch's order.
   *
   * Not a filtered listing: `listJobs` sorts by `createdAt` then ID, and the
   * batch's order is the administrator's, which is a different thing the moment
   * M08.9 lets them reorder it. A member whose document cannot be read is
   * reported rather than skipped, because a batch that quietly lost a job would
   * misreport how much work it holds.
   */
  async readBatchJobs(batchId: BatchId): Promise<CatalogResult<readonly CatalogJobDocument[]>> {
    const batch = await this.readBatch(batchId);
    if (isErr(batch)) return batch;

    const members: CatalogJobDocument[] = [];
    const problems: AdminError[] = [];
    for (const jobId of batch.value.jobIds) {
      const job = await this.readJob(jobId);
      if (isErr(job)) {
        problems.push(...job.error);
        continue;
      }
      members.push(job.value);
    }
    if (problems.length > 0) return err(problems);
    return ok(members);
  }

  async applyJobAction(input: JobActionInput): Promise<CatalogResult<CatalogJobDocument>> {
    const cause = input.cause ?? 'operator';
    return this.#mutateJob(input.jobId, (current, now) => {
      const moved = applyJobTransition(current.status, input.action);
      if (!moved.ok) return err([moved.error]);

      const next = withStatus(current, moved.to, now, input.failure ?? null);
      const event: JobEvent = {
        eventVersion: JOB_EVENT_VERSION,
        jobId: current.jobId,
        at: now,
        kind: 'transition',
        action: input.action,
        from: current.status,
        to: moved.to,
        cause,
        failure: input.failure ?? null,
      };
      return ok({ document: next, events: [event] });
    });
  }

  async setJobProgress(
    jobId: JobId,
    progress: Progress,
  ): Promise<CatalogResult<CatalogJobDocument>> {
    // Not an event. A counter moving is not a decision, and a log line per match
    // would bury the four kinds of line that are (`events.ts`).
    return this.#mutateJob(jobId, (current, now) =>
      ok({
        document: { ...current, progress, timestamps: { ...current.timestamps, updatedAt: now } },
        events: [],
      }),
    );
  }

  /**
   * The configuration this job was created with, re-validated on the way out.
   *
   * Re-parsed rather than trusted, exactly as every catalog document is: the file
   * may have been edited by hand, restored from a backup, or written by a build
   * whose `CONFIG_SCHEMA_VERSION` is not this one's — and that last case gets the
   * readable sentence rather than a literal mismatch.
   */
  async readJobConfig(jobId: JobId): Promise<CatalogResult<ExperimentConfig>> {
    if (!jobIdSchema.safeParse(jobId).success) {
      return err([adminError('admin/unknown_job', 'That is not a job identifier.')]);
    }
    return this.#locks.run(this.#configPath(jobId), () =>
      readJobConfig(this.#configPath(jobId), { jobId }),
    );
  }

  /**
   * Records where and how this job ran.
   *
   * Not an event, for the reason progress is not one: which directory a job owns
   * is a fact the document answers exactly, and a log line per attempt would say
   * nothing the `start` transition beside it does not already say.
   *
   * The location is checked before it is stored, the same way `attachJobResult`
   * checks one — so a document in the catalog never names a directory the store
   * would refuse to open, whichever field it names it in.
   */
  async setJobExecution(
    jobId: JobId,
    execution: JobExecution,
  ): Promise<CatalogResult<CatalogJobDocument>> {
    const validated = jobExecutionSchema.safeParse(execution);
    if (!validated.success) return err(adminSchemaErrors(validated.error));

    const resolved = await resolveResultLocation(this.#roots, validated.data.location);
    if (isErr(resolved)) return err(resolved.error);

    return this.#mutateJob(jobId, (current, now) =>
      ok({
        document: {
          ...current,
          execution: validated.data,
          timestamps: { ...current.timestamps, updatedAt: now },
        },
        events: [],
      }),
    );
  }

  async setJobAnnotations(
    jobId: JobId,
    annotations: Annotations,
  ): Promise<CatalogResult<CatalogJobDocument>> {
    return this.#mutateJob(jobId, (current, now) =>
      ok({
        document: {
          ...current,
          annotations,
          timestamps: { ...current.timestamps, updatedAt: now },
        },
        events: [
          {
            eventVersion: JOB_EVENT_VERSION,
            jobId: current.jobId,
            at: now,
            kind: 'annotated',
            annotations,
          },
        ],
      }),
    );
  }

  /**
   * Records which canonical experiment directory this job produced.
   *
   * The reference is resolved and checked *before* it is written, so a document
   * in the catalog never names a location the store would refuse to open. That
   * ordering is the difference between refusing an escape and storing one for a
   * later tranche to trip over.
   */
  async attachJobResult(
    jobId: JobId,
    reference: StoredResultReference,
  ): Promise<CatalogResult<CatalogJobDocument>> {
    const validated = storedResultReferenceSchema.safeParse(reference);
    if (!validated.success) return err(adminSchemaErrors(validated.error));

    const resolved = await resolveResultLocation(this.#roots, validated.data.location);
    if (isErr(resolved)) return err(resolved.error);

    return this.#mutateJob(jobId, (current, now) =>
      ok({
        document: {
          ...current,
          result: validated.data,
          timestamps: { ...current.timestamps, updatedAt: now },
        },
        events: [
          {
            eventVersion: JOB_EVENT_VERSION,
            jobId: current.jobId,
            at: now,
            kind: 'result_attached',
            identity: validated.data.identity,
          },
        ],
      }),
    );
  }

  /* -------------------------------------------------------- history */

  async readJobEvents(jobId: JobId): Promise<CatalogResult<JobEventLog>> {
    if (!jobIdSchema.safeParse(jobId).success) {
      return err([adminError('admin/unknown_job', 'That is not a job identifier.')]);
    }
    const { records, skipped } = await readJsonLines(
      this.#eventLogPath(jobId),
      jobEventSchema,
      'jobEvent',
    );
    return ok({ jobId, events: [...records], skipped: [...skipped] });
  }

  /* ------------------------------------------------------- recovery */

  /**
   * What a restart does about work that was in flight when the process went
   * away.
   *
   * The set of statuses this touches is **derived from the lifecycle table** —
   * every status with an `interrupt` transition — rather than listed, so a state
   * added to the table later is recovered or left alone by the table's own
   * decision instead of by this function's memory of it. Today that is `running`,
   * `pausing` and `cancelling`.
   *
   * `queued` and `paused` are settled and durable: a restart finds them exactly
   * as they were, so recovering them would be deciding something rather than
   * reading it. Terminal jobs are finished and are not reopened. And nothing here
   * can reach `completed`, because the table offers no route from `interrupted`
   * to it — which is the promise M08.2 makes in the strongest available form.
   *
   * A job whose document cannot be read is reported and **left where it is**. An
   * unreadable file is evidence of something, and overwriting it with a state
   * this build guessed at would destroy the only copy.
   */
  async recover(): Promise<CatalogResult<RecoveryReport>> {
    const loaded = await this.#loadAll(this.#jobDir, catalogJobDocumentSchema, 'admin/unknown_job');
    const recovered: RecoveredJob[] = [];
    const problems: AdminError[] = [];

    for (const document of loaded.documents) {
      if (!INTERRUPTIBLE_STATUSES.includes(document.status)) continue;
      const moved = await this.applyJobAction({
        jobId: document.jobId,
        action: 'interrupt',
        cause: 'recovery',
      });
      if (isErr(moved)) {
        problems.push(...moved.error);
        continue;
      }
      recovered.push({ jobId: document.jobId, from: document.status, to: moved.value.status });
    }

    if (problems.length > 0) return err(problems);
    return ok({
      scannedJobs: loaded.documents.length,
      recovered,
      unreadable: loaded.unreadable,
    });
  }

  /* ------------------------------------------------------- internals */

  #now(): string {
    return this.#clock().toISOString();
  }

  #mint(prefix: string): string {
    return this.#idSources === undefined ? generateId(prefix) : generateId(prefix, this.#idSources);
  }

  #eventLogPath(jobId: JobId): string {
    return join(this.#eventDir, `${jobId}.jsonl`);
  }

  #configPath(jobId: JobId): string {
    return documentPath(this.#configDir, jobId);
  }

  async #append(jobId: JobId, event: JobEvent): Promise<void> {
    const validated = jobEventSchema.safeParse(event);
    // A line that cannot be validated is not written. The document beside it is
    // already correct, and an unreadable history is worse than a short one.
    if (!validated.success) return;
    await appendJsonLine(this.#eventLogPath(jobId), validated.data);
  }

  async #readBatchDocument(batchId: BatchId): Promise<CatalogResult<CatalogBatchDocument>> {
    if (!batchIdSchema.safeParse(batchId).success) {
      return err([
        adminError('admin/unknown_batch', 'That is not a test batch identifier.', {
          path: 'batchId',
        }),
      ]);
    }
    return readDocument(documentPath(this.#batchDir, batchId), catalogBatchDocumentSchema, {
      missingCode: 'admin/unknown_batch',
      missingMessage: `No test batch \`${batchId}\` is in this catalog.`,
      versionField: 'catalogDocument',
      context: { batchId },
    });
  }

  async #readJobDocument(jobId: JobId): Promise<CatalogResult<CatalogJobDocument>> {
    if (!jobIdSchema.safeParse(jobId).success) {
      return err([
        adminError('admin/unknown_job', 'That is not an experiment job identifier.', {
          path: 'jobId',
        }),
      ]);
    }
    return readDocument(documentPath(this.#jobDir, jobId), catalogJobDocumentSchema, {
      missingCode: 'admin/unknown_job',
      missingMessage: `No experiment job \`${jobId}\` is in this catalog.`,
      versionField: 'catalogDocument',
      context: { jobId },
    });
  }

  async #writeBatch(
    path: string,
    document: CatalogBatchDocument,
  ): Promise<CatalogResult<CatalogBatchDocument>> {
    const validated = catalogBatchDocumentSchema.safeParse(document);
    if (!validated.success) return err(adminSchemaErrors(validated.error));
    await writeJsonAtomically(path, validated.data);
    return ok(validated.data);
  }

  /**
   * Read, change, validate, write, then log — under the job's own lock.
   *
   * The order is the part worth stating. The **document is written before the
   * event**, because the document is the authority and the log is history: a
   * crash between the two loses a line of history about a change that really
   * happened, which is recoverable, while the reverse would leave a log claiming
   * a transition the catalog never made, which is not.
   */
  async #mutateJob(
    jobId: JobId,
    change: (
      current: CatalogJobDocument,
      now: string,
    ) => CatalogResult<{ document: CatalogJobDocument; events: readonly JobEvent[] }>,
  ): Promise<CatalogResult<CatalogJobDocument>> {
    const path = documentPath(this.#jobDir, jobId);
    return this.#locks.run(path, async () => {
      const current = await this.#readJobDocument(jobId);
      if (isErr(current)) return current;

      const changed = change(current.value, this.#now());
      if (isErr(changed)) return changed;

      const validated = catalogJobDocumentSchema.safeParse(changed.value.document);
      if (!validated.success) return err(adminSchemaErrors(validated.error));

      await writeJsonAtomically(path, validated.data);
      for (const event of changed.value.events) await this.#append(jobId, event);
      return ok(validated.data);
    });
  }

  async #loadAll<T>(
    directory: string,
    schema: Parameters<typeof readDocument<T>>[1],
    missingCode: 'admin/unknown_job' | 'admin/unknown_batch',
  ): Promise<{ documents: T[]; unreadable: UnreadableEntry[] }> {
    const documents: T[] = [];
    const unreadable: UnreadableEntry[] = [];

    for (const name of await listDocumentNames(directory)) {
      const id = name.slice(0, -'.json'.length);
      const path = join(directory, name);
      const read = await this.#locks.run(path, () =>
        readDocument(path, schema, {
          missingCode,
          missingMessage: 'This catalog document disappeared while it was being listed.',
          versionField: 'catalogDocument',
        }),
      );
      if (isErr(read)) {
        unreadable.push({ id: isLegalId(id) ? id : null, errors: read.error });
        continue;
      }
      documents.push(read.value);
    }
    return { documents, unreadable };
  }

  /**
   * One page of an ordering, and the cursor that continues it.
   *
   * `nextCursor` is issued only when a row was actually left behind, so a caller
   * that loops until it is null makes exactly one extra request rather than one
   * per page, and never mistakes a full last page for a partial one.
   */
  async #paginate<T>(
    documents: readonly T[],
    unreadable: readonly UnreadableEntry[],
    positionOf: (document: T) => { createdAt: string; id: string },
    request?: PageRequestInput,
  ): Promise<CatalogResult<CatalogPage<T>>> {
    const parsed = pageRequestSchema.safeParse(request ?? {});
    if (!parsed.success) return err(adminSchemaErrors(parsed.error));
    const { limit, cursor } = parsed.data;

    const ordered = [...documents].sort((left, right) =>
      comparePositions(positionOf(left), positionOf(right)),
    );

    let remaining = ordered;
    if (cursor !== null) {
      const position = decodeCursor(cursor);
      if (isErr(position)) return err(position.error);
      remaining = ordered.filter((document) => isAfter(positionOf(document), position.value));
    }

    const items = remaining.slice(0, limit);
    const last = items.at(-1);
    const hasMore = remaining.length > items.length;

    return ok({
      items,
      page: {
        returned: items.length,
        limit,
        nextCursor: hasMore && last !== undefined ? encodeCursor(positionOf(last)) : null,
        total: ordered.length,
      },
      unreadable: [...unreadable],
    });
  }
}

/* ---------------------------------------------------------------- helpers */

/**
 * Opens a catalog: construct, create the layout, and recover in-flight work.
 *
 * Recovery is part of opening rather than something a caller may forget,
 * because "running work is never recovered as completed" is a promise about what
 * the catalog *says*, and a store that had not swept yet would say `running`
 * about a process that no longer exists.
 */
export async function openFileCatalogStore(
  options: FileCatalogStoreOptions,
): Promise<CatalogResult<{ store: FileCatalogStore; recovery: RecoveryReport }>> {
  const store = new FileCatalogStore(options);
  await store.open();
  const recovery = await store.recover();
  if (isErr(recovery)) return err(recovery.error);
  return ok({ store, recovery: recovery.value });
}

function freshTimestamps(now: string): EntryTimestamps {
  return { createdAt: now, updatedAt: now, startedAt: null, completedAt: null };
}

const batchIsFinished = (status: string): boolean =>
  status === 'completed' || status === 'cancelled';

/**
 * The document a status change produces, including which instants move.
 *
 * `statusTimestampProblems` in the contract is the rule this has to satisfy, and
 * the interesting case is `retry`: `failed → queued` is only a legal document
 * once `completedAt` is cleared, so a retried job cannot sit in the queue still
 * claiming it finished. Clearing it here rather than at the call site is what
 * makes that true of every route into a non-terminal state, including ones a
 * later tranche adds.
 */
function withStatus(
  current: CatalogJobDocument,
  status: JobStatus,
  now: string,
  failure: AdminError | null,
): CatalogJobDocument {
  const terminal = isTerminalJobStatus(status);
  const started = current.timestamps.startedAt ?? (status === 'running' ? now : null);
  return {
    ...current,
    status,
    // A job that has *left* `failed` is not failed any more, and the only way to
    // leave it is `retry` — an operator saying "try this again" (M08.5). Carrying
    // the previous attempt's diagnostics forward would leave a document spelling
    // `completed` beside the reason it fell over, which is the one reading of it
    // that is certainly wrong. Nothing is lost: the `fail` line in the event log
    // holds those diagnostics, which is where "how did it get here" lives.
    failure: status === 'failed' ? failure : current.status === 'failed' ? null : current.failure,
    timestamps: {
      ...current.timestamps,
      updatedAt: now,
      startedAt: started,
      completedAt: terminal ? (current.timestamps.completedAt ?? now) : null,
    },
  };
}

const isLegalId = (id: string): boolean =>
  jobIdSchema.safeParse(id).success || batchIdSchema.safeParse(id).success;

function duplicateId(kind: string, id: string): AdminError {
  return adminError(
    'admin/duplicate_id',
    `A ${kind} named \`${id}\` is already in this catalog, so nothing was written over it.`,
    { context: { entry: kind, id } },
  );
}

function mintingFailed(kind: string): AdminError {
  return adminError('admin/malformed', `The catalog could not mint a legal ${kind} identifier.`, {
    context: { entry: kind },
  });
}

/**
 * Whether one job matches a filter.
 *
 * OR within a field, AND across fields — the semantics `filters.ts` states,
 * implemented once here so a screen and a store cannot disagree about what an
 * empty array means.
 *
 * Two members are answerable only for a job that has a result, and this is a
 * genuine limitation rather than an oversight: `kinds` and `fullContentHash`
 * both read the **run identity**, and a job acquires one when its experiment
 * directory exists. A queued job has no kind, because M08.1's job document
 * carries no configuration reference at all — M08.4 is the tranche that maps a
 * job to a config and a directory, and it is the first that could put a kind on
 * a job before it runs. Until then a job with no result matches neither filter,
 * which is the honest answer to "which runs are searches" for a run that is not
 * yet a run.
 */
export function jobMatchesFilter(job: CatalogJobDocument, filter: CatalogFilter): boolean {
  if (filter.status.length > 0 && !filter.status.includes(job.status)) return false;
  if (filter.purpose !== null && job.purpose !== filter.purpose) return false;
  if (
    filter.sourceClasses.length > 0 &&
    !job.sourceClasses.some((value) => filter.sourceClasses.includes(value))
  ) {
    return false;
  }
  if (filter.batchId !== null && job.batchId !== filter.batchId) return false;
  if (filter.tags.length > 0 && !job.annotations.tags.some((tag) => filter.tags.includes(tag))) {
    return false;
  }
  if (filter.baseline !== null && job.annotations.baseline !== filter.baseline) return false;
  if (filter.createdAfter !== null && job.timestamps.createdAt < filter.createdAfter) return false;
  if (filter.createdBefore !== null && job.timestamps.createdAt > filter.createdBefore) {
    return false;
  }

  // Read from the spec rather than from the result, which is M08.2's recorded
  // limitation closed: *a queued job has no kind to filter on* was true only
  // because a kind lived exclusively inside a result, and a job acquires one of
  // those by finishing. A job has had a kind since it was created since M08.4.
  if (filter.kinds.length > 0 && !filter.kinds.includes(job.spec.kind)) return false;
  if (filter.fullContentHash !== null) {
    if (job.result === null) return false;
    if (!fullContentHashesOf(job.result.identity).includes(filter.fullContentHash)) return false;
  }
  return true;
}
