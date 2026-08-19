import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_SETTINGS } from './config.js';
import { aggregate, aggregateSchema, inOrder, usableRecords } from './analysis/aggregate.js';
import { clusterDecks, featuresOf, FEATURE_NAMES } from './analysis/clusters.js';
import { cardPairs } from './analysis/pairs.js';
import {
  buildReplacementVariant,
  comparableCards,
  replacementImpact,
  type ReplacementImpact,
  type ReplacementVariant,
} from './analysis/replacement.js';
import { computeFlags, FLAG_LEVELS } from './analysis/flags.js';
import {
  cohensH,
  proportion,
  proportionDifference,
  normalizedEntropy,
  round,
} from './analysis/stats.js';
import { runBatch } from './run-batch.js';
import { buildSchedule } from './schedule.js';
import { generatePopulation, type SimDeck } from '@tcg/deck-generator';
import type { MatchRecord } from './telemetry/schema.js';
import type { Environment } from './environment.js';
import {
  FAST_LIMITS,
  NO_RETENTION,
  VALUE_PILOT,
  fixtureDeck,
  tinyEnvironment,
} from './test-fixtures.js';

/**
 * CLAUDE.md §13.10–§13.11 and §13.15 items 16 and 17: controlled replacement
 * detects a deliberately stronger fixture card and does *not* flag an equivalent
 * one, and minimum-support rules suppress conclusions from tiny samples.
 */

const env: Environment = tinyEnvironment({ id: 'analysis', copyLimit: 6 });

/** The base deck: six ordinary 2/2s alongside six cheap bodies. */
const baseDeck = fixtureDeck('base', 'prototype_commander_blue', [
  ['fixture_baseline_unit', 6],
  ['prototype_scout', 6],
]);

/**
 * The opponent field deliberately overlaps *partially* with the arms: every card
 * appears both alongside and apart from at least one other. Without that, no
 * card pair has a marginal to be compared against and the pair analysis has
 * nothing to say.
 */
const opponents = [
  fixtureDeck('field_a', 'prototype_commander_blue', [
    ['prototype_guard', 6],
    ['prototype_scout', 6],
  ]),
  fixtureDeck('field_b', 'prototype_commander_blue', [
    ['prototype_guard', 6],
    ['prototype_drone', 6],
  ]),
];

/* ------------------------------------------------------------ the experiment */

interface Arm {
  readonly deck: SimDeck;
  readonly variant: ReplacementVariant;
}

function arm(replacementId: string): Arm {
  const built = buildReplacementVariant(
    baseDeck,
    env,
    'fixture_baseline_unit',
    replacementId,
    'all',
  );
  if (!built.deck || !built.variant) throw new Error(built.reasons.join('; '));
  return { deck: built.deck, variant: built.variant };
}

/**
 * The card that must be detected, and the one that must not be.
 *
 * The positive control is the *cheaper* fixture rather than the same-cost 9/9.
 * A bigger body at the same price is something a heuristic pilot can misplay —
 * it values the unit more highly and grows reluctant to trade it into a guardian
 * — so it moves win rate in either direction and would make this test measure
 * the pilot. A card that lands a turn earlier is exploited by any pilot that can
 * pay for it. The cost change is a confound, and the analyser has to say so.
 */
const stronger = arm('fixture_dominant_unit');
const equivalent = arm('fixture_equivalent_unit');

let records: readonly MatchRecord[];

beforeAll(async () => {
  const armDecks = [baseDeck, stronger.deck, equivalent.deck];
  const decks = [...armDecks, ...opponents];

  const schedule = buildSchedule({
    experimentId: 'analysis',
    experimentSeed: 'analysis-seed',
    environmentId: env.id,
    decks,
    pilots: [VALUE_PILOT],
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: 4,
    mirrorSeats: true,
    schedule: 'round_robin',
    sampledPairings: 10_000,
    // The whole point of a controlled substitution: every arm plays the same
    // opponents on the same shuffles, so the swapped card is the only difference.
    seedIgnoreDeckHashes: armDecks.map((deck) => deck.hash),
  });

  const armHashes = new Set(armDecks.map((deck) => deck.hash));
  const fieldHashes = new Set(opponents.map((deck) => deck.hash));
  const relevant = schedule.filter((match) => {
    const hashes = match.seats.map((seat) => decks[seat.deckIndex]?.hash ?? '');
    return hashes.some((h) => armHashes.has(h)) && hashes.some((h) => fieldHashes.has(h));
  });

  const outcome = await runBatch({
    experimentId: 'analysis',
    experimentKind: 'replacement',
    configHash: 'analysis-test',
    arm: null,
    environment: env,
    decks,
    pilots: [VALUE_PILOT],
    schedule: relevant,
    limits: FAST_LIMITS,
    retention: NO_RETENTION,
    workers: 1,
    failFast: false,
    sink: null,
    softwareCommit: null,
  });
  records = outcome.records;
}, 120_000);

