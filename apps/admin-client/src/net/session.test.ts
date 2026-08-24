import { ADMIN_CONTRACT_VERSION } from '@tcg/admin-contracts';
import { describe, expect, it } from 'vitest';

import { AdminSession } from './session.js';
import { capabilitiesFixture, fakeService } from '../test/fake-service.js';

/**
 * The connection as a state machine, driven without a DOM.
 *
 * The properties here are the ones a screen is entitled to rely on: that the
 * token is asked for only when the service asks for it, that it is held in
 * memory and published nowhere, that a rejected token is dropped rather than
 * re-sent, and that capabilities and presets fail apart.
 */

const TOKEN = 'k'.repeat(32);

describe('connecting', () => {
  it('connects with no token when the service requires none', async () => {
    const service = fakeService();
    const session = new AdminSession({ transport: service.transport });

    await session.connect();

    expect(session.state.connection.status).toBe('connected');
    if (session.state.connection.status !== 'connected') return;
    expect(session.state.connection.authenticated).toBe(false);
    expect(session.state.connection.capabilities.versions.contract).toBe(ADMIN_CONTRACT_VERSION);
    expect(session.hasToken).toBe(false);
  });

  it('asks for a token only because the service refused, never in advance', async () => {
    const service = fakeService({ token: TOKEN });
    const session = new AdminSession({ transport: service.transport });

    await session.connect();

    expect(session.state.connection.status).toBe('needs_token');
    if (session.state.connection.status !== 'needs_token') return;
    // No token had been offered yet, so there is nothing to report as refused.
    expect(session.state.connection.failure).toBeNull();
    // The first request went out without a token: asking is the only way to
    // learn the access policy.
    expect(service.requests[0]?.headers['x-admin-token']).toBeUndefined();
  });

  it('connects once the right token is supplied, and reports it as authenticated', async () => {
    const service = fakeService({ token: TOKEN });
    const session = new AdminSession({ transport: service.transport });

    await session.connect();
    await session.connect(TOKEN);

    expect(session.state.connection.status).toBe('connected');
    if (session.state.connection.status !== 'connected') return;
    expect(session.state.connection.authenticated).toBe(true);
    expect(session.hasToken).toBe(true);
  });

  it('drops a token the service refused rather than re-sending it', async () => {
    const service = fakeService({ token: TOKEN });
    const session = new AdminSession({ transport: service.transport });

    await session.connect('wrong-token-value-that-is-long-enough');

    expect(session.state.connection.status).toBe('needs_token');
    if (session.state.connection.status !== 'needs_token') return;
    expect(session.state.connection.failure).not.toBeNull();
    expect(session.hasToken).toBe(false);

    await session.connect();
    const last = service.requests.at(-1);
    expect(last?.headers['x-admin-token']).toBeUndefined();
  });

  it('publishes no token, in any field, at any depth', async () => {
    const service = fakeService({ token: TOKEN });
    const session = new AdminSession({ transport: service.transport });

    await session.connect(TOKEN);

    expect(JSON.stringify(session.state)).not.toContain(TOKEN);
  });

  it('reports an unreachable process as unavailable rather than as a token problem', async () => {
    const service = fakeService({ unreachable: true });
    const session = new AdminSession({ transport: service.transport });

    await session.connect();

    expect(session.state.connection.status).toBe('unavailable');
    if (session.state.connection.status !== 'unavailable') return;
    expect(session.state.connection.failure.kind).toBe('unreachable');
  });
});

