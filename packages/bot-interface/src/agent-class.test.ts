import { describe, expect, it } from 'vitest';
import {
  AGENT_CLASSES,
  AGENT_CLASS_REGISTRY,
  AGENT_CLASS_REGISTRY_VERSION,
  EVIDENCE_CLAIMS,
  EVIDENCE_CLAIM_QUESTIONS,
  agentClassGaps,
  agentClassSupports,
  assertAgentClassRegistryComplete,
  claimCarriedBy,
  claimsCarriedBy,
  classesBlocking,
  type AgentClass,
  type EvidenceClaim,
} from './agent-class.js';
import {
  AGENT_CLASSES_WITHOUT_PILOTS,
  LEGAL_ONLY_PILOT_IDS,
  PILOT_AGENT_CLASSES,
  PILOT_IDS,
  agentClassOf,
  pilotsInAgentClass,
} from './registry.js';

/**
 * The honest agent classes (M05.4).
 *
 * The acceptance criterion checked from the test side is the same one M05.2
 * used: the tables below are **mapped types over the registry's own
 * vocabularies**, so adding a class or a claim without deciding what it may be
 * cited for does not compile.
 */

/** Every claim each class must carry, restated independently of the registry. */
const EXPECTED_CLAIMS: Record<AgentClass, readonly EvidenceClaim[]> = {
  random_legal: [
    'run_integrity',
    'legality',
    'termination',
    'loop_freedom',
    'crash_freedom',
    'structural_asymmetry',
  ],
  generic_heuristic: [
    'run_integrity',
    'legality',
    'termination',
    'loop_freedom',
    'crash_freedom',
    'structural_asymmetry',
    'play_quality',
  ],
  archetype_aware: [
    'run_integrity',
    'legality',
    'termination',
    'loop_freedom',
    'crash_freedom',
    'structural_asymmetry',
    'play_quality',
    'synergy',
    'sacrifice',
    'control',
    'combo',
  ],
  human_playtest: [...EVIDENCE_CLAIMS],
};

/** One sentence per claim, so a new claim cannot arrive undescribed. */
const CLAIM_IS_DESCRIBED: Record<EvidenceClaim, true> = {
  run_integrity: true,
  legality: true,
  termination: true,
  loop_freedom: true,
  crash_freedom: true,
  structural_asymmetry: true,
  play_quality: true,
  synergy: true,
  sacrifice: true,
  control: true,
  combo: true,
  final_balance: true,
};

describe('the agent class registry', () => {
  it('decides every class/claim pair, in both directions', () => {
    expect(agentClassGaps()).toEqual([]);
    expect(() => assertAgentClassRegistryComplete()).not.toThrow();
    expect(AGENT_CLASS_REGISTRY_VERSION).toBeGreaterThan(0);
  });

  it('carries the claims the milestone assigned each class', () => {
    for (const agentClass of AGENT_CLASSES) {
      const expected = new Set(EXPECTED_CLAIMS[agentClass]);
      for (const claim of EVIDENCE_CLAIMS) {
        expect([agentClass, claim, agentClassSupports(agentClass, claim)]).toEqual([
          agentClass,
          claim,
          expected.has(claim),
        ]);
      }
    }
  });

  it('describes every claim it names', () => {
    for (const claim of EVIDENCE_CLAIMS) {
      expect(CLAIM_IS_DESCRIBED[claim]).toBe(true);
      expect(EVIDENCE_CLAIM_QUESTIONS[claim].endsWith('?')).toBe(true);
    }
    for (const agentClass of AGENT_CLASSES) {
      expect(AGENT_CLASS_REGISTRY[agentClass].summary.length).toBeGreaterThan(40);
    }
  });

  /**
   * `AGENT_CLASSES` is ordered weakest first and every claim is monotone along
   * it. Asserted rather than assumed: nothing in the code folds a set of classes
   * down to a rank, so a future class that is genuinely incomparable — one that
   * buys `combo` but loses `structural_asymmetry`, say — fails here instead of
   * being quietly averaged into a skill axis.
   */
  it('is monotone along the published order', () => {
    for (const claim of EVIDENCE_CLAIMS) {
      const supported = AGENT_CLASSES.map((agentClass) => agentClassSupports(agentClass, claim));
      const firstTrue = supported.indexOf(true);
      if (firstTrue === -1) continue;
      expect(supported.slice(firstTrue).every(Boolean)).toBe(true);
    }
  });

  it('makes random-legal a legality instrument and not a weak player', () => {
    expect(agentClassSupports('random_legal', 'termination')).toBe(true);
    expect(agentClassSupports('random_legal', 'crash_freedom')).toBe(true);
    // The one outcome claim uniform random play does carry: mirrored seats make
    // it an unbiased probe of a turn-order advantage.
    expect(agentClassSupports('random_legal', 'structural_asymmetry')).toBe(true);
    expect(agentClassSupports('random_legal', 'play_quality')).toBe(false);
  });

  it('reserves the four plan-shaped claims for an archetype-aware pilot', () => {
    for (const claim of ['synergy', 'sacrifice', 'control', 'combo'] as const) {
      expect(agentClassSupports('generic_heuristic', claim)).toBe(false);
      expect(agentClassSupports('archetype_aware', claim)).toBe(true);
    }
  });

  it('reserves a final balance conclusion for human play', () => {
    for (const agentClass of AGENT_CLASSES) {
      expect([agentClass, agentClassSupports(agentClass, 'final_balance')]).toEqual([
        agentClass,
        agentClass === 'human_playtest',
      ]);
    }
  });
});

