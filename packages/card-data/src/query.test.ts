import { describe, expect, it } from 'vitest';
import { loadBundledCardData } from './default-set.js';
import { isColorIdentityLegal, matchesQuery } from './query.js';
import type { CardDefinition } from './schema/card.js';

const { database } = loadBundledCardData();
const ids = (cards: readonly CardDefinition[]) => cards.map((c) => c.id);

describe('isColorIdentityLegal', () => {
  it('accepts neutral cards under any Commander', () => {
    expect(isColorIdentityLegal([], ['blue', 'red'])).toBe(true);
    expect(isColorIdentityLegal([], [])).toBe(true);
  });

  it('accepts a card whose colours are a subset of the Commander identity', () => {
    expect(isColorIdentityLegal(['blue'], ['blue', 'red'])).toBe(true);
    expect(isColorIdentityLegal(['blue', 'red'], ['blue', 'red'])).toBe(true);
  });

  it('rejects a card with any colour outside the Commander identity', () => {
    expect(isColorIdentityLegal(['green'], ['blue', 'red'])).toBe(false);
    expect(isColorIdentityLegal(['blue', 'green'], ['blue', 'red'])).toBe(false);
  });
});

describe('matchesQuery', () => {
  const scorch = database.getOrThrow('scorch');
  const bramble = database.getOrThrow('bramble_titan');

  it('matches an empty query against everything', () => {
    expect(database.search({})).toHaveLength(database.size);
  });

  it('searches display name and rules text, case-insensitively', () => {
    expect(matchesQuery(scorch, { text: 'SCORCH' })).toBe(true);
    expect(matchesQuery(scorch, { text: '3 damage' })).toBe(true);
    expect(matchesQuery(scorch, { text: 'bramble' })).toBe(false);
  });

  it('requires every whitespace-separated term to match', () => {
    expect(matchesQuery(scorch, { text: 'deal damage' })).toBe(true);
    expect(matchesQuery(scorch, { text: 'deal heal' })).toBe(false);
  });

  it('filters by colour, optionally including neutral cards', () => {
    const green = database.search({ colors: ['green'] });
    expect(green.every((c) => c.colorIdentity.includes('green'))).toBe(true);
    expect(ids(green)).toContain('bramble_titan');

    const greenOrNeutral = database.search({ colors: ['green'], includeNeutral: true });
    expect(ids(greenOrNeutral)).toContain('prototype_scout');
  });

  it('filters by card type', () => {
    const relics = database.search({ types: ['relic'] });
    expect(relics.length).toBeGreaterThan(0);
    expect(relics.every((c) => c.type === 'relic')).toBe(true);
  });

  it('filters by energy cost range and excludes costless cards', () => {
    const cheap = database.search({ minCost: 0, maxCost: 1 });
    expect(cheap.every((c) => c.cost !== null && c.cost <= 1)).toBe(true);
    expect(ids(cheap)).not.toContain('prototype_soldier_token');

    const expensive = database.search({ minCost: 7, maxCost: null });
    expect(ids(expensive)).toContain('worldbreaker_engine');
  });

  it('filters by keyword and tag', () => {
    expect(matchesQuery(bramble, { keywords: ['armored'] })).toBe(true);
    expect(matchesQuery(bramble, { keywords: ['swift'] })).toBe(false);
    expect(matchesQuery(bramble, { tags: ['beast'] })).toBe(true);
    expect(matchesQuery(bramble, { tags: ['goblin'] })).toBe(false);
  });

  it('filters by uniqueness in both directions', () => {
    const uniques = database.search({ unique: true });
    expect(uniques.every((c) => c.unique)).toBe(true);
    const regulars = database.search({ unique: false });
    expect(regulars.every((c) => !c.unique)).toBe(true);
    expect(uniques.length + regulars.length).toBe(database.size);
  });

  it('filters by role and power class', () => {
    const finishers = database.search({ roles: ['finisher'] });
    expect(finishers.length).toBeGreaterThan(0);
    expect(finishers.every((c) => c.role === 'finisher')).toBe(true);

    const centerpieces = database.search({ powerClasses: ['centerpiece'] });
    expect(centerpieces.every((c) => c.powerClass === 'centerpiece')).toBe(true);
  });

  it('filters to cards legal under a Commander colour identity', () => {
    const legal = database.search(
      { legalUnderColorIdentity: ['blue', 'red'] },
      database.deckable(),
    );
    expect(ids(legal)).toContain('scorch');
    expect(ids(legal)).toContain('desperate_insight');
    expect(ids(legal)).toContain('stormforge_adept');
    expect(ids(legal)).toContain('prototype_scout');
    expect(ids(legal)).not.toContain('bramble_titan');
  });

  it('combines filters with AND', () => {
    const result = database.search({ colors: ['black'], types: ['spell'], maxCost: 2 });
    expect(ids(result).sort()).toEqual(['blood_pact', 'wither_touch']);
  });
});

describe('CardDatabase', () => {
  it('exposes tags and the maximum cost for building filter controls', () => {
    expect(database.allTags()).toContain('goblin');
    expect(database.allTags()).toEqual([...database.allTags()].sort());
    expect(database.maxCost()).toBe(8);
  });

  it('returns undefined for unknown IDs and throws only when asked to', () => {
    expect(database.get('not_a_card')).toBeUndefined();
    expect(database.has('not_a_card')).toBe(false);
    expect(() => database.getOrThrow('not_a_card')).toThrow(/not_a_card/);
  });

  it('sorts cards by cost, then colour, then name', () => {
    const costs = database.all().map((c) => c.cost ?? -1);
    expect(costs).toEqual([...costs].sort((a, b) => a - b));
  });
});
