export {
  CONFIG_SCHEMA_VERSION,
  analysisSettingsSchema,
  batchConfigSchema,
  comparisonConfigSchema,
  deckSourceSchema,
  experimentConfigSchema,
  matchLimitsSchema,
  parseExperimentConfig,
  replacementConfigSchema,
  retentionSchema,
  searchConfigSchema,
  type AnalysisSettings,
  type BatchConfig,
  type ComparisonConfig,
  type DeckSource,
  type ExperimentConfig,
  type ExperimentConfigInput,
  type ReplacementConfig,
  type SearchConfig,
} from './config.js';

export {
  HASH_VERSION,
  canonicalJson,
  deckHash,
  digest,
  digestOf,
  type HashableDeck,
} from './hash.js';

export {
  SEED_DERIVATION_VERSION,
  deckPairSeed,
  deriveSeedBundle,
  environmentSeed,
  experimentSeed,
  gameSeed,
  pairedGameSeed,
  rngFor,
  seedBundleSchema,
  seedFromPath,
  seededIndex,
  type SeedBundle,
} from './seed.js';

export {
  cardPatchSchema,
  deckFormatSchema,
  diffEnvironments,
  environmentConfigForFormat,
  environmentConfigSchema,
  environmentDiffSchema,
  environmentSetSchema,
  resolveEnvironment,
  type CardPatch,
  type Environment,
  type EnvironmentConfig,
  type EnvironmentConfigInput,
  type EnvironmentDiff,
  type EnvironmentSet,
} from './environment.js';

export {
  cardMechanics,
  cardPilotMetadata,
  cardPresentation,
  computeEnvironmentHashes,
  environmentHashesSchema,
  snapshotCards,
  type EnvironmentHashes,
} from './content-hash.js';

export {
  formatReplayResult,
  loadReplayBundle,
  replayBundle,
  replayFile,
  type ReplayDivergence,
  type ReplayOptions,
  type ReplayResult,
} from './replay.js';

export {
  RESOLVED_ENVIRONMENT_SCHEMA_VERSION,
  freezeEnvironment,
  resolvedEnvironmentSchema,
  restoreEnvironment,
  serializeSnapshot,
  snapshotFileName,
  verifyEnvironmentHashes,
  type ResolvedEnvironment,
} from './resolved-environment.js';

// Re-exported rather than owned since M09.8: the deck value, its legality check
// and the deterministic draw live in `@tcg/deck-generator`, and the simulator's
// existing consumers keep importing them from here.
export {
  GENERATION_PROBLEM_CODES,
  checkDeck,
  deckSize,
  fromSavedDeck,
  generateDeck,
  generatePopulation,
  generatorConfigSchema,
  isFullSize,
  makeDeck,
  normalizeEntries,
  poolFor,
  poolReportFor,
  resolvePlan,
  simDeckSchema,
  toMatchDeck,
  toSavedDeck,
  PlanResolutionError,
  type DeckLegality,
  type GenerationDiagnostic,
  type GenerationPoolReport,
  type GenerationResult,
  type GeneratorConfig,
  type GeneratorConfigInput,
  type ResolvedPlan,
  type SimDeck,
  type SimDeckInput,
} from '@tcg/deck-generator';

export {
  crossoverDecks,
  deckDistance,
  mutateDeck,
  type MutationResult,
} from './deck-search/mutate.js';

export {
  SEARCH_CHECKPOINT_VERSION,
  fitnessSchema,
  generationReportSchema,
  runSearch,
  searchCheckpointSchema,
  type Fitness,
  type GenerationReport,
  type SearchCheckpoint,
  type SearchOptions,
  type SearchResult,
} from './deck-search/evolve.js';

export {
  resolveDeckSource,
  configDirOf,
  resolvedPreconSchema,
  type ResolvedDecks,
  type ResolvedPrecon,
} from './deck-source.js';

export {
  pilotCatalog,
  preconsForEnvironment,
  type PublishedPilot,
  type PublishedPrecon,
} from './content-catalog.js';

export {
  buildSchedule,
  deckMultisets,
  deckTuples,
  distinctRotationCount,
  matchesBetween,
  pilotTuples,
  type ScheduleDeck,
  type ScheduleOptions,
  type ScheduledMatch,
  type ScheduledSeat,
} from './schedule.js';

export {
  MATCHUP_MATRIX_SCHEMA_VERSION,
  buildMatchupMatrix,
  matchupMatrixRows,
  matchupMatrixSchema,
  type BuildMatchupMatrixInputs,
  type MatchupCell,
  type MatchupDeck,
  type MatchupGame,
  type MatchupMatrix,
  type MatchupMatrixRow,
  type MatchupSeat,
} from './matchup-matrix.js';

