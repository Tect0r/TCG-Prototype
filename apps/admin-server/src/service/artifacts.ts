import {
  MAX_ARTIFACT_BYTES,
  RESULT_ARTIFACTS,
  RESULT_ARTIFACT_NAMES,
  ARTIFACT_MEDIA_TYPES,
  adminError,
  resultArtifactListingSchema,
  resultArtifactSchema,
  suggestedArtifactFilename,
  type AdminError,
  type JobId,
  type ResultArtifact,
  type ResultArtifactListing,
  type ResultArtifactName,
  type RunIdentity,
} from '@tcg/admin-contracts';
import { err, isErr, ok, type Result } from '@tcg/shared';
import { experimentPaths } from '@tcg/simulator';
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, open as openFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveResultLocation, type ResolvedCatalogRoots } from '../catalog/roots.js';
import type { CatalogStore } from '../catalog/store.js';
import { readRunIdentity } from '../run/manifest.js';

/**
 * Handing an operator the files a run already wrote, unchanged.
 *
 * `artifacts.ts` in the contract gives the argument for serving them rather than
 * generating them; this is the half that has to keep the promise. Three
 * properties, all structural:
 *
 * - **The path is never a caller's.** A request carries a `jobId` and an enum
 *   member. The directory comes from `resolveResultLocation` — the same call the
 *   runner and the result reader make, which re-resolves against the configured
 *   root on every request and refuses a symlink that has appeared since the run
 *   finished (ADR 0023 §5) — and the file name comes from `experimentPaths`.
 *   `ARTIFACT_FILES` below is the only join between the two, and its test
 *   requires every contract member to name a field of `ExperimentPaths`.
 * - **Nothing is rewritten on the way out.** The bytes are the run's. A document
 *   is not parsed, re-serialized, pretty-printed or scrubbed, because every one
 *   of those would make the downloaded file a derivative rather than the
 *   artifact, and this milestone's whole reason for having a catalog is that the
 *   experiment directory stays canonical.
 * - **A refusal is never an empty file.** Absent, too large and unreadable are
 *   three different answers, and each is named. Handing back an empty string for
 *   any of them would be the admin layer inventing evidence, which is the same
 *   defect as reporting a zero win rate for a run nobody played.
 *
 * ## Why the listing does not go through the summary
 *
 * `ResultReader.readSummary` refuses a run whose calibration standing is missing
 * or whose summary is corrupt, deliberately. The moment that happens is exactly
 * the moment somebody needs the raw files, so this reader opens the manifest for
 * identity and never opens the summary at all. A run whose numbers cannot be
 * shown still has downloadable evidence, and the detail view says so.
 */

/** Contract name to the file `experimentPaths` fixes, and nothing in between. */
const ARTIFACT_FILES: Readonly<
  Record<ResultArtifactName, keyof ReturnType<typeof experimentPaths>>
> = Object.freeze({
  manifest: 'manifest',
  config: 'config',
  summary: 'summary',
  report: 'report',
  decks: 'decks',
  resolved_environment: 'resolvedEnvironment',
  reference_population: 'referencePopulation',
  matchup_matrix: 'matchupMatrix',
  matchup_matrix_csv: 'matchupMatrixCsv',
  card_usage: 'cardUsage',
  card_pairs: 'cardPairs',
  cluster_inclusion: 'clusterInclusion',
  errors: 'errors',
});

/** The absolute path of one artifact under an already-resolved run directory. */
export function artifactPath(directory: string, artifact: ResultArtifactName): string {
  const paths = experimentPaths(directory);
  const path = paths[ARTIFACT_FILES[artifact]];
  // Belt and braces over a mapping a test already proves total: `experimentPaths`
  // returns the run's own root under one key, and serving *that* would be serving
  // a directory. A name that resolved to the root is a defect in this table.
  if (path === directory) throw new Error(`Artifact "${artifact}" does not name a file.`);
  return path;
}

/** The exported names, so the server's test can be total over the same table. */
export const ARTIFACT_FILE_KEYS = ARTIFACT_FILES;

export interface ArtifactReaderOptions {
  readonly store: CatalogStore;
  readonly roots: ResolvedCatalogRoots;
  /** Injected so a test's `readAt` is the test's. */
  readonly clock?: () => Date;
}

interface OpenRun {
  readonly directory: string;
  readonly identity: RunIdentity;
}

export class ArtifactReader {
  readonly #store: CatalogStore;
  readonly #roots: ResolvedCatalogRoots;
  readonly #clock: () => Date;

  constructor(options: ArtifactReaderOptions) {
    this.#store = options.store;
    this.#roots = options.roots;
    this.#clock = options.clock ?? (() => new Date());
  }

