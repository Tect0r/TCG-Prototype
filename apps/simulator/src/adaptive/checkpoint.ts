import { z } from 'zod';
import { simDeckSchema } from '@tcg/deck-generator';
import { adaptiveExperimentIdSchema, type AdaptiveCommanderPolicy } from './config.js';
import { adaptiveGenerationRecordSchema } from './generate.js';
import { adaptiveRevisionSchema, assertAdaptiveLineage } from './revision.js';
import { ADAPTIVE_BLOCK_SIDES } from './block.js';
import { ADAPTIVE_CHECKPOINT_SCHEMA_VERSION, parseAdaptiveDocument } from './version.js';

/**
 * Adaptive Counter checkpoint state (M08.18A).
 *
 * A run is two co-evolving lineages — the same `incumbent`/`opponent` sides
 * `./block.ts`'s `AdaptiveBlockOutcome` already tallies wins for, restated
 * here as two independent, straight-chain revision histories (`./revision.ts`).
 * Either side can be the one that lost its last block and generated the
 * candidates now pending a decision (`./promote.ts`'s "moving opponent" note);
 * this file does not assume it is always the same side.
 *
 * This is deliberately state, not evidence. A block's actual games are a pure
 * function of configuration (`../schedule.ts`'s own doc comment: "That is what
 * lets an interrupted run resume by regenerating the schedule and skipping the
 * match IDs it already has"), so resuming does not need this checkpoint to
 * carry a single `ScheduledMatch` or screening result — a resumed run
 * regenerates its schedule and reconciles it against whatever the match store
 * already recorded, the same way `runBatch` resume already works. What a
 * checkpoint alone has to supply is everything that is *not* re-derivable that
 * way: which two revisions are active, their full lineage, how much of the
 * declared budget is already spent, the reference field a resumed run must
 * screen against unchanged, and the currently generated (but not yet decided)
 * candidates for the block in progress — so a run can be interrupted midway
 * through a block and still resume without regenerating a different set of
 * candidates or spending a seed path twice. Actually reading this checkpoint
 * back into a running loop is M08.18B's job; this file only defines what one
 * legally contains.
 */

export const adaptiveCheckpointLineageSchema = z
  .strictObject({
    activeRevisionId: z.string().min(1),
    /** Every revision produced for this side so far, root first, in generation order. */
    revisions: z.array(adaptiveRevisionSchema).min(1),
  })
  .refine((side) => side.revisions[0]?.parentRevisionId === null, {
    message: 'A checkpointed lineage must start with its root revision (parentRevisionId null).',
    path: ['revisions'],
  })
  .refine(
    (side) => side.revisions.some((revision) => revision.revisionId === side.activeRevisionId),
    {
      message: "`activeRevisionId` must name one of this side's own checkpointed revisions.",
      path: ['activeRevisionId'],
    },
  );
export type AdaptiveCheckpointLineage = z.infer<typeof adaptiveCheckpointLineageSchema>;

export const adaptiveCheckpointSchema = z
  .strictObject({
    schemaVersion: z.literal(ADAPTIVE_CHECKPOINT_SCHEMA_VERSION),
    experimentId: adaptiveExperimentIdSchema,
    configHash: z.string().min(1),
    /** This run's two co-evolving lineages, keyed the same way `./block.ts` names a block's two sides. */
    lineages: z.strictObject({
      incumbent: adaptiveCheckpointLineageSchema,
      opponent: adaptiveCheckpointLineageSchema,
    }),
    /** Games already spent out of `totalLearningBudget`. */
    gamesSpent: z.number().int().min(0),
    /**
     * The reference field's decks exactly as the caller supplied them
     * (`./evaluate.ts`'s `AdaptiveCandidateScreeningInput.referenceField`),
     * persisted verbatim so a resumed run screens against the identical field
     * rather than one a caller might reconstruct differently.
     */
    referenceField: z.array(simDeckSchema).default([]),
    /**
     * The current block's candidates, generated but not yet promoted or
     * rolled back. `null` at a clean block boundary — the previous block's
     * decision, if any, is already folded into `lineages`. Non-`null` is
     * exactly a valid partial-block checkpoint: the run stopped after
     * generating candidates but before (or partway through) screening them.
     */
    pendingGeneration: adaptiveGenerationRecordSchema.nullable(),
    /**
     * The generation `pendingGeneration` belongs to, or that the next call to
     * `generateAdaptiveCandidates` should produce when `pendingGeneration` is
     * `null`. Always at least 1: both lineages already hold their generation-0
     * root by the time a checkpoint exists.
     */
    nextGeneration: z.number().int().min(1),
    /** The block `pendingGeneration` belongs to, or that should be scheduled next. */
    nextBlock: z.number().int().min(0),
    /**
     * `./revision.ts`'s `adaptiveRevisionSeedPath` for `nextGeneration`/
     * `nextBlock`, persisted so a resumed run never re-derives — and never
     * risks re-deriving differently from a stale generation/block pair —
     * the seed path a still-pending block will spend.
     */
    nextSeedPath: z.string().min(1),
  })
  .refine(
    (checkpoint) =>
      checkpoint.pendingGeneration === null ||
      (checkpoint.pendingGeneration.generation === checkpoint.nextGeneration &&
        checkpoint.pendingGeneration.block === checkpoint.nextBlock),
    {
      message:
        '`pendingGeneration`, when present, must belong to this checkpoint\'s own ' +
        '`nextGeneration`/`nextBlock`.',
      path: ['pendingGeneration'],
    },
  )
  .refine(
    (checkpoint) => {
      if (checkpoint.pendingGeneration === null) return true;
      const active = new Set(
        ADAPTIVE_BLOCK_SIDES.map((side) => checkpoint.lineages[side].activeRevisionId),
      );
      return (
        active.has(checkpoint.pendingGeneration.incumbentRevisionId) &&
        active.has(checkpoint.pendingGeneration.opponentRevisionId)
      );
    },
    {
      message:
        '`pendingGeneration` must be generated between this checkpoint\'s two currently active ' +
        'revisions.',
      path: ['pendingGeneration'],
    },
  );
export type AdaptiveCheckpoint = z.infer<typeof adaptiveCheckpointSchema>;

/** Parses a checkpoint, refusing an unreadable schema version first (M08.16A). */
export function parseAdaptiveCheckpoint(input: unknown): AdaptiveCheckpoint {
  return parseAdaptiveDocument('checkpoint', adaptiveCheckpointSchema, input);
}

/**
 * Validates both of a checkpoint's lineages against a Commander policy,
 * reusing `./revision.ts`'s own straight-chain and Commander-lock rules
 * (`assertAdaptiveLineage`) rather than restating them. `commanderPolicy` is
 * not itself part of the checkpoint — it lives in the run's config, which a
 * checkpoint only names by `configHash` — so this takes it as an explicit
 * argument instead of trusting a copy that could drift from the config it was
 * checkpointed against.
 */
export function assertValidAdaptiveCheckpoint(
  commanderPolicy: AdaptiveCommanderPolicy,
  checkpoint: AdaptiveCheckpoint,
): void {
  for (const side of ADAPTIVE_BLOCK_SIDES) {
    assertAdaptiveLineage(commanderPolicy, checkpoint.lineages[side].revisions);
  }
}
