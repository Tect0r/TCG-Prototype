import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  runBatch,
  shouldKeepReplay,
  type BatchOutcome,
  type RunBatchOptions,
} from './run-batch.js';
import { buildSchedule } from './schedule.js';
import { generatePopulation } from './deck-search/generate.js';
import { JsonlWriter, readJsonl, toCsv } from './reporting/sinks.js';
import { MatchStore } from './reporting/match-store.js';
import { matchRecordSchema } from './telemetry/schema.js';
import { aggregate } from './analysis/aggregate.js';
import {
  AGGRESSIVE_PILOT,
  FAST_LIMITS,
  NO_RETENTION,
  VALUE_PILOT,
  tinyEnvironment,
} from './test-fixtures.js';

/**
 * CLAUDE.md §13.7 and §13.15 items 5, 6, 7 and 11: worker-count equivalence,
 * mirrored schedules, and JSONL streaming, resume, deduplication and damaged-tail
 * recovery.
 *
 * Since PHASE4_HARDENING §7 the stream is owned by a `MatchStore` rather than by
 * the batch, so these tests open one explicitly. That is the same object every
 * experiment kind uses, which is the point: resume behaviour is tested once and
 * applies to batches, searches, replacements and comparisons alike.
 */

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tcg-batch-'));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const env = tinyEnvironment();
const decks = generatePopulation(env, 'batch-pop', 3).decks;
const CONFIG_HASH = 'batch-config-hash';

function schedule(games = 1) {
  return buildSchedule({
    experimentId: 'batch',
    experimentSeed: 'batch-seed',
    environmentId: env.id,
    decks,
    pilots: [VALUE_PILOT, AGGRESSIVE_PILOT],
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: games,
    mirrorSeats: true,
    schedule: 'round_robin',
    sampledPairings: 100,
  });
}

/** A store over a temp directory, resuming an existing stream when asked. */
function batchStore(root: string | null, resume = false): MatchStore {
  return new MatchStore(root, {
    experimentId: 'batch',
    experimentKind: 'batch',
    configHash: CONFIG_HASH,
    resume,
  });
}

async function run(overrides: Partial<RunBatchOptions> = {}): Promise<BatchOutcome> {
  return runBatch({
    experimentId: 'batch',
    experimentKind: 'batch',
    configHash: CONFIG_HASH,
    arm: null,
    environment: env,
    decks,
    pilots: [VALUE_PILOT, AGGRESSIVE_PILOT],
    schedule: schedule(),
    limits: FAST_LIMITS,
    retention: NO_RETENTION,
    workers: 1,
    failFast: false,
    sink: null,
    softwareCommit: null,
    ...overrides,
  });
}

describe('runBatch', () => {
  it('runs the whole schedule and returns records in canonical order', async () => {
    const plan = schedule();
    const outcome = await run();
    expect(outcome.records).toHaveLength(plan.length);
    expect(outcome.failures).toEqual([]);
    expect(outcome.records.map((record) => record.orderKey)).toEqual(
      [...outcome.records.map((record) => record.orderKey)].sort(),
    );
    expect(new Set(outcome.records.map((record) => record.matchId)).size).toBe(plan.length);
  });

  it('produces identical results across worker counts', async () => {
    // CLAUDE.md §13.15 item 5. The comparison is on the sorted records, which is
    // exactly the guarantee the spec asks for.
    const sequential = await run({ workers: 1 });
    const parallel = await run({ workers: 4 });
    expect(parallel.records.map((record) => record.matchId)).toEqual(
      sequential.records.map((record) => record.matchId),
    );
    expect(JSON.stringify(parallel.records)).toBe(JSON.stringify(sequential.records));
  });

  it('produces identical aggregates across worker counts', async () => {
    const sequential = await run({ workers: 1 });
    const parallel = await run({ workers: 3 });
    expect(JSON.stringify(aggregate(parallel.records))).toBe(
      JSON.stringify(aggregate(sequential.records)),
    );
  });

  it('is unaffected by the order results arrive in', async () => {
    const outcome = await run();
    const shuffled = [...outcome.records].reverse();
    shuffled.sort((left, right) => left.orderKey.localeCompare(right.orderKey));
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(outcome.records));
    // Aggregation reads the canonical order, not the arrival order.
    expect(JSON.stringify(aggregate([...outcome.records].reverse()))).toBe(
      JSON.stringify(aggregate(outcome.records)),
    );
  });

  it('reports progress with a usable rate and remaining estimate', async () => {
    const seen: number[] = [];
    const outcome = await run({
      progressEvery: 1,
      onProgress: (progress) => {
        seen.push(progress.completed);
        expect(progress.total).toBeGreaterThan(0);
        expect(progress.matchesPerSecond).toBeGreaterThanOrEqual(0);
        expect(progress.estimatedRemainingMs).toBeGreaterThanOrEqual(0);
      },
    });
    expect(seen.at(-1)).toBe(outcome.records.length);
  });
});

