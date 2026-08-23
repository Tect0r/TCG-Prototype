import {
  adminError,
  runIdentitySchema,
  type AdminError,
  type RunIdentity,
} from '@tcg/admin-contracts';
import { err, ok, type Result } from '@tcg/shared';
import { experimentPaths } from '@tcg/simulator';
import { z } from 'zod';

import { readDocumentText } from '../catalog/files.js';

/**
 * Reading a finished run's identity out of the manifest it wrote.
 *
 * This is the point where the catalog stops holding an intention and starts
 * holding a reference: `spec` says what the job was asked to run, and this says
 * what the directory on disk actually is. The two are checked against each other
 * by the runner, because a job whose result identity disagreed with its own
 * configuration would be an index pointing at somebody else's run.
 *
 * ## Read loosely, record exactly
 *
 * The schema below **strips** unknown fields rather than refusing them, which is
 * the opposite of every other boundary in this workspace, and it is deliberate.
 * A manifest is `@tcg/simulator`'s document and it grows: version 8 added a
 * calibration block, version 7 a construction block, and each of those was
 * additive. A catalog that refused to index a run because the manifest had
 * learned a new field would be refusing evidence for being newer than the index.
 *
 * What is *not* loose is what gets written down. Every field the catalog keeps is
 * re-parsed by `runIdentitySchema`, so a manifest missing an environment, naming
 * a hash that is not hex, or declaring a version that is not a number is refused
 * rather than half-recorded. And `manifestSchemaVersion` is recorded rather than
 * checked: M08.1 fixed that policy — *M08.10 has to tell a reader "this run was
 * written by a build whose manifests were version 8" before refusing or reading
 * it* — so the number travels and the tranche that has to act on it decides.
 */

const manifestEnvironmentSchema = z.object({
  id: z.string(),
  hashes: z.object({
    mechanicsHash: z.string(),
    pilotInputHash: z.string(),
    presentationHash: z.string(),
    fullContentHash: z.string(),
  }),
});

const manifestSchema = z.object({
  schemaVersion: z.number(),
  experimentId: z.string(),
  kind: z.string(),
  seed: z.string(),
  configHash: z.string(),
  softwareCommit: z.string().nullable(),
  environments: z.array(manifestEnvironmentSchema),
});

/**
 * The run identity a completed experiment directory declares.
 *
 * `context` carries identifiers only — the job's ID, never the directory — for
 * the reason `roots.ts` gives: a refusal that names a path is a refusal that
 * leaks one, and the identifier is what an administrator can act on anyway.
 */
export async function readRunIdentity(
  directory: string,
  context: Readonly<Record<string, unknown>>,
): Promise<Result<RunIdentity, readonly AdminError[]>> {
  const text = await readDocumentText(experimentPaths(directory).manifest);
  if (text === null) {
    return err([
      adminError(
        'admin/run_failed',
        'This run wrote no manifest, so there is no canonical identity to index it by. Its partial output was left where it is.',
        { context },
      ),
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err([
      adminError('admin/malformed', 'This run’s manifest is not readable JSON.', { context }),
    ]);
  }

  const manifest = manifestSchema.safeParse(parsed);
  if (!manifest.success) {
    return err([
      adminError(
        'admin/schema',
        'This run’s manifest does not carry the identity a catalog entry references.',
        { context },
      ),
    ]);
  }

  const identity = runIdentitySchema.safeParse({
    experimentId: manifest.data.experimentId,
    kind: manifest.data.kind,
    seed: manifest.data.seed,
    configHash: manifest.data.configHash,
    environments: manifest.data.environments.map((environment) => ({
      environmentId: environment.id,
      hashes: environment.hashes,
    })),
    manifestSchemaVersion: manifest.data.schemaVersion,
    softwareCommit: manifest.data.softwareCommit,
  });
  if (!identity.success) {
    return err([
      adminError(
        'admin/schema',
        'This run’s manifest declares an identity this build cannot record: ' +
          identity.error.issues.map((issue) => issue.message).join('; '),
        { context },
      ),
    ]);
  }
  return ok(identity.data);
}
