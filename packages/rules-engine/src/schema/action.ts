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
  /**
   * Deliberately carries no slot. The battlefield is unbounded (ruleset update
   * §7), so a unit has nowhere to be placed *to* — it simply joins the
   * controller's unit list. Sending a slot is a schema error rather than an
   * ignored field, so a stale client is told rather than silently misread.
   */
  z.strictObject({
    type: z.literal('play_card'),
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
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
  /**
   * Each attacker independently names the opponent it attacks, so a
   * free-for-all attack can be split across several players in one combat
   * (CLAUDE.md §12). With two seats there is only one legal defender, and the
   * client fills it in.
   */
  z.strictObject({
    type: z.literal('declare_attackers'),
    playerId: playerIdSchema,
    attacks: z.array(
      z.strictObject({
        attackerInstanceId: instanceIdSchema,
        defenderPlayerId: playerIdSchema,
      }),
    ),
  }),
  /**
   * One defender's answer, covering only the attacks aimed at them. Each
   * attacked player submits independently and the assignments stay hidden until
   * the last of them arrives (CLAUDE.md §12).
   */
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
  /**
   * Plays a Reaction into the open window (rule adjustment §5).
   *
   * A separate action from `play_card` rather than a special case of it: every
   * check differs. `play_card` requires the active player, a Main Phase and an
   * empty queue; this one requires priority in a window, which is normally
   * somebody else's turn and normally has work pending. Folding the two together
   * would mean one handler carrying two disjoint sets of preconditions.
   */
  z.strictObject({
    type: z.literal('play_reaction'),
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
  }),
  /** Declines to act with priority in the open Reaction window. */
  z.strictObject({
    type: z.literal('pass_reaction'),
    playerId: playerIdSchema,
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
