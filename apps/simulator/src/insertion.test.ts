import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildInsertionVariant,
  insertionRemovalCandidates,
  replacementImpact,
  type ReplacementVariant,
} from './analysis/replacement.js';
import type { ReplacementImpact } from './analysis/replacement.js';
import { computeFlags } from './analysis/flags.js';
import { aggregate } from './analysis/aggregate.js';
import { aggregateBoard } from './analysis/board.js';
import { analyzeMechanicSupport } from './analysis/support.js';
import { analyzeAgentClasses } from './analysis/agent-classes.js';
import { analyzeDeckConstruction } from './analysis/construction.js';
import { clusterDecks, type ClusteringResult } from './analysis/clusters.js';
import { analyzeInclusion } from './analysis/inclusion.js';
import { ANALYSIS_STATS_VERSION, describeMultiplicity } from './analysis/paired.js';
import { DEFAULT_ANALYSIS_SETTINGS } from './config.js';
import { runBatch } from './run-batch.js';
import { buildSchedule } from './schedule.js';
import { SEED_DERIVATION_VERSION } from './seed.js';
import type { SimDeck } from './deck-search/deck.js';
import type { Environment } from './environment.js';
import { TELEMETRY_SCHEMA_VERSION, type MatchRecord } from './telemetry/schema.js';
import { renderReport, type ReportInputs } from './reporting/report.js';
import {
  FAST_LIMITS,
  FIXTURE_UNIQUE_UNIT,
  NO_RETENTION,
  VALUE_PILOT,
  fixtureDeck,
  tinyEnvironment,
} from './test-fixtures.js';

/**
 * Readiness §3 A1: genuine insertion experiments.
 *
 * The removal arm can only ever measure cards some deck already runs. A new card
 * — and every build-around — needs the other direction: put the card in, pay for
 * the slots with comparable cards, hold the deck size, and replay the same
 * seeded games. These tests check the construction, the metadata, the paired
 * estimate, the sign convention and the report wording.
 */

const env: Environment = tinyEnvironment({ id: 'insertion', copyLimit: 6 });

/** A deck that deliberately does *not* run the subject card. */
const baseDeck = fixtureDeck('insertion_base', 'prototype_commander_blue', [
  ['fixture_baseline_unit', 6],
  ['prototype_scout', 6],
]);

/** A deck sharing no tag with the fixture cards, for the build-around checks. */
const unrelatedDeck = fixtureDeck('unrelated', 'prototype_commander_blue', [
  ['prototype_guard', 6],
  ['prototype_scout', 6],
]);

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

function insert(
  deck: SimDeck,
  cardId: string,
  copies: number | 'all',
  removeCardIds?: readonly string[],
): { deck: SimDeck | null; variant: ReplacementVariant | null; reasons: readonly string[] } {
  return buildInsertionVariant(deck, env, cardId, copies, removeCardIds ? { removeCardIds } : {});
}

/* ------------------------------------------------------------- construction */

