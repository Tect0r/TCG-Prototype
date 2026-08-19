import { describe, expect, it } from 'vitest';
import { generationEnvironmentForFormat } from './environment.js';
import { generateDeck, generatePopulation } from './generate.js';
import { digestOf } from './hash.js';
import {
  GOLDEN_FORMAT_ID,
  WAVE_1_GOLDEN_CASES,
  WAVE_1_POPULATION_GOLDEN,
  WAVE_1_SEED_A_CARDS,
} from './test-goldens.js';

/**
 * M09.8: the generator moved out of the simulator and produces the same decks.
 *
 * The digests in `test-goldens.ts` were recorded from the pre-move code. This
 * suite replays the same inputs through the extracted package and requires the
 * same bytes out, over the whole result rather than over the deck alone — a
 * diagnostic that appeared or a label that changed would fail here too.
 *
 * The other half of the claim — that the *simulator's* own environments still
 * produce these decks — is asserted in
 * `apps/simulator/src/deck-search/equivalence.test.ts`, because only the
 * simulator can build a simulator `Environment`.
 */

const environment = generationEnvironmentForFormat(GOLDEN_FORMAT_ID);

describe('byte equivalence with the pre-extraction generator', () => {
  it.each(WAVE_1_GOLDEN_CASES.map((entry) => [entry.name, entry] as const))(
    'reproduces %s',
    (_name, entry) => {
      const result = generateDeck(environment, entry.seed, entry.config, {
        ...(entry.commanderId === undefined ? {} : { commanderId: entry.commanderId }),
        ...(entry.label === undefined ? {} : { label: entry.label }),
      });
      expect(result.diagnostics).toEqual([]);
      expect(digestOf({ deck: result.deck, diagnostics: result.diagnostics }, 32)).toBe(
        entry.digest,
      );
    },
  );

  it('reproduces a whole stratified population', () => {
    const result = generatePopulation(
      environment,
      WAVE_1_POPULATION_GOLDEN.seed,
      WAVE_1_POPULATION_GOLDEN.size,
    );
    expect(digestOf({ decks: result.decks, diagnostics: result.diagnostics }, 32)).toBe(
      WAVE_1_POPULATION_GOLDEN.digest,
    );
  });

  it('produces the exact recorded decklist, not merely the recorded digest', () => {
    const { deck } = generateDeck(environment, 'seed-a');
    expect(deck?.commanderId).toBe('goblin_warboss');
    expect(deck?.cards.map((entry) => entry.cardId)).toEqual(WAVE_1_SEED_A_CARDS);
    expect(deck?.cards.every((entry) => entry.quantity === 1)).toBe(true);
  });
});

describe('the format-scoped environment the goldens were taken against', () => {
  it('resolves the Wave 1 pool the plan documents', () => {
    expect(environment.deckFormat.deckSize).toBe(40);
    expect(environment.deckFormat.singleton).toBe(true);
    expect(environment.commanders).toHaveLength(4);
    expect(environment.pool.length).toBeGreaterThan(environment.deckFormat.deckSize);
  });

  it('refuses a format that does not exist rather than falling back to the universe', () => {
    expect(() => generationEnvironmentForFormat('no_such_format')).toThrow(/not defined/i);
  });
});
