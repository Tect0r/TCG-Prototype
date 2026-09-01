import { z } from 'zod';
import { cardIdSchema } from '@tcg/card-data';
import { deckSourceSchema, retentionSchema } from '../config.js';
import { environmentConfigSchema } from '../environment.js';
import { ADAPTIVE_CONFIG_SCHEMA_VERSION, parseAdaptiveDocument } from './version.js';

/**
 * Adaptive Counter Search configuration (M08.16A).
 *
 * `adaptive_counter` is a reserved preset (`packages/admin-contracts/src/
 * presets.ts`): this build can name an adaptive run and cannot yet schedule
 * one. This is the strict config surface a later tranche's runner will
 * accept — M08.16B adds the immutable revision lineage a run produces,
 * M08.16C the deterministic legal candidate generation, and M08.17 the
 * evaluation loop that actually spends the budget declared below. Nothing
 * here starts a match, generates a candidate or mutates a card definition.
 *
 * Deliberately its own schema rather than a sixth member of
 * `experimentConfigSchema`'s discriminated union in `../config.js`: that
 * union is the simulator's promise about what it can *run*, and wiring
 * `adaptive` into it belongs to the tranche that can actually honour it.
 * Until then, `EXPERIMENT_KINDS` in `@tcg/admin-contracts` stays exactly the
 * five it already lists, matching the preset registry's own empty `kinds: []`
 * for `adaptive_counter`.
 */

export const ADAPTIVE_COMMANDER_POLICIES = ['locked', 'selected', 'open'] as const;
export const adaptiveCommanderPolicySchema = z.enum(ADAPTIVE_COMMANDER_POLICIES);
export type AdaptiveCommanderPolicy = z.infer<typeof adaptiveCommanderPolicySchema>;

/**
 * `public_observation` preserves the normal bot observation boundary a match
 * already enforces; `analysis_full_deck` is analysis-only and must stay
 * unmistakable in provenance (M08.16 scope note). Nothing in this file makes
 * that boundary — `@tcg/bot-interface` and `@tcg/rules-engine` still own what
 * a seat may see — this only records which policy an adaptive run declared,
 * so a later reader can tell a full-deck analysis run from an ordinary one on
 * sight rather than by inspecting how it was configured.
 */
export const ADAPTIVE_INFORMATION_POLICIES = ['public_observation', 'analysis_full_deck'] as const;
export const adaptiveInformationPolicySchema = z.enum(ADAPTIVE_INFORMATION_POLICIES);
export type AdaptiveInformationPolicy = z.infer<typeof adaptiveInformationPolicySchema>;

/** Bounded card-swap size a revision may apply. Default policy: 1–5 cards. */
export const adaptiveSwapBoundSchema = z
  .strictObject({
    minCards: z.number().int().min(1).max(40),
    maxCards: z.number().int().min(1).max(40),
  })
  .refine((bound) => bound.minCards <= bound.maxCards, {
    message: '`minCards` cannot exceed `maxCards`.',
    path: ['minCards'],
  });
export type AdaptiveSwapBound = z.infer<typeof adaptiveSwapBoundSchema>;

export const DEFAULT_ADAPTIVE_SWAP_BOUND: AdaptiveSwapBound = { minCards: 1, maxCards: 5 };

/**
 * The optional deterministic rebuild trigger.
 *
 * A revision is normally the previous one plus a bounded swap
 * (`adaptiveSwapBoundSchema`). This names the condition under which M08.16C's
 * generator instead throws that lineage away and deterministically rebuilds
 * from the starting sources — at least one condition, since a trigger with
 * neither field would never fire and is better refused than kept as dead
 * configuration.
 */
export const adaptiveRebuildTriggerSchema = z
  .strictObject({
    afterConsecutiveLosses: z.number().int().min(1).max(50).optional(),
    everyBlocks: z.number().int().min(1).max(1000).optional(),
  })
  .refine(
    (trigger) => trigger.afterConsecutiveLosses !== undefined || trigger.everyBlocks !== undefined,
    'A rebuild trigger must name at least one condition.',
  );
export type AdaptiveRebuildTrigger = z.infer<typeof adaptiveRebuildTriggerSchema>;

/**
 * The same authored-slug alphabet `experimentConfigSchema.id` and
 * `experimentSlugSchema` use, restated rather than imported for the
 * dependency reason `@tcg/admin-contracts/identity.ts` already gives for
 * `EXPERIMENT_KINDS`: this file is the one both the config and the envelope
 * schemas need it from, so it is a single local constant rather than a second
 * copy per file.
 */
export const adaptiveExperimentIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_-]*$/, 'Adaptive experiment IDs are lowercase and hyphen/underscore safe.');

export const adaptiveConfigSchema = z
  .strictObject({
    schemaVersion: z.literal(ADAPTIVE_CONFIG_SCHEMA_VERSION),
    id: adaptiveExperimentIdSchema,
    /** Optional display label; empty falls back to the experiment ID. */
    label: z.string().max(120).default(''),
    /** Root seed. Everything else is derived from it (CLAUDE.md §13.4). */
    seed: z.string().min(1).max(64),
    /** Output directory, relative to the working directory. */
    output: z.string().min(1).default('results'),
    environment: environmentConfigSchema,
    /** Where the first revision of every lineage starts from. */
    startingDecks: deckSourceSchema,
    commanderPolicy: adaptiveCommanderPolicySchema.default('locked'),
    /**
     * Required and non-empty when `commanderPolicy` is `selected`; empty
     * otherwise. `locked` takes its Commander from `startingDecks` and `open`
     * takes it from the whole legal pool, so neither reads this list.
     */
    selectedCommanderIds: z.array(cardIdSchema).max(64).default([]),
    informationPolicy: adaptiveInformationPolicySchema.default('public_observation'),
    /** Total games this run may spend across every evaluation block. */
    totalLearningBudget: z.number().int().min(1).max(1_000_000),
    /** Games per pairing in one mirrored evaluation block. */
    blockSize: z.number().int().min(1).max(10_000),
    /** Play every pairing in both seat orders within a block (CLAUDE.md §13.7). */
    mirrorSeats: z.boolean().default(true),
    /** Candidate revisions generated per adaptation. */
    candidateCount: z.number().int().min(1).max(64),
    swapBound: adaptiveSwapBoundSchema.default(DEFAULT_ADAPTIVE_SWAP_BOUND),
    rebuildTrigger: adaptiveRebuildTriggerSchema.nullable().default(null),
    /** Share (0–1) of evaluation opponents drawn from the reference field rather than the current opponent. */
    referenceFieldShare: z.number().min(0).max(1).default(0),
    retention: retentionSchema.prefault({}),
    /** Games played per pairing in the frozen fresh-seed final validation stage. */
    finalValidationGames: z.number().int().min(1).max(100_000),
  })
  .refine(
    (config) =>
      config.commanderPolicy === 'selected'
        ? config.selectedCommanderIds.length > 0
        : config.selectedCommanderIds.length === 0,
    {
      message:
        '`selectedCommanderIds` is required when commanderPolicy is `selected` and must be ' +
        'empty otherwise.',
      path: ['selectedCommanderIds'],
    },
  );
export type AdaptiveConfig = z.infer<typeof adaptiveConfigSchema>;
export type AdaptiveConfigInput = z.input<typeof adaptiveConfigSchema>;

/** Parses an Adaptive Counter configuration, refusing an unreadable schema version first. */
export function parseAdaptiveConfig(input: unknown): AdaptiveConfig {
  return parseAdaptiveDocument('config', adaptiveConfigSchema, input);
}
