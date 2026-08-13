import {
  bundledPrecon,
  loadBundledCardData,
  preconsForFormat,
  type CardDefinition,
} from '@tcg/card-data';
import {
  CALIBRATION_FACETS,
  CALIBRATION_FACET_REGISTRY,
  facetsApplicableTo,
  type CalibrationFacet,
} from './facets.js';
import type { TacticalFixture } from './fixture.js';
import { BASTION_GUARDIANS_FIXTURES } from './fixtures-bastion-guardians.js';
import { CONTAINMENT_CONTROL_FIXTURES } from './fixtures-containment-control.js';
import { GOBLIN_SWARM_FIXTURES } from './fixtures-goblin-swarm.js';
import { GRAVE_SACRIFICE_FIXTURES } from './fixtures-grave-sacrifice.js';

/**
 * The tactical calibration suite (M05.6).
 *
 * Bumped when the *fixtures* change — one added, one retired, a claim reworded —
 * so a calibration citation can be read against the suite that produced it, the
 * way `AGENT_CLASS_REGISTRY_VERSION` pins a taxonomy. A `knownGaps` entry moving
 * does **not** bump it: that is a measurement changing, which is what the suite
 * is for, and the suite is the same instrument either way.
 *
 * - 1 — M05.6, the first suite: sixteen fixtures over the four Wave 1 precons.
 */
export const CALIBRATION_SUITE_VERSION = 1;

/** The construction format the shipped fixtures calibrate. */
export const CALIBRATION_FORMAT_ID = 'precon_wave_1';

export const CALIBRATION_FIXTURES: readonly TacticalFixture[] = [
  ...BASTION_GUARDIANS_FIXTURES,
  ...CONTAINMENT_CONTROL_FIXTURES,
  ...GOBLIN_SWARM_FIXTURES,
  ...GRAVE_SACRIFICE_FIXTURES,
];

export function fixturesForPrecon(preconId: string): readonly TacticalFixture[] {
  return CALIBRATION_FIXTURES.filter((fixture) => fixture.preconId === preconId);
}

export function fixturesForFacet(facet: CalibrationFacet): readonly TacticalFixture[] {
  return CALIBRATION_FIXTURES.filter((fixture) => fixture.facet === facet);
}

/** The cards a precon is built from, Commander included. */
export function preconCards(preconId: string): readonly CardDefinition[] {
  const precon = bundledPrecon(preconId);
  if (!precon) return [];
  const { database } = loadBundledCardData();
  return [precon.commanderId, ...precon.cardIds].map((cardId) => database.getOrThrow(cardId));
}

/** What a precon's calibration covers, and what it cannot pose a question in. */
export interface PreconCoverage {
  readonly preconId: string;
  readonly applicable: readonly CalibrationFacet[];
  readonly covered: readonly CalibrationFacet[];
  readonly missing: readonly CalibrationFacet[];
  /** Facets this deck cannot ask about at all, with the facet's own question. */
  readonly notApplicable: readonly CalibrationFacet[];
}

export function coverageOf(preconId: string): PreconCoverage {
  const cards = preconCards(preconId);
  const applicable = facetsApplicableTo(cards);
  const covered = [
    ...new Set(fixturesForPrecon(preconId).map((fixture) => fixture.facet)),
  ].sort() as CalibrationFacet[];
  return {
    preconId,
    applicable,
    covered: CALIBRATION_FACETS.filter((facet) => covered.includes(facet)),
    missing: applicable.filter((facet) => !covered.includes(facet)),
    notApplicable: CALIBRATION_FACETS.filter((facet) => !applicable.includes(facet)),
  };
}

/**
 * Every way the shipped suite could be out of date, in both directions.
 *
 * Precon IDs arrive as content rather than as a type — a set is a directory of
 * JSON, and `PRECON_IDS` is not a union the compiler can total a `Record` over —
 * so the coverage guarantee that the facet vocabulary gets from the type system
 * has to be made here instead. It is the same guarantee: a precon added to the
 * format without a calibration fixture, or a fixture that claims to calibrate a
 * facet its own deck cannot pose, is a named failure rather than a silent gap.
 */
export function calibrationGaps(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const fixture of CALIBRATION_FIXTURES) {
    if (seen.has(fixture.id)) problems.push(`two fixtures share the ID "${fixture.id}".`);
    seen.add(fixture.id);

    const precon = bundledPrecon(fixture.preconId);
    if (!precon) {
      problems.push(
        `fixture "${fixture.id}" names precon "${fixture.preconId}", which is not bundled.`,
      );
      continue;
    }
    if (precon.formatId !== CALIBRATION_FORMAT_ID) {
      problems.push(
        `fixture "${fixture.id}" calibrates "${fixture.preconId}", which is not in ` +
          `${CALIBRATION_FORMAT_ID}.`,
      );
    }
    if (!fixture.id.startsWith(`${fixture.preconId.replace(/^precon_/, '')}/`)) {
      problems.push(`fixture "${fixture.id}" is not prefixed with the deck it calibrates.`);
    }
    if (fixture.claim.trim() === '') problems.push(`fixture "${fixture.id}" states no claim.`);

    const definition = CALIBRATION_FACET_REGISTRY[fixture.facet];
    if (!definition) {
      problems.push(`fixture "${fixture.id}" is filed under unknown facet "${fixture.facet}".`);
      continue;
    }
    if (!definition.appliesTo(preconCards(fixture.preconId))) {
      problems.push(
        `fixture "${fixture.id}" calibrates ${fixture.facet}, but no card in ` +
          `"${fixture.preconId}" can pose that question.`,
      );
    }
  }

  for (const preconId of calibratedPreconIds()) {
    const coverage = coverageOf(preconId);
    for (const facet of coverage.missing) {
      problems.push(
        `"${preconId}" can pose a ${facet} question and has no fixture for it: ` +
          CALIBRATION_FACET_REGISTRY[facet].question,
      );
    }
  }
  return problems;
}

/** Every precon in the calibrated format, sorted, from the bundled content. */
export function calibratedPreconIds(): string[] {
  return preconsForFormat(CALIBRATION_FORMAT_ID)
    .map((precon) => precon.id)
    .sort();
}

export function assertCalibrationSuiteComplete(): void {
  const problems = calibrationGaps();
  if (problems.length > 0) {
    throw new Error(`The tactical calibration suite is out of date:\n- ${problems.join('\n- ')}`);
  }
}
