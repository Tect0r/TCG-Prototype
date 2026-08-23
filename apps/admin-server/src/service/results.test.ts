import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageRequestSchema, type JobId } from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';
import { experimentPaths } from '@tcg/simulator';

import {
  makeTestCatalog,
  testConfig,
  testIdentity,
  type TestCatalog,
} from '../catalog/test-catalog.js';
import { ResultReader, decodeRowCursor, encodeRowCursor } from './results.js';

/**
 * Reading a run through the boundary, from the run's own files.
 *
 * The fixtures below are hand-written `manifest.json` and `summary.json`
 * documents rather than a real experiment, and that is the right trade here: what
 * is being tested is the **projection and the refusals**, not whether the
 * simulator can play a batch — which `job-runner.test.ts` already drives through
 * `runExperiment` for real. What a fixture must not do is drift from the shape
 * the simulator writes, so every field below is one `aggregate.ts` and
 * `experiment.ts` actually produce, and the reader's own schemas would refuse a
 * document missing any of them.
 */

let catalog: TestCatalog;
let reader: ResultReader;

beforeEach(async () => {
  catalog = await makeTestCatalog();
  reader = new ResultReader({ store: catalog.store, roots: catalog.roots });
});

afterEach(async () => {
  await catalog.dispose();
});

const page = pageRequestSchema.parse({});

function rate(point: number, total: number): Record<string, number> {
  return {
    point,
    low: point - 0.1,
    high: point + 0.1,
    successes: Math.round(point * total),
    total,
    margin: 0.1,
  };
}

function summaryDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 7,
    configHash: 'abcdef0123456789',
    aggregate: {
      run: {
        matches: 16,
        usableMatches: 15,
        abnormalMatches: 1,
        abnormalShare: 0.0625,
        terminations: { last_player_standing: 14, draw: 1, turn_limit: 1 },
        endReasons: { defeat: 14 },
        draws: 1,
        turns: { mean: 12.5, median: 12, p10: 8, p90: 18, max: 22 },
        decisionsPerMatch: 44.2,
        botFailures: 0,
        seatWinRates: [
          { seatIndex: 0, rate: rate(0.55, 15) },
          { seatIndex: 1, rate: rate(0.45, 15) },
        ],
        pilotWinRates: [{ pilotId: 'aggressive', rate: rate(0.5, 30) }],
        agentClassWinRates: [
          { agentClass: 'heuristic', pilotIds: ['aggressive'], rate: rate(0.5, 30) },
        ],
        environments: ['baseline'],
      },
      decks: [
        {
          deckId: 'bastion',
          deckHash: 'aaaa1111',
          commanderId: 'cmd_bastion',
          matches: 15,
          winRate: rate(0.6, 15),
          averageTurns: 12.5,
          averageDamageDealt: 24,
          averageDamageTaken: 21,
        },
        {
          deckId: 'goblins',
          deckHash: 'bbbb2222',
          commanderId: 'cmd_goblin',
          matches: 15,
          winRate: rate(0.4, 15),
          averageTurns: 12.5,
          averageDamageDealt: 21,
          averageDamageTaken: 24,
        },
      ],
      matchups: [{ deckHash: 'aaaa1111', opponentHash: 'bbbb2222', rate: rate(0.6, 15) }],
      cards: [
        {
          definitionId: 'card_one',
          decksIncluding: 2,
          seatMatches: 30,
          copiesPerDeck: 1,
          winRateWhenIncluded: rate(0.5, 30),
          winRateWhenAbsent: rate(0.5, 0),
          inclusionWinRateLift: 0,
          drawRate: 0.4,
          playsPerDraw: 0.9,
          gamesDrawnAndPlayedShare: 0.8,
          gamesDrawn: 12,
          activationsPerMatch: 0.3,
          averageEnergySpent: 2.1,
          deadInHandShare: 0.1,
          mechanicallyUnusableShare: 0.05,
          strategicallyUnusedShare: 0.05,
          removalRate: 0.2,
        },
      ],
    },
    calibration: {
      schemaVersion: 1,
      standing: 'calibration',
      reasons: ['No pilot in this build carries a final balance conclusion.'],
      promotionRequires:
        'A run stops being calibration only when every class that flew it carries it.',
    },
    ...overrides,
  };
}

function manifestDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const identity = testIdentity();
  return {
    schemaVersion: 8,
    experimentId: identity.experimentId,
    kind: identity.kind,
    seed: identity.seed,
    configHash: identity.configHash,
    softwareCommit: identity.softwareCommit,
    environments: [
      { id: identity.environments[0]?.environmentId, hashes: identity.environments[0]?.hashes },
    ],
    matches: 16,
    abnormalMatches: 1,
    failedMatches: 0,
    resumedMatches: 3,
    ...overrides,
  };
}

