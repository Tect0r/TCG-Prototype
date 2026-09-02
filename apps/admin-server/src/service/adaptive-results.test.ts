import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adaptiveExperimentIdSchema, pageRequestSchema } from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';

import { resolveCatalogRoots } from '../catalog/roots.js';
import {
  AdaptiveResultReader,
  readAdaptiveSummary,
  readAdaptiveTable,
} from './adaptive-results.js';

/**
 * Reading a directory-keyed Adaptive Counter run (M08.19B), from the run's
 * own `adaptive-result.json`/`adaptive-checkpoint.json` files.
 *
 * The fixtures below are hand-written documents rather than a real run — what
 * is under test is the **projection and the refusals**, not whether the
 * adaptive loop can actually play a block. Every field below is one
 * `apps/simulator/src/adaptive/report.ts`, `checkpoint.ts` or `envelopes.ts`
 * actually defines, and the reader's own strict schemas would refuse a
 * document missing any of them.
 */

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tcg-admin-adaptive-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const page = pageRequestSchema.parse({});

function deck(commanderId: string, hash: string): Record<string, unknown> {
  return {
    id: `d_${hash}`,
    label: `deck ${hash}`,
    commanderId,
    cards: [{ cardId: 'card_one', quantity: 1 }],
    hash,
  };
}

function revision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revisionId: 'rev_root_incumbent',
    experimentId: 'goblin_counter',
    parentRevisionId: null,
    generation: 0,
    block: 0,
    opponentRevisionId: null,
    construction: 'root',
    swaps: [],
    seedPath: 'seed|adaptive:goblin_counter|gen:0000|block:0000',
    deck: deck('cmd_bastion', 'aaaa1111'),
    ...overrides,
  };
}

function screeningTally(
  candidateWins: number,
  opponentWins: number,
  noResult = 0,
): Record<string, unknown> {
  return { candidateWins, opponentWins, noResult };
}

function proportion(point: number, total: number): Record<string, unknown> {
  return {
    point,
    low: Math.max(0, point - 0.1),
    high: Math.min(1, point + 0.1),
    successes: Math.round(point * total),
    total,
    margin: 0.1,
  };
}

function resultDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const incumbentRoot = revision();
  const opponentRoot = revision({
    revisionId: 'rev_root_opponent',
    deck: deck('cmd_goblin', 'bbbb2222'),
  });
  const opponentSwap = revision({
    revisionId: 'rev_opponent_swap_1',
    parentRevisionId: 'rev_root_opponent',
    generation: 1,
    block: 1,
    opponentRevisionId: 'rev_root_incumbent',
    construction: 'swap',
    swaps: [{ cardOut: 'card_one', cardIn: 'card_two' }],
    deck: deck('cmd_goblin', 'cccc3333'),
  });

  return {
    schemaVersion: 3,
    experimentId: 'goblin_counter',
    configHash: 'abcdef0123456789',
    informationPolicy: 'public_observation',
    lineages: {
      incumbent: [incumbentRoot],
      opponent: [opponentRoot, opponentSwap],
    },
    seriesTally: { incumbentWins: 1, opponentWins: 0, ties: 0, noDecisions: 0 },
    series: [
      {
        generation: 0,
        block: 0,
        incumbentRevisionId: 'rev_root_incumbent',
        opponentRevisionId: 'rev_root_opponent',
        incumbentDeckHash: 'aaaa1111',
        opponentDeckHash: 'bbbb2222',
        decision: { kind: 'win', loser: 'opponent' },
      },
    ],
    screeningRounds: [
      {
        generation: 1,
        block: 1,
        loserSide: 'opponent',
        opponentRevisionId: 'rev_root_incumbent',
        candidates: [
          {
            revisionId: 'rev_opponent_swap_1',
            objective: 'pure_counter',
            opponentTally: screeningTally(3, 1),
            fieldTally: null,
            score: proportion(0.75, 4),
          },
        ],
        decision: { kind: 'promoted', revisionId: 'rev_opponent_swap_1' },
      },
    ],
    referenceField: null,
    finalDeckDiff: {
      incumbent: {
        rootRevisionId: 'rev_root_incumbent',
        finalRevisionId: 'rev_root_incumbent',
        swaps: [],
        commanderChanged: false,
      },
      opponent: {
        rootRevisionId: 'rev_root_opponent',
        finalRevisionId: 'rev_opponent_swap_1',
        swaps: [{ cardOut: 'card_one', cardIn: 'card_two' }],
        commanderChanged: false,
      },
    },
    cycles: [],
    validation: null,
    ...overrides,
  };
}

function checkpointDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const incumbentRoot = revision();
  const opponentSwap = revision({
    revisionId: 'rev_opponent_swap_1',
    parentRevisionId: 'rev_root_opponent',
    generation: 1,
    block: 1,
    opponentRevisionId: 'rev_root_incumbent',
    construction: 'swap',
    swaps: [{ cardOut: 'card_one', cardIn: 'card_two' }],
    deck: deck('cmd_goblin', 'cccc3333'),
  });
  const opponentRoot = revision({
    revisionId: 'rev_root_opponent',
    deck: deck('cmd_goblin', 'bbbb2222'),
  });

  return {
    schemaVersion: 2,
    experimentId: 'goblin_counter',
    configHash: 'abcdef0123456789',
    lineages: {
      incumbent: { activeRevisionId: 'rev_root_incumbent', revisions: [incumbentRoot] },
      opponent: {
        activeRevisionId: 'rev_opponent_swap_1',
        revisions: [opponentRoot, opponentSwap],
      },
    },
    gamesSpent: 8,
    referenceField: [],
    pendingGeneration: null,
    nextGeneration: 2,
    nextBlock: 2,
    nextSeedPath: 'seed|adaptive:goblin_counter|gen:0002|block:0002',
    ...overrides,
  };
}

describe('an adaptive run summary', () => {
  it('is read out of the run’s own result document', async () => {
    await writeFile(
      join(directory, 'adaptive-result.json'),
      JSON.stringify(resultDocument()),
      'utf8',
    );
    const summary = unwrap(await readAdaptiveSummary(directory));

    expect(summary.experimentId).toBe('goblin_counter');
    expect(summary.configHash).toBe('abcdef0123456789');
    expect(summary.source).toEqual({ document: 'adaptive-result.json', schemaVersion: 3 });
    expect(summary.informationPolicy).toBe('public_observation');
  });

  it('reports readings read straight off the payload, never recomputed', async () => {
    await writeFile(
      join(directory, 'adaptive-result.json'),
      JSON.stringify(resultDocument()),
      'utf8',
    );
    const summary = unwrap(await readAdaptiveSummary(directory));
    const readings = new Map(summary.readings.map((entry) => [entry.key, entry.value]));

    expect(readings.get('seriesIncumbentWins')).toBe(1);
    expect(readings.get('seriesOpponentWins')).toBe(0);
    expect(readings.get('blocksDecided')).toBe(1);
    expect(readings.get('generationsScreened')).toBe(1);
    expect(readings.get('incumbentRevisions')).toBe(1);
    expect(readings.get('opponentRevisions')).toBe(2);
    expect(readings.get('repeatedStates')).toBe(0);
  });

  it('says how many rows each table has', async () => {
    await writeFile(
      join(directory, 'adaptive-result.json'),
      JSON.stringify(resultDocument()),
      'utf8',
    );
    const summary = unwrap(await readAdaptiveSummary(directory));
    expect(summary.tables).toEqual([
      { table: 'series', rows: 1 },
      { table: 'revisions', rows: 3 },
      { table: 'screening_candidates', rows: 1 },
      { table: 'deck_diff', rows: 2 },
      { table: 'cycles', rows: 0 },
      { table: 'reference_field', rows: 0 },
      { table: 'validation', rows: 0 },
    ]);
  });

  it('carries fixed limitations that name no calibration or evidence-claim standing', async () => {
    await writeFile(
      join(directory, 'adaptive-result.json'),
      JSON.stringify(resultDocument()),
      'utf8',
    );
    const summary = unwrap(await readAdaptiveSummary(directory));
    expect(summary.limitations.length).toBeGreaterThan(0);
    expect(summary.limitations.join(' ')).toContain('no calibration standing');
  });
});

