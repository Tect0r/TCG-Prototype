import { z } from 'zod';

import { runEnvironmentRefSchema } from './catalog.js';
import { contentIdSchema } from './content.js';
import { sourceClassesSchema } from './identity.js';
import {
  liveMatchContentVersionSchema,
  liveMatchDeckHashSchema,
  liveMatchSourceSchema,
} from './player-meta.js';

/**
 * M08.26A — the shared boundary the Deck, Card and Match explorers (M08.26B–D)
 * are all built against, so the three of them agree on what a stable
 * cross-navigation reference is and what a piece of evidence is allowed to
 * claim about where it came from, before any of the three exists.
 *
 * ## Two of the five named concerns need nothing new here
 *
 * M08.26's work-slice line asks for "bounded pagination, authorization,
 * stable identifiers, source/provenance fields and cross-navigation
 * contracts." The first two are not gaps this file fills — they are already
 * general enough to reuse as they stand, and restating either would be the
 * second copy this package exists to refuse:
 *
 * - **Bounded pagination** is `pageRequestSchema`/`pageInfoSchema`/`pageOf`
 *   (`./pagination.ts`). Nothing about a deck, card or match listing needs a
 *   page shaped differently from a batch or job listing; an explorer table
 *   asks for one exactly the way `playerMetaResultTableSchema` (M08.24/25)
 *   already does.
 * - **Authorization** is the single administrator token ADR 0023 §4 fixes,
 *   surfaced uniformly as the `admin/unauthorized` code (`./errors.ts`) and
 *   enforced once, server-side (`apps/admin-server/src/service/http.ts`).
 *   Hidden information — a replay artifact, a surrender-state snapshot —
 *   stays behind that same boundary per ADR 0023 §5; an explorer needs no
 *   second door, only to route the reference it exposes through an endpoint
 *   that checks the one token that exists.
 *
 * ## Stable identifiers: reused where one already exists, restated once where none did
 *
 * A deck's stable identity is its fingerprint, already restated as
 * `liveMatchDeckHashSchema` (`./player-meta.ts`, M08.25A) — a second
 * restatement here would drift the moment the first one did. A card's stable
 * identity is `contentIdSchema` (`./content.ts`), the package's one
 * deliberately shallow stand-in for a `@tcg/card-data`-owned card ID, for the
 * same "real shape belongs elsewhere" reason `content.ts`'s own doc comment
 * gives. A match's stable identity has no existing restatement anywhere in
 * this package: `explorerMatchIdSchema` below is the first one, bounded to
 * match `matchId` on `packages/match-telemetry/src/schema.ts`'s
 * `liveMatchEnvelopeSchema`.
 *
 * ## Source/provenance: one honest union, not one invented shape
 *
 * A Deck or Match explorer's evidence is a live match, carrying the
 * `(source, contentVersion, rulesVersion)` partition M08.24/25 already
 * defines. A Card explorer's eligible-inclusion evidence can also come from
 * an experiment run, carrying `sourceClasses` (`./identity.ts`) and the
 * environment content addresses `runEnvironmentRefSchema` (`./catalog.ts`)
 * already defines. These are two different systems with two different real
 * shapes, not one shape with optional fields — a union discriminated on
 * `realm` says exactly that, rather than fabricating a single provenance
 * record neither system actually produces.
 *
 * ## Cross-navigation: a typed reference, not a bare string
 *
 * `explorerRefSchema` is what one explorer hands another to navigate by: a
 * Card explorer's "contributing decks" list is `deckExplorerRefSchema[]`, a
 * Match explorer's deck snapshots point back with the same shape, and a
 * mixed "related items" panel can hold any of the three kinds side by side
 * without losing which stable identifier each one actually is. Bounded by
 * `MAX_EXPLORER_REFS` for the reason every array in this package is bounded:
 * an explorer never hands the browser an unlimited list of references any
 * more than it hands it unlimited rows.
 */

/* ------------------------------------------------------------------ kinds */

