import {
  adminError,
  adminSchemaErrors,
  jobSpecSchema,
  refuseForeignVersion,
  type AdminError,
  type JobSpec,
} from '@tcg/admin-contracts';
import { err, ok, type Result } from '@tcg/shared';
import { CONFIG_SCHEMA_VERSION, configHashOf, parseExperimentConfig } from '@tcg/simulator';
import type { ExperimentConfig } from '@tcg/simulator';
import { z } from 'zod';

import { readDocumentText, writeJsonAtomically } from './files.js';

/**
 * The configuration a job runs, and the address the catalog records for it.
 *
 * M08.1 stopped deliberately short of putting a configuration on a job, and
 * M08.2 wrote down what that cost: *the job document carries no configuration
 * reference at all … so a queued job has no kind to filter on*. M08.4 is the
 * tranche that closes it, and the shape of the answer is fixed by two rules that
 * were already written down:
 *
 * - **The catalog indexes; it never becomes a second copy of an authority.** The
 *   experiment configuration schema belongs to `@tcg/simulator`. Restating it in
 *   `@tcg/admin-contracts` would be a second copy that drifts the first time the
 *   simulator adds a field, so the contract holds only the run's *address* —
 *   `jobSpecSchema` — and the configuration itself is stored as what it already
 *   is: an ordinary experiment configuration, in the simulator's own schema,
 *   parsed by the simulator's own parser.
 * - **A version this build does not own is read, not adopted.**
 *   `CONFIG_SCHEMA_VERSION` moves when the simulator moves it. So the stored file
 *   is checked against whatever the simulator currently declares, and a file from
 *   a newer or an older build gets the readable sentence rather than a literal
 *   mismatch (ADR 0023 §7). There is no `AdminVersionField` for it, because the
 *   admin surface does not get to move it.
 *
 * The file the store writes is byte-shaped exactly like the `config.json` a run
 * writes into its own directory. That is not a coincidence worth hiding: a person
 * comparing the two is comparing the same document, and the run's own copy stays
 * the canonical one.
 */

/**
 * The finding this module had to be built around, measured rather than assumed.
 *
 * **`parseExperimentConfig` is not idempotent.** `pilotSpecSchema` declares
 * `weights: botWeightsSchema.partial().default({})`, and under zod 4 those two
 * behave differently depending on whether the key is *there*:
 *
 * - `weights` absent — every hand-authored config, every preset expansion —
 *   short-circuits to the literal `{}`, and `createAggressivePilot({})` merges
 *   nothing over the published `AGGRESSIVE_WEIGHTS`.
 * - `weights: {}` **present** — which is exactly what serializing the parsed
 *   config produces — is run through `.partial()`, whose per-field defaults all
 *   apply, yielding the complete generic weight vector. `createAggressivePilot`
 *   then merges *that* over the published vector and replaces every entry, so
 *   the aggressive pilot flies a default-weighted scorer.
 *
 * So a configuration written out in its parsed form and read back is a different
 * configuration, with a different `configHashOf` and different play. That is a
 * pre-existing defect in `@tcg/bot-interface` — it also means `perturbPilot`
 * currently perturbs the generic vector rather than the pilot's published one —
 * and M08.4 deliberately does **not** fix it: correcting it would move robustness
 * evidence, which is not this tranche's to move. `IMPLEMENTATION_PLAN.md` carries
 * the question.
 *
 * What M08.4 owes instead is a bridge that is not affected by it, which is the
 * two functions below: store the configuration in the shape a hand-authored file
 * states it, and then **prove** per job that reading it back yields the same
 * configuration rather than assuming so.
 */

/**
 * The configuration in the shape a file states it: no property whose value is an
 * empty object.
 *
 * An empty object in a parsed configuration is always the trace of a default
 * that was never supplied — `weights`, `randomConfig`, and the `prefault` blocks
 * for limits, retention, analysis and deck format, all of which parse `{}` and
 * absence identically. Removing them is what makes the stored file the same
 * document a person would have typed, and it is checked rather than trusted:
 * `prepareJobConfig` refuses a configuration this changes the identity of.
 */
export function storableForm(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(storableForm);
  if (typeof value !== 'object' || value === null) return value;

  const kept: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const simplified = storableForm(entry);
    if (isEmptyObject(simplified)) continue;
    kept[key] = simplified;
  }
  return kept;
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/**
 * What to write and what to record, or a refusal.
 *
 * The round trip is performed here, at creation, rather than discovered at start:
 * a job whose stored configuration would come back as a different run is a job
 * that must never be queued, and finding that out an hour later — or worse, not
 * finding out — is the failure this check exists to prevent.
 */
export function prepareJobConfig(
  config: ExperimentConfig,
): Result<{ readonly stored: unknown; readonly spec: JobSpec }, readonly AdminError[]> {
  const stored = storableForm(config);

  let reread: ExperimentConfig;
  try {
    reread = parseExperimentConfig(JSON.parse(JSON.stringify(stored)));
  } catch {
    return err([
      adminError(
        'admin/schema',
        'This configuration could not be written down and read back as an experiment configuration, so it was not stored.',
        { path: 'config' },
      ),
    ]);
  }

  if (configHashOf(reread) !== configHashOf(config)) {
    return err([
      adminError(
        'admin/schema',
        'Writing this configuration down and reading it back changes what it is, so it was refused rather than stored as a run nobody asked for.',
        { path: 'config' },
      ),
    ]);
  }

  return ok({ stored, spec: jobSpecOf(config) });
}

/** What the catalog records about a configuration, derived from the configuration. */
export function jobSpecOf(config: ExperimentConfig): JobSpec {
  return jobSpecSchema.parse({
    experimentId: config.id,
    kind: config.kind,
    seed: config.seed,
    // The simulator's own hash, never a second one. It excludes `output` and
    // `workers` on purpose, which is what lets a retry resume its own stream
    // into its own directory with a different worker count.
    configHash: configHashOf(config),
    configSchemaVersion: CONFIG_SCHEMA_VERSION,
  });
}

/** Writes a job's configuration beside the catalog, atomically like every document. */
export async function writeJobConfig(path: string, stored: unknown): Promise<void> {
  await writeJsonAtomically(path, stored);
}

/**
 * Reads a job's stored configuration, or explains exactly why it could not.
 *
 * The same four distinguishable failures `readDocument` reports, for the same
 * reason — a caller does different things about an absent file, unreadable
 * bytes, a version this build cannot read, and a shape that is wrong — except
 * that the version and the shape are both the simulator's rather than this
 * package's.
 */
export async function readJobConfig(
  path: string,
  context: Readonly<Record<string, unknown>>,
): Promise<Result<ExperimentConfig, readonly AdminError[]>> {
  const text = await readDocumentText(path);
  if (text === null) {
    return err([
      adminError(
        'admin/unknown_job',
        'This job has no stored experiment configuration, so there is nothing to run.',
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
        'This job’s stored experiment configuration is not readable JSON. It was left where it is rather than replaced.',
        { context },
      ),
    ]);
  }

  const declared =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).schemaVersion
      : undefined;
  const refusal = refuseForeignVersion(
    'experiment configuration',
    declared,
    CONFIG_SCHEMA_VERSION,
    'schemaVersion',
  );
  if (refusal !== null) return err([refusal]);

  try {
    return ok(parseExperimentConfig(parsed));
  } catch (cause) {
    if (cause instanceof z.ZodError) return err(adminSchemaErrors(cause));
    return err([
      adminError(
        'admin/schema',
        'This job’s stored experiment configuration could not be validated by the simulator.',
        { context },
      ),
    ]);
  }
}
