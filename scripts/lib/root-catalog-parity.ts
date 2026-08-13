/**
 * Root catalogue parity — the measurement behind Q40 (M07.6).
 *
 * The repository root still holds `cards.json` and `precons.json`: the authored
 * Wave 1 design catalogue the generated content under `content/` was imported
 * from. Generated `content/` is authoritative — it is what the loader, the
 * server, the deck builder and the simulator read, and nothing in the codebase
 * opens either root file — so the only question the root pair raises is whether
 * keeping a second, silent copy of every card's text is worth anything.
 *
 * That question cannot be answered by remembering that the import was faithful.
 * This module re-derives it: it reads the two root catalogues, reads the shipped
 * content through the same loader the product uses, and compares them field by
 * field, in both directions. A field that is genuinely presented differently in
 * the two representations is mapped explicitly below rather than skipped, so
 * "they agree" means the design record and the runtime content say the same
 * thing about every card — not that the comparison avoided the places they
 * could differ.
 *
 * Nothing here decides anything. It produces a report; `docs/open-questions.md`
 * Q40 records what the report said and puts the deletion to the owner.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';
import {
  BUNDLED_PRECONS,
  bundledFormat,
  cardIdSchema,
  cardTypeSchema,
  colorIdentitySchema,
  keywordIdSchema,
  loadBundledCardData,
  preconIdSchema,
  type CardDefinition,
  type PlayFormat,
  type PreconDefinition,
} from '@tcg/card-data';

/* --------------------------------------------------------------- root files */

/** The two tracked root catalogues, relative to the repository root. */
export const ROOT_CARD_CATALOG = 'cards.json';
export const ROOT_PRECON_CATALOG = 'precons.json';

/**
 * The authored catalogue's card shape.
 *
 * Strict, and parsed rather than cast: a comparison against a file whose shape
 * nobody checks would report "no differences" for a field that had quietly been
 * renamed. `power`, `identity` and `faction` are the designer's labels and live
 * under `design` in a runtime card; `rulesText` is what became `displayText`.
 */
const rootCardSchema = z.strictObject({
  id: cardIdSchema,
  name: z.string().min(1),
  type: cardTypeSchema,
  faction: z.string().min(1).nullable().optional(),
  colorIdentity: colorIdentitySchema,
  power: z.enum(['low', 'medium', 'high']).nullable().optional(),
  identity: z.string().min(1).nullable().optional(),
  cost: z.number().int().nullable(),
  attack: z.number().int().nullable().optional(),
  health: z.number().int().nullable().optional(),
  keywords: z.array(keywordIdSchema).default([]),
  rulesText: z.string().nullable().optional(),
  collectible: z.boolean().default(true),
});
export type RootCard = z.infer<typeof rootCardSchema>;

export const rootCardCatalogSchema = z.object({
  schemaVersion: z.number().int().min(1),
  catalogId: z.string().min(1),
  cards: z.array(rootCardSchema).min(1),
});
export type RootCardCatalog = z.infer<typeof rootCardCatalogSchema>;

const rootPreconSchema = z.strictObject({
  id: preconIdSchema,
  name: z.string().min(1),
  strategy: z.string().min(1),
  commanderId: cardIdSchema,
  cardIds: z.array(cardIdSchema),
});
export type RootPrecon = z.infer<typeof rootPreconSchema>;

export const rootPreconCatalogSchema = z.object({
  schemaVersion: z.number().int().min(1),
  catalogId: z.string().min(1),
  format: z.object({
    deckSize: z.number().int().min(1),
    singleton: z.boolean(),
    commanderOutsideDeck: z.boolean(),
  }),
  precons: z.array(rootPreconSchema).min(1),
});
export type RootPreconCatalog = z.infer<typeof rootPreconCatalogSchema>;

/* ------------------------------------------------------------- comparisons */