export {
  DEFAULT_LIMITS,
  runMatch,
  seatToAct,
  type DecisionTrace,
  type MatchLimits,
  type RunMatchOptions,
  type RunMatchResult,
  type RunMatchSeat,
} from './run-match.js';

export { runOne, type RunOneOptions, type RunOneResult } from './run-one.js';

export {
  runBatch,
  scheduleFor,
  shouldKeepReplay,
  type BatchOutcome,
  type BatchProgress,
  type BatchRetention,
  type RunBatchOptions,
} from './run-batch.js';

export {
  ABNORMAL_TERMINATIONS,
  DEAD_HAND_CATEGORIES,
  TELEMETRY_SCHEMA_VERSION,
  TERMINATION_KINDS,
  cardTelemetrySchema,
  isAbnormal,
  matchRecordSchema,
  replayBundleSchema,
  seatTelemetrySchema,
  type CardTelemetry,
  type DeadHandCategory,
  type MatchRecord,
  type ReplayBundle,
  type SeatTelemetry,
  type TerminationKind,
} from './telemetry/schema.js';

export {
  TelemetryCollector,
  type CollectedTelemetry,
  type SeatSetup,
} from './telemetry/collector.js';

export {
  aggregate,
  aggregateSchema,
  inOrder,
  usableRecords,
  type Aggregate,
  type CardSummary,
  type CommanderMatchup,
  type CommanderSummary,
  type DeckSummary,
  type Matchup,
  type RunSummary,
  type SearchDeckEvidence,
} from './analysis/aggregate.js';

export {
  clusterDecks,
  featureDistance,
  featuresOf,
  FEATURE_NAMES,
  type Cluster,
  type ClusterMatchup,
  type ClusteringResult,
  type DeckFeatures,
} from './analysis/clusters.js';

export { aggregateBoard, type BoardAggregate, type BoardMeasure } from './analysis/board.js';

export {
  aggregateLiveMatches,
  partitionLiveMatches,
  type CommanderSelectionEntry,
  type DeckMatchupEntry,
  type DeckUsageEntry,
  type LiveMatchAggregate,
  type LiveMatchAggregateOptions,
  type LiveMatchAggregatePartition,
  type LiveMatchClusterView,
  type LiveMatchDurationStats,
  type TerminationOriginCount,
} from './analysis/live-match-aggregate.js';

export {
  NO_LIVE_MATCH_FILTER,
  filterLiveMatches,
  type LiveMatchFilter,
} from './analysis/live-match-filter.js';

export {
  aggregateLiveCardEvidence,
  type CardEligibilityEntry,
  type CardEligibilityStatus,
  type CardPairEntry,
  type CommanderCardEvidence,
  type LiveCardEvidence,
  type LiveCardEvidenceOptions,
} from './analysis/live-card-evidence.js';

export {
  aggregateLiveMatchSurrenders,
  type LiveMatchSurrenderAggregate,
  type LiveMatchSurrenderOptions,
  type LiveMatchSurrenderResult,
  type SurrenderCommanderEntry,
  type SurrenderDeckEntry,
  type SurrenderExposureView,
  type SurrenderOriginCount,
  type SurrenderPendingChoiceEntry,
  type SurrenderPhaseEntry,
  type SurrenderProximityDistance,
  type SurrenderProximityEntry,
  type SurrenderStateSummary,
  type SurrenderTurnEntry,
  type UnmatchedSurrenderCapture,
} from './analysis/live-match-surrender.js';

export {
  readLiveMatchEnvelopes,
  type ReadLiveMatchEnvelopesResult,
  type SkippedLiveMatch,
} from './analysis/live-match-read.js';

export { currentLiveMatchCardDatabases } from './analysis/live-match-card-databases.js';

export { cardPairs, cardPairSchema, type CardPair } from './analysis/pairs.js';

export {
  buildInsertionVariant,
  buildReplacementVariant,
  comparableCards,
  insertionRemovalCandidates,
  replacementImpact,
  replacementImpactSchema,
  replacementVariantSchema,
  variantCardChangeSchema,
  variantDirectionSchema,
  VARIANT_DIRECTIONS,
  type InsertionOptions,
  type RemovalCandidate,
  type ReplacementImpact,
  type ReplacementVariant,
  type VariantCardChange,
  type VariantDirection,
  type VariantResult,
} from './analysis/replacement.js';

