import { describe, expect, it } from 'vitest';
import { checkDeck, deckSize, fromSavedDeck, makeDeck, toSavedDeck } from './deck-search/deck.js';
import { generateDeck, generatePopulation, isFullSize, poolFor } from './deck-search/generate.js';
import { crossoverDecks, deckDistance, mutateDeck } from './deck-search/mutate.js';
import { resolveEnvironment } from './environment.js';
import { tinyEnvironment } from './test-fixtures.js';

/**
 * CLAUDE.md §13.15 item 12: generated and mutated decks always pass normal deck
 * validation, and impossible configurations fail with actionable diagnostics
 * rather than a quietly repaired deck.
 */

const env = tinyEnvironment();

describe('generateDeck', () => {
  it('produces a legal, full-size deck', () => {
    const { deck, diagnostics } = generateDeck(env, 'seed-1');
    expect(diagnostics).toEqual([]);
    expect(deck).not.toBeNull();
    expect(isFullSize(deck!, env)).toBe(true);
    expect(checkDeck(deck!, env).legal).toBe(true);
  });

  it('is deterministic for a given seed and varies across seeds', () => {
    expect(generateDeck(env, 'seed-1').deck?.hash).toBe(generateDeck(env, 'seed-1').deck?.hash);
    const hashes = new Set(
      Array.from({ length: 12 }, (_, index) => generateDeck(env, `s${index}`).deck?.hash),
    );
    expect(hashes.size).toBeGreaterThan(1);
  });

  it('never exceeds the copy limit', () => {
    for (let index = 0; index < 25; index += 1) {
      const { deck } = generateDeck(env, `copy-${index}`);
      for (const entry of deck?.cards ?? []) {
        expect(entry.quantity).toBeLessThanOrEqual(env.deckFormat.copyLimit);
      }
    }
  });

  it('only ever uses cards legal under the chosen Commander', () => {
    for (let index = 0; index < 20; index += 1) {
      const { deck } = generateDeck(env, `identity-${index}`);
      const commander = env.database.get(deck!.commanderId)!;
      const legal = new Set(poolFor(env, commander).map((card) => card.id));
      for (const entry of deck!.cards) expect(legal.has(entry.cardId)).toBe(true);
    }
  });

  it('honours a requested Commander', () => {
    const { deck } = generateDeck(env, 'fixed', {}, { commanderId: 'prototype_commander_red' });
    expect(deck?.commanderId).toBe('prototype_commander_red');
  });

  it('reports, rather than silently substituting, an unavailable Commander', () => {
    const { deck, diagnostics } = generateDeck(
      env,
      'unavailable',
      {},
      { commanderId: 'prototype_commander_blue_red' },
    );
    expect(deck).not.toBeNull();
    expect(diagnostics.map((entry) => entry.code)).toContain('sim/commander_unavailable');
  });

  it('respects required cards', () => {
    const { deck } = generateDeck(env, 'required', {
      requiredCards: [{ cardId: 'fixture_strong_unit', quantity: 2 }],
    });
    const entry = deck?.cards.find((card) => card.cardId === 'fixture_strong_unit');
    expect(entry?.quantity).toBe(2);
  });

  it('fails with an actionable diagnostic when no Commander matches', () => {
    const { deck, diagnostics } = generateDeck(env, 'seed', {
      commanderIds: ['no_such_commander'],
    });
    expect(deck).toBeNull();
    expect(diagnostics[0]?.code).toBe('sim/no_legal_commander');
    expect(diagnostics[0]?.message).toMatch(/no Commander/i);
  });

  it('fails with an actionable diagnostic when the pool cannot fill the format', () => {
    // Three cards, two copies each: six slots for a thirty-card format.
    const starved = resolveEnvironment({
      id: 'starved',
      allowCardIds: [
        'prototype_scout',
        'prototype_guard',
        'trench_guard',
        'prototype_commander_blue',
      ],
      deckFormat: { deckSize: 30, copyLimit: 2 },
    });
    const { deck, diagnostics } = generateDeck(starved, 'seed');
    expect(deck).toBeNull();
    expect(diagnostics[0]?.code).toBe('sim/pool_too_small');
    expect(diagnostics[0]?.message).toMatch(/at most \d+ cards/);
  });
});

describe('generatePopulation', () => {
  it('produces distinct legal decks spread across Commanders', () => {
    const { decks, diagnostics } = generatePopulation(env, 'pop', 6);
    expect(decks).toHaveLength(6);
    expect(diagnostics.filter((entry) => entry.code === 'sim/population_short')).toEqual([]);
    expect(new Set(decks.map((deck) => deck.hash)).size).toBe(6);
    for (const deck of decks) expect(checkDeck(deck, env).legal).toBe(true);
    // Stratification: every legal Commander is used before any is used twice.
    expect(new Set(decks.map((deck) => deck.commanderId)).size).toBe(
      Math.min(6, env.commanders.length),
    );
  });

  it('reports when it cannot reach the requested size', () => {
    const single = resolveEnvironment({
      id: 'single',
      allowCardIds: ['prototype_scout', 'prototype_guard', 'prototype_commander_blue'],
      deckFormat: { deckSize: 4, copyLimit: 2 },
    });
    const { decks, diagnostics } = generatePopulation(single, 'pop', 5);
    // Only one legal deck exists: two copies of each of the two cards.
    expect(decks).toHaveLength(1);
    expect(diagnostics.map((entry) => entry.code)).toContain('sim/population_short');
  });
});