describe('buildInsertionVariant', () => {
  it('inserts into a legal deck and holds the deck size', () => {
    const built = insert(baseDeck, 'fixture_dominant_unit', 2);
    expect(built.deck).not.toBeNull();
    const total = built.deck?.cards.reduce((sum, entry) => sum + entry.quantity, 0);
    expect(total).toBe(baseDeck.cards.reduce((sum, entry) => sum + entry.quantity, 0));
    expect(built.deck?.cards.find((c) => c.cardId === 'fixture_dominant_unit')?.quantity).toBe(2);
    expect(built.variant?.direction).toBe('insertion');
    expect(built.variant?.subjectPresentIn).toBe('variant');
  });

  it('supports multi-copy insertion up to the ordinary copy limit', () => {
    const built = insert(baseDeck, 'fixture_dominant_unit', 'all');
    // `all` fills to the format's copy limit, which this environment raises to 6.
    expect(built.variant?.copiesChanged).toBe(6);
    expect(built.deck?.cards.find((c) => c.cardId === 'fixture_dominant_unit')?.quantity).toBe(6);
    expect(built.deck?.cards.reduce((sum, entry) => sum + entry.quantity, 0)).toBe(
      env.deckFormat.deckSize,
    );
  });

  it('honours the unique copy limit rather than the ordinary one', () => {
    const uniqueEnv = tinyEnvironment({
      id: 'insertion_unique',
      copyLimit: 6,
      cardOverrides: [FIXTURE_UNIQUE_UNIT],
    });
    const one = buildInsertionVariant(baseDeck, uniqueEnv, 'fixture_unique_unit', 'all', {});
    expect(one.variant?.copiesChanged).toBe(1);

    const two = buildInsertionVariant(baseDeck, uniqueEnv, 'fixture_unique_unit', 2, {});
    expect(two.deck).toBeNull();
    expect(two.reasons.join(' ')).toMatch(/over the limit of 1/);
  });

  it('refuses when the deck already runs the card at the copy limit', () => {
    const full = fixtureDeck('full', 'prototype_commander_blue', [
      ['fixture_dominant_unit', 6],
      ['prototype_scout', 6],
    ]);
    const built = insert(full, 'fixture_dominant_unit', 'all');
    expect(built.deck).toBeNull();
    expect(built.reasons.join(' ')).toMatch(/already runs 6 copies/);
  });

  it('refuses rather than repairs when no legal removal candidate can pay', () => {
    const built = insert(baseDeck, 'fixture_dominant_unit', 4, ['prototype_drone']);
    expect(built.deck).toBeNull();
    expect(built.reasons.join(' ')).toMatch(/does not run prototype_drone/);

    const thin = fixtureDeck('thin', 'prototype_commander_blue', [
      ['prototype_guard', 11],
      ['prototype_drone', 1],
    ]);
    const short = buildInsertionVariant(thin, env, 'fixture_dominant_unit', 4, {
      removeCardIds: ['prototype_drone'],
    });
    expect(short.deck).toBeNull();
    expect(short.reasons.join(' ')).toMatch(/supply only 1 of the 4 slot/);
  });

  it('refuses a card the deck s Commander could not legally run', () => {
    // `crimson_covenant` is black/red; the base deck's Commander is mono-blue.
    const colored = tinyEnvironment({
      id: 'insertion_colors',
      copyLimit: 6,
      extraCardIds: ['crimson_covenant'],
    });
    const built = buildInsertionVariant(baseDeck, colored, 'crimson_covenant', 1, {});
    expect(built.deck).toBeNull();
    expect(built.reasons.join(' ')).toMatch(/not legal under/);
  });

  it('refuses a card the environment does not make playable', () => {
    // In the database, but banned from this environment's pool.
    const built = insert(baseDeck, 'dread_sovereign', 1);
    expect(built.deck).toBeNull();
    expect(built.reasons.join(' ')).toMatch(/not in this environment's playable pool/);
  });

  it('cuts comparable cards first and records every one of them', () => {
    // The subject is a 1-cost unit, so the deck's 1-cost unit outranks its 2-cost
    // one as the thing to cut.
    // The subject shares the `fixture` tag with the baseline unit, which puts it
    // ahead of the scout as the thing to cut.
    const ranked = insertionRemovalCandidates(baseDeck, env, 'fixture_dominant_unit');
    expect(ranked[0]?.cardId).toBe('fixture_baseline_unit');

    const built = insert(baseDeck, 'fixture_dominant_unit', 2);
    // Round-robin down the ranking: one copy from each of the two candidates,
    // rather than deleting whichever card sorts first.
    expect(built.variant?.removedCards).toEqual([
      { cardId: 'fixture_baseline_unit', quantity: 1 },
      { cardId: 'prototype_scout', quantity: 1 },
    ]);
    expect(built.variant?.addedCards).toEqual([{ cardId: 'fixture_dominant_unit', quantity: 2 }]);
    expect(built.variant?.selectionMethod).toBe('comparable_cards_round_robin');
    expect(built.variant?.legal).toBe(true);
    expect(built.variant?.baseDeckHash).toBe(baseDeck.hash);
    expect(built.variant?.variantDeckHash).toBe(built.deck?.hash);
  });

  it('honours an explicitly declared removal list', () => {
    const built = insert(baseDeck, 'fixture_dominant_unit', 2, ['prototype_scout']);
    expect(built.variant?.removedCards).toEqual([{ cardId: 'prototype_scout', quantity: 2 }]);
    expect(built.variant?.selectionMethod).toBe('explicit_removal_cards');
  });

  it('keeps build-around context visible instead of implying the card is weak', () => {
    const built = insert(unrelatedDeck, 'fixture_combo_payoff', 2);
    const confounds = built.variant?.confounds.join(' ') ?? '';
    expect(confounds).toMatch(/inserted rather than swapped in place/);
    // The deck contains no `combo` or `fixture` card, so this measures the payoff
    // with none of its support — a stress test, and said so.
    expect(confounds).toMatch(/stress\/control experiment/);
  });

  it('says an inserted centerpiece is being measured at its floor', () => {
    const built = insert(baseDeck, 'fixture_dominant_unit', 1);
    expect(built.variant?.confounds.join(' ')).toMatch(/measures the floor rather than the card/);
  });
});

/* ----------------------------------------------------------- paired analysis */

const inserted = insert(baseDeck, 'fixture_dominant_unit', 'all');
const variantDeck = inserted.deck as SimDeck;
const variant = inserted.variant as ReplacementVariant;

let records: readonly MatchRecord[];
let parallelRecords: readonly MatchRecord[];

async function play(workers: number): Promise<readonly MatchRecord[]> {
  const armDecks = [baseDeck, variantDeck];
  const decks = [...armDecks, ...opponents];

  const schedule = buildSchedule({
    experimentId: 'insertion',
    experimentSeed: 'insertion-seed',
    environmentId: env.id,
    decks,
    pilots: [VALUE_PILOT],
    pilotPairing: 'mirror',
    playerCount: 2,
    // Enough paired games for the bootstrap interval to have something to say.
    // At four games the estimate is correctly reported as inconclusive, which is
    // exercised deliberately in its own test below.
    gamesPerPairing: 16,
    mirrorSeats: true,
    schedule: 'round_robin',
    sampledPairings: 10_000,
    // Common random numbers: the base arm and the insertion arm meet the same
    // opponents on the same shuffles, so the inserted card is the only difference.
    seedIgnoreDeckHashes: armDecks.map((deck) => deck.hash),
  });

  const armHashes = new Set(armDecks.map((deck) => deck.hash));
  const fieldHashes = new Set(opponents.map((deck) => deck.hash));
  const relevant = schedule.filter((match) => {
    const hashes = match.seats.map((seat) => decks[seat.deckIndex]?.hash ?? '');
    return hashes.some((h) => armHashes.has(h)) && hashes.some((h) => fieldHashes.has(h));
  });

  const outcome = await runBatch({
    experimentId: 'insertion',
    experimentKind: 'replacement',
    configHash: 'insertion-test',
    arm: null,
    environment: env,
    decks,
    pilots: [VALUE_PILOT],
    schedule: relevant,
    limits: FAST_LIMITS,
    retention: NO_RETENTION,
    workers,
    failFast: false,
    sink: null,
    softwareCommit: null,
  });
  return outcome.records;
}

beforeAll(async () => {
  records = await play(1);
  parallelRecords = await play(2);
}, 240_000);

describe('insertion impact', () => {
  it('generates a paired estimate on an identical common-seed schedule', () => {
    const impact = replacementImpact(variant, records, records, { minMatches: 10, minPairs: 8 });
    expect(impact.baseMatches).toBeGreaterThan(0);
    expect(impact.variantMatches).toBe(impact.baseMatches);
    // Every base game has an insertion twin, which is what the shared seeds buy.
    expect(impact.pairedGames).toBe(impact.baseMatches);
    expect(impact.direction).toBe('insertion');
  });

  it('reports the subject s contribution with the same sign as a removal test', () => {
    const impact = replacementImpact(variant, records, records, { minMatches: 10, minPairs: 8 });
    // A one-cost 9/9 with Swift, inserted into a deck of 2/2s. "With the card"
    // must come out ahead of "without it", exactly as removing it from a deck
    // that ran it would come out behind.
    expect(impact.variantWinRate).toBeGreaterThan(impact.baseWinRate);
    expect(impact.impact).toBeGreaterThan(DEFAULT_ANALYSIS_SETTINGS.replacementImpact);
    expect(impact.insufficientData).toBe(false);
  });

  it('carries the variant metadata through to the impact record', () => {
    const impact = replacementImpact(variant, records, records, { minMatches: 10, minPairs: 8 });
    expect(impact.subjectCardId).toBe('fixture_dominant_unit');
    expect(impact.selectionMethod).toBe('comparable_cards_round_robin');
    expect(impact.removedCards.reduce((sum, entry) => sum + entry.quantity, 0)).toBe(
      variant.copiesChanged,
    );
    expect(impact.addedCards).toEqual([{ cardId: 'fixture_dominant_unit', quantity: 6 }]);
    expect(impact.confounds.length).toBeGreaterThan(0);
  });

  it('is identical at one worker and at two', () => {
    const one = replacementImpact(variant, records, records, { minMatches: 10, minPairs: 8 });
    const two = replacementImpact(variant, parallelRecords, parallelRecords, {
      minMatches: 10,
      minPairs: 8,
    });
    expect(two.impact).toBe(one.impact);
    expect(two.low).toBe(one.low);
    expect(two.high).toBe(one.high);
    expect(two.pairedGames).toBe(one.pairedGames);

    const sortById = (list: readonly MatchRecord[]): string[] =>
      list.map((record) => `${record.matchId}:${record.winnerId ?? 'draw'}:${record.turns}`).sort();
    expect(sortById(parallelRecords)).toEqual(sortById(records));
  });

  it('flags the insertion in the same evidence-backed shape as a removal', () => {
    const impact = replacementImpact(variant, records, records, { minMatches: 10, minPairs: 8 });
    const flags = computeFlags({
      settings,
      aggregate: aggregate(records),
      clustering: clustering(),
      pairs: [],
      replacements: [impact],
    });
    const flag = flags.find((entry) => entry.reason === 'large_replacement_impact');
    expect(flag?.level).toBe('review_recommended');
    expect(flag?.message).toMatch(/^Inserting fixture_dominant_unit in place of/);
    // Never a verdict — the flag stays review guidance with its evidence attached.
    expect(flag?.message).not.toMatch(/overpowered|balanced/i);
  });

  it('suppresses the conclusion when the pairing is too small to support it', () => {
    // Same games, a minimum the sample cannot meet. The estimate still exists;
    // the *claim* is withdrawn, and the flag says so rather than going quiet.
    const impact = replacementImpact(variant, records, records, { minMatches: 10, minPairs: 500 });
    expect(impact.insufficientData).toBe(true);
    const flags = computeFlags({
      settings,
      aggregate: aggregate(records),
      clustering: clustering(),
      pairs: [],
      replacements: [impact],
    });
    const flag = flags.find((entry) => entry.reason === 'large_replacement_impact');
    expect(flag?.level).toBe('insufficient_data');
    expect(flag?.message).toMatch(/insertion test for fixture_dominant_unit/);
  });

  it('describes both directions distinctly in the written report', () => {
    const impact = replacementImpact(variant, records, records, { minMatches: 10, minPairs: 8 });
    const report = renderReport(reportInputsFor([impact]));
    expect(report).toMatch(/## Controlled replacement and insertion/);
    expect(report).toMatch(/\| `fixture_dominant_unit` \| insertion \|/);
    expect(report).toMatch(/inserting `fixture_dominant_unit` is \*\*not a clean comparison\*\*/);
    // The removal column shows what actually paid for the slots.
    expect(report).toMatch(/3× `prototype_scout`/);
  });
});

const settings = { ...DEFAULT_ANALYSIS_SETTINGS, minMatchesPerCard: 10, minPairedGames: 8 };
const allDecks = [baseDeck, variantDeck, ...opponents];

function clustering(): ClusteringResult {
  return clusterDecks(allDecks, env.database, records);
}

/** Real report inputs; only the replacement section is under test here. */
function reportInputsFor(replacements: readonly ReplacementImpact[]): ReportInputs {
  const summary = aggregate(records);
  const clusters = clustering();
  return {
    title: 'Insertion fixture',
    experimentId: 'insertion',
    kind: 'replacement',
    seed: 'insertion-seed',
    configHash: 'insertion-test',
    softwareCommit: null,
    rulesVersion: env.rulesConfig.version,
    seedDerivationVersion: SEED_DERIVATION_VERSION,
    telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
    analysisStatsVersion: ANALYSIS_STATS_VERSION,
    environmentSummaries: [
      { id: env.id, hash: env.hash, cardPoolHash: env.cardPoolHash, label: env.label },
    ],
    settings,
    aggregate: summary,
    board: aggregateBoard(records),
    mechanicSupport: analyzeMechanicSupport({
      decks: allDecks,
      database: env.database,
      pilotIds: ['value'],
    }),
    agentClasses: analyzeAgentClasses({ pilotIds: ['value'] }),
    deckConstruction: analyzeDeckConstruction(allDecks),
    clustering: clusters,
    inclusion: analyzeInclusion(allDecks, clusters, records, settings),
    pairs: [],
    replacements,
    sensitivity: [],
    displacement: [],
    multiplicity: describeMultiplicity(replacements.length, 0, 0.05),
    flags: [],
    matchesPath: 'matches.jsonl',
    resumedMatches: 0,
    recoveredLines: 0,
    failedMatches: 0,
    abnormalMatches: [],
    deckCount: allDecks.length,
    pilots: [{ id: 'value', version: '1' }],
    wallClockMs: 0,
    workers: 1,
  };
}