export {
  compareEnvironments,
  comparisonReportSchema,
  type CardDelta,
  type CompareInputs,
  type ComparisonReport,
  type DeckDelta,
} from './analysis/compare.js';

export {
  FLAG_LEVELS,
  FLAG_REASONS,
  computeFlags,
  flagSchema,
  type Flag,
  type FlagInputs,
  type FlagLevel,
  type FlagReason,
} from './analysis/flags.js';

export {
  cohensH,
  effectSizeLabel,
  mean,
  meanInterval,
  normalizedEntropy,
  percentile,
  proportion,
  proportionDifference,
  round,
  stdev,
  zFor,
  type Interval,
  type ProportionEstimate,
} from './analysis/stats.js';

export {
  JsonlWriter,
  ensureDir,
  experimentPaths,
  readJson,
  readJsonl,
  toCsv,
  writeCsv,
  writeJson,
  type CsvColumn,
  type ExperimentPaths,
  type JsonlReadResult,
} from './reporting/sinks.js';

export { REPORT_SCHEMA_VERSION, renderReport, type ReportInputs } from './reporting/report.js';

/**
 * The two artifact versions a run writes from modules the index otherwise keeps
 * to itself. Exported so the status audit (M07.1) can read every artifact
 * version the simulator stamps rather than transcribing two of them by hand.
 */
export { MATCH_STREAM_HEADER_VERSION } from './reporting/match-store.js';
export { REFERENCE_POPULATION_VERSION } from './reference-population.js';

export {
  MANIFEST_SCHEMA_VERSION,
  SUMMARY_SCHEMA_VERSION,
  configHashOf,
  detectSoftwareCommit,
  runExperiment,
  type ExperimentOutcome,
  type RunExperimentOptions,
} from './experiment.js';

export {
  ExperimentStopped,
  isExperimentStopped,
  type StopReason,
  type StopSignal,
} from './stop.js';

export { runJobsInPool, WorkerPoolStartupError, type PoolOptions } from './workers/pool.js';
export {
  workerJobSchema,
  workerResultSchema,
  workerSetupSchema,
  type WorkerJob,
  type WorkerResult,
  type WorkerSetup,
} from './workers/protocol.js';

export {
  CURRENT_ADAPTIVE_VERSIONS,
  ADAPTIVE_CHECKPOINT_SCHEMA_VERSION,
  ADAPTIVE_CONFIG_SCHEMA_VERSION,
  ADAPTIVE_RAW_SCHEMA_VERSION,
  ADAPTIVE_RESULT_SCHEMA_VERSION,
  ADAPTIVE_VERSION_FIELDS,
  assertCompatibleAdaptiveVersion,
  describeAdaptiveVersionProblem,
  isFutureAdaptiveVersion,
  parseAdaptiveDocument,
  type AdaptiveVersionField,
} from './adaptive/version.js';

export {
  ADAPTIVE_COMMANDER_POLICIES,
  ADAPTIVE_INFORMATION_POLICIES,
  DEFAULT_ADAPTIVE_SWAP_BOUND,
  adaptiveCommanderPolicySchema,
  adaptiveConfigSchema,
  adaptiveExperimentIdSchema,
  adaptiveInformationPolicySchema,
  adaptiveRebuildTriggerSchema,
  adaptiveSwapBoundSchema,
  parseAdaptiveConfig,
  type AdaptiveCommanderPolicy,
  type AdaptiveConfig,
  type AdaptiveConfigInput,
  type AdaptiveInformationPolicy,
  type AdaptiveRebuildTrigger,
  type AdaptiveSwapBound,
} from './adaptive/config.js';

export {
  adaptiveCheckpointSchema,
  adaptiveRawRecordSchema,
  adaptiveResultSchema,
  parseAdaptiveCheckpoint,
  parseAdaptiveRawRecord,
  parseAdaptiveResult,
  type AdaptiveCheckpoint,
  type AdaptiveRawRecord,
  type AdaptiveResult,
} from './adaptive/envelopes.js';

export {
  activeAdaptiveRevisionOf,
  adaptiveCheckpointLineageSchema,
  assertValidAdaptiveCheckpoint,
  type AdaptiveCheckpointLineage,
} from './adaptive/checkpoint.js';

export {
  ADAPTIVE_REVISION_CONSTRUCTION_KINDS,
  adaptiveCardSwapSchema,
  adaptiveRevisionConstructionKindSchema,
  adaptiveRevisionSchema,
  adaptiveRevisionSeedPath,
  assertAdaptiveLineage,
  makeAdaptiveRevision,
  parseAdaptiveRevision,
  type AdaptiveCardSwap,
  type AdaptiveRevision,
  type AdaptiveRevisionConstructionKind,
  type AdaptiveRevisionInput,
} from './adaptive/revision.js';

