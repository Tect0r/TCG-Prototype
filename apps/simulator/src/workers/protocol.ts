import { z } from 'zod';
import { pilotSpecSchema } from '@tcg/bot-interface';
import { environmentConfigSchema } from '../environment.js';
import { matchLimitsSchema, retentionSchema } from '../config.js';
import { simDeckSchema } from '../deck-search/deck.js';
import { seedBundleSchema } from '../seed.js';
import { matchRecordSchema } from '../telemetry/schema.js';

/**
 * What crosses the worker boundary.
 *
 * Plain, schema-validated data only: no closures, no shared mutable state, no
 * `CardDatabase` instances. A worker rebuilds everything it needs from the
 * configuration it is given, which is the same configuration the main thread
 * used, so a worker cannot drift from the main thread's environment
 * (CLAUDE.md §13.7).
 */

export const workerSetupSchema = z.strictObject({
  experimentId: z.string(),
  experimentKind: matchRecordSchema.shape.experimentKind,
  configHash: z.string(),
  arm: z.string().nullable(),
  environment: environmentConfigSchema,
  decks: z.array(simDeckSchema),
  pilots: z.array(pilotSpecSchema),
  limits: matchLimitsSchema,
  retention: retentionSchema,
  softwareCommit: z.string().nullable(),
});
export type WorkerSetup = z.infer<typeof workerSetupSchema>;

export const workerJobSchema = z.strictObject({
  matchId: z.string(),
  orderKey: z.string(),
  deckPairId: z.string(),
  variantKey: z.string(),
  gameIndex: z.number().int().min(0),
  orientation: z.number().int().min(0),
  seats: z.array(
    z.strictObject({
      playerId: z.string(),
      deckIndex: z.number().int().min(0),
      pilotIndex: z.number().int().min(0),
    }),
  ),
  seeds: seedBundleSchema,
  /** Keep a replay bundle for this specific match. Decided by the scheduler. */
  keepReplay: z.boolean(),
});
export type WorkerJob = z.infer<typeof workerJobSchema>;

export const workerResultSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('done'),
    matchId: z.string(),
    record: matchRecordSchema,
    replay: z.unknown().nullable(),
  }),
  z.strictObject({
    type: z.literal('failed'),
    matchId: z.string(),
    message: z.string(),
  }),
]);
export type WorkerResult = z.infer<typeof workerResultSchema>;
