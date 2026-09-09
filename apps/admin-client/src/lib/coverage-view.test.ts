import { describe, expect, it } from 'vitest';

import type { CatalogCardCoverage, PlayerMetaCardCoverage } from '@tcg/admin-contracts';

import {
  catalogCoverageStageLabel,
  catalogStageTally,
  catalogStageTallyFacts,
  coverageStatusLabel,
  playerMetaObservationTally,
} from './coverage-view.js';

function card(overrides: Partial<CatalogCardCoverage> = {}): CatalogCardCoverage {
  return {
    cardId: 'card_forest',
    eligibility: 'reached',
    inclusion: 'reached',
    draw: 'reached',
    play: 'not_reached',
    activation: 'unavailable',
    trigger: 'not_reached',
    unavailableReasons: { activation: 'no data' },
    ...overrides,
  };
}

describe('coverageStatusLabel', () => {
  it('labels every status in words', () => {
    expect(coverageStatusLabel('reached')).toBe('Reached');
    expect(coverageStatusLabel('not_reached')).toBe('Not reached');
    expect(coverageStatusLabel('unavailable')).toBe('Unavailable');
  });
});

describe('catalogCoverageStageLabel', () => {
  it('labels every catalog stage in words', () => {
    expect(catalogCoverageStageLabel('eligibility')).toBe('Eligibility');
    expect(catalogCoverageStageLabel('inclusion')).toBe('Inclusion');
    expect(catalogCoverageStageLabel('draw')).toBe('Draw');
    expect(catalogCoverageStageLabel('play')).toBe('Play');
    expect(catalogCoverageStageLabel('activation')).toBe('Activation');
    expect(catalogCoverageStageLabel('trigger')).toBe('Trigger');
  });
});

describe('catalogStageTally', () => {
  it('counts cards per status for one stage, naming every status even at zero', () => {
    const cards = [card(), card({ eligibility: 'not_reached' })];
    expect(catalogStageTally(cards, 'eligibility')).toEqual({
      reached: 1,
      not_reached: 1,
      unavailable: 0,
    });
  });

  it('tallies an empty card list as all zero', () => {
    expect(catalogStageTally([], 'play')).toEqual({ reached: 0, not_reached: 0, unavailable: 0 });
  });
});

describe('catalogStageTallyFacts', () => {
  it('renders every stage as a fact, in the funnel order', () => {
    const facts = catalogStageTallyFacts([card()]);
    expect(facts.map((fact) => fact.label)).toEqual([
      'Eligibility',
      'Inclusion',
      'Draw',
      'Play',
      'Activation',
      'Trigger',
    ]);
    expect(facts[3]).toEqual({ label: 'Play', value: '0 reached, 1 not reached, 0 unavailable' });
  });
});

describe('playerMetaObservationTally', () => {
  function pmCard(overrides: Partial<PlayerMetaCardCoverage> = {}): PlayerMetaCardCoverage {
    return { cardId: 'card_forest', observation: 'reached', unavailableReason: null, ...overrides };
  }

  it('counts cards per observation status, naming every status even at zero', () => {
    const cards = [pmCard(), pmCard({ observation: 'unavailable' })];
    expect(playerMetaObservationTally(cards)).toEqual({
      reached: 1,
      not_reached: 0,
      unavailable: 1,
    });
  });
});
