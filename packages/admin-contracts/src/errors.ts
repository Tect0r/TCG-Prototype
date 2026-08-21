import { error, type Issue } from '@tcg/shared';
import { z } from 'zod';

/**
 * The admin surface's structured errors: a closed list of stable codes, a
 * readable message, and context that is checked to be safe rather than trusted
 * to be.
 *
 * The shape is `@tcg/shared`'s `Issue`, which every other external boundary in
 * this repository already reports with. What this module adds is the two things
 * an admin boundary needs and a card loader does not: the codes are **closed**,
 * so a client can branch on one without matching prose, and the context is
 * **validated**, because the admin service is the one process that can see
 * authentication tokens, hidden deck lists and real filesystem paths — and an
 * error is the easiest place for one of them to escape by accident
 * ([ADR 0023](../../../docs/architecture/0023-admin-lab-boundary.md) §4, §5).
 */

/* ------------------------------------------------------------------ codes */

/**
 * Every code the admin contract may report, in one list.
 *
 * Closed on purpose. A code is part of the contract — a client that hides a
 * "start" button when the answer is `admin/illegal_transition` is reading this
 * list, and a code invented at a call site would not be in it. A tranche that
 * needs a new code adds it here, which is where the client will look for it.
 */
export const ADMIN_ERROR_CODES = [
  /** The payload was not a JSON object at all. */
  'admin/malformed',
  /** The payload was an object and failed its schema. Carries the failing field. */
  'admin/schema',
  /** A request or document declares a version this build cannot read. */
  'admin/unsupported_version',
  /** A request or document declares no readable version at all. */
  'admin/missing_version',
  /** The lifecycle model has no such transition out of the state the entry is in. */
  'admin/illegal_transition',
  /** A batch ID that resolves to nothing. */
  'admin/unknown_batch',
  /** A job ID that resolves to nothing. */
  'admin/unknown_job',
  /** An ID that already exists. Minting one is the store's job, never a caller's. */
  'admin/duplicate_id',
  /** A continuation token this build did not issue, or can no longer honour. */
  'admin/invalid_cursor',
  /** Two filter values that cannot both be satisfied, e.g. an inverted date range. */
  'admin/incompatible_filter',
  /** A result reference that does not resolve inside its configured root. */
  'admin/unsafe_result_reference',
  /** Error context that would have leaked a credential or a filesystem path. */
  'admin/unsafe_error_context',
] as const;

export const adminErrorCodeSchema = z.enum(ADMIN_ERROR_CODES);
export type AdminErrorCode = z.infer<typeof adminErrorCodeSchema>;

/* ------------------------------------------------------------ safe context */

/**
 * Context keys an admin error may never carry, matched case-insensitively as a
 * substring of the key.
 *
 * Substring rather than exact match because the failure being guarded against
 * is a future tranche adding `adminToken`, `tokenHeader` or `bearerSecret` — a
 * name nobody listed, formed from a word everybody would have. ADR 0023 §4 says
 * the token appears in no query string, no log line and no generated report; an
 * error body is the fourth thing on that list, and this is what keeps it off.
 */
export const FORBIDDEN_CONTEXT_KEYS = [
  'token',
  'secret',
  'password',
  'passphrase',
  'credential',
  'authorization',
  'apikey',
  'api_key',
  'cookie',
  'session',
  /** Hidden information rather than a credential — a deck list is nobody else's to read. */
  'deck',
  'cards',
  'hand',
] as const;

/** Longest a single context string may be: long enough to name a thing, too short to be a payload. */
export const MAX_CONTEXT_STRING = 200;

/** Most entries one context object may carry. */
export const MAX_CONTEXT_ENTRIES = 12;

/**
 * Whether a string could be read as a filesystem location.
 *
 * Deliberately blunt: any separator, any `..`, any Windows drive letter, any
 * leading `~`. A blunt rule refuses a few harmless strings and cannot be talked
 * out of refusing a real path, which is the trade an admin boundary wants. The
 * safe way to name a location in an admin error is the identifier the server
 * resolved it from (ADR 0023 §5), and an identifier never contains one of these.
 */
export function looksLikeFilesystemPath(value: string): boolean {
  return (
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('..') ||
    value.startsWith('~') ||
    /^[A-Za-z]:/.test(value)
  );
}

/** Exported so a caller can check before building an error rather than after. */
export function isForbiddenContextKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return FORBIDDEN_CONTEXT_KEYS.some((forbidden) => lowered.includes(forbidden));
}

function contextValueIsSafe(value: string | number | boolean | readonly string[]): boolean {
  if (typeof value === 'string') return !looksLikeFilesystemPath(value);
  if (Array.isArray(value)) return value.every((entry) => !looksLikeFilesystemPath(entry));
  return true;
}

