import { z } from 'zod';
import { EFFECT_TYPES, type EffectDefinition, type EffectType } from './schema/effect.js';
import type { SignedValueExpression } from './schema/condition.js';
import type { ZoneId } from './schema/primitives.js';

/**
 * What being selected *does to the thing selected* (M05.3).
 *
 * The question this answers is deliberately narrow. It is not "is this card
 * good", not "does this player want to be asked", and not "who benefits from the
 * card overall" — it is the valence of **one instruction** on **one recipient**,
 * which is the only thing a chooser actually needs in order to know whether to
 * name its best option or its worst.
 *
 * That narrowness is the whole tranche. The pilots used to answer the same
 * question by scanning a card's entire effect list for anything that looked
 * hostile, so a card reading "Deal 2 damage to an enemy Unit. A friendly Unit
 * gains +2/+2" was hostile *for both of its choices*, and the pilot dutifully
 * picked its worst unit to buff. An instruction carries its own valence; the
 * card it is printed on does not have one.
 *
 * - **benefit** — the selected entity's controller is better off for it being
 *   selected: it is healed, buffed, readied, drawn, revived, found.
 * - **detriment** — the selected entity's controller is worse off: it is
 *   destroyed, damaged, discarded, exhausted, bounced, buried, taxed.
 * - **neutral** — the instruction does nothing to the selected entity that can
 *   be read as good or bad without knowing more than the instruction says.
 *
 * A `neutral` intent is a decision, not a fallback. Nothing here may be
 * classified `neutral` because it was awkward: the table below is total over the
 * instruction vocabulary, and an unclassified instruction is a compile error.
 */
export const CHOICE_INTENTS = ['benefit', 'detriment', 'neutral'] as const;
export const choiceIntentSchema = z.enum(CHOICE_INTENTS);
export type ChoiceIntent = z.infer<typeof choiceIntentSchema>;

/** Decides the intent of one named member of the instruction vocabulary. */
type EffectIntentRule<K extends EffectType> = (
  effect: Extract<EffectDefinition, { type: K }>,
) => ChoiceIntent;

/**
 * Sign of a stat delta.
 *
 * A derived magnitude (`count`, `stat`) is non-negative before its own `sign` is
 * applied, so the `sign` field is the answer for those. `plus` is deliberately
 * ignored: it is an adjustment to a magnitude, not the direction of one, and a
 * card whose direction depended on it would be one whose printed text could not
 * say whether it was a buff.
 */
function signOf(value: SignedValueExpression): number {
  return typeof value === 'number' ? Math.sign(value) : value.sign;
}

/**
 * Zones a card is better off arriving in than leaving.
 *
 * `hand` and `battlefield` are where a card can still be used; everything else
 * is a place it has been put out of the way — including `deck`, which is where
 * "look at the top three and put one on the bottom" sends the card the chooser
 * likes least.
 */
const USEFUL_ZONES: ReadonlySet<ZoneId> = new Set<ZoneId>(['hand', 'battlefield']);

/**
 * The instruction intent table (M05.3).
 *
 * Shaped like `EFFECT_PRICERS` in `@tcg/bot-interface` and the support registry
 * in `support.ts`: a total mapped type over the schema's own instruction
 * vocabulary, so adding an instruction without classifying its valence is a
 * **compile error**, and `effectIntentGaps` makes the same check at runtime for
 * the JSON-driven paths that never see the type.
 *
 * Four entries read a parameter rather than returning a constant, because for
 * those four the printed number *is* the valence: `-2/-0` and `+2/+0` are the
 * same instruction pointing in opposite directions.
 */
const EFFECT_INTENTS: { readonly [K in EffectType]: EffectIntentRule<K> } = {
  draw: () => 'benefit',
  discard: () => 'detriment',
  deal_damage: () => 'detriment',
  heal: () => 'benefit',

  // "+2/+2" and "-2/-0" are one instruction with two directions.
  modify_stats: (effect) => {
    const direction = signOf(effect.attack) + signOf(effect.health);
    if (direction > 0) return 'benefit';
    if (direction < 0) return 'detriment';
    return 'neutral';
  },

  grant_keyword: () => 'benefit',
  remove_keyword: () => 'detriment',
  create_token: () => 'benefit',
  destroy: () => 'detriment',
  sacrifice: () => 'detriment',
  return_to_hand: () => 'detriment',

  /**
   * A search is judged by where the chosen card ends up. "Find a Unit and put it
   * in your hand" wants the best card; "look at the top three and put one on the
   * bottom" wants the worst, and both are this instruction.
   */
  search_zone: (effect) => (USEFUL_ZONES.has(effect.destination) ? 'benefit' : 'detriment'),

  /**
   * An earlier position is drawn sooner, so putting a card first is good for
   * whoever owns the zone — which is what makes "reorder an opponent's deck"
   * come out the right way round without a second rule.
   */
  reorder_zone: () => 'benefit',

  modify_cost: (effect) => {
    if (effect.delta < 0) return 'benefit';
    if (effect.delta > 0) return 'detriment';
    return 'neutral';
  },

  prevent_damage: () => 'benefit',
  exhaust: () => 'detriment',
  ready: () => 'benefit',
  skip_next_ready: () => 'detriment',

  /**
   * Judged by the journey, not by the destination alone: `battlefield` is a
   * revival, `hand` is recursion out of a discard pile but a bounce off a
   * battlefield, and everything else puts the card away.
   *
   * A target that is not a zone query — the source, the trigger subject, "it",
   * the units this one is blocking — always names a permanent, so the card is
   * coming off a battlefield.
   */
  move_card: (effect) => {
    const fromZone: ZoneId =
      effect.target.kind === 'entity' ? effect.target.selector.zone : 'battlefield';
    if (effect.toZone === 'battlefield') return 'benefit';
    if (effect.toZone === 'hand') return fromZone === 'battlefield' ? 'detriment' : 'benefit';
    return 'detriment';
  },

  counter: () => 'detriment',

  /**
   * Scheduling a promise does nothing to anything yet. The delayed body's own
   * instructions are classified when they resolve, which is the only moment at
   * which there is a recipient to be better or worse off (M02.1).
   */
  schedule_delayed: () => 'neutral',
};

/** What being selected for this instruction does to the selected entity. */
export function effectIntent(effect: EffectDefinition): ChoiceIntent {
  // The one cast in the module, for the reason `ungatedEffectValue` needs its
  // twin: indexing a mapped type with a union key yields a union of function
  // types TypeScript will not call, and the mapped type is what makes it safe.
  const rule = EFFECT_INTENTS[effect.type] as EffectIntentRule<EffectType>;
  return rule(effect);
}

/**
 * Runtime twin of the type-level totality check on `EFFECT_INTENTS`.
 *
 * Checks both directions — an instruction in the schema with no intent, and an
 * intent for an instruction the schema no longer has — and returns the problems
 * rather than throwing, so a caller can report all of them at once. Modelled on
 * `supportRegistryGaps` and `effectPricingGaps`.
 */
export function effectIntentGaps(): string[] {
  const problems: string[] = [];
  const classified = new Set<string>(Object.keys(EFFECT_INTENTS));
  for (const type of EFFECT_TYPES) {
    if (!classified.has(type)) {
      problems.push(`effect:${type} is in the schema but has no choice intent.`);
    }
  }
  for (const type of classified) {
    if (!(EFFECT_TYPES as readonly string[]).includes(type)) {
      problems.push(`effect:${type} has a choice intent but is not in the schema.`);
    }
  }
  return problems;
}
