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
  /**
   * Every attacker this card is currently assigned to block. "Units blocked by
   * **this Unit** …" (M02.4).
   *
   * Its own target kind rather than a `CardFilter` predicate, and the reason is
   * structural: `matchesCardFilter` is handed a definition and an instance and
   * nothing else, so a predicate meaning "…relative to the card asking" has
   * nowhere to read the asker from — and the same filter shape is reused by
   * continuous scopes and trigger scopes, where "the source" is a different
   * card again.
   *
   * Read from the public block assignments at the moment the instruction
   * resolves, so it names whatever the source is actually blocking rather than
   * whatever it was blocking when the ability was queued. Empty — and the
   * instruction fizzles — outside a combat where the source blocked.
   */
  z.strictObject({ kind: z.literal('blocked_by_source') }),
  /**
   * Whatever the instruction immediately before this one resolved with. The
   * "**It**" of "Exhaust a Unit. **It** does not Ready…" (M02.4).
   *
   * The instruction-level twin of `delayedSubject: "previous_target"`, and it
   * reads the same record: the entity targets each step resolves with are filed
   * on the resolution item under a `<index>:targets` key, so this survives a
   * pause and a JSON round trip. Without it a two-sentence card would have to
   * repeat the selector and ask its controller twice — and they could answer
   * with two different units, which is a card nobody printed.
   *
   * Names nothing, and the instruction fizzles, when the step before it had no
   * entity targets or when everything it named has left the battlefield.
   */
  z.strictObject({ kind: z.literal('previous_target') }),
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
const gate = {
  condition: conditionSchema.optional(),
  /**
   * "**You may** …" — a yes/no the instruction's controller answers when it
   * resolves (ruleset update §15).
   *
   * A property of the instruction rather than a wrapper effect, for the same
   * reason `condition` is: an optional step is still one flat instruction with a
   * `type`, and every reader of an effect list would otherwise have to learn to
   * walk into a `maybe` node.
   *
   * Distinct from a target selector's `optional`, which is "you may pick
   * nothing" and is the better encoding whenever the decision *is* the target —
   * declining by choosing no unit is one interaction where a confirm plus a
   * target choice is two. `optional` here is for the instructions that have no
   * target to decline: "you may Ready that Guardian" points at the unit the
   * trigger was about, and the only decision left is whether to do it at all.
   *
   * Declining is not a failure. The rest of the card still resolves, which is
   * what lets "you may sacrifice … **if you do**, …" work: see the
   * `previous_step` condition.
   *
   * `.optional()` rather than `.default(false)`, matching `condition` beside it
   * and `groupByTokenDefinition` on the selector: a rare opt-in on a shape that
   * fixtures and tests write by hand, where a default would make "absent" a type
   * error in every one of them. Absent means off.
   */
  optional: z.boolean().optional(),
} as const;

const abilityIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Ability IDs must be lowercase_snake_case.');

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
    /**
     * "The damage **may be divided among targets**" (M02.5).
     *
     * Flips what `amount` means. Without it the amount is dealt to every
     * recipient — three units take three lots of two. With it the amount is a
     * **total**, and the chooser splits it: each point is allocated to one
     * legal target, and every target that ends up with at least one point takes
     * exactly what it was given.
     *
     * A property of the instruction rather than of the selector, because the
     * division decides *both* how much each target takes and which targets are
     * hit at all. That is why the selector underneath it must be an
     * unrestricted `count: "all"` pool the chooser picks from — a `count: 2`
     * would describe a pre-selection the allocation never makes — and why the
     * card schema rejects any other shape rather than quietly ignoring it.
     *
     * `.optional()` rather than `.default(false)`, matching `entersExhausted`
     * and `onlySource`: a rare opt-in on a shape fixtures and tests write by
     * hand, where a default would make "absent" a type error in every one of
     * them. Absent means each recipient takes the full amount.
     */
    divided: z.boolean().optional(),
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
  /**
   * "It does not Ready during its controller's **next** Ready Step" (M02.4).
   *
   * The stored half of the readiness replacement layer. An instruction rather
   * than a static ability because the prevention is fixed onto one permanent at
   * one moment and then outlives whatever applied it: `stasis_seal` is a Spell
   * that has gone to a discard pile long before the Ready Step it is talking
   * about, and `stasis_keeper` is routinely defeated in the very combat that
   * applies it. A continuous effect would evaporate with its source and leave
   * both cards doing nothing.
   *
   * Deliberately not a `Duration`-carrying modifier either. Every duration in
   * this engine expires at a boundary, and `until_your_next_turn` expires
   * *immediately before* the Ready Step that this has to survive into — so a
   * modifier would be gone at exactly the moment it is meant to act.
   *
   * Scoped to the Ready Step and nothing else, because that is what the cards
   * print: a unit under this may still be readied by an effect that says
   * "Ready target Unit". The prevention is consumed by its controller's next
   * Ready Step whether or not the unit was Exhausted when it arrived.
   */
  z.strictObject({
    type: z.literal('skip_next_ready'),
    ...gate,
    target: entityTargetSchema,
  }),
  /**
   * Moves a card from wherever it is into a named zone.
   *
   * The one instruction that covers every zone transition a card can print,
   * including the two M02.2 needs: `removed`, which is terminal and untargetable
   * (CLAUDE.md §12), and `battlefield`, which is a revival — the card arrives as
   * a fresh permanent, Newly Deployed, and reports `entersBattlefield` rather
   * than `deployed` because nobody paid its deployment cost (rule adjustment
   * §7).
   */
  z.strictObject({
    type: z.literal('move_card'),
    ...gate,
    target: entityTargetSchema,
    toZone: zoneIdSchema,
    /**
     * "… to the battlefield **Exhausted**" (M02.2).
     *
     * A property of the arrival rather than a second `exhaust` instruction, and
     * the distinction is not cosmetic: a follow-up instruction would need a way
     * to name the cards that had just arrived, would be skippable on its own,
     * and would let anything that reads the board between the two steps see a
     * Ready unit that the card says was never Ready. Here the card arrives in
     * the state it is printed in, in one atomic step.
     *
     * Only meaningful when `toZone` is `battlefield`; setting it anywhere else
     * is a schema error rather than a silently ignored field, because a card
     * whose data claims something the engine drops is exactly the "silently
     * approximate a card" failure ruleset update §1 forbids.
     *
     * `.optional()` rather than `.default(false)`, matching `optional` and
     * `groupByTokenDefinition`: this is a rare opt-in on a shape that fixtures
     * and tests write by hand, and a default would make "absent" a type error in
     * every one of them for a flag almost nothing sets. Absent means Ready.
     */
    entersExhausted: z.boolean().optional(),
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
  /**
   * "… **at the end of the turn**", "when it is defeated **this turn**, …"
   * (M02.1).
   *
   * Sets up one of the card's own `delayedAbilities` as a live, serialized
   * delayed effect. It names the entry by ID rather than carrying the delayed
   * instructions inline, and that is the whole reason the instruction union
   * stays flat: an inline body would make `EffectDefinition` recursive, and
   * every reader of an effect list — the engine, the help layer, the pilots, the
   * display-text linter — would have to learn to walk into it. A named reference
   * is one more lookup for the readers that want the detail and invisible to the
   * ones that do not.
   *
   * The delayed effect is bound when this instruction resolves — source,
   * controller, subject and provenance are all fixed then — and never re-chosen
   * afterwards.
   */
  z.strictObject({
    type: z.literal('schedule_delayed'),
    ...gate,
    /** An entry in this same card's `delayedAbilities`. */
    delayedAbilityId: abilityIdSchema,
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

/**
 * The turn boundary a delayed effect is tied to (M02.1).
 *
 * Deliberately its own one-value enum rather than a reuse of `Duration`. A
 * duration says how long a modifier *lasts*; this says when a scheduled
 * instruction *happens*, and half of `Duration` — `permanent`,
 * `while_source_present` — has no meaning at all as a moment. A single member
 * is the honest inventory: `end_of_turn` is the only boundary the authored
 * catalog names, and adding a second is a schema change with its own tests
 * rather than an untested rule shipped in advance.
 */
export const DELAYED_BOUNDARIES = ['end_of_turn'] as const;
export const delayedBoundarySchema = z.enum(DELAYED_BOUNDARIES);
export type DelayedBoundary = z.infer<typeof delayedBoundarySchema>;

/**
 * What the "it" in a delayed clause points at.
 *
 * Resolved **once**, when the scheduling instruction resolves, and stored as a
 * concrete instance on the delayed effect. Nothing is re-chosen later: "When it
 * is defeated this turn" is about the unit that was named at the time, not about
 * whatever is standing there when the turn ends.
 *
 * - `source` — the card the delayed text is printed on. "Return **it** to your
 *   hand" on the unit that was just sacrificed.
 * - `previous_target` — whatever the instruction immediately before the
 *   `schedule_delayed` acted on. This is "Target friendly Unit gains +3 ATK.
 *   When **it** is defeated …", where the delayed clause and the buff must name
 *   the same unit and the player is asked exactly once.
 *
 * Absent means the delayed instructions name nothing — "at the end of the turn,
 * draw a card".
 */
export const DELAYED_SUBJECTS = ['source', 'previous_target'] as const;
export const delayedSubjectSchema = z.enum(DELAYED_SUBJECTS);
export type DelayedSubject = z.infer<typeof delayedSubjectSchema>;

/**
 * A delayed effect, as authored.
 *
 * Kept in its own list on the card rather than inline in `schedule_delayed` so
 * the instruction union stays flat and non-recursive — see that variant. A
 * delayed ability's own `effects` may not schedule another delayed ability,
 * which is what bounds the whole feature: scheduling is one level deep, always,
 * so there is no chain to unwind and no loop to guard against.
 *
 * Two shapes, distinguished only by `trigger`:
 *
 *  - **without** a trigger the instructions run *at* the boundary;
 *  - **with** one they run when that event happens to the bound subject before
 *    the boundary, once, and are discarded unfired at the boundary if it never
 *    does.
 *
 * Both are tied to the same explicit boundary, which is what keeps a delayed
 * effect from outliving the turn that created it in a game where the next turn
 * belongs to somebody else.
 */
export const delayedAbilityDefinitionSchema = z.strictObject({
  id: abilityIdSchema,
  boundary: delayedBoundarySchema,
  /**
   * The event to wait for. Absent means "fire at the boundary itself".
   *
   * Restricted to the triggers that are *about a card*, because a delayed watch
   * is always bound to one subject instance; a turn-phase trigger is about a
   * phase and has nothing for the binding to hold on to.
   */
  trigger: z.enum(CARD_SCOPED_TRIGGERS).optional(),
  subject: delayedSubjectSchema.optional(),
  /** Re-checked when the delayed effect fires, exactly like an ability's gate. */
  condition: conditionSchema.optional(),
  effects: z.array(effectDefinitionSchema).min(1),
});
export type DelayedAbilityDefinition = z.infer<typeof delayedAbilityDefinitionSchema>;

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
const discardCostSchema = z.strictObject({
  type: z.literal('discard'),
  amount: z.number().int().min(1).max(10),
  selection: selectionModeSchema.default('player_choice'),
});

const sacrificeCostSchema = z.strictObject({
  type: z.literal('sacrifice'),
  amount: z.number().int().min(1).max(10),
  /** Restricts which friendly permanents may pay. Defaults to any unit. */
  filter: cardFilterSchema.optional(),
  /**
   * Excludes the card the cost is being paid for. This is the whole of
   * "sacrifice **another** Unit" on a card that is itself a Unit.
   *
   * Never meaningful on a Spell's additional cost — the Spell is in hand, not
   * on the battlefield, so it was never in the candidate set to begin with.
   */
  excludeSource: z.boolean().default(false),
  /**
   * Who picks the victim.
   *
   * `player_choice` is the default because on the cards that print this, the
   * whole decision *is* which unit you feed it — an engine that picked for the
   * player would be choosing the card's most important line. The engine pauses
   * for a selection before anything is spent (see the `cost_selection`
   * continuation). `automatic` keeps the older deterministic pick for a cost
   * where the victim genuinely does not matter, and nothing is ever asked when
   * there is only one legal answer.
   */
  selection: selectionModeSchema.default('player_choice'),
});

export const abilityCostSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('energy'), amount: z.number().int().min(0).max(20) }),
  z.strictObject({ type: z.literal('exhaust_source') }),
  discardCostSchema,
  sacrificeCostSchema,
]);
export type AbilityCost = z.infer<typeof abilityCostSchema>;
export type AbilityCostType = AbilityCost['type'];

