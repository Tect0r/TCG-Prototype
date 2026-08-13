import type { CardDefinition, EffectDefinition } from '@tcg/card-data';
import { mechanicKey, mechanicsUsedByAll } from '@tcg/card-data';
import { z } from 'zod';

/**
 * What kind of tactical decision a calibration fixture is about (M05.6).
 *
 * A match result cannot tell you whether a pilot sacrificed the right unit: the
 * action was legal, the match finished, and the number at the end is the same
 * either way. These are the decision families where "legal" and "characteristic"
 * come apart, so they are the families a hand-authored fixture has to pin.
 *
 * The three the milestone names — sequencing, targeting, sacrifice — plus the two
 * that are the whole identity of two of the four shipped precons: a Guardian deck
 * is a blocking deck, and a Containment deck is a Reaction deck. Leaving those
 * out would have calibrated every precon except at the thing it is for.
 */
export const CALIBRATION_FACETS = [
  'sequencing',
  'targeting',
  'sacrifice',
  'blocking',
  'reaction',
] as const;
export const calibrationFacetSchema = z.enum(CALIBRATION_FACETS);
export type CalibrationFacet = z.infer<typeof calibrationFacetSchema>;

export interface CalibrationFacetDefinition {
  readonly id: CalibrationFacet;
  readonly label: string;
  /** The question a fixture in this facet answers, for the coverage report. */
  readonly question: string;
  /**
   * Whether a deck can even pose this question, read off the deck's own cards.
   *
   * Derived rather than declared, for the reason everything else in M05 is:
   * `precon_goblin_swarm` contains no sacrifice, and a registry that let somebody
   * *claim* that would let the next author claim it about a deck that does. Two
   * of the five are true of every legal deck, and they are still computed from
   * the cards rather than returned as `true`, so a future format whose decks are
   * not built from Units answers honestly without anybody remembering to look.
   */
  readonly appliesTo: (cards: readonly CardDefinition[]) => boolean;
}

/** Does any card in the deck hand its controller a pick between board entities? */
function targetsEntities(cards: readonly CardDefinition[]): boolean {
  return cards.some((card) => allEffectsOf(card).some(effectTargetsEntity));
}

function effectTargetsEntity(effect: EffectDefinition): boolean {
  const target = (effect as { readonly target?: { readonly kind?: string } }).target;
  return target?.kind === 'entity';
}

/** Every instruction a card can execute, wherever it is printed. */
function allEffectsOf(card: CardDefinition): readonly EffectDefinition[] {
  return [
    ...card.effects,
    ...card.abilities.flatMap((ability) => ability.effects),
    ...card.activatedAbilities.flatMap((ability) => ability.effects),
    ...card.delayedAbilities.flatMap((ability) => ability.effects),
  ];
}

/** Does any card sacrifice something, as an instruction or as a cost? */
function sacrifices(cards: readonly CardDefinition[]): boolean {
  return mechanicsUsedByAll(cards).some(
    (ref) => mechanicKey(ref) === 'effect:sacrifice' || mechanicKey(ref) === 'cost:sacrifice',
  );
}

export const CALIBRATION_FACET_REGISTRY: Readonly<
  Record<CalibrationFacet, CalibrationFacetDefinition>
> = Object.freeze({
  sequencing: {
    id: 'sequencing',
    label: 'sequencing',
    question:
      'Within one turn, does the pilot take its plays in an order that keeps them all live?',
    // Two cards is the smallest hand an order can be wrong in.
    appliesTo: (cards) => cards.length >= 2,
  },
  targeting: {
    id: 'targeting',
    label: 'targeting',
    question: 'Handed a pick between board entities, does the pilot name the one that matters?',
    appliesTo: targetsEntities,
  },
  sacrifice: {
    id: 'sacrifice',
    label: 'sacrifice',
    question: 'Asked to give something up, does the pilot give up the thing it can most afford?',
    appliesTo: sacrifices,
  },
  blocking: {
    id: 'blocking',
    label: 'blocking',
    question: 'Facing an attack, does the pilot put the right bodies in front of it?',
    appliesTo: (cards) => cards.some((card) => card.type === 'unit'),
  },
  reaction: {
    id: 'reaction',
    label: 'reaction',
    question: 'Offered a Reaction window, does the pilot spend the answer on something worth it?',
    appliesTo: (cards) => cards.some((card) => card.type === 'reaction'),
  },
});

/** The facets a specific deck can pose a question in, in vocabulary order. */
export function facetsApplicableTo(cards: readonly CardDefinition[]): CalibrationFacet[] {
  return CALIBRATION_FACETS.filter((facet) => CALIBRATION_FACET_REGISTRY[facet].appliesTo(cards));
}

/**
 * Runtime twin of the type-level totality check, in both directions.
 *
 * The `Record` type already fails a build that adds a facet without describing
 * it; this catches an entry for a facet the vocabulary no longer has, and covers
 * the JSON-driven callers that arrive with a string.
 */
export function calibrationFacetGaps(): string[] {
  const problems: string[] = [];
  const known = new Set<string>(CALIBRATION_FACETS);
  for (const key of Object.keys(CALIBRATION_FACET_REGISTRY)) {
    if (!known.has(key)) problems.push(`calibration facet "${key}" is described but not listed.`);
  }
  for (const facet of CALIBRATION_FACETS) {
    const definition = CALIBRATION_FACET_REGISTRY[facet];
    if (definition.id !== facet) problems.push(`facet "${facet}" is filed under the wrong key.`);
    if (definition.question.trim() === '') problems.push(`facet "${facet}" has no question.`);
  }
  return problems;
}
