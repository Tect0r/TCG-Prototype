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
  schemaVersion: z.number().int().min(1).max(CARD_SCHEMA_VERSION),
  setId: setIdSchema,
  name: z.string().min(1).max(80),
  status: setStatusSchema,
  description: z.string().min(1).max(400).optional(),
});
export type SetManifest = z.infer<typeof setManifestSchema>;

/** Version of the generated bundle's own envelope. */
export const CONTENT_BUNDLE_SCHEMA_VERSION = 1;

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
