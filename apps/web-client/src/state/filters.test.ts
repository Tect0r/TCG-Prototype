import { describe, expect, it } from 'vitest';
import { formatDatabase } from '@tcg/card-data';
import { emptyFilters, isFilterActive, toCardQuery, toggle } from './filters.js';

const database = formatDatabase('development');

describe('toggle', () => {
  it('adds and removes values', () => {
    expect(toggle(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggle(['a', 'b'], 'a')).toEqual(['b']);
  });
});

describe('isFilterActive', () => {
  it('ignores the Commander-legality toggle, which is on by default', () => {
    expect(isFilterActive(emptyFilters)).toBe(false);
    expect(isFilterActive({ ...emptyFilters, commanderLegalOnly: false })).toBe(false);
    expect(isFilterActive({ ...emptyFilters, text: 'scorch' })).toBe(true);
    expect(isFilterActive({ ...emptyFilters, unique: false })).toBe(true);
  });
});

describe('toCardQuery', () => {
  it('omits every unset filter so an empty query matches everything', () => {
    expect(toCardQuery(emptyFilters, null)).toEqual({});
  });

  it('trims the search text and drops it when blank', () => {
    expect(toCardQuery({ ...emptyFilters, text: '  scorch ' }, null)).toEqual({ text: 'scorch' });
    expect(toCardQuery({ ...emptyFilters, text: '   ' }, null)).toEqual({});
  });

  it('carries the neutral toggle only alongside a colour filter', () => {
    expect(toCardQuery({ ...emptyFilters, colors: ['red'] }, null)).toEqual({
      colors: ['red'],
      includeNeutral: true,
    });
    expect(toCardQuery({ ...emptyFilters, includeNeutral: false }, null)).toEqual({});
  });

  it('applies Commander legality only when a Commander is chosen', () => {
    expect(toCardQuery(emptyFilters, ['blue', 'red'])).toEqual({
      legalUnderColorIdentity: ['blue', 'red'],
    });
    expect(toCardQuery({ ...emptyFilters, commanderLegalOnly: false }, ['blue', 'red'])).toEqual(
      {},
    );
  });

  it('produces a query the card database understands end to end', () => {
    const query = toCardQuery({ ...emptyFilters, types: ['spell'], minCost: 1, maxCost: 1 }, [
      'red',
    ]);
    const ids = database.search(query, database.deckable()).map((c) => c.id);
    // Neutral cards are legal under any Commander, so field_survey belongs here.
    expect(ids.sort()).toEqual(['field_survey', 'scorch']);
    expect(ids).not.toContain('root_snare');
  });
});