  /**
   * Which documents this run actually has, and which of them are servable.
   *
   * Every name is reported, present or not. `contentCatalogSchema` makes the
   * same choice about a precon an environment refuses and for the same reason: a
   * reader who cannot tell *the run wrote no matchup matrix* from *this build
   * forgot to offer it* has been told nothing.
   */
  async list(jobId: JobId): Promise<Result<ResultArtifactListing, readonly AdminError[]>> {
    const open = await this.#open(jobId);
    if (isErr(open)) return open;

    const artifacts = [];
    for (const name of RESULT_ARTIFACT_NAMES) {
      const size = await sizeOf(artifactPath(open.value.directory, name));
      artifacts.push({
        artifact: name,
        format: RESULT_ARTIFACTS[name].format,
        present: size !== null,
        byteLength: size,
        tooLarge: size !== null && size > MAX_ARTIFACT_BYTES,
      });
    }

    const value = {
      jobId,
      identity: open.value.identity,
      artifacts,
      readAt: this.#clock().toISOString(),
    };
    const validated = resultArtifactListingSchema.safeParse(value);
    if (!validated.success) return err([builtBadly(jobId)]);
    return ok(validated.data);
  }

  /** One document, byte for byte, with the identity that says which run wrote it. */
  async read(
    jobId: JobId,
    artifact: ResultArtifactName,
  ): Promise<Result<ResultArtifact, readonly AdminError[]>> {
    const open = await this.#open(jobId);
    if (isErr(open)) return open;

    const path = artifactPath(open.value.directory, artifact);
    const opened = await openArtifactFile(path);
    if (!opened.ok) {
      if (opened.reason === 'absent') {
        return err([
          adminError(
            'admin/no_result',
            `This run wrote no ${RESULT_ARTIFACTS[artifact].filename}. That is a fact about the run rather than a failure to read it: not every experiment produces every document.`,
            { context: { jobId, artifact } },
          ),
        ]);
      }
      if (opened.reason === 'unsafe') {
        return err([
          adminError(
            'admin/unsafe_result_reference',
            `This run’s ${RESULT_ARTIFACTS[artifact].filename} does not resolve to a plain file inside the configured result root, so it was refused rather than followed.`,
            { context: { jobId, artifact } },
          ),
        ]);
      }
      return err([
        adminError(
          'admin/no_result',
          `This run’s ${RESULT_ARTIFACTS[artifact].filename} could not be read. Its raw records are still where the run left them.`,
          { context: { jobId, artifact } },
        ),
      ]);
    }

    const size = opened.byteLength;
    if (size > MAX_ARTIFACT_BYTES) {
      await opened.handle.close();
      return err([
        adminError(
          'admin/artifact_too_large',
          `This run’s ${RESULT_ARTIFACTS[artifact].filename} is ${String(size)} bytes, and this service will not send more than ${String(MAX_ARTIFACT_BYTES)} in one answer. It was left whole where the run wrote it rather than sent in part.`,
          { context: { jobId, artifact, byteLength: size } },
        ),
      ]);
    }

    let content: string;
    try {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await opened.handle.read(buffer, 0, size, 0);
      content = buffer.toString('utf8', 0, bytesRead);
    } catch {
      return err([
        adminError(
          'admin/no_result',
          `This run’s ${RESULT_ARTIFACTS[artifact].filename} could not be read. Its raw records are still where the run left them.`,
          { context: { jobId, artifact } },
        ),
      ]);
    } finally {
      await opened.handle.close();
    }

    const definition = RESULT_ARTIFACTS[artifact];
    const value = {
      jobId,
      artifact,
      filename: definition.filename,
      suggestedFilename: suggestedArtifactFilename(
        open.value.identity.experimentId,
        jobId,
        artifact,
      ),
      format: definition.format,
      mediaType: ARTIFACT_MEDIA_TYPES[definition.format],
      // The size on disk rather than `content.length`: one is bytes and the
      // other is UTF-16 code units, and a report with an em dash in it would
      // otherwise report a length nothing on disk has. It is also the exact
      // byte count validated and read from the open descriptor above, never a
      // live re-`stat` — a file that grows after that validation cannot move
      // this number or the bytes actually sent.
      byteLength: size,
      content,
      identity: open.value.identity,
      readAt: this.#clock().toISOString(),
    };

    const validated = resultArtifactSchema.safeParse(value);
    if (!validated.success) return err([builtBadly(jobId)]);
    return ok(validated.data);
  }

  /**
   * The run's directory and its identity, or the one refusal that covers every
   * way there is not one.
   *
   * The manifest is opened and the summary is not, which is the whole point of
   * this reader existing beside `ResultReader` rather than inside it.
   */
  async #open(jobId: JobId): Promise<Result<OpenRun, readonly AdminError[]>> {
    const job = await this.#store.readJob(jobId);
    if (isErr(job)) return err(job.error);

    const reference = job.value.result;
    if (reference === null) {
      return err([
        adminError(
          'admin/no_result',
          'This job has produced no canonical result yet, so it has no documents to download.',
          { context: { jobId } },
        ),
      ]);
    }

    const directory = await resolveResultLocation(this.#roots, reference.location);
    if (isErr(directory)) return err(directory.error);

    const identity = await readRunIdentity(directory.value, { jobId });
    if (isErr(identity)) return err(identity.error);

    if (identity.value.configHash !== reference.identity.configHash) {
      return err([
        adminError(
          'admin/no_result',
          'The directory this job indexes no longer declares the run it was recorded with, so nothing was read from it.',
          { context: { jobId } },
        ),
      ]);
    }

    return ok({ directory: directory.value, identity: identity.value });
  }
}

