import { z } from 'zod';
import { cardIdSchema, keywordIdSchema, zoneIdSchema } from './primitives.js';
import {
  cardFilterSchema,
  controllerSchema,
  durationSchema,
  playerSelectorSchema,
  selectionModeSchema,
  targetDefinitionSchema,
  targetSelectorSchema,
} from './target.js';
import {
  conditionSchema,
  signedValueExpressionSchema,
  sourceStateSchema,
  valueExpressionSchema,
} from './condition.js';

/**
 * Structured effects. Card behaviour is data, never parsed prose (CLAUDE.md §8).
 *
 * A discriminated union keeps each effect's required fields its own business.
 */

/**
 * How much of something an effect does.
 *
 * A `ValueExpression` rather than a plain number, so "deal damage equal to the
 * number of Goblins you control" is authorable without a second effect type. A
 * printed number is still just a number: widening the field left every existing
 * card valid and unchanged (ruleset update §15).
 */
const amount = valueExpressionSchema;

/**
 * Effects that can only ever apply to a card or unit. Restricting the union at
 * the schema boundary means "destroy target opponent" is rejected when the data
 * loads rather than fizzling silently at resolution time.
 */
const entityTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('entity'), selector: targetSelectorSchema }),
  z.strictObject({ kind: z.literal('source') }),
  z.strictObject({ kind: z.literal('trigger_subject') }),
]);
export type EntityTarget = z.infer<typeof entityTargetSchema>;

/**
 * A gate every instruction may carry.
 *
 * Spread into each variant rather than wrapped around the union, so an effect
 * stays one flat object with a `type` discriminant — a nested `conditional`
 * wrapper would make the union recursive, and every reader of an effect list
 * (the engine, the help layer, the pilots, the display-text linter) would have
 * to learn to walk into it.
 *
 * The condition is checked when the instruction resolves, not when its card was
 * played. An instruction whose condition is false is skipped and the rest of the
 * card still resolves, which is exactly what "Draw a card. If …, draw another"
 * means.
 */
const gate = { condition: conditionSchema.optional() } as const;

