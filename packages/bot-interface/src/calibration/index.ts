export {
  CALIBRATION_FACETS,
  CALIBRATION_FACET_REGISTRY,
  calibrationFacetGaps,
  calibrationFacetSchema,
  facetsApplicableTo,
  type CalibrationFacet,
  type CalibrationFacetDefinition,
} from './facets.js';

export {
  CALIBRATED_PILOT_IDS,
  fixtureSeed,
  gapsFor,
  runFixture,
  runFixtureAcrossPilots,
  type FixtureResult,
  type TacticalFixture,
} from './fixture.js';

export {
  CalibrationTable,
  attackersIn,
  blockersIn,
  calibrationDatabase,
  playIndexOf,
  preconMatchDeck,
  type AskedDecision,
  type BotRng,
  type TableOptions,
} from './table.js';

export {
  CALIBRATION_FIXTURES,
  CALIBRATION_FORMAT_ID,
  CALIBRATION_SUITE_VERSION,
  assertCalibrationSuiteComplete,
  calibratedPreconIds,
  calibrationGaps,
  coverageOf,
  fixturesForFacet,
  fixturesForPrecon,
  preconCards,
  type PreconCoverage,
} from './registry.js';

export {
  compareCalibrationSuite,
  compareFixture,
  type CalibrationReport,
  type FixtureComparison,
  type PilotCalibration,
} from './compare.js';
