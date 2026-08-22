import { describe, expect, it } from 'vitest';

import {
  buildSchedule,
  environmentConfigForFormat,
  parseExperimentConfig,
  poolReportFor,
  resolveDeckSource,
  resolveEnvironment,
  type ExperimentConfig,
  type ExperimentConfigInput,
} from '@tcg/simulator';

import { PRESET_FORMAT_ID } from './expand.js';
import {
  deckCountFor,
  estimateConfig,
  estimateExperiment,
  forcedInclusionFor,
} from './estimate.js';

/**
 * M08.3's acceptance, in the only form that settles it: **the estimator equals
 * the real generated schedule.**
 *
 * Every equivalence test below builds the schedule the way `experiment.ts` builds
 * it — real decks, resolved from real content, through `buildSchedule` — and
 * requires the estimate to be that number. A test that compared the estimator to
 * a formula would be comparing two guesses.
 */

const PRECONS = [
  'precon_bastion_guardians',
  'precon_containment_control',
  'precon_goblin_swarm',
  'precon_grave_sacrifice',
];

const ENVIRONMENT_CONFIG = environmentConfigForFormat(PRESET_FORMAT_ID, {
  label: 'Precon Wave 1',
});
const ENVIRONMENT = resolveEnvironment(ENVIRONMENT_CONFIG);

function batch(overrides: Record<string, unknown> = {}): ExperimentConfig {
  return parseExperimentConfig({
    schemaVersion: 1,
    kind: 'batch',
    id: 'equivalence',
    seed: 'equivalence-2026-08',
    playerCount: 2,
    pilots: [{ id: 'value' }],
    pilotPairing: 'mirror',
    environment: ENVIRONMENT_CONFIG,
    decks: { kind: 'precon', preconIds: PRECONS },
    gamesPerPairing: 3,
    ...overrides,
  } satisfies ExperimentConfigInput as ExperimentConfigInput);
}

/** The schedule the run itself would build, from decks that really resolved. */
function realBatchSchedule(config: Extract<ExperimentConfig, { kind: 'batch' }>): number {
  const resolved = resolveDeckSource(config.decks, ENVIRONMENT, `${config.seed}|decks`);
  return buildSchedule({
    experimentId: config.id,
    experimentSeed: config.seed,
    environmentId: ENVIRONMENT.id,
    decks: resolved.decks,
    pilots: config.pilots,
    pilotPairing: config.pilotPairing,
    playerCount: config.playerCount,
    gamesPerPairing: config.gamesPerPairing,
    mirrorSeats: config.mirrorSeats,
    schedule: config.schedule,
    sampledPairings: config.sampledPairings,
    includeMirrorMatchups: config.orderedMatchupMatrix,
  }).length;
}

const IDENTITY = { stageId: 'matches', label: 'matches', purpose: 'exploration' } as const;