export const effectDefinitionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('draw'),
    ...gate,
    player: playerSelectorSchema.default('self'),
    amount,
  }),
  z.strictObject({
    type: z.literal('discard'),
    ...gate,
    player: playerSelectorSchema.default('self'),
    amount,
    selection: selectionModeSchema.default('player_choice'),
  }),
  z.strictObject({
    type: z.literal('deal_damage'),
    ...gate,
    /** Units, the source itself, or a player (CLAUDE.md §12). */
    target: targetDefinitionSchema,
    amount,
  }),
  z.strictObject({
    type: z.literal('heal'),
    ...gate,
    target: targetDefinitionSchema,
    amount,
  }),
  z.strictObject({
    type: z.literal('modify_stats'),
    ...gate,
    target: entityTargetSchema,
    attack: signedValueExpressionSchema.default(0),
    health: signedValueExpressionSchema.default(0),
    duration: durationSchema.default('permanent'),
  }),
  z.strictObject({
    type: z.literal('grant_keyword'),
    ...gate,
    target: entityTargetSchema,
    keyword: keywordIdSchema,
    duration: durationSchema.default('permanent'),
  }),
  z.strictObject({
    type: z.literal('remove_keyword'),
    ...gate,
    target: entityTargetSchema,
    keyword: keywordIdSchema,
    duration: durationSchema.default('permanent'),
  }),
  z.strictObject({
    type: z.literal('create_token'),
    ...gate,
    tokenCardId: cardIdSchema,
    amount: valueExpressionSchema,
    controller: playerSelectorSchema.default('self'),
  }),
  z.strictObject({
    type: z.literal('destroy'),
    ...gate,
    target: entityTargetSchema,
  }),
  z.strictObject({
    type: z.literal('sacrifice'),
    ...gate,
    target: entityTargetSchema,
  }),
  z.strictObject({
    type: z.literal('return_to_hand'),
    ...gate,
    target: entityTargetSchema,
  }),
  z.strictObject({
    type: z.literal('search_zone'),
    ...gate,
    player: playerSelectorSchema.default('self'),
    zone: zoneIdSchema,
    filter: cardFilterSchema.optional(),
    amount: z.number().int().min(1).max(10).default(1),
    destination: zoneIdSchema.default('hand'),
    reveal: z.boolean().default(false),
    /**
     * Searching a *public* zone is mandatory when a legal result exists unless
     * the effect opts out here; a hidden zone may always legally find nothing
     * (CLAUDE.md §17 Q25).
     */
    upTo: z.boolean().default(false),
    /**
     * "Look at the top N cards" rather than searching the whole zone
     * (ruleset update §16).
     *
     * An extension of the search rather than a second effect type, because the
     * decision a player makes is identical — pick from a set of cards you have
     * been shown — and only the size of that set differs. Absent means the whole
     * zone, which is what every existing card assumes.
     */
    fromTop: z.number().int().min(1).max(10).optional(),
    /**
     * Where the cards that were looked at but not taken end up.
     *
     * `unchanged` leaves the zone alone, which is what a full-zone search does
     * before it shuffles. `bottom` is the "put the others on the bottom" clause
     * that almost every look-at-the-top card prints, and it suppresses the
     * post-search shuffle: the player has been told the new order deliberately,
     * and shuffling it away would make the card say something it does not do.
     */
    remainder: z.enum(['unchanged', 'bottom']).default('unchanged'),
  }),
  z.strictObject({
    type: z.literal('reorder_zone'),
    ...gate,
    player: playerSelectorSchema.default('self'),
    zone: zoneIdSchema,
    amount: z.number().int().min(1).max(10),
  }),
  z.strictObject({
    type: z.literal('modify_cost'),
    ...gate,
    player: playerSelectorSchema.default('self'),
    filter: cardFilterSchema.optional(),
    delta: z.number().int().min(-10).max(10),
    duration: durationSchema.default('end_of_turn'),
  }),
  z.strictObject({
    type: z.literal('prevent_damage'),
    ...gate,
    target: targetDefinitionSchema,
    amount,
    duration: durationSchema.default('end_of_turn'),
  }),
  z.strictObject({
    type: z.literal('exhaust'),
    ...gate,
    target: entityTargetSchema,
  }),
  z.strictObject({
    type: z.literal('ready'),
    ...gate,
    target: entityTargetSchema,
  }),
  z.strictObject({
    type: z.literal('move_card'),
    ...gate,
    target: entityTargetSchema,
    toZone: zoneIdSchema,
  }),
  /**
   * Counters the card this Reaction is responding to.
   *
   * It takes no target: the only thing a Reaction may counter is the Spell that
   * opened the window it was played in (rule adjustment §5.5), and that card is
   * already named by the window. Giving it a selector would imply a second,
   * unreachable answer and let a card claim to counter something the timing
   * rules never put in front of it.
   *
   * `unlessPays` is the "unless its controller pays N additional Energy" clause.
   * The additional cost is offered to that controller as an explicit choice; a
   * controller who cannot afford it is never asked. Additional costs already
   * paid to play the countered card are **not** refunded (ruleset update §5).
   */
  z.strictObject({
    type: z.literal('counter'),
    ...gate,
    unlessPays: z.number().int().min(0).max(20).default(0),
  }),
]);

export type EffectDefinition = z.infer<typeof effectDefinitionSchema>;
export type EffectType = EffectDefinition['type'];

export const EFFECT_TYPES = effectDefinitionSchema.options.map(
  (option) => option.shape.type.value,
) as readonly EffectType[];

/**
 * Triggers that a card ability may listen to (CLAUDE.md §8, ruleset update §15).
 *
 * Every trigger here names an *event*, not a card. Which occurrences an ability
 * listens to is a separate question, answered by its `scope` — that separation
 * is what lets one `on_defeated` mean "when this dies", "when another friendly
 * Unit dies" and "when any Unit dies" without three trigger IDs.
 */
