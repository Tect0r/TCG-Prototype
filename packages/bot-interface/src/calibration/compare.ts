import type { PilotId } from '../registry.js';
import { CALIBRATION_FACETS, type CalibrationFacet } from './facets.js';
import {
  CALIBRATED_PILOT_IDS,
  runFixture,
  type FixtureResult,
  type TacticalFixture,
} from './fixture.js';
import { CALIBRATION_FIXTURES, CALIBRATION_SUITE_VERSION } from './registry.js';
import type { TacticalProfileId } from '../tactics.js';

/**
 * Comparing pilots on identical positions (M05.6).
 *
 * The match-level comparison already exists: a schedule mirrors seats and
 * derives every match seed from one path, so two pilots meet the same decks on
 * the same shuffles. What that cannot tell you is *where* they differ, because a
 * win rate is one number at the end of thousands of decisions.
 *
 * This is the same comparison one decision at a time. Every pilot faces the
 * identical hand-authored board, the identical scripted opponent and the
 * identical generator state, so a disagreement between two pilots on a fixture
 * is a difference in valuation and cannot be a difference in luck. Nothing here
 * ranks the pilots: `aggressive` and `defensive` are one agent class with two
 * weight vectors (M05.4), and a fixture they answer differently is a fixture
 * where the deck's characteristic play is a matter of temperament — which is a
 * finding about the *fixture*, not a scoreboard.
 */

export interface FixtureComparison {
  readonly fixtureId: string;
  /** Which tactical profile the row was measured under (M09.14). */
  readonly tactics: TacticalProfileId;
  readonly preconId: string;
  readonly facet: CalibrationFacet;
  readonly claim: string;
  /** Per pilot, whether it made the characteristic decision. */
  readonly byPilot: Readonly<Record<string, boolean>>;
  /** Every calibrated pilot agreed with every other, whichever way. */
  readonly unanimous: boolean;
  /** Every calibrated pilot made the characteristic decision. */
  readonly characteristic: boolean;
  /** The reasons recorded for the pilots that did not. */
  readonly gapNotes: readonly string[];
  /** True when what happened still matches what the fixture says happens. */
  readonly matchesRecord: boolean;
}

export interface PilotCalibration {
  readonly pilotId: PilotId;
  readonly fixtures: number;
  readonly characteristic: number;
  /** Characteristic decisions as a share of fixtures. Never a skill score. */
  readonly rate: number;
}

export interface CalibrationReport {
  readonly suiteVersion: number;
  /**
   * The tactical profile every row was measured under (M09.14).
   *
   * `baseline` by default, which is what Normal and Easy fly and therefore what
   * every existing caller was already measuring. A report that did not carry
   * this could not be read at all once two profiles exist.
   */
  readonly tactics: TacticalProfileId;
  readonly fixtures: number;
  readonly pilots: readonly PilotId[];
  readonly comparisons: readonly FixtureComparison[];
  readonly byPilot: readonly PilotCalibration[];
  /** Per facet, how many fixtures every calibrated pilot got characteristically. */
  readonly byFacet: Readonly<Record<CalibrationFacet, { total: number; unanimousYes: number }>>;
  /** Fixtures the pilots disagreed on — the interesting rows. */
  readonly disputed: readonly string[];
  /** Fixtures whose recorded behaviour has changed. Empty is the passing state. */
  readonly stale: readonly string[];
}

export function compareFixture(
  fixture: TacticalFixture,
  tactics: TacticalProfileId = 'baseline',
): FixtureComparison {
  const results: FixtureResult[] = CALIBRATED_PILOT_IDS.map((pilotId) =>
    runFixture(fixture, pilotId, tactics),
  );
  const byPilot: Record<string, boolean> = {};
  for (const result of results) byPilot[result.pilotId] = result.characteristic;

  const answers = results.map((result) => result.characteristic);
  return {
    fixtureId: fixture.id,
    tactics,
    preconId: fixture.preconId,
    facet: fixture.facet,
    claim: fixture.claim,
    byPilot,
    unanimous: answers.every((answer) => answer === answers[0]),
    characteristic: answers.every(Boolean),
    gapNotes: [
      ...new Set(
        results
          .filter((result) => result.gapNote !== null)
          .map((result) => `${result.pilotId}: ${result.gapNote ?? ''}`),
      ),
    ],
    matchesRecord: results.every((result) => result.matchesRecord),
  };
}

export function compareCalibrationSuite(
  fixtures: readonly TacticalFixture[] = CALIBRATION_FIXTURES,
  tactics: TacticalProfileId = 'baseline',
): CalibrationReport {
  const comparisons = fixtures.map((fixture) => compareFixture(fixture, tactics));

  const byPilot = CALIBRATED_PILOT_IDS.map((pilotId): PilotCalibration => {
    const characteristic = comparisons.filter(
      (comparison) => comparison.byPilot[pilotId] === true,
    ).length;
    return {
      pilotId,
      fixtures: comparisons.length,
      characteristic,
      rate: comparisons.length === 0 ? 0 : characteristic / comparisons.length,
    };
  });

  const byFacet = Object.fromEntries(
    CALIBRATION_FACETS.map((facet) => {
      const rows = comparisons.filter((comparison) => comparison.facet === facet);
      return [
        facet,
        {
          total: rows.length,
          unanimousYes: rows.filter((row) => row.characteristic).length,
        },
      ];
    }),
  ) as Record<CalibrationFacet, { total: number; unanimousYes: number }>;

  return {
    suiteVersion: CALIBRATION_SUITE_VERSION,
    tactics,
    fixtures: comparisons.length,
    pilots: CALIBRATED_PILOT_IDS,
    comparisons,
    byPilot,
    byFacet,
    disputed: comparisons.filter((row) => !row.unanimous).map((row) => row.fixtureId),
    stale: comparisons.filter((row) => !row.matchesRecord).map((row) => row.fixtureId),
  };
}