/**
 * `minPairs` is explicit because the estimate is paired: the fixture plays a
 * handful of games per arm, and the shipped default of 20 complete pairs would
 * correctly refuse to say anything about it. The default is exercised on its own
 * below rather than silently lowered everywhere.
 */
function impactOf(target: Arm, minMatches = 10, minPairs = 8): ReplacementImpact {
  return replacementImpact(target.variant, records, records, { minMatches, minPairs });
}

/* ------------------------------------------------------------------- tests */

describe('comparableCards', () => {
  it('offers same-type cards within one energy of the subject', () => {
    const candidates = comparableCards(env, 'fixture_baseline_unit', []);
    expect(candidates.length).toBeGreaterThan(0);
    for (const card of candidates) {
      expect(card.type).toBe('unit');
      expect(Math.abs((card.cost ?? 0) - 2)).toBeLessThanOrEqual(1);
      expect(card.id).not.toBe('fixture_baseline_unit');
    }
    // Cards sharing role, power class and tags rank first.
    expect(candidates.map((card) => card.id)).toContain('fixture_equivalent_unit');
  });

  it('excludes cards the Commander could not legally run', () => {
    const candidates = comparableCards(env, 'fixture_baseline_unit', ['blue']);
    for (const card of candidates) {
      expect(card.colorIdentity.every((color) => color === 'blue')).toBe(true);
    }
  });
});

describe('buildReplacementVariant', () => {
  it('changes exactly one card and keeps the deck legal and the same size', () => {
    expect(stronger.variant.copiesChanged).toBe(6);
    expect(stronger.deck.cards.find((c) => c.cardId === 'fixture_baseline_unit')).toBeUndefined();
    expect(stronger.deck.cards.find((c) => c.cardId === 'fixture_dominant_unit')?.quantity).toBe(6);
    expect(stronger.deck.cards.reduce((sum, c) => sum + c.quantity, 0)).toBe(
      baseDeck.cards.reduce((sum, c) => sum + c.quantity, 0),
    );
    expect(stronger.deck.origin.kind).toBe('replacement');
    expect(stronger.deck.origin.parentHashes).toEqual([baseDeck.hash]);
  });

  it('refuses rather than repairs when the swap would be illegal', () => {
    // Six more copies of a card the deck already runs six of: over the limit.
    const built = buildReplacementVariant(
      baseDeck,
      env,
      'fixture_baseline_unit',
      'prototype_scout',
      'all',
    );
    expect(built.deck).toBeNull();
    expect(built.reasons.join(' ')).toMatch(/over the limit/);
  });

  it('reports when the base deck does not run the subject at all', () => {
    const built = buildReplacementVariant(baseDeck, env, 'trench_guard', null, 'all');
    expect(built.deck).toBeNull();
    expect(built.reasons.join(' ')).toMatch(/does not run/);
  });

  it('names the confounds instead of pretending a swap is clean', () => {
    const shifted = buildReplacementVariant(
      baseDeck,
      env,
      'fixture_baseline_unit',
      'fixture_dominant_unit',
      'all',
    );
    // Different cost and different role: not a controlled comparison, and said so.
    expect(shifted.variant?.confounds.join(' ')).toMatch(/curve changed/);
    expect(shifted.variant?.confounds.join(' ')).toMatch(/role changed/);
  });

  it('refills the freed slots when a card is removed rather than swapped', () => {
    // A short deck is illegal in every format the prototype has, so "remove the
    // card" has to mean "and play more of what is left" — stated as a confound.
    const roomy = fixtureDeck('roomy', 'prototype_commander_blue', [
      ['fixture_baseline_unit', 4],
      ['prototype_scout', 4],
      ['prototype_guard', 4],
    ]);
    const removal = buildReplacementVariant(roomy, env, 'fixture_baseline_unit', null, 2);
    expect(removal.deck).not.toBeNull();
    expect(removal.deck?.cards.reduce((sum, c) => sum + c.quantity, 0)).toBe(
      env.deckFormat.deckSize,
    );
    expect(removal.deck?.cards.find((c) => c.cardId === 'fixture_baseline_unit')?.quantity).toBe(2);
    // Spread round-robin rather than piled onto whichever card sorts first.
    expect(removal.deck?.cards.find((c) => c.cardId === 'prototype_guard')?.quantity).toBe(5);
    expect(removal.deck?.cards.find((c) => c.cardId === 'prototype_scout')?.quantity).toBe(5);
    expect(removal.variant?.confounds.join(' ')).toMatch(/removed rather than swapped/);
  });

  it('reports when the freed slots cannot legally be refilled', () => {
    // Both remaining cards are already at the copy limit, so there is nowhere to
    // put the freed slots — and the experiment says so instead of shrinking.
    const maxed = fixtureDeck('maxed', 'prototype_commander_blue', [
      ['fixture_baseline_unit', 6],
      ['prototype_scout', 6],
    ]);
    const removal = buildReplacementVariant(maxed, env, 'fixture_baseline_unit', null, 'all');
    expect(removal.deck).toBeNull();
    expect(removal.reasons.join(' ')).toMatch(/cannot legally fill/);
  });

  it('finds no confound in a genuinely like-for-like swap', () => {
    expect(equivalent.variant.confounds).toEqual([]);
  });
});