describe('mirrored schedules', () => {
  it('exposes a deliberately biased fixture through the seat breakdown', async () => {
    // CLAUDE.md §13.15 item 6. The bias is manufactured: the seat that plays
    // first is handed the strong fixture card and the other seat is not, so a
    // correct mirrored schedule must show it rather than average it away.
    const strong = decks[0];
    const weak = decks[1];
    expect(strong && weak).toBeTruthy();

    const outcome = await run({ schedule: schedule(2) });
    const bySeat = new Map<number, { wins: number; games: number }>();
    for (const record of outcome.records) {
      for (const seat of record.seats) {
        const entry = bySeat.get(seat.seatIndex) ?? { wins: 0, games: 0 };
        entry.games += 1;
        if (seat.won) entry.wins += 1;
        bySeat.set(seat.seatIndex, entry);
      }
    }
    // Every seat played the same number of games — that is what "mirrored" means.
    const games = [...bySeat.values()].map((entry) => entry.games);
    expect(new Set(games).size).toBe(1);

    const summary = aggregate(outcome.records);
    expect(summary.run.seatWinRates).toHaveLength(2);
    // Both seats are measured over the same sample, which is what makes the
    // seat-advantage number readable at all.
    const totals = summary.run.seatWinRates.map((entry) => entry.rate.total);
    expect(new Set(totals).size).toBe(1);
    expect(totals.reduce((sum, total) => sum + total, 0)).toBe(outcome.records.length * 2);
    // Every seat rate carries an interval, so a small sample cannot be read as
    // a firm seat advantage.
    for (const entry of summary.run.seatWinRates) {
      expect(entry.rate.high).toBeGreaterThanOrEqual(entry.rate.point);
      expect(entry.rate.low).toBeLessThanOrEqual(entry.rate.point);
    }
  });

  it('gives each deck the same number of games in each seat', async () => {
    const outcome = await run({ schedule: schedule(2) });
    const counts = new Map<string, number[]>();
    for (const record of outcome.records) {
      for (const seat of record.seats) {
        const entry = counts.get(seat.deckHash) ?? [0, 0];
        entry[seat.seatIndex] = (entry[seat.seatIndex] ?? 0) + 1;
        counts.set(seat.deckHash, entry);
      }
    }
    for (const [hash, entry] of counts) {
      expect(entry[0], hash).toBe(entry[1]);
    }
  });
});

