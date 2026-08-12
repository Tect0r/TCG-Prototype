import {
  SUPPORT_DIMENSIONS,
  SUPPORT_REGISTRY_VERSION,
  describeCardSupport,
  limitingMechanics,
  mechanicKey,
  mechanicSupport,
  mechanicsUsedByAll,
  supportRank,
  weakestSupport,
  type CardDatabase,
  type CardDefinition,
  type MechanicSupport,
  type SupportDimension,
} from '@tcg/card-data';
import { LEGAL_ONLY_PILOT_IDS } from '@tcg/bot-interface';
import type { SimDeck } from '../deck-search/deck.js';

/**
 * How well supported the mechanics a run actually played are (M05.1).
 *
 * The report has always said what its pilots were and what its thresholds were.
 * It has never said whether the *cards* were something a pilot could play or a
 * batch could observe, and that is the difference between "these decks won at
 * these rates" and "these decks won at these rates, and one of them is a
 * Reaction deck no pilot values". This module answers the second question, and
 * everything it answers with is derived from the mechanic support registry in
 * `@tcg/card-data` rather than from anything an author wrote on a card.
 *
 * It is deliberately not an opinion. Nothing here is a score, a verdict or a
 * threshold; it is a projection of the registry onto the decks that were played,
 * plus the two booleans the flag layer uses to decline a claim.
 */

/** Schema of the `mechanicSupport` block in the manifest and the summary. */
export const SUPPORT_ANALYSIS_VERSION = 1;

export interface MechanicSupportNote {
  readonly key: string;
  readonly where: string;
}

export interface DeckSupport {
  readonly deckHash: string;
  readonly label: string;
  /** The weakest level reached in each dimension, folded independently. */
  readonly weakest: MechanicSupport;
  /** What holds the deck back, per dimension, as `kind:id` keys. */
  readonly limiting: Readonly<Record<SupportDimension, readonly string[]>>;
  /** Cards no pilot values at least one thing about. */
  readonly pilotBlindCards: readonly string[];
  /** Cards nothing in a match record observes. */
  readonly telemetryBlindCards: readonly string[];
  /** Cards built on a mechanic the engine does not execute. Normally empty. */
  readonly inertCards: readonly string[];
}

export interface MechanicSupportAnalysis {
  readonly schemaVersion: number;
  readonly registryVersion: number;
  /** Weakest support across every deck in the run. */
  readonly weakest: MechanicSupport;
  readonly decks: readonly DeckSupport[];
  /**
   * Cards, across all decks, that no pilot values something about — the set the
   * flag layer declines card-level claims for.
   */
  readonly pilotBlindCards: readonly string[];
  readonly telemetryBlindCards: readonly string[];
  /** Every pilot in the run only plays legally, so nothing here is play quality. */
  readonly legalOnlyPilots: boolean;
  readonly pilotIds: readonly string[];
  /** Developer-facing notes for the mechanics named in `limiting`. */
  readonly notes: readonly MechanicSupportNote[];
}

/** The three fields the flag layer needs, projected out of a full analysis. */
export function supportLimitsOf(analysis: MechanicSupportAnalysis): {
  readonly legalOnlyPilots: boolean;
  readonly pilotBlindCards: readonly string[];
  readonly telemetryBlindCards: readonly string[];
} {
  return {
    legalOnlyPilots: analysis.legalOnlyPilots,
    pilotBlindCards: analysis.pilotBlindCards,
    telemetryBlindCards: analysis.telemetryBlindCards,
  };
}

function cardsOf(deck: SimDeck, database: CardDatabase): CardDefinition[] {
  const cards: CardDefinition[] = [];
  const commander = database.get(deck.commanderId);
  if (commander) cards.push(commander);
  for (const entry of deck.cards) {
    const definition = database.get(entry.cardId);
    if (definition) cards.push(definition);
  }
  return cards;
}

/**
 * Tokens a deck's cards create are part of what the deck does, so their
 * mechanics count. A card that creates a Token with a triggered ability is a
 * card whose behaviour lives on the Token.
 */
