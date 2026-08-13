import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { preconsForFormat } from '@tcg/card-data';
import { emptyBoardTelemetry } from '@tcg/board-telemetry';
import { experimentConfigSchema } from './config.js';
import { resolveEnvironment } from './environment.js';
import { resolveDeckSource } from './deck-source.js';
import { runExperiment } from './experiment.js';
import { buildMatchupMatrix, matchupMatrixRows, matchupMatrixSchema } from './matchup-matrix.js';
import { experimentPaths } from './reporting/sinks.js';
import { makeDeck, type SimDeck } from './deck-search/deck.js';
import {
  TELEMETRY_SCHEMA_VERSION,
  matchRecordSchema,
  type MatchRecord,
} from './telemetry/schema.js';

/**
 * M03.4 — the ordered matchup matrix.
 *
 * Two halves. The builder is exercised against hand-written records, because the
 * properties that matter — every ordered pair is a cell of its own, a mirror is
 * one cell and not two, a missing cell is reported rather than dropped, and an
 * invariant failure is surfaced with its replay — are properties of the artifact
 * and not of any particular match. The shipped configuration is then run for
 * real, because "all sixteen ordered matchups terminate deterministically with
 * no illegal action, loop or crash" is only a claim if the sixteen matches ran.
 */

const WAVE_1 = 'precon_wave_1';

function deck(name: string, guards: number): SimDeck {
  return makeDeck({
    id: name,
    label: name,
    commanderId: 'prototype_commander_blue',
    cards: [
      { cardId: 'prototype_scout', quantity: 2 },
      { cardId: 'prototype_guard', quantity: guards },
    ],
  });
}

function seatOf(
  playerId: string,
  seatIndex: number,
  source: SimDeck,
  won: boolean,
): Record<string, unknown> {
  return {
    playerId,
    seatIndex,
    deckId: source.id,
    deckHash: source.hash,
    commanderId: source.commanderId,
    colors: ['blue'],
    pilotId: 'value',
    pilotVersion: '1.0.0',
    pilotConfigHash: 'fixture',
    pilotSeed: `p_${playerId}`,
    won,
    lost: !won,
    lossReason: won ? null : 'health',
    eliminatedOnTurn: null,
    startingHealth: 20,
    endingHealth: won ? 10 : 0,
    damageDealtToPlayers: 10,
    damageTaken: 10,
    healingReceived: 0,
    cardsDrawn: 5,
    cardsPlayed: 5,
    cardsDiscarded: 0,
    energySpent: 10,
    energyUnspentAtTurnEnd: 0,
    unitsDeployed: 3,
    relicsDeployed: 0,
    relicsReplaced: 0,
    tokensCreated: 0,
    unitsLost: 1,
    attacksDeclared: 3,
    blocksAssigned: 1,
    abilitiesActivated: 0,
    choicesResolved: 0,
    decisions: 20,
  };
}

/** Parsed rather than cast, so a drifted fixture cannot prove anything. */
function record(options: {
  matchId: string;
  first: SimDeck;
  second: SimDeck;
  firstWins: boolean;
  termination?: MatchRecord['termination'];
  diagnostics?: readonly string[];
  replayPath?: string | null;
  gameIndex?: number;
  orientation?: number;
}): MatchRecord {
  const seats = [
    seatOf('player_1', 0, options.first, options.firstWins),
    seatOf('player_2', 1, options.second, !options.firstWins),
  ];
  const termination = options.termination ?? 'victory';
  return matchRecordSchema.parse({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    matchId: options.matchId,
    orderKey: options.matchId,
    experimentId: 'fixture',
    experimentKind: 'batch',
    configHash: 'fixture-config',
    arm: null,
    environmentId: 'fixture',
    environmentHash: 'fixture-env',
    cardPoolHash: 'fixture-pool',
    rulesVersion: '0.2.0',
    deckPairId: 'pair',
    variantKey: 'variant',
    gameIndex: options.gameIndex ?? 0,
    orientation: options.orientation ?? 0,
    playerCount: 2,
    seeds: {
      derivationVersion: 2,
      path: `fixture|pair:${options.first.hash}|game:00000${options.gameIndex ?? 0}`,
      matchSeed: `m_${options.matchId}`,
      seatSeed: `s_${options.matchId}`,
      pilotSeeds: ['p_1', 'p_2'],
    },
    startingPlayerId: 'player_1',
    outcome: termination === 'victory' ? 'win' : 'none',
    winnerId: termination === 'victory' ? (options.firstWins ? 'player_1' : 'player_2') : null,
    termination,
    endReason: termination === 'victory' ? 'health' : null,
    turns: 10,
    actions: 40,
    decisions: 40,
    events: 80,
    resolutionSteps: 40,
    seats,
    cards: [],
    // Zeroed rather than invented: this fixture is about matrix completeness,
    // and a made-up board figure would be indistinguishable from a measured one.
    board: emptyBoardTelemetry(),
    botFailures: [],
    diagnostics: [...(options.diagnostics ?? [])],
    replayPath: options.replayPath ?? null,
    softwareCommit: null,
  });
}