const contextScalarSchema = z.union([
  z.string().max(MAX_CONTEXT_STRING),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(MAX_CONTEXT_STRING)).max(MAX_CONTEXT_ENTRIES),
]);

/**
 * Machine-readable context, restricted to what is safe to hand to a browser.
 *
 * `Issue['context']` already limits the value types to scalars and string
 * arrays; the checks here are about *meaning* rather than type — a forbidden
 * key, an over-long value, or a value shaped like a path. Refusal is a parse
 * failure rather than a silent redaction, because a redacted field looks exactly
 * like a field that was never set, and the tranche that added it would never
 * find out.
 */
export const safeContextSchema = z
  .record(z.string().min(1).max(64), contextScalarSchema)
  .refine(
    (context) => Object.keys(context).length <= MAX_CONTEXT_ENTRIES,
    `Admin error context carries at most ${MAX_CONTEXT_ENTRIES} entries.`,
  )
  .refine(
    (context) => Object.keys(context).every((key) => !isForbiddenContextKey(key)),
    'Admin error context must not name a credential or hidden player information.',
  )
  .refine(
    (context) => Object.values(context).every(contextValueIsSafe),
    'Admin error context must not carry a filesystem path. Name the identifier the server resolved it from.',
  );

export type SafeContext = z.infer<typeof safeContextSchema>;

/* ---------------------------------------------------------------- the error */

/**
 * A data path such as `filter.createdBefore` or `jobIds.2`.
 *
 * Field names and dots only. A data path and a filesystem path are different
 * things that both get called "path", and the one that reaches a client must
 * only ever be the first.
 */
export const errorPathSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(
    /^[A-Za-z0-9_[\]]+(\.[A-Za-z0-9_[\]]+)*$/,
    'An error path names a field, not a file. Use dotted field names.',
  );

/**
 * One structured admin error, as it round-trips between the service and the
 * client.
 *
 * `severity` is present and fixed to `error` rather than reusing the whole of
 * `IssueSeverity`: this shape is what a *failed* request returns, and a request
 * does not half-fail. The field is kept rather than dropped so the value is
 * still an `Issue` — `toIssue` is a widening, not a conversion — and warnings
 * that accompany a successful answer belong beside that answer, added by the
 * tranche that first has one.
 */
export const adminErrorSchema = z.strictObject({
  severity: z.literal('error'),
  code: adminErrorCodeSchema,
  message: z.string().min(1).max(500),
  path: errorPathSchema.optional(),
  context: safeContextSchema.optional(),
});
export type AdminError = z.infer<typeof adminErrorSchema>;

/**
 * Builds an admin error, and validates its own context on the way out.
 *
 * Returns the error rather than a `Result` because a builder that could fail
 * would be called from inside failure handling, where there is nothing useful to
 * do with a second failure. Unsafe context is replaced by a single
 * `unsafeContextRefused` marker: the original code and message still travel, so
 * the caller learns what went wrong *and* that something tried to attach a
 * credential or a path to it. An unusable `path` is dropped for the same reason
 * — an error that cannot be delivered is worse than one missing a field.
 */
export function adminError(
  code: AdminErrorCode,
  message: string,
  extra?: { readonly path?: string; readonly context?: Readonly<Record<string, unknown>> },
): AdminError {
  const base = { severity: 'error' as const, code, message };
  const path =
    extra?.path !== undefined && errorPathSchema.safeParse(extra.path).success
      ? { path: extra.path }
      : {};
  if (extra?.context === undefined) return { ...base, ...path };

  const checked = safeContextSchema.safeParse(extra.context);
  if (checked.success) return { ...base, ...path, context: checked.data };
  return { ...base, ...path, context: { unsafeContextRefused: true } };
}

/** The same error as an `Issue`, for callers already collecting those. */
export function toIssue(from: AdminError): Issue {
  return error(from.code, from.message, {
    ...(from.path === undefined ? {} : { path: from.path }),
    ...(from.context === undefined ? {} : { context: from.context }),
  });
}

/**
 * Zod problems, reported with this package's own code rather than another's.
 *
 * Every zod failure becomes `admin/schema`, including an unknown member: a
 * client cannot do anything different about a misspelled field than about a
 * mistyped one, and the zod code that separates them travels in the context for
 * the reader who can.
 */
export function adminSchemaErrors(zodError: z.ZodError): AdminError[] {
  return zodError.issues.map((problem) =>
    adminError('admin/schema', problem.message, {
      path: problem.path.join('.'),
      context: { zodCode: problem.code },
    }),
  );
}
