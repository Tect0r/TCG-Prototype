import { isColorIdentityLegal, type CardDefinition, type CardId } from '@tcg/card-data';
import { nextInt, type RngState } from '@tcg/rules-engine';
import {
  checkDeck,
  conformanceOf,
  corePackages,
  isPackageIntact,
  makeDeck,
  poolFor,
  withConstruction,
  type ResolvedPlan,
  type SimDeck,
} from '@tcg/deck-generator';
import type { Environment } from '../environment.js';
import { rngFor } from '../seed.js';

/**
 * Legal mutation and crossover (CLAUDE.md §13.9).
 *
 * Every operator here produces a deck that `validateDeck` accepts, or produces
 * nothing. And every produced deck records what changed, which parents it came
 * from, which generation it belongs to and which seed drove the change — lineage
 * is not optional, because "the search found this" is only useful if you can see
 * how it got there.
 */

export interface MutationResult {
  readonly deck: SimDeck | null;
  readonly reasons: readonly string[];
}

/**
 * What a mutation is allowed to do to a deck plan's packages (M05.5).
 *
 * - `none` — the default and the historical behaviour. Cards are swapped one at
 *   a time with no idea that any of them belong together. **This is what keeps
 *   the search able to explore outside plans**, and it is the default precisely
 *   so that adding plans to this build did not narrow what a search may find.
 * - `protect` — a card belonging to an intact **core** package is never chosen
 *   for removal. The deck keeps its identity and the search varies everything
 *   else; the non-core packages and the plan's free slots stay fully mutable,
 *   which is why this constrains rather than freezes.
 * - `replace` — the opposite question. One whole intact core package is removed
 *   and the freed slots are refilled from the legal pool, so the search can ask
 *   what this deck is without its engine. The replacements are drawn from the
 *   *pool*, not from the plan: a plan-shaped mutation that could only produce
 *   plan cards would be a plan, not a search.
 *
 * Both non-default modes need a resolved plan; without one they degrade to
 * `none` and say so, rather than pretending to protect something.
 */
export const PACKAGE_POLICIES = ['none', 'protect', 'replace'] as const;
export type PackagePolicy = (typeof PACKAGE_POLICIES)[number];

export interface MutationOptions {
  readonly strength: number;
  readonly generation: number;
  /** The plan this deck is measured against. `null` outside a planned search. */
  readonly plan?: ResolvedPlan | null;
  readonly packagePolicy?: PackagePolicy;
}

/**
 * Swaps `strength` cards for other legal ones.
 *
 * Deck size is preserved exactly: each removal is matched by an addition, so a
 * mutation can never drift the deck out of the format. That holds for the
 * whole-package replacement too — `n` cards out, `n` cards in.
 */
