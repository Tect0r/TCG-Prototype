/**
 * `@tcg/admin-server` — the orchestration process
 * [ADR 0023](../../../docs/architecture/0023-admin-lab-boundary.md) §1 named.
 *
 * What this workspace is **for** is running balance experiments and serving one
 * admin client. Since M08.4 it does the first of those and none of the second,
 * because the milestone builds it in the order the pieces depend on each other:
 *
 * - **M08.2** persists batches and jobs and recovers their truthful state after a
 *   restart. It opens files under a configured root and nothing else.
 * - **M08.3 (here)** adds the match-count estimator and the typed presets. It is
 *   the first tranche that imports `@tcg/simulator`, because ADR 0023 §2 puts the
 *   estimator behind `buildSchedule` and the presets behind
 *   `experimentConfigSchema`; M08.2's own record predicted M08.4 would add that
 *   dependency, and this is the correction. Nothing here **runs** an experiment.
 * - **M08.4 (here)** turns one catalog job into one canonical experiment
 *   directory. It is the first tranche that runs anything: a job is created with
 *   a validated experiment configuration, `ExperimentRunner` plays it into the
 *   directory the job is named after, progress is read back out of that
 *   directory rather than counted, and a failure keeps every partial record so a
 *   retry resumes rather than restarts.
 * - **M08.5 (here)** gives an operator control over it. `JobQueue` runs queued
 *   jobs under a bound in two dimensions — how many experiments at once, and how
 *   many simulator workers across all of them — and adds the four verbs a person
 *   has over work in flight. `pause` and `cancel` reach the simulator's own
 *   dispatch loop as a predicate, so in-flight matches reach their normal record
 *   boundary and a stopped run writes no manifest, no summary and no report;
 *   `resume` and `retry` are ordinary starts that continue the stream already on
 *   disk. Nothing retries or resumes by itself.
 * - **M08.6 (here)** exposes all of it to one admin client, and is the first
 *   tranche that opens a port. `src/service/` holds the whole boundary: a
 *   configuration that refuses a non-loopback bind with no token *before*
 *   anything is bound, a lock that refuses a second orchestrator against one
 *   catalog, thirteen versioned endpoints whose request and response shapes are
 *   both validated, a rate limit, a body limit, and a result reader that answers
 *   every number out of the run's own directory at the moment it is asked for.
 *
 * So this package now has exactly one entry point — `src/main.ts`, reached by
 * `npm run start --workspace @tcg/admin-server` — and it is the only file that
 * reads the environment. Everything under `src/service/` can be driven without
 * it: `AdminService` takes a parsed payload and answers with a value, and
 * `startAdminHttpServer` is the only file that knows a socket exists.
 *
 * ## The boundaries this package keeps
 *
 * - It imports `@tcg/admin-contracts`, `@tcg/shared`, `@tcg/simulator` and `zod`,
 *   and nothing else. The simulator arrives as a **library**: the estimator calls
 *   `buildSchedule`, the expansion calls `parseExperimentConfig`, and exactly one
 *   file — `run/job-runner.ts` — calls `runExperiment`. `boundary.test.ts`
 *   requires it there and refuses it in every other source, and refuses
 *   `runBatch`, `runMatch`, `runSearch`, `runOne` and the worker pool everywhere,
 *   so "a run is asked for rather than assembled here" stays structural.
 * - Nothing in the player bundle or the live match server may import it, and
 *   nothing in it may import them: ADR 0023 §1 keeps the admin process and the
 *   live match process off one event loop, and M08's exclusions keep simulator
 *   CPU work out of the multiplayer server entirely.
 * - It listens on **one** port, from **one** file. `service/http.ts` is the only
 *   source that imports `node:http`; `boundary.test.ts` requires it there and
 *   refuses every server, socket and `fetch` in every other source, so "the
 *   admin surface has one door" is a fact about the sources rather than a
 *   convention.
 * - It spawns no process and invokes no shell. M08.4 needed no child process at
 *   all, so there is no argument vector to fix (ADR 0023 §2): the one process
 *   boundary a run crosses is the simulator's own worker pool, which starts a
 *   fixed module with no `argv` and hands it a schema-validated setup object.
 * - Every path it touches is resolved from configuration against a configured
 *   root, and a reference that escapes one is refused rather than followed
 *   (ADR 0023 §5).
 *
 * `boundary.test.ts` reads these sources and the manifests to keep each of those
 * a fact rather than a paragraph.
 */

