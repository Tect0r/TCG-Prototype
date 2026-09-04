import { z } from 'zod';

import { contentIdSchema } from './content.js';
import { liveMatchDeckHashSchema } from './player-meta.js';
import { liveMatchExplorerEvidenceSchema } from './explorers.js';

/**
 * M08.26B — the Deck Explorer.
 *
 * The milestone's own line asks for "immutable list, Commander, provenance,
 * construction, known revisions, matches, matchup split, cluster and
 * separated AI and human evidence." Four of those nine words are not a gap
 * this file fills — they are already exactly what `playerMetaResultTableSchema`
 * (`./player-meta-results.ts`, M08.25B) answers once its `filter.deckHashes`
 * (`./player-meta.ts`, M08.25A) is narrowed to this one hash: `deck_matchups`
 * is the matches and matchup split, `clusters`/`cluster_matchups` is the
 * cluster, and every row already carries its own `source` partition, so
 * "separated AI and human evidence" is a property that table already has
 * rather than one this file would have to invent a second time. A client
 * reaches all four through the existing `player-meta-result-table` address —
 * this file would only be duplicating a reduction `apps/simulator`'s
 * `aggregateLiveMatches` (M08.24C) already owns.
 *
 * What is left — an immutable card list plus Commander tied to one exact
 * observed occurrence of a deck hash, its provenance, and (optionally) the
 * Adaptive Counter revision lineage that produced it — has no existing
 * restatement anywhere in this package, so `deckExplorerIdentitySchema` and
 * `deckExplorerRevisionSchema` are new.
 *
 * ## Identity is read off one observed envelope, not invented from the hash
 *
 * A deck hash (`liveMatchDeckHashSchema`, M08.25A) is `deckFingerprint`
 * (`packages/deck/src/fingerprint.ts`) over `{commanderId, cards}` — any two
 * live-match occurrences of the same hash are byte-identical by
 * construction, so reading the card list and Commander off *any one* match
 * that played this deck is exact, never a sample. `apps/admin-server`'s
 * reader picks the lowest `matchId` among the filtered occurrences — a
 * narrow, documented rule for "which one envelope anchors this identity
 * read," not the general representative-match-selection framework M08.26E
 * still owns.
 *
 * `deckExplorerCardEntrySchema` restates `deckEntrySchema`
 * (`packages/deck/src/schema.ts`) rather than importing it (ADR 0001 — a
 * `@tcg/deck`-owned shape is a word this package names, never an import that
 * would put `@tcg/deck` on `@tcg/admin-contracts`'s dependency graph, the
 * same rule `player-meta.ts`'s doc comment already states for
 * `@tcg/match-telemetry`). `DECK_EXPLORER_MAX_CARD_ENTRIES` restates
 * `MAX_FORMAT_DECK_SIZE` (`packages/card-data/src/schema/format.ts`), the
 * largest deck size any format can require, for the same "restate the bound,
 * not just the word" reason `explorers.ts`'s `EXPLORER_MATCH_ID_MAX` does.
 *
 * `observedIn` is `liveMatchExplorerEvidenceSchema` (`./explorers.ts`,
 * M08.26A) verbatim — the exact evidence shape that file exists so every
 * explorer agrees on, not a second one.
 *
 * ## Known revisions: an honest `null` versus an honest empty list
 *
 * `apps/simulator/src/adaptive/revision.ts`'s `adaptiveRevisionSchema` is the
 * only place "construction" and "revision lineage" data exists anywhere in
 * this codebase for any deck — live-match telemetry carries no generator
 * metadata at all. There is also no global index from a deck hash to the
 * Adaptive Counter run that produced it; building one is an unscoped,
 * un-asked-for feature this slice does not invent (CLAUDE.md: "do not
 * silently invent unresolved rules"). So a caller that wants revision lineage
 * names the one experiment to check, `adaptiveExperimentId`, and the answer
 * distinguishes two states a single empty array would blur together:
 *
 * - `knownRevisions: null` — no `adaptiveExperimentId` was named, so nothing
 *   was checked.
 * - `knownRevisions: []` — one was named, its run was read, and no revision
 *   in either lineage names this deck hash.
 *
 * If the named experiment's run cannot be read at all (missing, unreadable,
 * a schema version this build does not own), the whole request is refused
 * rather than silently degrading to either of the above — a caller that named
 * a specific run and got `null` back would read that as "not checked," which
 * would be false.
 *
 * `deckExplorerRevisionSchema` restates `adaptiveRevisionSchema`'s fields the
 * way `apps/admin-server/src/service/adaptive-results.ts`'s `'revisions'`
 * table already flattens them for display (`side`, `swapCount` in place of
 * `swaps`), not the full nested shape — a lineage entry here is read
 * evidence, not a second copy of the engine's own revision record.
 * `DECK_EXPLORER_REVISION_SIDES` restates that file's module-private
 * `ADAPTIVE_SIDES`.
 */

