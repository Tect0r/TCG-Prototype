export {
  SPECTATOR_REPLAY_VERSION,
  VALID_PROVENANCE,
  spectatorReplaySchema,
  spectatorSeatSchema,
  spectatorProvenanceSchema,
  spectatorTelemetrySchema,
  spectatorSeatTelemetrySchema,
  spectatorDecisionSchema,
  checkReplayCompatibility,
  replayFormatVersion,
  type ReplayIncompatibility,
  type SpectatorDecision,
  type SpectatorProvenance,
  type SpectatorReplay,
  type SpectatorSeat,
  type SpectatorSeatTelemetry,
  type SpectatorTelemetry,
} from './schema.js';

export {
  runSpectatorMatch,
  seatToAct,
  DEFAULT_SPECTATOR_LIMITS,
  type RunSpectatorMatchOptions,
  type SpectatorLimits,
  type SpectatorSeatConfig,
} from './run.js';

export { collectTelemetry } from './telemetry.js';

export {
  groupEvents,
  GROUP_KINDS,
  type EventGroup,
  type GroupingOptions,
  type GroupKind,
} from './grouping.js';

export {
  SpectatorPlayback,
  stepDelayMs,
  BASE_STEP_MS,
  PLAYBACK_SPEEDS,
  INFORMATION_MODES,
  type InformationMode,
  type PlaybackFrame,
  type PlaybackOptions,
  type PlaybackSpeed,
} from './playback.js';

export {
  cardPoolHash,
  defaultSpectatorSetup,
  resolveSpectatorSetup,
  setupProvenance,
  spectatorDatabase,
  spectatorPrecons,
  SPECTATOR_PILOT_IDS,
  type ResolvedSetup,
  type SeatIncompleteCards,
  type SetupProblem,
  type SetupProblemKind,
  type SpectatorSetup,
  type SpectatorSetupSeat,
} from './setup.js';

export { derivePilotSeed, hashString, randomSeed } from './seed.js';
