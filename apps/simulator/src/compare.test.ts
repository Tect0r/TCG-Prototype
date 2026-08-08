import { beforeAll, describe, expect, it } from 'vitest';
import type { CardDefinitionInput } from '@tcg/card-data';
import { compareEnvironments, comparisonReportSchema } from './analysis/compare.js';
import { diffEnvironments, resolveEnvironment, type Environment } from './environment.js';
import { runBatch } from './run-batch.js';
import { buildSchedule } from './schedule.js';
import type { MatchRecord } from './telemetry/schema.js';
import {
  FAST_LIMITS,
  FIXTURE_CARDS,
  NO_RETENTION,
  VALUE_PILOT,
  fixtureDeck,
  tinyEnvironment,
} from './test-fixtures.js';

/**
 * CLAUDE.md §13.12 and §13.15 item 18: common-seed pairing is correct and the
 * environment diff is complete.
 */

/**
 * The one thing that differs: in the candidate, the baseline unit is cheaper and
 * far larger.
 *
 * A cost reduction is deliberately chosen over a pure statline buff. A bigger
 * body is something a heuristic pilot can misplay — it values the unit more and
 * becomes reluctant to trade it — so a stat change can move a win rate in either
 * direction and would make this fixture measure the pilot. A card that lands a
 * turn earlier is exploited by every pilot that can afford it.
 */
const BUFFED: CardDefinitionInput = {
  ...(FIXTURE_CARDS.find((card) => card.id === 'fixture_baseline_unit') as CardDefinitionInput),
  cost: 1,
  attack: 9,
  health: 9,
  keywords: ['swift'],
};

/**
 * Twenty-four cards rather than twelve: at twelve, a match is decided by running
 * out of deck long before the board matters, and no card change could show up.
 */
const format = { copyLimit: 12, deckSize: 24 } as const;
const baselineEnv: Environment = tinyEnvironment({ id: 'baseline', ...format });
const candidateEnv: Environment = tinyEnvironment({
  id: 'candidate',
  ...format,
  cardOverrides: [BUFFED],
});

const referenceDecks = [
  fixtureDeck('runs_subject', 'prototype_commander_blue', [
    ['fixture_baseline_unit', 12],
    ['prototype_scout', 12],
  ]),
  fixtureDeck('no_subject', 'prototype_commander_blue', [
    ['fixture_equivalent_unit', 12],
    ['prototype_scout', 12],
  ]),
  fixtureDeck('scouts', 'prototype_commander_blue', [
    ['prototype_scout', 12],
    ['prototype_drone', 12],
  ]),
];

async function runArm(environment: Environment): Promise<readonly MatchRecord[]> {
  const schedule = buildSchedule({
    experimentId: 'comparison',
    experimentSeed: 'comparison-seed',
    environmentId: environment.id,
    decks: referenceDecks,
    pilots: [VALUE_PILOT],
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: 4,
    mirrorSeats: true,
    schedule: 'round_robin',
    sampledPairings: 10_000,
    // Common random numbers: the seed path deliberately omits the environment.
    pairedSeeds: true,
  });
  const outcome = await runBatch({
    experimentId: 'comparison',
    environment,
    decks: referenceDecks,
    pilots: [VALUE_PILOT],
    schedule,
    limits: FAST_LIMITS,
    retention: NO_RETENTION,
    workers: 1,
    failFast: false,
    outputDir: null,
    softwareCommit: null,
  });
  return outcome.records;
}

let baselineRecords: readonly MatchRecord[];
let candidateRecords: readonly MatchRecord[];

beforeAll(async () => {
  baselineRecords = await runArm(baselineEnv);
  candidateRecords = await runArm(candidateEnv);
}, 120_000);

