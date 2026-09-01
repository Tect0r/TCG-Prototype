import { z } from 'zod';
import { adaptiveExperimentIdSchema } from './config.js';
import {
  ADAPTIVE_CHECKPOINT_SCHEMA_VERSION,
  ADAPTIVE_RAW_SCHEMA_VERSION,
  ADAPTIVE_RESULT_SCHEMA_VERSION,
  parseAdaptiveDocument,
} from './version.js';

/**
 * The three documents an Adaptive Counter run writes, and the identity every
 * one of them carries (M08.16A).
 *
 * Deliberately minimal today: `experimentId` and `configHash` are what a
 * reader needs to tell one run's documents from another's and to detect that
 * a checkpoint or result was written against a since-changed config — the
 * same two fields `SearchCheckpoint` (`../deck-search/evolve.ts`) has carried
 * since M03. No wall-clock timestamp, for the same reason nothing else this
 * app content-addresses carries one: a checkpoint has to compare equal across
 * an uninterrupted run and a resumed one, and a timestamp would make two
 * otherwise-identical checkpoints disagree on nothing that matters.
 *
 * Each envelope's payload is empty by design. M08.16B adds the immutable
 * revision lineage each of the three needs to name, and M08.16C adds
 * generated and rejected candidates to the raw stream — every one of those is
 * an additive widening of the schema version it lands on, in the same style
 * `MANIFEST_SCHEMA_VERSION`'s and `SEARCH_CHECKPOINT_VERSION`'s histories
 * already record.
 */

const adaptiveDocumentIdentity = {
  experimentId: adaptiveExperimentIdSchema,
  configHash: z.string().min(1),
};

export const adaptiveRawRecordSchema = z.strictObject({
  schemaVersion: z.literal(ADAPTIVE_RAW_SCHEMA_VERSION),
  ...adaptiveDocumentIdentity,
});
export type AdaptiveRawRecord = z.infer<typeof adaptiveRawRecordSchema>;

export const adaptiveCheckpointSchema = z.strictObject({
  schemaVersion: z.literal(ADAPTIVE_CHECKPOINT_SCHEMA_VERSION),
  ...adaptiveDocumentIdentity,
});
export type AdaptiveCheckpoint = z.infer<typeof adaptiveCheckpointSchema>;

export const adaptiveResultSchema = z.strictObject({
  schemaVersion: z.literal(ADAPTIVE_RESULT_SCHEMA_VERSION),
  ...adaptiveDocumentIdentity,
});
export type AdaptiveResult = z.infer<typeof adaptiveResultSchema>;

/** Parses one raw record, refusing an unreadable schema version first (M08.16A). */
export function parseAdaptiveRawRecord(input: unknown): AdaptiveRawRecord {
  return parseAdaptiveDocument('raw', adaptiveRawRecordSchema, input);
}

/** Parses a checkpoint, refusing an unreadable schema version first (M08.16A). */
export function parseAdaptiveCheckpoint(input: unknown): AdaptiveCheckpoint {
  return parseAdaptiveDocument('checkpoint', adaptiveCheckpointSchema, input);
}

/** Parses a result, refusing an unreadable schema version first (M08.16A). */
export function parseAdaptiveResult(input: unknown): AdaptiveResult {
  return parseAdaptiveDocument('result', adaptiveResultSchema, input);
}
