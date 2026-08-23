import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { experimentPaths } from '@tcg/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkpointFileName, countCommittedRecords, readCanonicalProgress } from './progress.js';

/**
 * The canonical reading, against real files.
 *
 * Every claim M08.4 makes about progress is a claim about what is on disk — a
 * committed record is one with a newline after it, a resumed run continues a
 * stream it can identify, a stage is a checkpoint that exists — so each is
 * checked by writing the bytes and reading them back rather than by agreeing
 * with a mock.
 */

let root: string;
let directory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tcg-admin-progress-'));
  directory = join(root, 'run');
  await mkdir(directory, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const paths = (): ReturnType<typeof experimentPaths> => experimentPaths(directory);

describe('counting what is committed', () => {
  it('reports nothing for a directory that holds no run at all', async () => {
    const reading = await readCanonicalProgress(join(root, 'never-created'));
    expect(reading).toEqual({ completedMatches: 0, stage: null, streamIdentity: null });
  });

  it('counts one record per terminating newline', async () => {
    await writeFile(paths().matches, '{"a":1}\n{"a":2}\n{"a":3}\n', 'utf8');
    expect(await readCanonicalProgress(directory)).toMatchObject({ completedMatches: 3 });
  });

  it('does not count a half-written final line, which is what resume also does', async () => {
    // `MatchStore`: *a record is resumable once its newline is on disk*. A
    // process killed mid-append leaves exactly this, and counting it would be
    // promising a match that is about to be played again.
    await writeFile(paths().matches, '{"a":1}\n{"a":2}\n{"a":3', 'utf8');
    expect(await readCanonicalProgress(directory)).toMatchObject({ completedMatches: 2 });
  });

  it('counts a stream larger than one read buffer', async () => {
    // The file is read in chunks, so the count must not depend on where a chunk
    // boundary happens to fall relative to a newline.
    const line = `{"filler":"${'x'.repeat(500)}"}\n`;
    await writeFile(paths().matches, line.repeat(400), 'utf8');
    expect(await countCommittedRecords(paths().matches)).toBe(400);
  });

  it('reports zero rather than throwing when the stream is not there yet', async () => {
    expect(await countCommittedRecords(join(directory, 'absent.jsonl'))).toBe(0);
  });
});

describe('the resume identity the stream declares', () => {
  it('reads the three fields a resuming caller has to agree with', async () => {
    await writeFile(
      paths().matchesHeader,
      JSON.stringify({
        schemaVersion: 1,
        experimentId: 'precon-smoke',
        experimentKind: 'batch',
        configHash: 'abcdef0123456789',
        telemetrySchemaVersion: 6,
        seedDerivationVersion: 2,
        hashVersion: 1,
      }),
      'utf8',
    );
    expect((await readCanonicalProgress(directory)).streamIdentity).toEqual({
      experimentId: 'precon-smoke',
      experimentKind: 'batch',
      configHash: 'abcdef0123456789',
    });
  });

  it('still answers how far along the run is when the header cannot be read', async () => {
    // A progress reading answers one question. Refusing to say how many records
    // are on disk because a sidecar is damaged would be answering another.
    await writeFile(paths().matches, '{"a":1}\n{"a":2}\n', 'utf8');
    await writeFile(paths().matchesHeader, 'not json at all', 'utf8');
    expect(await readCanonicalProgress(directory)).toEqual({
      completedMatches: 2,
      stage: null,
      streamIdentity: null,
    });
  });
});

describe('the stage, read from checkpoint state', () => {
  it('is null while the run has written no checkpoint', async () => {
    await mkdir(paths().checkpoints, { recursive: true });
    expect((await readCanonicalProgress(directory)).stage).toBeNull();
  });

  it('names the newest checkpointed stage, ordered by the stages that exist', async () => {
    await mkdir(paths().checkpoints, { recursive: true });
    for (const name of [
      checkpointFileName('r0', 0),
      checkpointFileName('r0', 3),
      checkpointFileName('r1', 0),
      checkpointFileName('r1', 2),
    ]) {
      await writeFile(join(paths().checkpoints, name), '{}', 'utf8');
    }
    expect((await readCanonicalProgress(directory)).stage).toEqual({
      stageId: 'r1',
      ordinal: 1,
      total: null,
    });
  });

  it('reports no total, because the directory does not know how many stages there are', async () => {
    // `stageRefSchema`: *reporting a total it does not have would be the
    // second-formula mistake ADR 0023 §2 exists to prevent.* Reading the
    // configured replicate count here would be this module having an opinion
    // about a run beyond what the run wrote down.
    await mkdir(paths().checkpoints, { recursive: true });
    await writeFile(join(paths().checkpoints, checkpointFileName('r0', 7)), '{}', 'utf8');
    expect((await readCanonicalProgress(directory)).stage).toEqual({
      stageId: 'r0',
      ordinal: 0,
      total: null,
    });
  });

  it('ignores anything in the directory that is not a checkpoint', async () => {
    await mkdir(paths().checkpoints, { recursive: true });
    for (const name of ['notes.txt', 'r0-generation-.json', 'generation-001.json', 'r0.json']) {
      await writeFile(join(paths().checkpoints, name), '{}', 'utf8');
    }
    expect((await readCanonicalProgress(directory)).stage).toBeNull();
  });

  it('never opens a checkpoint, so a reading costs a listing rather than a population', async () => {
    // A checkpoint holds every card of every deck in the generation. This one is
    // not valid JSON at all, and the reading is unaffected — which is the
    // structural form of "the files, not their contents".
    await mkdir(paths().checkpoints, { recursive: true });
    await writeFile(join(paths().checkpoints, checkpointFileName('r0', 1)), '<<<not json', 'utf8');
    expect((await readCanonicalProgress(directory)).stage).toEqual({
      stageId: 'r0',
      ordinal: 0,
      total: null,
    });
  });
});
