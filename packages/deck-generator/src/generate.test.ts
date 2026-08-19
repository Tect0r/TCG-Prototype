import { describe, expect, it } from 'vitest';
import { checkDeck, deckSize, toSavedDeck } from './deck.js';
import { generationEnvironmentForFormat, type GenerationEnvironment } from './environment.js';
import {
  generateDeck,
  generatePopulation,
  isFullSize,
  poolFor,
  poolReportFor,
} from './generate.js';

/**
 * What the extracted generator promises on its own, against the real Wave 1
 * pool rather than a fixture: a legal deck with provenance, or named problems.
 *
 * The equivalence suite proves the procedure did not change. This one proves the
 * properties M09.8 makes the package responsible for, several of which nothing
 * was asserting while the code lived inside a search.
 */

const wave1 = generationEnvironmentForFormat('precon_wave_1');

/** Narrows an environment the way a starved or hostile configuration would. */
function restrict(
  environment: GenerationEnvironment,
  options: {
    readonly cardIds?: readonly string[];
    readonly commanderIds?: readonly string[];
    readonly deckSize?: number;
  },
): GenerationEnvironment {
  const cardIds = options.cardIds;
  const commanderIds = options.commanderIds;
  return {
    ...environment,
    id: environment.id + '_restricted',
    ...(cardIds ? { pool: environment.pool.filter((card) => cardIds.includes(card.id)) } : {}),
    ...(commanderIds
      ? { commanders: environment.commanders.filter((card) => commanderIds.includes(card.id)) }
      : {}),
    ...(options.deckSize === undefined
      ? {}
      : { deckFormat: { ...environment.deckFormat, deckSize: options.deckSize } }),
  };
}

describe('a legal deck, or nothing', () => {
  it('builds a deck the deck builder itself accepts', () => {
    const { deck, diagnostics, pool } = generateDeck(wave1, 'legal-1');
    expect(diagnostics).toEqual([]);
    expect(deck).not.toBeNull();
    expect(checkDeck(deck!, wave1).legal).toBe(true);
    expect(isFullSize(deck!, wave1)).toBe(true);
    expect(pool?.commanderId).toBe(deck!.commanderId);
  });

  it('honours singleton and the exact deck size', () => {
    for (let index = 0; index < 8; index += 1) {
      const { deck } = generateDeck(wave1, 'size-' + index);
      expect(deckSize(deck!)).toBe(wave1.deckFormat.deckSize);
      expect(deck!.cards.every((entry) => entry.quantity === 1)).toBe(true);
      expect(new Set(deck!.cards.map((entry) => entry.cardId)).size).toBe(deck!.cards.length);
    }
  });

  it('never draws a card the Commander cannot legally run', () => {
    for (let index = 0; index < 8; index += 1) {
      const { deck } = generateDeck(wave1, 'identity-' + index);
      const commander = wave1.database.get(deck!.commanderId)!;
      const legal = new Set(poolFor(wave1, commander).map((card) => card.id));
      for (const entry of deck!.cards) expect(legal.has(entry.cardId)).toBe(true);
    }
  });

  it('never reaches outside the environment pool to make a deck work', () => {
    const permitted = new Set(wave1.pool.map((card) => card.id));
    for (let index = 0; index < 8; index += 1) {
      const { deck } = generateDeck(wave1, 'pool-' + index);
      for (const entry of deck!.cards) expect(permitted.has(entry.cardId)).toBe(true);
    }
  });

  it('records provenance rather than leaving it to be inferred', () => {
    const unplanned = generateDeck(wave1, 'prov-1').deck!;
    expect(unplanned.construction.kind).toBe('unconstrained');
    expect(unplanned.construction.planId).toBeNull();
    expect(unplanned.origin.kind).toBe('random');
    expect(unplanned.origin.mutationSeed).toBe('prov-1');

    const planned = generateDeck(wave1, 'prov-2', { planId: 'plan_goblin_swarm' }).deck!;
    expect(planned.construction.kind).toBe('plan_generated');
    expect(planned.construction.planId).toBe('plan_goblin_swarm');
    expect(planned.origin.kind).toBe('stratified');
  });

  it('returns a deck nothing can edit after the fact', () => {
    const { deck } = generateDeck(wave1, 'frozen');
    expect(Object.isFrozen(deck)).toBe(true);
    expect(Object.isFrozen(deck!.cards)).toBe(true);
    expect(Object.isFrozen(deck!.cards[0])).toBe(true);
    // A deck is named by a hash of its own contents, so an edited one would be
    // holding an ID that describes a different list.
    expect(() => {
      (deck as unknown as { hash: string }).hash = 'tampered';
    }).toThrow(TypeError);
    expect(toSavedDeck(deck!).cards).toHaveLength(deck!.cards.length);
  });
});

