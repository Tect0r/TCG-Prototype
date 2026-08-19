import {
  ARCHETYPE_REGISTRY,
  ARCHETYPE_REGISTRY_VERSION,
  archetypeIdSchema,
  type ArchetypeId,
} from '@tcg/card-data';
import {
  DECK_CONSTRUCTION_KINDS,
  type DeckConstructionKind,
  type SimDeck,
} from '@tcg/deck-generator';

/**
 * How the decks in this run were built (M05.5).
 *
 * The third question in the same family as mechanic support and agent classes,
 * and independent of both. Those two ask "could these cards be played" and "was
 * the player the kind of instrument whose results mean anything". This one asks
 * **whose decks were these**, because the answer changes what a win rate is
 * about:
 *
 * - a `hand_authored` deck is a designer's statement, and a result about it is a
 *   result about a decision somebody made;
 * - a `plan_generated` deck has a coherent engine and payoff by construction, so
 *   a result about it is about a *strategy* rather than about 40 legal cards;
 * - an `unconstrained` deck is a weighted random draw, and a result about it is
 *   mostly a result about the card pool.
 *
 * Pooling them would produce a number that is none of the three, which is the
 * same error M05.4 forbade for pilots. So they are counted apart and reported
 * apart, and a run that mixes them says so.
 *
 * Everything here is a projection of what the decks recorded about themselves.
 * Nothing is inferred from a decklist: a random deck that happens to contain a
 * whole package is still a random deck, and `DeckConstruction.kind` is the only
 * thing that knows the difference.
 */

/** Schema of the `deckConstruction` block in the manifest and the summary. */
export const DECK_CONSTRUCTION_ANALYSIS_VERSION = 1;

export interface ConstructionCount {
  readonly kind: DeckConstructionKind;
  readonly decks: number;
}

export interface PlanUsage {
  readonly planId: string;
  readonly archetypeId: ArchetypeId | null;
  readonly decks: number;
  /** Packages held by every deck measured against this plan. */
  readonly packagesIntactMin: number;
  readonly packagesIntactMax: number;
  /** Deck slots no package of the plan names, at their narrowest and widest. */
  readonly offPlanCardsMin: number;
  readonly offPlanCardsMax: number;
}

export interface DeckConstructionAnalysis {
  readonly schemaVersion: number;
  readonly registryVersion: number;
  readonly deckCount: number;
  /** Every kind in published order, including the ones with no decks. */
  readonly counts: readonly ConstructionCount[];
  /** More than one kind is present, so no pooled deck number is about one thing. */
  readonly mixed: boolean;
  /** Plans any deck in the run was measured against, sorted by ID. */
  readonly plans: readonly PlanUsage[];
  /** Archetypes represented, in registry order. */
  readonly archetypes: readonly ArchetypeId[];
  /**
   * Decks measured against a plan that hold none of its packages intact.
   *
   * Named rather than counted silently: a search that has dismantled every
   * package of the plan it was seeded from has left the archetype, and the
   * report says so instead of continuing to print the plan's name beside it.
   */
  readonly decksOffPlan: number;
}

export function analyzeDeckConstruction(decks: readonly SimDeck[]): DeckConstructionAnalysis {
  const counts = DECK_CONSTRUCTION_KINDS.map((kind) => ({
    kind,
    decks: decks.filter((deck) => deck.construction.kind === kind).length,
  }));

  const byPlan = new Map<string, SimDeck[]>();
  for (const deck of decks) {
    const planId = deck.construction.planId;
    if (planId === null) continue;
    const bucket = byPlan.get(planId);
    if (bucket) bucket.push(deck);
    else byPlan.set(planId, [deck]);
  }

  const plans: PlanUsage[] = [...byPlan.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([planId, members]) => {
      const intact = members.map((deck) => deck.construction.packagesIntact.length);
      const offPlan = members.map((deck) => deck.construction.offPlanCards);
      return {
        planId,
        archetypeId: asArchetype(members[0]?.construction.archetypeId ?? null),
        decks: members.length,
        packagesIntactMin: Math.min(...intact),
        packagesIntactMax: Math.max(...intact),
        offPlanCardsMin: Math.min(...offPlan),
        offPlanCardsMax: Math.max(...offPlan),
      };
    });

  const seen = new Set(
    plans.map((entry) => entry.archetypeId).filter((id): id is ArchetypeId => id !== null),
  );

  return {
    schemaVersion: DECK_CONSTRUCTION_ANALYSIS_VERSION,
    registryVersion: ARCHETYPE_REGISTRY_VERSION,
    deckCount: decks.length,
    counts,
    mixed: counts.filter((entry) => entry.decks > 0).length > 1,
    plans,
    archetypes: (Object.keys(ARCHETYPE_REGISTRY) as ArchetypeId[]).filter((id) => seen.has(id)),
    decksOffPlan: decks.filter(
      (deck) => deck.construction.planId !== null && deck.construction.packagesIntact.length === 0,
    ).length,
  };
}

/**
 * A recorded archetype ID this build still recognises, or `null`.
 *
 * A deck from an older artefact may name an archetype the registry has since
 * dropped. That is an unvouched-for label rather than a new one, so it is
 * reported as absent instead of being passed through as if the registry had
 * blessed it — the same reading M05.4 gave an unrecognised pilot ID.
 */
function asArchetype(value: string | null): ArchetypeId | null {
  if (value === null) return null;
  const parsed = archetypeIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function constructionKindLabel(kind: DeckConstructionKind): string {
  switch (kind) {
    case 'hand_authored':
      return 'hand-authored';
    case 'plan_generated':
      return 'plan-generated';
    case 'unconstrained':
      return 'unconstrained';
  }
}

/** One line per kind, for the report. Total, so a new kind needs a sentence. */
export const CONSTRUCTION_KIND_MEANINGS: Readonly<Record<DeckConstructionKind, string>> =
  Object.freeze({
    hand_authored:
      'A person wrote this list — a precon, an inline deck or a deck-builder export. A result ' +
      'about it is a result about a decision somebody made.',
    plan_generated:
      'Seeded from an authored deck plan, so its engine and payoff are coherent by construction. ' +
      'A result about it is about a strategy rather than about forty legal cards.',
    unconstrained:
      'Drawn from the legal pool under a curve and a role weighting, with no plan. Legal, and ' +
      'about as strategically coherent as any random forty cards.',
  });
