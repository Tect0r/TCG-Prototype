import {
  adaptiveJobSpecSchema,
  adminError,
  type AdaptiveJobSpec,
  type AdaptiveWorkloadEstimate,
  type AdminError,
} from '@tcg/admin-contracts';
import { err, ok, type Result } from '@tcg/shared';
import {
  ADAPTIVE_CONFIG_SCHEMA_VERSION,
  adaptiveConfigHashOf,
  describeAdaptiveVersionProblem,
  parseAdaptiveConfig,
  type AdaptiveConfig,
} from '@tcg/simulator';

import { readDocumentText, writeJsonAtomically } from './files.js';
import { storableForm } from './job-config.js';

/**
 * The Adaptive Counter counterpart to `job-config.ts`, for the one job kind
 * whose stored configuration is `AdaptiveConfig` rather than
 * `ExperimentConfig` (M08.R3).
 *
 * Same two rules as `job-config.ts`, applied to the other schema:
 *
 * - **The catalog indexes; it never becomes a second copy of an authority.**
 *   `adaptiveJobSpecSchema` records the run's address — identity, seed, the
 *   configuration hash and the workload estimate it was priced at — never
 *   the configuration itself, which is `@tcg/simulator`'s and is stored
 *   beside the job in its own schema.
 * - **A version this build does not own is read, not adopted.**
 *   `ADAPTIVE_CONFIG_SCHEMA_VERSION` moves when the simulator moves it, so a
 *   stored file from a newer or an older build gets the simulator's own
 *   readable sentence (`describeAdaptiveVersionProblem`) rather than a
 *   literal mismatch.
 *
 * `storableForm` is reused unchanged from `job-config.ts`: an empty object in
 * a parsed configuration is the same trace of an unsupplied default —
 * `swapBound`, `retention`, `rebuildTrigger`'s absence — regardless of which
 * schema produced it, so removing it is the same normalization for both.
 */

/**
 * What to write and what to record, or a refusal.
 *
 * The round trip is performed here, exactly as `prepareJobConfig` performs it
 * for an ordinary experiment: a stored configuration that would come back as
 * a different run must never be queued, so this is proven at creation rather
 * than discovered at start.
 */
export function prepareAdaptiveJobConfig(
  config: AdaptiveConfig,
  workloadEstimate: AdaptiveWorkloadEstimate,
): Result<{ readonly stored: unknown; readonly spec: AdaptiveJobSpec }, readonly AdminError[]> {
  const stored = storableForm(config);

  let reread: AdaptiveConfig;
  try {
    reread = parseAdaptiveConfig(JSON.parse(JSON.stringify(stored)));
  } catch {
    return err([
      adminError(
        'admin/schema',
        'This Adaptive Counter configuration could not be written down and read back as one, so it was not stored.',
        { path: 'config' },
      ),
    ]);
  }

  if (adaptiveConfigHashOf(reread) !== adaptiveConfigHashOf(config)) {
    return err([
      adminError(
        'admin/schema',
        'Writing this Adaptive Counter configuration down and reading it back changes what it is, so it was refused rather than stored as a run nobody asked for.',
        { path: 'config' },
      ),
    ]);
  }

  return ok({ stored, spec: adaptiveJobSpecOf(config, workloadEstimate) });
}

/** What the catalog records about an Adaptive Counter configuration, derived from it. */
export function adaptiveJobSpecOf(
  config: AdaptiveConfig,
  workloadEstimate: AdaptiveWorkloadEstimate,
): AdaptiveJobSpec {
  return adaptiveJobSpecSchema.parse({
    kind: 'adaptive_counter',
    experimentId: config.id,
    seed: config.seed,
    configHash: adaptiveConfigHashOf(config),
    configSchemaVersion: ADAPTIVE_CONFIG_SCHEMA_VERSION,
    workloadEstimate,
  });
}

/** Writes a job's Adaptive Counter configuration beside the catalog, atomically. */
export async function writeAdaptiveJobConfig(path: string, stored: unknown): Promise<void> {
  await writeJsonAtomically(path, stored);
}

/**
 * Reads a job's stored Adaptive Counter configuration, or explains exactly
 * why it could not — the same four distinguishable failures `readJobConfig`
 * reports, for the same reason.
 */
export async function readAdaptiveJobConfig(
  path: string,
  context: Readonly<Record<string, unknown>>,
): Promise<Result<AdaptiveConfig, readonly AdminError[]>> {
  const text = await readDocumentText(path);
  if (text === null) {
    return err([
      adminError(
        'admin/unknown_job',
        'This job has no stored Adaptive Counter configuration, so there is nothing to run.',
        { context },
      ),
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err([
      adminError(
        'admin/malformed',
        'This job’s stored Adaptive Counter configuration is not readable JSON. It was left where it is rather than replaced.',
        { context },
      ),
    ]);
  }

  const declared =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).schemaVersion
      : undefined;
  const problem = describeAdaptiveVersionProblem('config', declared);
  if (problem !== null) {
    // Same two codes `refuseForeignVersion` gives an experiment configuration
    // for the same distinction: no readable version number at all is
    // `admin/missing_version`, and a version outside this build's supported
    // range — in either direction — is `admin/unsupported_version`. The
    // message stays the simulator's own (`describeAdaptiveVersionProblem`),
    // since it names the record precisely; only the code is standardised.
    const code =
      typeof declared !== 'number' || !Number.isInteger(declared) || declared < 1
        ? 'admin/missing_version'
        : 'admin/unsupported_version';
    return err([adminError(code, problem, { path: 'schemaVersion', context })]);
  }

  try {
    return ok(parseAdaptiveConfig(parsed));
  } catch (cause) {
    return err([
      adminError(
        'admin/schema',
        cause instanceof Error
          ? cause.message
          : 'This job’s stored Adaptive Counter configuration could not be validated by the simulator.',
        { context },
      ),
    ]);
  }
}