describe('replacement impact', () => {
  it('pairs the two arms on the same games', () => {
    const impact = impactOf(stronger);
    expect(impact.baseMatches).toBeGreaterThan(0);
    expect(impact.variantMatches).toBe(impact.baseMatches);
    // Common random numbers: every base game has a variant twin.
    expect(impact.pairedGames).toBe(impact.baseMatches);
  });

  it('detects the deliberately stronger card', () => {
    // CLAUDE.md §13.15 item 16, positive control. `impact` is base minus
    // variant, so a strictly better replacement makes it strongly negative.
    const impact = impactOf(stronger);
    expect(impact.variantWinRate).toBeGreaterThan(impact.baseWinRate);
    expect(impact.impact).toBeLessThan(-DEFAULT_ANALYSIS_SETTINGS.replacementImpact);
    // The interval excludes zero, which is what makes it worth reporting.
    expect(impact.high).toBeLessThan(0);
    expect(impact.effectSizeLabel).not.toBe('negligible');
    expect(impact.insufficientData).toBe(false);
    // …and it does not pretend the comparison was clean: the swap changed the
    // curve, and that is carried alongside the result rather than dropped.
    expect(impact.confounds.join(' ')).toMatch(/curve changed/);
  });

  it('does not flag an equivalent card', () => {
    // Negative control. The replacement is statistically identical, and both arms
    // play the same shuffles, so the two arms play out the same way.
    const impact = impactOf(equivalent);
    expect(impact.variantWinRate).toBe(impact.baseWinRate);
    expect(impact.impact).toBe(0);
    expect(impact.effectSize).toBe(0);
    expect(impact.effectSizeLabel).toBe('negligible');

    const flags = computeFlags({
      aggregate: aggregate(records),
      clustering: clusterDecks([baseDeck, equivalent.deck, ...opponents], env.database, records),
      pairs: [],
      replacements: [impact],
      settings: DEFAULT_ANALYSIS_SETTINGS,
    });
    expect(
      flags.filter(
        (flag) => flag.reason === 'large_replacement_impact' && flag.level === 'review_recommended',
      ),
    ).toEqual([]);
  });

  it('flags the stronger card with evidence, sample size and an interval', () => {
    const impact = impactOf(stronger);
    const flags = computeFlags({
      aggregate: aggregate(records),
      clustering: clusterDecks([baseDeck, stronger.deck, ...opponents], env.database, records),
      pairs: [],
      replacements: [impact],
      settings: { ...DEFAULT_ANALYSIS_SETTINGS, minMatchesPerCard: 8 },
    });
    const flag = flags.find(
      (entry) =>
        entry.reason === 'large_replacement_impact' && entry.level === 'review_recommended',
    );
    expect(flag).toBeDefined();
    expect(flag?.subject).toBe('fixture_baseline_unit');
    expect(flag?.sampleSize).toBeGreaterThan(0);
    expect(flag?.interval).not.toBeNull();
    expect(flag?.threshold?.name).toBe('replacementImpact');
    // Never a verdict.
    expect(flag?.message).not.toMatch(/overpowered|balanced|broken/i);
  });

  it('reports the paired detail the headline numbers were taken from', () => {
    // PHASE4_HARDENING §9.1. The discordant counts are the sample the difference
    // is actually estimated from, and exclusions have to be counted rather than
    // silently folded in as though everything were independent.
    const impact = impactOf(stronger);
    const paired = impact.paired as {
      pairs: number;
      delta: number;
      low: number;
      high: number;
      candidateOnlyWins: number;
      baselineOnlyWins: number;
      concordantPairs: number;
      excludedPairs: number;
      exclusionReasons: Record<string, number>;
      method: string;
    };
    expect(paired.pairs).toBe(impact.pairedGames);
    expect(paired.delta).toBe(impact.impact);
    expect(paired.low).toBe(impact.low);
    expect(paired.high).toBe(impact.high);
    expect(paired.candidateOnlyWins + paired.baselineOnlyWins + paired.concordantPairs).toBe(
      paired.pairs,
    );
    expect(paired.excludedPairs).toBe(
      Object.values(paired.exclusionReasons).reduce((sum, value) => sum + value, 0),
    );
    expect(paired.method).toMatch(/paired/i);
  });

  it('refuses a paired estimate when too few complete pairs survive', () => {
    // The same real, strong effect judged against a pair count the fixture cannot
    // reach. It must come back as insufficient rather than as a confident number.
    const impact = replacementImpact(stronger.variant, records, records, {
      minMatches: 1,
      minPairs: 10_000,
    });
    expect(impact.pairedGames).toBeGreaterThan(0);
    expect(impact.insufficientData).toBe(true);
  });
});

