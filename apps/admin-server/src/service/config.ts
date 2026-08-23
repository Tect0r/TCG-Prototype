import { isAbsolute } from 'node:path';

import { adminError, type AdminError } from '@tcg/admin-contracts';
import { err, ok, type Result } from '@tcg/shared';
import { z } from 'zod';

import { resolveCatalogRoots, type ResolvedCatalogRoots } from '../catalog/roots.js';
import {
  DEFAULT_RESOURCE_LIMITS,
  resourceLimitsSchema,
  type ResourceLimits,
} from '../run/limits.js';

/**
 * Where the service listens, who may talk to it, and how much one caller may
 * send — decided once, at startup, from configuration.
 *
 * [ADR 0023](../../../../docs/architecture/0023-admin-lab-boundary.md) §4 is the
 * whole of this module's brief, and it is unusually specific for an ADR because
 * the failure it prevents is unusually cheap to cause:
 *
 * > `apps/admin-server` binds `127.0.0.1` unless told otherwise. A non-loopback
 * > bind **refuses to start** unless an administrator token is configured out of
 * > band, in the environment. There is no default token, no
 * > generated-and-printed token, and no "insecure mode" flag.
 *
 * Three consequences are worth stating as code rather than as intent.
 *
 * **The refusal is at startup, not per request.** A service that bound
 * `0.0.0.0` and then rejected unauthenticated requests would already be
 * listening on every interface while somebody read the log line. `parseServiceConfig`
 * returns a refusal and nothing binds.
 *
 * **There is no way to spell "off".** No `--insecure`, no
 * `TCG_ADMIN_ALLOW_ANONYMOUS`, no empty-string token that counts as configured.
 * The token is either absent — which is legal on loopback and only on loopback —
 * or it is a real one, and `adminTokenSchema` decides what real means.
 *
 * **A token is required to be long.** Thirty-two characters is not a password
 * policy dressed up; it is the observation that this service has one
 * administrator, no lockout, no second factor and no way to notice a guess. A
 * rate limit slows an attacker down by a constant; length is the only defence
 * whose cost to the attacker is exponential. The alphabet is deliberately
 * header-safe, because a token with a newline in it is a header-injection bug
 * rather than a strong secret.
 */

/* --------------------------------------------------------------- the token */

/** Shortest administrator token this build will accept. See the header. */
export const MIN_TOKEN_LENGTH = 32;

/**
 * The token as it must be configured: long, and safe to put in a header.
 *
 * The alphabet is URL-safe base64 plus `.` and `~` — everything a person is
 * likely to get out of `openssl rand -base64 32 | tr '+/' '-_'` — and nothing
 * that could terminate a header line or need escaping anywhere it travels.
 */
export const adminTokenSchema = z
  .string()
  .min(MIN_TOKEN_LENGTH)
  .max(512)
  .regex(
    /^[A-Za-z0-9._~-]+$/,
    'An administrator token is URL-safe text: letters, digits, and `-._~`.',
  );

/** The header a token travels in. Never a query string, never a cookie (ADR 0023 §4). */
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

/* ------------------------------------------------------------ the interface */

/**
 * Hosts that mean "this machine only".
 *
 * A closed list plus the `127.0.0.0/8` prefix, rather than a DNS lookup. A
 * resolver is a moving part in a security decision — `localhost` can be made to
 * resolve anywhere — and the question being answered is *did the operator ask for
 * a loopback bind*, which is a question about the string they typed.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

export function isLoopbackHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(trimmed)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed);
}

/* ------------------------------------------------------------ what is bounded */

/**
 * The two limits that are properties of a socket rather than of a payload.
 *
 * `maxRequestBytes` is the one that has to exist before anything is read: a
 * service that parsed first and measured afterwards has already allocated
 * whatever it was sent. 128 KiB is generous by two orders of magnitude for every
 * request this contract can express — the largest is a preset choice with
 * sixteen precon identifiers and a four-thousand-character note — and it is small
 * enough that refusing one costs nothing.
 *
 * The rate limit is a **fixed window** rather than a token bucket, and 240 a
 * minute is chosen against the real caller: a queue screen polling four running
 * jobs every two seconds is 120, and an operator clicking through result tables
 * adds a handful. It is not a defence against a determined attacker — nothing at
 * this layer is — it is what stops a looping client from turning a file-backed
 * catalog into a disk benchmark.
 */
export const requestLimitsSchema = z.strictObject({
  maxRequestBytes: z
    .number()
    .int()
    .min(1024)
    .max(4 * 1024 * 1024)
    .default(128 * 1024),
  requestsPerWindow: z.number().int().min(1).max(100_000).default(240),
  windowMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
});
export type RequestLimits = z.infer<typeof requestLimitsSchema>;
export type RequestLimitsInput = z.input<typeof requestLimitsSchema>;

export const DEFAULT_REQUEST_LIMITS: RequestLimits = Object.freeze(requestLimitsSchema.parse({}));

/* --------------------------------------------------------------- the config */

