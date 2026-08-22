/**
 * `@tcg/admin-contracts` — the language `apps/admin-client` and
 * `apps/admin-server` speak, and nothing that acts on it.
 *
 * A schema-only package, in the sense
 * [ADR 0023](../../../docs/architecture/0023-admin-lab-boundary.md) §1 means it:
 * strict versioned zod schemas for batch and job identity, lifecycle state and
 * its transitions, progress, catalog and result references, pagination, filters,
 * request and response envelopes, and structured errors. It opens no file,
 * binds no port, spawns no process, runs no experiment and renders nothing. Both
 * future applications import it, so a contract change is a compile error on both
 * sides rather than a runtime surprise on one.
 *
 * What it deliberately does **not** contain is as much of the design as what it
 * does:
 *
 * - **No results.** A catalog entry references an experiment directory and the
 *   hashes that identify the run inside it. Every number a result view shows is
 *   read back out of the canonical artefacts at the moment it is shown
 *   (ADR 0023 §3, ADR 0012). Nothing here can express "this run's win rate".
 * - **No second copy of an existing contract.** Experiment configuration,
 *   manifests, summaries, reports and checkpoints belong to `@tcg/simulator`;
 *   deck construction identity to `@tcg/deck-generator`; bot seats, difficulties
 *   and the M09 match summary to `@tcg/bot-config` and `@tcg/protocol`; evidence
 *   claims and calibration standing to `@tcg/bot-interface`. Where this package
 *   names something one of them owns, it names the *word* and says why the
 *   dependency direction ADR 0001 fixed does not allow the import.
 * - **No filesystem path in any input.** A request names an identifier the
 *   server resolves (ADR 0023 §5). `resultLocationSchema` is the one shape that
 *   holds a root and a directory, it is reachable only from the persisted
 *   document, and `boundary.test.ts` reads these sources to keep it that way.
 * - **No dependency from the player bundle.** `@tcg/web-client` does not depend
 *   on this package and must not: a separate bundle is what makes "a player
 *   build cannot ship an admin control" a fact rather than a guard.
 */

export {
  ADMIN_VERSION_FIELDS,
  ADMIN_CONTRACT_VERSION,
  CATALOG_DOCUMENT_VERSION,
  CURRENT_ADMIN_VERSIONS,
  JOB_EVENT_VERSION,
  catalogDocumentVersionSchema,
  contractVersionSchema,
  isFutureVersion,
  jobEventVersionSchema,
  refuseFutureVersion,
  type AdminVersionField,
} from './version.js';

export {
  JOB_EVENT_CAUSES,
  JOB_EVENT_KINDS,
  jobAnnotatedEventSchema,
  jobCreatedEventSchema,
  jobEventCauseSchema,
  jobEventKindSchema,
  jobEventLogSchema,
  jobEventSchema,
  jobResultAttachedEventSchema,
  jobTransitionEventSchema,
  type JobEvent,
  type JobEventCause,
  type JobEventKind,
  type JobEventLog,
} from './events.js';

export {
  ADMIN_ERROR_CODES,
  FORBIDDEN_CONTEXT_KEYS,
  MAX_CONTEXT_ENTRIES,
  MAX_CONTEXT_STRING,
  adminError,
  adminErrorCodeSchema,
  adminErrorSchema,
  adminSchemaErrors,
  errorPathSchema,
  isForbiddenContextKey,
  looksLikeFilesystemPath,
  safeContextSchema,
  toIssue,
  type AdminError,
  type AdminErrorCode,
  type SafeContext,
} from './errors.js';

export {
  BATCH_ID_PREFIX,
  EXPERIMENT_KINDS,
  EXPERIMENT_PURPOSES,
  JOB_ID_PREFIX,
  SOURCE_CLASSES,
  batchIdSchema,
  canonicalSourceClasses,
  contentHashSchema,
  entryTimestampsSchema,
  experimentKindSchema,
  experimentPurposeSchema,
  experimentSlugSchema,
  jobIdSchema,
  labelSchema,
  sourceClassSchema,
  sourceClassesSchema,
  stageIdSchema,
  stageRefSchema,
  tagSchema,
  timestampSchema,
  type BatchId,
  type ContentHash,
  type EntryTimestamps,
  type ExperimentKind,
  type ExperimentPurpose,
  type ExperimentSlug,
  type JobId,
  type SourceClass,
  type StageId,
  type StageRef,
  type Tag,
  type Timestamp,
} from './identity.js';

