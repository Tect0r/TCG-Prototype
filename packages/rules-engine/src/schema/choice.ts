import { z } from 'zod';
import { choiceIntentSchema, EFFECT_TYPES, zoneIdSchema } from '@tcg/card-data';
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
   * A `replace_ready` offer being answered part-way through a Ready Step
   * (M02.4).
   *
   * The Ready Step is not a resolution item — it is turn-start bookkeeping that
   * runs before anything is queued — so an offer inside it cannot be a
   * `resolution` continuation. It is instead a paused *step*, and everything
   * needed to carry on is named here rather than snapshotted: the offer list
   * itself is recomputed from the board when the step resumes, so it can never
   * disagree with the state after a serialisation round trip.
   *
   * Progress is tracked by *which sources have been asked*, not by an index into
   * that list. An index would silently point at a different offer once a taken
   * replacement dropped out of the recomputed list; a set of instance IDs stays
   * correct however the list moves.
   */
  z.strictObject({
    kind: z.literal('ready_step_replacement'),
    /** Whose Ready Step this is. */
    playerId: playerIdSchema,
    /** The replacement source whose offer this choice is answering. */
    sourceInstanceId: instanceIdSchema,
    /** Every source already offered this Ready Step, including that one. */
    askedSourceIds: z.array(instanceIdSchema),
    /** Permanents already kept Exhausted earlier in this same Ready Step. */
    keptExhaustedIds: z.array(instanceIdSchema),
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
  /**
   * An allocation of a fixed total across legal targets (M02.5).
   *
   * The answer is a **multiset**: one entry per point, so three damage split two
   * and one is `[a, a, b]`. It is the one choice type where a repeated option is
   * the answer rather than a mistake, and the shape is what makes the validation
   * the tranche calls for fall out of the existing checks — every entry is a
   * legal target, the length is the required total, and a non-negative integer
   * per target is the only thing a multiset can express.
   *
   * Deliberately not a map from target to number. `submit_choice` carries a list
   * of IDs across the protocol, the pilots and the replay log, and a second
   * payload shape for one choice type would have to be validated, redacted and
   * serialised everywhere the first one already is.
   */
  'divide_damage',
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
  /**
   * "…you may pay N Energy. If you do, it remains Exhausted" — offered at
   * somebody else's Ready Step to the controller of a `replace_ready`
   * replacement (M02.4).
   *
   * A `select_units` rather than a `confirm`, because the answer names *which*
   * permanent stays Exhausted as well as whether to pay at all. Declining is
   * selecting nothing, which is why the minimum is zero.
   */
  'keep_exhausted',
  /**
   * "**Each player** chooses and sacrifices one Unit they control" — one seat's
   * share of a selection every seat is making (M02.5).
   *
   * Its own reason rather than `effect_target`, because what a player needs to
   * know is different: nothing has happened yet, the other seats are answering
   * the same question, and none of the answers takes effect until all of them
   * are in. A prompt that read like an ordinary targeting choice would invite
   * the player to look at a board that is about to change.
   */
  'each_player_choice',
  /**
   * "The damage **may be divided among targets**" — splitting a fixed total
   * across the legal targets (M02.5).
   */
  'divide_damage',
] as const;
export const choiceReasonSchema = z.enum(CHOICE_REASONS);
export type ChoiceReason = z.infer<typeof choiceReasonSchema>;

/**
 * Where the question came from, at the coarsest useful grain.
 *
 * Not the same axis as `ChoiceReason`, and both are needed. A reason says what
 * the player is being asked ("discard for the hand size limit"); an origin says
 * which part of the engine is asking, which is what decides whether the rest of
 * the provenance can be filled in at all — only an `instruction` has a
 * resolution item and an effect index.
 */
export const CHOICE_ORIGINS = [
  /** A resolving instruction on a card asked. */
  'instruction',
  /** An interactive cost, chosen before the action it pays for commits (M02.4). */
  'cost',
  /** A `replace_ready` offer inside a Ready Step (M02.4). */
  'replacement',
  /** Turn structure itself asked: the hand-size discard at end of turn. */
  'turn_structure',
] as const;
export const choiceOriginSchema = z.enum(CHOICE_ORIGINS);
export type ChoiceOrigin = z.infer<typeof choiceOriginSchema>;

/**
 * How the seat being asked stands to the seat whose card asked.
 *
 * `none` is not "unknown": it means no card asked at all, which is true of the
 * hand-size discard and of nothing else.
 */
export const CHOICE_CHOOSER_RELATIONS = ['source_controller', 'opponent', 'none'] as const;
export const choiceChooserRelationSchema = z.enum(CHOICE_CHOOSER_RELATIONS);
export type ChoiceChooserRelation = z.infer<typeof choiceChooserRelationSchema>;

/**
 * Whose entities the options may include, **read from the seat being asked**.
 *
 * Relative to the chooser rather than to the ability's controller, because the
 * chooser is the one who has to decide, and "a Unit you control" means a
 * different set of cards depending on who was handed the question — which is
 * exactly what an `each_player_choice` does (M02.5).
 *
 * `any` covers both the selector that genuinely says "any Unit" and the case a
 * seat cannot pin down from where it sits: an ability whose controller pointed
 * at "an opponent's Unit" and then handed the choice to one of those opponents
 * is naming a set that mixes that seat's own cards with a third seat's.
 * `none` is for a question with no entity behind it at all — a `confirm`.
 */
export const CHOICE_TARGET_RELATIONS = ['self', 'opponent', 'any', 'none'] as const;
export const choiceTargetRelationSchema = z.enum(CHOICE_TARGET_RELATIONS);
export type ChoiceTargetRelation = z.infer<typeof choiceTargetRelationSchema>;

/**
 * Why this choice exists, in structured form (M05.3).
 *
 * The thing this replaces is a pilot reading the *whole source card* and
 * deciding it was "hostile" if anything on it was: a card that removed one unit
 * and buffed another was hostile for both of its questions, so the pilot picked
 * its worst unit to buff. The valence of a choice belongs to the instruction
 * that asked, and this is that instruction, named.
 *
 * Deliberately carries **no card identity**. `sourceInstanceId` beside it
 * already attributes the question, and adding the source's `definitionId` would
 * hand the seat being asked the printed identity of a card it may never have
 * been shown — a question you are asked is not a card you have seen
 * (CLAUDE.md §11).
 */
export const choiceProvenanceSchema = z.strictObject({
  origin: choiceOriginSchema,
  /** Resolution item that asked. Null for every non-`instruction` origin. */
  itemId: z.string().min(1).nullable(),
  /** Index of the asking instruction in the list it was printed in. */
  effectIndex: z.number().int().min(0).nullable(),
  /** The instruction that asked. Null when no instruction did. */
  effectType: z.enum(EFFECT_TYPES).nullable(),
  /** Who controls the asking source. Null when nothing on the board asked. */
  sourceControllerId: playerIdSchema.nullable(),
  chooser: choiceChooserRelationSchema,
  targetRelation: choiceTargetRelationSchema,
  /** What being selected does to the selected entity. */
  intent: choiceIntentSchema,
});
export type ChoiceProvenance = z.infer<typeof choiceProvenanceSchema>;

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
  /** Structured account of what asked and what an answer does (M05.3). */
  provenance: choiceProvenanceSchema,
  continuation: continuationSchema,
});
export type PendingChoice = z.infer<typeof pendingChoiceSchema>;
