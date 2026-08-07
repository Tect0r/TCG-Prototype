import type { CardDefinition } from './schema/card.js';
import { DECKABLE_CARD_TYPES, type CardId, type CardType } from './schema/primitives.js';
import { compareCards, matchesQuery, type CardQuery } from './query.js';

/**
 * Immutable, validated view over every known card. Shared by the deck builder,
 * and later by the rules engine, server and simulator.
 */
export class CardDatabase {
  readonly #byId: ReadonlyMap<CardId, CardDefinition>;
  readonly #all: readonly CardDefinition[];

  constructor(cards: readonly CardDefinition[]) {
    const sorted = [...cards].sort(compareCards);
    this.#all = Object.freeze(sorted);
    this.#byId = new Map(sorted.map((card) => [card.id, card]));
  }

  get size(): number {
    return this.#all.length;
  }

  all(): readonly CardDefinition[] {
    return this.#all;
  }

  get(id: CardId): CardDefinition | undefined {
    return this.#byId.get(id);
  }

  has(id: CardId): boolean {
    return this.#byId.has(id);
  }

  /** Throws — only for call sites that have already validated the ID. */
  getOrThrow(id: CardId): CardDefinition {
    const card = this.#byId.get(id);
    if (!card) throw new Error(`Unknown card ID "${id}"`);
    return card;
  }

  ofType(type: CardType): readonly CardDefinition[] {
    return this.#all.filter((card) => card.type === type);
  }

  /** Commanders available to choose in the deck builder. */
  commanders(): readonly CardDefinition[] {
    return this.#all.filter((card) => card.type === 'commander' && card.collectible);
  }

  /** Cards that may appear in a deck list. Excludes Commanders and tokens. */
  deckable(): readonly CardDefinition[] {
    return this.#all.filter((card) => card.collectible && DECKABLE_CARD_TYPES.includes(card.type));
  }

  search(query: CardQuery, pool: readonly CardDefinition[] = this.#all): readonly CardDefinition[] {
    return pool.filter((card) => matchesQuery(card, query));
  }

  /** Every tag used by any card, sorted, for building filter controls. */
  allTags(): readonly string[] {
    return [...new Set(this.#all.flatMap((card) => card.tags))].sort();
  }

  /** Highest energy cost in the database, for cost slider bounds. */
  maxCost(): number {
    return this.#all.reduce((max, card) => Math.max(max, card.cost ?? 0), 0);
  }
}
