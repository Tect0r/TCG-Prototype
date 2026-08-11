import { z } from 'zod';
import { cardFilterSchema, controllerSchema } from './target.js';

/**
 * Counting, conditions and computed values (ruleset update §15).
 *
 * Three things the catalog needs constantly and the v0.2 vocabulary could not
 * say at all:
 *
 *  - **"if …"** — an ability that fires only when the board looks a certain way.
 *  - **"for each …"** — an amount that depends on the board rather than a
 *    printed number.
 *  - **"… this turn"** — a question about what has already happened, not about
 *    what is standing there now.
 *
 * All three are the same question underneath — *how many things match?* — so
 * they share one `CountQuery` rather than growing three parallel vocabularies
 * that drift apart. A condition compares a count to a number; a value scales a
 * count into an amount.
 *
 * Nothing here is a script. Every query is a closed set of named subjects with
 * a controller and a card filter, so the engine can answer it, the help layer
 * can describe it in a sentence, and a pilot can price it — none of which is
 * possible with an expression language.
 */

/**
 * What a query counts.
 *
 * Split into two families that behave very differently. The `*_this_turn`
 * subjects read a per-turn log, because the things they count have usually left
 * the board by the time anyone asks — "two friendly Units were defeated this
 * turn" cannot be answered by looking at the battlefield. Everything else reads
 * the current board.
 */
export const COUNT_SUBJECTS = [
  /** Units standing on a battlefield right now. */
  'units',
  /** Units currently declared as attackers in this combat. */
  'attacking_units',
  /** Units currently assigned as blockers in this combat. */
  'blocking_units',
  /** Cards in hand. */
  'cards_in_hand',
  /** Units that have been defeated so far this turn, for any reason. */
  'units_defeated_this_turn',
  /** Units sacrificed so far this turn. A subset of the defeated. */
  'units_sacrificed_this_turn',
  /** Units that arrived on a battlefield this turn, tokens included. */
  'units_deployed_this_turn',
  /** Tokens created this turn. A subset of the deployed. */
  'tokens_created_this_turn',
  /**
   * Units that blocked and survived combat this turn.
   *
   * The narrow window. "Since your previous turn" is the `survivedAsBlocker`
   * card filter instead, because after two opponents' turns the two questions
   * have different answers.
   */
  'units_survived_as_blocker_this_turn',
] as const;
export const countSubjectSchema = z.enum(COUNT_SUBJECTS);
export type CountSubject = z.infer<typeof countSubjectSchema>;

/**
 * One counting question.
 *
 * `controller` is relative to whoever the ability belongs to, never to a seat
 * index, so the same card counts correctly in a four-player game.
 */
export const countQuerySchema = z.strictObject({
  subject: countSubjectSchema,
  controller: controllerSchema.default('self'),
  filter: cardFilterSchema.optional(),
  /**
   * Excludes the card the ability is printed on. This is what turns "Goblins
   * you control" into "**other** Goblins you control" without a second subject.
   */
  excludeSource: z.boolean().default(false),
});
export type CountQuery = z.infer<typeof countQuerySchema>;

export const COMPARISONS = ['at_least', 'at_most', 'exactly'] as const;
export const comparisonSchema = z.enum(COMPARISONS);
export type Comparison = z.infer<typeof comparisonSchema>;

/** States of the card an ability is printed on that a condition may ask about. */
export const SOURCE_STATES = ['ready', 'exhausted', 'newly_deployed'] as const;
export const sourceStateSchema = z.enum(SOURCE_STATES);
export type SourceState = z.infer<typeof sourceStateSchema>;

/**
 * A gate on a trigger or an instruction.
 *
 * Evaluated at the moment the thing it guards would happen — when the trigger
 * fires, or when the instruction resolves — never cached. A condition that was
 * true when a trigger was queued and false by the time it resolves does not
 * fire, which is the behaviour every "if" on a card implies.
 */