const ALPHA = deck('alpha', 1);
const BETA = deck('beta', 2);

function build(records: readonly MatchRecord[], decks: readonly SimDeck[] = [ALPHA, BETA]) {
  return buildMatchupMatrix({
    experimentId: 'fixture',
    seed: 'fixture-seed',
    configHash: 'fixture-config',
    environmentId: 'fixture',
    environmentHash: 'fixture-env',
    formatId: WAVE_1,
    decks,
    precons: [
      {
        preconId: 'precon_goblin_swarm',
        name: 'Goblin Swarm',
        formatId: WAVE_1,
        commanderId: ALPHA.commanderId,
        deckHash: ALPHA.hash,
      },
    ],
    records,
  });
}

/** The four ordered pairs of two decks, all won by the first seat. */
function fullTwoDeckMatrix(): MatchRecord[] {
  return [
    record({ matchId: 'm_aa', first: ALPHA, second: ALPHA, firstWins: true }),
    record({ matchId: 'm_ab', first: ALPHA, second: BETA, firstWins: true }),
    record({ matchId: 'm_ba', first: BETA, second: ALPHA, firstWins: true }),
    record({ matchId: 'm_bb', first: BETA, second: BETA, firstWins: true }),
  ];
}

describe('buildMatchupMatrix', () => {
  it('gives every ordered pair its own cell and marks the diagonal as mirrors', () => {
    const matrix = build(fullTwoDeckMatrix());

    expect(matrix.expectedCells).toBe(4);
    expect(matrix.playedCells).toBe(4);
    expect(matrix.complete).toBe(true);
    expect(matrix.missing).toEqual([]);

    // (alpha, beta) and (beta, alpha) are different cells: that is the whole
    // point of an *ordered* matrix.
    const forward = matrix.cells.find(
      (cell) => cell.firstSeatDeckId === 'alpha' && cell.secondSeatDeckId === 'beta',
    );
    const backward = matrix.cells.find(
      (cell) => cell.firstSeatDeckId === 'beta' && cell.secondSeatDeckId === 'alpha',
    );
    expect(forward?.games).toHaveLength(1);
    expect(backward?.games).toHaveLength(1);
    expect(forward?.mirror).toBe(false);

    expect(matrix.cells.filter((cell) => cell.mirror).map((cell) => cell.firstSeatDeckId)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('reports a missing ordered pair instead of presenting a partial grid', () => {
    const matrix = build(fullTwoDeckMatrix().filter((entry) => entry.matchId !== 'm_ba'));
    expect(matrix.complete).toBe(false);
    expect(matrix.playedCells).toBe(3);
    expect(matrix.missing).toEqual(['beta -> alpha']);
  });

  it('records seat order, winner deck and the full seed hierarchy', () => {
    const matrix = build(fullTwoDeckMatrix());
    const cell = matrix.cells.find(
      (entry) => entry.firstSeatDeckId === 'beta' && entry.secondSeatDeckId === 'alpha',
    );
    const game = cell?.games[0];

    expect(game?.seats.map((seat) => seat.deckId)).toEqual(['beta', 'alpha']);
    expect(game?.seats.map((seat) => seat.seatIndex)).toEqual([0, 1]);
    expect(game?.winnerDeckId).toBe('beta');
    expect(cell?.firstSeatWins).toBe(1);
    expect(cell?.secondSeatWins).toBe(0);
    expect(game?.seeds.path).toContain('game:');
    expect(game?.seeds.matchSeed).toBe('m_m_ba');
    expect(game?.startingPlayerId).toBe('player_1');
  });

  it('names the precon a deck came from', () => {
    const matrix = build(fullTwoDeckMatrix());
    expect(matrix.decks.find((entry) => entry.deckId === 'alpha')?.preconId).toBe(
      'precon_goblin_swarm',
    );
    expect(matrix.decks.find((entry) => entry.deckId === 'beta')?.preconId).toBeNull();
    expect(matrix.formatId).toBe(WAVE_1);
    expect(matrix.pilots).toEqual([{ id: 'value', version: '1.0.0' }]);
  });

  it('surfaces an abnormal termination and a diagnostic as invariant failures', () => {
    const records = fullTwoDeckMatrix().filter((entry) => entry.matchId !== 'm_ab');
    records.push(
      record({
        matchId: 'm_ab',
        first: ALPHA,
        second: BETA,
        firstWins: false,
        termination: 'no_progress',
        diagnostics: ['safeguard: no progress for 60 actions'],
        replayPath: 'replays/m_ab.json',
      }),
    );
    const matrix = build(records);

    expect(matrix.games).toBe(4);
    expect(matrix.cleanGames).toBe(3);
    expect(matrix.invariantFailures.map((failure) => failure.detail)).toEqual([
      'termination:no_progress',
      'diagnostic:safeguard: no progress for 60 actions',
    ]);
    expect(matrix.invariantFailures.every((failure) => failure.replayPath === 'replays/m_ab.json'));
    // The cell is still there — an abnormal match is a played matchup, and
    // hiding it would turn a broken pairing into a missing one.
    expect(matrix.complete).toBe(true);
    expect(
      matrix.cells.find(
        (cell) => cell.firstSeatDeckId === 'alpha' && cell.secondSeatDeckId === 'beta',
      )?.unclean,
    ).toBe(1);
  });

  it('is a pure function of its inputs and validates against its own schema', () => {
    const first = build(fullTwoDeckMatrix());
    const second = build(fullTwoDeckMatrix());
    expect(second).toEqual(first);
    expect(() => matchupMatrixSchema.parse(first)).not.toThrow();
  });

  it('does not depend on the order records arrived in', () => {
    // The property that makes the artifact worker-count invariant, held here
    // rather than borrowed from whoever assembled the record list.
    const games = [
      record({ matchId: 'm_ab_1', first: ALPHA, second: BETA, firstWins: true, gameIndex: 0 }),
      record({ matchId: 'm_ab_2', first: ALPHA, second: BETA, firstWins: false, gameIndex: 1 }),
      record({ matchId: 'm_ba_1', first: BETA, second: ALPHA, firstWins: true, gameIndex: 0 }),
      record({ matchId: 'm_aa_1', first: ALPHA, second: ALPHA, firstWins: true, gameIndex: 0 }),
      record({ matchId: 'm_bb_1', first: BETA, second: BETA, firstWins: true, gameIndex: 0 }),
    ];
    expect(build([...games].reverse())).toEqual(build(games));
  });

  it('exports one CSV row per game with its seed and outcome', () => {
    const rows = matchupMatrixRows(build(fullTwoDeckMatrix()));
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.mirror)).toHaveLength(2);
    for (const row of rows) {
      expect(row.seedPath.length).toBeGreaterThan(0);
      expect(row.termination).toBe('victory');
      expect(row.invariantFailures).toBe('');
    }
  });

  it('ignores a table that is not an ordered pair', () => {
    // A matrix is defined over two seats. A four-player record in the same
    // stream is left out rather than being folded into a cell it is not from.
    const fourSeats = matchRecordSchema.parse({
      ...record({ matchId: 'm_four', first: ALPHA, second: BETA, firstWins: true }),
      playerCount: 4,
      seats: [
        seatOf('player_1', 0, ALPHA, true),
        seatOf('player_2', 1, BETA, false),
        seatOf('player_3', 2, ALPHA, false),
        seatOf('player_4', 3, BETA, false),
      ],
    });
    const matrix = build([...fullTwoDeckMatrix(), fourSeats]);
    expect(matrix.games).toBe(4);
  });
});

describe('the ordered-matchup-matrix configuration', () => {
  const base = {
    schemaVersion: 1,
    kind: 'batch',
    id: 'matrix',
    seed: 'seed',
    pilots: [{ id: 'value' }],
    environment: { id: 'env' },
    decks: { kind: 'precon', preconIds: ['precon_goblin_swarm'] },
    orderedMatchupMatrix: true,
  };

  it('accepts a two-seat round-robin with mirrored seats', () => {
    const config = experimentConfigSchema.parse({ ...base, playerCount: 2 });
    expect(config.kind === 'batch' && config.orderedMatchupMatrix).toBe(true);
  });

  it('is off unless a configuration asks for it', () => {
    const config = experimentConfigSchema.parse({ ...base, orderedMatchupMatrix: undefined });
    expect(config.kind === 'batch' && config.orderedMatchupMatrix).toBe(false);
  });

  // Refused rather than adjusted: an artifact called "the ordered matchup
  // matrix" that quietly omitted cells is worse than one that will not run.
  it('refuses a table that is not a pair', () => {
    expect(() => experimentConfigSchema.parse({ ...base, playerCount: 4 })).toThrow(
      /ordered \*pair\* needs 2 seats/,
    );
  });

  it('refuses a sampled schedule', () => {
    expect(() => experimentConfigSchema.parse({ ...base, schedule: 'sampled' })).toThrow(
      /drops pairings/,
    );
  });

  it('refuses unmirrored seats', () => {
    expect(() => experimentConfigSchema.parse({ ...base, mirrorSeats: false })).toThrow(
      /one way round/,
    );
  });
});

describe('the shipped matrix config', () => {
  it('names the four Wave 1 precons and asks for the matrix', () => {
    const raw: unknown = JSON.parse(readFileSync('experiments/precon-matrix.json', 'utf8'));
    const config = experimentConfigSchema.parse(raw);
    if (config.kind !== 'batch' || config.decks.kind !== 'precon') {
      throw new Error('experiments/precon-matrix.json is no longer a precon batch.');
    }
    expect(config.orderedMatchupMatrix).toBe(true);
    expect(config.playerCount).toBe(2);

    const environment = resolveEnvironment(config.environment);
    const resolved = resolveDeckSource(config.decks, environment, config.seed);
    expect(resolved.precons.map((entry) => entry.preconId).sort()).toEqual(
      preconsForFormat(WAVE_1)
        .map((precon) => precon.id)
        .sort(),
    );
    // 4 decks -> 16 ordered pairs, which is what the tranche is named after.
    expect(resolved.decks.length ** 2).toBe(16);
  });
});

describe('a matrix experiment over the four precons', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('runs all sixteen ordered matchups to a clean, deterministic end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tcg-matrix-'));
    roots.push(dir);

    const raw: unknown = JSON.parse(readFileSync('experiments/precon-matrix.json', 'utf8'));
    const config = experimentConfigSchema.parse({ ...(raw as object), workers: 1 });

    const outcome = await runExperiment(config, { outputDir: dir, softwareCommit: 'test-commit' });
    const matrix = outcome.matchupMatrix;
    if (!matrix) throw new Error('The matrix experiment produced no matchup matrix.');

    expect(outcome.records).toHaveLength(16);
    expect(matrix.expectedCells).toBe(16);
    expect(matrix.playedCells).toBe(16);
    expect(matrix.complete).toBe(true);
    expect(matrix.games).toBe(16);

    // The acceptance criterion, stated as one assertion: no illegal action, no
    // loop, no crash, in any of the sixteen ordered pairs.
    expect(matrix.invariantFailures).toEqual([]);
    expect(matrix.cleanGames).toBe(16);
    expect(outcome.records.filter((entry) => entry.termination !== 'victory')).toEqual([]);

    // Four mirrors on the diagonal, played once each rather than twice.
    expect(matrix.cells.filter((cell) => cell.mirror)).toHaveLength(4);
    for (const cell of matrix.cells) expect(cell.games).toHaveLength(1);

    // Every deck is a named precon, and every game carries its own seed path.
    expect(matrix.decks.map((entry) => entry.preconId)).toEqual(
      preconsForFormat(WAVE_1)
        .map((precon) => precon.id)
        .sort(),
    );
    expect(matrix.formatId).toBe(WAVE_1);
    const paths = new Set(matrix.cells.flatMap((cell) => cell.games.map((g) => g.seeds.path)));
    expect(paths.size).toBe(16);

    // The artifact on disk is the record, and it validates as itself.
    const written = matchupMatrixSchema.parse(
      JSON.parse(readFileSync(experimentPaths(dir).matchupMatrix, 'utf8')),
    );
    expect(written).toEqual(matrix);
    const csv = readFileSync(experimentPaths(dir).matchupMatrixCsv, 'utf8').trim().split('\n');
    expect(csv).toHaveLength(17);
    expect(csv[0]).toContain('seed_path');

    const manifest = JSON.parse(readFileSync(experimentPaths(dir).manifest, 'utf8'));
    expect(manifest.schemaVersion).toBe(8);
    expect(manifest.matchupMatrix).toMatchObject({
      path: 'matchup-matrix.json',
      expectedCells: 16,
      playedCells: 16,
      complete: true,
      cleanGames: 16,
      invariantFailures: 0,
    });
    expect(manifest.failedMatches).toBe(0);
    expect(manifest.abnormalMatches).toBe(0);

    // The report carries the grid and refuses to be read as a balance result.
    expect(outcome.report).toContain('## Ordered matchup matrix');
    expect(outcome.report).toContain('robustness artifact, not a balance measurement');
    expect(outcome.report).toContain('precon_goblin_swarm');
  }, 300_000);
});