/** A job with a directory on disk, a manifest, a summary and a result reference. */
async function seedRun(
  options: {
    readonly directory?: string;
    readonly summary?: Record<string, unknown> | null;
    readonly manifest?: Record<string, unknown> | null;
    readonly attach?: boolean;
    readonly preset?: boolean;
  } = {},
): Promise<JobId> {
  const directory = options.directory ?? 'run-1';
  const batch = unwrap(await catalog.store.createBatch({ label: 'August sweep' }));
  const job = unwrap(
    await catalog.store.createJob({
      batchId: batch.batchId,
      label: 'Precon Smoke',
      purpose: 'exploration',
      sourceClasses: ['ai', 'precon'],
      config: testConfig(),
      ...(options.preset === false
        ? {}
        : { origin: { kind: 'preset', presetId: 'precon_smoke', stageId: 'matches' } as const }),
    }),
  );

  const full = join(catalog.resultRoot, directory);
  await mkdir(full, { recursive: true });
  const paths = experimentPaths(full);
  if (options.summary !== null) {
    await writeFile(paths.summary, JSON.stringify(options.summary ?? summaryDocument()), 'utf8');
  }
  if (options.manifest !== null) {
    await writeFile(paths.manifest, JSON.stringify(options.manifest ?? manifestDocument()), 'utf8');
  }

  if (options.attach !== false) {
    unwrap(
      await catalog.store.attachJobResult(job.jobId, {
        identity: testIdentity(),
        location: { rootId: 'local', directory },
      }),
    );
  }
  return job.jobId;
}

describe('a run summary', () => {
  it('is read out of the run’s own files, with the identity the manifest declares', async () => {
    const jobId = await seedRun();
    const summary = unwrap(await reader.readSummary(jobId));

    expect(summary.jobId).toBe(jobId);
    expect(summary.source).toEqual({ document: 'summary.json', schemaVersion: 7 });
    expect(summary.identity.manifestSchemaVersion).toBe(8);
    expect(summary.identity.softwareCommit).toBe('2b1a6ec');
  });

  it('reports the denominators a reader needs before treating a rate as evidence', async () => {
    const jobId = await seedRun();
    const summary = unwrap(await reader.readSummary(jobId));

    expect(summary.denominators.matches).toBe(16);
    expect(summary.denominators.usableMatches).toBe(15);
    expect(summary.denominators.abnormalMatches).toBe(1);
    // From the manifest rather than the aggregate: the summary does not hold them.
    expect(summary.denominators.resumedMatches).toBe(3);
    // Split by kind, so "excluded" is never one opaque number — and `draw` is not
    // in it, because a draw is a result rather than an exclusion.
    expect(summary.denominators.abnormalByKind).toEqual({ turn_limit: 1 });
  });

  it('carries the calibration standing, and the sentence that says what would change it', async () => {
    const jobId = await seedRun();
    const summary = unwrap(await reader.readSummary(jobId));
    expect(summary.evidence.standing).toBe('calibration');
    expect(summary.evidence.promotionRequires).toContain('only when every class');
  });

  it('carries the preset’s published limitations, reached through the job’s origin', async () => {
    const jobId = await seedRun();
    const summary = unwrap(await reader.readSummary(jobId));
    expect(summary.limitations.length).toBeGreaterThan(0);
    expect(summary.limitations[0]).toContain('termination and determinism check');
  });

  it('carries none for a job that came from a configuration rather than a preset', async () => {
    // Truthful rather than empty-because-unimplemented: a hand-assembled
    // configuration has made no published claim to caveat.
    const jobId = await seedRun({ preset: false });
    const summary = unwrap(await reader.readSummary(jobId));
    expect(summary.limitations).toEqual([]);
  });

  it('says how many rows each table has, so a client does not fetch seven empty pages', async () => {
    const jobId = await seedRun();
    const summary = unwrap(await reader.readSummary(jobId));
    expect(summary.tables).toEqual([
      { table: 'decks', rows: 2 },
      { table: 'matchups', rows: 1 },
      { table: 'cards', rows: 1 },
      { table: 'seats', rows: 2 },
      { table: 'pilots', rows: 1 },
      { table: 'agent_classes', rows: 1 },
      { table: 'terminations', rows: 3 },
    ]);
  });

  it('never carries a directory, a root identifier or a path', async () => {
    const jobId = await seedRun();
    const rendered = JSON.stringify(unwrap(await reader.readSummary(jobId)));
    expect(rendered).not.toContain('run-1');
    expect(rendered).not.toContain('rootId');
    expect(rendered).not.toContain(catalog.resultRoot.replace(/\\/g, '\\\\'));
  });
});