export {
  FileCatalogStore,
  jobMatchesFilter,
  openFileCatalogStore,
  type FileCatalogStoreOptions,
} from './catalog/file-catalog-store.js';

export {
  resolveCatalogRoots,
  resolveResultLocation,
  type CatalogRootsInput,
  type ResolvedCatalogRoots,
} from './catalog/roots.js';

export {
  comparePositions,
  decodeCursor,
  encodeCursor,
  isAfter,
  type CatalogPosition,
} from './catalog/cursor.js';

export {
  appendJsonLine,
  documentExists,
  documentPath,
  ensureDirectory,
  listDocumentNames,
  readDocument,
  readJsonLines,
  writeJsonAtomically,
  type JsonLinesResult,
  type SkippedLine,
} from './catalog/files.js';

export { KeyedMutex } from './catalog/serialize.js';

export type {
  CatalogPage,
  CatalogResult,
  CatalogStore,
  JobActionInput,
  NewBatchInput,
  NewJobInput,
  NewSavedChoiceInput,
  RecoveredJob,
  RecoveryReport,
  SavedChoiceListing,
  UnreadableEntry,
} from './catalog/store.js';

export {
  PRESET_FORMAT_ID,
  PresetRefused,
  expandPreset,
  presetEnvironment,
  scrubRefusal,
  type ExpandedPreset,
  type ExpandedStage,
} from './lab/expand.js';

export { readContentCatalog } from './lab/content.js';

export {
  ExperimentRunner,
  type ExperimentRunnerOptions,
  type JobAttemptOptions,
  type JobRunOutcome,
  type RunExperimentFn,
} from './run/job-runner.js';

export {
  JobStopControl,
  SETTLE_ACTIONS,
  settleActionFor,
  type RunControl,
  type StopReason,
} from './run/control.js';

export {
  DEFAULT_RESOURCE_LIMITS,
  MAX_CONCURRENT_JOBS,
  MAX_TOTAL_WORKERS,
  grantWorkers,
  parseResourceLimits,
  resourceLimitsSchema,
  type ResourceLimits,
  type ResourceLimitsInput,
} from './run/limits.js';

export { JobQueue, type JobQueueOptions, type QueueSnapshot } from './run/queue.js';

export {
  NO_CANONICAL_READING,
  checkpointDirectoryOf,
  checkpointFileName,
  countCommittedRecords,
  readCanonicalProgress,
  type CanonicalReading,
  type StreamIdentity,
} from './run/progress.js';

export { readRunIdentity } from './run/manifest.js';

export {
  deckCountFor,
  estimateConfig,
  estimateExperiment,
  estimatePreset,
  forcedInclusionFor,
  type PresetEstimate,
} from './lab/estimate.js';

export {
  ADMIN_ENVIRONMENT_KEYS,
  ADMIN_TOKEN_HEADER,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_REQUEST_LIMITS,
  ENVIRONMENT_RESULT_ROOT_ID,
  MIN_TOKEN_LENGTH,
  adminTokenSchema,
  isLoopbackHost,
  parseServiceConfig,
  requestLimitsSchema,
  serviceConfigFromEnvironment,
  type AdminServiceConfig,
  type AdminServiceConfigInput,
  type RequestLimits,
  type RequestLimitsInput,
} from './service/config.js';

export {
  ORCHESTRATOR_LOCK_FILE,
  acquireOrchestratorLock,
  processIsAlive,
  type AcquireLockOptions,
  type OrchestratorLock,
} from './service/lock.js';

export {
  DEFAULT_MAX_TRACKED_CLIENTS,
  RateLimiter,
  type RateLimitDecision,
  type RateLimiterOptions,
} from './service/rate-limit.js';

export {
  ResultReader,
  decodeRowCursor,
  encodeRowCursor,
  type ResultReaderOptions,
} from './service/results.js';

export { AdminService, type AdminServiceOptions } from './service/handlers.js';

export {
  authorized,
  resolveRoute,
  startAdminHttpServer,
  type AdminHttpServer,
  type StartAdminHttpOptions,
} from './service/http.js';