/**
 * The cost vocabulary, as a list. Covers `additionalCosts` too: that schema is a
 * strict subset of this union, so a cost type classified here is classified for
 * both (M05.1).
 */
export const ABILITY_COST_TYPES = abilityCostSchema.options.map(
  (option) => option.shape.type.value,
) as readonly AbilityCostType[];

/**
 * "**As an additional cost**, sacrifice a Unit."
 *
 * Paid when the card is played, before it is queued, and **not refunded if the
 * card is later countered** (CLAUDE.md §4). That timing is the whole reason it
 * is a cost rather than a first instruction: a first instruction resolves after
 * the Reaction window has already closed over the card, so a countered spell
 * would cost its controller nothing.
 *
 * A narrower union than `AbilityCost` on purpose. `energy` is excluded because
 * a card's energy cost is its printed `cost` and a second, invisible one would
 * make `energyCostOf` a lie; `exhaust_source` is excluded because a card being
 * played out of hand has nothing to exhaust.
 */
export const additionalCostSchema = z.discriminatedUnion('type', [
  discardCostSchema,
  sacrificeCostSchema,
]);
export type AdditionalCost = z.infer<typeof additionalCostSchema>;

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
  /**
   * Narrows the set to the card the ability is printed on and nothing else.
   * "**This card** costs 1 less for each …" (M02.3).
   *
   * The exact complement of `excludeSource`, and setting both is a schema error
   * rather than an empty set that silently does nothing. Without it the only way
   * to say "this card" would be a `cardIds` filter naming the card itself, which
   * would also catch every other copy of it — a different, stronger card in any
   * format that is not singleton.
   *
   * `.optional()` rather than `.default(false)` like its neighbour, matching
   * `groupByTokenDefinition` and `entersExhausted`: a rare opt-in on a shape
   * that fixtures and tests write by hand, where a default would make "absent" a
   * type error in every one of them. Absent means off.
   */
  onlySource: z.boolean().optional(),
});
export type ContinuousScope = z.infer<typeof continuousScopeSchema>;

