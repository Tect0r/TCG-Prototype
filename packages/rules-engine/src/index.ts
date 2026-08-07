export {
  RULES_VERSION,
  DEFAULT_RULES_CONFIG,
  rulesConfigSchema,
  parseRulesConfig,
  type RulesConfig,
} from './config.js';

export {
  KEYWORD_BEHAVIOUR,
  ACTIVE_KEYWORDS,
  INERT_KEYWORDS,
  type KeywordBehaviour,
} from './keywords.js';

export {
  ENGINE_ERROR_CODES,
  engineError,
  engineErrorSchema,
  type EngineError,
  type EngineErrorCode,
} from './errors.js';

export {
  createRngState,
  nextFloat,
  nextInt,
  nextUint32,
  rngStateSchema,
  shuffle,
  type RngState,
} from './rng.js';

export {
  MATCH_SCHEMA_VERSION,
  MATCH_PHASES,
  MATCH_MODES,
  MATCH_STATUSES,
  MAIN_PHASES,
  LOSS_REASONS,
  instanceIdSchema,
  lossReasonSchema,
  matchModeSchema,
  matchPhaseSchema,
  matchStatusSchema,
  playerIdSchema,
  type InstanceId,
  type LossReason,
  type MatchMode,
  type MatchPhase,
  type MatchStatus,
  type PlayerId,
} from './schema/primitives.js';

export {
  cardInstanceSchema,
  combatStateSchema,
  matchResultSchema,
  matchStateSchema,
  playerStateSchema,
  resolutionItemSchema,
  MATCH_END_REASONS,
  type BlockAssignment,
  type CardInstance,
  type CombatState,
  type CostModifier,
  type MatchEndReason,
  type MatchResult,
  type MatchState,
  type PlayerState,
  type ResolutionItem,
  type StatModifier,
} from './schema/state.js';

export {
  actionSchema,
  loggedActionSchema,
  type Action,
  type ActionInput,
  type ActionType,
  type LoggedAction,
} from './schema/action.js';

export {
  gameEventSchema,
  eventCauseSchema,
  type EventCause,
  type GameEvent,
  type GameEventType,
} from './schema/event.js';

export {
  CHOICE_REASONS,
  CHOICE_TYPES,
  choiceReasonSchema,
  choiceTypeSchema,
  continuationSchema,
  pendingChoiceSchema,
  type ChoiceReason,
  type ChoiceType,
  type Continuation,
  type PendingChoice,
} from './schema/choice.js';

export {
  createMatch,
  type CreateMatchOptions,
  type MatchDeck,
  type MatchSeat,
  type MatchStart,
} from './setup.js';

export { applyAction, type ApplyContext, type ApplySuccess } from './engine.js';

export {
  legalActions,
  legalActionsSchema,
  enumerateActions,
  type ActivatableAbility,
  type LegalActions,
  type LegalActionOptions,
  type PlayableCard,
} from './legal-actions.js';

export {
  playerView,
  eventsSince,
  redactEvent,
  playerViewSchema,
  playerViewSummarySchema,
  cardInstanceViewSchema,
  type CardInstanceView,
  type PlayerView,
  type PlayerViewSummary,
} from './view.js';

export { serializeMatchState, deserializeMatchState, parseMatchState } from './serialize.js';

export {
  currentAttack,
  currentHealth,
  effectiveKeywords,
  energyCostOf,
  hasKeyword,
  isSummoningSick,
  opponentOf,
  remainingHealth,
} from './derive.js';