export interface AdminServiceConfigInput {
  readonly host?: string;
  readonly port?: number;
  /** Where batch documents, job documents and event logs live. Absolute. */
  readonly catalogRoot: string;
  /** Each configured result root, by the identifier a document may name. Absolute. */
  readonly resultRoots: Readonly<Record<string, string>>;
  /** Which of them new runs are created under. Defaults to the only one, when there is one. */
  readonly defaultResultRootId?: string;
  readonly token?: string | null;
  readonly limits?: Partial<ResourceLimits>;
  readonly requestLimits?: RequestLimitsInput;
}

export interface AdminServiceConfig {
  readonly host: string;
  readonly port: number;
  readonly loopback: boolean;
  /** `null` only when the bind is loopback. Never printed, never logged. */
  readonly token: string | null;
  readonly roots: ResolvedCatalogRoots;
  readonly resultRootId: string;
  readonly limits: ResourceLimits;
  readonly requestLimits: RequestLimits;
}

/** What a bind defaults to when nobody said. ADR 0023 §4's first sentence. */
export const DEFAULT_HOST = '127.0.0.1';

/** The port the lab defaults to. One above the match server's, so both can run. */
export const DEFAULT_PORT = 8788;

/**
 * Validates a whole service configuration, or refuses it entirely.
 *
 * Every problem is collected rather than thrown at the first one, because an
 * operator setting this up for the first time would otherwise fix five things in
 * five restarts. The one exception is deliberate: a non-loopback bind with no
 * token is reported *alongside* whatever else is wrong, and the caller still
 * gets nothing to bind.
 */
export function parseServiceConfig(
  input: AdminServiceConfigInput,
): Result<AdminServiceConfig, readonly AdminError[]> {
  const problems: AdminError[] = [];

  const host = input.host ?? DEFAULT_HOST;
  const loopback = isLoopbackHost(host);

  if (host.trim() === '') {
    problems.push(adminError('admin/schema', 'A bind address cannot be empty.', { path: 'host' }));
  }

  const port = input.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    problems.push(
      adminError('admin/schema', 'A port is a whole number from 0 to 65535.', { path: 'port' }),
    );
  }

  const rawToken = input.token ?? null;
  let token: string | null = null;
  if (rawToken !== null) {
    const parsed = adminTokenSchema.safeParse(rawToken);
    if (parsed.success) {
      token = parsed.data;
    } else {
      // The value never travels: the message says what shape is required and the
      // context carries a length rather than a prefix, because a prefix is a
      // fifth of a secret.
      problems.push(
        adminError(
          'admin/schema',
          `An administrator token is at least ${String(MIN_TOKEN_LENGTH)} characters of URL-safe text. The configured value is not, so it was refused rather than shortened or hashed into shape.`,
          { path: 'token', context: { configuredLength: rawToken.length } },
        ),
      );
    }
  }

  if (!loopback && token === null) {
    problems.push(
      adminError(
        'admin/unauthorized',
        `This service is configured to bind \`${host}\`, which is not a loopback address, and no administrator token is configured. ADR 0023 §4 refuses that combination at startup: there is no insecure mode, so either bind ${DEFAULT_HOST} or configure a token out of band.`,
        { path: 'host' },
      ),
    );
  }

  for (const [name, value] of Object.entries(input.resultRoots)) {
    if (isAbsolute(value)) continue;
    problems.push(
      adminError(
        'admin/unsafe_result_reference',
        `The result root \`${name}\` must be configured as an absolute path.`,
        { path: 'resultRoots', context: { rootId: name } },
      ),
    );
  }

  const roots = resolveCatalogRoots({
    catalogRoot: input.catalogRoot,
    resultRoots: input.resultRoots,
  });
  if (!roots.ok) problems.push(...roots.error);

  const rootIds = roots.ok ? [...roots.value.resultRoots.keys()] : [];
  const resultRootId = input.defaultResultRootId ?? rootIds[0] ?? '';
  if (roots.ok && !roots.value.resultRoots.has(resultRootId)) {
    problems.push(
      adminError(
        'admin/unsafe_result_reference',
        rootIds.length === 0
          ? 'No result root is configured, so there is nowhere for a run to be written.'
          : `No result root named \`${resultRootId}\` is configured, so new runs would have nowhere to go.`,
        { path: 'defaultResultRootId' },
      ),
    );
  }

  const limits = resourceLimitsSchema.safeParse({ ...DEFAULT_RESOURCE_LIMITS, ...input.limits });
  if (!limits.success) {
    for (const issue of limits.error.issues) {
      problems.push(
        adminError('admin/schema', issue.message, {
          path: ['limits', ...issue.path.map(String)].join('.'),
        }),
      );
    }
  }

  const requestLimits = requestLimitsSchema.safeParse(input.requestLimits ?? {});
  if (!requestLimits.success) {
    for (const issue of requestLimits.error.issues) {
      problems.push(
        adminError('admin/schema', issue.message, {
          path: ['requestLimits', ...issue.path.map(String)].join('.'),
        }),
      );
    }
  }

  if (problems.length > 0 || !roots.ok || !limits.success || !requestLimits.success) {
    return err(problems.length > 0 ? problems : [unexpectedRefusal()]);
  }

  return ok({
    host,
    port,
    loopback,
    token,
    roots: roots.value,
    resultRootId,
    limits: limits.data,
    requestLimits: requestLimits.data,
  });
}