/**
 * Which arrivals on a battlefield a replacement rewrites (M02.4).
 *
 * The two members mirror the `on_deployed` / `on_entered_battlefield` triggers
 * exactly, rather than inventing a second, subtly different vocabulary for the
 * same distinction — CLAUDE.md requires the two readings to stay separate and to
 * be reviewed card by card, and a replacement layer that blurred them would be
 * the bulk conversion the update forbids.
 *
 * - `deployed` — a card that was *played* by paying its deployment cost, plus a
 *   Token being created. That second half is not an extension: the engine
 *   already reports a Token's arrival as an `on_deployed` occurrence, because a
 *   Token arriving *is* a deployment, and "the first enemy Unit deployed each
 *   turn" has always covered Tokens without saying so.
 * - `entered_battlefield` — every arrival by any route, revivals included.
 */
export const ARRIVAL_EVENTS = ['deployed', 'entered_battlefield'] as const;
export const arrivalEventSchema = z.enum(ARRIVAL_EVENTS);
export type ArrivalEvent = z.infer<typeof arrivalEventSchema>;

/**
 * How often a replacement effect may rewrite an event.
 *
 * `first_each_turn` is "**the first** … each turn". Tracked per source copy on
 * the instance, exactly like a triggered ability's `each_turn` limit, so two
 * copies of the same Relic each get their own.
 */
export const REPLACEMENT_LIMITS = ['first_each_turn', 'unlimited'] as const;
export const replacementLimitSchema = z.enum(REPLACEMENT_LIMITS);
export type ReplacementLimit = z.infer<typeof replacementLimitSchema>;

