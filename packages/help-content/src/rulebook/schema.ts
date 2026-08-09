import { z } from 'zod';

/**
 * The rulebook is content, not a React page.
 *
 * A deliberately small, closed set of block types — not HTML in JSON. Adding a
 * new kind of presentation means adding a block type here and a renderer for
 * it, which is a visible, reviewable change; it must never be possible to smuggle
 * markup or behaviour in through a text field.
 *
 * Text fields may contain `{matchConfig.…}` / `{deckRules.…}` references, which
 * the loader resolves against live configuration. Unknown references fail
 * content validation.
 */

export const RULEBOOK_SCHEMA_VERSION = 1;

/**
 * Plain text only. Angle brackets are rejected at the schema boundary so no
 * author, and no future import path, can introduce executable markup — the
 * renderer's escaping is then a second line of defence rather than the only one.
 */
const safeText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((text) => !/[<>]/.test(text), {
      message: 'Rulebook text is plain text: angle brackets are not allowed.',
    });

const sectionIdSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, 'Section IDs must be lowercase_snake_case.');

const referenceSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_.]*$/, 'A source reference is a dotted allow-listed name.');

export const rulebookBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('heading'),
    text: safeText(120),
  }),
  z.strictObject({
    type: z.literal('paragraph'),
    text: safeText(1200),
  }),
  z.strictObject({
    type: z.literal('bulletList'),
    items: z.array(safeText(400)).min(1).max(30),
  }),
  z.strictObject({
    type: z.literal('numberedList'),
    items: z.array(safeText(400)).min(1).max(30),
  }),
  z.strictObject({
    type: z.literal('callout'),
    /** `unresolved` marks a rule that is deliberately not decided yet. */
    tone: z.enum(['info', 'warning', 'unresolved']),
    title: safeText(80).optional(),
    text: safeText(800),
  }),
  z.strictObject({
    type: z.literal('example'),
    title: safeText(80),
    steps: z.array(safeText(400)).min(1).max(20),
  }),
  z.strictObject({
    type: z.literal('configValue'),
    label: safeText(80),
    source: referenceSchema,
    /** Appended to the value, e.g. "cards" or "energy". */
    suffix: safeText(24).optional(),
  }),
  z.strictObject({
    type: z.literal('phaseList'),
    source: z.literal('matchConfig.turnPhases'),
  }),
  z.strictObject({
    type: z.literal('keywordIndex'),
    source: z.literal('keywordRegistry'),
  }),
  z.strictObject({
    type: z.literal('glossaryIndex'),
    source: z.literal('glossary'),
  }),
]);
export type RulebookBlock = z.infer<typeof rulebookBlockSchema>;
export type RulebookBlockType = RulebookBlock['type'];

export const rulebookSectionSchema = z.strictObject({
  id: sectionIdSchema,
  title: safeText(80),
  /** Sort key. Sparse on purpose, so a section can be inserted without renumbering. */
  order: z.number().int().min(0).max(10_000),
  /** Extra words that should match this section in search but are not displayed. */
  searchTerms: z.array(safeText(40)).max(20).default([]),
  blocks: z.array(rulebookBlockSchema).min(1),
});
export type RulebookSection = z.infer<typeof rulebookSectionSchema>;

export const rulebookSchema = z.strictObject({
  schemaVersion: z.number().int().min(1).max(RULEBOOK_SCHEMA_VERSION),
  title: safeText(80),
  /** Shown at the top: what this document is and is not. */
  intro: safeText(600),
  sections: z.array(rulebookSectionSchema).min(1),
});
export type Rulebook = z.infer<typeof rulebookSchema>;
