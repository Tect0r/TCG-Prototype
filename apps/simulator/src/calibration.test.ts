import { describe, expect, it } from 'vitest';
import { AGENT_CLASSES, agentClassSupports } from '@tcg/bot-interface';
import {
  analyzeCalibration,
  BALANCE_CLAIM,
  CALIBRATION_ANALYSIS_VERSION,
  classesCarryingBalance,
  EVIDENCE_STANDINGS,
} from './analysis/calibration.js';
import { analyzeAgentClasses, type AgentClassAnalysis } from './analysis/agent-classes.js';

/**
 * The calibration standing (M05.6).
 *
 * The one label on the whole document, and the tests that matter are the ones
 * about where it comes from: it must be derived from the agent classes, it must
 * be unreachable by configuration, and it must say what would have to change.
 */

function standingFor(pilotIds: readonly string[]) {
  return analyzeCalibration({ agentClasses: analyzeAgentClasses({ pilotIds }) });
}

describe('the calibration standing', () => {
  it('labels every run this build can produce as calibration', () => {
    for (const pilotIds of [
      ['value'],
      ['aggressive', 'defensive'],
      ['random_legal'],
      ['value', 'random_legal'],
    ]) {
      expect(standingFor(pilotIds).standing).toBe('calibration');
    }
  });

  it('names the classes that would carry a balance conclusion, and the gap', () => {
    const standing = standingFor(['value']);
    expect(standing.claim).toBe(BALANCE_CLAIM);
    expect(standing.claimCarriedBy).toEqual(['human_playtest']);
    expect(standing.classesFlown).toEqual(['generic_heuristic']);
    expect(standing.classesMissing).toEqual(['human_playtest']);
    expect(standing.reasons.some((reason) => reason.includes('generic_heuristic'))).toBe(true);
  });

  it('is derived from the agent class registry, not restated beside it', () => {
    expect(classesCarryingBalance()).toEqual(
      AGENT_CLASSES.filter((agentClass) => agentClassSupports(agentClass, BALANCE_CLAIM)),
    );
  });

  it('withdraws the standing entirely for a pilot it cannot classify', () => {
    const standing = standingFor(['value', 'mystery_pilot']);
    expect(standing.standing).toBe('calibration');
    expect(standing.reasons.some((reason) => reason.includes('mystery_pilot'))).toBe(true);
  });

  it('says calibration when no pilot flew at all', () => {
    const standing = standingFor([]);
    expect(standing.standing).toBe('calibration');
    expect(standing.reasons.some((reason) => reason.includes('no recognised agent class'))).toBe(
      true,
    );
  });

  it('promotes only when every flying class carries the claim', () => {
    // No pilot in this build is a human, so the promoted case is reachable only
    // by handing the analysis a class set directly. Asserting it here is what
    // stops the standing from being a constant dressed up as a derivation.
    const human: AgentClassAnalysis = {
      ...analyzeAgentClasses({ pilotIds: ['value'] }),
      classes: ['human_playtest'],
      unclassifiedPilotIds: [],
    };
    const standing = analyzeCalibration({ agentClasses: human });
    expect(standing.standing).toBe('balance');
    expect(standing.reasons).toEqual([]);
    expect(standing.classesMissing).toEqual([]);

    // And a mixed run is not promoted by its strongest arm.
    const mixed: AgentClassAnalysis = {
      ...human,
      classes: ['generic_heuristic', 'human_playtest'],
    };
    expect(analyzeCalibration({ agentClasses: mixed }).standing).toBe('calibration');
  });

  it('always states what would have to change, whatever the standing', () => {
    for (const pilotIds of [['value'], ['random_legal']]) {
      const standing = standingFor(pilotIds);
      expect(standing.promotionRequires).toContain(BALANCE_CLAIM);
      expect(standing.promotionRequires).toMatch(/no configuration setting/i);
      expect(standing.schemaVersion).toBe(CALIBRATION_ANALYSIS_VERSION);
      expect(standing.registryVersion).toBeGreaterThan(0);
    }
  });

  it('offers exactly two standings and no scale between them', () => {
    expect([...EVIDENCE_STANDINGS]).toEqual(['calibration', 'balance']);
  });
});