export const TRIGGER_IDS = [
  'on_attack',
  'on_block',
  'on_survive_combat',
  /**
   * Survived combat *while blocking*, specifically. A separate trigger rather
   * than a scope filter because "as a blocker" is a fact about the combat, not
   * about the card: the same unit surviving an attack it declared must not fire
   * it (ruleset update §15).
   */
  'on_survive_combat_as_blocker',
  'on_defeated',
  'on_sacrifice',
  /** A unit arrived on a battlefield — played, created, or returned there. */
  'on_deployed',
  /**
   * A card arrived on a battlefield by **any** route — deployment, revival, or
   * an effect that simply put it there (rule adjustment §7).
   *
   * Kept strictly distinct from `on_deployed`, which fires only when the card
   * was *played* by paying its deployment cost. A normal deployment fires both,
   * deployment first; a revival fires only this one. The update forbids
   * converting existing `on_deployed` cards to this trigger wholesale — each has
   * to be reviewed on its own, and `npm run report:triggers` lists them.
   */
  'on_entered_battlefield',
  /**
   * One or more tokens were created by a single instruction.
   *
   * Batched on purpose: "whenever you create one or more Goblin Tokens" fires
   * once for a five-token instruction, not five times (ruleset update §13).
   */
  'on_tokens_created',
  'on_turn_start',
  'on_turn_end',
  /** The start/end of a turn belonging to somebody other than the controller. */
  'on_opponent_turn_start',
  'on_opponent_turn_end',
] as const;
export const triggerIdSchema = z.enum(TRIGGER_IDS);
export type TriggerId = z.infer<typeof triggerIdSchema>;

/**
 * Triggers whose event is about a card, and which therefore accept a `scope`.
 *
 * The turn triggers are about a *phase*, so scoping them by card filter would
 * be meaningless — "at the start of your turn, if a Goblin…" is a `condition`,
 * not a scope.
 */
export const CARD_SCOPED_TRIGGERS = [
  'on_attack',
  'on_block',
  'on_survive_combat',
  'on_survive_combat_as_blocker',
  'on_defeated',
  'on_sacrifice',
  'on_deployed',
  'on_entered_battlefield',
  'on_tokens_created',
] as const satisfies readonly TriggerId[];

/**
 * Which occurrences of a trigger an ability listens to.
 *
 * Absent means the classic self-scoped reading — only when the event is about
 * this very card — which is what every card authored before this existed
 * assumes, and what most cards still want.
 */
export const triggerScopeSchema = z.strictObject({
  /** Whose card the event has to be about, relative to the ability's controller. */
  controller: controllerSchema.default('any'),
  filter: cardFilterSchema.optional(),
  /**
   * Excludes the card the ability is printed on. This is the whole of
   * "**another** friendly Unit is defeated".
   */
  excludeSource: z.boolean().default(false),
  /**
   * Ignores events this same ability caused.
   *
   * "This does not trigger from Tokens created by this effect" — and, more
   * importantly, the general safety property behind it: a token multiplier that
   * fed itself would recur until the resolution-step safeguard killed the match.
   * Structural rather than per-card prose, so any future ability that produces
   * the event it listens for can opt out the same way.
   */
  excludeSelfCaused: z.boolean().default(false),
});
export type TriggerScope = z.infer<typeof triggerScopeSchema>;

/**
 * How often a triggered ability may fire.
 *
 * `each_turn` is "the first time … each turn". There is deliberately no
 * `each_round`: a round is a full cycle of the seat order, the engine has no
 * bookkeeping for one, and the only card that wants it is blocked on Reactions
 * anyway. Inventing round tracking that nothing can exercise would be adding an
 * untested rule (ruleset update §18).
 */
export const TRIGGER_LIMITS = ['each_turn'] as const;
export const triggerLimitSchema = z.enum(TRIGGER_LIMITS);
export type TriggerLimit = z.infer<typeof triggerLimitSchema>;

const abilityIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Ability IDs must be lowercase_snake_case.');

/**
 * A triggered ability.
 *
 * `on_deploy` is deliberately *not* in the trigger vocabulary: deploy behaviour
 * has exactly one authoring form, a card's top-level `effects` (CLAUDE.md §17
 * Q1). The v1 → v2 migration folds old `on_deploy` abilities into `effects`.
 */
export const abilityDefinitionSchema = z.strictObject({
  id: abilityIdSchema,
  trigger: triggerIdSchema,
  /**
   * The zone the source must be in for the ability to listen at all.
   *
   * Explicit rather than inferred from the word "passive" or from rules text
   * (rule adjustment §3): "While this Commander is in the Command Zone …" and
   * "While this Commander is on the battlefield …" are different cards, and the
   * engine may not tell them apart by reading prose. `battlefield` is the
   * default, which is what every non-Commander card means and what the update
   * says a Commander means when its text does not say otherwise.
   *
   * One deliberate exception survives this gate: a card's **own** `on_defeated`
   * fires after it has left the battlefield. That is not a zone question — the
   * card is reacting to its own removal — and it is handled where triggers are
   * discovered rather than by pretending the discard pile is an active zone.
   */
  activeZone: zoneIdSchema.default('battlefield'),
  /** Which occurrences to listen to. Absent means "only about this card". */
  scope: triggerScopeSchema.optional(),
  /**
   * A gate re-checked when the trigger fires. "At the end of your turn, **if a
   * friendly Unit was defeated that turn**, …".
   */
  condition: conditionSchema.optional(),
  /** "The first time … each turn". Absent means every time. */
  limit: triggerLimitSchema.optional(),
  effects: z.array(effectDefinitionSchema).min(1),
});
export type AbilityDefinition = z.infer<typeof abilityDefinitionSchema>;

/**
 * How often an activated ability may be used. CLAUDE.md §4 requires either
 * `once_per_match` or a documented reusable restriction, so the restriction is
 * an explicit enum rather than an open-ended field.
 */
export const ABILITY_USAGE_LIMITS = ['once_per_match', 'once_per_turn', 'unlimited'] as const;
export const abilityUsageLimitSchema = z.enum(ABILITY_USAGE_LIMITS);
export type AbilityUsageLimit = z.infer<typeof abilityUsageLimitSchema>;

/**
 * What activating an ability costs.
 *
 * A structured, extensible array rather than a lone `energyCost` field: costs
 * are validated and paid atomically before the ability is queued, and sacrifice
 * is legal as a cost as well as an effect (CLAUDE.md §17 Q3/Q27).
 */
export const abilityCostSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('energy'), amount: z.number().int().min(0).max(20) }),
  z.strictObject({ type: z.literal('exhaust_source') }),
  z.strictObject({
    type: z.literal('discard'),
    amount: z.number().int().min(1).max(10),
    selection: selectionModeSchema.default('player_choice'),
  }),
  z.strictObject({
    type: z.literal('sacrifice'),
    amount: z.number().int().min(1).max(10),
    /** Restricts which friendly permanents may pay. Defaults to any unit. */
    filter: cardFilterSchema.optional(),
  }),
]);
export type AbilityCost = z.infer<typeof abilityCostSchema>;

/**
 * An ability the controller chooses to use. The only legal timing is the
 * controller's own Main Phase with an empty effect queue and no pending choice
 * (CLAUDE.md §4).
 */
export const activatedAbilityDefinitionSchema = z.strictObject({
  id: abilityIdSchema,
  name: z.string().min(1).max(80),
  /**
   * Where the ability can be activated from.
   *
   * "An activated ability on a Commander is battlefield-only unless its text
   * explicitly says it can be activated from the Command Zone" (rule adjustment
   * §3) — so the default is `battlefield` and a Command-Zone ability has to say
   * so in its data. The engine checks this field and never the card's prose.
   */
  activeZone: zoneIdSchema.default('battlefield'),
  costs: z.array(abilityCostSchema).default([]),
  usageLimit: abilityUsageLimitSchema,
  timing: z.literal('main_phase').default('main_phase'),
  effects: z.array(effectDefinitionSchema).min(1),
});
export type ActivatedAbilityDefinition = z.infer<typeof activatedAbilityDefinitionSchema>;

