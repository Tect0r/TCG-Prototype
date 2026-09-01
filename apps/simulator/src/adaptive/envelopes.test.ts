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

/** M08.16A: the three envelopes' identity fields and version refusal. */

function identity() {
  return { experimentId: 'my-adaptive-run', configHash: 'a-config-hash' };
}

describe.each([
  ['raw', adaptiveRawRecordSchema, parseAdaptiveRawRecord] as const,
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