describe('the estimate equals the real schedule', () => {
  const cases: readonly { readonly name: string; readonly overrides: Record<string, unknown> }[] = [
    { name: 'four precons, three games per seat order', overrides: {} },
    { name: 'one game per seat order', overrides: { gamesPerPairing: 1 } },
    { name: 'seat mirroring turned off', overrides: { mirrorSeats: false } },
    {
      name: 'the ordered matchup matrix, mirrors included',
      overrides: { gamesPerPairing: 1, orderedMatchupMatrix: true },
    },
    {
      name: 'several pilots flown as mirrors',
      overrides: { pilots: [{ id: 'value' }, { id: 'aggressive' }, { id: 'defensive' }] },
    },
    {
      name: 'several pilots in every ordered arrangement',
      overrides: {
        pilots: [{ id: 'value' }, { id: 'aggressive' }],
        pilotPairing: 'all_pairs',
      },
    },
    {
      name: 'pilots rotated through the seats',
      overrides: { pilots: [{ id: 'value' }, { id: 'aggressive' }], pilotPairing: 'rotate' },
    },
    { name: 'a four-seat table', overrides: { playerCount: 4, gamesPerPairing: 2 } },
    {
      name: 'a sampled schedule that drops pairings',
      overrides: { schedule: 'sampled', sampledPairings: 2 },
    },
    {
      name: 'a sampled schedule wider than the pairings it has',
      overrides: { schedule: 'sampled', sampledPairings: 500 },
    },
  ];

  for (const entry of cases) {
    it(`agrees on ${entry.name}`, () => {
      const config = batch(entry.overrides) as Extract<ExperimentConfig, { kind: 'batch' }>;
      const [stage] = estimateConfig(config, IDENTITY, ENVIRONMENT);
      expect(stage?.matches).toBe(realBatchSchedule(config));
      expect(stage?.basis).toBe('exact');
    });
  }

  it('agrees on a robustness run, once per profile including the reference arm', () => {
    const config = parseExperimentConfig({
      schemaVersion: 1,
      kind: 'robustness',
      id: 'robust',
      seed: 'robust-2026-08',
      pilots: [{ id: 'value' }],
      environment: ENVIRONMENT_CONFIG,
      decks: { kind: 'precon', preconIds: PRECONS },
      profiles: ['combat_forward', 'card_advantage'],
      gamesPerPairing: 2,
    } as ExperimentConfigInput) as Extract<ExperimentConfig, { kind: 'robustness' }>;

    const resolved = resolveDeckSource(config.decks, ENVIRONMENT, `${config.seed}|decks`);
    const perArm = buildSchedule({
      experimentId: config.id,
      experimentSeed: config.seed,
      environmentId: ENVIRONMENT.id,
      decks: resolved.decks,
      pilots: config.pilots,
      pilotPairing: config.pilotPairing,
      playerCount: config.playerCount,
      gamesPerPairing: config.gamesPerPairing,
      mirrorSeats: config.mirrorSeats,
      schedule: config.schedule,
      sampledPairings: config.sampledPairings,
      pairedSeeds: true,
    }).length;

    const [stage] = estimateConfig(config, IDENTITY, ENVIRONMENT);
    // `published` is always an arm, so two configured profiles make three.
    expect(stage?.repeats).toBe(3);
    expect(stage?.matches).toBe(perArm * 3);
    expect(stage?.basis).toBe('exact');
  });

  it('counts nothing when the table cannot be seated', () => {
    // Two precons cannot fill four seats, and `buildSchedule` refuses rather than
    // scheduling a partial table. The estimator must not turn that into a number.
    expect(() =>
      estimateConfig(
        batch({ playerCount: 4, decks: { kind: 'precon', preconIds: PRECONS.slice(0, 2) } }),
        IDENTITY,
        ENVIRONMENT,
      ),
    ).toThrow(/at least 4 decks/);
  });
});

describe('games are reported per seat order', () => {
  it('splits a mirrored two-seat schedule evenly between the orientations', () => {
    const config = batch() as Extract<ExperimentConfig, { kind: 'batch' }>;
    const [stage] = estimateConfig(config, IDENTITY, ENVIRONMENT);
    expect(stage?.seatOrders).toEqual([
      { orientation: 0, matches: 18 },
      { orientation: 1, matches: 18 },
    ]);
    expect(stage?.gamesPerSeatOrder).toBe(3);
  });

  it('reports one orientation when seat mirroring is off', () => {
    const [stage] = estimateConfig(batch({ mirrorSeats: false }), IDENTITY, ENVIRONMENT);
    expect(stage?.seatOrders).toEqual([{ orientation: 0, matches: 18 }]);
  });

  it('puts a mirror matchup in one orientation rather than two', () => {
    // Rotating a deck against a copy of itself gives the same table back, so the
    // matrix's four diagonal cells are orientation 0 only. A breakdown that
    // divided the total by the seat count would get this wrong and never know.
    const [stage] = estimateConfig(
      batch({ gamesPerPairing: 1, orderedMatchupMatrix: true }),
      IDENTITY,
      ENVIRONMENT,
    );
    const byOrientation = new Map(
      stage?.seatOrders.map((entry) => [entry.orientation, entry.matches]),
    );
    expect(byOrientation.get(0)).toBe(10);
    expect(byOrientation.get(1)).toBe(6);
  });

  it('reports four orientations at a four-seat table', () => {
    const [stage] = estimateConfig(
      batch({ playerCount: 4, gamesPerPairing: 1 }),
      IDENTITY,
      ENVIRONMENT,
    );
    expect(stage?.seatOrders.map((entry) => entry.orientation)).toEqual([0, 1, 2, 3]);
  });

  it('multiplies the breakdown by the repeats, so it still adds up', () => {
    const config = parseExperimentConfig({
      schemaVersion: 1,
      kind: 'robustness',
      id: 'robust',
      seed: 'robust-2026-08',
      pilots: [{ id: 'value' }],
      environment: ENVIRONMENT_CONFIG,
      decks: { kind: 'precon', preconIds: PRECONS },
      profiles: ['combat_forward'],
      gamesPerPairing: 1,
    } as ExperimentConfigInput);
    const [stage] = estimateConfig(config, IDENTITY, ENVIRONMENT);
    const summed = stage?.seatOrders.reduce((total, entry) => total + entry.matches, 0);
    expect(summed).toBe(stage?.matches);
  });
});

