import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  ADMIN_CONTRACT_VERSION,
  ADMIN_ENDPOINTS,
  ADMIN_PATH_PATTERN,
  ADMIN_ROUTES,
  adminError,
  adminRequest,
  adminSchemaErrors,
  refuseFutureVersion,
  refusePastVersion,
  type AdminEndpointName,
  type AdminError,
  type AdminErrorCode,
} from '@tcg/admin-contracts';
import { isErr } from '@tcg/shared';

import { ADMIN_TOKEN_HEADER, type AdminServiceConfig } from './config.js';
import type { AdminService } from './handlers.js';
import { RateLimiter } from './rate-limit.js';

/**
 * The only file in this workspace that knows about sockets.
 *
 * It is deliberately the only one, the same way `ws-adapter.ts` is the only file
 * in the live match server that knows about WebSockets: everything above it
 * takes a parsed payload and answers with a value or a list of refusals, so the
 * handlers can be driven end to end without a port and the transport can be
 * exercised without a queue.
 *
 * ## The order the checks run in, and why it is that order
 *
 * Each step is placed where it costs the least and refuses the most:
 *
 * 1. **Rate limit.** Before anything is parsed, because the cheapest request to
 *    refuse is the one nothing has been done for yet, and the caller a limit
 *    exists to stop is the one sending thousands.
 * 2. **Method.** `POST` only. There is no `GET` anywhere in this contract, which
 *    is what keeps every input inside a validated body and out of a URL a proxy
 *    logs (ADR 0023 §4, §5).
 * 3. **Address shape and version.** `/admin/v{n}/{route}`, with `n` compared
 *    against `ADMIN_CONTRACT_VERSION`. A recognisable address under another
 *    version gets the repository's readable newer-build or older-build sentence;
 *    only an address that is not an endpoint at all gets `admin/unknown_endpoint`.
 * 4. **Authentication.** After routing so the answer does not depend on whether
 *    a path exists, and *before* the body is read so an unauthenticated caller
 *    cannot make this process allocate a hundred kilobytes per request.
 * 5. **Size, then bytes, then JSON, then schema.** The declared length is checked
 *    first and the stream is measured as it arrives, because `content-length` is
 *    a claim rather than a fact.
 * 6. **Handler, then the response schema.** Every answer is validated against
 *    the endpoint's own response schema before it is written. That is the second
 *    of the two boundaries the milestone asks to be schema-validated, and it is
 *    the one that is easy to skip because nothing fails when it is missing.
 *
 * ## What is deliberately absent
 *
 * **No CORS headers.** None are sent, so a browser page from another origin
 * cannot read an answer. M08.7 builds the admin client and will have a dev server
 * on another port; deciding its origin policy here — before the client exists,
 * and with no way to test the decision — would be widening the boundary on a
 * guess. It is recorded as M08.7's to settle.
 *
 * **No `GET /health`.** The live match server has one because a person needs to
 * know whether matches are being served without a client. Here the equivalent is
 * `capabilities`, which is authenticated when a token is configured; an
 * unauthenticated probe would be a second, quieter door and would report exactly
 * the fact an unauthenticated caller most wants — that a lab is here.
 *
 * **No request logging.** Nothing writes a request line, and that is not an
 * omission to fix later without thought: ADR 0023 §4 says the token appears in
 * *no log line*, and a logger added carelessly is the most likely way that stops
 * being true.
 */

export interface AdminHttpServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Longest a body may be before the socket is refused rather than drained. */
const JSON_CONTENT_TYPES = ['application/json', 'text/json'];

/**
 * Which HTTP status one refusal deserves.
 *
 * A closed mapping over the contract's closed code list, so a code added later
 * without a status here is a compile error rather than a silent 500. The codes
 * are the contract; the numbers are this transport's translation of them, and
 * nothing above this file knows a status exists.
 */
const STATUS_FOR: Readonly<Record<AdminErrorCode, number>> = Object.freeze({
  'admin/malformed': 400,
  'admin/schema': 400,
  'admin/unsupported_version': 400,
  'admin/missing_version': 400,
  'admin/illegal_transition': 409,
  'admin/unknown_batch': 404,
  'admin/unknown_job': 404,
  'admin/catalog_limit': 409,
  // A read this service will not put in one answer. 413 rather than 409: the
  // request was legal and the *response* is what is too large, which is the one
  // case where the payload-size status is about the answer rather than the ask.
  'admin/artifact_too_large': 413,
  'admin/duplicate_id': 409,
  'admin/invalid_cursor': 400,
  'admin/incompatible_filter': 400,
  'admin/unsafe_result_reference': 409,
  'admin/run_failed': 500,
  'admin/unsafe_error_context': 500,
  'admin/unauthorized': 401,
  'admin/rate_limited': 429,
  'admin/payload_too_large': 413,
  'admin/unknown_endpoint': 404,
  'admin/no_result': 404,
  'admin/already_running': 409,
});

