import {
  ADMIN_CONTRACT_VERSION,
  ADMIN_ENDPOINTS,
  adminEndpointPath,
  adminResponse,
  refuseFutureVersion,
  refusePastVersion,
  type AdminEndpointName,
  type AdminError,
  type AdminRequestOf,
  type AdminResponseOf,
} from '@tcg/admin-contracts';

/**
 * The one file that speaks to the orchestration process.
 *
 * Deliberately free of React, the same way `match-client.ts` is in the player
 * application: it owns the envelope, the token header and the four ways a call
 * can fail, and it answers with a value. That keeps every rule of this boundary
 * testable without a DOM, and keeps the screens pure renderers of an answer
 * somebody else validated.
 *
 * ## Everything the service decided, this file obeys rather than restates
 *
 * The address comes from `adminEndpointPath`, which is derived from
 * `ADMIN_CONTRACT_VERSION`; the request and response shapes come from
 * `ADMIN_ENDPOINTS`; the version refusal comes from the contract's own
 * `refuseFutureVersion` and `refusePastVersion`. A second spelling of any of
 * them here would be a client that can disagree with the service about what it
 * just sent.
 *
 * ## Same origin, always
 *
 * The path is relative and there is no base URL, no host and no scheme anywhere
 * in this module. That is what makes the origin policy in `vite.config.ts` a
 * fact rather than a convention: the browser can only send this request to the
 * page's own origin, so a build pointed at somebody else's lab is not a
 * misconfiguration away — it is unrepresentable. `transport.test.ts` reads the
 * address the transport was handed and requires it to be relative.
 *
 * ## The token is a header, and it is never anything else
 *
 * ADR 0023 §4: *the token travels in a request header. Never a query string,
 * never a log line, never a generated report, never anything the browser
 * persists.* It arrives here as an argument, is written into one header, and is
 * held nowhere in this module — the session above it holds it in memory for as
 * long as the tab is open, and no longer.
 */

/** The header the service reads its administrator token from (M08.6). */
export const ADMIN_TOKEN_HEADER = 'x-admin-token';

export interface AdminHttpRequest {
  /** Always relative, always beginning `/admin/`. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface AdminHttpReply {
  readonly status: number;
  readonly body: string;
}

/** How a request is actually sent. Injected in tests; `browserTransport` in a browser. */
export type AdminTransport = (request: AdminHttpRequest) => Promise<AdminHttpReply>;

/**
 * Why a call did not produce a value.
 *
 * Four kinds rather than one list of errors, because an operator does something
 * different about each and a screen has to be able to tell them apart:
 *
 * - `refused` — the service answered, in this contract, and said no. The
 *   `AdminError[]` is the service's own, with its own closed code, so a screen
 *   can branch on `admin/unauthorized` without matching prose.
 * - `version` — the service answered in a contract version this build cannot
 *   read. Carries the repository's readable newer-build or older-build sentence
 *   rather than a schema complaint (ADR 0023 §7).
 * - `unreadable` — something answered, and it was not this contract. A proxy
 *   error page, an empty body, a response the endpoint's own schema refuses.
 * - `unreachable` — nothing answered at all. The process is not running, or the
 *   dev server has nothing to forward to.
 *
 * A client-side failure is never dressed up as an `AdminError`: the code list is
 * closed and it is the *service's*, and inventing a member of it here would put
 * a code into the wire's vocabulary that no service ever sends.
 */
export type AdminFailure =
  | { readonly kind: 'refused'; readonly status: number; readonly errors: readonly AdminError[] }
  | { readonly kind: 'version'; readonly error: AdminError }
  | { readonly kind: 'unreadable'; readonly status: number; readonly message: string }
  | { readonly kind: 'unreachable'; readonly message: string };

export type AdminOutcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: AdminFailure };

/** The sentences a screen prints for one failure, in order. */
export function failureMessages(failure: AdminFailure): readonly string[] {
  switch (failure.kind) {
    case 'refused':
      return failure.errors.map((problem) => problem.message);
    case 'version':
      return [failure.error.message];
    case 'unreadable':
    case 'unreachable':
      return [failure.message];
  }
}

