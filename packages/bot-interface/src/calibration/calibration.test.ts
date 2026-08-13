import { describe, expect, it } from 'vitest';
import { bundledPrecon } from '@tcg/card-data';
import { createRngState } from '@tcg/rules-engine';
import { agentClassSupports } from '../agent-class.js';
import { createPilot, PILOT_AGENT_CLASSES, PILOT_IDS } from '../registry.js';
import {
  CALIBRATED_PILOT_IDS,
  CALIBRATION_FACETS,
  CALIBRATION_FACET_REGISTRY,
  CALIBRATION_FIXTURES,
  CALIBRATION_FORMAT_ID,
  CALIBRATION_SUITE_VERSION,
  CalibrationTable,
  assertCalibrationSuiteComplete,
  calibratedPreconIds,
  calibrationFacetGaps,
  calibrationGaps,
  compareCalibrationSuite,
  coverageOf,
  fixtureSeed,
  fixturesForPrecon,
  preconCards,
  runFixture,
} from './index.js';

/**
 * The tactical calibration suite (M05.6).
 *
 * Three separate assertions, and it matters that they are separate:
 *
 * 1. the suite is **complete** — every deck in the format is calibrated in every
 *    facet its own cards can pose a question in;
 * 2. every fixture's **recorded behaviour is still true**, in both directions, so
 *    a pilot that starts making a decision it did not make fails just as loudly
 *    as one that stops;
 * 3. the pilots faced **identical positions**, which is what makes a
 *    disagreement between two of them a fact about their valuations.
 */

describe('the calibration facet vocabulary', () => {
  it('is complete in both directions', () => {
    expect(calibrationFacetGaps()).toEqual([]);
  });

  it('derives applicability from the cards rather than accepting a claim', () => {
    const goblins = preconCards('precon_goblin_swarm');
    const graves = preconCards('precon_grave_sacrifice');

    // The one facet the shipped content genuinely splits on, and the reason
    // applicability is derived at all.
    expect(CALIBRATION_FACET_REGISTRY.sacrifice.appliesTo(graves)).toBe(true);
    expect(CALIBRATION_FACET_REGISTRY.sacrifice.appliesTo(goblins)).toBe(false);

    // And a facet no deck in the format can pose is not silently "covered".
    expect(coverageOf('precon_goblin_swarm').notApplicable).toContain('sacrifice');
    expect(coverageOf('precon_grave_sacrifice').notApplicable).toContain('reaction');
  });

  it('says nothing about a deck that is not there', () => {
    expect(CALIBRATION_FACET_REGISTRY.blocking.appliesTo([])).toBe(false);
    expect(CALIBRATION_FACET_REGISTRY.reaction.appliesTo([])).toBe(false);
  });
});

describe('the calibration suite', () => {
  it('covers every Wave 1 precon in every facet that precon can pose', () => {
    expect(calibrationGaps()).toEqual([]);
    expect(() => assertCalibrationSuiteComplete()).not.toThrow();
  });

  it('calibrates all four shipped precons', () => {
    const preconIds = calibratedPreconIds();
    expect(preconIds).toHaveLength(4);
    for (const preconId of preconIds) {
      expect(bundledPrecon(preconId)?.formatId).toBe(CALIBRATION_FORMAT_ID);
      expect(fixturesForPrecon(preconId).length).toBeGreaterThan(0);
    }
  });

  it('files every fixture under a facet its own deck can pose', () => {
    for (const fixture of CALIBRATION_FIXTURES) {
      const cards = preconCards(fixture.preconId);
      expect(CALIBRATION_FACET_REGISTRY[fixture.facet].appliesTo(cards)).toBe(true);
    }
  });

  it('is versioned, so a citation names the instrument that made it', () => {
    expect(CALIBRATION_SUITE_VERSION).toBeGreaterThan(0);
  });

  it('asks only the pilots whose class can carry a claim about play', () => {
    // A view of the agent class registry, never a second list beside it.
    expect(CALIBRATED_PILOT_IDS).toEqual(
      PILOT_IDS.filter((id) => agentClassSupports(PILOT_AGENT_CLASSES[id], 'play_quality')),
    );
    expect(CALIBRATED_PILOT_IDS).not.toContain('random_legal');
  });
});

describe('every fixture', () => {
  for (const fixture of CALIBRATION_FIXTURES) {
    for (const pilotId of CALIBRATED_PILOT_IDS) {
      const note = fixture.knownGaps?.[pilotId];
      const verb = note === undefined ? 'still' : 'still does not';
      it(`${pilotId} ${verb}: ${fixture.claim} (${fixture.id})`, () => {
        const result = runFixture(fixture, pilotId);
        expect(result.characteristic).toBe(note === undefined);
        expect(result.gapNote).toBe(note ?? null);
        // A fixture that never drew a decision out of the pilot proves nothing,
        // whichever way its answer came out.
        expect(result.decisions.length).toBeGreaterThan(0);
      });
    }
  }
});