describe('mutateDeck', () => {
  const base = generateDeck(env, 'mutation-base').deck!;

  it('always produces a legal, same-size deck', () => {
    for (let index = 0; index < 40; index += 1) {
      const { deck } = mutateDeck(base, env, `m${index}`, { strength: 3, generation: 1 });
      if (!deck) continue;
      expect(deckSize(deck)).toBe(deckSize(base));
      expect(checkDeck(deck, env).legal).toBe(true);
    }
  });

  it('records auditable lineage', () => {
    const { deck } = mutateDeck(base, env, 'lineage', { strength: 2, generation: 4 });
    expect(deck?.origin.kind).toBe('mutation');
    expect(deck?.origin.parentHashes).toEqual([base.hash]);
    expect(deck?.origin.generation).toBe(4);
    expect(deck?.origin.mutationSeed).toBe('lineage');
    expect(deck?.origin.changes.length).toBeGreaterThan(0);
    for (const change of deck?.origin.changes ?? []) expect(change).toMatch(/^-1 \w+ \+1 \w+$/);
  });

  it('is deterministic for a given seed', () => {
    const first = mutateDeck(base, env, 'same', { strength: 3, generation: 1 });
    const second = mutateDeck(base, env, 'same', { strength: 3, generation: 1 });
    expect(second.deck?.hash).toBe(first.deck?.hash);
  });

  it('reports rather than repairs when no swap is possible', () => {
    // Two cards, two copies each, four-card format: the deck is the whole pool.
    const locked = resolveEnvironment({
      id: 'locked',
      allowCardIds: ['prototype_scout', 'prototype_guard', 'prototype_commander_blue'],
      deckFormat: { deckSize: 4, copyLimit: 2 },
    });
    const full = makeDeck({
      commanderId: 'prototype_commander_blue',
      cards: [
        { cardId: 'prototype_scout', quantity: 2 },
        { cardId: 'prototype_guard', quantity: 2 },
      ],
    });
    const { deck, reasons } = mutateDeck(full, locked, 'stuck', { strength: 2, generation: 1 });
    expect(deck).toBeNull();
    expect(reasons.join(' ')).toMatch(/no legal swap|reproduced the parent/);
  });

  it('never returns a deck identical to its parent', () => {
    for (let index = 0; index < 60; index += 1) {
      const { deck } = mutateDeck(base, env, `identity-${index}`, { strength: 2, generation: 1 });
      if (deck) expect(deck.hash).not.toBe(base.hash);
    }
  });
});

describe('crossoverDecks', () => {
  it('produces a legal child or nothing, never an illegal one', () => {
    const left = generateDeck(env, 'x-left').deck!;
    const right = generateDeck(env, 'x-right').deck!;
    for (let index = 0; index < 20; index += 1) {
      const { deck } = crossoverDecks(left, right, env, `x${index}`, 2);
      if (!deck) continue;
      expect(deckSize(deck)).toBe(env.deckFormat.deckSize);
      expect(checkDeck(deck, env).legal).toBe(true);
      expect(deck.origin.parentHashes).toEqual([left.hash, right.hash]);
    }
  });

  it('never returns a copy of either parent', () => {
    const left = generateDeck(env, 'clone-left').deck!;
    const right = generateDeck(env, 'clone-right').deck!;
    for (let index = 0; index < 30; index += 1) {
      for (const [a, b] of [
        [left, right],
        [left, left],
      ] as const) {
        const { deck: child } = crossoverDecks(a, b, env, `clone-${index}`, 1);
        if (!child) continue;
        expect(child.hash).not.toBe(a.hash);
        expect(child.hash).not.toBe(b.hash);
      }
    }
  });
});

describe('deckDistance', () => {
  it('is zero for a deck against itself and grows with each swap', () => {
    const base = generateDeck(env, 'distance').deck!;
    expect(deckDistance(base, base)).toBe(0);
    const mutated = mutateDeck(base, env, 'distance-m', { strength: 2, generation: 1 }).deck!;
    expect(deckDistance(base, mutated)).toBeGreaterThan(0);
    expect(deckDistance(base, mutated)).toBe(deckDistance(mutated, base));
  });

  it('penalises a different Commander', () => {
    const blue = makeDeck({
      commanderId: 'prototype_commander_blue',
      cards: [{ cardId: 'prototype_scout', quantity: 2 }],
    });
    const red = makeDeck({
      commanderId: 'prototype_commander_red',
      cards: [{ cardId: 'prototype_scout', quantity: 2 }],
    });
    expect(deckDistance(blue, red)).toBeGreaterThan(0);
  });
});

describe('deck conversion', () => {
  it('round-trips through the saved deck format', () => {
    const deck = generateDeck(env, 'round-trip').deck!;
    const restored = fromSavedDeck(toSavedDeck(deck));
    expect(restored.hash).toBe(deck.hash);
    expect(restored.cards).toEqual(deck.cards);
  });

  it('rejects an out-of-pool card through the environment check', () => {
    const outside = makeDeck({
      commanderId: 'prototype_commander_blue',
      cards: [
        { cardId: 'tidepool_apprentice', quantity: 2 },
        { cardId: 'prototype_scout', quantity: 2 },
        { cardId: 'prototype_guard', quantity: 2 },
        { cardId: 'trench_guard', quantity: 2 },
        { cardId: 'unstable_construct', quantity: 2 },
        { cardId: 'surveyors_lens', quantity: 2 },
      ],
    });
    const legality = checkDeck(outside, env);
    expect(legality.legal).toBe(false);
    expect(legality.issues.map((issue) => issue.code)).toContain('sim/card_out_of_pool');
  });
});
