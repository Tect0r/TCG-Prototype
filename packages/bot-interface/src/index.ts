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
  type BotWeights,
  type BotWeightsInput,
  type CombatOutcome,
} from './scoring.js';

export {
  candidateActions,
  rankChoiceOptions,
  type CandidateOptions,
  type RankedOption,
} from './candidates.js';

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
  pilotIdSchema,
  pilotSpecSchema,
  PILOT_IDS,
  PILOT_BASE_WEIGHTS,
  LEGAL_ONLY_PILOT_IDS,
  type PilotId,
  type PilotSpec,
  type PilotSpecInput,
} from './registry.js';

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
