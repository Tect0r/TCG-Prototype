import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CATALOG_DOCUMENT_VERSION, catalogBatchDocumentSchema } from '@tcg/admin-contracts';
import { isErr, isOk, unwrap } from '@tcg/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  appendJsonLine,
  documentExists,
  documentPath,
  listDocumentNames,
  readDocument,
  readJsonLines,
  writeJsonAtomically,
} from './files.js';

let base: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'tcg-admin-files-'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const lineSchema = z.strictObject({ n: z.number().int(), eventVersion: z.number().optional() });

const batchDocument = {
  documentVersion: CATALOG_DOCUMENT_VERSION,
  batchId: 'batch_aaaaaa1111',
  label: 'Wave 1',
  status: 'draft' as const,
  timestamps: {
    createdAt: '2026-08-21T09:00:00.000Z',
    updatedAt: '2026-08-21T09:00:00.000Z',
    startedAt: null,
    completedAt: null,
  },
  annotations: { tags: [], note: '', baseline: false },
  jobIds: [],
};

describe('an atomic write', () => {
  it('never writes into the destination itself, so a crash cannot truncate it', async () => {
    // The atomicity is the `rename`, and the observable form of that is this:
    // a write that fails after the temporary file was created leaves the
    // previous document byte-for-byte intact, because nothing ever opened it.
    const path = join(base, 'document.json');
    await writeJsonAtomically(path, batchDocument);
    const before = await readFile(path, 'utf8');

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(writeJsonAtomically(path, circular)).rejects.toThrow();

    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('fails loudly, and changes nothing, when a reader holds the destination open for good', async () => {
    // The honest platform limit, stated as a test rather than as a comment.
    // Windows cannot replace a file another handle has open: `MoveFileEx` reports
    // `EPERM` and there is no way around it, so a reader that never lets go
    // blocks the write. What matters is what happens then — the previous
    // document is still there, in full, and the caller is told rather than left
    // believing the write landed.
    //
    // On POSIX a rename over an open file simply succeeds, so the same code
    // takes the other branch and the assertion below covers both outcomes.
    const path = join(base, 'document.json');
    await writeJsonAtomically(path, { keep: 'me' });

    const handle = await open(path, 'r');
    try {
      let failed = false;
      try {
        await writeJsonAtomically(path, { replaced: true });
      } catch (cause) {
        failed = true;
        expect((cause as NodeJS.ErrnoException).code).toBe('EPERM');
      }

      const after = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      expect(after).toEqual(failed ? { keep: 'me' } : { replaced: true });
      // Either way, nothing partial and no temporary file left behind.
      expect(await readdir(base)).toEqual(['document.json']);
    } finally {
      await handle.close();
    }
  });

  it('leaves no temporary file behind on success', async () => {
    await writeJsonAtomically(join(base, 'document.json'), batchDocument);
    expect(await readdir(base)).toEqual(['document.json']);
  });

  it('leaves the previous document intact when the new value cannot be written', async () => {
    const path = join(base, 'document.json');
    await writeJsonAtomically(path, { keep: 'me' });

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    await expect(writeJsonAtomically(path, circular)).rejects.toThrow();

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ keep: 'me' });
    expect(await readdir(base)).toEqual(['document.json']);
  });

  it('creates the directory it is asked to write into', async () => {
    const path = join(base, 'nested', 'deeper', 'document.json');
    await writeJsonAtomically(path, batchDocument);
    expect(await documentExists(path)).toBe(true);
  });

  it('writes the temporary file beside the destination, where rename is atomic', async () => {
    // A system temporary directory is often a different filesystem, and a
    // cross-device rename is a copy that can be interrupted halfway.
    const path = join(base, 'nested', 'document.json');
    await writeJsonAtomically(path, batchDocument);
    expect(await readdir(join(base, 'nested'))).toEqual(['document.json']);
  });
});

