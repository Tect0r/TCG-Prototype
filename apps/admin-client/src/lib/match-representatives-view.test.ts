import { describe, expect, it } from 'vitest';

import { representativeMatchKindLabel } from './match-representatives-view.js';

describe('representativeMatchKindLabel', () => {
  it('labels every representative-match kind in words', () => {
    expect(representativeMatchKindLabel('closest')).toBe('Closest matchup');
    expect(representativeMatchKindLabel('largest_upset')).toBe('Largest upset');
    expect(representativeMatchKindLabel('most_one_sided')).toBe('Most one-sided');
    expect(representativeMatchKindLabel('shortest')).toBe('Shortest');
    expect(representativeMatchKindLabel('longest')).toBe('Longest');
    expect(representativeMatchKindLabel('pre_adaptation')).toBe('Pre-adaptation');
    expect(representativeMatchKindLabel('random_ordinary')).toBe('Deterministic ordinary sample');
  });
});
