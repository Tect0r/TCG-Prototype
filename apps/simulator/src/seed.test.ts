import { describe, expect, it } from 'vitest';
import {
  SEED_DERIVATION_VERSION,
  deckPairSeed,
  deriveSeedBundle,
  environmentSeed,
  gameSeed,
  pairedGameSeed,
  seedBundleSchema,
  seededIndex,
} from './seed.js';

/** CLAUDE.md §13.4: the seed hierarchy, and §13.15 item 4: reproducibility. */

describe('seed derivation', () => {
  it('derives the documented path shape', () => {
    const path = gameSeed(deckPairSeed(environmentSeed('exp', 'baseline'), 'abc123'), 7);
    expect(path).toBe('exp|env:baseline|pair:abc123|game:000007');
  });

  it('produces a schema-valid bundle whose parts all differ', () => {
    const bundle = deriveSeedBundle('exp|env:baseline|pair:abc|game:000000', 3);
    expect(seedBundleSchema.parse(bundle)).toEqual(bundle);
    expect(bundle.derivationVersion).toBe(SEED_DERIVATION_VERSION);
    expect(bundle.pilotSeeds).toHaveLength(3);
    const all = [bundle.matchSeed, bundle.seatSeed, ...bundle.pilotSeeds];
    expect(new Set(all).size).toBe(all.length);
  });

  it('is a pure function of the path', () => {
    expect(deriveSeedBundle('p', 2)).toEqual(deriveSeedBundle('p', 2));
    expect(deriveSeedBundle('p', 2).matchSeed).not.toBe(deriveSeedBundle('q', 2).matchSeed);
  });

  it('separates game indices, deck pairs and environments', () => {
    const base = deckPairSeed(environmentSeed('exp', 'baseline'), 'pair');
    expect(deriveSeedBundle(gameSeed(base, 0), 2).matchSeed).not.toBe(
      deriveSeedBundle(gameSeed(base, 1), 2).matchSeed,
    );
    expect(
      deriveSeedBundle(gameSeed(deckPairSeed(environmentSeed('exp', 'a'), 'pair'), 0), 2).matchSeed,
    ).not.toBe(
      deriveSeedBundle(gameSeed(deckPairSeed(environmentSeed('exp', 'b'), 'pair'), 0), 2).matchSeed,
    );
  });

  it('gives a baseline and a candidate common random numbers', () => {
    // The whole point of `pairedGameSeed`: the environment is excluded, so the
    // same deck pair and game index draw the same cards in both arms.
    const left = deriveSeedBundle(pairedGameSeed('exp', 'pair', 3), 2);
    const right = deriveSeedBundle(pairedGameSeed('exp', 'pair', 3), 2);
    expect(left).toEqual(right);
    expect(left.path).not.toContain('env:');
  });

  it('does not depend on anything outside its inputs', () => {
    // No clock, no worker, no process. Re-deriving after a delay is identical.
    const first = deriveSeedBundle('exp|env:x|pair:y|game:000042', 4);
    const second = deriveSeedBundle('exp|env:x|pair:y|game:000042', 4);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('seededIndex', () => {
  it('stays in range and is deterministic', () => {
    for (let index = 0; index < 50; index += 1) {
      const value = seededIndex(`seed-${index}`, 4);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(4);
      expect(seededIndex(`seed-${index}`, 4)).toBe(value);
    }
  });

  it('returns zero for a non-positive bound', () => {
    expect(seededIndex('seed', 0)).toBe(0);
  });

  it('reaches every value over a spread of seeds', () => {
    const seen = new Set(Array.from({ length: 200 }, (_, index) => seededIndex(`s${index}`, 4)));
    expect(seen.size).toBe(4);
  });
});