/** One field on one subject, as the two sides state it. */
export interface FieldDifference {
  /** The card, precon or format the field belongs to. */
  readonly subject: string;
  readonly field: string;
  readonly root: string;
  readonly content: string;
}

export interface CatalogParity {
  readonly rootCount: number;
  readonly contentCount: number;
  /** IDs the root catalogue has and the shipped content does not. */
  readonly onlyInRoot: readonly string[];
  /** IDs the shipped content has and the root catalogue does not. */
  readonly onlyInContent: readonly string[];
  readonly differences: readonly FieldDifference[];
}

export interface RootCatalogParity {
  /** The set and format the root catalogues claim to describe. */
  readonly catalogId: string;
  readonly cards: CatalogParity;
  readonly precons: CatalogParity;
  /** Fields compared per card, so a reader can see what the verdict covers. */
  readonly comparedCardFields: readonly string[];
  /** True when nothing is missing on either side and no field differs. */
  readonly exact: boolean;
}

/**
 * How a value is written into a difference row.
 *
 * JSON rather than `String(...)` so `null`, `""` and `[]` are distinguishable in
 * a report — the three values most likely to be involved when an import loses
 * something.
 */
function show(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** `undefined` and `null` mean the same absence here; a missing stat is `null`. */
function orNull<T>(value: T | undefined | null): T | null {
  return value ?? null;
}

/**
 * Order-free comparison for the two list fields.
 *
 * A colour identity and a keyword list are sets: `["red","white"]` and
 * `["white","red"]` are the same card. Sorting before comparing keeps the report
 * about content rather than about the order two files happened to be written in.
 */
function sortedList(values: readonly string[] | undefined): readonly string[] {
  return [...(values ?? [])].sort((left, right) => left.localeCompare(right));
}

/**
 * The field map, and the whole of what "parity" means for a card.
 *
 * Written out rather than derived from the schemas, because the two shapes are
 * deliberately different: the authored catalogue is flat, and the runtime card
 * puts the designer's labels under `design` and calls the printed text
 * `displayText`. Every field the authored catalogue carries appears here — a
 * field left out would be a place the two could disagree without the report
 * noticing, which is the one failure this module cannot afford.
 */
const CARD_FIELDS: readonly {
  readonly field: string;
  readonly root: (card: RootCard) => unknown;
  readonly content: (card: CardDefinition) => unknown;
}[] = [
  { field: 'name', root: (card) => card.name, content: (card) => card.name },
  { field: 'type', root: (card) => card.type, content: (card) => card.type },
  {
    field: 'colorIdentity',
    root: (card) => sortedList(card.colorIdentity),
    content: (card) => sortedList(card.colorIdentity),
  },
  { field: 'cost', root: (card) => orNull(card.cost), content: (card) => orNull(card.cost) },
  { field: 'attack', root: (card) => orNull(card.attack), content: (card) => orNull(card.attack) },
  { field: 'health', root: (card) => orNull(card.health), content: (card) => orNull(card.health) },
  {
    field: 'keywords',
    root: (card) => sortedList(card.keywords),
    content: (card) => sortedList(card.keywords),
  },
  {
    field: 'collectible',
    root: (card) => card.collectible,
    content: (card) => card.collectible,
  },
  {
    field: 'faction → design.faction',
    root: (card) => orNull(card.faction),
    content: (card) => orNull(card.design?.faction),
  },
  {
    field: 'identity → design.identity',
    root: (card) => orNull(card.identity),
    content: (card) => orNull(card.design?.identity),
  },
  {
    field: 'power → design.power',
    root: (card) => orNull(card.power),
    content: (card) => orNull(card.design?.power),
  },
  {
    field: 'rulesText → displayText',
    root: (card) => orNull(card.rulesText),
    content: (card) => orNull(card.displayText),
  },
];

export const COMPARED_CARD_FIELDS: readonly string[] = CARD_FIELDS.map((entry) => entry.field);

/** Sorted IDs present in `left` and absent from `right`. */
function missingFrom(left: readonly string[], right: readonly string[]): readonly string[] {
  const known = new Set(right);
  return left.filter((id) => !known.has(id)).sort((a, b) => a.localeCompare(b));
}

export function compareCards(
  rootCards: readonly RootCard[],
  contentCards: readonly CardDefinition[],
): CatalogParity {
  const byId = new Map(contentCards.map((card) => [card.id, card]));
  const differences: FieldDifference[] = [];

  for (const rootCard of rootCards) {
    const contentCard = byId.get(rootCard.id);
    if (!contentCard) continue;
    for (const entry of CARD_FIELDS) {
      const root = show(entry.root(rootCard));
      const content = show(entry.content(contentCard));
      if (root !== content) {
        differences.push({ subject: rootCard.id, field: entry.field, root, content });
      }
    }
  }

  const rootIds = rootCards.map((card) => card.id);
  const contentIds = contentCards.map((card) => card.id);
  return {
    rootCount: rootCards.length,
    contentCount: contentCards.length,
    onlyInRoot: missingFrom(rootIds, contentIds),
    onlyInContent: missingFrom(contentIds, rootIds),
    differences,
  };
}

/**
 * Precon parity, including the construction rules the root file states.
 *
 * The root catalogue states deck size, singleton and commander-outside-deck once
 * for the whole file; the shipped equivalent is the format's `deck` block, which
 * is what actually decides whether a deck is legal. Both are compared, under the
 * subject `format`, because a root file claiming a 30-card format while the game
 * plays 40 would be exactly the stale second source of truth Q40 is about.
 *
 * A precon's `cardIds` order is explicitly not meaningful (`precon.ts`), so the
 * lists are compared as sorted sets. A repeat would change the multiset and is
 * therefore still caught.
 */
export function comparePrecons(
  rootCatalog: RootPreconCatalog,
  contentPrecons: readonly PreconDefinition[],
  format: PlayFormat,
): CatalogParity {
  const byId = new Map(contentPrecons.map((precon) => [precon.id, precon]));
  const differences: FieldDifference[] = [];

  const formatFields: readonly { field: string; root: unknown; content: unknown }[] = [
    { field: 'deckSize', root: rootCatalog.format.deckSize, content: format.deck.size },
    { field: 'singleton', root: rootCatalog.format.singleton, content: format.deck.singleton },
    {
      field: 'commanderOutsideDeck',
      root: rootCatalog.format.commanderOutsideDeck,
      content: format.deck.commanderOutsideDeck,
    },
  ];
  for (const entry of formatFields) {
    if (show(entry.root) !== show(entry.content)) {
      differences.push({
        subject: 'format',
        field: entry.field,
        root: show(entry.root),
        content: show(entry.content),
      });
    }
  }

  for (const rootPrecon of rootCatalog.precons) {
    const contentPrecon = byId.get(rootPrecon.id);
    if (!contentPrecon) continue;
    const fields: readonly { field: string; root: unknown; content: unknown }[] = [
      { field: 'name', root: rootPrecon.name, content: contentPrecon.name },
      { field: 'strategy', root: rootPrecon.strategy, content: contentPrecon.strategy },
      { field: 'commanderId', root: rootPrecon.commanderId, content: contentPrecon.commanderId },
      {
        field: 'cardIds',
        root: sortedList(rootPrecon.cardIds),
        content: sortedList(contentPrecon.cardIds),
      },
    ];
    for (const entry of fields) {
      const root = show(entry.root);
      const content = show(entry.content);
      if (root !== content) {
        differences.push({ subject: rootPrecon.id, field: entry.field, root, content });
      }
    }
  }

  const rootIds = rootCatalog.precons.map((precon) => precon.id);
  const contentIds = contentPrecons.map((precon) => precon.id);
  return {
    rootCount: rootCatalog.precons.length,
    contentCount: contentPrecons.length,
    onlyInRoot: missingFrom(rootIds, contentIds),
    onlyInContent: missingFrom(contentIds, rootIds),
    differences,
  };
}

function isExact(parity: CatalogParity): boolean {
  return (
    parity.onlyInRoot.length === 0 &&
    parity.onlyInContent.length === 0 &&
    parity.differences.length === 0
  );
}

/* ------------------------------------------------------------- repo reading */

/**
 * The parity of this repository's root catalogues against its shipped content.
 *
 * The content side is scoped by the catalogues' own `catalogId`, which is both
 * the set and the format they describe. Scoping matters: `content/` also ships
 * the `prototype_core` development fixture set, which the authored Wave 1
 * catalogue never claimed to contain, and comparing against the whole bundled
 * universe would report every fixture card as a loss.
 */
export function collectRootCatalogParity(repoRoot: string): RootCatalogParity {
  const cardCatalog = rootCardCatalogSchema.parse(
    JSON.parse(readFileSync(join(repoRoot, ROOT_CARD_CATALOG), 'utf8')),
  );
  const preconCatalog = rootPreconCatalogSchema.parse(
    JSON.parse(readFileSync(join(repoRoot, ROOT_PRECON_CATALOG), 'utf8')),
  );
  if (cardCatalog.catalogId !== preconCatalog.catalogId) {
    throw new Error(
      `The root catalogues disagree about what they describe: ${ROOT_CARD_CATALOG} says ` +
        `"${cardCatalog.catalogId}" and ${ROOT_PRECON_CATALOG} says "${preconCatalog.catalogId}".`,
    );
  }

  const catalogId = cardCatalog.catalogId;
  const set = loadBundledCardData().sets.find((entry) => entry.setId === catalogId);
  if (!set) {
    throw new Error(`No bundled set \`${catalogId}\`, which the root catalogues describe.`);
  }
  const format = bundledFormat(catalogId);
  if (!format) {
    throw new Error(`No bundled format \`${catalogId}\`, which the root catalogues describe.`);
  }

  const cards = compareCards(cardCatalog.cards, set.cards);
  const precons = comparePrecons(
    preconCatalog,
    BUNDLED_PRECONS.filter((precon) => precon.formatId === catalogId),
    format,
  );

  return {
    catalogId,
    cards,
    precons,
    comparedCardFields: COMPARED_CARD_FIELDS,
    exact: isExact(cards) && isExact(precons),
  };
}

/* ---------------------------------------------------------------- rendering */

function renderSection(label: string, parity: CatalogParity): readonly string[] {
  const lines = [
    `${label}: ${parity.rootCount} in the root catalogue, ${parity.contentCount} in content/.`,
  ];
  if (parity.onlyInRoot.length > 0) {
    lines.push(`  only in the root catalogue: ${parity.onlyInRoot.join(', ')}`);
  }
  if (parity.onlyInContent.length > 0) {
    lines.push(`  only in content/: ${parity.onlyInContent.join(', ')}`);
  }
  for (const difference of parity.differences) {
    lines.push(
      `  ${difference.subject} — ${difference.field}: root ${difference.root} vs content ${difference.content}`,
    );
  }
  if (lines.length === 1) lines.push('  no differences.');
  return lines;
}

/** A plain-text report, for the command line. */
export function renderParityReport(parity: RootCatalogParity): string {
  return [
    `Root catalogue parity for \`${parity.catalogId}\``,
    '',
    ...renderSection('Cards', parity.cards),
    '',
    ...renderSection('Precons', parity.precons),
    '',
    `Fields compared per card: ${parity.comparedCardFields.join(', ')}.`,
    '',
    parity.exact
      ? 'Exact parity: the root design catalogue and the shipped content agree on every compared field.'
      : 'NOT in parity — the differences above are between two files that both claim to describe the same cards.',
    '',
  ].join('\n');
}
