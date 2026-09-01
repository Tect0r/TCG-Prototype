import type { z } from 'zod';

/**
 * The four version domains an Adaptive Counter run stamps, and the rule they
 * all share: a document this build cannot read is refused with a readable
 * message rather than migrated on a guess (M08.16A).
 *
 * Four rather than one, for the reason `@tcg/admin-contracts`'s
 * `CURRENT_ADMIN_VERSIONS` already documents for an analogous family: a
 * **config** is written once by whoever starts a run, a **raw** record is
 * appended to throughout it, a **checkpoint** is rewritten in place as the run
 * proceeds, and a **result** is written once at the end. Four artifacts with
 * four different lifetimes, each moving only when its own shape moves —
 * collapsing them would mean a widened result schema refusing a config a
 * build can still read perfectly well, or the reverse.
 *
 * Every other schema version in this app — `CONFIG_SCHEMA_VERSION`,
 * `SEARCH_CHECKPOINT_VERSION`, `MANIFEST_SCHEMA_VERSION` — is checked with a
 * bare `z.literal` and no readable counterpart, because every one of those
 * files is written and read by the same build in the same run: a hand-edited
 * config that fails its literal really is just "this file is wrong right
 * now." An adaptive run's checkpoint and raw stream are read by whichever
 * build later resumes or reports on them (M08.16B onward), which can be a
 * build far newer or older than the one that wrote them — the same gap
 * `CATALOG_DOCUMENT_VERSION` exists for, so the same readable treatment
 * applies here for the first time in this app.
 */

export const ADAPTIVE_CONFIG_SCHEMA_VERSION = 1;
/** 2: M08.16C additively widens the raw stream with generation records. */
export const ADAPTIVE_RAW_SCHEMA_VERSION = 2;
/** 2: M08.18A widens the checkpoint from an empty identity stub to real resumable state. */
export const ADAPTIVE_CHECKPOINT_SCHEMA_VERSION = 2;
export const ADAPTIVE_RESULT_SCHEMA_VERSION = 1;

export const CURRENT_ADAPTIVE_VERSIONS = Object.freeze({
  config: ADAPTIVE_CONFIG_SCHEMA_VERSION,
  raw: ADAPTIVE_RAW_SCHEMA_VERSION,
  checkpoint: ADAPTIVE_CHECKPOINT_SCHEMA_VERSION,
  result: ADAPTIVE_RESULT_SCHEMA_VERSION,
});

export type AdaptiveVersionField = keyof typeof CURRENT_ADAPTIVE_VERSIONS;

export const ADAPTIVE_VERSION_FIELDS = Object.keys(
  CURRENT_ADAPTIVE_VERSIONS,
) as readonly AdaptiveVersionField[];

const VERSION_LABELS: Readonly<Record<AdaptiveVersionField, string>> = Object.freeze({
  config: 'Adaptive Counter configuration',
  raw: 'Adaptive Counter raw record',
  checkpoint: 'Adaptive Counter checkpoint',
  result: 'Adaptive Counter result',
});

/** Whether `found` is a readable version number this build is simply too old for. */
export function isFutureAdaptiveVersion(
  field: AdaptiveVersionField,
  found: unknown,
): found is number {
  return (
    typeof found === 'number' &&
    Number.isInteger(found) &&
    found >= 1 &&
    found > CURRENT_ADAPTIVE_VERSIONS[field]
  );
}

/**
 * The readable refusal for one version field, meant to be checked before the
 * strict schema is even reached. `null` when the version is one this build
 * can read.
 *
 * Two of the four fields still start at 1, so the "older build" branch below
 * is unreached for `config` and `result` — there is no earlier document of
 * theirs anywhere to refuse. It stays beside the "newer build" branch anyway,
 * for the same reason `refusePastVersion` was written into
 * `@tcg/admin-contracts` ahead of the version move that first needed it: the
 * day a number moves, the readable refusal must already exist rather than
 * being invented under pressure at that milestone. `raw` moved first, at
 * M08.16C — a schemaVersion-1 raw record predates candidate generation and is
 * refused as an older build, never guessed at. `checkpoint` moved next, at
 * M08.18A — a schemaVersion-1 checkpoint predates every real resumable field
 * this file now requires and is refused the same way.
 */
export function describeAdaptiveVersionProblem(
  field: AdaptiveVersionField,
  found: unknown,
): string | null {
  const supported = CURRENT_ADAPTIVE_VERSIONS[field];
  const label = VERSION_LABELS[field];
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    return `This ${label} does not declare a readable schema version, so it cannot be read.`;
  }
  if (found > supported) {
    return (
      `This ${label} was written by a newer build (schema version ${String(found)}; this ` +
      `build reads up to ${String(supported)}). Update the application.`
    );
  }
  if (found < supported) {
    return (
      `This ${label} was written by an older build (schema version ${String(found)}; this ` +
      `build reads version ${String(supported)}) and there is no migration for it, so it was ` +
      'left where it is rather than guessed at.'
    );
  }
  return null;
}

/** Throws the readable refusal above when `found` is not a version this build reads. */
export function assertCompatibleAdaptiveVersion(field: AdaptiveVersionField, found: unknown): void {
  const problem = describeAdaptiveVersionProblem(field, found);
  if (problem !== null) throw new Error(problem);
}

/**
 * Parses one adaptive document, refusing an unreadable schema version with
 * the readable message above before `schema`'s strict shape check ever runs —
 * the same two-step read `apps/admin-server`'s `readDocument` uses for a
 * persisted catalog document. Shared by `./config.ts` and `./envelopes.ts`
 * rather than repeated in each, since all four adaptive documents read the
 * same way.
 */
export function parseAdaptiveDocument<T>(
  field: AdaptiveVersionField,
  schema: z.ZodType<T>,
  input: unknown,
): T {
  if (input !== null && typeof input === 'object') {
    const problem = describeAdaptiveVersionProblem(
      field,
      (input as { schemaVersion?: unknown }).schemaVersion,
    );
    if (problem !== null) throw new Error(problem);
  }
  return schema.parse(input);
}