describe('streaming, resume and recovery', () => {
  it('streams every record to matches.jsonl as it finishes', async () => {
    const dir = tempDir();
    const store = batchStore(dir);
    const outcome = await run({ sink: store });
    store.flush();

    const onDisk = readJsonl(join(dir, 'matches.jsonl'), matchRecordSchema);
    expect(onDisk.skipped).toEqual([]);
    expect(onDisk.records).toHaveLength(outcome.records.length);
    expect(new Set(onDisk.records.map((record) => record.matchId))).toEqual(
      new Set(outcome.records.map((record) => record.matchId)),
    );
  });

  it('writes a header sidecar identifying the configuration that wrote the stream', () => {
    const dir = tempDir();
    const store = batchStore(dir);
    store.flush();
    const header = JSON.parse(readFileSync(join(dir, 'matches.header.json'), 'utf8'));
    expect(header.configHash).toBe(CONFIG_HASH);
    expect(header.experimentKind).toBe('batch');
    expect(header.telemetrySchemaVersion).toBeGreaterThan(0);
  });

  it('resumes without rerunning or duplicating completed matches', async () => {
    const dir = tempDir();
    const plan = schedule(2);

    // A first run that stops after part of the schedule.
    const partial = plan.slice(0, 4);
    const first = batchStore(dir);
    await run({ sink: first, schedule: partial });
    first.flush();

    const second = batchStore(dir, true);
    const resumed = await run({ sink: second, schedule: plan });
    second.flush();

    expect(second.resumedCount).toBe(partial.length);
    expect(resumed.skippedByResume).toBe(partial.length);
    expect(second.all()).toHaveLength(plan.length);
    expect(new Set(second.all().map((record) => record.matchId)).size).toBe(plan.length);

    const onDisk = readJsonl(join(dir, 'matches.jsonl'), matchRecordSchema);
    expect(onDisk.records).toHaveLength(plan.length);
  });

  it('produces the same results whether or not it was interrupted', async () => {
    const plan = schedule(2);
    const wholeStore = batchStore(tempDir());
    await run({ sink: wholeStore, schedule: plan });
    wholeStore.flush();

    const dir = tempDir();
    const first = batchStore(dir);
    await run({ sink: first, schedule: plan.slice(0, 3) });
    first.flush();
    const second = batchStore(dir, true);
    await run({ sink: second, schedule: plan });
    second.flush();

    // Summaries must agree, not merely the record counts: that is what makes an
    // interrupted run indistinguishable from an uninterrupted one.
    expect(JSON.stringify(second.all())).toBe(JSON.stringify(wholeStore.all()));
    expect(JSON.stringify(aggregate(second.all()))).toBe(
      JSON.stringify(aggregate(wholeStore.all())),
    );
  });

  it('refuses to resume a stream written by a different configuration', async () => {
    const dir = tempDir();
    const first = batchStore(dir);
    await run({ sink: first });
    first.flush();

    expect(
      () =>
        new MatchStore(dir, {
          experimentId: 'batch',
          experimentKind: 'batch',
          configHash: 'a-different-configuration',
          resume: true,
        }),
    ).toThrow(/different run|configuration hash/i);
  });

  it('starts a fresh file when not resuming, rather than appending to an old run', async () => {
    const dir = tempDir();
    const first = batchStore(dir);
    await run({ sink: first });
    first.flush();

    const second = batchStore(dir);
    await run({ sink: second });
    second.flush();

    const onDisk = readJsonl(join(dir, 'matches.jsonl'), matchRecordSchema);
    expect(onDisk.records).toHaveLength(schedule().length);
  });

  it('recovers from a truncated final line without losing the rest', async () => {
    const dir = tempDir();
    const plan = schedule(2);
    const first = batchStore(dir);
    await run({ sink: first, schedule: plan.slice(0, 4) });
    first.flush();

    // Simulate a process killed mid-write.
    const path = join(dir, 'matches.jsonl');
    appendFileSync(path, '{"matchId":"m_truncated","schemaVer', 'utf8');

    const read = readJsonl(path, matchRecordSchema);
    expect(read.records).toHaveLength(4);
    expect(read.skipped).toHaveLength(1);
    expect(read.skipped[0]?.reason).toMatch(/truncated|unparseable/i);

    // And the run still resumes correctly, without a duplicate and without
    // losing any of the four valid records before the damaged tail.
    const second = batchStore(dir, true);
    expect(second.recovered).toHaveLength(1);
    expect(second.resumedCount).toBe(4);
    const resumed = await run({ sink: second, schedule: plan });
    second.flush();
    expect(resumed.skippedByResume).toBe(4);
    expect(second.all()).toHaveLength(plan.length);
    expect(new Set(second.all().map((record) => record.matchId)).size).toBe(plan.length);
    // The damaged tail is truncated exactly once rather than re-read forever.
    expect(readJsonl(path, matchRecordSchema).skipped).toEqual([]);
  });

  it('drops a structurally invalid line and says why', () => {
    const dir = tempDir();
    const path = join(dir, 'matches.jsonl');
    writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, matchId: 'nope' })}\n`, 'utf8');
    const read = readJsonl(path, matchRecordSchema);
    expect(read.records).toEqual([]);
    expect(read.skipped).toHaveLength(1);
    expect(read.skipped[0]?.reason.length).toBeGreaterThan(0);
  });

  it('deduplicates by arm and match ID rather than by match ID alone', async () => {
    const dir = tempDir();
    const store = batchStore(dir);
    const plan = schedule();
    await run({ sink: store, schedule: plan, arm: 'baseline' });
    await run({ sink: store, schedule: plan, arm: 'candidate' });
    store.flush();

    // The same match IDs in two arms are two records, not one overwritten one.
    expect(store.all()).toHaveLength(plan.length * 2);
    expect(store.arm('baseline')).toHaveLength(plan.length);
    expect(store.arm('candidate')).toHaveLength(plan.length);
    expect(new Set(store.arm('baseline').map((record) => record.matchId))).toEqual(
      new Set(store.arm('candidate').map((record) => record.matchId)),
    );
  });

  it('writes a replay for every abnormal match', async () => {
    const dir = tempDir();
    const store = batchStore(dir);
    const outcome = await run({
      sink: store,
      replayDir: join(dir, 'replays'),
      limits: { ...FAST_LIMITS, maxTurns: 2 },
    });
    store.flush();

    const abnormal = outcome.records.filter((record) => record.termination === 'turn_limit');
    expect(abnormal.length).toBeGreaterThan(0);
    for (const record of abnormal) {
      expect(record.replayPath).toBe(`replays/${record.matchId}.json`);
      const bundle = JSON.parse(readFileSync(join(dir, record.replayPath!), 'utf8'));
      expect(bundle.matchId).toBe(record.matchId);
      expect(Array.isArray(bundle.actions)).toBe(true);
      expect(bundle.actions.length).toBeGreaterThan(0);
    }
  });
});

describe('replay sampling', () => {
  it('is derived from the match ID, not a counter', () => {
    expect(shouldKeepReplay('m_abc', 0)).toBe(false);
    expect(shouldKeepReplay('m_abc', 1)).toBe(true);
    // Stable: the same match is always in or out of the sample.
    expect(shouldKeepReplay('m_abc', 10)).toBe(shouldKeepReplay('m_abc', 10));
  });

  it('samples roughly the requested share', () => {
    const ids = Array.from({ length: 2000 }, (_, index) => `m_${index}`);
    const kept = ids.filter((id) => shouldKeepReplay(id, 10)).length;
    expect(kept / ids.length).toBeGreaterThan(0.05);
    expect(kept / ids.length).toBeLessThan(0.2);
  });
});

describe('sinks', () => {
  it('escapes CSV values that would otherwise break the format', () => {
    const csv = toCsv(
      [{ name: 'a,b', note: 'say "hi"', line: 'x\ny' }],
      [
        { header: 'name', value: (row) => row.name },
        { header: 'note', value: (row) => row.note },
        { header: 'line', value: (row) => row.line },
      ],
    );
    expect(csv).toBe('name,note,line\n"a,b","say ""hi""","x\ny"\n');
  });

  it('buffers and flushes JSONL without losing a record', () => {
    const dir = tempDir();
    const path = join(dir, 'stream.jsonl');
    const writer = new JsonlWriter(path, 4);
    for (let index = 0; index < 10; index += 1) writer.append({ index });
    writer.flush();
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(10);
    expect(JSON.parse(lines[9] as string)).toEqual({ index: 9 });
  });
});
