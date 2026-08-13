import { describe, expect, it } from 'vitest';
import { bundledDeckPlan, MAX_PLAN_SHARE, planCardIds } from '@tcg/card-data';
import { resolveEnvironment, type EnvironmentConfigInput } from './environment.js';
import { resolveDeckSource } from './deck-source.js';
import { checkDeck, deckSize, type SimDeck } from './deck-search/deck.js';
import { generateDeck, generatePopulation } from './deck-search/generate.js';
import { crossoverDecks, mutateDeck } from './deck-search/mutate.js';
import {
  conformanceOf,
  corePackages,
  isPackageIntact,
  PlanResolutionError,
  resolvePlan,
  resolvePlanForPrecon,
} from './deck-search/plan.js';
import { analyzeDeckConstruction } from './analysis/construction.js';

/**
 * M05.5 — archetype registry and deck plans, from the search's side.
 *
 * `@tcg/card-data`'s own tests hold down the registry and the four authored
 * plans. What is asserted here is the three behaviours the milestone actually
 * asks for, plus the property that keeps them honest:
 *
 * - generation **seeds coherent packages** — whole, never partial;
 * - mutation may **protect** a package or **replace** one;
 * - the search **remains able to explore outside plans**, which is checked
 *   structurally rather than trusted: the default policy is unconstrained, and
 *   even under `protect` every plan-generated deck has free slots by
 *   construction.
 *
 * Plus the fourth: a report can tell hand-authored, plan-generated and
 * unconstrained decks apart, and never by inspecting a decklist.
 */

const WAVE_1 = 'precon_wave_1';
const PLAN_ID = 'plan_goblin_swarm';

function wave1(overrides: Partial<EnvironmentConfigInput> = {}): EnvironmentConfigInput {
  return {
    id: 'wave_1',
    format: WAVE_1,
    deckFormat: { formatId: WAVE_1, deckSize: 40, singleton: true },
    ...overrides,
  };
}

const env = resolveEnvironment(wave1());
const plan = resolvePlan(PLAN_ID, env);

/**
 * The same pool with room to move in.
 *
 * `goblin_warboss` is mono-red, so its colour-legal Wave 1 pool is **41 cards
 * against a 40-card singleton deck**: one spare. That is a property of the
 * shipped content, not of any operator here, and it means every package-scale
 * move — replacing a package, crossing two decks over — has nowhere to put the
 * cards it frees. Those behaviours are therefore exercised at a smaller deck
 * size, where the same pool leaves eleven spare slots. Nothing else changes:
 * same format, same cards, same plan.
 */
const roomy = resolveEnvironment(
  wave1({ id: 'wave_1_roomy', deckFormat: { formatId: WAVE_1, deckSize: 30, singleton: true } }),
);
const roomyPlan = resolvePlan(PLAN_ID, roomy);

describe('resolving a plan against an environment', () => {
  it('resolves the shipped plan whole', () => {
    expect(plan.plan.id).toBe(PLAN_ID);
    expect(plan.archetypeId).toBe('token_swarm');
    expect(plan.commanderId).toBe('goblin_warboss');
    expect(plan.cardIds).toEqual(planCardIds(bundledDeckPlan(PLAN_ID)!));
    expect(corePackages(plan).length).toBeGreaterThan(0);
  });

  it('refuses rather than trims when the environment bans a packaged card', () => {
    const banned = resolveEnvironment(
      wave1({ id: 'banned', banCardIds: [plan.cardIds[0] as string] }),
    );
    expect(() => resolvePlan(PLAN_ID, banned)).toThrow(PlanResolutionError);
    // A partial plan would seed decks labelled with an archetype they cannot
    // express, which is worse than not running.
    expect(() => resolvePlan(PLAN_ID, banned)).toThrow(/resolved whole or not at all/);
  });

  it('refuses a plan built to another format', () => {
    const other = resolveEnvironment({
      id: 'fixtures',
      format: 'development',
      deckFormat: { formatId: 'development', deckSize: 30, copyLimit: 2 },
    });
    expect(() => resolvePlan(PLAN_ID, other)).toThrow(/built to format/);
  });

  it('names the plans it does publish when an ID matches nothing', () => {
    expect(() => resolvePlan('plan_nonsense', env)).toThrow(/plan_goblin_swarm/);
  });
});

