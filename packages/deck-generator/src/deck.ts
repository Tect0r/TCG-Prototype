import { z } from 'zod';
import { cardIdSchema, type CardId } from '@tcg/card-data';
import {
  DECK_SCHEMA_VERSION,
  deckEntrySchema,
  validateDeck,
  type DeckValidationReport,
  type SavedDeck,
} from '@tcg/deck';
import type { MatchDeck } from '@tcg/rules-engine';
import { error, hasErrors, type Issue } from '@tcg/shared';
import type { GenerationEnvironment } from './environment.js';
import { deckHash } from './hash.js';

/**
 * A constructed deck, as the generator and the search hand it around.
 *
 * Identical in content to a `SavedDeck` minus the parts that are about a human
 * saving a file — timestamps and a display name are not experimental inputs, and
 * including them would make two identical decks hash differently. Conversion in
 * both directions is exact, so `validateDeck` stays the single authority on
 * legality (CLAUDE.md §13.8).
 *
 * The name `SimDeck` is older than the package and is kept on purpose (M09.8):
 * it is what recorded search checkpoints, reports and every existing test cite,
 * and renaming it would be a two-hundred-site change that alters no output.
 * What moved in M09.8 is where the type lives, not what it means.
 */

/**
 * How a deck came to exist (M05.5).
 *
 * Three kinds, and the report keeps them apart because they support different
 * claims:
 *
 * - `hand_authored` — a person wrote the list. A precon, an inline deck, a
 *   deck-builder export. The only kind a designer's intent is evidence about.
 * - `plan_generated` — the generator seeded it from an authored deck plan, so
 *   its engine and payoff are coherent by construction rather than by luck.
 * - `unconstrained` — the generator drew it from the legal pool with nothing but
 *   a curve and a role weighting. Legal, and about as strategically coherent as
 *   a random 40 cards.
 *
 * The kind is *recorded*, never inferred: no amount of inspecting a decklist
 * recovers where it came from, and a random deck that happens to contain a whole
 * package is still a random deck.
 */
export const DECK_CONSTRUCTION_KINDS = [
  'hand_authored',
  'plan_generated',
  'unconstrained',
] as const;
export const deckConstructionKindSchema = z.enum(DECK_CONSTRUCTION_KINDS);
export type DeckConstructionKind = z.infer<typeof deckConstructionKindSchema>;

export const deckConstructionSchema = z.strictObject({
  kind: deckConstructionKindSchema.default('unconstrained'),
  /** The plan this deck was built to or is measured against. */
  planId: z.string().nullable().default(null),
  archetypeId: z.string().nullable().default(null),
  /** Packages every one of whose cards is still present. */
  packagesIntact: z.array(z.string()).default([]),
  /** Packages the deck has some of but not all of. */
  packagesBroken: z.array(z.string()).default([]),
  /**
   * Cards the plan does not name. Never zero for a plan-generated deck: the
   * plan schema caps a plan below the deck size precisely so the search always
   * has slots it owns.
   */
  offPlanCards: z.number().int().min(0).default(0),
});
export type DeckConstruction = z.infer<typeof deckConstructionSchema>;

export const simDeckSchema = z.strictObject({
  /** Stable, content-derived unless the experiment supplied its own. */
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(80),
  commanderId: cardIdSchema,
  cards: z.array(deckEntrySchema),
  /** Canonical hash: entry-order independent, quantity and Commander sensitive. */
  hash: z.string().min(1),
  /** Where the deck came from, for lineage in a search run. */
  origin: z
    .strictObject({
      kind: z.enum(['seed', 'random', 'stratified', 'mutation', 'crossover', 'replacement']),
      parentHashes: z.array(z.string()).default([]),
      generation: z.number().int().min(0).default(0),
      /** What the mutation actually changed, for auditable lineage. */
      changes: z.array(z.string()).default([]),
      mutationSeed: z.string().default(''),
    })
    .prefault({ kind: 'seed' }),
  /**
   * How the deck was constructed, and how much of its plan it still holds.
   *
   * Outside the hash on purpose: two decks with identical cards are the same
   * deck to the engine and to every replay, whoever built them. This is
   * provenance, which is why it is recorded beside `origin` rather than folded
   * into it — `origin` says which *operator* produced this deck from which
   * parents, and this says what the deck is *for*.
   */
  construction: deckConstructionSchema.prefault({}),
});
export type SimDeck = z.infer<typeof simDeckSchema>;
export type SimDeckInput = z.input<typeof simDeckSchema>;