export {
  BATCH_ACTIONS,
  BATCH_LIFECYCLE,
  BATCH_STATUSES,
  BATCH_TERMINAL_STATUSES,
  BATCH_TRANSITIONS,
  JOB_ACTIONS,
  JOB_LIFECYCLE,
  JOB_STATUSES,
  JOB_STATUSES_REQUIRING_START,
  JOB_TERMINAL_STATUSES,
  JOB_TRANSITIONS,
  NO_PROGRESS,
  applyBatchTransition,
  applyJobTransition,
  applyTransition,
  batchActionSchema,
  batchStatusSchema,
  batchTransition,
  isTerminal,
  isTerminalBatchStatus,
  isTerminalJobStatus,
  jobActionSchema,
  jobStatusSchema,
  jobTransition,
  legalActions,
  legalBatchActions,
  legalJobActions,
  nextState,
  progressSchema,
  reachableStates,
  type BatchAction,
  type BatchStatus,
  type JobAction,
  type JobStatus,
  type LifecycleModel,
  type LifecycleTransition,
  type Progress,
} from './lifecycle.js';

export {
  MAX_ENVIRONMENTS_PER_RUN,
  MAX_JOBS_PER_BATCH,
  MAX_NOTE_LENGTH,
  MAX_TAGS,
  NO_ANNOTATIONS,
  RESULT_PATH_MAX_SEGMENTS,
  annotationsSchema,
  catalogBatchDocumentSchema,
  catalogBatchViewOf,
  catalogBatchViewSchema,
  catalogJobDocumentSchema,
  catalogJobViewOf,
  catalogJobViewSchema,
  environmentContentHashesSchema,
  experimentDirectorySchema,
  fullContentHashesOf,
  resultLocationSchema,
  resultReferenceOf,
  resultReferenceSchema,
  resultRootIdSchema,
  runEnvironmentRefSchema,
  runIdentitySchema,
  statusTimestampProblems,
  storedResultReferenceSchema,
  type Annotations,
  type CatalogBatchDocument,
  type CatalogBatchView,
  type CatalogJobDocument,
  type CatalogJobView,
  type EnvironmentContentHashes,
  type ResultLocation,
  type ResultReference,
  type RunEnvironmentRef,
  type RunIdentity,
  type StoredResultReference,
} from './catalog.js';

export {
  BASIS_WORDING,
  DECK_COUNT_SOURCES,
  ESTIMATE_BASES,
  FORCED_INCLUSION_CAVEAT,
  combineBases,
  deckCountSchema,
  deckCountSourceSchema,
  estimateBasisSchema,
  estimateStageSchema,
  forcedInclusionFloorSchema,
  matchCountEstimateSchema,
  seatOrderCountSchema,
  type DeckCount,
  type DeckCountSource,
  type EstimateBasis,
  type EstimateStage,
  type ForcedInclusionFloor,
  type MatchCountEstimate,
  type SeatOrderCount,
} from './estimate.js';

export {
  AVAILABLE_PRESET_IDS,
  EXPERIMENT_PRESET_IDS,
  PRESET_DECISION_SOURCES,
  PRESET_REGISTRY,
  PRESET_STATUSES,
  PRESET_TEST_STYLES,
  experimentPresetIdSchema,
  presetChoiceSchema,
  presetDecisionSchema,
  presetDecisionSourceSchema,
  presetExpansionSchema,
  presetStageSchema,
  presetStatusSchema,
  presetTestStyleSchema,
  type ExperimentPresetDefinition,
  type ExperimentPresetId,
  type PresetChoice,
  type PresetChoiceInput,
  type PresetDecision,
  type PresetDecisionSource,
  type PresetExpansion,
  type PresetStage,
  type PresetStatus,
  type PresetTestStyle,
  type PresetValue,
} from './presets.js';

export {
  CURSOR_MAX_LENGTH,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PAGE_SIZE_MIN,
  cursorSchema,
  pageInfoSchema,
  pageOf,
  pageRequestSchema,
  pageSizeSchema,
  type Cursor,
  type PageInfo,
  type PageRequest,
  type PageRequestInput,
} from './pagination.js';

export {
  MAX_FILTER_VALUES,
  NO_CATALOG_FILTER,
  catalogFilterSchema,
  type CatalogFilter,
  type CatalogFilterInput,
} from './filters.js';

export {
  ADMIN_REQUEST_PAYLOAD_NAMES,
  ADMIN_REQUEST_PAYLOAD_SCHEMAS,
  adminRequest,
  adminResponse,
  batchPageSchema,
  batchRefSchema,
  jobActionRequestSchema,
  jobPageSchema,
  jobRefSchema,
  listBatchesRequestSchema,
  listJobsRequestSchema,
  setJobAnnotationsRequestSchema,
  type AdminRequestPayloadName,
  type BatchPage,
  type BatchRef,
  type JobActionRequest,
  type JobPage,
  type JobRef,
  type ListBatchesRequest,
  type ListJobsRequestInput,
  type ListJobsRequest,
  type SetJobAnnotationsRequest,
} from './requests.js';