describe('plan-seeded generation', () => {
  const { deck, diagnostics } = generateDeck(env, 'plan-seed', { planId: PLAN_ID });

  it('produces a legal, full-size deck on the plan’s Commander', () => {
    expect(diagnostics).toEqual([]);
    expect(deck).not.toBeNull();
    expect(deck?.commanderId).toBe('goblin_warboss');
    expect(deckSize(deck as SimDeck)).toBe(env.deckFormat.deckSize);
    expect(checkDeck(deck as SimDeck, env).legal).toBe(true);
  });

  it('seeds every package whole', () => {
    for (const group of plan.packages) {
      expect(
        isPackageIntact(deck as SimDeck, group),
        `package ${group.definition.id} was seeded partially`,
      ).toBe(true);
    }
    expect(deck?.construction.packagesBroken).toEqual([]);
  });

  it('records where the deck came from rather than leaving it to be guessed', () => {
    expect(deck?.construction.kind).toBe('plan_generated');
    expect(deck?.construction.planId).toBe(PLAN_ID);
    expect(deck?.construction.archetypeId).toBe('token_swarm');
  });

  it('leaves the search slots of its own, structurally', () => {
    // Not a configuration choice: the plan schema caps a plan below the deck
    // size, so free slots exist however the generator is set up.
    expect(deck?.construction.offPlanCards).toBeGreaterThan(0);
    expect(plan.cardIds.length).toBeLessThanOrEqual(
      Math.floor(env.deckFormat.deckSize * MAX_PLAN_SHARE),
    );
  });

  it('seeds only the core packages when asked to', () => {
    const core = generateDeck(env, 'plan-core', {
      planId: PLAN_ID,
      planPackages: 'core',
    }).deck as SimDeck;
    const coreIds = corePackages(plan).map((group) => group.definition.id);
    expect(core.construction.packagesIntact).toEqual(expect.arrayContaining(coreIds));
    // The non-core packages are left to the weighted draw, so more of the deck
    // is the search's own than under `all`.
    expect(core.construction.offPlanCards).toBeGreaterThanOrEqual(
      (deck as SimDeck).construction.offPlanCards,
    );
  });

  it('is deterministic and still varies the slots it owns', () => {
    expect(generateDeck(env, 'x', { planId: PLAN_ID }).deck?.hash).toBe(
      generateDeck(env, 'x', { planId: PLAN_ID }).deck?.hash,
    );
    const hashes = new Set(
      Array.from(
        { length: 8 },
        (_, index) => generateDeck(env, `vary-${index}`, { planId: PLAN_ID }).deck?.hash,
      ),
    );
    expect(hashes.size).toBeGreaterThan(1);
  });

  it('stops the generation when the plan cannot be resolved', () => {
    const result = generateDeck(env, 'missing', { planId: 'plan_nonsense' });
    expect(result.deck).toBeNull();
    expect(result.diagnostics.map((entry) => entry.code)).toContain('sim/unknown_deck_plan');
  });

  it('produces a plan-seeded population on one Commander without complaining', () => {
    const population = generatePopulation(env, 'pop', 4, { planId: PLAN_ID });
    expect(population.decks).toHaveLength(4);
    expect(population.diagnostics).toEqual([]);
    for (const entry of population.decks) {
      expect(entry.commanderId).toBe('goblin_warboss');
      expect(entry.construction.kind).toBe('plan_generated');
    }
    // Distinct decks, because only the free slots were drawn.
    expect(new Set(population.decks.map((entry) => entry.hash)).size).toBe(4);
  });
});

describe('unplanned generation', () => {
  it('is labelled unconstrained and is not credited with a strategy', () => {
    const { deck } = generateDeck(env, 'plain');
    expect(deck?.construction.kind).toBe('unconstrained');
    expect(deck?.construction.planId).toBeNull();
    expect(deck?.construction.archetypeId).toBeNull();
  });
});