describe('a bound is labelled a bound', () => {
  const search = parseExperimentConfig({
    schemaVersion: 1,
    kind: 'search',
    id: 'search',
    seed: 'search-2026-08',
    pilots: [{ id: 'value' }],
    environment: ENVIRONMENT_CONFIG,
    populationSize: 8,
    generations: 3,
    replicates: 2,
    opponentsPerEvaluation: 4,
    gamesPerOpponent: 2,
  } as ExperimentConfigInput) as Extract<ExperimentConfig, { kind: 'search' }>;

  it('counts a search generation the way its evaluation builds it', () => {
    const [stage] = estimateConfig(search, IDENTITY, ENVIRONMENT);
    // 8 contenders × 4 opponents × 2 seat orders × 2 games, once per pilot tuple.
    expect(stage?.matches).toBe(8 * 4 * 2 * 2 * search.replicates * search.generations);
    expect(stage?.repeats).toBe(6);
  });

  it('calls the search total an upper bound and says why', () => {
    const [stage] = estimateConfig(search, IDENTITY, ENVIRONMENT);
    expect(stage?.basis).toBe('upper_bound');
    expect(stage?.reason).toMatch(/overlaps the current population/);
  });

  it('makes the whole estimate a bound as soon as one stage is', () => {
    const estimate = estimateExperiment(search);
    expect(estimate.basis).toBe('upper_bound');
    expect(estimate.totalMatches).toBe(
      estimate.stages.reduce((total, stage) => total + stage.matches, 0),
    );
  });

  it('splits a comparison into its reference arms and its searches', () => {
    const config = parseExperimentConfig({
      schemaVersion: 1,
      kind: 'comparison',
      id: 'candidate',
      seed: 'candidate-2026-08',
      pilots: [{ id: 'value' }],
      baseline: ENVIRONMENT_CONFIG,
      candidate: environmentConfigForFormat(PRESET_FORMAT_ID, {
        id: 'precon_wave_1_candidate',
        banCardIds: [ENVIRONMENT.pool[0]?.id ?? ''],
      }),
      referenceDecks: { kind: 'precon', preconIds: PRECONS },
      gamesPerPairing: 2,
    } as ExperimentConfigInput);
    const stages = estimateConfig(config, IDENTITY, ENVIRONMENT);
    expect(stages.map((stage) => stage.stageId)).toEqual(['matches-reference', 'matches-search']);
    // Both arms play the same reference schedule.
    expect(stages[0]?.repeats).toBe(2);
    for (const stage of stages) expect(stage.basis).toBe('upper_bound');
    expect(stages[0]?.reason).toMatch(/legal in both environments/);
  });

  it('drops the search stage when a comparison is configured without one', () => {
    const config = parseExperimentConfig({
      schemaVersion: 1,
      kind: 'comparison',
      id: 'candidate',
      seed: 'candidate-2026-08',
      pilots: [{ id: 'value' }],
      baseline: ENVIRONMENT_CONFIG,
      candidate: ENVIRONMENT_CONFIG,
      referenceDecks: { kind: 'precon', preconIds: PRECONS },
      searchBothEnvironments: false,
    } as ExperimentConfigInput);
    expect(estimateConfig(config, IDENTITY, ENVIRONMENT)).toHaveLength(1);
  });

  it('calls a replacement a floor, because every variant it builds adds matches', () => {
    const config = parseExperimentConfig({
      schemaVersion: 1,
      kind: 'replacement',
      id: 'replacement',
      seed: 'replacement-2026-08',
      pilots: [{ id: 'value' }],
      environment: ENVIRONMENT_CONFIG,
      baseDecks: { kind: 'precon', preconIds: PRECONS.slice(0, 2) },
      opponentDecks: { kind: 'precon', preconIds: PRECONS.slice(2) },
      subjectCardId: ENVIRONMENT.pool[0]?.id ?? '',
      gamesPerPairing: 1,
    } as ExperimentConfigInput);
    const [stage] = estimateConfig(config, IDENTITY, ENVIRONMENT);
    expect(stage?.basis).toBe('at_least');
    expect(stage?.reason).toMatch(/Each variant adds matches/);
    // Two arms against two opponents, both seat orders.
    expect(stage?.matches).toBe(8);
  });
});

