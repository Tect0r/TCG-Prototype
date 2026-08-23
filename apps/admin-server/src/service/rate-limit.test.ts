import { describe, expect, it } from 'vitest';

import { DEFAULT_MAX_TRACKED_CLIENTS, RateLimiter } from './rate-limit.js';

/**
 * The bound on how often one caller may ask, and the two properties that are
 * easy to get subtly wrong: a refused request must not extend the window, and
 * the map that remembers callers must not grow without limit.
 */

function limiterAt(now: { value: number }, requestsPerWindow = 3, windowMs = 1_000): RateLimiter {
  return new RateLimiter({ requestsPerWindow, windowMs, clock: () => now.value });
}

describe('a window', () => {
  it('allows exactly what it says and then refuses', () => {
    const now = { value: 0 };
    const limiter = limiterAt(now);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('counts down the requests that are left', () => {
    const now = { value: 0 };
    const limiter = limiterAt(now);
    expect(limiter.check('a').remaining).toBe(2);
    expect(limiter.check('a').remaining).toBe(1);
    expect(limiter.check('a').remaining).toBe(0);
  });

  it('says how long until it resets', () => {
    const now = { value: 0 };
    const limiter = limiterAt(now);
    limiter.check('a');
    now.value = 400;
    expect(limiter.check('a').retryAfterMs).toBe(600);
  });

  it('resets once it has elapsed', () => {
    const now = { value: 0 };
    const limiter = limiterAt(now);
    for (let index = 0; index < 4; index += 1) limiter.check('a');
    now.value = 1_000;
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('does not extend itself when a refused caller keeps trying', () => {
    // The failure this exists to prevent is a lockout: if a refusal restarted the
    // window, a client retrying every 100 ms would never be let back in, and the
    // administrator would lose access to their own lab at the moment they most
    // want it.
    const now = { value: 0 };
    const limiter = limiterAt(now);
    for (let index = 0; index < 3; index += 1) limiter.check('a');
    for (let index = 0; index < 20; index += 1) {
      now.value += 40;
      expect(limiter.check('a').allowed).toBe(false);
    }
    now.value = 1_000;
    expect(limiter.check('a').allowed).toBe(true);
  });

  it('counts each caller separately', () => {
    const now = { value: 0 };
    const limiter = limiterAt(now);
    for (let index = 0; index < 4; index += 1) limiter.check('a');
    expect(limiter.check('b').allowed).toBe(true);
  });
});

describe('the map of callers', () => {
  it('is bounded, so an address nobody controls cannot grow it forever', () => {
    const now = { value: 0 };
    const limiter = new RateLimiter({
      requestsPerWindow: 10,
      windowMs: 60_000,
      clock: () => now.value,
      maxClients: 4,
    });
    for (let index = 0; index < 50; index += 1) {
      now.value += 1;
      limiter.check(`client-${String(index)}`);
    }
    expect(limiter.tracked).toBeLessThanOrEqual(4);
  });

  it('drops the coldest window first, so an active caller keeps its count', () => {
    const now = { value: 0 };
    const limiter = new RateLimiter({
      requestsPerWindow: 2,
      windowMs: 60_000,
      clock: () => now.value,
      maxClients: 2,
    });
    limiter.check('old');
    now.value = 10;
    limiter.check('busy');
    now.value = 20;
    limiter.check('busy');
    now.value = 30;
    // `new` evicts `old` — the coldest — rather than the caller that is active.
    limiter.check('new');
    expect(limiter.check('busy').allowed).toBe(false);
  });

  it('has a default bound rather than none', () => {
    expect(DEFAULT_MAX_TRACKED_CLIENTS).toBeGreaterThan(0);
  });
});