function withTokens(cards: readonly CardDefinition[], database: CardDatabase): CardDefinition[] {
  const seen = new Set(cards.map((card) => card.id));
  const all = [...cards];
  for (const card of cards) {
    for (const list of [
      card.effects,
      ...card.abilities.map((ability) => ability.effects),
      ...card.activatedAbilities.map((ability) => ability.effects),
      ...card.delayedAbilities.map((ability) => ability.effects),
    ]) {
      for (const effect of list) {
        if (effect.type !== 'create_token' || seen.has(effect.tokenCardId)) continue;
        const token = database.get(effect.tokenCardId);
        if (!token) continue;
        seen.add(token.id);
        all.push(token);
      }
    }
  }
  return all;
}

function limitingKeys(
  cards: readonly CardDefinition[],
): Readonly<Record<SupportDimension, readonly string[]>> {
  const refs = mechanicsUsedByAll(cards);
  const limiting = {} as Record<SupportDimension, readonly string[]>;
  for (const dimension of SUPPORT_DIMENSIONS) {
    limiting[dimension] = limitingMechanics(refs, dimension).map(mechanicKey);
  }
  return limiting;
}

function describeDeck(deck: SimDeck, database: CardDatabase): DeckSupport {
  const cards = withTokens(cardsOf(deck, database), database);
  const supports = cards.map((card) => describeCardSupport(card));
  return {
    deckHash: deck.hash,
    label: deck.label,
    weakest: weakestSupport(mechanicsUsedByAll(cards)),
    limiting: limitingKeys(cards),
    pilotBlindCards: supports
      .filter((support) => support.pilotBlind)
      .map((support) => support.cardId)
      .sort(),
    telemetryBlindCards: supports
      .filter((support) => support.telemetryBlind)
      .map((support) => support.cardId)
      .sort(),
    inertCards: supports
      .filter((support) => !support.executable)
      .map((support) => support.cardId)
      .sort(),
  };
}

/** Folds two readings by taking the weaker level in each dimension. */
function weaker(left: MechanicSupport, right: MechanicSupport): MechanicSupport {
  const result = { ...left } as Record<SupportDimension, string>;
  for (const dimension of SUPPORT_DIMENSIONS) {
    if (supportRank(dimension, right[dimension]) > supportRank(dimension, left[dimension])) {
      result[dimension] = right[dimension];
    }
  }
  return result as MechanicSupport;
}

const FULLY_SUPPORTED: MechanicSupport = {
  engine: 'full',
  help: 'full',
  pilot: 'full',
  telemetry: 'full',
};

export function analyzeMechanicSupport(inputs: {
  readonly decks: readonly SimDeck[];
  readonly database: CardDatabase;
  readonly pilotIds: readonly string[];
}): MechanicSupportAnalysis {
  const decks = inputs.decks
    .map((deck) => describeDeck(deck, inputs.database))
    .sort((left, right) => left.deckHash.localeCompare(right.deckHash));

  const weakest = decks.reduce<MechanicSupport>(
    (accumulator, deck) => weaker(accumulator, deck.weakest),
    FULLY_SUPPORTED,
  );

  const pilotIds = [...new Set(inputs.pilotIds)].sort();
  const union = (pick: (deck: DeckSupport) => readonly string[]): readonly string[] =>
    [...new Set(decks.flatMap(pick))].sort();

  // Only the mechanics that actually limited something get a note, so the block
  // stays a diagnosis rather than a copy of the whole registry.
  const named = new Set(
    decks.flatMap((deck) => SUPPORT_DIMENSIONS.flatMap((d) => deck.limiting[d])),
  );
  const notes = mechanicsUsedByAll(
    inputs.decks.flatMap((deck) => withTokens(cardsOf(deck, inputs.database), inputs.database)),
  )
    .filter((ref) => named.has(mechanicKey(ref)))
    .map((ref) => ({ key: mechanicKey(ref), where: mechanicSupport(ref).where }));

  return {
    schemaVersion: SUPPORT_ANALYSIS_VERSION,
    registryVersion: SUPPORT_REGISTRY_VERSION,
    weakest,
    decks,
    pilotBlindCards: union((deck) => deck.pilotBlindCards),
    telemetryBlindCards: union((deck) => deck.telemetryBlindCards),
    // "Every pilot is legality-only", not "any": a run mixing random_legal with
    // a heuristic still produced heuristic play at some seats, and refusing to
    // report any of it would throw away the arm that was flown properly.
    legalOnlyPilots:
      pilotIds.length > 0 &&
      pilotIds.every((id) => (LEGAL_ONLY_PILOT_IDS as readonly string[]).includes(id)),
    pilotIds,
    notes,
  };
}