export function mutateDeck(
  base: SimDeck,
  environment: Environment,
  seed: string,
  options: MutationOptions,
): MutationResult {
  const commander = environment.database.get(base.commanderId);
  if (!commander) return { deck: null, reasons: [`unknown Commander ${base.commanderId}`] };

  const pool = poolFor(environment, commander);
  if (pool.length === 0) return { deck: null, reasons: ['no legal cards for this Commander'] };

  let rng = rngFor(seed);
  const pick = <T>(items: readonly T[]): T => {
    const roll = nextInt(rng, items.length);
    rng = roll.state;
    return items[roll.value] as T;
  };

  const counts = new Map<CardId, number>(base.cards.map((entry) => [entry.cardId, entry.quantity]));
  const changes: string[] = [];
  const limitOf = (card: CardDefinition): number =>
    card.unique ? environment.deckFormat.uniqueCopyLimit : environment.deckFormat.copyLimit;

  const plan = options.plan ?? null;
  const policy: PackagePolicy = plan ? (options.packagePolicy ?? 'none') : 'none';
  const intactCore = plan ? corePackages(plan).filter((group) => isPackageIntact(base, group)) : [];

  // Cards a `protect` policy will not remove. Empty under every other policy,
  // which is what makes `none` byte-identical to the pre-M05.5 operator.
  const protectedCards = new Set<CardId>(
    policy === 'protect' ? intactCore.flatMap((group) => group.cardIds) : [],
  );

  // `replace` spends its first step on a whole package, then mutates normally.
  // Doing it first matters: the freed slots are then part of the ordinary swap
  // budget, so a replacement is one macro-move and not a second deck.
  let steps = options.strength;
  if (policy === 'replace') {
    if (intactCore.length === 0) {
      return { deck: null, reasons: ['no intact core package was available to replace'] };
    }
    const group = pick(
      [...intactCore].sort((left, right) => left.definition.id.localeCompare(right.definition.id)),
    );
    for (const cardId of group.cardIds) counts.delete(cardId);

    let refilled = 0;
    for (
      let attempt = 0;
      refilled < group.cardIds.length && attempt < pool.length * 4;
      attempt += 1
    ) {
      const addable = pool.filter(
        (card) => (counts.get(card.id) ?? 0) < limitOf(card) && !group.cardIds.includes(card.id),
      );
      if (addable.length === 0) break;
      const added = pick(addable);
      counts.set(added.id, (counts.get(added.id) ?? 0) + 1);
      refilled += 1;
    }
    if (refilled < group.cardIds.length) {
      return {
        deck: null,
        reasons: [
          `replacing package "${group.definition.id}" left the deck ` +
            `${group.cardIds.length - refilled} card(s) short of legal size`,
        ],
      };
    }
    changes.push(`-package ${group.definition.id} (${group.cardIds.length} cards)`);
    steps = Math.max(0, steps - 1);
  }

  for (let step = 0; step < steps; step += 1) {
    const present = [...counts.keys()].filter((cardId) => !protectedCards.has(cardId)).sort();
    if (present.length === 0) break;
    const removeId = pick(present);
    const remaining = (counts.get(removeId) ?? 0) - 1;
    if (remaining <= 0) counts.delete(removeId);
    else counts.set(removeId, remaining);

    const addable = pool.filter((card) => (counts.get(card.id) ?? 0) < limitOf(card));
    if (addable.length === 0) {
      // Put it back rather than shrink the deck.
      counts.set(removeId, (counts.get(removeId) ?? 0) + 1);
      break;
    }
    const added = pick(addable);
    counts.set(added.id, (counts.get(added.id) ?? 0) + 1);
    // Drawing the card that was just removed is a legal outcome of the roll, but
    // it is not an edit. Recording it would put a swap in the lineage that never
    // happened, and would let a mutation "succeed" without changing the deck.
    if (added.id !== removeId) changes.push(`-1 ${removeId} +1 ${added.id}`);
  }

  if (changes.length === 0) return { deck: null, reasons: ['no legal swap was available'] };

  const drafted = makeDeck({
    commanderId: base.commanderId,
    cards: [...counts].map(([cardId, quantity]) => ({ cardId, quantity })),
    label: `${base.label} m${options.generation}`,
    origin: {
      kind: 'mutation',
      parentHashes: [base.hash],
      generation: options.generation,
      changes,
      mutationSeed: seed,
    },
  });

  const mutated = withInheritedConstruction(drafted, base, plan);

  // Several swaps can compose back to the starting deck. That is a failed
  // mutation, not a new candidate: returning it would put a duplicate into the
  // population and credit it with a lineage it does not have.
  if (mutated.hash === base.hash) {
    return { deck: null, reasons: ['the swaps cancelled out and reproduced the parent'] };
  }

  const legality = checkDeck(mutated, environment);
  if (!legality.legal) {
    return {
      deck: null,
      reasons: legality.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message),
    };
  }
  return { deck: mutated, reasons: [] };
}

/**
 * Combines two decks that share a Commander colour identity.
 *
 * Crossover is only attempted when it can stay legal *and* produce something
 * neither parent already is; otherwise it returns nothing rather than quietly
 * degrading into a copy of one parent (CLAUDE.md §13.9 step 5).
 */