describe('the reading', () => {
  it('records when it was taken, from the clock it was given', async () => {
    const service = fakeService();
    const session = new AdminSession({
      transport: service.transport,
      now: () => new Date('2026-08-24T09:30:00.000Z'),
    });

    await session.connect();

    expect(session.state.connection.status).toBe('connected');
    if (session.state.connection.status !== 'connected') return;
    expect(session.state.connection.checkedAt).toBe('2026-08-24T09:30:00.000Z');
  });

  it('does not call a first reading a restart', async () => {
    const service = fakeService();
    const session = new AdminSession({ transport: service.transport });

    await session.connect();

    expect(session.state.connection.status).toBe('connected');
    if (session.state.connection.status !== 'connected') return;
    expect(session.state.connection.restarted).toBe(false);
  });

  it('notices a restart when the process reports a different start time', async () => {
    const service = fakeService();
    const session = new AdminSession({ transport: service.transport });
    await session.connect();

    service.configure({ capabilities: { startedAt: '2026-08-24T11:00:00.000Z' } });
    await session.refresh();

    expect(session.state.connection.status).toBe('connected');
    if (session.state.connection.status !== 'connected') return;
    expect(session.state.connection.restarted).toBe(true);
  });

  it('does not call an unchanged start time a restart', async () => {
    const service = fakeService();
    const session = new AdminSession({ transport: service.transport });
    await session.connect();
    await session.refresh();

    expect(session.state.connection.status).toBe('connected');
    if (session.state.connection.status !== 'connected') return;
    expect(session.state.connection.restarted).toBe(false);
  });
});

describe('the preset catalog', () => {
  it('arrives with the connection', async () => {
    const service = fakeService();
    const session = new AdminSession({ transport: service.transport });

    await session.connect();

    expect(session.state.presets.status).toBe('ready');
    if (session.state.presets.status !== 'ready') return;
    expect(session.state.presets.value.presets.length).toBeGreaterThan(5);
  });

  it('fails on its own without disconnecting the session', async () => {
    const service = fakeService({ refuse: { presets: 'admin/rate_limited' } });
    const session = new AdminSession({ transport: service.transport });

    await session.connect();

    expect(session.state.connection.status).toBe('connected');
    expect(session.state.presets.status).toBe('failed');
  });

  it('can be asked for again after it alone failed', async () => {
    const service = fakeService({ refuse: { presets: 'admin/rate_limited' } });
    const session = new AdminSession({ transport: service.transport });
    await session.connect();

    service.configure({});
    await session.reloadPresets();

    expect(session.state.presets.status).toBe('ready');
    expect(session.state.connection.status).toBe('connected');
  });

  it('is not asked for while there is no connection', async () => {
    const service = fakeService({ unreachable: true });
    const session = new AdminSession({ transport: service.transport });
    await session.connect();
    const sent = service.requests.length;

    await session.reloadPresets();

    expect(service.requests.length).toBe(sent);
  });
});

describe('forgetting the token', () => {
  it('returns to the gate and stops holding it', async () => {
    const service = fakeService({ token: TOKEN });
    const session = new AdminSession({ transport: service.transport });
    await session.connect(TOKEN);

    session.forget();

    expect(session.state.connection.status).toBe('needs_token');
    expect(session.state.presets.status).toBe('idle');
    expect(session.hasToken).toBe(false);
  });

  it('forgets the start time too, so the next connection is not read as a restart', async () => {
    const service = fakeService({ token: TOKEN });
    const session = new AdminSession({ transport: service.transport });
    await session.connect(TOKEN);

    session.forget();
    service.configure({ token: TOKEN, capabilities: { startedAt: '2026-08-24T12:00:00.000Z' } });
    await session.connect(TOKEN);

    expect(session.state.connection.status).toBe('connected');
    if (session.state.connection.status !== 'connected') return;
    expect(session.state.connection.restarted).toBe(false);
  });
});

describe('subscribers', () => {
  it('are told after every published change, and can unsubscribe', async () => {
    const service = fakeService();
    const session = new AdminSession({ transport: service.transport });
    let seen = 0;
    const stop = session.subscribe(() => {
      seen += 1;
    });

    await session.connect();
    const during = seen;
    stop();
    await session.refresh();

    expect(during).toBeGreaterThan(1);
    expect(seen).toBe(during);
  });

  it('see a snapshot that is frozen, so nothing can edit the state in place', async () => {
    const service = fakeService();
    const session = new AdminSession({ transport: service.transport });
    await session.connect();

    expect(Object.isFrozen(session.state)).toBe(true);
  });
});

describe('the fixture itself', () => {
  it('is a capabilities answer the contract accepts, so these tests mean something', () => {
    const capabilities = capabilitiesFixture();
    expect(capabilities.versions.contract).toBe(ADMIN_CONTRACT_VERSION);
    expect(capabilities.resultRootIds).toEqual(['default']);
  });
});
