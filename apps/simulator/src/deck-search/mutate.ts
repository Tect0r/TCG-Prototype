import { isColorIdentityLegal, type CardDefinition, type CardId } from '@tcg/card-data';
import { nextInt, type RngState } from '@tcg/rules-engine';
import type { Environment } from '../environment.js';
import { rngFor } from '../seed.js';
import { checkDeck, makeDeck, type SimDeck } from './deck.js';
import { poolFor } from './generate.js';

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
 * Swaps `strength` cards for other legal ones.
 *
 * Deck size is preserved exactly: each removal is matched by an addition, so a
 * mutation can never drift the deck out of the format.
 */
export function mutateDeck(
  base: SimDeck,
  environment: Environment,
  seed: string,
  options: { readonly strength: number; readonly generation: number },
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

  for (let step = 0; step < options.strength; step += 1) {
    const present = [...counts.keys()].sort();
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

  const mutated = makeDeck({
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

  const child = makeDeck({
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
