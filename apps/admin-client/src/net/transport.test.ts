import {
  ADMIN_CONTRACT_VERSION,
  ADMIN_ENDPOINTS,
  ADMIN_ENDPOINT_NAMES,
} from '@tcg/admin-contracts';
import { describe, expect, it } from 'vitest';

import {
  ADMIN_TOKEN_HEADER,
  callAdmin,
  failureMessages,
  isUnauthorized,
  type AdminTransport,
} from './transport.js';
import { bodyTransport, fakeService, versionedTransport } from '../test/fake-service.js';

/**
 * What the client puts on the wire, and what it does with what comes back.
 *
 * These are the rules the screens above are allowed to assume: that the address
 * is relative, that the token is a header and only a header, that a version this
 * build cannot read is refused with the repository's readable sentence, and that
 * a failure is classified so a screen can tell "log in" from "the process is not
 * running".
 */

describe('the request', () => {
  it('is a POST to a relative address under /admin, with the version in the path', async () => {
    const service = fakeService();
    await callAdmin(service.transport, 'capabilities', {}, null);

    const sent = service.requests[0];
    expect(sent).toBeDefined();
    expect(sent?.path).toBe(`/admin/v${String(ADMIN_CONTRACT_VERSION)}/capabilities`);
    // Relative, so the browser can only reach the origin this page came from.
    expect(sent?.path.startsWith('/admin/')).toBe(true);
    expect(sent?.path).not.toMatch(/^https?:/);
    expect(sent?.path).not.toContain('//');
  });

  it('carries the contract version in the envelope as well as in the path', async () => {
    const service = fakeService();
    await callAdmin(service.transport, 'capabilities', {}, null);

    const body: unknown = JSON.parse(service.requests[0]?.body ?? '{}');
    expect(body).toEqual({ contractVersion: ADMIN_CONTRACT_VERSION, payload: {} });
  });

  it('sends the token as a header, and never in the address or the body', async () => {
    const token = 'a'.repeat(32);
    const service = fakeService({ token });
    await callAdmin(service.transport, 'capabilities', {}, token);

    const sent = service.requests[0];
    expect(sent?.headers[ADMIN_TOKEN_HEADER]).toBe(token);
    expect(sent?.path).not.toContain(token);
    expect(sent?.body).not.toContain(token);
  });

  it('sends no token header at all when there is no token', async () => {
    const service = fakeService();
    await callAdmin(service.transport, 'capabilities', {}, null);

    expect(Object.keys(service.requests[0]?.headers ?? {})).toEqual(['content-type']);
  });

  it('addresses every endpoint in the registry at a route the router recognises', () => {
    // Total over the thirteen, so an endpoint added later is one this client can
    // already name rather than one it silently cannot reach.
    for (const name of ADMIN_ENDPOINT_NAMES) {
      expect(ADMIN_ENDPOINTS[name].route).toMatch(/^[a-z][a-z-]{0,39}$/);
    }
  });
});

describe('the answer', () => {
  it('is the payload when the service says yes', async () => {
    const service = fakeService();
    const answer = await callAdmin(service.transport, 'capabilities', {}, null);

    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.value.formatId).toBe('precon_wave_1');
    expect(answer.value.versions.contract).toBe(ADMIN_CONTRACT_VERSION);
  });

  it('is a refusal carrying the service’s own closed code', async () => {
    const service = fakeService({ token: 'b'.repeat(32) });
    const answer = await callAdmin(service.transport, 'capabilities', {}, null);

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.failure.kind).toBe('refused');
    expect(isUnauthorized(answer.failure)).toBe(true);
    expect(failureMessages(answer.failure)[0]).toContain('administrator token');
  });

  it('refuses a newer contract version with the readable newer-build sentence', async () => {
    const answer = await callAdmin(
      versionedTransport(ADMIN_CONTRACT_VERSION + 1),
      'capabilities',
      {},
      null,
    );

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.failure.kind).toBe('version');
    if (answer.failure.kind !== 'version') return;
    expect(answer.failure.error.code).toBe('admin/unsupported_version');
    expect(answer.failure.error.message).toContain('newer build');
    expect(answer.failure.error.message).toContain('Update the application');
  });

  it('refuses an older contract version with the readable older-build sentence', async () => {
    const answer = await callAdmin(
      versionedTransport(ADMIN_CONTRACT_VERSION - 1),
      'capabilities',
      {},
      null,
    );

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.failure.kind).toBe('version');
    if (answer.failure.kind !== 'version') return;
    expect(answer.failure.error.message).toContain('older build');
    expect(answer.failure.error.message).toContain('no migration');
  });

  it('refuses an envelope that declares no readable version at all', async () => {
    const answer = await callAdmin(
      bodyTransport(200, JSON.stringify({ ok: true, payload: {} })),
      'capabilities',
      {},
      null,
    );

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.failure.kind).toBe('version');
    if (answer.failure.kind !== 'version') return;
    expect(answer.failure.error.code).toBe('admin/missing_version');
  });

  it('refuses a payload the endpoint’s own response schema does not describe', async () => {
    // Right version, wrong shape: the two builds agree on the contract, so this
    // is a defect rather than a mismatch, and the client says so.
    const answer = await callAdmin(
      bodyTransport(
        200,
        JSON.stringify({
          ok: true,
          contractVersion: ADMIN_CONTRACT_VERSION,
          payload: { formatId: 'precon_wave_1' },
        }),
      ),
      'capabilities',
      {},
      null,
    );

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.failure.kind).toBe('unreadable');
    expect(failureMessages(answer.failure)[0]).toContain('defect');
  });

  it('refuses an answer with an unknown field, because the envelope is strict', async () => {
    const answer = await callAdmin(
      bodyTransport(
        200,
        JSON.stringify({
          ok: true,
          contractVersion: ADMIN_CONTRACT_VERSION,
          payload: {},
          extra: 'unexpected',
        }),
      ),
      'capabilities',
      {},
      null,
    );

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.failure.kind).toBe('unreadable');
  });

  it('reports HTML from a proxy as something that is not the admin service', async () => {
    const answer = await callAdmin(
      bodyTransport(502, '<!doctype html><title>Bad gateway</title>'),
      'capabilities',
      {},
      null,
    );

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.failure.kind).toBe('unreadable');
    expect(failureMessages(answer.failure)[0]).toContain('502');
  });

  it('reports a transport that threw as unreachable, and says where to look', async () => {
    const dead: AdminTransport = () => Promise.reject(new TypeError('Failed to fetch'));
    const answer = await callAdmin(dead, 'capabilities', {}, null);

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.failure.kind).toBe('unreachable');
    expect(failureMessages(answer.failure)[0]).toContain('orchestration process');
  });

  it('never dresses a client-side failure up as one of the service’s codes', async () => {
    // The code list is closed and it is the service's. A client that invented a
    // member of it would put a code on the contract's vocabulary that no service
    // ever sends, and a screen branching on it would be branching on fiction.
    const dead: AdminTransport = () => Promise.reject(new TypeError('Failed to fetch'));
    const answer = await callAdmin(dead, 'capabilities', {}, null);

    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(isUnauthorized(answer.failure)).toBe(false);
    expect(answer.failure.kind).not.toBe('refused');
  });
});
