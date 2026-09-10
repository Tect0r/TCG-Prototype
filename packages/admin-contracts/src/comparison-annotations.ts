import { z } from 'zod';

import {
  annotatableComparisonDecisionSchema,
  type AnnotatableComparisonDecision,
} from './comparison.js';
import { comparisonDeltaIdentitySchema, type ComparisonDeltaIdentity } from './comparison-deltas.js';
import { comparisonAnnotationIdSchema, timestampSchema } from './identity.js';
import { comparisonAnnotationVersionSchema } from './version.js';

/**
 * M08.27E — additive annotations.
 *
 * `./comparison.ts` decides whether a baseline/candidate pair is safe to
 * compare; `./comparison-deltas.ts` computes the delta once it is. Neither
 * records *why* an administrator went ahead with a `deliberately_different`
 * pair, or what a `compatible` verdict's automatic note was standing in for
 * once a person actually looked at the result. This file is that record —
 * and only that record: it adds no computation, changes no comparison and
 * exists purely to hold a human explanation next to the identity and
 * verdict it explains.
 *
 * **Additive, not editable.** There is no update and no delete anywhere in
 * this file or in `CatalogStore` for an annotation, which is a stronger
 * guarantee than "the API happens not to expose one" — the type this module
 * hands the store (`NewComparisonAnnotationInput` in
 * `apps/admin-server/src/catalog/store.ts`) carries no annotation ID,
 * because minting one is the store's job and nothing here can ask for a
 * second write against an ID it was never given. A candidate change is
 * tested once and its raw comparison stays exactly what
 * `computeCatalogComparisonDelta`/`computePlayerMetaComparisonDelta`
 * produced; annotating it is strictly additive record-keeping alongside
 * that output, never a mutation of it.
 *
 * **Cannot annotate a refusal.** `annotatableComparisonDecisionSchema`
 * (`./comparison.ts`) is a discriminated union of only the `compatible` and
 * `deliberately_different` branches of `ComparisonDecision` — `refused` is
 * absent from the type, not merely rejected by a runtime check. A refused
 * pair was never compared, so a note "explaining" one would describe
 * evidence that does not exist; making that shape unconstructable is the
 * same idiom `comparisonDeltaTableSchema`'s refinement uses to keep a
 * refused delta table from also carrying rows.
 *
 * **Linked by identity, not by table.** An annotation carries the same
 * `ComparisonDeltaIdentity` (`./comparison-deltas.ts`) a delta table does —
 * a catalog job pair or a Player Meta partition pair — rather than a
 * reference to any specific delta table row. The identity plus the decision
 * it accompanies *is* the link the milestone asks for: two people looking at
 * the same baseline/candidate pair, on any of the tables M08.27B computes
 * for it, find the same annotations, because nothing here ties a note to one
 * table's shape.
 */

/**
 * Most annotations one catalog holds.
 *
 * The same bound `MAX_SAVED_CHOICES` sets and for the same reason: annotation
 * listing is unpaginated, so "all of them" has to be an answer whose size is
 * known before it is built.
 */
export const MAX_COMPARISON_ANNOTATIONS = 500;

/** What an administrator wrote down about a comparison. */
export const comparisonAnnotationNoteSchema = z.string().min(1).max(600);
export type ComparisonAnnotationNote = z.infer<typeof comparisonAnnotationNoteSchema>;

/**
 * The stored document, and the only shape written to disk.
 *
 * One `createdAt` rather than `entryTimestampsSchema`'s four instants:
 * `entryTimestampsSchema` names `updatedAt` because a batch and a job are
 * both mutated after creation, and a saved choice keeps the same shape only
 * because `startedAt`/`completedAt` are honestly always `null`. An
 * annotation is never mutated at all, so a field named `updatedAt` would
 * promise a capability this store does not have.
 */
export const comparisonAnnotationDocumentSchema = z.strictObject({
  documentVersion: comparisonAnnotationVersionSchema,
  annotationId: comparisonAnnotationIdSchema,
  identity: comparisonDeltaIdentitySchema,
  decision: annotatableComparisonDecisionSchema,
  note: comparisonAnnotationNoteSchema,
  createdAt: timestampSchema,
});
export type ComparisonAnnotationDocument = z.infer<typeof comparisonAnnotationDocumentSchema>;

/** The same thing as a client sees it: the document without its storage version. */
export const comparisonAnnotationViewSchema = z.strictObject({
  annotationId: comparisonAnnotationIdSchema,
  identity: comparisonDeltaIdentitySchema,
  decision: annotatableComparisonDecisionSchema,
  note: comparisonAnnotationNoteSchema,
  createdAt: timestampSchema,
});
export type ComparisonAnnotationView = z.infer<typeof comparisonAnnotationViewSchema>;

export function comparisonAnnotationViewOf(
  stored: ComparisonAnnotationDocument,
): ComparisonAnnotationView {
  const { documentVersion: _documentVersion, ...rest } = stored;
  return rest;
}

/**
 * Every annotation this catalog holds, newest first.
 *
 * Unpaginated and bounded by `MAX_COMPARISON_ANNOTATIONS`, mirroring
 * `SavedChoiceList` for the same reason: a comparison's annotations are a
 * list somebody reads in full alongside the delta they explain, not a
 * collection anyone pages through.
 */
export const comparisonAnnotationListSchema = z.strictObject({
  items: z.array(comparisonAnnotationViewSchema).max(MAX_COMPARISON_ANNOTATIONS),
  /** How many the catalog holds, which is `items.length` unless something is unreadable. */
  total: z.number().int().min(0).max(MAX_COMPARISON_ANNOTATIONS),
  /**
   * Documents in the catalog this build could not read.
   *
   * Reported rather than dropped, for the reason `SavedChoiceList` gives: a
   * document from a newer build and a document that was never written are
   * different facts, and a list that showed neither would make the first
   * look like the second.
   */
  unreadable: z.number().int().min(0).max(MAX_COMPARISON_ANNOTATIONS).default(0),
});
export type ComparisonAnnotationList = z.infer<typeof comparisonAnnotationListSchema>;

export type { AnnotatableComparisonDecision, ComparisonDeltaIdentity };
