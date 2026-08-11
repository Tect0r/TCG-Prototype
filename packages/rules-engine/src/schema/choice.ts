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
  /**
   * A cost being chosen **before** the thing it pays for commits.
   *
   * The resolution queue is the only thing that can pause for a choice, and a
   * cost is paid before anything is queued — so an interactive cost cannot be a
   * `resolution` continuation. It is instead a paused *action*: nothing has been
   * spent, no card has moved, and answering re-runs the original action with the
   * selection supplied. Re-running rather than resuming halfway is what keeps
   * the atomicity guarantee (CLAUDE.md §10): every check happens again against
   * current state, so an answer that has stopped being legal fails as an
   * ordinary rejected action instead of half-paying.
   */
  z.strictObject({
    kind: z.literal('cost_selection'),
    intent: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('play_card'), instanceId: instanceIdSchema }),
      z.strictObject({
        kind: z.literal('activate_ability'),
        instanceId: instanceIdSchema,
        abilityId: z.string().min(1),
      }),
    ]),
    /**
     * Answers already given, keyed by the index of the cost entry they pay.
     *
     * A cost list can hold more than one interactive entry, and each is asked
     * separately; carrying the earlier answers here is what lets the re-run skip
     * the questions that have already been settled.
     */
    paid: z.record(z.string(), z.array(instanceIdSchema)),
    /** The cost entry this particular question is about. */
    costIndex: z.number().int().min(0),
  }),
]);
export type Continuation = z.infer<typeof continuationSchema>;

export const CHOICE_TYPES = [
  'select_cards',
  'select_units',
  'select_players',
  'order_cards',
  /**
   * A yes/no answer. `validEntityIds` is exactly `['yes', 'no']` and the
   * selection is one of them.
   *
   * The option IDs are literals rather than instance IDs because the answer is
   * not about an entity — "will you pay 2 more Energy?" points at nothing on the
   * board. Modelling it as a one-of-two card selection is what would have forced
   * a fake entity into the option set.
   */
  'confirm',
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
  // No `unit_slot`: with an unbounded battlefield there is no position to
  // choose, so the choice cannot arise (ruleset update §7).
  /** Which living opponent an `opponent` target means (CLAUDE.md §12). */
  'select_opponent',
  /**
   * "…unless its controller pays N additional Energy" — offered to the
   * controller of a card a Reaction is countering (rule adjustment §5).
   */
  'pay_additional_cost',
  /**
   * "**You may** …" — the yes/no on an optional instruction (ruleset update
   * §15).
   *
   * Distinct from `pay_additional_cost`, which is also a `confirm`: that one
   * asks whether to spend Energy to save a card somebody is countering, this
   * one asks whether to carry out a step of your own card. A UI that showed
   * them with the same wording would be describing a different game.
   */
  'optional_effect',
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
