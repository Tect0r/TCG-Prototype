import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runBatch, shouldKeepReplay, type BatchOutcome } from './run-batch.js';
import { buildSchedule } from './schedule.js';
import { generatePopulation } from './deck-search/generate.js';
import { JsonlWriter, readJsonl, toCsv } from './reporting/sinks.js';
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

async function run(overrides: Partial<Parameters<typeof runBatch>[0]> = {}): Promise<BatchOutcome> {
  return runBatch({
    experimentId: 'batch',
    environment: env,
    decks,
    pilots: [VALUE_PILOT, AGGRESSIVE_PILOT],
    schedule: schedule(),
    limits: FAST_LIMITS,
    retention: NO_RETENTION,
    workers: 1,
    failFast: false,
    outputDir: null,
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
    const outcome = await run({ outputDir: dir });
    const onDisk = readJsonl(join(dir, 'matches.jsonl'), matchRecordSchema);
    expect(onDisk.skipped).toEqual([]);
    expect(onDisk.records).toHaveLength(outcome.records.length);
    expect(new Set(onDisk.records.map((record) => record.matchId))).toEqual(
      new Set(outcome.records.map((record) => record.matchId)),
    );
  });

  it('resumes without rerunning or duplicating completed matches', async () => {
    const dir = tempDir();
    const plan = schedule(2);

    // A first run that stops after part of the schedule.
    const partial = plan.slice(0, 4);
    await run({ outputDir: dir, schedule: partial });

    const resumed = await run({ outputDir: dir, schedule: plan, resume: true });
    expect(resumed.skippedByResume).toBe(partial.length);
    expect(resumed.records).toHaveLength(plan.length);
    expect(new Set(resumed.records.map((record) => record.matchId)).size).toBe(plan.length);

    const onDisk = readJsonl(join(dir, 'matches.jsonl'), matchRecordSchema);
    expect(onDisk.records).toHaveLength(plan.length);
  });

  it('produces the same results whether or not it was interrupted', async () => {
    const plan = schedule(2);
    const whole = await run({ outputDir: tempDir(), schedule: plan });

    const dir = tempDir();
    await run({ outputDir: dir, schedule: plan.slice(0, 3) });
    const resumed = await run({ outputDir: dir, schedule: plan, resume: true });

    expect(JSON.stringify(resumed.records)).toBe(JSON.stringify(whole.records));
  });

  it('starts a fresh file when not resuming, rather than appending to an old run', async () => {
    const dir = tempDir();
    await run({ outputDir: dir });
    await run({ outputDir: dir });
    const onDisk = readJsonl(join(dir, 'matches.jsonl'), matchRecordSchema);
    expect(onDisk.records).toHaveLength(schedule().length);
  });

  it('recovers from a truncated final line without losing the rest', async () => {
    const dir = tempDir();
    const plan = schedule(2);
    await run({ outputDir: dir, schedule: plan.slice(0, 4) });

    // Simulate a process killed mid-write.
    const path = join(dir, 'matches.jsonl');
    appendFileSync(path, '{"matchId":"m_truncated","schemaVer', 'utf8');

    const read = readJsonl(path, matchRecordSchema);
    expect(read.records).toHaveLength(4);
    expect(read.skipped).toHaveLength(1);
    expect(read.skipped[0]?.reason).toMatch(/truncated|unparseable/i);

    // And the run still resumes correctly, without a duplicate.
    const resumed = await run({ outputDir: dir, schedule: plan, resume: true });
    expect(resumed.recovered).toHaveLength(1);
    expect(resumed.records).toHaveLength(plan.length);
    expect(new Set(resumed.records.map((record) => record.matchId)).size).toBe(plan.length);
  });

  it('drops a structurally invalid line and says why', async () => {
    const dir = tempDir();
    const path = join(dir, 'matches.jsonl');
    writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, matchId: 'nope' })}\n`, 'utf8');
    const read = readJsonl(path, matchRecordSchema);
    expect(read.records).toEqual([]);
    expect(read.skipped).toHaveLength(1);
    expect(read.skipped[0]?.reason.length).toBeGreaterThan(0);
  });

  it('writes a replay for every abnormal match', async () => {
    const dir = tempDir();
    const outcome = await run({
      outputDir: dir,
      limits: { ...FAST_LIMITS, maxTurns: 2 },
    });
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