describe('environment diff', () => {
  it('names exactly what changed, and which fields', () => {
    const diff = diffEnvironments(baselineEnv, candidateEnv);
    expect(diff.identical).toBe(false);
    expect(diff.cardsAdded).toEqual([]);
    expect(diff.cardsRemoved).toEqual([]);
    expect(diff.cardsChanged).toHaveLength(1);
    expect(diff.cardsChanged[0]?.cardId).toBe('fixture_baseline_unit');
    expect(diff.cardsChanged[0]?.fields.sort()).toEqual(['attack', 'cost', 'health', 'keywords']);
    expect(diff.rulesChanged).toEqual([]);
    expect(diff.formatChanged).toEqual([]);
  });

  it('records the before and after definitions, so the claim is checkable', () => {
    const diff = diffEnvironments(baselineEnv, candidateEnv);
    expect(diff.cardsChanged[0]?.before).toMatch(/"attack":2/);
    expect(diff.cardsChanged[0]?.after).toMatch(/"attack":9/);
  });

  it('reports a rules change as a rules change, not a card change', () => {
    const slower = tinyEnvironment({
      id: 'slower',
      ...format,
      rulesConfig: { startingHealth: 30 },
    });
    const diff = diffEnvironments(baselineEnv, slower);
    expect(diff.cardsChanged).toEqual([]);
    expect(diff.rulesChanged.map((entry) => entry.key)).toEqual(['startingHealth']);
    expect(diff.rulesChanged[0]?.before).toBe('20');
    expect(diff.rulesChanged[0]?.after).toBe('30');
  });

  it('reports a deck-format change separately again', () => {
    const bigger = tinyEnvironment({ id: 'bigger', copyLimit: format.copyLimit, deckSize: 30 });
    const diff = diffEnvironments(baselineEnv, bigger);
    expect(diff.formatChanged.map((entry) => entry.key)).toEqual(['deckSize']);
  });

  it('says there is nothing to compare when the environments match', () => {
    const twin = resolveEnvironment(baselineEnv.config);
    const diff = diffEnvironments(baselineEnv, twin);
    expect(diff.identical).toBe(true);
    expect(diff.cardsChanged).toEqual([]);
    const report = compareEnvironments({
      diff,
      baselineRecords,
      candidateRecords: baselineRecords,
    });
    expect(report.limitations.join(' ')).toMatch(/nothing to compare/);
  });

  it('hashes the two environments differently and the twin identically', () => {
    expect(candidateEnv.hash).not.toBe(baselineEnv.hash);
    expect(resolveEnvironment(baselineEnv.config).hash).toBe(baselineEnv.hash);
  });
});

describe('common-seed pairing', () => {
  it('plays the same games in both environments', () => {
    // CLAUDE.md §13.15 item 18. The two runs must be the same experimental units,
    // or the comparison is measuring noise alongside the change.
    expect(candidateRecords).toHaveLength(baselineRecords.length);
    expect(candidateRecords.map((r) => r.matchId)).not.toEqual(
      baselineRecords.map((r) => r.matchId),
    );
    expect(candidateRecords.map((r) => r.seeds.matchSeed)).toEqual(
      baselineRecords.map((r) => r.seeds.matchSeed),
    );
    expect(candidateRecords.map((r) => `${r.deckPairId}:${r.gameIndex}`)).toEqual(
      baselineRecords.map((r) => `${r.deckPairId}:${r.gameIndex}`),
    );
  });

  it('reports full paired coverage when the schedules line up', () => {
    const report = compareEnvironments({
      diff: diffEnvironments(baselineEnv, candidateEnv),
      baselineRecords,
      candidateRecords,
    });
    expect(report.pairedGames).toBe(baselineRecords.length);
    expect(report.pairedCoverage).toBe(1);
    expect(report.limitations.join(' ')).not.toMatch(/unpaired/);
  });

  it('says so loudly when nothing is paired', () => {
    const unpaired = compareEnvironments({
      diff: diffEnvironments(baselineEnv, candidateEnv),
      baselineRecords,
      candidateRecords: candidateRecords.map((record) => ({
        ...record,
        gameIndex: record.gameIndex + 1000,
      })),
    });
    expect(unpaired.pairedGames).toBe(0);
    expect(unpaired.limitations.join(' ')).toMatch(/nothing here is a paired comparison/);
  });

  it('keeps the environment identity in the records despite the shared seed', () => {
    expect(new Set(baselineRecords.map((r) => r.environmentId))).toEqual(new Set(['baseline']));
    expect(new Set(candidateRecords.map((r) => r.environmentId))).toEqual(new Set(['candidate']));
    expect(new Set(candidateRecords.map((r) => r.environmentHash))).toEqual(
      new Set([candidateEnv.hash]),
    );
  });
});

