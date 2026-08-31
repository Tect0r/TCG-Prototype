import { z } from 'zod';

import { entryTimestampsSchema, savedChoiceIdSchema } from './identity.js';
import { presetChoiceSchema } from './presets.js';
import { savedChoiceVersionSchema } from './version.js';

/**
 * A filled-in builder form an administrator kept, so it can be reopened and
 * reused.
 *
 * ## Why this is stored by the service rather than by the browser
 *
 * ADR 0023 §4 forbids the administrator token from *anything the browser
 * persists*, and `apps/admin-client` keeps that promise structurally: its
 * boundary suite refuses `localStorage`, `sessionStorage`, `indexedDB` and
 * `document.cookie` in any source. A saved form put in one of those would either
 * require weakening that scan — turning a structural guarantee into a reviewer's
 * judgement about which key is allowed — or would live in a second storage
 * mechanism nobody scans. It is also the wrong place on its own merits: a
 * configuration kept in one browser profile is invisible from the machine's
 * other browser, gone when site data is cleared, and impossible for the process
 * that would run it to validate.
 *
 * ## Why it is not called a preset
 *
 * `PRESET_REGISTRY` already owns that word, and its presets are the *build's*:
 * published, versioned with the code, and carrying authored limitations that a
 * result may never be cited against. A saved choice is one administrator's form,
 * carries no limitations of its own, and is worth exactly what the preset it
 * names is worth. Calling both "preset" would make `presetId` ambiguous in every
 * signature that takes one.
 *
 * ## What it holds, and what it deliberately does not
 *
 * It holds a `presetChoice` — the same shape `enqueue-preset` takes — and a
 * label. It holds **no estimate**: a stored count would be a number about
 * content as it was on the day it was saved, and reopening the form has to
 * re-ask. It holds **no batch, no job and no result**, because saving a form
 * schedules nothing; and it holds **no filesystem location**, for the reason
 * every other admin input has none.
 */

/**
 * Most saved configurations one catalog holds.
 *
 * A bound rather than a preference, and the same argument `MAX_JOBS_PER_BATCH`
 * makes: `saved-choices` is unpaginated on the wire, so "all of them" has to be
 * an answer whose size is known before it is built. It is generous — a hundred
 * kept forms is far past the point at which a person can find one by reading the
 * list — and refusing at a stated number is better than a listing that grows
 * until it exceeds the service's own body limit.
 */
export const MAX_SAVED_CHOICES = 200;

/** What a person calls a saved configuration when they look for it later. */
export const savedChoiceLabelSchema = z.string().min(1).max(120);

/**
 * The stored document, and the only shape written to disk.
 *
 * `timestamps` is `entryTimestampsSchema` — the same four instants a batch and a
 * job carry — rather than a bespoke pair. `startedAt` and `completedAt` are
 * always `null` here and that is honest rather than wasteful: a saved
 * configuration never starts and never completes, and a reader that finds a
 * value in either has found a document this build did not write.
 */
export const savedChoiceDocumentSchema = z
  .strictObject({
    documentVersion: savedChoiceVersionSchema,
    savedChoiceId: savedChoiceIdSchema,
    label: savedChoiceLabelSchema,
    timestamps: entryTimestampsSchema,
    choice: presetChoiceSchema,
  })
  .refine(
    (entry) => entry.timestamps.startedAt === null && entry.timestamps.completedAt === null,
    'A saved test configuration never starts and never completes, so it has neither instant.',
  );
export type SavedChoiceDocument = z.infer<typeof savedChoiceDocumentSchema>;

/** The same thing as a client sees it: the document without its storage version. */
export const savedChoiceViewSchema = z.strictObject({
  savedChoiceId: savedChoiceIdSchema,
  label: savedChoiceLabelSchema,
  timestamps: entryTimestampsSchema,
  choice: presetChoiceSchema,
});
export type SavedChoiceView = z.infer<typeof savedChoiceViewSchema>;

export function savedChoiceViewOf(stored: SavedChoiceDocument): SavedChoiceView {
  const { documentVersion: _documentVersion, ...rest } = stored;
  return rest;
}

/**
 * Every saved configuration this catalog holds, newest first.
 *
 * Unpaginated, and bounded by `MAX_SAVED_CHOICES` rather than by a page size —
 * the same argument `batchDetailSchema` makes for a batch's membership. A
 * builder's "open a saved configuration" control is a list somebody scans, and a
 * list that arrives in pages is one where the configuration you want is on the
 * page you did not ask for.
 */
export const savedChoiceListSchema = z.strictObject({
  items: z.array(savedChoiceViewSchema).max(MAX_SAVED_CHOICES),
  /** How many the catalog holds, which is `items.length` unless something is unreadable. */
  total: z.number().int().min(0).max(MAX_SAVED_CHOICES),
  /**
   * Documents in the catalog this build could not read.
   *
   * Reported rather than dropped, for the reason `CatalogPage` gives: a document
   * from a newer build and a document that was never written are different
   * facts, and a list that showed neither would make the first look like the
   * second.
   */
  unreadable: z.number().int().min(0).max(MAX_SAVED_CHOICES).default(0),
});
export type SavedChoiceList = z.infer<typeof savedChoiceListSchema>;