describe('minimum support and uncertainty', () => {
  it('suppresses a replacement conclusion below the configured minimum', () => {
    // CLAUDE.md §13.15 item 17. The same real, strong effect, judged against a
    // sample size the run did not reach.
    const impact = impactOf(stronger, 10_000);
    expect(impact.insufficientData).toBe(true);

    const flags = computeFlags({
      aggregate: aggregate(records),
      clustering: clusterDecks([baseDeck, stronger.deck, ...opponents], env.database, records),
      pairs: [],
      replacements: [impact],
      settings: DEFAULT_ANALYSIS_SETTINGS,
    });
    const flag = flags.find((entry) => entry.reason === 'large_replacement_impact');
    // Downgraded, not dropped: "we do not know" must be visible.
    expect(flag?.level).toBe('insufficient_data');
    expect(flag?.message).toMatch(/Nothing is claimed/);
  });

  it('suppresses a card pair below the support threshold', () => {
    const withSupport = cardPairs(records, { minSupport: 1 });
    const suppressed = cardPairs(records, { minSupport: 10_000 });
    expect(withSupport.length).toBeGreaterThan(0);
    expect(suppressed).toEqual([]);

    const flags = computeFlags({
      aggregate: aggregate(records),
      clustering: clusterDecks([baseDeck, ...opponents], env.database, records),
      pairs: withSupport,
      replacements: [],
      settings: { ...DEFAULT_ANALYSIS_SETTINGS, minPairSupport: 10_000 },
    });
    expect(flags.filter((flag) => flag.reason === 'strong_card_pair')).toEqual([]);
  });

  it('reports a thin card as insufficient_data rather than saying nothing', () => {
    const summary = aggregate(records);
    const flags = computeFlags({
      aggregate: summary,
      clustering: clusterDecks([baseDeck, ...opponents], env.database, records),
      pairs: [],
      replacements: [],
      settings: { ...DEFAULT_ANALYSIS_SETTINGS, minMatchesPerCard: 10_000 },
    });
    const thin = flags.filter((flag) => flag.level === 'insufficient_data');
    expect(thin.length).toBe(summary.cards.length);
    for (const flag of thin) {
      expect(flag.threshold?.name).toBe('minMatchesPerCard');
      expect(flag.sampleSize).toBeLessThan(10_000);
    }
  });

  it('says nothing about two cards that never appear apart', () => {
    // The estimand is a difference-in-differences over four cells. Without a
    // marginal cell the contrast is *undefined*, not merely imprecise, so the
    // pair must come back as insufficient evidence rather than as a number.
    const pairs = cardPairs(records, { minSupport: 1, minCellSupport: 1 });
    const withoutMarginal = pairs.filter(
      (pair) => pair.supportAOnly === 0 || pair.supportBOnly === 0 || pair.supportNeither === 0,
    );
    expect(withoutMarginal.length).toBeGreaterThan(0);
    for (const pair of withoutMarginal) {
      expect(pair.insufficientEvidence).toBe(true);
      expect(pair.sparseCells.length).toBeGreaterThan(0);
      // No interval is invented for a contrast that could not be computed.
      expect(Number.isFinite(pair.low)).toBe(false);
      expect(Number.isFinite(pair.high)).toBe(false);
    }
  });

  it('names its estimand and keeps the descriptive lift under its own name', () => {
    const pairs = cardPairs(records, { minSupport: 1, minCellSupport: 1 });
    expect(pairs.length).toBeGreaterThan(0);
    for (const pair of pairs) {
      // `liftOverBestSingle` is the number a reader expects to see, kept but
      // labelled so it is not mistaken for the synergy estimate.
      expect(pair.liftOverBestSingle).toBeCloseTo(
        pair.winRateTogether - Math.max(pair.winRateAOnly, pair.winRateBOnly),
        6,
      );
      // `interaction` is the estimand: what the second card adds on top of the
      // first, minus what it adds alone.
      expect(pair.interaction).toBeCloseTo(
        pair.winRateTogether - pair.winRateAOnly - (pair.winRateBOnly - pair.winRateNeither),
        6,
      );
      expect(pair.estimand).toMatch(/not a causal effect/i);
    }
  });

  it('propagates every contributing cell into the interval, not just "both"', () => {
    const pairs = cardPairs(records, { minSupport: 1, minCellSupport: 1, iterations: 400 });
    const estimable = pairs.filter((pair) => !pair.insufficientEvidence);
    // Nothing to assert if this fixture happens to have no four-cell pair; the
    // dedicated synthetic fixture in the hardening suite covers that case.
    for (const pair of estimable) {
      expect(Number.isFinite(pair.low)).toBe(true);
      expect(Number.isFinite(pair.high)).toBe(true);
      expect(pair.high).toBeGreaterThanOrEqual(pair.low);
      expect(pair.strata).toBeGreaterThan(0);
    }
  });
});

