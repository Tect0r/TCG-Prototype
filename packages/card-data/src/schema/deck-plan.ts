import { z } from 'zod';
import { cardIdSchema } from './primitives.js';
import { formatIdSchema } from './format.js';
import { preconIdSchema } from './precon.js';

/**
 * Deck plans — what a deck is *made of*, as packages rather than as 40 cards
 * (M05.5).
 *
 * A precon is a list. A plan is the same list with its joints marked: which
 * cards are the engine, which are the payoff that engine exists to feed, which
 * are the interaction that buys it time. That distinction is what lets deck
 * generation seed something coherent instead of a legal pile, and what lets
 * mutation say "protect this" or "replace this" about a group of cards that only
 * mean anything together.
 *
 * Three rules keep a plan honest:
 *
 * - A plan is **content**, like a precon: it lives in `content/deck-plans/`, is
 *   compiled into the shipped bundle, and its card references are checked
 *   against the format pool by the content build rather than at run time.
 * - A plan **describes** a deck; it never constructs one on its own. Nothing
 *   here is a decklist: packages may overlap the format's deck size in neither
 *   direction, because a plan deliberately leaves room. The one thing a plan
 *   may not do is fill a deck completely — see `maxPlanShare` below.
 * - A plan is **not a rule**. The engine never reads one, no card behaviour
 *   depends on one, and a deck that ignores its plan entirely is still legal.
 *   A plan constrains a *search*, and the search is always allowed to leave it.
 */
export const DECK_PLAN_SCHEMA_VERSION = 1;

/** A plan's permanent ID. Same shape as a precon's, and a separate namespace. */
export const deckPlanIdSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9_]*$/, 'Deck plan IDs must be lowercase_snake_case.');

/**
 * The archetype vocabulary.
 *
 * Lives beside the schema rather than in the registry so that the registry can
 * be a total `Record` read *off* this list — the same arrangement the mechanic
 * support and agent class registries use, and the reason adding an archetype
 * without describing it is a compile error. The descriptions, the roles a plan
 * for each archetype must supply, and the version are in `src/archetype.ts`.
 *
 * These are strategies, not decks. `token_swarm` is not "the Goblin precon": it
 * is the plan that precon is one expression of, and a searched deck can reach
 * the same archetype from a different Commander.
 */
export const ARCHETYPE_IDS = [
  'token_swarm',
  'defensive_attrition',
  'sacrifice_value',
  'reactive_control',
] as const;
export const archetypeIdSchema = z.enum(ARCHETYPE_IDS);
export type ArchetypeId = z.infer<typeof archetypeIdSchema>;

/**
 * What a package is *for*.
 *
 * A closed vocabulary, because mutation reasons about roles: "replace the
 * engine" has to mean something to code that has never read this particular
 * plan. These are deliberately about the package's job in the deck and not
 * about a card's printed type — a Relic, a Unit and a Spell can all be engine.
 *
 * Each role is derivable from the authored `role` and `design.identity` a card
 * already carries, which is where the shipped plans' memberships came from;
 * nothing here is a second opinion about what a card does.
 */
export const PACKAGE_ROLES = [
  /** Produces the recurring resource the deck is built around. */
  'engine',
  /** Converts the engine's output into damage, advantage or a win. */
  'payoff',
  /** Removal, counters and disruption aimed at the opponent. */
  'interaction',
  /** Blockers and protection that buy the plan the time it needs. */
  'defense',
  /** Filtering, selection and recovery that make the plan repeatable. */
  'consistency',
  /** Plain bodies that fill the cost curve and nothing more. */
  'curve',
] as const;
export const packageRoleSchema = z.enum(PACKAGE_ROLES);
export type PackageRole = z.infer<typeof packageRoleSchema>;

/**
 * One package: cards that are worth more together than apart.
 *
 * `cardIds` is a set, not a decklist — quantities live in the format's copy
 * limit, and Wave 1 is singleton, so a package is present exactly when every one
 * of its cards is present. That all-or-nothing reading is the point: a "package"
 * that counts as half-present would let mutation dismantle an engine one card at
 * a time and still report it protected.
 */
export const deckPlanPackageSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, 'Package IDs must be lowercase_snake_case.'),
  label: z.string().min(1).max(80),
  role: packageRoleSchema,
  /** One line on why these cards belong together. Presentation only. */
  rationale: z.string().min(1).max(400),
  /**
   * Does the archetype stop being itself without this package?
   *
   * `core: true` is what `protect` protects and what `replace` is allowed to
   * take out — the two are the same set on purpose, because the interesting
   * question a search can ask about a plan is what happens without its core.
   */
  core: z.boolean().default(false),
  cardIds: z.array(cardIdSchema).min(2).max(20),
});
export type DeckPlanPackage = z.infer<typeof deckPlanPackageSchema>;

/**
 * The share of a deck a plan's packages may occupy, as a hard ceiling.
 *
 * The milestone requires that "search must remain able to explore outside
 * plans", and a plan that could fill 40 of 40 slots would make that a matter of
 * configuration rather than a property of the data. So it is pinned here: the
 * content build refuses a plan whose packages cover more than this share of the
 * format's deck size, which means every plan-generated deck has free slots by
 * construction and no generator setting can take them away.
 */
export const MAX_PLAN_SHARE = 0.75;

export const deckPlanSchema = z.strictObject({
  schemaVersion: z.number().int().min(1).max(DECK_PLAN_SCHEMA_VERSION),
  id: deckPlanIdSchema,
  name: z.string().min(1).max(80),
  /** The archetype this plan is one expression of. */
  archetypeId: archetypeIdSchema,
  /** The format whose construction rules the plan's cards are legal under. */
  formatId: formatIdSchema,
  commanderId: cardIdSchema,
  /**
   * The shipped precon this plan describes, when it describes one.
   *
   * Optional because a plan is not required to have a precon — a plan authored
   * for a strategy nobody shipped a deck for is a legitimate search seed. When
   * it *is* set, the content build requires the plan's cards to be a subset of
   * that precon's list, so "this is the plan of that deck" is checkable rather
   * than asserted.
   */
  preconId: preconIdSchema.optional(),
  /** One line on what the plan is trying to do. Presentation only. */
  summary: z.string().min(1).max(400),
  packages: z.array(deckPlanPackageSchema).min(2).max(12),
});
export type DeckPlan = z.infer<typeof deckPlanSchema>;

/** Every card named by any package, deduplicated, in stable ID order. */
export function planCardIds(plan: DeckPlan): string[] {
  return [...new Set(plan.packages.flatMap((entry) => entry.cardIds))].sort((left, right) =>
    left.localeCompare(right),
  );
}

/** How many deck slots a plan's packages ask for. Singleton, so one per card. */
export function planSlotCount(plan: DeckPlan): number {
  return planCardIds(plan).length;
}
