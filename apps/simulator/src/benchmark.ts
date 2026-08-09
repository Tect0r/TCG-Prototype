/* eslint-disable no-console */
import { performance } from 'node:perf_hooks';
import { resolveEnvironment } from './environment.js';
import { generatePopulation } from './deck-search/generate.js';
import { buildSchedule } from './schedule.js';
import { runBatch } from './run-batch.js';
import { DEFAULT_LIMITS } from './run-match.js';
import type { PilotSpec } from '@tcg/bot-interface';

/**
 * The checked-in benchmark scenario (CLAUDE.md §13.14).
 *
 * A fixed environment, a fixed population, a fixed schedule — so the only thing
 * that varies between runs is the machine and the worker count. Reports
 * matches/second, actions/second, peak heap and output size at 1, 2 and 4
 * workers, and checks that the results are identical at every count.
 *
 * ```bash
 * npm run bench --workspace @tcg/simulator
 * npm run bench --workspace @tcg/simulator -- --games 4 --decks 8
 * ```
 */

const BENCH_SEED = 'benchmark-v1';
const BENCH_PILOTS: PilotSpec[] = [
  { id: 'value', weights: {}, randomConfig: {} },
  { id: 'aggressive', weights: {}, randomConfig: {} },
];

interface BenchResult {
  readonly workers: number;
  readonly matches: number;
  readonly elapsedMs: number;
  readonly matchesPerSecond: number;
  readonly actionsPerSecond: number;
  readonly peakHeapMb: number;
  readonly recordBytes: number;
  readonly fingerprint: string;
}

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number.parseInt(process.argv[index + 1] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function runOnce(workers: number, deckCount: number, games: number): Promise<BenchResult> {
  const environment = resolveEnvironment({ id: 'benchmark' });
  const population = generatePopulation(environment, `${BENCH_SEED}|decks`, deckCount, {});
  const decks = population.decks;

  const schedule = buildSchedule({
    experimentId: 'benchmark',
    experimentSeed: BENCH_SEED,
    environmentId: environment.id,
    decks,
    pilots: BENCH_PILOTS,
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: games,
    mirrorSeats: true,
    schedule: 'round_robin',
    sampledPairings: 100_000,
  });

  const before = performance.now();
  const outcome = await runBatch({
    experimentId: 'benchmark',
    experimentKind: 'batch',
    configHash: `benchmark|${deckCount}|${games}`,
    arm: null,
    environment,
    decks,
    pilots: BENCH_PILOTS,
    schedule,
    limits: DEFAULT_LIMITS,
    retention: { replaySampleRate: 0, keepLogs: false, keepDecisions: false },
    workers,
    failFast: false,
    // The benchmark measures throughput, not storage, so nothing is committed to
    // a stream. Worker-count equivalence is checked through the fingerprint below.
    sink: null,
  });
  const elapsedMs = performance.now() - before;

  const actions = outcome.records.reduce((sum, record) => sum + record.actions, 0);
  const serialized = outcome.records.map((record) => JSON.stringify(record)).join('\n');

  return {
    workers,
    matches: outcome.records.length,
    elapsedMs,
    matchesPerSecond: (outcome.records.length / elapsedMs) * 1000,
    actionsPerSecond: (actions / elapsedMs) * 1000,
    peakHeapMb: process.memoryUsage().heapUsed / (1024 * 1024),
    recordBytes: Buffer.byteLength(serialized, 'utf8'),
    // Everything except the record order must be identical between worker
    // counts; the fingerprint is what proves it.
    fingerprint: outcome.records
      .map(
        (record) =>
          `${record.matchId}:${record.termination}:${record.winnerId ?? '-'}:${record.turns}`,
      )
      .join('|'),
  };
}

async function main(): Promise<void> {
  const deckCount = arg('decks', 6);
  const games = arg('games', 2);
  const counts = [1, 2, 4];

  console.log(`benchmark scenario: ${deckCount} generated decks, ${games} game(s) per orientation`);
  console.log(`seed: ${BENCH_SEED}`);
  console.log('');

  const results: BenchResult[] = [];
  for (const workers of counts) {
    const result = await runOnce(workers, deckCount, games);
    results.push(result);
    console.log(
      `workers=${workers}  matches=${result.matches}  ` +
        `${result.matchesPerSecond.toFixed(2)} matches/s  ` +
        `${result.actionsPerSecond.toFixed(0)} actions/s  ` +
        `heap ${result.peakHeapMb.toFixed(0)} MB  ` +
        `records ${(result.recordBytes / 1024).toFixed(0)} KB  ` +
        `${(result.elapsedMs / 1000).toFixed(1)} s`,
    );
  }

  const reference = results[0];
  const identical = reference
    ? results.every((result) => result.fingerprint === reference.fingerprint)
    : false;
  console.log('');
  console.log(
    `results identical across worker counts: ${identical ? 'yes' : 'NO — this is a bug'}`,
  );
  if (reference && results.length > 1) {
    const best = results.reduce((a, b) => (a.matchesPerSecond >= b.matchesPerSecond ? a : b));
    console.log(
      `scaling: ${(best.matchesPerSecond / reference.matchesPerSecond).toFixed(2)}× at ${best.workers} workers`,
    );
  }
  if (!identical) process.exitCode = 1;
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
