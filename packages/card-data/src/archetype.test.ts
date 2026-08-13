import { describe, expect, it } from 'vitest';
import {
  ARCHETYPE_IDS,
  ARCHETYPE_REGISTRY,
  ARCHETYPE_REGISTRY_VERSION,
  BUNDLED_DECK_PLANS,
  DECK_PLAN_SCHEMA_VERSION,
  MAX_PLAN_SHARE,
  PACKAGE_ROLES,
  archetypeGaps,
  assertArchetypeRegistryComplete,
  bundledDeckPlan,
  bundledFormat,
  bundledPrecon,
  deckPlanForPrecon,
  deckPlanSchema,
  deckPlansForFormat,
  missingRolesOf,
  planCardIds,
  planSlotCount,
  preconsForFormat,
  requiredRolesOf,
  type ArchetypeId,
  type PackageRole,
} from './index.js';

/**
 * The archetype registry and the shipped deck plans (M05.5).
 *
 * The `Record` type already fails a build that adds an archetype without
 * defining it. What is asserted here is the half a type cannot check: that the
 * registry is restated independently as a mapped type, that the four authored
 * plans really do describe the four shipped precons, and that a plan can never
 * fill a deck — the property the search relies on to stay able to explore
 * outside a plan.
 */

describe('the archetype registry', () => {
  it('is complete in both directions', () => {
    expect(archetypeGaps()).toEqual([]);
    expect(() => assertArchetypeRegistryComplete()).not.toThrow();
  });

  it('pins the taxonomy a citation was made against', () => {
    expect(ARCHETYPE_REGISTRY_VERSION).toBe(1);
  });

  /**
   * Restated as a mapped type rather than read off the registry, so adding an
   * archetype fails to compile here until somebody decides what a plan for it
   * must supply. Same acceptance criterion as `agent-class.test.ts`.
   */
  const EXPECTED_REQUIRED_ROLES: Readonly<Record<ArchetypeId, readonly PackageRole[]>> = {
    token_swarm: ['engine', 'payoff', 'curve'],
    defensive_attrition: ['defense', 'payoff', 'consistency'],
    sacrifice_value: ['engine', 'payoff', 'interaction'],
    reactive_control: ['interaction', 'defense', 'consistency'],
  };

  it.each(ARCHETYPE_IDS)('%s requires exactly the roles the table says', (archetypeId) => {
    expect([...requiredRolesOf(archetypeId)].sort()).toEqual(
      [...EXPECTED_REQUIRED_ROLES[archetypeId]].sort(),
    );
  });

  it('names no card, so the vocabulary survives the card pool moving', () => {
    const serialized = JSON.stringify(ARCHETYPE_REGISTRY);
    for (const plan of BUNDLED_DECK_PLANS) {
      for (const cardId of planCardIds(plan)) {
        expect(serialized).not.toContain(cardId);
      }
    }
  });

  it('gives every archetype a label, a summary and a pilot note', () => {
    for (const archetypeId of ARCHETYPE_IDS) {
      const definition = ARCHETYPE_REGISTRY[archetypeId];
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.summary.length).toBeGreaterThan(0);
      expect(definition.pilotNote.length).toBeGreaterThan(0);
    }
  });
});

describe('the shipped deck plans', () => {
  it('publishes one plan per Wave 1 precon', () => {
    const precons = preconsForFormat('precon_wave_1');
    const plans = deckPlansForFormat('precon_wave_1');
    expect(plans).toHaveLength(precons.length);
    for (const precon of precons) {
      const plan = deckPlanForPrecon(precon.id);
      expect(plan, `no deck plan describes ${precon.id}`).toBeDefined();
      expect(plan?.commanderId).toBe(precon.commanderId);
    }
  });

  it('covers all four archetypes exactly once', () => {
    const claimed = deckPlansForFormat('precon_wave_1').map((plan) => plan.archetypeId);
    expect([...claimed].sort()).toEqual([...ARCHETYPE_IDS].sort());
  });

  it.each(BUNDLED_DECK_PLANS.map((plan) => [plan.id, plan] as const))(
    '%s packages only cards its precon runs',
    (_id, plan) => {
      const precon = plan.preconId ? bundledPrecon(plan.preconId) : undefined;
      expect(precon).toBeDefined();
      const inPrecon = new Set(precon?.cardIds ?? []);
      for (const cardId of planCardIds(plan)) expect(inPrecon.has(cardId)).toBe(true);
    },
  );

  it.each(BUNDLED_DECK_PLANS.map((plan) => [plan.id, plan] as const))(
    '%s supplies every role its archetype requires',
    (_id, plan) => {
      expect(missingRolesOf(plan)).toEqual([]);
    },
  );

  it.each(BUNDLED_DECK_PLANS.map((plan) => [plan.id, plan] as const))(
    '%s leaves the search room to explore outside it',
    (_id, plan) => {
      const format = bundledFormat(plan.formatId);
      expect(format).toBeDefined();
      const size = format?.deck.size ?? 0;
      expect(planSlotCount(plan)).toBeLessThanOrEqual(Math.floor(size * MAX_PLAN_SHARE));
      expect(planSlotCount(plan)).toBeLessThan(size);
    },
  );

  it.each(BUNDLED_DECK_PLANS.map((plan) => [plan.id, plan] as const))(
    '%s never lists a card in two packages',
    (_id, plan) => {
      const listed = plan.packages.flatMap((entry) => entry.cardIds);
      expect(listed).toHaveLength(new Set(listed).size);
    },
  );

  it.each(BUNDLED_DECK_PLANS.map((plan) => [plan.id, plan] as const))(
    '%s marks at least one package core, so there is something to protect',
    (_id, plan) => {
      expect(plan.packages.some((entry) => entry.core)).toBe(true);
    },
  );

  it('uses only the published package-role vocabulary', () => {
    const roles = new Set<string>(PACKAGE_ROLES);
    for (const plan of BUNDLED_DECK_PLANS) {
      for (const entry of plan.packages) expect(roles.has(entry.role)).toBe(true);
    }
  });

  it('is addressable by permanent ID', () => {
    expect(bundledDeckPlan('plan_goblin_swarm')?.archetypeId).toBe('token_swarm');
    expect(bundledDeckPlan('no_such_plan')).toBeUndefined();
    expect(deckPlansForFormat('development')).toEqual([]);
  });

  it('round-trips through its own schema at the current version', () => {
    for (const plan of BUNDLED_DECK_PLANS) {
      expect(plan.schemaVersion).toBeLessThanOrEqual(DECK_PLAN_SCHEMA_VERSION);
      expect(deckPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    }
  });
});