/* -------------------------------------------------------------- identity */

/** Restates `deckEntrySchema` (`packages/deck/src/schema.ts`). See file doc comment. */
export const deckExplorerCardEntrySchema = z.strictObject({
  cardId: contentIdSchema,
  quantity: z.number().int().min(1).max(99),
});
export type DeckExplorerCardEntry = z.infer<typeof deckExplorerCardEntrySchema>;

/** Restates `MAX_FORMAT_DECK_SIZE` (`packages/card-data/src/schema/format.ts`). See file doc comment. */
export const DECK_EXPLORER_MAX_CARD_ENTRIES = 250;

export const deckExplorerIdentitySchema = z.strictObject({
  commanderId: contentIdSchema,
  cards: z.array(deckExplorerCardEntrySchema).min(1).max(DECK_EXPLORER_MAX_CARD_ENTRIES),
  /** The one observed live match this exact card list and Commander were read from. */
  observedIn: liveMatchExplorerEvidenceSchema,
});
export type DeckExplorerIdentity = z.infer<typeof deckExplorerIdentitySchema>;

/* ------------------------------------------------------------- revisions */

/** Restates `ADAPTIVE_REVISION_CONSTRUCTION_KINDS` (`apps/simulator/src/adaptive/revision.ts`). */
export const DECK_EXPLORER_REVISION_CONSTRUCTION_KINDS = ['root', 'swap', 'rebuild'] as const;
export const deckExplorerRevisionConstructionKindSchema = z.enum(
  DECK_EXPLORER_REVISION_CONSTRUCTION_KINDS,
);
export type DeckExplorerRevisionConstructionKind = z.infer<
  typeof deckExplorerRevisionConstructionKindSchema
>;

/** Restates the module-private `ADAPTIVE_SIDES` (`apps/admin-server/src/service/adaptive-results.ts`). */
export const DECK_EXPLORER_REVISION_SIDES = ['incumbent', 'opponent'] as const;
export const deckExplorerRevisionSideSchema = z.enum(DECK_EXPLORER_REVISION_SIDES);
export type DeckExplorerRevisionSide = z.infer<typeof deckExplorerRevisionSideSchema>;

/**
 * One lineage entry that named this deck hash, flattened the way the
 * `adaptive-result-table`'s `'revisions'` table already flattens
 * `adaptiveRevisionSchema` for display. See file doc comment.
 */
export const deckExplorerRevisionSchema = z.strictObject({
  side: deckExplorerRevisionSideSchema,
  revisionId: z.string().min(1),
  parentRevisionId: z.string().min(1).nullable(),
  generation: z.number().int().min(0),
  block: z.number().int().min(0),
  opponentRevisionId: z.string().min(1).nullable(),
  construction: deckExplorerRevisionConstructionKindSchema,
  swapCount: z.number().int().min(0),
});
export type DeckExplorerRevision = z.infer<typeof deckExplorerRevisionSchema>;

/** Most lineage entries one deck's known-revisions answer carries. See file doc comment. */
export const DECK_EXPLORER_MAX_REVISIONS = 64;

/* -------------------------------------------------------------- the view */

export const deckExplorerViewSchema = z.strictObject({
  deckHash: liveMatchDeckHashSchema,
  /** `null` when no live match played this exact deck hash. */
  identity: deckExplorerIdentitySchema.nullable(),
  /** `null` versus `[]` — see file doc comment. */
  knownRevisions: z.array(deckExplorerRevisionSchema).max(DECK_EXPLORER_MAX_REVISIONS).nullable(),
});
export type DeckExplorerView = z.infer<typeof deckExplorerViewSchema>;