describe('package-aware mutation', () => {
  const base = generateDeck(env, 'mutation-base', { planId: PLAN_ID }).deck as SimDeck;
  const coreCards = new Set(corePackages(plan).flatMap((group) => group.cardIds));

  it('defaults to exploring freely, which is what keeps a search a search', () => {
    // Twenty mutations at the default policy: at least one has to have touched
    // a card the plan names, or "explore outside the plan" would be a slogan.
    let touchedPlanCard = false;
    for (let index = 0; index < 20 && !touchedPlanCard; index += 1) {
      const result = mutateDeck(base, env, `free-${index}`, { strength: 4, generation: 1, plan });
      const cards = new Set((result.deck?.cards ?? []).map((entry) => entry.cardId));
      touchedPlanCard = plan.cardIds.some((cardId) => !cards.has(cardId));
    }
    expect(touchedPlanCard).toBe(true);
  });

  it('protects every card of an intact core package', () => {
    for (let index = 0; index < 20; index += 1) {
      const result = mutateDeck(base, env, `protect-${index}`, {
        strength: 6,
        generation: 1,
        plan,
        packagePolicy: 'protect',
      });
      if (!result.deck) continue;
      const cards = new Set(result.deck.cards.map((entry) => entry.cardId));
      for (const cardId of coreCards) expect(cards.has(cardId)).toBe(true);
      expect(deckSize(result.deck)).toBe(env.deckFormat.deckSize);
      expect(checkDeck(result.deck, env).legal).toBe(true);
    }
  });

  it('still changes the deck while protecting, so the search is constrained not frozen', () => {
    const result = mutateDeck(base, env, 'protect-changes', {
      strength: 3,
      generation: 1,
      plan,
      packagePolicy: 'protect',
    });
    expect(result.deck).not.toBeNull();
    expect(result.deck?.hash).not.toBe(base.hash);
  });

  it('leaves the pre-plan operator byte-identical when no plan is supplied', () => {
    const withPlan = mutateDeck(base, env, 'same', { strength: 3, generation: 1 });
    const without = mutateDeck(base, env, 'same', {
      strength: 3,
      generation: 1,
      plan: null,
      packagePolicy: 'none',
    });
    expect(withPlan.deck?.hash).toBe(without.deck?.hash);
  });
});

describe('whole-package replacement', () => {
  // See `roomy` above: a 40-card singleton deck out of a 41-card colour-legal
  // pool has nowhere to put the cards a package replacement frees.
  const base = generateDeck(roomy, 'replace-base', { planId: PLAN_ID }).deck as SimDeck;

  it('removes a whole core package and refills the slots from the pool', () => {
    const result = mutateDeck(base, roomy, 'replace-1', {
      strength: 1,
      generation: 2,
      plan: roomyPlan,
      packagePolicy: 'replace',
    });
    const deck = result.deck as SimDeck;
    expect(result.reasons).toEqual([]);
    expect(deck).not.toBeNull();
    expect(deckSize(deck)).toBe(roomy.deckFormat.deckSize);
    expect(checkDeck(deck, roomy).legal).toBe(true);

    const removed = deck.origin.changes.find((entry) => entry.startsWith('-package '));
    expect(removed, 'a replacement must name the package it removed').toBeDefined();
    const removedId = removed?.split(' ')[1];
    // The package is gone entirely — not thinned, which is the whole difference
    // between replacing a package and mutating cards that happen to be in one.
    const group = roomyPlan.packages.find((entry) => entry.definition.id === removedId);
    expect(group?.definition.core, 'only a core package may be replaced').toBe(true);
    const cards = new Set(deck.cards.map((entry) => entry.cardId));
    for (const cardId of group?.cardIds ?? []) expect(cards.has(cardId)).toBe(false);
    expect(deck.construction.packagesBroken).toContain(removedId);
  });

  it('re-measures conformance instead of carrying the parent’s forward', () => {
    const deck = mutateDeck(base, roomy, 'replace-2', {
      strength: 1,
      generation: 2,
      plan: roomyPlan,
      packagePolicy: 'replace',
    }).deck as SimDeck;
    expect(deck.construction.packagesIntact.length).toBeLessThan(
      base.construction.packagesIntact.length,
    );
    // Where the deck came from is unchanged: losing a package is a finding, not
    // a reason to relabel a plan-generated deck as something else.
    expect(deck.construction.kind).toBe('plan_generated');
    expect(deck.construction.planId).toBe(PLAN_ID);
  });

  it('declines, with a reason, once no intact core package is left', () => {
    let current = base;
    let declined: readonly string[] | null = null;
    for (let index = 0; index < 12; index += 1) {
      const result = mutateDeck(current, roomy, `strip-${index}`, {
        strength: 1,
        generation: index,
        plan: roomyPlan,
        packagePolicy: 'replace',
      });
      if (!result.deck) {
        declined = result.reasons;
        break;
      }
      current = result.deck;
    }
    expect(declined, 'stripping every core package should eventually decline').not.toBeNull();
    expect(declined?.join(' ')).toMatch(/no intact core package|short of legal size/);
  });

  it('carries construction through a crossover from the left parent', () => {
    const other = generateDeck(roomy, 'cross-other', { planId: PLAN_ID }).deck as SimDeck;
    const child = crossoverDecks(base, other, roomy, 'cross', 1, roomyPlan).deck;
    expect(child).not.toBeNull();
    expect(child?.construction.kind).toBe('plan_generated');
    expect(child?.construction.planId).toBe(PLAN_ID);
  });
});