describe('a set of classes', () => {
  it('carries a claim only when every class in it does', () => {
    expect(claimCarriedBy(['generic_heuristic'], 'play_quality')).toBe(true);
    // The pooled column of a mixed run is only as good as its weakest seat.
    expect(claimCarriedBy(['generic_heuristic', 'random_legal'], 'play_quality')).toBe(false);
    expect(claimCarriedBy(['generic_heuristic', 'random_legal'], 'termination')).toBe(true);
    expect(classesBlocking(['generic_heuristic', 'random_legal'], 'play_quality')).toEqual([
      'random_legal',
    ]);
  });

  it('carries nothing at all when no class flew', () => {
    expect(claimsCarriedBy([])).toEqual([]);
    expect(claimCarriedBy([], 'legality')).toBe(false);
  });

  it('lists carried claims in vocabulary order', () => {
    const carried = claimsCarriedBy(['archetype_aware']);
    expect(carried).toEqual(EVIDENCE_CLAIMS.filter((claim) => claim !== 'final_balance'));
  });
});

describe('the pilots this build ships', () => {
  it('classifies every one of them', () => {
    for (const id of PILOT_IDS) {
      expect(AGENT_CLASSES).toContain(PILOT_AGENT_CLASSES[id]);
      expect(agentClassOf(id)).toBe(PILOT_AGENT_CLASSES[id]);
    }
  });

  it('returns null for a pilot ID this build does not know', () => {
    expect(agentClassOf('some_future_pilot')).toBeNull();
    // Not a prototype lookup: `constructor` is not a pilot.
    expect(agentClassOf('constructor')).toBeNull();
  });

  it('derives the legality-only list from the classification', () => {
    expect(LEGAL_ONLY_PILOT_IDS).toEqual(['random_legal']);
    for (const id of PILOT_IDS) {
      expect([id, LEGAL_ONLY_PILOT_IDS.includes(id)]).toEqual([
        id,
        !agentClassSupports(PILOT_AGENT_CLASSES[id], 'play_quality'),
      ]);
    }
  });

  it('says out loud which classes have no pilot yet', () => {
    // M05.5 adds the first archetype-aware pilot; a human is not a pilot at all.
    // Until then no run this build produces is synergy, sacrifice, control,
    // combo or final-balance evidence, and the report states that as a fact
    // about the software rather than leaving it to be inferred.
    expect(AGENT_CLASSES_WITHOUT_PILOTS).toEqual(['archetype_aware', 'human_playtest']);
    expect(pilotsInAgentClass('generic_heuristic')).toEqual(['aggressive', 'defensive', 'value']);
    expect(pilotsInAgentClass('random_legal')).toEqual(['random_legal']);
  });
});