describe('flags', () => {
  it('never uses a verdict label', () => {
    expect(FLAG_LEVELS).not.toContain('overpowered');
    expect(FLAG_LEVELS).not.toContain('balanced');
  });

  it('always carries a reason code, evidence and a sample size', () => {
    const flags = computeFlags({
      aggregate: aggregate(records),
      clustering: clusterDecks([baseDeck, stronger.deck, ...opponents], env.database, records),
      pairs: cardPairs(records, { minSupport: 1 }),
      replacements: [impactOf(stronger)],
      settings: { ...DEFAULT_ANALYSIS_SETTINGS, minMatchesPerCard: 8, minPairSupport: 4 },
    });
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of flags) {
      expect(FLAG_LEVELS).toContain(flag.level);
      expect(flag.reason.length).toBeGreaterThan(0);
      expect(Object.keys(flag.evidence).length).toBeGreaterThan(0);
      expect(flag.sampleSize).toBeGreaterThanOrEqual(0);
      expect(flag.message).not.toMatch(/\boverpowered\b|\bbalanced\b/i);
    }
  });

  it('is deterministically ordered', () => {
    const inputs = {
      aggregate: aggregate(records),
      clustering: clusterDecks([baseDeck, stronger.deck, ...opponents], env.database, records),
      pairs: cardPairs(records, { minSupport: 1 }),
      replacements: [impactOf(stronger)],
      settings: DEFAULT_ANALYSIS_SETTINGS,
    };
    expect(JSON.stringify(computeFlags(inputs))).toBe(JSON.stringify(computeFlags(inputs)));
  });

  it('does not call a single deck a strategy', () => {
    const clustering = clusterDecks([baseDeck], env.database, records);
    const flags = computeFlags({
      aggregate: aggregate(records),
      clustering,
      pairs: [],
      replacements: [],
      settings: DEFAULT_ANALYSIS_SETTINGS,
    });
    expect(flags.filter((flag) => flag.reason === 'no_unfavourable_context')).toEqual([]);
    expect(flags.filter((flag) => flag.reason === 'single_narrow_counter')).toEqual([]);
  });
});

