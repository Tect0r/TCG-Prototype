import { cursorSchema, looksLikeFilesystemPath, timestampSchema } from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';
import { describe, expect, it } from 'vitest';

import { comparePositions, decodeCursor, encodeCursor, isAfter } from './cursor.js';

const AT = '2026-08-21T09:30:00.000Z';
const LATER = '2026-08-21T09:30:00.001Z';

describe('a cursor round-trips a position', () => {
  it('returns the position it encoded', () => {
    const position = { createdAt: AT, id: 'job_aaaaaa1111' };
    expect(unwrap(decodeCursor(encodeCursor(position)))).toEqual(position);
  });

  it('satisfies the contract’s alphabet by construction', () => {
    // base64url has no `/`, `+` or `=`, which is why the schema's promise that a
    // cursor cannot spell a path is a property of the encoding rather than of a
    // check somebody has to remember.
    const token = encodeCursor({ createdAt: AT, id: 'batch_zzzzzz9999' });
    expect(cursorSchema.safeParse(token).success).toBe(true);
    expect(looksLikeFilesystemPath(token)).toBe(false);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('stays inside the contract’s length bound for the longest legal identifier', () => {
    const longest = `job_${'a'.repeat(40)}`;
    const token = encodeCursor({ createdAt: AT, id: longest });
    expect(cursorSchema.safeParse(token).success).toBe(true);
  });

  it('is opaque: two adjacent positions do not produce visibly adjacent tokens', () => {
    // Not a security property, just the contract's: the client stores it and
    // hands it back, and what it encodes is the store's business to change.
    expect(encodeCursor({ createdAt: AT, id: 'job_aaaaaa1111' })).not.toBe(
      encodeCursor({ createdAt: LATER, id: 'job_aaaaaa1111' }),
    );
  });
});

describe('a token this build did not issue is refused', () => {
  it('refuses one whose alphabet is wrong', () => {
    for (const token of ['has spaces', 'has/slash', 'has=padding', '../escape', '']) {
      const decoded = decodeCursor(token);
      expect(`${token}: ${String(isErr(decoded))}`).toBe(`${token}: true`);
    }
  });

  it('refuses one with the wrong tag, which is how a successor store refuses ours', () => {
    const foreign = Buffer.from(`c9 ${AT} job_aaaaaa1111`, 'utf8').toString('base64url');
    expect(isErr(decodeCursor(foreign))).toBe(true);
  });

  it('refuses one with the wrong number of parts', () => {
    for (const payload of ['c1', `c1 ${AT}`, `c1 ${AT} job_a 1 extra`]) {
      const token = Buffer.from(payload, 'utf8').toString('base64url');
      expect(`${payload}: ${String(isErr(decodeCursor(token)))}`).toBe(`${payload}: true`);
    }
  });

  it('refuses one whose instant is not the sortable UTC form', () => {
    const token = Buffer.from('c1 2026-08-21T09:30:00Z job_aaaaaa1111', 'utf8').toString(
      'base64url',
    );
    expect(isErr(decodeCursor(token))).toBe(true);
  });

  it('refuses one with an empty identifier', () => {
    const token = Buffer.from(`c1 ${AT} `, 'utf8').toString('base64url');
    expect(isErr(decodeCursor(token))).toBe(true);
  });

  it('reports the contract’s own code, and tells the caller what to do', () => {
    const refused = decodeCursor('not a cursor');
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/invalid_cursor');
    expect(isErr(refused) && refused.error[0]?.message).toContain('Start the listing again.');
  });

  it('says the same thing however it failed, so nothing is learned from the wording', () => {
    const messages = ['not a cursor', Buffer.from('c9 a b').toString('base64url')].map((token) => {
      const refused = decodeCursor(token);
      return isErr(refused) ? refused.error[0]?.message : null;
    });
    expect(new Set(messages).size).toBe(1);
  });
});

describe('the ordering the cursor is a position in', () => {
  it('orders by instant first, then by identifier', () => {
    expect(
      comparePositions({ createdAt: AT, id: 'job_b' }, { createdAt: LATER, id: 'job_a' }),
    ).toBeLessThan(0);
    expect(
      comparePositions({ createdAt: AT, id: 'job_b' }, { createdAt: AT, id: 'job_a' }),
    ).toBeGreaterThan(0);
    expect(comparePositions({ createdAt: AT, id: 'job_a' }, { createdAt: AT, id: 'job_a' })).toBe(
      0,
    );
  });

  it('sorts chronologically because the timestamp sorts lexicographically', () => {
    // The reason `timestampSchema` fixes the offset to `Z` and the precision to
    // milliseconds: it is what lets a position be a value rather than a count.
    const instants = [
      '2026-08-21T09:30:00.000Z',
      '2026-08-21T09:30:00.001Z',
      '2026-08-21T10:00:00.000Z',
      '2026-12-31T23:59:59.999Z',
    ];
    for (const instant of instants) expect(timestampSchema.safeParse(instant).success).toBe(true);
    expect([...instants].sort()).toEqual(instants);
    expect(instants.map((value) => Date.parse(value)).sort((a, b) => a - b)).toEqual(
      instants.map((value) => Date.parse(value)),
    );
  });

  it('is strictly after, so the row the cursor names is never shown twice', () => {
    const position = { createdAt: AT, id: 'job_aaaaaa1111' };
    expect(isAfter(position, position)).toBe(false);
    expect(isAfter({ createdAt: AT, id: 'job_aaaaaa1112' }, position)).toBe(true);
    expect(isAfter({ createdAt: LATER, id: 'job_aaaaaa1110' }, position)).toBe(true);
    expect(isAfter({ createdAt: '2026-08-21T09:29:59.999Z', id: 'job_z' }, position)).toBe(false);
  });
});