describe('what a run summary refuses', () => {
  it('a job with no result attached', async () => {
    const jobId = await seedRun({ attach: false });
    const refused = await reader.readSummary(jobId);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
    expect(isErr(refused) && refused.error[0]?.message).toContain('no canonical result yet');
  });

  it('a run whose summary is gone', async () => {
    const jobId = await seedRun({ summary: null });
    const refused = await reader.readSummary(jobId);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
    expect(isErr(refused) && refused.error[0]?.message).toContain('raw records are still');
  });

  it('a run whose summary is not readable JSON', async () => {
    const jobId = await seedRun();
    await writeFile(
      experimentPaths(join(catalog.resultRoot, 'run-1')).summary,
      '{ half a docum',
      'utf8',
    );
    const refused = await reader.readSummary(jobId);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
  });

  it('a run written before the calibration standing existed', async () => {
    // The milestone's result rules put evidence-claim and calibration standing
    // among the things visible *before* a reader may treat a number as evidence.
    // Serving the numbers with the field omitted would invite exactly the reading
    // that rule forbids.
    const jobId = await seedRun({ summary: summaryDocument({ calibration: null }) });
    const refused = await reader.readSummary(jobId);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
    expect(isErr(refused) && refused.error[0]?.message).toContain(
      'before the calibration standing',
    );
  });

  it('a directory that now declares a different run', async () => {
    const jobId = await seedRun();
    await writeFile(
      experimentPaths(join(catalog.resultRoot, 'run-1')).manifest,
      JSON.stringify(manifestDocument({ configHash: 'ffffffffffffffff' })),
      'utf8',
    );
    const refused = await reader.readSummary(jobId);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
    expect(isErr(refused) && refused.error[0]?.message).toContain('no longer declares the run');
  });

  it('a directory that has become a link out of the configured root', async () => {
    // The reference was checked when it was attached. This is the case that check
    // cannot cover: a link created afterwards. ADR 0023 §5 says a resolved real
    // path is checked *before it is used*, which means on every read.
    const jobId = await seedRun();
    const outside = join(catalog.catalogRoot, '..', 'outside-run');
    await mkdir(outside, { recursive: true });
    await rm(join(catalog.resultRoot, 'run-1'), { recursive: true, force: true });

    let linked = true;
    try {
      await symlink(
        outside,
        join(catalog.resultRoot, 'run-1'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      linked = false;
    }
    if (!linked) {
      // Recorded rather than skipped quietly: a security test that looks green
      // without running is worse than one that admits it did not.
      expect(process.platform).toBe('win32');
      return;
    }

    const refused = await reader.readSummary(jobId);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/unsafe_result_reference');
  });
});

describe('a result table', () => {
  it('declares its columns and carries only cells that belong to one', async () => {
    const jobId = await seedRun();
    const table = unwrap(await reader.readTable(jobId, 'decks', page));
    const keys = new Set(
      table.columns.flatMap((column) => [
        column.key,
        ...(column.bounds === null ? [] : [column.bounds.low, column.bounds.high]),
      ]),
    );
    for (const row of table.rows) {
      for (const key of Object.keys(row)) expect([...keys]).toContain(key);
    }
  });

  it('carries an interval’s bounds beside its point estimate', async () => {
    const jobId = await seedRun();
    const table = unwrap(await reader.readTable(jobId, 'decks', page));
    const winRate = table.columns.find((column) => column.key === 'winRate');
    expect(winRate?.kind).toBe('interval');
    expect(table.rows[0]?.[winRate?.bounds?.low ?? '']).toBeCloseTo(0.5);
  });

  it('keeps the pilot and agent-class readings in separate tables', async () => {
    // M05.4: an agent class is reported *beside* a pilot and never averaged with
    // it, because `random_legal` and a heuristic are two instruments rather than
    // two skill levels.
    const jobId = await seedRun();
    const pilots = unwrap(await reader.readTable(jobId, 'pilots', page));
    const classes = unwrap(await reader.readTable(jobId, 'agent_classes', page));
    expect(pilots.columns.map((column) => column.key)).toContain('pilotId');
    expect(classes.columns.map((column) => column.key)).toContain('agentClass');
    expect(pilots.columns.map((column) => column.key)).not.toContain('agentClass');
  });

  it('marks which terminations are excluded from the statistics', async () => {
    const jobId = await seedRun();
    const table = unwrap(await reader.readTable(jobId, 'terminations', page));
    const rows = new Map(table.rows.map((row) => [row.kind, row.abnormal]));
    expect(rows.get('turn_limit')).toBe(true);
    expect(rows.get('draw')).toBe(false);
    expect(rows.get('last_player_standing')).toBe(false);
  });

  it('pages, and stops when it is exhausted', async () => {
    const jobId = await seedRun();
    const first = unwrap(
      await reader.readTable(jobId, 'decks', pageRequestSchema.parse({ limit: 1 })),
    );
    expect(first.rows).toHaveLength(1);
    expect(first.page.total).toBe(2);
    expect(first.page.nextCursor).not.toBeNull();

    const second = unwrap(
      await reader.readTable(
        jobId,
        'decks',
        pageRequestSchema.parse({ limit: 1, cursor: first.page.nextCursor }),
      ),
    );
    expect(second.rows[0]?.deckId).toBe('goblins');
    expect(second.page.nextCursor).toBeNull();
  });

  it('refuses a continuation token this build did not issue', async () => {
    const jobId = await seedRun();
    const refused = await reader.readTable(
      jobId,
      'decks',
      pageRequestSchema.parse({ cursor: 'bm90LWEtY3Vyc29y' }),
    );
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/invalid_cursor');
  });

  it('issues a token that is opaque and cannot carry a path', async () => {
    const token = encodeRowCursor(50);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(unwrap(decodeRowCursor(token))).toBe(50);
  });
});
