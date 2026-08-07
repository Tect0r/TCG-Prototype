import { describe, expect, it } from 'vitest';
import { generateId } from './id.js';

describe('generateId', () => {
  it('is deterministic for fixed sources', () => {
    const sources = { now: () => 1_770_000_000_000, random: () => 0.5 };
    expect(generateId('deck', sources)).toBe(generateId('deck', sources));
  });

  it('uses the prefix and a lowercase alphanumeric body', () => {
    const id = generateId('deck', { now: () => 1_770_000_000_000, random: () => 0.25 });
    expect(id).toMatch(/^deck_[0-9a-z]{18}$/);
  });

  it('sorts lexicographically by creation time', () => {
    const earlier = generateId('deck', { now: () => 1_000_000, random: () => 0.9 });
    const later = generateId('deck', { now: () => 2_000_000, random: () => 0.1 });
    expect(earlier < later).toBe(true);
  });
});
