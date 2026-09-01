import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  adaptiveCheckpointSchema,
  adaptiveRawRecordSchema,
  adaptiveResultSchema,
  parseAdaptiveCheckpoint,
  parseAdaptiveRawRecord,
  parseAdaptiveResult,
} from './envelopes.js';

/**
 * M08.16A: the three envelopes' identity fields and version refusal.
 * `checkpoint` and `result` are still empty at schemaVersion 1; `raw` moved to
 * schemaVersion 2 in M08.16C when it grew a `generations` field, so it is
 * checked on its own below rather than through the shared `describe.each`.
 */

function identity() {
  return { experimentId: 'my-adaptive-run', configHash: 'a-config-hash' };
}

describe.each([
  ['checkpoint', adaptiveCheckpointSchema, parseAdaptiveCheckpoint] as const,
  ['result', adaptiveResultSchema, parseAdaptiveResult] as const,
])('%s envelope', (_name, schema, parse) => {
  it('accepts its identity fields at schemaVersion 1', () => {
    expect(() => parse({ schemaVersion: 1, ...identity() })).not.toThrow();
  });

  it('refuses an unrecognized field', () => {
    expect(() => schema.parse({ schemaVersion: 1, ...identity(), stray: true })).toThrow(
      ZodError,
    );
  });

  it('refuses a missing experimentId or configHash', () => {
    expect(() => schema.parse({ schemaVersion: 1, configHash: 'x' })).toThrow(ZodError);
    expect(() => schema.parse({ schemaVersion: 1, experimentId: 'x' })).toThrow(ZodError);
  });

  it('refuses an experimentId outside the lowercase slug alphabet', () => {
    expect(() =>
      schema.parse({ schemaVersion: 1, experimentId: 'Not Valid', configHash: 'x' }),
    ).toThrow(ZodError);
  });

  it('refuses a future schemaVersion with the readable message, not a shape error', () => {
    expect(() => parse({ schemaVersion: 2, ...identity() })).toThrow(/newer build/);
  });

  it('refuses a missing schemaVersion with the readable message', () => {
    expect(() => parse(identity())).toThrow(/does not declare/);
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
      adaptiveRawRecordSchema.parse({ schemaVersion: 2, experimentId: 'Not Valid', configHash: 'x' }),
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
