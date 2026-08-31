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
import { readFile, stat } from 'node:fs/promises';
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
    const size = await sizeOf(path);
    if (size === null) {
      return err([
        adminError(
          'admin/no_result',
          `This run wrote no ${RESULT_ARTIFACTS[artifact].filename}. That is a fact about the run rather than a failure to read it: not every experiment produces every document.`,
          { context: { jobId, artifact } },
        ),
      ]);
    }
    if (size > MAX_ARTIFACT_BYTES) {
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
      content = await readFile(path, 'utf8');
    } catch {
      return err([
        adminError(
          'admin/no_result',
          `This run’s ${RESULT_ARTIFACTS[artifact].filename} could not be read. Its raw records are still where the run left them.`,
          { context: { jobId, artifact } },
        ),
      ]);
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
      // otherwise report a length nothing on disk has.
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

/** The size of a file, or `null` when there is not one there. */
async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
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
