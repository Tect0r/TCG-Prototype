import { describe, expect, it } from 'vitest';

import { cardExplorerEligibilityLabel, formatCardExplorerRate, resultRowFacts } from './card-explorer-view.js';

describe('cardExplorerEligibilityLabel', () => {
  it('labels every eligibility status in words', () => {
    expect(cardExplorerEligibilityLabel('played')).toBe('Played');
    expect(cardExplorerEligibilityLabel('held')).toBe('Held');
    expect(cardExplorerEligibilityLabel('unusable')).toBe('Unusable');
  });
});

describe('formatCardExplorerRate', () => {
  it('formats a rate as a percentage', () => {
    expect(formatCardExplorerRate(0.5)).toBe('50.0%');
  });

  it('names a null rate as structurally ineligible rather than a fabricated zero', () => {
    expect(formatCardExplorerRate(null)).toBe('Not applicable — structurally ineligible');
  });
});

describe('resultRowFacts', () => {
  it('renders every cell as a label/value fact, in order', () => {
    expect(resultRowFacts({ definitionId: 'arcane_snare', deadInHandShare: 0.25 })).toEqual([
      { label: 'definitionId', value: 'arcane_snare' },
      { label: 'deadInHandShare', value: '0.25' },
    ]);
  });

  it('renders a null cell as not measured, distinct from a real zero', () => {
    expect(resultRowFacts({ deadInHandShare: null })).toEqual([
      { label: 'deadInHandShare', value: 'Not measured' },
    ]);
  });
});