describe('what an adaptive summary refuses', () => {
  it('a directory with no result document yet, using the checkpoint only as context', async () => {
    await writeFile(
      join(directory, 'adaptive-checkpoint.json'),
      JSON.stringify(checkpointDocument()),
      'utf8',
    );
    const refused = await readAdaptiveSummary(directory);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
    expect(isErr(refused) && refused.error[0]?.message).toContain('no canonical result yet');
    const context = isErr(refused) ? (refused.error[0]?.context as Record<string, unknown>) : {};
    expect(context.gamesSpent).toBe(8);
    expect(context.pendingGeneration).toBe(false);
    expect(context.incumbentRevisions).toBe(1);
    expect(context.opponentRevisions).toBe(2);
  });

  it('a directory with neither document', async () => {
    const refused = await readAdaptiveSummary(directory);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
    expect(isErr(refused) && refused.error[0]?.context).toBeUndefined();
  });

  it('a result document that is not readable JSON', async () => {
    await writeFile(join(directory, 'adaptive-result.json'), '{ half a docum', 'utf8');
    const refused = await readAdaptiveSummary(directory);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
  });

  it('a result document declaring a schema version this build does not own', async () => {
    await writeFile(
      join(directory, 'adaptive-result.json'),
      JSON.stringify(resultDocument({ schemaVersion: 99 })),
      'utf8',
    );
    const refused = await readAdaptiveSummary(directory);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/unsupported_version');
  });

  it('a result document missing fields the schema requires', async () => {
    const broken = resultDocument();
    delete (broken as { seriesTally?: unknown }).seriesTally;
    await writeFile(join(directory, 'adaptive-result.json'), JSON.stringify(broken), 'utf8');
    const refused = await readAdaptiveSummary(directory);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
  });

  it('never lets a bad checkpoint stand in as context for a bad result', async () => {
    await writeFile(
      join(directory, 'adaptive-checkpoint.json'),
      JSON.stringify(checkpointDocument({ schemaVersion: 99 })),
      'utf8',
    );
    const refused = await readAdaptiveSummary(directory);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
    expect(isErr(refused) && refused.error[0]?.context).toBeUndefined();
  });
});

