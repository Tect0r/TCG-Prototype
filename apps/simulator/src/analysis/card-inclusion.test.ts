import { beforeAll, describe, expect, it } from 'vitest';
import type { CardDefinitionInput } from '@tcg/card-data';
import { poolReportFor } from '@tcg/deck-generator';
import { aggregate, usableRecords } from './aggregate.js';
import { SUMMARY_SCHEMA_VERSION } from '../experiment.js';
import { runBatch } from '../run-batch.js';
import { buildSchedule } from '../schedule.js';
import type { MatchRecord } from '../telemetry/schema.js';
import type { Environment } from '../environment.js';
import {
  FAST_LIMITS,
  NO_RETENTION,
  VALUE_PILOT,
  fixtureDeck,
  tinyEnvironment,
} from '../test-fixtures.js';

/**
 * M08.12 — card-inclusion integrity.
 *
 * Two defects, both fixed here:
 *
 * - **Zero observations are not a zero win rate.** A card nobody ever left out
 *   (`fixture_universal_unit`, present in every deck below) has an empty
 *   "absent" comparison group; a card whose only would-be excluders are
 *   colour-ineligible has an empty group for a different reason. Either way
 *   the lift is `insufficient_data` (`null`), never a fabricated difference.
 * - **The inclusion denominator is eligibility-aware.** `fixture_blue_only_unit`
 *   is legal only under a blue Commander, so a red-Commander deck that never
 *   ran it is not "choosing" to exclude it and must not count on either side of
 *   the contrast.
 *
 * The population deliberately mixes two Commanders with different legal pools
 * (the "mixed-source" acceptance case) so eligibility has to be computed per
 * Commander rather than assumed uniform across the run.
 */

const BLUE_ONLY: CardDefinitionInput = {
  schemaVersion: 2,
  id: 'fixture_blue_only_unit',
  name: 'Fixture Blue-Only Unit',
  type: 'unit',
  colorIdentity: ['blue'],
  cost: 2,
  attack: 2,
  health: 2,
  role: 'attacker',
  powerClass: 'standard',
  tags: ['fixture'],
  displayText: 'Legal only under a blue Commander.',
};

const UNIVERSAL: CardDefinitionInput = {
  schemaVersion: 2,
  id: 'fixture_universal_unit',
  name: 'Fixture Universal Unit',
  type: 'unit',
  colorIdentity: [],
  cost: 1,
  attack: 1,
  health: 1,
  role: 'support',
  powerClass: 'minor',
  tags: ['fixture'],
  displayText: 'In every deck this run plays.',
};

/** Eligible under every Commander this run seats, and run by none of them. */
const NEVER_RUN: CardDefinitionInput = {
  schemaVersion: 2,
  id: 'fixture_never_run_unit',
  name: 'Fixture Never-Run Unit',
  type: 'unit',
  colorIdentity: [],
  cost: 3,
  attack: 1,
  health: 1,
  role: 'support',
  powerClass: 'minor',
  tags: ['fixture'],
  displayText: 'Legal everywhere in this run, chosen nowhere.',
};

const env: Environment = tinyEnvironment({
  id: 'card_inclusion',
  deckSize: 12,
  copyLimit: 2,
  cardOverrides: [BLUE_ONLY, UNIVERSAL, NEVER_RUN],
});

const FILLER: readonly [string, number][] = [
  ['prototype_drone', 2],
  ['prototype_scout', 2],
  ['prototype_guard', 2],
  ['trench_guard', 2],
];

/** Blue Commander, runs the blue-only card. */
const blueWithCard = fixtureDeck('blue_with_card', 'prototype_commander_blue', [
  ['fixture_universal_unit', 2],
  ['fixture_blue_only_unit', 2],
  ...FILLER,
]);

/** Same Commander, same eligibility, chose not to run it. */
const blueWithoutCard = fixtureDeck('blue_without_card', 'prototype_commander_blue', [
  ['fixture_universal_unit', 2],
  ['unstable_construct', 2],
  ...FILLER,
]);

/** A different Commander that can never legally run the blue-only card. */
const redDeck = fixtureDeck('red_deck', 'prototype_commander_red', [
  ['fixture_universal_unit', 2],
  ['energy_font', 2],
  ...FILLER,
]);

let records: readonly MatchRecord[];

beforeAll(async () => {
  const decks = [blueWithCard, blueWithoutCard, redDeck];
  const schedule = buildSchedule({
    experimentId: 'card-inclusion',
    experimentSeed: 'card-inclusion-seed',
    environmentId: env.id,
    decks,
    pilots: [VALUE_PILOT],
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: 4,
    mirrorSeats: true,
    schedule: 'round_robin',
    sampledPairings: 10_000,
  });

  const outcome = await runBatch({
    experimentId: 'card-inclusion',
    experimentKind: 'batch',
    configHash: 'card-inclusion-test',
    arm: null,
    environment: env,
    decks,
    pilots: [VALUE_PILOT],
    schedule,
    limits: FAST_LIMITS,
    retention: NO_RETENTION,
    workers: 1,
    failFast: false,
    sink: null,
    softwareCommit: null,
  });
  records = outcome.records;
}, 120_000);

