import { z } from 'zod';
import { instanceIdSchema, playerIdSchema } from './primitives.js';

/**
 * Everything a seat can ask the engine to do.
 *
 * Target selection is deliberately *not* carried on `play_card`. Every choice —
 * spell targets, discards, search results, ordering — arrives through the same
 * `submit_choice` path against an engine-generated legal option set, so the
 * client has exactly one way to make a decision and never computes legality
 * itself (CLAUDE.md §9).
 */
export const actionSchema = z.discriminatedUnion('type', [
  /**
   * Opening-hand redraw. An empty `returnInstanceIds` is a keep, so this single
   * action covers both branches of the mulligan.
   */
  z.strictObject({
    type: z.literal('mulligan'),
    playerId: playerIdSchema,
    returnInstanceIds: z.array(instanceIdSchema),
  }),
  z.strictObject({
    type: z.literal('play_card'),
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    /** Unit slot to deploy into. `null` lets the engine take the lowest free slot. */
    slot: z.number().int().min(0).nullable().default(null),
  }),
  z.strictObject({
    type: z.literal('activate_ability'),
    playerId: playerIdSchema,
    sourceInstanceId: instanceIdSchema,
    abilityId: z.string().min(1).max(64),
  }),
  z.strictObject({
    type: z.literal('pass_phase'),
    playerId: playerIdSchema,
  }),
  z.strictObject({
    type: z.literal('declare_attackers'),
    playerId: playerIdSchema,
    attackerInstanceIds: z.array(instanceIdSchema),
  }),
  z.strictObject({
    type: z.literal('assign_blockers'),
    playerId: playerIdSchema,
    blocks: z.array(
      z.strictObject({
        attackerInstanceId: instanceIdSchema,
        blockerInstanceId: instanceIdSchema,
      }),
    ),
  }),
  z.strictObject({
    type: z.literal('submit_choice'),
    playerId: playerIdSchema,
    choiceId: z.string().min(1),
    /** For an ordered choice this is the full ordering, top of zone first. */
    selectedIds: z.array(z.string().min(1)),
  }),
  z.strictObject({
    type: z.literal('concede'),
    playerId: playerIdSchema,
  }),
  /**
   * Server-originated. The engine never reads a clock; a timeout reaches it as
   * an explicit, validated action like any other (CLAUDE.md §4).
   */
  z.strictObject({
    type: z.literal('server_timeout'),
    playerId: playerIdSchema,
  }),
]);

export type Action = z.infer<typeof actionSchema>;
export type ActionInput = z.input<typeof actionSchema>;
export type ActionType = Action['type'];

/** An accepted action recorded in the match log, with the sequence it produced. */
export const loggedActionSchema = z.strictObject({
  index: z.number().int().min(0),
  action: actionSchema,
  /** Sequence number of the last event this action produced. */
  sequenceAfter: z.number().int().min(0),
});
export type LoggedAction = z.infer<typeof loggedActionSchema>;
