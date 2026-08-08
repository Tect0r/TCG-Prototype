import { z } from 'zod';
import { zoneIdSchema } from '@tcg/card-data';
import { instanceIdSchema, playerIdSchema } from './primitives.js';

/**
 * Where resolution resumes once the choice is answered.
 *
 * Continuations are plain data. The engine never stores a closure in match
 * state, so a paused match survives JSON serialisation, reconnection and
 * replay (CLAUDE.md §9).
 */
export const continuationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('resolution'),
    /** Resolution queue item to resume. */
    itemId: z.string().min(1),
    /** Index of the instruction that asked for the choice. */
    effectIndex: z.number().int().min(0),
    /**
     * Where to file the answer in the item's `selections`. Usually the effect
     * index, but one instruction can need several answers — an `each_opponent`
     * discard asks every opponent in turn — so the key is explicit.
     */
    selectionKey: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('turn_end_discard'),
  }),
]);
export type Continuation = z.infer<typeof continuationSchema>;

export const CHOICE_TYPES = [
  'select_cards',
  'select_units',
  'select_players',
  'order_cards',
] as const;
export const choiceTypeSchema = z.enum(CHOICE_TYPES);
export type ChoiceType = z.infer<typeof choiceTypeSchema>;

/**
 * Why the choice exists. A stable code rather than prose: the UI turns it into
 * a sentence, the engine never stores display text in match state.
 */
export const CHOICE_REASONS = [
  'effect_target',
  'discard_effect',
  'sacrifice_cost',
  'discard_cost',
  'search_zone',
  'reorder_zone',
  'hand_size_discard',
  'unit_slot',
  /** Which living opponent an `opponent` target means (CLAUDE.md §12). */
  'select_opponent',
] as const;
export const choiceReasonSchema = z.enum(CHOICE_REASONS);
export type ChoiceReason = z.infer<typeof choiceReasonSchema>;

/**
 * A mandatory pause. While one is set, the engine accepts only the expected
 * player's matching `submit_choice`, a concession, or a server timeout
 * (CLAUDE.md §9).
 */
export const pendingChoiceSchema = z.strictObject({
  id: z.string().min(1),
  playerId: playerIdSchema,
  type: choiceTypeSchema,
  reason: choiceReasonSchema,
  /** Zone the options live in, when they are cards. */
  zone: zoneIdSchema.nullable(),
  minimum: z.number().int().min(0),
  maximum: z.number().int().min(0),
  /**
   * Engine-generated legal options. The client renders these; it never computes
   * legality itself.
   */
  validEntityIds: z.array(z.string().min(1)),
  /** When true, the submitted selection is an ordering of every option. */
  ordered: z.boolean(),
  /** The instance whose effect asked, for UI attribution. */
  sourceInstanceId: instanceIdSchema.nullable(),
  continuation: continuationSchema,
});
export type PendingChoice = z.infer<typeof pendingChoiceSchema>;
