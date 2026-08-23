import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isErr, unwrap } from '@tcg/shared';

import {
  ADMIN_ENVIRONMENT_KEYS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_REQUEST_LIMITS,
  ENVIRONMENT_RESULT_ROOT_ID,
  MIN_TOKEN_LENGTH,
  isLoopbackHost,
  parseServiceConfig,
  serviceConfigFromEnvironment,
} from './config.js';

/**
 * ADR 0023 §4, executable.
 *
 * The clause being kept is short and the failure it prevents is expensive:
 * *`apps/admin-server` binds `127.0.0.1` unless told otherwise. A non-loopback
 * bind refuses to start unless an administrator token is configured out of band,
 * in the environment. There is no default token, no generated-and-printed token,
 * and no "insecure mode" flag.*
 *
 * So the tests below are as interested in what cannot be configured as in what
 * can. A configuration that could be talked into binding every interface without
 * a token is the one outcome none of these may allow.
 */

let base = '';
const TOKEN = 'a'.repeat(MIN_TOKEN_LENGTH);

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'tcg-admin-config-'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

function roots(): { catalogRoot: string; resultRoots: Record<string, string> } {
  return { catalogRoot: join(base, 'catalog'), resultRoots: { local: join(base, 'results') } };
}

describe('what counts as loopback', () => {
  it('accepts the addresses that mean “this machine”', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      expect(`${host}: ${String(isLoopbackHost(host))}`).toBe(`${host}: true`);
    }
  });

  it('refuses the addresses that mean “every interface”', () => {
    // `0.0.0.0` and `::` are the two an operator reaches for when they want the
    // lab visible from another machine, and they are exactly the two that must
    // drag the token requirement with them.
    for (const host of ['0.0.0.0', '::', '192.168.1.10', '10.0.0.4', 'lab.example.com', '']) {
      expect(`${host}: ${String(isLoopbackHost(host))}`).toBe(`${host}: false`);
    }
  });
});

describe('the default bind', () => {
  it('is loopback, and needs no token', () => {
    const config = unwrap(parseServiceConfig(roots()));
    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.loopback).toBe(true);
    expect(config.token).toBeNull();
  });

  it('carries the request limits a client is told about', () => {
    const config = unwrap(parseServiceConfig(roots()));
    expect(config.requestLimits).toEqual(DEFAULT_REQUEST_LIMITS);
    expect(config.requestLimits.maxRequestBytes).toBe(128 * 1024);
  });

  it('accepts a token on loopback too, and then requires it', () => {
    // Loopback does not *need* one; configuring one anyway must still be honoured,
    // because "I share this machine" is a real reason and a service that ignored
    // the token would be quietly less protected than the operator believes.
    const config = unwrap(parseServiceConfig({ ...roots(), token: TOKEN }));
    expect(config.token).toBe(TOKEN);
  });
});

describe('a non-loopback bind', () => {
  it('refuses to start without a token', () => {
    const refused = parseServiceConfig({ ...roots(), host: '0.0.0.0' });
    expect(isErr(refused)).toBe(true);
    expect(isErr(refused) && refused.error.some((e) => e.code === 'admin/unauthorized')).toBe(true);
    expect(isErr(refused) && refused.error[0]?.message).toContain('no insecure mode');
  });

  it('starts with one', () => {
    const config = unwrap(parseServiceConfig({ ...roots(), host: '0.0.0.0', token: TOKEN }));
    expect(config.loopback).toBe(false);
    expect(config.token).toBe(TOKEN);
  });

  it('refuses a token short enough to guess, rather than accepting it', () => {
    const refused = parseServiceConfig({ ...roots(), host: '0.0.0.0', token: 'hunter2' });
    expect(isErr(refused)).toBe(true);
    // Two refusals: the token is not a token, and the bind therefore has none.
    expect(isErr(refused) && refused.error.map((e) => e.code)).toContain('admin/schema');
    expect(isErr(refused) && refused.error.map((e) => e.code)).toContain('admin/unauthorized');
  });

  it('never puts the rejected token in the refusal', () => {
    const secret = 'short-but-secret';
    const refused = parseServiceConfig({ ...roots(), host: '0.0.0.0', token: secret });
    const rendered = JSON.stringify(isErr(refused) ? refused.error : []);
    expect(rendered).not.toContain(secret);
    expect(rendered).toContain('configuredLength');
  });

  it('refuses a token with characters that could break a header', () => {
    for (const bad of ['a'.repeat(31), `${'a'.repeat(40)}\n`, `${'a'.repeat(40)} b`]) {
      const refused = parseServiceConfig({ ...roots(), host: '0.0.0.0', token: bad });
      expect(`${bad.length}: ${String(isErr(refused))}`).toBe(`${bad.length}: true`);
    }
  });
});