function unexpectedRefusal(): AdminError {
  return adminError(
    'admin/schema',
    'The service configuration could not be resolved, and nothing said why. This is a defect rather than a configuration problem.',
  );
}

/* ------------------------------------------------------- reading it from env */

/**
 * The environment variables an operator sets, and nothing that can be passed on
 * a command line.
 *
 * ADR 0023 §4 says the token is configured *out of band, in the environment*, and
 * the rest follows it for consistency rather than for the same reason: a process
 * argument is visible in a process listing to every user on the machine, and
 * there is no admin input worth putting there.
 *
 * **One result root, named `default`.** The catalog and this configuration both
 * hold many, because `resultLocationSchema` has always been able to name one by
 * identifier and M08.10 will want an archive root beside a working one. What
 * there is no environment syntax for is *several*, and inventing one — a
 * delimiter, an escaping rule, a precedence order — before anything needs it
 * would be the premature scaffolding the milestone warns against. A second root
 * arrives with the tranche that has a use for it, through `parseServiceConfig`,
 * which already takes as many as it is given.
 */
export const ADMIN_ENVIRONMENT_KEYS = Object.freeze({
  host: 'TCG_ADMIN_HOST',
  port: 'TCG_ADMIN_PORT',
  catalogRoot: 'TCG_ADMIN_CATALOG_ROOT',
  resultRoot: 'TCG_ADMIN_RESULT_ROOT',
  token: 'TCG_ADMIN_TOKEN',
  maxConcurrentJobs: 'TCG_ADMIN_MAX_CONCURRENT_JOBS',
  maxWorkers: 'TCG_ADMIN_MAX_WORKERS',
  maxWorkersPerJob: 'TCG_ADMIN_MAX_WORKERS_PER_JOB',
});

/** The identifier the single environment-configured result root is known by. */
export const ENVIRONMENT_RESULT_ROOT_ID = 'default';

function numberFrom(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
  problems: AdminError[],
): number | undefined {
  const raw = environment[key];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    problems.push(adminError('admin/schema', `\`${key}\` must be a whole number.`, { path: key }));
    return undefined;
  }
  return value;
}

export function serviceConfigFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Result<AdminServiceConfig, readonly AdminError[]> {
  const problems: AdminError[] = [];

  const catalogRoot = environment[ADMIN_ENVIRONMENT_KEYS.catalogRoot];
  const resultRoot = environment[ADMIN_ENVIRONMENT_KEYS.resultRoot];

  if (catalogRoot === undefined || catalogRoot.trim() === '') {
    problems.push(
      adminError(
        'admin/schema',
        `\`${ADMIN_ENVIRONMENT_KEYS.catalogRoot}\` must name the absolute directory the catalog lives in. There is no default: a lab that chose one for you would write somebody's experiments somewhere they did not pick.`,
        { path: ADMIN_ENVIRONMENT_KEYS.catalogRoot },
      ),
    );
  }
  if (resultRoot === undefined || resultRoot.trim() === '') {
    problems.push(
      adminError(
        'admin/schema',
        `\`${ADMIN_ENVIRONMENT_KEYS.resultRoot}\` must name the absolute directory experiment directories are written under.`,
        { path: ADMIN_ENVIRONMENT_KEYS.resultRoot },
      ),
    );
  }
  if (problems.length > 0) return err(problems);

  const limits: Partial<ResourceLimits> = {};
  const maxConcurrentJobs = numberFrom(
    environment,
    ADMIN_ENVIRONMENT_KEYS.maxConcurrentJobs,
    problems,
  );
  if (maxConcurrentJobs !== undefined) Object.assign(limits, { maxConcurrentJobs });
  const maxWorkers = numberFrom(environment, ADMIN_ENVIRONMENT_KEYS.maxWorkers, problems);
  if (maxWorkers !== undefined) Object.assign(limits, { maxWorkers });
  const maxWorkersPerJob = numberFrom(
    environment,
    ADMIN_ENVIRONMENT_KEYS.maxWorkersPerJob,
    problems,
  );
  if (maxWorkersPerJob !== undefined) Object.assign(limits, { maxWorkersPerJob });

  const port = numberFrom(environment, ADMIN_ENVIRONMENT_KEYS.port, problems);
  if (problems.length > 0) return err(problems);

  const token = environment[ADMIN_ENVIRONMENT_KEYS.token];
  const host = environment[ADMIN_ENVIRONMENT_KEYS.host];
  return parseServiceConfig({
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    catalogRoot: catalogRoot as string,
    resultRoots: { [ENVIRONMENT_RESULT_ROOT_ID]: resultRoot as string },
    defaultResultRootId: ENVIRONMENT_RESULT_ROOT_ID,
    // An empty string is *not* a configured token. Treating it as one would give
    // a non-loopback bind a token nobody can guess and nobody can send.
    token: token === undefined || token.trim() === '' ? null : token,
    limits,
  });
}