describe('deck construction in a report', () => {
  it('records a precon as hand-authored and measures it against its plan', () => {
    const resolved = resolveDeckSource(
      { kind: 'precon', preconIds: ['precon_goblin_swarm'] },
      env,
      'seed',
    );
    const deck = resolved.decks[0] as SimDeck;
    expect(deck.construction.kind).toBe('hand_authored');
    expect(deck.construction.planId).toBe(PLAN_ID);
    // The shipped list contains its own plan whole. That is a fact about the
    // deck, and it does *not* make the deck plan-generated.
    expect(deck.construction.packagesBroken).toEqual([]);
    expect(deck.construction.offPlanCards).toBeGreaterThan(0);
  });

  it('records an inline deck as hand-authored with no plan', () => {
    const precon = resolveDeckSource(
      { kind: 'precon', preconIds: ['precon_goblin_swarm'] },
      env,
      'seed',
    ).decks[0] as SimDeck;
    const resolved = resolveDeckSource(
      {
        kind: 'inline',
        decks: [{ commanderId: precon.commanderId, cards: precon.cards, id: 'typed_by_hand' }],
      },
      env,
      'seed',
    );
    const deck = resolved.decks[0] as SimDeck;
    expect(deck.construction.kind).toBe('hand_authored');
    // Identical cards to the precon above, and deliberately *not* measured
    // against a plan: nothing here claimed one, and inferring it from the cards
    // is exactly the inference this design refuses.
    expect(deck.construction.planId).toBeNull();
  });

  it('counts the three kinds apart and never pools them', () => {
    const precon = resolveDeckSource(
      { kind: 'precon', preconIds: ['precon_goblin_swarm'] },
      env,
      'seed',
    ).decks[0] as SimDeck;
    const planned = generateDeck(env, 'a', { planId: PLAN_ID }).deck as SimDeck;
    const random = generateDeck(env, 'b').deck as SimDeck;

    const analysis = analyzeDeckConstruction([precon, planned, random]);
    expect(analysis.deckCount).toBe(3);
    expect(analysis.mixed).toBe(true);
    expect(analysis.counts).toEqual([
      { kind: 'hand_authored', decks: 1 },
      { kind: 'plan_generated', decks: 1 },
      { kind: 'unconstrained', decks: 1 },
    ]);
    expect(analysis.plans.map((entry) => entry.planId)).toEqual([PLAN_ID]);
    expect(analysis.plans[0]?.decks).toBe(2);
    expect(analysis.archetypes).toEqual(['token_swarm']);
    expect(analysis.decksOffPlan).toBe(0);
  });

  it('names a deck that has lost every package of the plan it was seeded from', () => {
    const planned = generateDeck(env, 'c', { planId: PLAN_ID }).deck as SimDeck;
    const gutted = {
      ...planned,
      construction: { ...planned.construction, packagesIntact: [], packagesBroken: ['x'] },
    };
    expect(analyzeDeckConstruction([gutted]).decksOffPlan).toBe(1);
  });

  it('treats an archetype this build no longer publishes as unvouched-for', () => {
    const planned = generateDeck(env, 'd', { planId: PLAN_ID }).deck as SimDeck;
    const stale = {
      ...planned,
      construction: { ...planned.construction, archetypeId: 'ramp' },
    };
    const analysis = analyzeDeckConstruction([stale]);
    expect(analysis.plans[0]?.archetypeId).toBeNull();
    expect(analysis.archetypes).toEqual([]);
  });
});

describe('conformance', () => {
  it('needs every card of a package, not most of them', () => {
    const deck = generateDeck(env, 'conformance', { planId: PLAN_ID }).deck as SimDeck;
    const group = corePackages(plan)[0]!;
    const thinned: SimDeck = {
      ...deck,
      cards: deck.cards.filter((entry) => entry.cardId !== group.cardIds[0]),
    };
    expect(isPackageIntact(thinned, group)).toBe(false);
    expect(conformanceOf(thinned, plan, 'plan_generated').packagesBroken).toContain(
      group.definition.id,
    );
  });

  it('says nothing about packages when there is no plan to say it against', () => {
    const deck = generateDeck(env, 'no-plan', {}).deck as SimDeck;
    const reading = conformanceOf(deck, null, 'unconstrained');
    expect(reading.planId).toBeNull();
    expect(reading.packagesIntact).toEqual([]);
    expect(reading.offPlanCards).toBe(env.deckFormat.deckSize);
  });

  it('finds the plan describing a precon, and nothing for a precon without one', () => {
    expect(resolvePlanForPrecon('precon_goblin_swarm', env)?.plan.id).toBe(PLAN_ID);
    expect(resolvePlanForPrecon('no_such_precon', env)).toBeNull();
  });
});