export {
  ADAPTIVE_GENERATED_CONSTRUCTION_KINDS,
  adaptiveGeneratedConstructionKindSchema,
  adaptiveGenerationRecordSchema,
  adaptiveRejectedCandidateSchema,
  diffSwaps,
  generateAdaptiveCandidates,
  type AdaptiveGeneratedConstructionKind,
  type AdaptiveGenerationRecord,
  type AdaptiveRejectedCandidate,
  type GenerateAdaptiveCandidatesInput,
} from './adaptive/generate.js';

export {
  ADAPTIVE_BLOCK_SIDES,
  adaptiveBlockDecisionSchema,
  adaptiveBlockGameCount,
  adaptiveBlockSideSchema,
  decideAdaptiveBlock,
  planAdaptiveBudget,
  scheduleAdaptiveBlock,
  type AdaptiveBlockDecision,
  type AdaptiveBlockOutcome,
  type AdaptiveBlockScheduleInput,
  type AdaptiveBlockScheduleResult,
  type AdaptiveBlockShortfall,
  type AdaptiveBlockSide,
  type AdaptiveBudgetPlan,
  type AdaptiveBudgetShortfall,
} from './adaptive/block.js';

export {
  ADAPTIVE_OBJECTIVES,
  ADAPTIVE_SCREENING_OPPONENT_KINDS,
  adaptiveObjectiveOf,
  adaptiveObjectiveSchema,
  adaptiveScreeningTallySchema,
  scheduleAdaptiveCandidateScreening,
  tallyAdaptiveScreening,
  type AdaptiveCandidateScreening,
  type AdaptiveCandidateScreeningInput,
  type AdaptiveObjective,
  type AdaptiveScreeningMatch,
  type AdaptiveScreeningOpponentKind,
  type AdaptiveScreeningResult,
  type AdaptiveScreeningTallies,
  type AdaptiveScreeningTally,
} from './adaptive/evaluate.js';

export {
  adaptivePromotionScore,
  adaptiveSeriesTallySchema,
  decideAdaptivePromotion,
  tallyAdaptiveSeries,
  type AdaptiveCandidateEvidence,
  type AdaptivePromotionDecision,
  type AdaptiveSeriesEntry,
  type AdaptiveSeriesTally,
  type DecideAdaptivePromotionInput,
} from './adaptive/promote.js';

export {
  adaptiveCandidateResultSchema,
  adaptiveCycleObservationSchema,
  adaptiveDeckDiffSchema,
  adaptiveReferenceFieldStandingSchema,
  adaptiveResultLineagesSchema,
  adaptiveResultPayloadSchema,
  adaptiveScreeningDecisionSchema,
  adaptiveScreeningRoundSchema,
  adaptiveSeriesRecordSchema,
  adaptiveValidationSummarySchema,
  buildAdaptiveResult,
  buildAdaptiveScreeningRound,
  detectAdaptiveCycles,
  finalAdaptiveDeckDiff,
  informationPolicyLabel,
  makeAdaptiveSeriesRecord,
  renderAdaptiveReport,
  summarizeAdaptiveReferenceField,
  type AdaptiveCandidateResult,
  type AdaptiveCycleObservation,
  type AdaptiveDeckDiff,
  type AdaptiveReferenceFieldStanding,
  type AdaptiveReportInput,
  type AdaptiveResultPayload,
  type AdaptiveScreeningDecision,
  type AdaptiveScreeningRound,
  type AdaptiveSeriesRecord,
  type AdaptiveValidationSummary,
  type BuildAdaptiveResultInput,
  type BuildAdaptiveScreeningRoundInput,
} from './adaptive/report.js';

export {
  runAdaptiveExperiment,
  runAdaptiveFinalValidation,
  type AdaptiveRawEvent,
  type AdaptiveValidationRun,
  type RunAdaptiveExperimentOptions,
} from './adaptive/run.js';

export {
  adaptiveValidationSeedPath,
  adaptiveValidationStanding,
  freezeAdaptiveFinalDecks,
  scheduleAdaptiveValidation,
  tallyAdaptiveValidation,
  type AdaptiveFrozenDecks,
  type AdaptiveFrozenRevision,
  type AdaptiveValidationOutcome,
  type AdaptiveValidationResult,
  type AdaptiveValidationScheduleInput,
} from './adaptive/validate.js';