describe('deck counts', () => {
  it('resolves named precons for real, so a refused one is refused now', () => {
    const count = deckCountFor({ kind: 'precon', preconIds: PRECONS }, ENVIRONMENT, 'seed');
    expect(count).toEqual({ count: 4, source: 'resolved_precons', basis: 'exact', rejected: [] });
  });

  it('refuses a precon this build does not publish, in the simulator’s own words', () => {
    expect(() =>
      deckCountFor({ kind: 'precon', preconIds: ['precon_not_a_deck'] }, ENVIRONMENT, 'seed'),
    ).toThrow(/No built-in precon has ID/);
  });

  it('treats a generated population as a request rather than a promise', () => {
    const count = deckCountFor(
      { kind: 'generated', count: 40, generator: { commanderIds: [] } } as never,
      ENVIRONMENT,
      'seed',
    );
    expect(count.basis).toBe('upper_bound');
    expect(count.count).toBe(40);
    expect(count.source).toBe('requested_generation');
  });

  it('does not generate a population to find out', () => {
    // A UI estimate that spent a minute building two thousand decks would not be
    // an estimate. Two thousand is the schema's ceiling, and this must be instant.
    const started = Date.now();
    deckCountFor(
      { kind: 'generated', count: 2000, generator: { commanderIds: [] } } as never,
      ENVIRONMENT,
      'seed',
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('bounds a file deck source rather than resolving a path it was never given', () => {
    const count = deckCountFor({ kind: 'files', paths: ['a.json', 'b.json'] }, ENVIRONMENT, 'seed');
    expect(count).toMatchObject({ count: 2, source: 'declared_files', basis: 'upper_bound' });
  });
});

describe('the forced-inclusion floor', () => {
  it('is `poolReportFor`, field for field, and never recomputed', () => {
    const floors = forcedInclusionFor(
      ENVIRONMENT,
      ENVIRONMENT.commanders.map((card) => card.id),
    );
    expect(floors).toHaveLength(ENVIRONMENT.commanders.length);
    for (const floor of floors) {
      const commander = ENVIRONMENT.commanders.find((card) => card.id === floor.commanderId);
      expect(commander).toBeDefined();
      expect(floor).toEqual({ ...poolReportFor(ENVIRONMENT, commander!) });
    }
  });

  it('reports the Wave 1 floors the milestone predicted', () => {
    // The locked interpretation: 41–42 legal cards for a 40-card singleton deck.
    // Two legal decks under one Commander therefore share at least 38 of 40 cards.
    const floors = forcedInclusionFor(
      ENVIRONMENT,
      ENVIRONMENT.commanders.map((card) => card.id),
    );
    expect(
      floors.map((floor) => [floor.commanderId, floor.legalPoolSize, floor.forcedInclusionFloor]),
    ).toEqual([
      ['bastion_commander', 42, 38],
      ['chief_containment_scholar', 41, 39],
      ['goblin_warboss', 41, 39],
      ['grave_matriarch', 42, 38],
    ]);
  });

  it('reports one row per Commander however many decks run it', () => {
    const floors = forcedInclusionFor(ENVIRONMENT, ['goblin_warboss', 'goblin_warboss']);
    expect(floors).toHaveLength(1);
  });

  it('ignores a Commander the environment does not have rather than inventing a floor', () => {
    expect(forcedInclusionFor(ENVIRONMENT, ['not_a_commander'])).toEqual([]);
  });

  it('is attached to a batch estimate, with the caveat beside it', () => {
    const estimate = estimateExperiment(batch());
    expect(estimate.forcedInclusion.map((floor) => floor.commanderId).sort()).toEqual([
      'bastion_commander',
      'chief_containment_scholar',
      'goblin_warboss',
      'grave_matriarch',
    ]);
    expect(estimate.limitations.join(' ')).toMatch(/forced-inclusion floor/);
  });

  it('shows every legal Commander for an unconstrained search, because it may choose any', () => {
    const estimate = estimateExperiment(
      parseExperimentConfig({
        schemaVersion: 1,
        kind: 'search',
        id: 'open',
        seed: 'open-2026-08',
        pilots: [{ id: 'value' }],
        environment: ENVIRONMENT_CONFIG,
      } as ExperimentConfigInput),
    );
    expect(estimate.forcedInclusion).toHaveLength(ENVIRONMENT.commanders.length);
  });
});
