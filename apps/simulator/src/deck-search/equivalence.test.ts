import { describe, expect, it } from 'vitest';
import {
  digestOf,
  generateDeck,
  generatePopulation,
  generationEnvironmentForFormat,
} from '@tcg/deck-generator';
import {
  GOLDEN_FORMAT_ID,
  TINY_GOLDENS,
  WAVE_1_GOLDEN_CASES,
  WAVE_1_POPULATION_GOLDEN,
} from '@tcg/deck-generator/test-goldens';
import { PRECON_WAVE_1_DECK_FORMAT } from '@tcg/deck';
import { resolveEnvironment } from '../environment.js';
import { tinyEnvironment } from '../test-fixtures.js';

/**
 * The simulator half of M09.8's equivalence claim.
 *
 * Two things are checked here that the package cannot check for itself:
 *
 * - A simulator `Environment` — the full one, with hashes, a rules config and a
 *   resolved card set — still drives the extracted generator to the decks it
 *   drove the in-app generator to before the move.
 * - The simulator's own twelve-card fixture environment does too, so the claim
 *   is not resting on one real format that happens to be well behaved.
 */

const wave1 = resolveEnvironment({
  id: 'wave1',
  format: GOLDEN_FORMAT_ID,
  deckFormat: { ...PRECON_WAVE_1_DECK_FORMAT },
});
const tiny = tinyEnvironment();

describe('the extracted generator against a simulator Environment', () => {
  it.each(WAVE_1_GOLDEN_CASES.map((entry) => [entry.name, entry] as const))(
    'reproduces %s',
    (_name, entry) => {
      const result = generateDeck(wave1, entry.seed, entry.config, {
        ...(entry.commanderId === undefined ? {} : { commanderId: entry.commanderId }),
        ...(entry.label === undefined ? {} : { label: entry.label }),
      });
      expect(digestOf({ deck: result.deck, diagnostics: result.diagnostics }, 32)).toBe(
        entry.digest,
      );
    },
  );

  it('reproduces a whole stratified population', () => {
    const result = generatePopulation(
      wave1,
      WAVE_1_POPULATION_GOLDEN.seed,
      WAVE_1_POPULATION_GOLDEN.size,
    );
    expect(digestOf({ decks: result.decks, diagnostics: result.diagnostics }, 32)).toBe(
      WAVE_1_POPULATION_GOLDEN.digest,
    );
  });

  it('agrees, card for card, with the package’s own format-scoped environment', () => {
    const scoped = generationEnvironmentForFormat(GOLDEN_FORMAT_ID);
    for (const entry of WAVE_1_GOLDEN_CASES) {
      const options = {
        ...(entry.commanderId === undefined ? {} : { commanderId: entry.commanderId }),
        ...(entry.label === undefined ? {} : { label: entry.label }),
      };
      expect(generateDeck(wave1, entry.seed, entry.config, options).deck).toEqual(
        generateDeck(scoped, entry.seed, entry.config, options).deck,
      );
    }
  });
});

describe('the extracted generator against the simulator’s fixture environment', () => {
  it('reproduces the recorded single deck', () => {
    const result = generateDeck(tiny, 'seed-1');
    expect(digestOf({ deck: result.deck, diagnostics: result.diagnostics }, 32)).toBe(
      TINY_GOLDENS.seed1Digest,
    );
  });

  it('reproduces the recorded population', () => {
    const result = generatePopulation(tiny, 'pop', 6);
    expect(digestOf({ decks: result.decks, diagnostics: result.diagnostics }, 32)).toBe(
      TINY_GOLDENS.population6Digest,
    );
  });
});