/** Whether the service refused this call for want of a valid administrator token. */
export function isUnauthorized(failure: AdminFailure): boolean {
  return (
    failure.kind === 'refused' &&
    failure.errors.some((problem) => problem.code === 'admin/unauthorized')
  );
}

/**
 * The real transport: `fetch`, to this page's own origin.
 *
 * `cache: 'no-store'` because every answer here is a reading of live state, and
 * a cached listing would show an operator a run that finished ten minutes ago —
 * the same reason `service.ts` gives for putting every input in a POST body.
 * `credentials: 'omit'` because this boundary authenticates with one header and
 * nothing else: there is no cookie, no session and no ambient authority to send.
 */
export function browserTransport(): AdminTransport {
  return async (request) => {
    const response = await fetch(request.path, {
      method: 'POST',
      headers: { ...request.headers },
      body: request.body,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    return { status: response.status, body: await response.text() };
  };
}

/**
 * Sends one request and returns a value, or the reason there is none.
 *
 * The order of the checks is the order in which each can be answered honestly:
 * the transport either produced bytes or it did not; the bytes are either JSON
 * or they are not; the JSON either declares a version this build reads or it
 * does not; and only then is the payload worth parsing against a schema.
 */
export async function callAdmin<N extends AdminEndpointName>(
  transport: AdminTransport,
  name: N,
  payload: AdminRequestOf<N>,
  token: string | null,
): Promise<AdminOutcome<AdminResponseOf<N>>> {
  const body = JSON.stringify({ contractVersion: ADMIN_CONTRACT_VERSION, payload });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers[ADMIN_TOKEN_HEADER] = token;

  let reply: AdminHttpReply;
  try {
    reply = await transport({ path: adminEndpointPath(name), headers, body });
  } catch {
    // The thrown value is deliberately not read. A `TypeError` out of `fetch`
    // carries no fact an operator can act on, and a browser's wording for
    // "connection refused" differs between browsers; what is actionable is that
    // nothing answered, and where to look.
    return {
      ok: false,
      failure: {
        kind: 'unreachable',
        message:
          'The lab’s orchestration process did not answer. Start it, or check that this page is ' +
          'being served by the admin client’s own dev server — that is what forwards these ' +
          'requests to it.',
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.body);
  } catch {
    return {
      ok: false,
      failure: {
        kind: 'unreadable',
        status: reply.status,
        message: `Something answered at this address with HTTP ${String(reply.status)}, and it was not the admin service.`,
      },
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      failure: {
        kind: 'unreadable',
        status: reply.status,
        message: `The answer to “${ADMIN_ENDPOINTS[name].route}” was not an admin envelope.`,
      },
    };
  }

  const declared = (parsed as Record<string, unknown>).contractVersion;
  const newer = refuseFutureVersion('contract', declared, 'contractVersion');
  if (newer !== null) return { ok: false, failure: { kind: 'version', error: newer } };
  const older = refusePastVersion('contract', declared, 'contractVersion');
  if (older !== null) return { ok: false, failure: { kind: 'version', error: older } };

  const envelope = adminResponse(ADMIN_ENDPOINTS[name].response).safeParse(parsed);
  if (!envelope.success) {
    return {
      ok: false,
      failure: {
        kind: 'unreadable',
        status: reply.status,
        message:
          `The admin service answered “${ADMIN_ENDPOINTS[name].route}” in a shape this build ` +
          'cannot read. Both ends agree on the contract version, so this is a defect in one of ' +
          'the two builds rather than a version mismatch.',
      },
    };
  }

  const answer = envelope.data;
  if (!answer.ok) {
    return { ok: false, failure: { kind: 'refused', status: reply.status, errors: answer.errors } };
  }
  return { ok: true, value: answer.payload as AdminResponseOf<N> };
}