/**
 * A continuous effect.
 *
 * Static abilities are *derived*, never applied: nothing is stamped onto the
 * recipients, and the whole layer is recomputed after any relevant state change.
 * That is what makes "your units get +1/+0" cover units that arrive later, and
 * makes the bonus vanish the instant the source leaves play (CLAUDE.md §17 Q2).
 */
const staticAbilityEffectSchema = z.discriminatedUnion('type', [
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
  /**
   * "This card costs 1 less **for each friendly Unit defeated this turn**,
   * to a minimum cost of 3" (M02.3).
   *
   * A static ability rather than a `modify_cost` instruction, and the
   * difference is the whole mechanic: `modify_cost` stamps a fixed delta
   * onto its controller for a duration, which would freeze the discount at
   * whatever the board looked like when it was applied. This is derived —
   * recomputed every time a cost is asked for — so a Unit defeated after the
   * card was drawn makes it cheaper, and a card that stops qualifying goes
   * back to full price with nothing to clean up.
   *
   * Like `reaction_discount` beside it, it contributes nothing to the
   * continuous layer: a cost is a fact about a card its controller might
   * play, not a modifier stamped on anything. The cost path reads it
   * directly at the moment a cost is computed.
   */
  /**
   * "The first enemy Unit deployed each turn **enters Exhausted**";
   * "Goblin Tokens you create during your turn **have Rush** until the end
   * of that turn" (M02.4).
   *
   * A replacement, not a trigger: it rewrites an arrival as it happens, so
   * nothing — not a state-based check, not another trigger discovered from
   * the same event — ever observes the unit in the state it would have
   * arrived in. A triggered "when a Unit is deployed, exhaust it" would be a
   * visibly different card, and one an opponent could respond to in between.
   *
   * `affects` says whose arrivals and which cards; `on` says which arrivals.
   * The rewrite itself is the last three fields, and at least one of them
   * must be set — a replacement that changes nothing is an authoring
   * mistake, not a no-op the loader should accept.
   */
  z.strictObject({
    type: z.literal('replace_arrival'),
    on: arrivalEventSchema.default('entered_battlefield'),
    /**
     * "…**during your turn**". Absent means every turn.
     *
     * Its own narrow flag rather than a `ConditionDefinition`, matching
     * `sourceState` beside it: a replacement is read at the moment an event
     * happens, and "whose turn is it" is a single field read that cannot
     * turn a card's arrival into a scan of the board.
     */
    onlyOnControllerTurn: z.boolean().optional(),
    limit: replacementLimitSchema.default('unlimited'),
    /** "…enters Exhausted." */
    entersExhausted: z.boolean().optional(),
    /** "…have Rush", granted as part of the arrival. */
    grantKeyword: keywordIdSchema.optional(),
    /**
     * How long a granted keyword lasts. `end_of_turn` is what every card
     * that grants one on arrival prints ("until the end of that turn").
     */
    grantDuration: durationSchema.default('end_of_turn'),
  }),
  /**
   * "Once each turn, when an enemy Unit would become Ready, you may pay 1
   * Energy. If you do, it remains Exhausted" (M02.4).
   *
   * The derived half of the readiness replacement layer, and the mirror of
   * `skip_next_ready`: this one is a standing property of a card in play and
   * applies to whatever is on the board when the Ready Step arrives, where
   * the instruction is fixed onto one permanent in advance.
   *
   * Only the Ready Step is replaced. That is not a narrowing of the printed
   * text — the Ready Step is the only thing in this ruleset that readies a
   * card its controller does not own the effect of, and every `ready`
   * instruction in the catalog aims at its own controller's units.
   *
   * With an `energyCost` above zero the replacement is *offered* to its
   * controller when the Ready Step arrives and is skipped entirely when they
   * cannot pay; at zero it simply applies.
   */
  z.strictObject({
    type: z.literal('replace_ready'),
    /** "…you may pay N Energy." Zero makes the replacement mandatory. */
    energyCost: z.number().int().min(0).max(20).default(0),
    limit: replacementLimitSchema.default('unlimited'),
  }),
  z.strictObject({
    type: z.literal('cost_reduction'),
    /**
     * How much cheaper. A `ValueExpression`, so the board can decide — which
     * is the point — but a printed number is still a printed number.
     */
    amount: valueExpressionSchema,
    /**
     * The printed "to a minimum cost of N" floor.
     *
     * Clamped against the printed cost when it is applied, so it can never
     * *raise* a cost that was already below it.
     */
    minimum: z.number().int().min(0).max(20).default(0),
  }),
]);

