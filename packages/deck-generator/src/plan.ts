import {
  ARCHETYPE_REGISTRY,
  bundledDeckPlan,
  deckPlanForPrecon,
  deckPlansForFormat,
  planCardIds,
  type ArchetypeId,
  type CardId,
  type DeckPlan,
  type DeckPlanPackage,
} from '@tcg/card-data';
import type { DeckConstruction, SimDeck } from './deck.js';
import type { GenerationEnvironment } from './environment.js';

/**
 * Deck plans as a generation input (M05.5).
 *
 * A plan is authored content — `@tcg/card-data` owns the schema, the archetype
 * registry and the build-time checks. What this module adds is the two things a
 * *generator*, and the search built on it, need from one:
 *
 * - **Resolution.** A plan names cards; an environment decides which cards
 *   exist. `resolvePlan` is where those two meet, and it refuses rather than
 *   trims: a plan whose engine the environment bans is not a smaller plan, it is
 *   a plan that no longer describes anything, and seeding a population from it
 *   would produce decks labelled with an archetype they cannot express.
 *
 * - **Conformance.** `conformanceOf` answers "how much of this plan is still in
 *   this deck" for a deck the search has been mutating for twenty generations.
 *   A package is intact only when *every* one of its cards is present, because a
 *   package that counted as half-present would let mutation dismantle an engine
 *   one card at a time and still report it protected.
 *
 * Nothing here constrains legality. A deck that ignores its plan completely is
 * still a legal deck, and `checkDeck` remains the only authority on that.
 */

export interface ResolvedPackage {
  readonly definition: DeckPlanPackage;
  /** The package's cards, in stable ID order. Always the full list or nothing. */
  readonly cardIds: readonly CardId[];
}

export interface ResolvedPlan {
  readonly plan: DeckPlan;
  readonly archetypeId: ArchetypeId;
  readonly commanderId: CardId;
  /** Packages in declared order: core first is the plan's business, not ours. */
  readonly packages: readonly ResolvedPackage[];
  /** Every card any package names, deduplicated and sorted. */
  readonly cardIds: readonly CardId[];
}

export class PlanResolutionError extends Error {
  /**
   * Declared and assigned rather than written as a constructor parameter
   * property: worker threads run this module through Node's strip-only
   * TypeScript loader, which rejects parameter properties outright.
   */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlanResolutionError';
    this.code = code;
  }
}

/**
 * Resolves a plan ID against an environment, or refuses.
 *
 * Every failure throws for the same reason a named precon does (M03.3): a run
 * configured against a *named* plan must run that plan or not run. Quietly
 * dropping the two cards the environment banned would leave the report claiming
 * an archetype the population never had.
 */
export function resolvePlan(planId: string, environment: GenerationEnvironment): ResolvedPlan {
  const plan = bundledDeckPlan(planId);
  if (!plan) {
    const published = deckPlansForFormat(environment.deckFormat.formatId).map((entry) => entry.id);
    throw new PlanResolutionError(
      'sim/unknown_deck_plan',
      `No deck plan has ID "${planId}". Plans published for ` +
        `"${environment.deckFormat.formatId}": ${published.join(', ') || 'none'}.`,
    );
  }

  if (plan.formatId !== environment.deckFormat.formatId) {
    throw new PlanResolutionError(
      'sim/deck_plan_format_mismatch',
      `Deck plan "${plan.id}" is built to format "${plan.formatId}", but environment ` +
        `"${environment.id}" constructs decks under "${environment.deckFormat.formatId}".`,
    );
  }

  if (!environment.commanders.some((card) => card.id === plan.commanderId)) {
    throw new PlanResolutionError(
      'sim/deck_plan_commander_out_of_pool',
      `Deck plan "${plan.id}" names Commander "${plan.commanderId}", which environment ` +
        `"${environment.id}" does not offer.`,
    );
  }

  const pool = new Set(environment.pool.map((card) => card.id));
  const missing = planCardIds(plan).filter((cardId) => !pool.has(cardId));
  if (missing.length > 0) {
    throw new PlanResolutionError(
      'sim/deck_plan_card_out_of_pool',
      `Deck plan "${plan.id}" packages ${missing.join(', ')}, which environment ` +
        `"${environment.id}" does not contain. A plan is resolved whole or not at all: ` +
        'fix the environment’s pool or bans rather than running a partial plan.',
    );
  }

  return {
    plan,
    archetypeId: plan.archetypeId,
    commanderId: plan.commanderId,
    packages: plan.packages.map((definition) => ({
      definition,
      cardIds: [...definition.cardIds].sort((left, right) => left.localeCompare(right)),
    })),
    cardIds: planCardIds(plan),
  };
}

/** The plan describing a shipped precon, resolved against this environment. */
export function resolvePlanForPrecon(
  preconId: string,
  environment: GenerationEnvironment,
): ResolvedPlan | null {
  const plan = deckPlanForPrecon(preconId);
  if (!plan) return null;
  return resolvePlan(plan.id, environment);
}

/** Packages a policy is allowed to protect or replace: the ones marked core. */
export function corePackages(resolved: ResolvedPlan): readonly ResolvedPackage[] {
  return resolved.packages.filter((entry) => entry.definition.core);
}

export function isPackageIntact(deck: SimDeck, group: ResolvedPackage): boolean {
  const present = new Set(deck.cards.map((entry) => entry.cardId));
  return group.cardIds.every((cardId) => present.has(cardId));
}

/**
 * How much of a plan a deck still expresses.
 *
 * `kind` is supplied rather than derived: whether a deck was *hand-authored*,
 * *plan-generated* or *unconstrained* is a fact about where it came from, and no
 * amount of inspecting its 40 cards can recover it. A hand-authored precon that
 * happens to contain every package of a plan is not plan-generated, and calling
 * it that would let a report credit the generator with a human's deck.
 */
export function conformanceOf(
  deck: SimDeck,
  resolved: ResolvedPlan | null,
  kind: DeckConstruction['kind'],
): DeckConstruction {
  if (!resolved) {
    return {
      kind,
      planId: null,
      archetypeId: null,
      packagesIntact: [],
      packagesBroken: [],
      offPlanCards: deck.cards.reduce((sum, entry) => sum + entry.quantity, 0),
    };
  }

  const intact: string[] = [];
  const broken: string[] = [];
  for (const group of resolved.packages) {
    (isPackageIntact(deck, group) ? intact : broken).push(group.definition.id);
  }

  const planned = new Set(resolved.cardIds);
  const offPlan = deck.cards
    .filter((entry) => !planned.has(entry.cardId))
    .reduce((sum, entry) => sum + entry.quantity, 0);

  return {
    kind,
    planId: resolved.plan.id,
    archetypeId: resolved.archetypeId,
    packagesIntact: intact,
    packagesBroken: broken,
    offPlanCards: offPlan,
    // A deck with no card outside its plan would mean the search had nowhere to
    // explore. `MAX_PLAN_SHARE` makes that impossible by construction, and this
    // is the assertion that the impossible stayed impossible.
  };
}

/** The registry's own sentence for an archetype, for the report. */
export function describeArchetype(archetypeId: ArchetypeId): string {
  return ARCHETYPE_REGISTRY[archetypeId].summary;
}

export function archetypeLabel(archetypeId: ArchetypeId): string {
  return ARCHETYPE_REGISTRY[archetypeId].label;
}
