/**
 * `@tcg/bot-config` — what a bot seat *is*, before any of it crosses a wire.
 *
 * A contract package and nothing else: strict versioned schemas, two total
 * registries, one arithmetic function, and two privacy projections. It knows
 * nothing about pilots, the engine, the lobby or the UI, so a client that has to
 * validate a bot seat view does not drag a decision procedure in with it, and
 * the dependency direction stays the one ADR 0001 chose.
 *
 * The four axes it defines are independent on purpose
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §5): deck
 * source decides what cards a bot brings, difficulty how well it chooses, style
 * what it prefers, and timing how long it waits. None of them is a rename of
 * another.
 */

export {
  BOT_CONFIG_SCHEMA_VERSION,
  CURRENT_BOT_CONFIG_VERSIONS,
  DIFFICULTY_REGISTRY_VERSION,
  PACING_CONFIG_VERSION,
  botConfigIssues,
  refuseFutureVersion,
  type BotConfigVersionField,
} from './version.js';

export {
  AVAILABLE_DIFFICULTIES,
  BOT_DIFFICULTIES,
  CANDIDATE_SELECTION_KINDS,
  DIFFICULTY_REGISTRY,
  DIFFICULTY_STATUSES,
  EASY_SELECTION,
  PLANNED_DIFFICULTIES,
  assertDifficultyRegistryComplete,
  botDifficultySchema,
  candidateSelectionKindSchema,
  difficultyDefinition,
  difficultyIsAvailable,
  difficultyRegistryGaps,
  difficultySelection,
  difficultySelectionSchema,
  difficultyStatusSchema,
  type BotDifficulty,
  type CandidateSelectionKind,
  type DifficultyDefinition,
  type DifficultySelection,
  type DifficultyStatus,
} from './difficulty.js';

export {
  BOT_STYLES,
  BOT_STYLE_REGISTRY,
  botStyleDefinition,
  botStyleRegistryGaps,
  botStyleSchema,
  type BotStyle,
  type BotStyleDefinition,
} from './style.js';

export {
  BOT_DECK_MODES,
  DECK_MODE_SUPPORT,
  botDeckModeSchema,
  botDeckSnapshotSchema,
  botDeckSourcePublicSchema,
  botDeckSourceSchema,
  botSeedSchema,
  configuredCommanderIdOf,
  deckHashSchema,
  deckModeGenerates,
  deckModeIsSupported,
  generatedDeckProvenanceSchema,
  publicDeckSourceOf,
  type BotDeckMode,
  type BotDeckSnapshot,
  type BotDeckSource,
  type BotDeckSourcePublic,
  type GeneratedDeckProvenance,
} from './deck-source.js';

export {
  BOT_DECISION_CATEGORIES,
  DEFAULT_BOT_PACING_BUDGETS,
  DEFAULT_BUDGET_SECONDS,
  IMMEDIATE_BOT_PACING,
  MAX_BUDGET_SECONDS,
  MAX_PACING_PERCENT,
  MIN_BUDGET_SECONDS,
  MIN_PACING_PERCENT,
  PACING_BUDGET_BY_CATEGORY,
  PACING_BUDGET_KEYS,
  PACING_SAFETY_MARGIN_MS,
  botDecisionCategorySchema,
  botDelayMs,
  botDelayTable,
  botPacingBudgetsSchema,
  botPacingSchema,
  budgetSecondsFor,
  pacingBudgetKeySchema,
  pacingDelayMs,
  pacingPercentFor,
  pacingPercentSchema,
  pacingRegistryGaps,
  readBotPacingBudgets,
  type BotDecisionCategory,
  type BotPacing,
  type BotPacingBudgets,
  type PacingBudgetKey,
} from './pacing.js';

export {
  DEFAULT_BOT_DIFFICULTY,
  FIELDS_A_BOT_CONTROLLER_NEVER_HAS,
  SEAT_CONTROLLERS,
  botControllerSchema,
  botDisplayNameSchema,
  botIdSchema,
  botSeatConfigSchema,
  botSeatPublicSchema,
  publicBotSeatOf,
  readBotSeatConfig,
  seatControllerSchema,
  type BotController,
  type BotSeatConfig,
  type BotSeatPublic,
  type SeatController,
} from './seat-config.js';
