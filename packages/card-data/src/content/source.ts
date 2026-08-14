import { z } from 'zod';
import { setIdSchema } from '../schema/card.js';
import { CARD_SCHEMA_VERSION, setStatusSchema } from '../schema/primitives.js';

/**
 * A set manifest — `content/sets/<setId>/set.json`.
 *
 * The manifest owns `schemaVersion` for every card in the set. Per-card files
 * deliberately do not repeat it: a schema migration is then one edit per set
 * instead of one per card, and a card file cannot drift to a version its set
 * does not claim.
 */
export const setManifestSchema = z.strictObject({
  schemaVersion: z.number().int().min(1).max(
    CARD_SCHEMA_VERSION,
    // The authoring-side twin of `loadCardSets`' refusal, and it says the same
    // thing for the same reason: a set from a newer build is refused with the
    // action that fixes it, not with "too big".
    `A set may not declare a schemaVersion newer than the ${CARD_SCHEMA_VERSION} this build understands. Update the application.`,
  ),
  setId: setIdSchema,
  name: z.string().min(1).max(80),
  status: setStatusSchema,
  description: z.string().min(1).max(400).optional(),
});
export type SetManifest = z.infer<typeof setManifestSchema>;

/**
 * Version of the generated bundle's own envelope.
 *
 * - 1 — sets, formats and precons.
 * - 2 (M05.5) — `deckPlans`, the authored package structure of a deck. A v1
 *   bundle has no `deckPlans` key at all, so this is a refusal rather than a
 *   migration: the plans were never authored, and inventing an empty list would
 *   make "this build has no deck plans" indistinguishable from "this bundle
 *   predates them".
 */
export const CONTENT_BUNDLE_SCHEMA_VERSION = 2;

/**
 * Where the generated bundle lives, relative to the repository root.
 *
 * Generated output is never the human source of truth (readiness spec C1.7):
 * it is derived from `content/` by `npm run content:build`, checked in so the
 * browser and server get deterministic data without a build step, and verified
 * fresh by `npm run content:check`.
 */
export const CONTENT_SOURCE_DIR = 'content';
export const GENERATED_BUNDLE_PATH = 'packages/card-data/src/data/generated/content-bundle.json';

/** Marker written into the bundle so a hand-edited copy is obvious in review. */
export const GENERATED_BANNER =
  'GENERATED FILE — do not edit. Source: content/. Rebuild with `npm run content:build`.';
