import { describe, expect, it } from 'vitest';

import {
  EMPTY_RESULTS_FILTER,
  resultsFilterIsEmpty,
  toCatalogFilterInput,
  toggled,
} from './results-view.js';

describe('whether the filter narrows anything', () => {
  it('is empty for the default state', () => {
    expect(resultsFilterIsEmpty(EMPTY_RESULTS_FILTER)).toBe(true);
  });

  it('is not empty once any one field is set', () => {
    expect(resultsFilterIsEmpty({ ...EMPTY_RESULTS_FILTER, status: ['running'] })).toBe(false);
    expect(resultsFilterIsEmpty({ ...EMPTY_RESULTS_FILTER, purpose: 'validation' })).toBe(false);
    expect(resultsFilterIsEmpty({ ...EMPTY_RESULTS_FILTER, baseline: true })).toBe(false);
    expect(resultsFilterIsEmpty({ ...EMPTY_RESULTS_FILTER, createdAfter: '2026-08-01' })).toBe(
      false,
    );
  });

  it('treats a content hash of only whitespace as unset', () => {
    expect(resultsFilterIsEmpty({ ...EMPTY_RESULTS_FILTER, fullContentHash: '   ' })).toBe(true);
  });
});

describe('converting to the request the catalog reads', () => {
  it('names nothing when nothing is set', () => {
    const filter = toCatalogFilterInput(EMPTY_RESULTS_FILTER);
    expect(filter.status).toEqual([]);
    expect(filter.purpose).toBeNull();
    expect(filter.fullContentHash).toBeNull();
    expect(filter.createdAfter).toBeNull();
    expect(filter.createdBefore).toBeNull();
  });

  it('turns a typed date into an inclusive UTC day range', () => {
    const filter = toCatalogFilterInput({
      ...EMPTY_RESULTS_FILTER,
      createdAfter: '2026-08-20',
      createdBefore: '2026-08-24',
    });
    expect(filter.createdAfter).toBe('2026-08-20T00:00:00.000Z');
    expect(filter.createdBefore).toBe('2026-08-24T23:59:59.999Z');
  });

  it('trims a pasted content hash, and nulls out an empty one', () => {
    expect(
      toCatalogFilterInput({ ...EMPTY_RESULTS_FILTER, fullContentHash: '  abc123  ' })
        .fullContentHash,
    ).toBe('abc123');
    expect(
      toCatalogFilterInput({ ...EMPTY_RESULTS_FILTER, fullContentHash: '   ' }).fullContentHash,
    ).toBeNull();
  });

  it('carries every multi-select field through unchanged', () => {
    const filter = toCatalogFilterInput({
      ...EMPTY_RESULTS_FILTER,
      status: ['running', 'completed'],
      sourceClasses: ['ai'],
      kinds: ['batch'],
      preconIds: ['precon_goblin_swarm'],
      commanderIds: ['goblin_warboss'],
      baseline: false,
    });
    expect(filter.status).toEqual(['running', 'completed']);
    expect(filter.sourceClasses).toEqual(['ai']);
    expect(filter.kinds).toEqual(['batch']);
    expect(filter.preconIds).toEqual(['precon_goblin_swarm']);
    expect(filter.commanderIds).toEqual(['goblin_warboss']);
    expect(filter.baseline).toBe(false);
  });
});

describe('toggling one member of a multi-select field', () => {
  it('adds a value that is not present', () => {
    expect(toggled(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('removes a value that is present, without touching the others', () => {
    expect(toggled(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('never produces a repeat', () => {
    const once = toggled([], 'a');
    expect(toggled(once, 'a')).toEqual([]);
  });
});