describe('the same seed, the same deck', () => {
  it('is deterministic and seed-sensitive', () => {
    expect(generateDeck(wave1, 'det').deck?.hash).toBe(generateDeck(wave1, 'det').deck?.hash);
    const hashes = new Set(
      Array.from({ length: 10 }, (_, index) => generateDeck(wave1, 'det-' + index).deck?.hash),
    );
    expect(hashes.size).toBeGreaterThan(1);
  });

  it('is independent of the order populations are generated in', () => {
    const first = generatePopulation(wave1, 'order', 4);
    const second = generatePopulation(wave1, 'order', 4);
    expect(second.decks.map((deck) => deck.hash)).toEqual(first.decks.map((deck) => deck.hash));
  });
});

describe('what the format left to work with', () => {
  it('reports the legal pool and the forced-inclusion floor', () => {
    for (const commander of wave1.commanders) {
      const report = poolReportFor(wave1, commander);
      expect(report.legalPoolSize).toBe(poolFor(wave1, commander).length);
      // Wave 1 is 41-42 legal cards for a 40-card singleton deck, so any two
      // decks under one Commander share all but one or two cards.
      expect(report.legalPoolSize).toBeGreaterThanOrEqual(41);
      expect(report.slack).toBe(report.poolCapacity - report.deckSize);
      expect(report.forcedInclusionFloor).toBe(report.deckSize - report.slack);
      expect(report.forcedInclusionFloor).toBeGreaterThanOrEqual(38);
    }
  });

  it('reports a floor of zero when the pool is comfortably larger than the deck', () => {
    const roomy = restrict(wave1, { deckSize: 10 });
    const report = poolReportFor(roomy, roomy.commanders[0]!);
    expect(report.slack).toBeGreaterThan(report.deckSize);
    expect(report.forcedInclusionFloor).toBe(0);
  });

  it('never claims a floor larger than the pool can supply', () => {
    const starved = restrict(wave1, {
      cardIds: ['throwing_knife', 'veteran_guard'],
      commanderIds: ['goblin_warboss'],
    });
    const report = poolReportFor(starved, starved.commanders[0]!);
    expect(report.poolCapacity).toBe(2);
    expect(report.forcedInclusionFloor).toBe(2);
  });

  it('reports the pool beside the refusal when the pool is the reason', () => {
    const starved = restrict(wave1, {
      cardIds: ['throwing_knife', 'veteran_guard'],
      commanderIds: ['goblin_warboss'],
    });
    const { deck, diagnostics, pool } = generateDeck(starved, 'starved');
    expect(deck).toBeNull();
    expect(diagnostics[0]?.code).toBe('sim/pool_too_small');
    expect(diagnostics[0]?.message).toMatch(/at most 2 cards/);
    expect(pool?.legalPoolSize).toBe(2);
  });
});