export function crossoverDecks(
  left: SimDeck,
  right: SimDeck,
  environment: Environment,
  seed: string,
  generation: number,
  plan: ResolvedPlan | null = null,
): MutationResult {
  const commander = environment.database.get(left.commanderId);
  if (!commander) return { deck: null, reasons: ['unknown Commander'] };

  const rightCommander = environment.database.get(right.commanderId);
  if (!rightCommander) return { deck: null, reasons: ['unknown Commander'] };

  // The child keeps the left parent's Commander, so every card it inherits from
  // the right parent has to be legal under it.
  const inheritable = right.cards.filter((entry) => {
    const card = environment.database.get(entry.cardId);
    return card ? isColorIdentityLegal(card.colorIdentity, commander.colorIdentity) : false;
  });
  if (inheritable.length === 0) {
    return {
      deck: null,
      reasons: ['no card of the second parent is legal under the first Commander'],
    };
  }

  let rng = rngFor(seed);
  const counts = new Map<CardId, number>(left.cards.map((entry) => [entry.cardId, entry.quantity]));
  const limitOf = (cardId: CardId): number =>
    environment.database.get(cardId)?.unique
      ? environment.deckFormat.uniqueCopyLimit
      : environment.deckFormat.copyLimit;

  const changes: string[] = [];
  const swaps = Math.max(1, Math.floor(environment.deckFormat.deckSize / 6));

  for (let step = 0; step < swaps; step += 1) {
    const donorRoll = nextInt(rng, inheritable.length);
    rng = donorRoll.state;
    const donor = inheritable[donorRoll.value];
    if (!donor) break;
    if ((counts.get(donor.cardId) ?? 0) >= limitOf(donor.cardId)) continue;

    const present = [...counts.keys()].filter((cardId) => cardId !== donor.cardId).sort();
    if (present.length === 0) break;
    const removeRoll = nextInt(rng, present.length);
    rng = removeRoll.state;
    const removeId = present[removeRoll.value] as CardId;

    const remaining = (counts.get(removeId) ?? 0) - 1;
    if (remaining <= 0) counts.delete(removeId);
    else counts.set(removeId, remaining);
    counts.set(donor.cardId, (counts.get(donor.cardId) ?? 0) + 1);
    changes.push(`-1 ${removeId} +1 ${donor.cardId}`);
  }

  if (changes.length === 0) return { deck: null, reasons: ['crossover produced no legal change'] };

  const drafted = makeDeck({
    commanderId: left.commanderId,
    cards: [...counts].map(([cardId, quantity]) => ({ cardId, quantity })),
    label: `${left.label} x ${right.label} g${generation}`,
    origin: {
      kind: 'crossover',
      parentHashes: [left.hash, right.hash],
      generation,
      changes,
      mutationSeed: seed,
    },
  });

  // The child keeps the *left* parent's Commander, so it keeps the left parent's
  // construction kind too — that is the parent it is a variation of.
  const child = withInheritedConstruction(drafted, left, plan);

  if (child.hash === left.hash || child.hash === right.hash) {
    return { deck: null, reasons: ['crossover reproduced a parent exactly'] };
  }

  const legality = checkDeck(child, environment);
  if (!legality.legal) {
    return {
      deck: null,
      reasons: legality.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message),
    };
  }
  return { deck: child, reasons: [] };
}

/**
 * Carries a parent's construction onto a child, re-measured (M05.5).
 *
 * The *kind* is inherited: a plan-generated deck stays plan-generated however
 * far the search drags it, because that is a fact about where it came from and
 * a fresh set of cards cannot change it. Losing every package is a finding for
 * the report, not a reason to relabel the deck as something it never was.
 *
 * The package readings are re-measured when a plan is available and **cleared**
 * when one is not, because they describe cards and the cards just moved.
 * Carrying stale ones forward would let a report claim an engine that a search
 * dismantled ten generations ago.
 */
function withInheritedConstruction(
  child: SimDeck,
  parent: SimDeck,
  plan: ResolvedPlan | null,
): SimDeck {
  if (plan) return withConstruction(child, conformanceOf(child, plan, parent.construction.kind));
  return withConstruction(child, {
    ...parent.construction,
    packagesIntact: [],
    packagesBroken: [],
    offPlanCards: 0,
  });
}

/** Card-count distance between two decks: how many single-card swaps apart they are. */
export function deckDistance(left: SimDeck, right: SimDeck): number {
  const counts = new Map<CardId, number>();
  for (const entry of left.cards) counts.set(entry.cardId, entry.quantity);
  for (const entry of right.cards) {
    counts.set(entry.cardId, (counts.get(entry.cardId) ?? 0) - entry.quantity);
  }
  let distance = 0;
  for (const delta of counts.values()) distance += Math.abs(delta);
  if (left.commanderId !== right.commanderId) distance += 4;
  return distance / 2;
}

export type { RngState };
