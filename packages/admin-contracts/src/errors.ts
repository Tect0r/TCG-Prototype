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
  /**
   * The experiment this job holds stopped because something went wrong.
   *
   * The one code M08.4 adds, and it is a new *kind* of failure rather than a new
   * spelling of an old one: every code above is about a request or a document
   * being wrong, and this one is about a run that was accepted, started and then
   * did not finish. A client cannot do anything about it that it would do about
   * `admin/schema` — the configuration was valid, and retrying it is a lifecycle
   * action rather than a correction — so collapsing the two would leave a queue
   * screen unable to tell "fix this form" from "this run fell over".
   *
   * The message is the underlying failure's, with anything that could be a
   * filesystem path replaced first (ADR 0023 §5).
   */
  'admin/run_failed',
  /** Error context that would have leaked a credential or a filesystem path. */
  'admin/unsafe_error_context',

  /* ------------------------------------------------ the service boundary (M08.6) */

  /**
   * The request carried no administrator token, or not the configured one.
   *
   * The first code that is about *who is asking* rather than about what they
   * asked for, which is why it is not `admin/schema`: the payload may be
   * perfectly well formed. It is deliberately one code for both the missing and
   * the wrong token — telling them apart out loud would confirm to an
   * unauthenticated caller that a token is configured at all — and it never
   * carries the value it refused, because `FORBIDDEN_CONTEXT_KEYS` above already
   * refuses to let one travel.
   */
  'admin/unauthorized',
  /** More requests arrived from one caller than the configured window allows. */
  'admin/rate_limited',
  /** The request body was longer than the configured limit, so it was not read. */
  'admin/payload_too_large',
  /**
   * No endpoint of this service answers at that address.
   *
   * Separate from `admin/schema` because the failure is *routing* rather than
   * content, and separate from a bare 404 because a versioned service's most
   * likely wrong address is the right endpoint under a version this build does
   * not speak — and that answer is `admin/unsupported_version`, which a router
   * can only give if it recognises the shape of the address first.
   */
  'admin/unknown_endpoint',
  /**
   * The job exists, and there is no canonical result to read for it.
   *
   * One code for every way that happens — nothing attached yet, the reference no
   * longer resolves, the manifest is gone, the summary is gone, or the directory
   * now declares a different run — because a client can do exactly one thing
   * about all five: show the job without its numbers. Which one it was travels
   * in the message.
   *
   * It is emphatically **not** an empty result. ADR 0012 makes the experiment
   * directory the deliverable; a summary this service could not read is a
   * missing reading, and returning zeroes for it would be the admin layer
   * inventing evidence.
   */
  'admin/no_result',
  /**
   * Another orchestration process already holds this catalog.
   *
   * ADR 0023 §4 describes one administrator and one orchestration process, and
   * M08.5 recorded the gap in as many words: *two orchestrators in two processes
   * could both pass the `start` transition, and the worker budget is one
   * process's own... M08.6 creates the process, and is where a second one would
   * have to be refused.* This is that refusal. It is a startup answer rather than
   * a request answer — no endpoint can produce it — and it is its own code
   * because "somebody else is already running the lab" is a thing an operator
   * fixes by stopping that process, not by correcting a field.
   */
  'admin/already_running',

  /* --------------------------------------------------- the builder (M08.8) */

  /**
   * A bounded collection in this catalog is full, so nothing was written.
   *
   * The first refusal in this list that is neither a bad value nor a missing
   * record: the request was well formed, the caller may make it, and the answer
   * is still no. M08.3 named this as the condition for adding a code — *a policy
   * refusal that is not a bad value … would be [one], and would move
   * `ADMIN_CONTRACT_VERSION` deliberately* — and `MAX_SAVED_CHOICES` is the
   * first such bound a request can reach.
   *
   * Reporting it as `admin/schema` would tell a builder screen to highlight a
   * field, and there is no field to highlight; reporting it as a 500 would tell
   * an operator the lab is broken when their catalog is simply full. What they
   * do about it is remove something, which is a different action from every
   * other code here.
   */
  'admin/catalog_limit',
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