describe('named problems, never a quiet repair', () => {
  it('refuses when no Commander matches the configuration', () => {
    const { deck, diagnostics, pool } = generateDeck(wave1, 'none', {
      commanderIds: ['no_such_commander'],
    });
    expect(deck).toBeNull();
    expect(diagnostics[0]?.code).toBe('sim/no_legal_commander');
    expect(pool).toBeNull();
  });

  it('skips and names a required card the Commander cannot run', () => {
    const { deck, diagnostics } = generateDeck(
      wave1,
      'illegal-required',
      { requiredCards: [{ cardId: 'goblin_chieftain', quantity: 1 }] },
      { commanderId: 'chief_containment_scholar' },
    );
    expect(diagnostics.map((entry) => entry.code)).toContain('sim/required_card_illegal');
    expect(deck?.cards.some((entry) => entry.cardId === 'goblin_chieftain')).toBe(false);
    expect(checkDeck(deck!, wave1).legal).toBe(true);
  });

  it('skips and names a required card that does not exist at all', () => {
    const { deck, diagnostics } = generateDeck(wave1, 'unknown-required', {
      requiredCards: [{ cardId: 'not_a_card', quantity: 1 }],
    });
    expect(diagnostics.map((entry) => entry.code)).toContain('sim/required_card_illegal');
    expect(deck?.cards.some((entry) => entry.cardId === 'not_a_card')).toBe(false);
  });

  it('names an unknown deck plan instead of generating something unplanned', () => {
    const { deck, diagnostics, pool } = generateDeck(wave1, 'plan', { planId: 'no_such_plan' });
    expect(deck).toBeNull();
    expect(diagnostics[0]?.code).toBe('sim/unknown_deck_plan');
    expect(pool).toBeNull();
  });

  it('refuses a plan whose cards the environment does not contain', () => {
    const trimmed = restrict(wave1, {
      cardIds: wave1.pool.filter((card) => !card.id.startsWith('goblin_')).map((card) => card.id),
    });
    const { deck, diagnostics } = generateDeck(trimmed, 'plan', { planId: 'plan_goblin_swarm' });
    expect(deck).toBeNull();
    expect(diagnostics[0]?.code).toBe('sim/deck_plan_card_out_of_pool');
  });

  it('says which Commander a plan took, rather than silently overriding one', () => {
    const { deck, diagnostics } = generateDeck(
      wave1,
      'plan-commander',
      { planId: 'plan_goblin_swarm' },
      { commanderId: 'grave_matriarch' },
    );
    expect(diagnostics.map((entry) => entry.code)).toContain('sim/plan_fixes_commander');
    expect(deck?.commanderId).toBe('goblin_warboss');
  });

  it('refuses a plan the Commander filter excludes', () => {
    const { deck, diagnostics } = generateDeck(wave1, 'plan-excluded', {
      planId: 'plan_goblin_swarm',
      commanderIds: ['grave_matriarch'],
    });
    expect(deck).toBeNull();
    expect(diagnostics[0]?.code).toBe('sim/plan_commander_excluded');
  });

  it('reports a population it could not fill instead of returning a short one quietly', () => {
    const single = restrict(wave1, { commanderIds: ['goblin_warboss'] });
    const { decks, diagnostics } = generatePopulation(single, 'pop', 500);
    expect(decks.length).toBeLessThan(500);
    expect(diagnostics.map((entry) => entry.code)).toContain('sim/population_short');
  });
});

describe('the package policy a plan is seeded under', () => {
  it('seeds every package under "all" and fewer under "core"', () => {
    const all = generateDeck(wave1, 'pol-1', {
      planId: 'plan_goblin_swarm',
      planPackages: 'all',
    }).deck!;
    const core = generateDeck(wave1, 'pol-1', {
      planId: 'plan_goblin_swarm',
      planPackages: 'core',
    }).deck!;
    expect(all.construction.packagesBroken).toEqual([]);
    expect(all.origin.changes.length).toBeGreaterThan(core.origin.changes.length);
    expect(core.construction.kind).toBe('plan_generated');
  });

  it('seeds a package whole or not at all, and says which it skipped', () => {
    const { diagnostics } = generateDeck(wave1, 'pol-2', {
      planId: 'plan_goblin_swarm',
      requiredCards: wave1.pool
        .filter((card) => !card.id.startsWith('goblin_'))
        .slice(0, 38)
        .map((card) => ({ cardId: card.id, quantity: 1 })),
    });
    expect(diagnostics.map((entry) => entry.code)).toContain('sim/package_not_seeded');
  });
});