describe('a listing ignores what is not a document', () => {
  it('skips a stray temporary file left by an interrupted write', async () => {
    await writeJsonAtomically(documentPath(base, 'batch_aaaaaa1111'), batchDocument);
    await writeFile(join(base, 'batch_bbbbbb2222.json.abc123.tmp'), 'half a document', 'utf8');

    expect(await listDocumentNames(base)).toEqual(['batch_aaaaaa1111.json']);
  });

  it('returns nothing for a directory that does not exist yet', async () => {
    expect(await listDocumentNames(join(base, 'absent'))).toEqual([]);
  });

  it('sorts, so a listing is at least stable before it is ordered', async () => {
    for (const id of ['batch_ccc333333', 'batch_aaa111111', 'batch_bbb222222']) {
      await writeJsonAtomically(documentPath(base, id), { ...batchDocument, batchId: id });
    }
    expect(await listDocumentNames(base)).toEqual([
      'batch_aaa111111.json',
      'batch_bbb222222.json',
      'batch_ccc333333.json',
    ]);
  });
});

describe('reading a document', () => {
  const options = {
    missingCode: 'admin/unknown_batch' as const,
    missingMessage: 'No such batch.',
    versionField: 'catalogDocument' as const,
  };

  it('validates on the way out, not only on the way in', async () => {
    const path = documentPath(base, 'batch_aaaaaa1111');
    await writeJsonAtomically(path, batchDocument);
    expect(unwrap(await readDocument(path, catalogBatchDocumentSchema, options))).toEqual(
      batchDocument,
    );
  });

  it('reports a missing document with the caller’s own code', async () => {
    const missing = await readDocument(
      documentPath(base, 'batch_absent0001'),
      catalogBatchDocumentSchema,
      options,
    );
    expect(isErr(missing) && missing.error[0]?.code).toBe('admin/unknown_batch');
  });

  it('reports unreadable bytes as malformed rather than as a schema failure', async () => {
    const path = documentPath(base, 'batch_aaaaaa1111');
    await writeFile(path, 'not json at all', 'utf8');
    const read = await readDocument(path, catalogBatchDocumentSchema, options);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/malformed');
  });

  it('reads the version before the schema, so a newer build gets a sentence not a mismatch', async () => {
    const path = documentPath(base, 'batch_aaaaaa1111');
    await writeJsonAtomically(path, { ...batchDocument, documentVersion: 7 });
    const read = await readDocument(path, catalogBatchDocumentSchema, options);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/unsupported_version');
    expect(isErr(read) && read.error[0]?.message).toContain('Update the application.');
    expect(isErr(read) && read.error[0]?.message).not.toContain('expected');
  });

  it('reads the version before the schema, so an older build gets a sentence not a mismatch', async () => {
    const path = documentPath(base, 'batch_aaaaaa1111');
    await writeJsonAtomically(path, {
      ...batchDocument,
      documentVersion: CATALOG_DOCUMENT_VERSION - 1,
    });
    const read = await readDocument(path, catalogBatchDocumentSchema, options);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/unsupported_version');
    expect(isErr(read) && read.error[0]?.message).toContain('there is no migration for it');
    expect(isErr(read) && read.error[0]?.message).not.toContain('expected');
  });

  it('reports a document with no readable version as missing one', async () => {
    const path = documentPath(base, 'batch_aaaaaa1111');
    await writeJsonAtomically(path, { ...batchDocument, documentVersion: 'one' });
    const read = await readDocument(path, catalogBatchDocumentSchema, options);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/missing_version');
  });

  it('reports a shape failure with the failing field', async () => {
    const path = documentPath(base, 'batch_aaaaaa1111');
    await writeJsonAtomically(path, { ...batchDocument, status: 'melting' });
    const read = await readDocument(path, catalogBatchDocumentSchema, options);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/schema');
    expect(isErr(read) && read.error[0]?.path).toBe('status');
  });

  it('carries only the safe context it was given', async () => {
    const read = await readDocument(
      documentPath(base, 'batch_absent0001'),
      catalogBatchDocumentSchema,
      { ...options, context: { batchId: 'batch_absent0001' } },
    );
    expect(isErr(read) && read.error[0]?.context).toEqual({ batchId: 'batch_absent0001' });
  });
});

