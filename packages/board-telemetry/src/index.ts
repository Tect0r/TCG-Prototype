export {
  BOARD_TELEMETRY_VERSION,
  boardSeatTelemetrySchema,
  boardTelemetrySchema,
  combatTelemetrySchema,
  emptyBoardTelemetry,
  type BoardSeatTelemetry,
  type BoardTelemetry,
  type CombatTelemetry,
} from './schema.js';

export {
  BoardTelemetryCollector,
  collectBoardTelemetry,
  type BoardTelemetryOptions,
  type BoardTelemetrySeat,
} from './collector.js';