describe('an adaptive result table', () => {
  it('declares its columns and carries only cells that belong to one', async () => {
    await writeFile(
      join(directory, 'adaptive-result.json'),
      JSON.stringify(resultDocument()),
      'utf8',
    );
    const table = unwrap(await readAdaptiveTable(directory, 'screening_candidates', page));
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

  it('keeps the two lineages in one revisions table, distinguished by side', async () => {
    await writeFile(
      join(directory, 'adaptive-result.json'),
      JSON.stringify(resultDocument()),
      'utf8',
    );
    const table = unwrap(await readAdaptiveTable(directory, 'revisions', page));
    expect(table.rows).toHaveLength(3);
    expect(table.rows.filter((row) => row.side === 'incumbent')).toHaveLength(1);
    expect(table.rows.filter((row) => row.side === 'opponent')).toHaveLength(2);
  });

  it('reads a null fieldTally as null cells, never a fabricated zero', async () => {
    await writeFile(
      join(directory, 'adaptive-result.json'),
      JSON.stringify(resultDocument()),
      'utf8',
    );
    const table = unwrap(await readAdaptiveTable(directory, 'screening_candidates', page));
    expect(table.rows[0]?.fieldTallyCandidateWins).toBeNull();
    expect(table.rows[0]?.fieldTallyOpponentWins).toBeNull();
    expect(table.rows[0]?.fieldTallyNoResult).toBeNull();
  });

  it('reads reference_field as zero rows, never a null-filled row, when the run recorded none', async () => {
    await writeFile(
      join(directory, 'adaptive-result.json'),
      JSON.stringify(resultDocument()),
      'utf8',
    );
    const table = unwrap(await readAdaptiveTable(directory, 'reference_field', page));
    expect(table.rows).toEqual([]);
  });

  it('carries a reference_field standing when the run recorded one, with its bounds beside the point estimate', async () => {
    await writeFile(
      join(directory, 'adaptive-result.json'),
      JSON.stringify(
        resultDocument({
          referenceField: {
            gamesPlayed: 10,
            candidateWins: 6,
            opponentWins: 3,
            noResult: 1,
            standing: proportion(0.6, 9),
          },
        }),
      ),
      'utf8',
    );
    const table = unwrap(await readAdaptiveTable(directory, 'reference_field', page));
    expect(table.rows).toHaveLength(1);
    const standing = table.columns.find((column) => column.key === 'standing');
    expect(standing?.kind).toBe('interval');
    expect(table.rows[0]?.gamesPlayed).toBe(10);
  });

  it('keeps validation on its own table, separate from the series score', async () => {
    await writeFile(
      join(directory, 'adaptive-result.json'),
      JSON.stringify(
        resultDocument({
          validation: {
            incumbentRevisionId: 'rev_root_incumbent',
            opponentRevisionId: 'rev_opponent_swap_1',
            incumbentWins: 4,
            opponentWins: 2,
            noResult: 0,
            standing: proportion(0.667, 6),
          },
        }),
      ),
      'utf8',
    );
    const validation = unwrap(await readAdaptiveTable(directory, 'validation', page));
    const series = unwrap(await readAdaptiveTable(directory, 'series', page));
    expect(validation.rows).toHaveLength(1);
    expect(validation.rows[0]?.incumbentWins).toBe(4);
    expect(series.rows).toHaveLength(1);
    expect(series.columns.map((column) => column.key)).not.toContain('incumbentWins');
  });

  it('renders a no-decision block’s reason and a null loser', async () => {
    await writeFile(
      join(directory, 'adaptive-result.json'),
      JSON.stringify(
        resultDocument({
          series: [
            {
              generation: 0,
              block: 0,
              incumbentRevisionId: 'rev_root_incumbent',
              opponentRevisionId: 'rev_root_opponent',
              incumbentDeckHash: 'aaaa1111',
              opponentDeckHash: 'bbbb2222',
              decision: { kind: 'no_decision', reason: 'no game was scheduled for this block' },
            },
          ],
        }),
      ),
      'utf8',
    );
    const table = unwrap(await readAdaptiveTable(directory, 'series', page));
    expect(table.rows[0]?.decisionKind).toBe('no_decision');
    expect(table.rows[0]?.decisionLoser).toBeNull();
    expect(table.rows[0]?.decisionReason).toBe('no game was scheduled for this block');
  });

  it('pages, and stops when it is exhausted', async () => {
    await writeFile(
      join(directory, 'adaptive-result.json'),
      JSON.stringify(resultDocument()),
      'utf8',
    );
    const first = unwrap(
      await readAdaptiveTable(directory, 'revisions', pageRequestSchema.parse({ limit: 1 })),
    );
    expect(first.rows).toHaveLength(1);
    expect(first.page.total).toBe(3);
    expect(first.page.nextCursor).not.toBeNull();

    const second = unwrap(
      await readAdaptiveTable(
        directory,
        'revisions',
        pageRequestSchema.parse({ limit: 2, cursor: first.page.nextCursor }),
      ),
    );
    expect(second.rows).toHaveLength(2);
    expect(second.page.nextCursor).toBeNull();
  });

  it('refuses a table read for a run with no readable result', async () => {
    const refused = await readAdaptiveTable(directory, 'series', page);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
  });
});

describe('AdaptiveResultReader (M08.19C)', () => {
  it("resolves an experiment's directory as its own id under the configured result root", async () => {
    const experimentId = adaptiveExperimentIdSchema.parse('goblin_counter');
    const runDirectory = join(directory, experimentId);
    await mkdir(runDirectory);
    await writeFile(
      join(runDirectory, 'adaptive-result.json'),
      JSON.stringify(resultDocument()),
      'utf8',
    );

    const roots = unwrap(
      resolveCatalogRoots({
        catalogRoot: join(directory, 'catalog'),
        resultRoots: { default: directory },
      }),
    );
    const reader = new AdaptiveResultReader({ roots, resultRootId: 'default' });

    const summary = unwrap(await reader.readSummary(experimentId));
    expect(summary.experimentId).toBe('goblin_counter');

    const table = unwrap(await reader.readTable(experimentId, 'revisions', page));
    expect(table.experimentId).toBe('goblin_counter');
    expect(table.rows.length).toBeGreaterThan(0);
  });

  it('refuses an experiment id with no directory of its own name, the same way a missing job directory refuses', async () => {
    const experimentId = adaptiveExperimentIdSchema.parse('nothing_here');
    const roots = unwrap(
      resolveCatalogRoots({
        catalogRoot: join(directory, 'catalog'),
        resultRoots: { default: directory },
      }),
    );
    const reader = new AdaptiveResultReader({ roots, resultRootId: 'default' });

    const refused = await reader.readSummary(experimentId);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
  });

  it('refuses a resultRootId that is not configured, rather than guessing another root', async () => {
    const experimentId = adaptiveExperimentIdSchema.parse('goblin_counter');
    const roots = unwrap(
      resolveCatalogRoots({
        catalogRoot: join(directory, 'catalog'),
        resultRoots: { default: directory },
      }),
    );
    const reader = new AdaptiveResultReader({ roots, resultRootId: 'unconfigured' });

    const refused = await reader.readSummary(experimentId);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/unsafe_result_reference');
  });
});