describe('an append-only log', () => {
  it('writes one independently parseable line per record', async () => {
    const path = join(base, 'log.jsonl');
    for (let n = 1; n <= 3; n += 1) await appendJsonLine(path, { n });

    const text = await readFile(path, 'utf8');
    expect(text.trimEnd().split('\n')).toHaveLength(3);
    for (const line of text.trimEnd().split('\n')) {
      expect(JSON.parse(line)).toHaveProperty('n');
    }
  });

  it('never rewrites what it already wrote', async () => {
    const path = join(base, 'log.jsonl');
    await appendJsonLine(path, { n: 1 });
    const first = await readFile(path, 'utf8');
    await appendJsonLine(path, { n: 2 });
    expect((await readFile(path, 'utf8')).startsWith(first)).toBe(true);
  });

  it('drops and reports a truncated final line, and keeps every line before it', async () => {
    const path = join(base, 'log.jsonl');
    for (let n = 1; n <= 3; n += 1) await appendJsonLine(path, { n });
    await writeFile(path, `${await readFile(path, 'utf8')}{"n": 4`, 'utf8');

    const read = await readJsonLines(path, lineSchema);
    expect(read.records.map((record) => record.n)).toEqual([1, 2, 3]);
    expect(read.skipped).toEqual([
      { line: 4, reason: 'unparseable JSON (likely a truncated tail)' },
    ]);
  });

  it('reports a line that parses but fails its schema, on the line it was on', async () => {
    const path = join(base, 'log.jsonl');
    await appendJsonLine(path, { n: 1 });
    await appendJsonLine(path, { n: 'two' });
    await appendJsonLine(path, { n: 3 });

    const read = await readJsonLines(path, lineSchema);
    expect(read.records.map((record) => record.n)).toEqual([1, 3]);
    expect(read.skipped[0]?.line).toBe(2);
  });

  it('ignores blank lines rather than calling them damaged', async () => {
    const path = join(base, 'log.jsonl');
    await writeFile(path, '{"n":1}\n\n\n{"n":2}\n', 'utf8');
    const read = await readJsonLines(path, lineSchema);
    expect(read.records).toHaveLength(2);
    expect(read.skipped).toEqual([]);
  });

  it('is empty rather than an error when the log does not exist', async () => {
    const read = await readJsonLines(join(base, 'absent.jsonl'), lineSchema);
    expect(read).toEqual({ records: [], skipped: [] });
  });

  it('refuses a line from a newer build with the readable sentence', async () => {
    const path = join(base, 'log.jsonl');
    await appendJsonLine(path, { n: 1, eventVersion: 1 });
    await appendJsonLine(path, { n: 2, eventVersion: 99 });

    const read = await readJsonLines(path, lineSchema, 'jobEvent');
    expect(read.records.map((record) => record.n)).toEqual([1]);
    expect(read.skipped[0]?.reason).toContain('written by a newer build');
  });
});

describe('documentExists', () => {
  it('is false for an absent file and true for a present one', async () => {
    const path = documentPath(base, 'batch_aaaaaa1111');
    expect(await documentExists(path)).toBe(false);
    await writeJsonAtomically(path, batchDocument);
    expect(await documentExists(path)).toBe(true);
  });

  it('does not parse the file, so a corrupt document still exists', async () => {
    const path = documentPath(base, 'batch_aaaaaa1111');
    await writeFile(path, 'corrupt', 'utf8');
    expect(await documentExists(path)).toBe(true);
    expect(
      isOk(
        await readDocument(path, catalogBatchDocumentSchema, {
          missingCode: 'admin/unknown_batch',
          missingMessage: 'No such batch.',
          versionField: 'catalogDocument',
        }),
      ),
    ).toBe(false);
  });
});
