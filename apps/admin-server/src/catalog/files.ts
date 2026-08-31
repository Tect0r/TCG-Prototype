import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  adminError,
  adminSchemaErrors,
  refuseFutureVersion,
  type AdminError,
  type AdminErrorCode,
  type AdminVersionField,
} from '@tcg/admin-contracts';
import { err, ok, type Result } from '@tcg/shared';
import type { z } from 'zod';

/**
 * The filesystem discipline the catalog is built on: write a document so a
 * reader never sees half of it, append a line so a reader can stop at the
 * damaged one, and validate everything in both directions.
 *
 * [ADR 0023](../../../../docs/architecture/0023-admin-lab-boundary.md) §3 chose
 * files over an embedded database, and the reason it gives is the reason this
 * module is small: `JsonlWriter` and `readJsonl` in `@tcg/simulator` already
 * define this repository's append-and-recover behaviour, including the
 * damaged-tail case, so there is a shape to follow rather than one to invent.
 *
 * ## Why the simulator's own functions are not imported
 *
 * They are still not imported, and the reason outlived the one M08.2 gave. That
 * reason was that the dependency did not exist yet; it arrived in M08.3 and the
 * behaviour below did not move, because what is copied is thirty lines of
 * discipline rather than a function whose meaning could drift. `writeJson` in
 * `sinks.ts` and `writeJsonAtomically` here answer different questions — see the
 * two differences below — so importing one to avoid the other would be sharing a
 * name rather than an implementation. This is the same trade M08.1 made when it
 * copied `@tcg/bot-config`'s newer-build sentence rather than its function.
 *
 * Where the simulator genuinely owns the answer, it is called: `job-config.ts`
 * validates a stored experiment configuration with `parseExperimentConfig`, and
 * `run/progress.ts` asks `experimentPaths` where a run's files are rather than
 * spelling their names a second time.
 *
 * What is copied is the **behaviour**, and it is copied exactly: a truncated
 * final line is dropped and reported rather than silently discarded or allowed
 * to poison the whole file.
 *
 * Two differences from `sinks.ts` are deliberate rather than drift:
 *
 * - **Writes are atomic here and are not there.** `writeJson` overwrites in
 *   place, which is right for a run's own output — a half-written `summary.json`
 *   belongs to a run that was killed, and the run is gone with it. A catalog
 *   document is read by the *next* process, so a crash mid-write must leave the
 *   previous document intact. Temporary file plus `rename`, which ADR 0023 §3
 *   names.
 * - **Everything here is asynchronous.** The store sits behind an interface
 *   precisely so its implementation can change (ADR 0023 §3), and both plausible
 *   successors — a database driver, and the M08.6 request handler that will call
 *   this from a live server — are asynchronous. Synchronous file calls behind an
 *   asynchronous interface would be a stall waiting for a reason to happen.
 */

/* ------------------------------------------------------------- atomic write */

/**
 * Writes a JSON document so that a concurrent or subsequent reader sees either
 * the whole new document or the whole old one.
 *
 * The temporary file is created in the destination's own directory, because
 * `rename` is only atomic within one filesystem and a system temporary directory
 * is frequently not the same one. Its name carries random bytes so two writers
 * of the same document cannot collide on it, and it is removed on failure so a
 * crash leaves at most one stray file that no listing reads (listings filter to
 * `.json`).
 *
 * `sync()` before the rename is durability rather than atomicity: without it the
 * rename can reach the disk before the bytes it points at. Directory-entry
 * durability is left to the operating system, because there is no portable way
 * to flush a directory on every platform this repository runs on, and claiming
 * otherwise would be the kind of promise this module exists to avoid.
 */
export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameOverBusyReader(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
}

/**
 * Error codes a rename reports when the destination is momentarily held open by
 * somebody else.
 *
 * This is a Windows condition and it is a real one rather than a theoretical
 * one, found by a test that read a document in a loop while it was being
 * rewritten. `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING` fails with
 * `ERROR_ACCESS_DENIED` when another handle on the destination was not opened
 * with delete sharing — which is every ordinary reader, including this store's
 * own `readDocument`, an editor with the file open, and a backup agent.
 *
 * POSIX renames over an open file without complaint, so on Linux and macOS this
 * list never matches and the retry never runs.
 */
const RENAME_CONTENTION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Renames, retrying briefly while a reader is holding the destination.
 *
 * Measured rather than assumed. With a reader opening a document in a loop
 * beside forty writes, roughly a quarter of the renames collide and the retry
 * lands almost all of them within five attempts. The rest do not land at all:
 * **a destination held open continuously cannot be replaced on Windows**, and no
 * backoff fixes that — a jittered one was tried and did slightly worse, because
 * the cause is occupancy rather than phase.
 *
 * So the retry is scoped to what it can actually do, which is absorb the
 * ordinary transient overlap, and the two things that make that sufficient live
 * elsewhere:
 *
 * - **In-process, reads take the same per-document lock writes do**
 *   (`FileCatalogStore.readJob`), so the store never collides with itself. That
 *   is the case M08.6's concurrent request handlers would otherwise create.
 * - **Out of process, a failure is reported.** A write that cannot land inside
 *   the budget throws, and the previous document is intact — which is the right
 *   outcome for "something else is sitting on this file", and is asserted as a
 *   test rather than left as a hope.
 *
 * Bounded rather than indefinite: twelve attempts over about a fifth of a
 * second. Nothing about atomicity changes — each attempt is still one `rename`,
 * so a reader still sees the whole old document or the whole new one, and the
 * retry only decides how long the writer waits before giving up on the swap.
 */
