import { describe, expect, it } from 'vitest';

import {
  BASIS_WORDING,
  DECK_COUNT_SOURCES,
  ESTIMATE_BASES,
  FORCED_INCLUSION_CAVEAT,
  combineBases,
  deckCountSchema,
  estimateBasisSchema,
  estimateStageSchema,
  forcedInclusionFloorSchema,
  matchCountEstimateSchema,
  seatOrderCountSchema,
  type EstimateBasis,
  type EstimateStage,
} from './estimate.js';

/**
 * The estimate's *shape*. What the numbers are is `apps/admin-server`'s, and its
 * suite proves them against a real `buildSchedule`; these prove that a shape
 * which claims something it cannot support is refused before it reaches a screen.
 */

function stage(overrides: Partial<EstimateStage> = {}): unknown {
  return {
    stageId: 'matches',
    label: 'The four precons, four games per seat order',
    kind: 'batch',
    purpose: 'exploration',
    matches: 48,
    basis: 'exact',
    reason: '',
    seatOrders: [
      { orientation: 0, matches: 24 },
      { orientation: 1, matches: 24 },
    ],
    gamesPerSeatOrder: 4,
    decks: { count: 4, source: 'resolved_precons', basis: 'exact', rejected: [] },
    pilotTuples: 1,
    repeats: 1,
    ...overrides,
  };
}

function estimate(stages: readonly unknown[], overrides: Record<string, unknown> = {}): unknown {
  const parsed = stages.map((entry) => estimateStageSchema.parse(entry));
  return {
    totalMatches: parsed.reduce((sum, entry) => sum + entry.matches, 0),
    basis: combineBases(parsed.map((entry) => entry.basis)),
    stages,
    forcedInclusion: [],
    limitations: [],
    ...overrides,
  };
}

describe('combineBases', () => {
  it('is exact only when every part is', () => {
    expect(combineBases(['exact', 'exact'])).toBe('exact');
    expect(combineBases([])).toBe('exact');
  });

  it('degrades to an upper bound when a part is one', () => {
    expect(combineBases(['exact', 'upper_bound'])).toBe('upper_bound');
  });

  it('lets `at_least` win over `upper_bound`, in either order', () => {
    // The rule the whole enum exists for: a total containing one part that can
    // grow without limit is not an upper bound on anything, however tightly the
    // other parts are bounded.
    expect(combineBases(['upper_bound', 'at_least'])).toBe('at_least');
    expect(combineBases(['at_least', 'upper_bound'])).toBe('at_least');
    expect(combineBases(['exact', 'at_least'])).toBe('at_least');
  });

  it('has a wording for every basis, so no screen invents one', () => {
    for (const basis of ESTIMATE_BASES) {
      expect(BASIS_WORDING[basis]).toMatch(/\S/);
    }
    expect(Object.keys(BASIS_WORDING).sort()).toEqual([...ESTIMATE_BASES].sort());
  });
});

describe('a stage', () => {
  it('round-trips an exact precon benchmark', () => {
    const parsed = estimateStageSchema.parse(stage());
    expect(parsed.matches).toBe(48);
    expect(parsed.seatOrders).toHaveLength(2);
  });

  it('refuses a bound that does not say why it is one', () => {
    expect(() => estimateStageSchema.parse(stage({ basis: 'upper_bound', reason: '' }))).toThrow();
    expect(() => estimateStageSchema.parse(stage({ basis: 'at_least', reason: '' }))).toThrow();
    expect(() =>
      estimateStageSchema.parse(
        stage({ basis: 'upper_bound', reason: 'The opponent field overlaps the population.' }),
      ),
    ).not.toThrow();
  });

  it('refuses a seat-order breakdown that does not add up to the total', () => {
    expect(() =>
      estimateStageSchema.parse(
        stage({
          seatOrders: [
            { orientation: 0, matches: 24 },
            { orientation: 1, matches: 23 },
          ],
        }),
      ),
    ).toThrow(/add up/);
  });

  it('allows an empty breakdown, because a stage that schedules nothing has none', () => {
    expect(() =>
      estimateStageSchema.parse(stage({ matches: 0, seatOrders: [], gamesPerSeatOrder: 0 })),
    ).not.toThrow();
  });

  it('refuses the same seat orientation twice', () => {
    expect(() =>
      estimateStageSchema.parse(
        stage({
          seatOrders: [
            { orientation: 0, matches: 24 },
            { orientation: 0, matches: 24 },
          ],
        }),
      ),
    ).toThrow(/at most once/);
  });

  it('refuses an unknown field rather than ignoring it', () => {
    expect(() => estimateStageSchema.parse({ ...(stage() as object), minutes: 12 })).toThrow();
  });

  it('refuses a seat orientation outside a four-seat table', () => {
    expect(() => seatOrderCountSchema.parse({ orientation: 4, matches: 1 })).toThrow();
    expect(() => seatOrderCountSchema.parse({ orientation: -1, matches: 1 })).toThrow();
  });
});

