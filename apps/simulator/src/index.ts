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

export {
  checkDeck,
  deckSize,
  fromSavedDeck,
  makeDeck,
  normalizeEntries,
  simDeckSchema,
  toMatchDeck,
  toSavedDeck,
  type DeckLegality,
  type SimDeck,
  type SimDeckInput,
} from './deck-search/deck.js';

export {
  generateDeck,
  generatePopulation,
  generatorConfigSchema,
  isFullSize,
  poolFor,
  type GenerationDiagnostic,
  type GenerationResult,
  type GeneratorConfig,
  type GeneratorConfigInput,
} from './deck-search/generate.js';

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
  buildSchedule,
  deckMultisets,
  deckTuples,
  distinctRotationCount,
  pilotTuples,
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
  type DeckSummary,
  type Matchup,
  type RunSummary,
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

export { renderReport, type ReportInputs } from './reporting/report.js';

export {
  detectSoftwareCommit,
  runExperiment,
  type ExperimentOutcome,
  type RunExperimentOptions,
} from './experiment.js';

export { runJobsInPool, WorkerPoolStartupError, type PoolOptions } from './workers/pool.js';
export {
  workerJobSchema,
  workerResultSchema,
  workerSetupSchema,
  type WorkerJob,
  type WorkerResult,
  type WorkerSetup,
} from './workers/protocol.js';
