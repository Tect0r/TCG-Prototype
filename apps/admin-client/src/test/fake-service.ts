import {
  ADMIN_CONTRACT_VERSION,
  ADMIN_ENDPOINTS,
  CURRENT_ADMIN_VERSIONS,
  MAX_FILTER_VALUES,
  MAX_JOBS_PER_BATCH,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PRESET_REGISTRY,
  adminError,
  type AdminEndpointName,
  type AdminErrorCode,
  type Capabilities,
  type PresetCatalog,
} from '@tcg/admin-contracts';

import type { AdminHttpRequest, AdminHttpReply, AdminTransport } from '../net/transport.js';

/**
 * A lab that answers, without a port.
 *
 * Every answer is built out of the contract's own schemas and constants — the
 * preset catalog is `PRESET_REGISTRY` itself rather than a hand-written copy —
 * so a test that passes here is a test against the shapes the real service is
 * validated against on the way out. What the fake does not do is enforce the
 * service's *policy*: it refuses a token because a test told it to, not because
 * it read one. That policy has its own suite in `apps/admin-server`, and
 * re-implementing it here would be the admin client growing a second opinion
 * about who may connect.
 */

export interface FakeServiceOptions {
  /** When set, a request must carry exactly this token or be refused. */
  readonly token?: string;
  readonly capabilities?: Partial<Capabilities>;
  /** Answers this endpoint with a refusal instead of a value. */
  readonly refuse?: Partial<Record<AdminEndpointName, AdminErrorCode>>;
  /** Throws instead of answering, the way a dead process does. */
  readonly unreachable?: boolean;
}

export interface FakeService {
  readonly transport: AdminTransport;
  /** Every request the client actually sent, in order. */
  readonly requests: AdminHttpRequest[];
  /** Replaces the answers mid-test, so a restart or a recovery can be driven. */
  configure(options: FakeServiceOptions): void;
}

export function capabilitiesFixture(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    versions: { ...CURRENT_ADMIN_VERSIONS },
    access: { loopback: true, authenticationRequired: false },
    limits: {
      maxRequestBytes: 131_072,
      requestsPerWindow: 240,
      windowMs: 60_000,
      pageSizeDefault: PAGE_SIZE_DEFAULT,
      pageSizeMax: PAGE_SIZE_MAX,
      maxFilterValues: MAX_FILTER_VALUES,
      maxJobsPerBatch: MAX_JOBS_PER_BATCH,
    },
    orchestrator: { maxConcurrentJobs: 1, maxWorkers: 7, maxWorkersPerJob: 7 },
    resultRootIds: ['default'],
    formatId: 'precon_wave_1',
    startedAt: '2026-08-24T09:00:00.000Z',
    ...overrides,
  };
}

export function presetCatalogFixture(): PresetCatalog {
  return {
    presets: Object.values(PRESET_REGISTRY).map((preset) => ({
      ...preset,
      kinds: [...preset.kinds],
      sourceClasses: [...preset.sourceClasses],
      limitations: [...preset.limitations],
    })),
  };
}

export function fakeService(initial: FakeServiceOptions = {}): FakeService {
  let options = initial;
  const requests: AdminHttpRequest[] = [];

  const transport: AdminTransport = async (request) => {
    requests.push(request);
    if (options.unreachable === true) throw new TypeError('Failed to fetch');

    const name = endpointOf(request.path);
    if (name === null) return refusal('admin/unknown_endpoint', 404);

    if (options.token !== undefined && request.headers['x-admin-token'] !== options.token) {
      return refusal('admin/unauthorized', 401);
    }

    const refused = options.refuse?.[name];
    if (refused !== undefined) return refusal(refused, 500);

    if (name === 'capabilities') {
      return answer(capabilitiesFixture(options.capabilities ?? {}));
    }
    if (name === 'presets') return answer(presetCatalogFixture());
    return refusal('admin/unknown_endpoint', 404);
  };

  return {
    transport,
    requests,
    configure(next) {
      options = next;
    },
  };
}

/** An answer whose envelope declares a version this build does not speak. */
export function versionedTransport(contractVersion: number): AdminTransport {
  return async () =>
    Promise.resolve({
      status: 200,
      body: JSON.stringify({ ok: true, contractVersion, payload: capabilitiesFixture() }),
    });
}

/** A transport that answers with bytes that are not this contract at all. */
export function bodyTransport(status: number, body: string): AdminTransport {
  return async () => Promise.resolve({ status, body });
}

function endpointOf(path: string): AdminEndpointName | null {
  for (const name of Object.keys(ADMIN_ENDPOINTS) as AdminEndpointName[]) {
    if (path === `/admin/v${String(ADMIN_CONTRACT_VERSION)}/${ADMIN_ENDPOINTS[name].route}`) {
      return name;
    }
  }
  return null;
}

function answer(payload: unknown): AdminHttpReply {
  return {
    status: 200,
    body: JSON.stringify({ ok: true, contractVersion: ADMIN_CONTRACT_VERSION, payload }),
  };
}

function refusal(code: AdminErrorCode, status: number): AdminHttpReply {
  return {
    status,
    body: JSON.stringify({
      ok: false,
      contractVersion: ADMIN_CONTRACT_VERSION,
      errors: [adminError(code, messageFor(code))],
    }),
  };
}

/**
 * The sentence one refusal carries.
 *
 * The wording for `admin/unauthorized` is the service's own, because the
 * connection tests assert that the client prints what the service said rather
 * than a paraphrase of it. Anything not listed gets a readable fallback: an
 * `undefined` message would fail `adminErrorSchema` on the way in, which would
 * make a fixture's omission look like a client defect.
 */
export function messageFor(code: AdminErrorCode): string {
  return MESSAGES[code] ?? 'The admin service refused this request.';
}

const MESSAGES: Readonly<Partial<Record<AdminErrorCode, string>>> = {
  'admin/unauthorized':
    'This service requires an administrator token in the `x-admin-token` header.',
  'admin/unknown_endpoint': 'No endpoint of this service answers at that address.',
  'admin/rate_limited': 'More requests arrived from this caller than the window allows.',
};
