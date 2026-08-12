import { z } from 'zod';
import {
  cardIdSchema,
  cardTypeSchema,
  colorIdSchema,
  keywordIdSchema,
  tagSchema,
  zoneIdSchema,
} from './primitives.js';

/**
 * Structured target filters. The authoritative engine computes the legal set
 * from these; the client never decides legality on its own (CLAUDE.md §9).
 */

export const numericRangeSchema = z
  .strictObject({
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  })
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, {
    message: 'Range min must not exceed max.',
  });
export type NumericRange = z.infer<typeof numericRangeSchema>;

export const CONTROLLERS = ['self', 'opponent', 'any'] as const;
export const controllerSchema = z.enum(CONTROLLERS);
export type Controller = z.infer<typeof controllerSchema>;

/**
 * Which players an effect applies to.
 *
 * `opponent` names exactly one living opponent. With three or four seats that
 * is genuinely ambiguous, so the engine asks the controller to pick rather than
 * guessing — CLAUDE.md §12 requires an explicitly selected living opponent
 * unless the definition says `each_opponent`.
 *
 * `each_opponent` and `all_players` resolve clockwise; `all_players` puts the
 * controller first, then clockwise (open-questions.md Q33).
 */
export const PLAYER_SELECTORS = ['self', 'opponent', 'each_opponent', 'all_players'] as const;
export const playerSelectorSchema = z.enum(PLAYER_SELECTORS);
export type PlayerSelector = z.infer<typeof playerSelectorSchema>;

export const SELECTION_MODES = ['player_choice', 'random', 'automatic'] as const;
export const selectionModeSchema = z.enum(SELECTION_MODES);
export type SelectionMode = z.infer<typeof selectionModeSchema>;

/**
 * How long a modifier lasts.
 *
 * `end_of_combat` and `until_your_next_turn` are boundaries the ruleset's
 * combat tricks need (§15): "+1 ATK **for that combat**" must not survive into
 * the second Main Phase, and "+0/+2 **until the beginning of your next turn**"
 * has to cover the opponents' turns in between, which `end_of_turn` cannot.
 */
export const DURATIONS = [
  'permanent',
  'end_of_turn',
  'end_of_combat',
  'until_your_next_turn',
  'while_source_present',
] as const;
export const durationSchema = z.enum(DURATIONS);
export type Duration = z.infer<typeof durationSchema>;

/** `"all"` means every matching entity rather than a fixed count. */
export const targetCountSchema = z.union([z.number().int().min(1).max(20), z.literal('all')]);
export type TargetCount = z.infer<typeof targetCountSchema>;

/**
 * The predicates a card filter can test. Every one that is present must hold —
 * a filter is an AND — except inside `anyOf`, which is the OR.
 */
const cardFilterPredicates = {
  cardTypes: z.array(cardTypeSchema).min(1).optional(),
  cardIds: z.array(cardIdSchema).min(1).optional(),
  colors: z.array(colorIdSchema).min(1).optional(),
  tags: z.array(tagSchema).min(1).optional(),
  keywords: z.array(keywordIdSchema).min(1).optional(),
  cost: numericRangeSchema.optional(),
  attack: numericRangeSchema.optional(),
  health: numericRangeSchema.optional(),
  damaged: z.boolean().optional(),
  exhausted: z.boolean().optional(),
  unique: z.boolean().optional(),
  /**
   * Whether the card arrived on the battlefield this turn-cycle and has not yet
   * been through its controller's Ready Step (ruleset update §8). Several cards
   * ask about it directly, so it is a filter predicate rather than something
   * only the combat rules may consult.
   */
  newlyDeployed: z.boolean().optional(),
  /** Currently declared as an attacker in this combat. */
  attacking: z.boolean().optional(),
  /** Currently assigned as a blocker in this combat. */
  blocking: z.boolean().optional(),
  /**
   * Blocked and lived through it since its controller's previous turn
   * (ruleset update §15).
   *
   * A fact about the unit's recent history, not about the current combat — the
   * blocking it describes happened on somebody else's turn. Distinct from
   * `blocking`, which is only ever true mid-combat.
   */
  survivedAsBlocker: z.boolean().optional(),
} as const;

/**
 * One alternative inside an `anyOf`.
 *
 * Deliberately *not* recursive: an alternative cannot itself contain an
 * `anyOf`. One level of alternation expresses every "X or Y" the catalog
 * prints ("a Goblin **or** a Relic", "a Unit with Guardian **or** a Reaction
 * Spell") and keeps the filter a flat, analysable shape that the help layer can
 * turn into a sentence and a pilot can price. Arbitrary nesting would be a
 * miniature boolean language, which CLAUDE.md §8 rules out.
 */
const cardFilterAlternativeSchema = z.strictObject(cardFilterPredicates);
export type CardFilterAlternative = z.infer<typeof cardFilterAlternativeSchema>;

export const cardFilterSchema = z.strictObject({
  ...cardFilterPredicates,
  /**
   * "X or Y". At least one alternative must match, on top of any predicates set
   * alongside it — so `{ cardTypes: ['unit'], anyOf: [...] }` reads as "a unit
   * that is either … or …".
   *
   * `cardTypes`, `tags`, `colors` and `keywords` already OR *within themselves*,
   * so this is only needed when the alternatives differ in **which** predicate
   * they test.
   */
  anyOf: z.array(cardFilterAlternativeSchema).min(2).max(4).optional(),
});
export type CardFilter = z.infer<typeof cardFilterSchema>;