describe('comparing pilots', () => {
  it('faces every pilot with the identical position and generator', () => {
    const fixture = CALIBRATION_FIXTURES[0];
    if (!fixture) throw new Error('no fixtures');

    // The seed is a function of the fixture alone, so nothing about which pilot
    // is flying can reach the shuffle, the board or the tie-break.
    expect(fixtureSeed(fixture)).toBe(`calibration:${fixture.id}`);
    for (const pilotId of CALIBRATED_PILOT_IDS) {
      expect(fixtureSeed(fixture)).toBe(`calibration:${fixture.id}`);
      expect(runFixture(fixture, pilotId).fixtureId).toBe(fixture.id);
    }
  });

  it('produces the same answer every time it is run', () => {
    const fixture = CALIBRATION_FIXTURES[0];
    if (!fixture) throw new Error('no fixtures');
    const first = runFixture(fixture, 'value');
    const second = runFixture(fixture, 'value');
    expect(second.characteristic).toBe(first.characteristic);
    expect(second.decisions.map((decision) => decision.key)).toEqual(
      first.decisions.map((decision) => decision.key),
    );
  });

  it('reports a suite-wide comparison with nothing stale in it', () => {
    const report = compareCalibrationSuite();
    expect(report.fixtures).toBe(CALIBRATION_FIXTURES.length);
    expect(report.pilots).toEqual(CALIBRATED_PILOT_IDS);
    expect(report.stale).toEqual([]);

    for (const facet of CALIBRATION_FACETS) {
      expect(report.byFacet[facet].total).toBeGreaterThan(0);
      expect(report.byFacet[facet].unanimousYes).toBeLessThanOrEqual(report.byFacet[facet].total);
    }
    for (const pilot of report.byPilot) {
      expect(pilot.fixtures).toBe(CALIBRATION_FIXTURES.length);
      expect(pilot.rate).toBeGreaterThan(0);
      // Nothing here is a ranking: a rate of 1 would mean the suite had stopped
      // asking anything hard, not that the pilot had become a good player.
      expect(pilot.rate).toBeLessThan(1);
    }
  });

  it('records where the three weight vectors genuinely disagree', () => {
    const report = compareCalibrationSuite();
    // Not an incidental property: `aggressive` and `defensive` are one agent
    // class with two weight vectors (M05.4), and a fixture they answer
    // differently is where that difference becomes observable.
    expect(report.disputed.length).toBeGreaterThan(0);
    for (const fixtureId of report.disputed) {
      const row = report.comparisons.find((entry) => entry.fixtureId === fixtureId);
      expect(row?.unanimous).toBe(false);
    }
  });
});

describe('the calibration table', () => {
  it('hands the pilot nothing but its own redacted view', () => {
    const table = CalibrationTable.open({ preconId: 'precon_containment_control' });
    table.give('quick_study', table.foe);
    const observation = table.observationFor(table.self);

    expect(observation.view.viewerId).toBe(table.self);
    expect(observation).not.toHaveProperty('state');
    // The opponent's hand is a count and nothing else: no instance of the card
    // the fixture put there is reachable from the view.
    const opponent = observation.view.players.find((summary) => summary.playerId === table.foe);
    expect(opponent?.handCount).toBe(1);
    const visible = Object.values(observation.view.instances);
    expect(visible.some((card) => card.definitionId === 'quick_study')).toBe(false);
    expect(visible.every((card) => card.zone !== 'deck')).toBe(true);
  });

  it('starts the pilot with a hand containing only what the fixture put there', () => {
    const table = CalibrationTable.open({ preconId: 'precon_goblin_swarm' });
    expect(table.handSize(table.self)).toBe(0);
    table.give('call_a_goblin');
    expect(table.handSize(table.self)).toBe(1);
  });

  it('refuses a pilot that decides asynchronously', () => {
    const table = CalibrationTable.open({ preconId: 'precon_goblin_swarm' });
    const inner = createPilot({ id: 'value' });
    const asyncPilot = {
      ...inner,
      decide: async (
        observation: Parameters<typeof inner.decide>[0],
        rng: Parameters<typeof inner.decide>[1],
      ) => inner.decide(observation, rng),
    };
    expect(() => table.ask(asyncPilot, { state: createRngState('async') })).toThrow(
      /decides asynchronously/,
    );
  });
});