export const conditionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('count'),
    count: countQuerySchema,
    comparison: comparisonSchema,
    value: z.number().int().min(0).max(99),
  }),
  /** "if this Unit is Ready" — a question about the source, not about a set. */
  z.strictObject({
    kind: z.literal('source_state'),
    state: sourceStateSchema,
    /** Set false for "if this Unit is *not* Ready". */
    expected: z.boolean().default(true),
  }),
  /**
   * "… during your turn".
   *
   * A question about whose turn it is, which no count can answer. Relative to
   * the ability's controller, so it reads the same at every seat.
   */
  z.strictObject({
    kind: z.literal('active_turn'),
    /** False for "during an opponent's turn". */
    expected: z.boolean().default(true),
  }),
  /**
   * "**If you do**, …" — the clause that hangs off an optional instruction
   * (ruleset update §15).
   *
   * True when the instruction immediately before this one actually did
   * something. "Did something" is measured by whether that step changed the
   * match — it emitted at least one event — not by whether the engine reached
   * it: a "you may sacrifice a Unit" that the player declined, or that found
   * nothing to act on, both leave the board exactly as it was, and both must
   * read as "you did not".
   *
   * Deliberately about the *immediately preceding* step rather than an authored
   * index. Every "if you do" on a card refers to the sentence before it, an
   * index would have to be re-validated against four separate effect arrays,
   * and a dangling one would silently gate an instruction off forever.
   *
   * Meaningless as an ability-level gate — a trigger has no preceding
   * instruction — where it evaluates false rather than guessing.
   */
  z.strictObject({
    kind: z.literal('previous_step'),
    /** False for "if you don't". */
    expected: z.boolean().default(true),
  }),
]);
export type ConditionDefinition = z.infer<typeof conditionSchema>;

/**
 * A number an effect uses, which may depend on the board.
 *
 * A bare number is still a bare number — the overwhelming majority of cards —
 * so widening these fields costs existing card data nothing. The object form
 * exists for "for each", "for every three", and the caps and floors that go
 * with them.
 */
export const valueExpressionSchema = z.union([
  z.number().int().min(0).max(99),
  z.strictObject({
    kind: z.literal('count'),
    count: countQuerySchema,
    /**
     * How many matches one point is worth. `per: 3` is "for every three",
     * rounded **down**, which is the only reading that makes "for every three
     * other Goblins" mean what a player expects at four Goblins.
     */
    per: z.number().int().min(1).max(20).default(1),
    /** Added after scaling. A flat base on top of the count. */
    plus: z.number().int().min(-99).max(99).default(0),
    /** Floor and ceiling, applied last. The result is never negative. */
    minimum: z.number().int().min(0).max(99).default(0),
    maximum: z.number().int().min(0).max(99).optional(),
  }),
]);
export type ValueExpression = z.infer<typeof valueExpressionSchema>;

/** True when the expression is a plain printed number. */
export function isFixedValue(value: ValueExpression): value is number {
  return typeof value === 'number';
}

/**
 * A signed number an effect uses. Same shape, but the count may be subtracted.
 *
 * Separate from `ValueExpression` because a stat modifier can legitimately be
 * negative and an amount of damage cannot, and collapsing the two would let a
 * card deal minus two damage.
 */
export const signedValueExpressionSchema = z.union([
  z.number().int().min(-99).max(99),
  z.strictObject({
    kind: z.literal('count'),
    count: countQuerySchema,
    per: z.number().int().min(1).max(20).default(1),
    plus: z.number().int().min(-99).max(99).default(0),
    /** `-1` counts downwards: "-1/-0 for each …". */
    sign: z.union([z.literal(1), z.literal(-1)]).default(1),
    minimum: z.number().int().min(-99).max(99).default(0),
    maximum: z.number().int().min(-99).max(99).optional(),
  }),
]);
export type SignedValueExpression = z.infer<typeof signedValueExpressionSchema>;