describe('aggregate', () => {
  it('validates against its schema and reconciles with the raw records', () => {
    const summary = aggregate(records);
    expect(() => aggregateSchema.parse(summary)).not.toThrow();
    expect(summary.run.matches).toBe(records.length);
    expect(summary.run.usableMatches).toBe(usableRecords(records).length);
    // Every deck that played appears exactly once.
    const hashes = new Set(records.flatMap((r) => r.seats.map((seat) => seat.deckHash)));
    expect(new Set(summary.decks.map((deck) => deck.deckHash))).toEqual(hashes);
  });

  it('is independent of record order', () => {
    expect(JSON.stringify(aggregate([...records].reverse()))).toBe(
      JSON.stringify(aggregate(records)),
    );
    expect(inOrder([...records].reverse()).map((r) => r.matchId)).toEqual(
      records.map((r) => r.matchId),
    );
  });

  it('excludes abnormal matches from the usable set but still counts them', () => {
    const summary = aggregate(records);
    expect(summary.run.usableMatches + summary.run.abnormalMatches).toBe(summary.run.matches);
  });
});

describe('clustering', () => {
  it('produces an inspectable feature vector per deck', () => {
    const features = featuresOf(baseDeck, env.database);
    expect(features.deckHash).toBe(baseDeck.hash);
    for (const name of FEATURE_NAMES) {
      expect(typeof features.features[name]).toBe('number');
    }
    // Every card is a unit, so the unit share is one.
    expect(features.features.type_unit).toBeCloseTo(1, 6);
  });

  it('groups mechanically similar decks and labels them readably', () => {
    const population = generatePopulation(env, 'cluster-pop', 6).decks;
    const clustering = clusterDecks(population, env.database, records);
    expect(clustering.clusters.length).toBeGreaterThan(0);
    expect(clustering.features).toHaveLength(population.length);
    for (const cluster of clustering.clusters) {
      expect(cluster.label.length).toBeGreaterThan(0);
      // Labels describe mechanics, never a made-up archetype name.
      expect(cluster.label).toMatch(/curve|heavy|units|spells|relics|colourless|[a-z]/);
    }
    const clustered = clustering.clusters.reduce((sum, c) => sum + c.deckHashes.length, 0);
    expect(clustered).toBe(population.length);
  });

  it('is deterministic', () => {
    const population = generatePopulation(env, 'cluster-pop', 6).decks;
    expect(JSON.stringify(clusterDecks(population, env.database, records))).toBe(
      JSON.stringify(clusterDecks([...population].reverse(), env.database, records)),
    );
  });
});

describe('statistics', () => {
  it('produces a Wilson interval that contains the point estimate', () => {
    for (const [successes, total] of [
      [0, 10],
      [5, 10],
      [10, 10],
      [1, 3],
      [97, 100],
    ] as const) {
      const estimate = proportion(successes, total);
      expect(estimate.low).toBeLessThanOrEqual(estimate.point);
      expect(estimate.high).toBeGreaterThanOrEqual(estimate.point);
      expect(estimate.low).toBeGreaterThanOrEqual(0);
      expect(estimate.high).toBeLessThanOrEqual(1);
    }
  });

  it('widens the interval as the sample shrinks', () => {
    const wide = proportion(3, 6);
    const narrow = proportion(300, 600);
    expect(wide.high - wide.low).toBeGreaterThan(narrow.high - narrow.low);
  });

  it('reports no information for an empty sample rather than a confident zero', () => {
    const empty = proportion(0, 0);
    expect(empty.low).toBe(0);
    expect(empty.high).toBe(1);
  });

  it('gives a difference interval that spans zero when there is no difference', () => {
    const same = proportionDifference({ successes: 5, total: 10 }, { successes: 5, total: 10 });
    expect(same.point).toBe(0);
    expect(same.low).toBeLessThanOrEqual(0);
    expect(same.high).toBeGreaterThanOrEqual(0);
  });

  it('reports effect size independently of sample size', () => {
    expect(cohensH(0.5, 0.5)).toBe(0);
    expect(Math.abs(cohensH(0.9, 0.5))).toBeGreaterThan(Math.abs(cohensH(0.55, 0.5)));
  });

  it('normalises entropy to [0, 1]', () => {
    expect(normalizedEntropy([1, 1, 1, 1])).toBeCloseTo(1, 6);
    expect(normalizedEntropy([10, 0, 0, 0])).toBeCloseTo(0, 6);
    expect(normalizedEntropy([])).toBe(0);
    expect(round(normalizedEntropy([3, 1]), 3)).toBeGreaterThan(0);
  });
});