const EPOCH = '2026-01-01T00:00:00.000Z';

/** Builds a deck, computing its canonical hash and defaulting its ID from it. */
export function makeDeck(input: {
  readonly commanderId: CardId;
  readonly cards: readonly { readonly cardId: CardId; readonly quantity: number }[];
  readonly id?: string;
  readonly label?: string;
  readonly origin?: SimDeckInput['origin'];
  readonly construction?: SimDeckInput['construction'];
}): SimDeck {
  const cards = normalizeEntries(input.cards);
  const hash = deckHash({ commanderId: input.commanderId, cards });
  return simDeckSchema.parse({
    id: input.id ?? `d_${hash}`,
    label: input.label ?? input.id ?? `deck ${hash.slice(0, 8)}`,
    commanderId: input.commanderId,
    cards,
    hash,
    origin: input.origin ?? { kind: 'seed' },
    // Defaulted rather than required, and defaulted to `unconstrained` rather
    // than to something flattering: a caller that has not said where its deck
    // came from has not earned a stronger label than "legal cards".
    construction: input.construction ?? {},
  });
}

/** Merges duplicate entries, drops empties, and sorts by card ID. */
export function normalizeEntries(
  entries: readonly { readonly cardId: CardId; readonly quantity: number }[],
): { cardId: CardId; quantity: number }[] {
  const counts = new Map<CardId, number>();
  for (const entry of entries) {
    counts.set(entry.cardId, (counts.get(entry.cardId) ?? 0) + entry.quantity);
  }
  return [...counts]
    .filter(([, quantity]) => quantity > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cardId, quantity]) => ({ cardId, quantity }));
}

export function deckSize(deck: SimDeck): number {
  return deck.cards.reduce((sum, entry) => sum + entry.quantity, 0);
}

export function toSavedDeck(deck: SimDeck): SavedDeck {
  return {
    schemaVersion: DECK_SCHEMA_VERSION,
    id: deck.id,
    name: deck.label,
    commanderId: deck.commanderId,
    cards: deck.cards.map((entry) => ({ ...entry })),
    createdAt: EPOCH,
    updatedAt: EPOCH,
  };
}

export function toMatchDeck(deck: SimDeck): MatchDeck {
  return { commanderId: deck.commanderId, cards: deck.cards.map((entry) => ({ ...entry })) };
}

export function fromSavedDeck(
  saved: SavedDeck,
  construction?: SimDeckInput['construction'],
): SimDeck {
  if (saved.commanderId === null) {
    throw new Error(`Deck "${saved.id}" has no Commander and cannot be simulated.`);
  }
  return makeDeck({
    commanderId: saved.commanderId,
    cards: saved.cards,
    id: saved.id,
    label: saved.name,
    ...(construction === undefined ? {} : { construction }),
  });
}

/**
 * Re-stamps a deck's construction without touching its identity.
 *
 * Used after a mutation: the deck's cards moved, so how much of its plan it
 * still holds moved with them, but its hash, ID and lineage are unchanged and
 * must not be recomputed from a different set of inputs.
 */
export function withConstruction(deck: SimDeck, construction: DeckConstruction): SimDeck {
  return { ...deck, construction };
}

export interface DeckLegality {
  readonly legal: boolean;
  readonly report: DeckValidationReport;
  /** Structured diagnostics. An illegal deck is never quietly repaired. */
  readonly issues: readonly Issue[];
}

/**
 * Legality through `validateDeck` — the same check the deck builder and the
 * multiplayer server run — plus the environment's ban and allow lists.
 */
export function checkDeck(deck: SimDeck, environment: GenerationEnvironment): DeckLegality {
  const report = validateDeck(toSavedDeck(deck), environment.database, environment.deckFormat);
  const issues: Issue[] = [...report.issues];

  const permitted = new Set(environment.pool.map((card) => card.id));
  for (const entry of deck.cards) {
    if (permitted.has(entry.cardId)) continue;
    issues.push(
      error(
        'sim/card_out_of_pool',
        `"${entry.cardId}" is not in environment "${environment.id}"’s card pool.`,
        { context: { cardId: entry.cardId, environmentId: environment.id } },
      ),
    );
  }
  if (!environment.commanders.some((card) => card.id === deck.commanderId)) {
    issues.push(
      error(
        'sim/commander_out_of_pool',
        `Commander "${deck.commanderId}" is not in environment "${environment.id}"’s pool.`,
        { context: { cardId: deck.commanderId, environmentId: environment.id } },
      ),
    );
  }

  return { legal: !hasErrors(issues), report, issues };
}