describe('the roots and the bound', () => {
  it('refuses a relative root rather than resolving it against the working directory', () => {
    const refused = parseServiceConfig({
      catalogRoot: 'catalog',
      resultRoots: { local: 'results' },
    });
    expect(isErr(refused)).toBe(true);
  });

  it('refuses a default result root that is not configured', () => {
    const refused = parseServiceConfig({ ...roots(), defaultResultRootId: 'archive' });
    expect(isErr(refused)).toBe(true);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/unsafe_result_reference');
  });

  it('refuses a resource limit that would stall the queue', () => {
    expect(isErr(parseServiceConfig({ ...roots(), limits: { maxWorkers: 0 } }))).toBe(true);
    expect(
      isErr(parseServiceConfig({ ...roots(), limits: { maxWorkers: 2, maxWorkersPerJob: 4 } })),
    ).toBe(true);
  });

  it('takes the operator’s bound when it is legal', () => {
    const config = unwrap(
      parseServiceConfig({
        ...roots(),
        limits: { maxConcurrentJobs: 2, maxWorkers: 6, maxWorkersPerJob: 3 },
      }),
    );
    expect(config.limits).toEqual({ maxConcurrentJobs: 2, maxWorkers: 6, maxWorkersPerJob: 3 });
  });
});

describe('reading the configuration out of the environment', () => {
  it('requires both roots and names the variables when they are missing', () => {
    const refused = serviceConfigFromEnvironment({});
    expect(isErr(refused)).toBe(true);
    const rendered = JSON.stringify(isErr(refused) ? refused.error : []);
    expect(rendered).toContain(ADMIN_ENVIRONMENT_KEYS.catalogRoot);
    expect(rendered).toContain(ADMIN_ENVIRONMENT_KEYS.resultRoot);
  });

  it('configures one result root, under the identifier the catalog will record', () => {
    const config = unwrap(
      serviceConfigFromEnvironment({
        [ADMIN_ENVIRONMENT_KEYS.catalogRoot]: join(base, 'catalog'),
        [ADMIN_ENVIRONMENT_KEYS.resultRoot]: join(base, 'results'),
      }),
    );
    expect([...config.roots.resultRoots.keys()]).toEqual([ENVIRONMENT_RESULT_ROOT_ID]);
    expect(config.resultRootId).toBe(ENVIRONMENT_RESULT_ROOT_ID);
  });

  it('treats an empty token as no token, not as a token nobody can send', () => {
    const refused = serviceConfigFromEnvironment({
      [ADMIN_ENVIRONMENT_KEYS.catalogRoot]: join(base, 'catalog'),
      [ADMIN_ENVIRONMENT_KEYS.resultRoot]: join(base, 'results'),
      [ADMIN_ENVIRONMENT_KEYS.host]: '0.0.0.0',
      [ADMIN_ENVIRONMENT_KEYS.token]: '   ',
    });
    expect(isErr(refused)).toBe(true);
    expect(isErr(refused) && refused.error.some((e) => e.code === 'admin/unauthorized')).toBe(true);
  });

  it('refuses a bound that is not a number rather than falling back to one', () => {
    const refused = serviceConfigFromEnvironment({
      [ADMIN_ENVIRONMENT_KEYS.catalogRoot]: join(base, 'catalog'),
      [ADMIN_ENVIRONMENT_KEYS.resultRoot]: join(base, 'results'),
      [ADMIN_ENVIRONMENT_KEYS.maxWorkers]: 'lots',
    });
    expect(isErr(refused)).toBe(true);
  });

  it('has no variable that turns authentication off', () => {
    // The absence ADR 0023 §4 asks for, stated as a closed set: eight variables,
    // and none of them is a switch.
    expect(Object.keys(ADMIN_ENVIRONMENT_KEYS).sort()).toEqual([
      'catalogRoot',
      'host',
      'maxConcurrentJobs',
      'maxWorkers',
      'maxWorkersPerJob',
      'port',
      'resultRoot',
      'token',
    ]);
  });
});