/**
 * The status a whole answer gets: the most severe of its refusals.
 *
 * "Most severe" rather than "the first", because a response carries several
 * errors — a schema failure is naturally several — and answering 400 to a list
 * whose first member happens to be a validation problem would hide a 401 sitting
 * behind it. The maximum is the safe direction: it never reports a failure as
 * less serious than it is.
 */
function statusFor(errors: readonly AdminError[]): number {
  return errors.reduce((worst, entry) => Math.max(worst, STATUS_FOR[entry.code]), 400);
}

export interface StartAdminHttpOptions {
  readonly service: AdminService;
  /** Injectable so a rate-limit test moves time rather than waiting for it. */
  readonly clock?: () => number;
}

export async function startAdminHttpServer(
  options: StartAdminHttpOptions,
): Promise<AdminHttpServer> {
  const config = options.service.config;
  const limiter = new RateLimiter({
    requestsPerWindow: config.requestLimits.requestsPerWindow,
    windowMs: config.requestLimits.windowMs,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const server = createServer((request, response) => {
    void serve(options.service, config, limiter, request, response).catch(() => {
      // A throw that reached here is a defect rather than a bad request, and the
      // one thing that must not happen is a socket left open. Nothing about the
      // failure travels: an unhandled error's message is the least curated string
      // in the process.
      respond(response, 500, [
        adminError(
          'admin/schema',
          'This service failed to answer, and the failure was not one it can describe. This is a defect in the build.',
        ),
      ]);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;

  return {
    host: config.host,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function serve(
  service: AdminService,
  config: AdminServiceConfig,
  limiter: RateLimiter,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const decision = limiter.check(request.socket.remoteAddress ?? 'unknown');
  if (!decision.allowed) {
    response.setHeader('retry-after', String(Math.ceil(decision.retryAfterMs / 1000)));
    respond(response, 429, [
      adminError(
        'admin/rate_limited',
        `This caller has used its ${String(config.requestLimits.requestsPerWindow)} requests for the current window. Try again once it resets.`,
        { context: { retryAfterMs: decision.retryAfterMs } },
      ),
    ]);
    return;
  }

  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST');
    respond(response, 405, [
      adminError(
        'admin/unknown_endpoint',
        'Every admin endpoint is a POST with a JSON envelope, so that nothing an administrator sends travels in a URL.',
      ),
    ]);
    return;
  }

  const route = resolveRoute(request.url ?? '');
  if (!route.ok) {
    respond(response, statusFor(route.errors), route.errors);
    return;
  }

  if (!authorized(config, request)) {
    respond(response, 401, [
      adminError(
        'admin/unauthorized',
        `This service requires an administrator token in the \`${ADMIN_TOKEN_HEADER}\` header.`,
      ),
    ]);
    return;
  }

  const body = await readBody(request, config.requestLimits.maxRequestBytes);
  if (!body.ok) {
    // A refused body is a body still arriving, so the answer is written first and
    // the request is abandoned only once it has flushed. Destroying the socket
    // straight away would deliver the refusal to nobody, and a caller that never
    // learns why it was refused retries forever.
    if (body.oversized) {
      response.setHeader('connection', 'close');
      response.once('finish', () => {
        request.destroy();
      });
    }
    respond(response, statusFor(body.errors), body.errors);
    return;
  }

  const endpoint = ADMIN_ENDPOINTS[route.name];
  const envelope = adminRequest(endpoint.request).safeParse(body.value);
  if (!envelope.success) {
    respond(response, 400, adminSchemaErrors(envelope.error));
    return;
  }

  const answer = await service.handle(
    route.name,
    // The payload has just been parsed by this endpoint's own request schema.
    // The generic parameter is the runtime name, which TypeScript cannot tie to
    // the value the parse produced; `AdminService.handle` narrows it back and the
    // response is validated below.
    envelope.data.payload as never,
  );
  if (isErr(answer)) {
    respond(response, statusFor(answer.error), answer.error);
    return;
  }

  // The outbound half of "request and response schemas validated on both
  // boundaries". A handler that built something its own contract does not
  // describe is a defect, and it is reported as one rather than sent.
  const validated = endpoint.response.safeParse(answer.value);
  if (!validated.success) {
    respond(response, 500, [
      adminError(
        'admin/schema',
        'This service built an answer it could not validate against its own contract, so it was not sent. This is a defect in the build rather than a problem with the request.',
        { context: { endpoint: route.name } },
      ),
    ]);
    return;
  }

  writeJson(response, 200, {
    ok: true,
    contractVersion: ADMIN_CONTRACT_VERSION,
    payload: validated.data,
  });
}

/* ------------------------------------------------------------------ routing */

type RouteResult =
  | { readonly ok: true; readonly name: AdminEndpointName }
  | { readonly ok: false; readonly errors: readonly AdminError[] };

/**
 * Turns a request target into an endpoint name, or into the refusal that says
 * why not.
 *
 * The query string is discarded rather than parsed. Nothing in this contract
 * travels in one, and a router that read one would be the first place a
 * filesystem path could arrive without passing a schema.
 */
export function resolveRoute(target: string): RouteResult {
  const path = target.split('?')[0] ?? '';
  const match = ADMIN_PATH_PATTERN.exec(path);
  if (match === null) return { ok: false, errors: [unknownEndpoint()] };

  const declared = Number(match[1]);
  const name = ADMIN_ROUTES.get(match[2] ?? '');
  if (name === undefined) return { ok: false, errors: [unknownEndpoint()] };

  // The route exists, so a version mismatch is a build mismatch rather than a
  // typo, and it gets the sentence that says so.
  if (declared !== ADMIN_CONTRACT_VERSION) {
    const refusal =
      refuseFutureVersion('contract', declared, 'contractVersion') ??
      refusePastVersion('contract', declared, 'contractVersion');
    return { ok: false, errors: [refusal ?? unknownEndpoint()] };
  }

  return { ok: true, name };
}

function unknownEndpoint(): AdminError {
  return adminError(
    'admin/unknown_endpoint',
    `No endpoint of this service answers there. Addresses are \`/admin/v${String(ADMIN_CONTRACT_VERSION)}/{endpoint}\`.`,
  );
}

/* ----------------------------------------------------------- authentication */

/**
 * Whether this request carries the configured token, compared without leaking
 * how nearly it matched.
 *
 * Both values are hashed and the digests compared with `timingSafeEqual`. Hashing
 * first is what makes the comparison constant-time *including in the length*: a
 * direct compare of two buffers has to return early when the lengths differ,
 * which tells a caller how long the real token is, and length is the one thing
 * about a secret that is cheap to learn and expensive to have leaked.
 *
 * A repeated header — `x-admin-token: a, x-admin-token: b` — arrives as an array
 * and is refused rather than joined. A caller sending two tokens does not have
 * one, and joining them would be inventing a third.
 */
export function authorized(config: AdminServiceConfig, request: IncomingMessage): boolean {
  if (config.token === null) return true;
  const supplied = request.headers[ADMIN_TOKEN_HEADER];
  if (typeof supplied !== 'string') return false;
  return sameSecret(supplied, config.token);
}

function sameSecret(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/* -------------------------------------------------------------------- body */

type BodyResult =
  | { readonly ok: true; readonly value: unknown; readonly oversized?: false }
  | { readonly ok: false; readonly errors: readonly AdminError[]; readonly oversized?: boolean };

/**
 * Reads a bounded JSON body, refusing before it allocates rather than after.
 *
 * `content-length` is checked first because it is free, and then the stream is
 * measured as it arrives because the header is a claim: a chunked request
 * declares no length at all, and a lying one declares the wrong one. The socket
 * is destroyed on the way out rather than drained — continuing to read a body
 * already known to be too long is doing the work the limit exists to avoid.
 */
async function readBody(request: IncomingMessage, maxBytes: number): Promise<BodyResult> {
  const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (
    contentType !== undefined &&
    contentType !== '' &&
    !JSON_CONTENT_TYPES.includes(contentType)
  ) {
    return {
      ok: false,
      errors: [
        adminError('admin/malformed', 'Every admin request carries a JSON body.', {
          context: { contentType },
        }),
      ],
    };
  }

  const declared = Number(request.headers['content-length'] ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, errors: [tooLarge(maxBytes)], oversized: true };
  }

  const chunks: Buffer[] = [];
  let received = 0;
  try {
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      received += buffer.length;
      if (received > maxBytes) {
        // The declared length was absent or a lie. The bytes stop being read
        // here, which is the whole point of measuring the stream rather than
        // trusting the header.
        return { ok: false, errors: [tooLarge(maxBytes)], oversized: true };
      }
      chunks.push(buffer);
    }
  } catch {
    return {
      ok: false,
      errors: [adminError('admin/malformed', 'The request body did not arrive completely.')],
    };
  }

  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed: unknown = JSON.parse(text === '' ? '{}' : text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        errors: [adminError('admin/malformed', 'An admin request body is a JSON object.')],
      };
    }
    return { ok: true, value: parsed };
  } catch {
    return {
      ok: false,
      errors: [adminError('admin/malformed', 'The request body is not readable JSON.')],
    };
  }
}

function tooLarge(maxBytes: number): AdminError {
  return adminError(
    'admin/payload_too_large',
    `An admin request body is at most ${String(maxBytes)} bytes, and this one is longer, so it was refused rather than read.`,
    { context: { maxBytes } },
  );
}

/* ------------------------------------------------------------------ writing */

function respond(response: ServerResponse, status: number, errors: readonly AdminError[]): void {
  writeJson(response, status, {
    ok: false,
    contractVersion: ADMIN_CONTRACT_VERSION,
    errors,
  });
}

/**
 * Writes one answer, with the headers an admin answer always has.
 *
 * `no-store` because every one of these is a reading of live state, and a queue
 * listing served from a cache would show an operator a run that finished ten
 * minutes ago. `nosniff` because the body is JSON and a browser that guessed
 * otherwise would be guessing about a document only an administrator can fetch.
 */
function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}
