import { describe, expect, it } from 'vitest';
import { z, ZodError } from 'zod';
import {
  ADAPTIVE_VERSION_FIELDS,
  assertCompatibleAdaptiveVersion,
  CURRENT_ADAPTIVE_VERSIONS,
  describeAdaptiveVersionProblem,
  isFutureAdaptiveVersion,
  parseAdaptiveDocument,
} from './version.js';

/**
 * M08.16A: readable current/future-version refusal, proved for all four
 * adaptive version domains without touching a real document.
 */

describe('describeAdaptiveVersionProblem', () => {
  it('is null for every field at its own current version', () => {
    for (const field of ADAPTIVE_VERSION_FIELDS) {
      expect(describeAdaptiveVersionProblem(field, CURRENT_ADAPTIVE_VERSIONS[field])).toBeNull();
    }
  });

  it('names a missing version as unreadable, not a future one', () => {
    for (const field of ADAPTIVE_VERSION_FIELDS) {
      expect(describeAdaptiveVersionProblem(field, undefined)).toMatch(/does not declare/);
      expect(describeAdaptiveVersionProblem(field, 'v1')).toMatch(/does not declare/);
      expect(describeAdaptiveVersionProblem(field, 0)).toMatch(/does not declare/);
      expect(describeAdaptiveVersionProblem(field, -1)).toMatch(/does not declare/);
    }
  });

  it('names a future version as written by a newer build', () => {
    for (const field of ADAPTIVE_VERSION_FIELDS) {
      const message = describeAdaptiveVersionProblem(field, CURRENT_ADAPTIVE_VERSIONS[field] + 1);
      expect(message).toMatch(/newer build/);
      expect(message).toMatch(/Update the application/);
    }
  });
});

describe('isFutureAdaptiveVersion', () => {
  it('is true only for a readable version number greater than current', () => {
    expect(isFutureAdaptiveVersion('config', CURRENT_ADAPTIVE_VERSIONS.config + 1)).toBe(true);
    expect(isFutureAdaptiveVersion('config', CURRENT_ADAPTIVE_VERSIONS.config)).toBe(false);
    expect(isFutureAdaptiveVersion('config', 'not-a-number')).toBe(false);
    expect(isFutureAdaptiveVersion('config', 0)).toBe(false);
  });
});

describe('assertCompatibleAdaptiveVersion', () => {
  it('throws the readable message for an incompatible version', () => {
    expect(() =>
      assertCompatibleAdaptiveVersion('raw', CURRENT_ADAPTIVE_VERSIONS.raw + 1),
    ).toThrow(/newer build/);
  });

  it('does not throw for the current version', () => {
    expect(() =>
      assertCompatibleAdaptiveVersion('raw', CURRENT_ADAPTIVE_VERSIONS.raw),
    ).not.toThrow();
  });
});

describe('parseAdaptiveDocument', () => {
  const schema = z.strictObject({ schemaVersion: z.literal(1), value: z.string() });

  it('refuses a future schemaVersion before the strict shape is even checked', () => {
    // `value` is also missing here — if the version check ran second, this
    // would fail with a shape error instead of the readable version message.
    expect(() => parseAdaptiveDocument('config', schema, { schemaVersion: 2 })).toThrow(
      /newer build/,
    );
  });

  it('refuses a missing schemaVersion with the readable message', () => {
    expect(() => parseAdaptiveDocument('config', schema, { value: 'x' })).toThrow(
      /does not declare/,
    );
  });

  it('falls through to the ordinary strict-schema error once the version is readable', () => {
    expect(() => parseAdaptiveDocument('config', schema, { schemaVersion: 1 })).toThrow(ZodError);
  });

  it('parses a compatible, well-shaped document', () => {
    expect(parseAdaptiveDocument('config', schema, { schemaVersion: 1, value: 'x' })).toEqual({
      schemaVersion: 1,
      value: 'x',
    });
  });

  it('lets a non-object input reach the schema unchanged', () => {
    expect(() => parseAdaptiveDocument('config', schema, null)).toThrow(ZodError);
  });
});