/**
 * The set a continuous effect applies to. Deliberately not a `TargetSelector`:
 * a static ability has no count, no chooser and no moment of selection — it
 * describes a set that is recomputed whenever the board changes.
 */
export const continuousScopeSchema = z.strictObject({
  zone: zoneIdSchema.default('battlefield'),
  controller: controllerSchema.default('self'),
  filter: cardFilterSchema.optional(),
  /** Excludes the card the ability is printed on (a lord that does not buff itself). */
  excludeSource: z.boolean().default(false),
});
export type ContinuousScope = z.infer<typeof continuousScopeSchema>;

/**
 * A continuous effect.
 *
 * Static abilities are *derived*, never applied: nothing is stamped onto the
 * recipients, and the whole layer is recomputed after any relevant state change.
 * That is what makes "your units get +1/+0" cover units that arrive later, and
 * makes the bonus vanish the instant the source leaves play (CLAUDE.md §17 Q2).
 */
export const staticAbilityDefinitionSchema = z
  .strictObject({
    id: abilityIdSchema,
    /** Zone the source must be in for the ability to be active. */
    activeZone: zoneIdSchema.default('battlefield'),
    /**
     * An extra state the source must be in — "**while this Unit is Ready**, …".
     *
     * Deliberately narrower than the full `ConditionDefinition` an ability or an
     * instruction may carry. A continuous effect is recomputed constantly, and a
     * gate that could count the board would turn every recalculation into a scan
     * of every card; a fact about the source itself is a single field read.
     */
    sourceState: sourceStateSchema.optional(),
    affects: continuousScopeSchema,
    effect: z.discriminatedUnion('type', [
      z.strictObject({
        type: z.literal('modify_stats'),
        attack: z.number().int().min(-99).max(99).default(0),
        health: z.number().int().min(-99).max(99).default(0),
      }),
      z.strictObject({ type: z.literal('grant_keyword'), keyword: keywordIdSchema }),
      /**
       * "The first Reaction Spell you play after the beginning of each of your
       * turns costs 1 less, to a minimum of 1" (rule adjustment §6).
       *
       * A static ability rather than a triggered one because it is a standing
       * property of a card in play — it has to be true at the moment a cost is
       * computed, on a turn that is usually not its controller's, which is a
       * question no trigger is in a position to answer.
       *
       * It is the one static effect that does not contribute to an instance's
       * continuous layer: a cost reduction is a fact about its controller, not a
       * modifier stamped on a card. `affects.controller` must therefore be `self`
       * — "your Reactions" — and `affects.filter`, if present, narrows which of
       * them qualify.
       */
      z.strictObject({
        type: z.literal('reaction_discount'),
        amount: z.number().int().min(1).max(10).default(1),
        /** The printed "to a minimum of N" floor. */
        minimum: z.number().int().min(0).max(10).default(1),
        /**
         * `first_each_turn` resets at the beginning of the controller's own turn
         * and stays available across the opponents' turns until it is used —
         * which is the whole point, since that is when Reactions are played.
         */
        limit: z.enum(['first_each_turn', 'unlimited']).default('first_each_turn'),
      }),
    ]),
  })
  .superRefine((ability, ctx) => {
    if (ability.effect.type !== 'reaction_discount') return;
    if (ability.affects.controller !== 'self') {
      ctx.addIssue({
        code: 'custom',
        path: ['affects', 'controller'],
        message: 'A Reaction discount applies to its own controller; set `controller` to "self".',
      });
    }
  });
export type StaticAbilityDefinition = z.infer<typeof staticAbilityDefinitionSchema>;