describe('comparison report', () => {
  it('validates against its schema', () => {
    const report = compareEnvironments({
      diff: diffEnvironments(baselineEnv, candidateEnv),
      baselineRecords,
      candidateRecords,
    });
    expect(() => comparisonReportSchema.parse(report)).not.toThrow();
  });

  it('detects that the buffed card made its deck better', () => {
    const report = compareEnvironments({
      diff: diffEnvironments(baselineEnv, candidateEnv),
      baselineRecords,
      candidateRecords,
    });
    const subject = referenceDecks[0];
    const delta = report.referenceDeckDeltas.find((entry) => entry.deckHash === subject?.hash);
    expect(delta).toBeDefined();
    expect(delta?.pairedGames).toBeGreaterThan(0);
    expect(delta?.candidateWinRate).toBeGreaterThan(delta?.baselineWinRate ?? 1);
    expect(delta?.delta).toBeGreaterThan(0);
  });

  it('leaves decks that do not run the changed card alone', () => {
    const report = compareEnvironments({
      diff: diffEnvironments(baselineEnv, candidateEnv),
      baselineRecords,
      candidateRecords,
    });
    // The other two decks changed only because their opponent did, so their
    // deltas move in the opposite direction rather than independently.
    const others = report.referenceDeckDeltas.filter(
      (entry) => entry.deckHash !== referenceDecks[0]?.hash,
    );
    expect(others).toHaveLength(2);
    for (const delta of others) expect(delta.delta).toBeLessThanOrEqual(0);
  });

  it('separates the reference comparison from a searched one, and says when there was none', () => {
    const report = compareEnvironments({
      diff: diffEnvironments(baselineEnv, candidateEnv),
      baselineRecords,
      candidateRecords,
    });
    expect(report.strategiesGained).toEqual([]);
    expect(report.strategiesLost).toEqual([]);
    expect(report.limitations.join(' ')).toMatch(/No independent deck search/);
  });

  it('reports strategies gained, lost, displaced and newly viable from searched populations', () => {
    const onlyInCandidate = fixtureDeck('candidate_only', 'prototype_commander_blue', [
      ['fixture_dominant_unit', 12],
      ['prototype_scout', 12],
    ]);
    // Two baseline decks run `trench_guard`, and neither survives the change:
    // displacement needs a card with real support before, and none after.
    const onlyInBaseline = [0, 1].map((index) =>
      fixtureDeck(`baseline_only_${index}`, 'prototype_commander_red', [
        ['trench_guard', 12],
        [index === 0 ? 'prototype_guard' : 'prototype_drone', 12],
      ]),
    );
    const shared = referenceDecks[2] as (typeof referenceDecks)[number];

    const report = compareEnvironments({
      diff: diffEnvironments(baselineEnv, candidateEnv),
      baselineRecords,
      candidateRecords,
      baselineSearchDecks: [...onlyInBaseline, shared],
      candidateSearchDecks: [onlyInCandidate, shared],
      baselineSearchScores: new Map(onlyInBaseline.map((deck, index) => [deck.hash, 0.8 - index])),
      candidateSearchScores: new Map([[onlyInCandidate.hash, 0.95]]),
    });

    expect(report.strategiesGained.map((entry) => entry.deckHash)).toEqual([onlyInCandidate.hash]);
    expect(report.strategiesGained[0]?.score).toBe(0.95);
    expect(report.strategiesLost.map((entry) => entry.deckHash)).toEqual(
      onlyInBaseline.map((deck) => deck.hash),
    );
    expect(report.displacedCards.map((entry) => entry.definitionId)).toContain('trench_guard');
    expect(report.displacedCards.find((e) => e.definitionId === 'trench_guard')).toMatchObject({
      before: 2,
      after: 0,
    });
    expect(report.newlyViableCards).toContain('fixture_dominant_unit');
    expect(report.limitations.join(' ')).not.toMatch(/No independent deck search/);
  });

  it('classifies card-level status against the baseline', () => {
    const report = compareEnvironments({
      diff: diffEnvironments(baselineEnv, candidateEnv),
      baselineRecords,
      candidateRecords,
    });
    const subject = report.referenceCardDeltas.find(
      (entry) => entry.definitionId === 'fixture_baseline_unit',
    );
    expect(subject).toBeDefined();
    // Same decks in both arms, so inclusion is unchanged — only performance moved.
    expect(subject?.status).toBe('unchanged');
    expect(subject?.winRateDelta).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const inputs = {
      diff: diffEnvironments(baselineEnv, candidateEnv),
      baselineRecords,
      candidateRecords,
    };
    expect(JSON.stringify(compareEnvironments(inputs))).toBe(
      JSON.stringify(compareEnvironments(inputs)),
    );
  });
});