export type StaticAbilityEffect = z.infer<typeof staticAbilityEffectSchema>;
export type StaticAbilityEffectType = StaticAbilityEffect['type'];

/**
 * The continuous-effect vocabulary, as a list.
 *
 * Read off the union rather than restated, for the same reason `EFFECT_TYPES`
 * is: a new continuous effect cannot be added to the schema without appearing
 * here, and therefore without appearing in the support registry keyed by this
 * list (M05.1).
 */
export const STATIC_ABILITY_EFFECT_TYPES = staticAbilityEffectSchema.options.map(
  (option) => option.shape.type.value,
) as readonly StaticAbilityEffectType[];

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
    effect: staticAbilityEffectSchema,
  })
  .superRefine((ability, ctx) => {
    if (ability.affects.onlySource && ability.affects.excludeSource) {
      ctx.addIssue({
        code: 'custom',
        path: ['affects', 'onlySource'],
        message:
          '`onlySource` and `excludeSource` are opposites; an ability that is both applies to nothing.',
      });
    }

    if (ability.effect.type === 'reaction_discount' && ability.affects.controller !== 'self') {
      ctx.addIssue({
        code: 'custom',
        path: ['affects', 'controller'],
        message: 'A Reaction discount applies to its own controller; set `controller` to "self".',
      });
    }

    // Both replacements rewrite something that happens *on a battlefield* — an
    // arrival there, or a Ready Step that only permanents in play take part in.
    // A replacement scoped to a hand or a discard pile is a printed clause the
    // layer would never read, which is the "silently approximate a card" failure
    // ruleset update §1 forbids.
    if (ability.effect.type === 'replace_arrival' || ability.effect.type === 'replace_ready') {
      if (ability.affects.zone !== 'battlefield') {
        ctx.addIssue({
          code: 'custom',
          path: ['affects', 'zone'],
          message: 'A replacement effect applies on the battlefield; set `zone` to "battlefield".',
        });
      }
    }

    if (ability.effect.type === 'replace_arrival') {
      if (ability.effect.entersExhausted !== true && ability.effect.grantKeyword === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['effect'],
          message:
            'A `replace_arrival` must change the arrival: set `entersExhausted`, `grantKeyword`, or both.',
        });
      }
      // `onlySource` would mean "rewrite my own arrival", which is a moment that
      // has already passed by the time the ability is active — the card has to
      // be on the battlefield for its static abilities to switch on at all.
      if (ability.affects.onlySource) {
        ctx.addIssue({
          code: 'custom',
          path: ['affects', 'onlySource'],
          message:
            'A replacement cannot rewrite its own arrival: its static abilities only switch on once it is already in play.',
        });
      }
    }

    if (ability.effect.type !== 'cost_reduction') return;
    // A play cost is only ever computed for a card its controller holds. A
    // reduction scoped to somebody else's cards, or to a zone nothing is played
    // from, is a printed clause the cost path would never read — the "silently
    // approximate a card" failure ruleset update §1 forbids. Making an opponent's
    // cards *more* expensive is a different mechanism and not this one.
    if (ability.affects.controller !== 'self') {
      ctx.addIssue({
        code: 'custom',
        path: ['affects', 'controller'],
        message: 'A cost reduction applies to its own controller; set `controller` to "self".',
      });
    }
    if (ability.affects.zone !== 'hand') {
      ctx.addIssue({
        code: 'custom',
        path: ['affects', 'zone'],
        message: 'A cost reduction applies to cards in hand; set `zone` to "hand".',
      });
    }
  });
export type StaticAbilityDefinition = z.infer<typeof staticAbilityDefinitionSchema>;