describe('card-inclusion integrity (M08.12)', () => {
  it('reports SUMMARY_SCHEMA_VERSION 8', () => {
    expect(SUMMARY_SCHEMA_VERSION).toBe(8);
  });

  it('universal-card: a card nobody ever left out has no contrast to report', () => {
    const summary = aggregate(records, { environment: env });
    const card = summary.cards.find((entry) => entry.definitionId === 'fixture_universal_unit');
    expect(card).toBeDefined();
    expect(card?.winRateWhenAbsent.total).toBe(0);
    expect(card?.winRateWhenIncluded.total).toBeGreaterThan(0);
    expect(card?.inclusionWinRateLift).toBeNull();
  });

  it('absent-card: a card no deck ever ran produces no fabricated row', () => {
    // `everSeen`/`tallies` in `summarizeCards` are built from decks that
    // actually included a card, so a card legal everywhere and chosen nowhere
    // cannot produce a `CardSummary` row at all — there is no deck-level
    // signal to attach one to. That absence is the correct behaviour: a
    // fabricated row with a 0% "included" rate would be exactly the invented
    // number this tranche exists to refuse. This is the "card present in
    // none" half of the milestone's result rule, asserted structurally
    // because it cannot be asserted as a row.
    const summary = aggregate(records, { environment: env });
    expect(
      summary.cards.find((entry) => entry.definitionId === 'fixture_never_run_unit'),
    ).toBeUndefined();
  });

  it('colour-ineligible-card: an ineligible deck never counts on either side', () => {
    const summary = aggregate(records, { environment: env });
    const card = summary.cards.find((entry) => entry.definitionId === 'fixture_blue_only_unit');
    expect(card).toBeDefined();
    if (!card) return;

    expect(card.decksIncluding).toBe(1);
    // Eligible: the two blue decks. The red deck could never run it.
    expect(card.eligibleDecks).toBe(2);
    expect(card.inclusionAmongEligibleShare).toBeCloseTo(0.5, 6);

    // The "absent" group is exactly blueWithoutCard's own seat-matches — never
    // the red deck's, which is ineligible rather than excluding.
    const blueWithoutSeatMatches = usableRecords(records).reduce(
      (sum, record) =>
        sum + record.seats.filter((seat) => seat.deckHash === blueWithoutCard.hash).length,
      0,
    );
    expect(card.winRateWhenAbsent.total).toBe(blueWithoutSeatMatches);

    const blue = card.perCommander.find(
      (entry) => entry.commanderId === 'prototype_commander_blue',
    );
    const red = card.perCommander.find((entry) => entry.commanderId === 'prototype_commander_red');
    expect(blue).toMatchObject({ eligible: true, decksUnderCommander: 2, decksIncluding: 1 });
    expect(red).toMatchObject({
      eligible: false,
      decksUnderCommander: 1,
      decksIncluding: 0,
      legalPoolSize: null,
      forcedInclusionFloor: null,
    });
  });

  it('forced-inclusion: the floor matches poolReportFor, read rather than recomputed', () => {
    const summary = aggregate(records, { environment: env });
    const card = summary.cards.find((entry) => entry.definitionId === 'fixture_blue_only_unit');
    const blue = card?.perCommander.find(
      (entry) => entry.commanderId === 'prototype_commander_blue',
    );
    expect(blue).toBeDefined();

    const commander = env.database.getOrThrow('prototype_commander_blue');
    const report = poolReportFor(env, commander);
    expect(blue?.legalPoolSize).toBe(report.legalPoolSize);
    expect(blue?.forcedInclusionFloor).toBe(report.forcedInclusionFloor);
  });

  it('mixed-source: eligibility is computed per Commander across a mixed population', () => {
    const summary = aggregate(records, { environment: env });
    const universal = summary.cards.find(
      (entry) => entry.definitionId === 'fixture_universal_unit',
    );
    expect(universal).toBeDefined();
    // Legal under both Commanders in this run, so eligibility spans all three decks.
    expect(universal?.eligibleDecks).toBe(3);
    expect(universal?.perCommander).toHaveLength(2);
    for (const entry of universal?.perCommander ?? []) {
      expect(entry.eligible).toBe(true);
    }
  });

  it('regeneration: re-aggregating the same raw records is deterministic', () => {
    const first = aggregate(records, { environment: env });
    const second = aggregate([...records].reverse(), { environment: env });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('omits eligibility when no environment is supplied, rather than guessing', () => {
    const summary = aggregate(records);
    const card = summary.cards.find((entry) => entry.definitionId === 'fixture_blue_only_unit');
    expect(card?.eligibleDecks).toBeNull();
    expect(card?.inclusionAmongEligibleShare).toBeNull();
    expect(card?.perCommander).toEqual([]);
  });
});