async function renameOverBusyReader(from: string, to: string): Promise<void> {
  const attempts = 12;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code ?? '';
      if (attempt >= attempts - 1 || !RENAME_CONTENTION_CODES.has(code)) throw cause;
      await new Promise((settle) => setTimeout(settle, Math.min(2 ** attempt, 25)));
    }
  }
}

/** Whether a document already exists, without reading or parsing it. */
export async function documentExists(path: string): Promise<boolean> {
  try {
    const handle = await open(path, 'r');
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- append-only */

/**
 * Appends one record as one line.
 *
 * A single `appendFile` of a complete line, rather than an open-write-close
 * sequence, so the line is handed to the operating system in one call. Ordering
 * between two appends to the same log is guaranteed by the store serializing
 * every mutation of a job on that job's key, not by this function — which is
 * worth stating because the guarantee would otherwise look like a property of
 * `O_APPEND` that holds on some platforms and not others.
 */
export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

export interface SkippedLine {
  readonly line: number;
  readonly reason: string;
}

export interface JsonLinesResult<T> {
  readonly records: readonly T[];
  readonly skipped: readonly SkippedLine[];
}

/**
 * Reads an append-only log, tolerating a damaged tail.
 *
 * A process killed mid-append leaves a partial final line. That must not make
 * the log unreadable, and it must not quietly become a record either: the line
 * is dropped **and reported**, so a caller can say "this log is missing its last
 * entry" rather than "this job has no history". A line that parses as JSON but
 * fails its schema is reported the same way and for the same reason — including
 * a line from a newer build, which gets the readable newer-build refusal rather
 * than a parse complaint.
 */
export async function readJsonLines<T>(
  path: string,
  schema: z.ZodType<T>,
  versionField?: AdminVersionField,
): Promise<JsonLinesResult<T>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { records: [], skipped: [] };
  }

  const records: T[] = [];
  const skipped: SkippedLine[] = [];

  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped.push({ line: index + 1, reason: 'unparseable JSON (likely a truncated tail)' });
      return;
    }

    if (versionField !== undefined) {
      const refusal = versionRefusalOf(parsed, versionField);
      if (refusal !== null) {
        skipped.push({ line: index + 1, reason: refusal.message });
        return;
      }
    }

    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      skipped.push({
        line: index + 1,
        reason: validated.error.issues.map((issue) => issue.message).join('; '),
      });
      return;
    }
    records.push(validated.data);
  });

  return { records, skipped };
}

/**
 * The bytes of a document, or `null` when there are none.
 *
 * Separate from `readDocument` because a job's stored experiment configuration
 * is validated by `@tcg/simulator`'s parser rather than by a zod schema this
 * package holds, and it declares a version this package does not own. Sharing
 * the read but not the validation keeps one answer to "the file is not there"
 * without pretending the admin surface owns the schema inside it.
 */
export async function readDocumentText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ validated read */

/** The field each version domain is stamped under, so a reader knows where to look. */
const VERSION_FIELD_NAMES: Readonly<Record<AdminVersionField, string>> = Object.freeze({
  contract: 'contractVersion',
  catalogDocument: 'documentVersion',
  jobEvent: 'eventVersion',
  savedChoice: 'documentVersion',
});

/**
 * The newer-build refusal, applied before the schema rather than after it.
 *
 * Order matters and is the whole point. A document from a future build fails the
 * `z.literal` version field too, but it fails it as "expected 1, received 2" —
 * which tells a person nothing about what to do. Reading the version first means
 * the sentence they get is the repository's own: *this record was written by a
 * newer build … update the application*.
 */
function versionRefusalOf(parsed: unknown, field: AdminVersionField): AdminError | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const name = VERSION_FIELD_NAMES[field];
  const found = (parsed as Record<string, unknown>)[name];
  return refuseFutureVersion(field, found, name);
}

/**
 * Reads one JSON document and validates it, or explains exactly why it could
 * not.
 *
 * Four distinguishable failures, because a caller does four different things
 * about them: the document is not there (`missingCode`, which is the caller's —
 * an absent job and an absent batch are different answers), the bytes are not
 * JSON, the version is from the future, or the shape is wrong. Collapsing them
 * into "could not read" would leave M08.10 unable to tell a corrupt entry from a
 * missing one, which is a distinction it is explicitly required to show.
 */
export async function readDocument<T>(
  path: string,
  schema: z.ZodType<T>,
  options: {
    readonly missingCode: AdminErrorCode;
    readonly missingMessage: string;
    readonly versionField: AdminVersionField;
    /** Safe context for the failure — identifiers only, never a path. */
    readonly context?: Readonly<Record<string, unknown>>;
  },
): Promise<Result<T, readonly AdminError[]>> {
  const context = options.context ?? {};

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return err([adminError(options.missingCode, options.missingMessage, { context })]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err([
      adminError(
        'admin/malformed',
        'This catalog document is not readable JSON. It was left where it is rather than replaced.',
        { context },
      ),
    ]);
  }

  const refusal = versionRefusalOf(parsed, options.versionField);
  if (refusal !== null) return err([refusal]);

  const validated = schema.safeParse(parsed);
  if (!validated.success) return err(adminSchemaErrors(validated.error));
  return ok(validated.data);
}

/**
 * Every document name in a directory, sorted, with temporary files excluded.
 *
 * The `.json` filter is what makes an interrupted `writeJsonAtomically` invisible
 * rather than a corrupt entry: its temporary file ends in `.tmp` and is never
 * offered to a reader.
 */
export async function listDocumentNames(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Ensures a directory exists, for a store opening its own root. */
export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export const documentPath = (directory: string, id: string): string =>
  join(directory, `${id}.json`);