/** The size of a file, or `null` when there is not one servable there. */
async function sizeOf(path: string): Promise<number | null> {
  const opened = await openArtifactFile(path);
  if (!opened.ok) return null;
  await opened.handle.close();
  return opened.byteLength;
}

type OpenArtifactRefusalReason =
  /** Nothing exists at the path. */
  | 'absent'
  /** A symlink (chain or dangling), a directory, or an object that stopped
   * matching the one just validated — refused rather than followed. */
  | 'unsafe'
  /** Exists, is a plain file, but could not be opened or read. */
  | 'unreadable';

interface OpenArtifactSuccess {
  readonly ok: true;
  readonly handle: FileHandle;
  /** The byte length `fstat` reported on the open descriptor, never re-read. */
  readonly byteLength: number;
}

interface OpenArtifactRefusal {
  readonly ok: false;
  readonly reason: OpenArtifactRefusalReason;
}

type OpenArtifactResult = OpenArtifactSuccess | OpenArtifactRefusal;

/** Test-only interleaving points; always absent in production. */
interface OpenArtifactHooks {
  /** Runs after `lstat` confirms a plain file, before the file is opened —
   * the window M08.R12 closes: a test hook can swap the path for a symlink
   * here to prove the identity check below catches it. */
  readonly afterLstat?: () => Promise<void>;
  /** Runs after the opened descriptor is validated, before it is read — lets
   * a test grow the file on disk and prove the read stays bounded to the
   * size already `fstat`-ed rather than re-checking a live size. */
  readonly beforeRead?: () => Promise<void>;
}

/**
 * Opens and validates the exact filesystem object a caller reads, never a
 * path a second time (M08.R12).
 *
 * `stat`-then-`readFile` on a path follows a file symlink and leaves a
 * window between validating a file and reading it in which the object at
 * that path can change. This validates the object with `lstat` (which never
 * follows a link, so a symlink — chained or dangling — is caught by its
 * immediate hop without ever trying to resolve it), opens it with the
 * platform's no-follow flag where one exists, then re-validates the open
 * descriptor with `fstat` against the same identity `lstat` reported before
 * treating it as the same object. Every subsequent read is bounded to the
 * size that `fstat` reported and comes from that one descriptor, so nothing
 * that happens to the path afterward — a swap, a symlink, a truncation, a
 * later append — can change what is returned.
 *
 * Where the platform gives no way to confirm the opened object still is the
 * one validated (`dev`/`ino` both zero, which the identity check below
 * cannot then tell apart from a coincidental match), this refuses rather
 * than trusting the comparison silently — the "refuse the unsafe operation"
 * half of the milestone's rule, distinct from the "use no-follow where
 * available" half `O_NOFOLLOW`'s platform gap above already covers.
 */
export async function openArtifactFile(
  path: string,
  hooks: OpenArtifactHooks = {},
): Promise<OpenArtifactResult> {
  let validated: Stats;
  try {
    validated = await lstat(path);
  } catch {
    return { ok: false, reason: 'absent' };
  }

  if (!validated.isFile()) {
    // `isSymbolicLink()` covers a chain and a dangling target identically:
    // `lstat` reports the immediate entry only, so what it points to (or
    // whether it resolves at all) is never consulted.
    return { ok: false, reason: validated.isSymbolicLink() ? 'unsafe' : 'unreadable' };
  }

  if (hooks.afterLstat) await hooks.afterLstat();

  const noFollowSupported = typeof fsConstants.O_NOFOLLOW === 'number';
  const flags = noFollowSupported
    ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
    : fsConstants.O_RDONLY;

  let handle: FileHandle;
  try {
    handle = await openFile(path, flags);
  } catch (error) {
    // `ELOOP` is the no-follow refusal for a symlink that appeared after the
    // `lstat` above (POSIX only; Windows has no equivalent open-time flag,
    // which is exactly why the `fstat` identity check below exists too).
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ELOOP' ? 'unsafe' : 'unreadable' };
  }

  const opened = await handle.stat();
  const hasStableIdentity = !(opened.dev === 0 && opened.ino === 0);
  const sameObject =
    hasStableIdentity && opened.dev === validated.dev && opened.ino === validated.ino;

  if (!opened.isFile() || !sameObject) {
    await handle.close();
    return { ok: false, reason: 'unsafe' };
  }

  if (hooks.beforeRead) await hooks.beforeRead();

  return { ok: true, handle, byteLength: opened.size };
}

/** The refusal for an answer this service built and could not validate. */
function builtBadly(jobId: JobId): AdminError {
  return adminError(
    'admin/schema',
    'This service built an artifact answer it could not validate against its own contract, so it was not sent. This is a defect in the build rather than a problem with the run.',
    { context: { jobId } },
  );
}

/** Kept so the module's one path join is visible to a reader looking for one. */
export const ARTIFACT_JOIN = join;