describe('a deck count', () => {
  it('names how it was arrived at, from a closed set', () => {
    for (const source of DECK_COUNT_SOURCES) {
      expect(() => deckCountSchema.parse({ count: 4, source, basis: 'exact' })).not.toThrow();
    }
    expect(() => deckCountSchema.parse({ count: 4, source: 'guessed', basis: 'exact' })).toThrow();
  });

  it('carries refused decks rather than dropping them silently', () => {
    const parsed = deckCountSchema.parse({
      count: 3,
      source: 'resolved_inline',
      basis: 'exact',
      rejected: ['deck_b: 39 cards, needs 40'],
    });
    expect(parsed.rejected).toEqual(['deck_b: 39 cards, needs 40']);
  });

  it('defaults its rejection list to empty', () => {
    expect(
      deckCountSchema.parse({ count: 4, source: 'resolved_precons', basis: 'exact' }).rejected,
    ).toEqual([]);
  });
});

describe('a forced-inclusion floor', () => {
  it('carries the six numbers `poolReportFor` produces', () => {
    const parsed = forcedInclusionFloorSchema.parse({
      commanderId: 'goblin_warboss',
      legalPoolSize: 41,
      poolCapacity: 41,
      deckSize: 40,
      slack: 1,
      forcedInclusionFloor: 39,
    });
    expect(parsed.forcedInclusionFloor).toBe(39);
  });

  it('refuses an extra field, so a caller cannot smuggle a conclusion in beside it', () => {
    expect(() =>
      forcedInclusionFloorSchema.parse({
        commanderId: 'goblin_warboss',
        legalPoolSize: 41,
        poolCapacity: 41,
        deckSize: 40,
        slack: 1,
        forcedInclusionFloor: 39,
        overpowered: true,
      }),
    ).toThrow();
  });

  it('states the caveat once, for every screen that shows a selection statistic', () => {
    expect(FORCED_INCLUSION_CAVEAT).toContain('forced-inclusion floor');
    expect(FORCED_INCLUSION_CAVEAT).toMatch(/not because anything chose it/);
  });
});

describe('the whole estimate', () => {
  it('round-trips a two-stage plan', () => {
    const parsed = matchCountEstimateSchema.parse(
      estimate([
        stage(),
        stage({
          stageId: 'search-r0',
          kind: 'search',
          matches: 320,
          basis: 'upper_bound',
          reason: 'The opponent field is drawn from an archive that overlaps the population.',
          seatOrders: [
            { orientation: 0, matches: 160 },
            { orientation: 1, matches: 160 },
          ],
          repeats: 5,
        }),
      ]),
    );
    expect(parsed.totalMatches).toBe(368);
    expect(parsed.basis).toBe('upper_bound');
  });

  it('refuses a total that is not the sum of its stages', () => {
    expect(() => matchCountEstimateSchema.parse(estimate([stage()], { totalMatches: 47 }))).toThrow(
      /sum of the stages/,
    );
  });

  it('refuses a basis stronger than the stages support', () => {
    // The failure this exists to catch: an exact-looking total built out of a
    // stage that was only ever a bound.
    expect(() =>
      matchCountEstimateSchema.parse(
        estimate(
          [
            stage({
              basis: 'at_least',
              reason: 'The number of replacement variants depends on the comparable cards found.',
            }),
          ],
          { basis: 'exact' },
        ),
      ),
    ).toThrow(/combination of its stages/);
  });

  it('requires at least one stage, because an estimate of nothing is not an estimate', () => {
    expect(() =>
      matchCountEstimateSchema.parse({
        totalMatches: 0,
        basis: 'exact',
        stages: [],
        forcedInclusion: [],
        limitations: [],
      }),
    ).toThrow();
  });

  it('defaults the floors and the limitations to empty lists', () => {
    const parsed = matchCountEstimateSchema.parse({
      totalMatches: 48,
      basis: 'exact',
      stages: [stage()],
    });
    expect(parsed.forcedInclusion).toEqual([]);
    expect(parsed.limitations).toEqual([]);
  });

  it('accepts every basis the enum declares', () => {
    for (const basis of ESTIMATE_BASES) {
      expect(estimateBasisSchema.parse(basis)).toBe(basis satisfies EstimateBasis);
    }
  });
});