/** A zone-and-filter query for cards or units. */
export const targetSelectorSchema = z.strictObject({
  zone: zoneIdSchema,
  controller: controllerSchema.default('any'),
  filter: cardFilterSchema.optional(),
  count: targetCountSchema.default(1),
  selection: selectionModeSchema.default('player_choice'),
  /**
   * Who picks, when `selection` is `player_choice`.
   *
   * A **plural** chooser — `each_opponent` or `all_players` — is the whole of
   * "**each player** chooses …" (M02.5). It turns one selection into a
   * distributed one: every named seat is asked separately, in the fixed order
   * that selector already resolves in, and `controller` below is then read
   * relative to *the seat being asked* rather than to the ability's controller,
   * so `controller: "self"` is "a Unit **they** control".
   *
   * That re-reading costs nothing anywhere else: with the default `self`
   * chooser the seat being asked **is** the ability's controller, so every card
   * authored before this existed means exactly what it always meant.
   *
   * Every answer is collected before any of them is applied. The engine may not
   * resolve the choices one at a time, because a later chooser would then be
   * deciding with a board the card never promised them (M02.5).
   */
  chooser: playerSelectorSchema.default('self'),
  /** When true the effect resolves harmlessly if no legal target exists. */
  optional: z.boolean().default(false),
  /** Excludes the card that produced the effect from the legal set. */
  excludeSource: z.boolean().default(false),
  /**
   * Expands the chosen Token into every Token of the same definition controlled
   * by the same player.
   *
   * "Exhaust all Tokens with the same Token definition controlled by target
   * player" (rule adjustment §8). The chooser names one Token, which identifies
   * both the player and the definition, and the effect then reaches every
   * matching Token — so the result is identical whether or not the client
   * groups Tokens visually, which is the whole requirement. Non-Token units are
   * never expanded: a group-target rule that quietly caught real cards would be
   * a different, much stronger effect.
   *
   * `.optional()` rather than `.default(false)` like its neighbours, and
   * deliberately: this is a rare opt-in on a shape that is also written by hand
   * in fixtures and tests, so a default would have made "absent" a type error
   * everywhere for a flag almost nothing sets. Absent means off.
   */
  groupByTokenDefinition: z.boolean().optional(),
});
export type TargetSelector = z.infer<typeof targetSelectorSchema>;

/**
 * What an effect points at.
 *
 * A discriminated union rather than one selector with escape-hatch booleans:
 * "the card this is printed on" and "an opposing player" are not zone queries,
 * and forcing them through `TargetSelector` is what produced the `targetsSource`
 * flag in Phase 2 (CLAUDE.md §12, open-questions.md Q23/Q29).
 */
export const targetDefinitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('entity'),
    selector: targetSelectorSchema,
  }),
  /** The instance whose text this is. Always exactly one entity, never chosen. */
  z.strictObject({
    kind: z.literal('source'),
  }),
  /**
   * The card the trigger was *about*, as opposed to the card the ability is
   * printed on.
   *
   * "The first Guardian you deploy each turn gains Barrier" needs to point at
   * the unit that was deployed, which is neither the source nor anything a
   * player chooses. Only meaningful inside a triggered ability; anywhere else
   * there is no subject and the instruction fizzles rather than guessing.
   */
  z.strictObject({
    kind: z.literal('trigger_subject'),
  }),
  /**
   * Every attacker the source is currently assigned to block (M02.4).
   *
   * Read from the public block assignments when the instruction resolves, so it
   * names what the source is actually blocking. Outside such a combat it names
   * nothing and the instruction fizzles. See the identical member of
   * `EntityTarget`, which is the narrowing of this union that card-only effects
   * use.
   */
  z.strictObject({
    kind: z.literal('blocked_by_source'),
  }),
  /**
   * Whatever the instruction before this one resolved with — the "it" of a
   * two-sentence card (M02.4). See the identical member of `EntityTarget`.
   */
  z.strictObject({
    kind: z.literal('previous_target'),
  }),
  z.strictObject({
    kind: z.literal('player'),
    relation: z.enum(['self', 'opponent']),
    /**
     * `automatic` only resolves without asking when there is exactly one legal
     * answer; otherwise the engine raises a `select_players` choice regardless,
     * because it may not invent a target.
     */
    selection: z.enum(['automatic', 'player_choice']).default('player_choice'),
  }),
  z.strictObject({
    kind: z.literal('players'),
    relation: z.enum(['each_opponent', 'all_players']),
  }),
]);
export type TargetDefinition = z.infer<typeof targetDefinitionSchema>;
export type TargetDefinitionInput = z.input<typeof targetDefinitionSchema>;

/**
 * True when a selector asks several seats rather than one (M02.5).
 *
 * The single predicate every layer reads — engine, help renderer and pilots —
 * so "is this an each-player choice?" cannot be answered two different ways.
 * `player_choice` is part of the test because a `random` or `automatic`
 * selection has no chooser at all: nobody is asked, so there is nothing to
 * distribute.
 */
export function isDistributedSelection(selector: TargetSelector): boolean {
  return (
    selector.selection === 'player_choice' &&
    (selector.chooser === 'each_opponent' || selector.chooser === 'all_players')
  );
}

/** Convenience constructor for the common "one zone query" case. */
export function entityTarget(
  selector: z.input<typeof targetSelectorSchema>,
): TargetDefinitionInput {
  return { kind: 'entity', selector };
}

/** True when the definition points at players rather than cards. */
export function targetsPlayers(
  target: TargetDefinition,
): target is Extract<TargetDefinition, { kind: 'player' | 'players' }> {
  return target.kind === 'player' || target.kind === 'players';
}
