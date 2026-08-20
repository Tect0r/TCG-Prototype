export {
  DECISION_FAMILIES,
  decisionFamilySchema,
  botDiagnosticsSchema,
  botFailureSchema,
  botFailureKindSchema,
  BOT_FAILURE_KINDS,
  type ActionCandidate,
  type BotDecision,
  type BotDiagnostics,
  type BotFailure,
  type BotFailureKind,
  type BotObservation,
  type BotPolicy,
  type DecisionFamily,
} from './types.js';

export {
  botWeightsSchema,
  parseWeights,
  DEFAULT_WEIGHTS,
  boardValueOf,
  cardValue,
  effectValue,
  effectsValue,
  effectPricingGaps,
  costValue,
  costsValue,
  keywordIsValued,
  damageRemovalFraction,
  greedyBlocks,
  opponentPriority,
  opponentSummaries,
  remainingHealthOf,
  resolveHypotheticalCombat,
  selfSummary,
  summaryOf,
  unitBoardValue,
  unitViewsOf,
  wouldDefeat,
  BASELINE_COMBAT_MODEL,
  type BotWeights,
  type BotWeightsInput,
  type CombatModel,
  type CombatOutcome,
  type GreedyBlockOptions,
} from './scoring.js';

export {
  candidateActions,
  combatModelOf,
  rankChoiceOptions,
  type CandidateOptions,
  type RankedOption,
} from './candidates.js';

export {
  assertTacticalProfilesComplete,
  tacticalProfile,
  tacticalProfileGaps,
  tacticalProfileIdSchema,
  BASELINE_TACTICS,
  HARD_TACTICAL_TACTICS,
  TACTICAL_PROFILES,
  TACTICAL_PROFILE_IDS,
  TACTICAL_REFINEMENTS,
  TACTICS_REGISTRY_VERSION,
  type TacticalProfile,
  type TacticalProfileId,
  type TacticalRefinement,
} from './tactics.js';

export {
  CATEGORY_BY_DECISION_FAMILY,
  classifyDecisionCategory,
  decisionCategoryDisagreement,
  decisionCategoryGaps,
} from './decision-category.js';

export { createHeuristicPilot, scoreCandidate, type HeuristicPilotOptions } from './heuristic.js';

export {
  createRandomLegalPilot,
  randomLegalConfigSchema,
  RANDOM_LEGAL_VERSION,
  type RandomLegalConfig,
  type RandomLegalConfigInput,
} from './random-legal.js';

export { createAggressivePilot, AGGRESSIVE_WEIGHTS, AGGRESSIVE_VERSION } from './aggressive.js';
export { createDefensivePilot, DEFENSIVE_WEIGHTS, DEFENSIVE_VERSION } from './defensive.js';
export { createValuePilot, VALUE_WEIGHTS, VALUE_VERSION } from './value.js';

export {
  createPilot,
  createStyledPilot,
  createTacticalPilot,
  pilotIdSchema,
  pilotSpecSchema,
  agentClassOf,
  pilotsInAgentClass,
  PILOT_IDS,
  PILOT_BASE_WEIGHTS,
  PILOT_AGENT_CLASSES,
  PILOT_VERSIONS,
  STYLED_PILOT_IDS,
  AGENT_CLASSES_WITHOUT_PILOTS,
  LEGAL_ONLY_PILOT_IDS,
  type PilotId,
  type PilotSpec,
  type PilotSpecInput,
  type StyledPilotOptions,
} from './registry.js';

export {
  agentClassDefinition,
  agentClassGaps,
  agentClassSchema,
  agentClassSupports,
  assertAgentClassRegistryComplete,
  claimCarriedBy,
  claimsCarriedBy,
  claimsOf,
  classesBlocking,
  evidenceClaimSchema,
  AGENT_CLASSES,
  AGENT_CLASS_REGISTRY,
  AGENT_CLASS_REGISTRY_VERSION,
  EVIDENCE_CLAIMS,
  EVIDENCE_CLAIM_QUESTIONS,
  type AgentClass,
  type AgentClassDefinition,
  type EvidenceClaim,
} from './agent-class.js';

export {
  perturbPilot,
  perturbationProfile,
  perturbationProfileIdSchema,
  PERTURBATION_PROFILES,
  PERTURBATION_PROFILE_IDS,
  PERTURBATION_PROFILE_VERSION,
  PERTURBABLE_WEIGHTS,
  UNPERTURBED_WEIGHTS,
  type PerturbationProfile,
} from './perturbation.js';

export { checkActionOffered, type ActionCheck } from './validate.js';
export { decideSafely, type PilotRunOptions, type PilotRunResult } from './run-pilot.js';
