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
 * - **M08.5** gives an operator control over it — bounded concurrency, pause,
 *   resume, cancel and a visible retry. This tranche uses exactly two lifecycle
 *   actions, `start` and one of `complete` or `fail`, and leaves the rest alone.
 * - **M08.6** adds the HTTP boundary, loopback binding and the non-loopback
 *   authentication refusal. It is the first tranche that opens a port, and the
 *   first that gives this workspace a `start` script.
 *
 * So there is deliberately **no entry point** in this package yet. A `main.ts`
 * that bound nothing would be the premature scaffolding the milestone warns
 * against; the runner is driven by its tests today and by the service that owns
 * it in M08.6.
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
  RecoveredJob,
  RecoveryReport,
  UnreadableEntry,
} from './catalog/store.js';

export {
  PRESET_FORMAT_ID,
  PresetRefused,
  expandPreset,
  scrubRefusal,
  type ExpandedPreset,
  type ExpandedStage,
} from './lab/expand.js';

export {
  ExperimentRunner,
  type ExperimentRunnerOptions,
  type JobRunOutcome,
  type RunExperimentFn,
} from './run/job-runner.js';

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
