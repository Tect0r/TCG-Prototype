import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { adaptiveRawRecordSchema, adaptiveResultSchema, parseAdaptiveRawRecord, parseAdaptiveResult } from './envelopes.js';

/**
 * M08.16A: the envelopes' shared identity fields and version refusal.
 * `result` is still empty at schemaVersion 1. `raw` moved to schemaVersion 2
 * in M08.16C when it grew a `generations` field, and `checkpoint` moved to
 * schemaVersion 2 in M08.18A when it grew real resumable state
 * (`./checkpoint.ts`), so both are checked on their own below and in
 * `./checkpoint.test.ts` respectively, rather than through a shared
 * `describe.each` with the still-empty `result`.
 */

function identity() {
  return { experimentId: 'my-adaptive-run', configHash: 'a-config-hash' };
}

describe('result envelope', () => {
  it('accepts its identity fields at schemaVersion 1', () => {
    expect(() => parseAdaptiveResult({ schemaVersion: 1, ...identity() })).not.toThrow();
  });

  it('refuses an unrecognized field', () => {
    expect(() =>
      adaptiveResultSchema.parse({ schemaVersion: 1, ...identity(), stray: true }),
    ).toThrow(ZodError);
  });

  it('refuses a missing experimentId or configHash', () => {
    expect(() => adaptiveResultSchema.parse({ schemaVersion: 1, configHash: 'x' })).toThrow(
      ZodError,
    );
    expect(() => adaptiveResultSchema.parse({ schemaVersion: 1, experimentId: 'x' })).toThrow(
      ZodError,
    );
  });

  it('refuses an experimentId outside the lowercase slug alphabet', () => {
    expect(() =>
      adaptiveResultSchema.parse({ schemaVersion: 1, experimentId: 'Not Valid', configHash: 'x' }),
    ).toThrow(ZodError);
  });

  it('refuses a future schemaVersion with the readable message, not a shape error', () => {
    expect(() => parseAdaptiveResult({ schemaVersion: 2, ...identity() })).toThrow(/newer build/);
  });

  it('refuses a missing schemaVersion with the readable message', () => {
    expect(() => parseAdaptiveResult(identity())).toThrow(/does not declare/);
  });
});

describe('raw envelope', () => {
  it('accepts its identity fields at schemaVersion 2 and defaults generations to empty', () => {
    const parsed = parseAdaptiveRawRecord({ schemaVersion: 2, ...identity() });
    expect(parsed.generations).toEqual([]);
  });

  it('refuses an unrecognized field', () => {
    expect(() =>
      adaptiveRawRecordSchema.parse({ schemaVersion: 2, ...identity(), stray: true }),
    ).toThrow(ZodError);
  });

  it('refuses a missing experimentId or configHash', () => {
    expect(() => adaptiveRawRecordSchema.parse({ schemaVersion: 2, configHash: 'x' })).toThrow(
      ZodError,
    );
    expect(() => adaptiveRawRecordSchema.parse({ schemaVersion: 2, experimentId: 'x' })).toThrow(
      ZodError,
    );
  });

  it('refuses an experimentId outside the lowercase slug alphabet', () => {
    expect(() =>
      adaptiveRawRecordSchema.parse({
        schemaVersion: 2,
        experimentId: 'Not Valid',
        configHash: 'x',
      }),
    ).toThrow(ZodError);
  });

  it('refuses a future schemaVersion with the readable message, not a shape error', () => {
    expect(() => parseAdaptiveRawRecord({ schemaVersion: 3, ...identity() })).toThrow(
      /newer build/,
    );
  });

  it('refuses a schemaVersion 1 record as an older build predating candidate generation', () => {
    expect(() => parseAdaptiveRawRecord({ schemaVersion: 1, ...identity() })).toThrow(
      /older build/,
    );
  });

  it('refuses a missing schemaVersion with the readable message', () => {
    expect(() => parseAdaptiveRawRecord(identity())).toThrow(/does not declare/);
  });
});