export const EXPLORER_KINDS = ['deck', 'card', 'match'] as const;
export const explorerKindSchema = z.enum(EXPLORER_KINDS);
export type ExplorerKind = z.infer<typeof explorerKindSchema>;

/**
 * Restates `matchId`'s bound on `liveMatchEnvelopeSchema`
 * (`packages/match-telemetry/src/schema.ts`), the same "restate the bound,
 * not just the word" requirement every other restated identifier in this
 * package follows. No regex to restate alongside it — the owning schema
 * places none on the field.
 */
export const EXPLORER_MATCH_ID_MAX = 128;
export const explorerMatchIdSchema = z.string().min(1).max(EXPLORER_MATCH_ID_MAX);
export type ExplorerMatchId = z.infer<typeof explorerMatchIdSchema>;

/* -------------------------------------------------------- stable references */

export const deckExplorerRefSchema = z.strictObject({
  kind: z.literal('deck'),
  deckHash: liveMatchDeckHashSchema,
});
export type DeckExplorerRef = z.infer<typeof deckExplorerRefSchema>;

export const cardExplorerRefSchema = z.strictObject({
  kind: z.literal('card'),
  cardId: contentIdSchema,
});
export type CardExplorerRef = z.infer<typeof cardExplorerRefSchema>;

export const matchExplorerRefSchema = z.strictObject({
  kind: z.literal('match'),
  matchId: explorerMatchIdSchema,
});
export type MatchExplorerRef = z.infer<typeof matchExplorerRefSchema>;

/** One stable, typed way for any explorer to point at a deck, a card or a match. */
export const explorerRefSchema = z.discriminatedUnion('kind', [
  deckExplorerRefSchema,
  cardExplorerRefSchema,
  matchExplorerRefSchema,
]);
export type ExplorerRef = z.infer<typeof explorerRefSchema>;

/** Most cross-navigation references one explorer answer carries side by side. */
export const MAX_EXPLORER_REFS = 64;
export const explorerRefsSchema = z.array(explorerRefSchema).max(MAX_EXPLORER_REFS);
export type ExplorerRefs = z.infer<typeof explorerRefsSchema>;

/* ---------------------------------------------------------------- evidence */

/**
 * Evidence traced to a live match — the same partition
 * `playerMetaPartitionSchema` (`./player-meta-results.ts`) already keys
 * Player Meta tables by, named here for an explorer row rather than a table
 * partition.
 */
export const liveMatchExplorerEvidenceSchema = z.strictObject({
  realm: z.literal('live_match'),
  source: liveMatchSourceSchema,
  contentVersion: liveMatchContentVersionSchema,
  /** `MatchState.rulesVersion` as it stood at match time. Restated, not imported — see `player-meta.ts`. */
  rulesVersion: z.string().min(1),
});
export type LiveMatchExplorerEvidence = z.infer<typeof liveMatchExplorerEvidenceSchema>;

/**
 * Evidence traced to an experiment run rather than a live match — a Card
 * explorer's eligible-inclusion evidence can come from a search or adaptive
 * job, and that evidence's classification and content address are
 * `sourceClasses` and `runEnvironmentRefSchema`, not a live-match partition.
 */
export const experimentExplorerEvidenceSchema = z.strictObject({
  realm: z.literal('experiment'),
  sourceClasses: sourceClassesSchema,
  environment: runEnvironmentRefSchema,
});
export type ExperimentExplorerEvidence = z.infer<typeof experimentExplorerEvidenceSchema>;

/**
 * Where one piece of explorer evidence came from: a live match or an
 * experiment run, never a shape that pretends those are the same system. See
 * file doc comment.
 */
export const explorerEvidenceSourceSchema = z.discriminatedUnion('realm', [
  liveMatchExplorerEvidenceSchema,
  experimentExplorerEvidenceSchema,
]);
export type ExplorerEvidenceSource = z.infer<typeof explorerEvidenceSourceSchema>;
