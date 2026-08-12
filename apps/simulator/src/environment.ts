import { z } from 'zod';
import {
  BUNDLED_FORMATS,
  CardDatabase,
  applyCardPatch,
  bundledFormat,
  cardDefinitionSchema,
  cardIdSchema,
  cardPatchBodySchema,
  formatCardPool,
  loadBundledCardData,
  type CardDefinition,
  type CardId,
  type PlayFormat,
} from '@tcg/card-data';
import { DEFAULT_DECK_FORMAT, type DeckFormatConfig } from '@tcg/deck';
import { DEFAULT_RULES_CONFIG, rulesConfigSchema, type RulesConfig } from '@tcg/rules-engine';
import { computeEnvironmentHashes, snapshotCards, type EnvironmentHashes } from './content-hash.js';
import { canonicalJson } from './hash.js';

/**
 * An environment: the versioned bundle a set of matches was played under
 * (CLAUDE.md §13.12).
 *
 * It is the unit a baseline-versus-candidate comparison compares. Everything
 * that can change a result and is not a deck or a pilot lives here — the card
 * pool, the card definitions themselves, the deck format and the rules
 * configuration — and the whole bundle is content-hashed, so "these two runs
 * used the same rules" is checkable rather than assumed.
 */

export const deckFormatSchema = z.strictObject({
  /**
   * The content format these limits describe. Recorded for provenance, never
   * used to look a format up: an experiment states its construction rules
   * outright so a later edit to `content/formats` cannot silently redefine a
   * finished run.
   */
  formatId: z.string().min(1).max(40).default('custom'),
  deckSize: z.number().int().min(1).max(200).default(DEFAULT_DECK_FORMAT.deckSize),
  /**
   * One copy of each card ID, enforced by identity rather than by copy count.
   *
   * Defaults to `false` rather than to the active format's value. An experiment
   * that omits it is saying "ordinary copy limits", and inheriting singleton
   * from whatever format happens to be current would silently change what every
   * existing config means.
   */
  singleton: z.boolean().default(false),
  copyLimit: z.number().int().min(1).max(20).default(DEFAULT_DECK_FORMAT.copyLimit),
  uniqueCopyLimit: z.number().int().min(1).max(20).default(DEFAULT_DECK_FORMAT.uniqueCopyLimit),
  maxCommanderColors: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(DEFAULT_DECK_FORMAT.maxCommanderColors),
});

/**
 * A small, reviewable balance edit to an existing card.
 *
 * The alternative — a complete duplicated `CardDefinition` in `cardOverrides` —
 * makes an ordinary cost change a forty-line diff in which the one number that
 * matters is invisible, and lets an unrelated field drift between the two copies
 * without anybody noticing. A patch states only what moves; the environment diff
 * is then derived from what actually resolved rather than from the prose.
 */
export const cardPatchSchema = z.strictObject({
  cardId: cardIdSchema,
  /** Optional human note. Never used to decide whether the patch applied. */
  note: z.string().max(200).default(''),
  patch: cardPatchBodySchema,
});
export type CardPatch = z.infer<typeof cardPatchSchema>;

export const environmentConfigSchema = z.strictObject({
  /** Stable identifier. Appears in seeds, match IDs and every record. */
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'Environment IDs must be lowercase_snake_case.'),
  /** Optional display label. Empty is legal and falls back to the ID, so a
   * resolved config still re-validates when a worker re-parses it. */
  label: z.string().max(80).default(''),
  /**
   * Named content sets to load, in place of the format's own selection.
   *
   * Empty means "whatever the named format selects". When both are given, these
   * sets replace the format's set list and the format's bans still apply, so an
   * environment can widen a format's content without quietly dropping its ban
   * list.
   */
  sets: z.array(z.string().min(1)).default([]),
  /**
   * Named format manifest to select cards by (`content/formats/`).
   *
   * `null` means "every bundled set", which is the whole card universe and is
   * not a legal pool for anything — it exists because the Phase 1–4 experiment
   * fixtures were written against it and their recorded hashes must not move.
   * A new experiment names its format, and a precon deck source needs one: a
   * precon is format-scoped content, and it is refused outright by
   * `reviewPrecon` when the environment's `deckFormat.formatId` is not the
   * format it was built to.
   *
   * Selecting content is what a format *is* (readiness §4 B4): prototype fixture
   * cards are present only when a set or format explicitly asks for them.
   */
  format: z.string().min(1).nullable().default(null),
  /**
   * Whole card definitions layered over the selected sets. A definition whose ID
   * already exists *replaces* it. Use this to add a card that does not exist yet;
   * use `cardPatches` for an ordinary balance edit to one that does.
   */
  cardOverrides: z.array(cardDefinitionSchema).default([]),
  /** Field-level edits to cards that already exist. Applied after overrides. */
  cardPatches: z.array(cardPatchSchema).default([]),
  /** When set, only these IDs may appear in a generated or accepted deck. */
  allowCardIds: z.array(cardIdSchema).nullable().default(null),
  banCardIds: z.array(cardIdSchema).default([]),
  deckFormat: deckFormatSchema.prefault({}),
  rulesConfig: rulesConfigSchema.partial().default({}),
});
export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;
export type EnvironmentConfigInput = z.input<typeof environmentConfigSchema>;

/**
 * A content set an environment drew cards from, at the version it was read at.
 *
 * Empty until sets are explicit source manifests (readiness §5 C1); the field
 * exists now so a snapshot written today keeps the same shape once they are.
 */
export const environmentSetSchema = z.strictObject({
  setId: z.string().min(1),
  name: z.string(),
  version: z.number().int().min(1),
  status: z.string(),
  contentHash: z.string(),
});
export type EnvironmentSet = z.infer<typeof environmentSetSchema>;

export interface Environment {
  readonly id: string;
  readonly label: string;
  /**
   * Identity of the whole resolved bundle — the `fullContentHash`. Two equal
   * hashes are byte-identical content, including player-facing text.
   */
  readonly hash: string;
  /**
   * Identity of what the *engine* executes — the `mechanicsHash`. This is the
   * hash a replay equivalence claim rests on, and the one that deliberately does
   * not move when a card's flavour text is corrected.
   */
  readonly cardPoolHash: string;
  /** All four hashes, separated by what they actually guarantee (§9 G3). */
  readonly hashes: EnvironmentHashes;
  readonly database: CardDatabase;
  readonly deckFormat: DeckFormatConfig;
  readonly rulesConfig: RulesConfig;
  /** Deckable, collectible, allowed cards — the pool deck generation draws from. */
  readonly pool: readonly CardDefinition[];
  readonly commanders: readonly CardDefinition[];
  /** Content sets the cards came from. Empty means "the bundled prototype data". */
  readonly sets: readonly EnvironmentSet[];
  /** Format manifest this environment was selected by, when it had one. */
  readonly formatId: string | null;
  readonly config: EnvironmentConfig;
}

let bundled: CardDatabase | undefined;
function bundledDatabase(): CardDatabase {
  bundled ??= loadBundledCardData().database;
  return bundled;
}

/**
 * The cards an environment starts from, before its own overrides and bans.
 *
 * The one place the "a playable pool comes from a format, never from the whole
 * bundled universe" rule is applied on the simulator side. An unknown format or
 * set is a hard error naming the environment: resolving to a smaller pool than
 * the config declares would reject decks for the wrong reason, and resolving to
 * the universe instead would run the experiment against content its own
 * configuration says is out of scope.
 */
function selectedCards(config: EnvironmentConfig): readonly CardDefinition[] {
  const format = config.format === null ? null : requireFormat(config);

  if (config.sets.length > 0) {
    const available = new Map(loadBundledCardData().sets.map((set) => [set.setId, set]));
    const missing = config.sets.filter((setId) => !available.has(setId));
    if (missing.length > 0) {
      throw new Error(
        `Environment "${config.id}" names set(s) ${missing.join(', ')}, which are not in the ` +
          `bundled content. Known sets: ${[...available.keys()].join(', ')}.`,
      );
    }
    const banned = new Set(format?.bannedCardIds ?? []);
    return config.sets
      .flatMap((setId) => available.get(setId)?.cards ?? [])
      .filter((card) => !banned.has(card.id));
  }

  if (format) return formatCardPool(format.formatId);

  // No format and no sets: the whole bundled universe, as every pre-M03.3
  // fixture config resolved to. Recorded hashes depend on this, so it stays.
  return bundledDatabase().all();
}

function requireFormat(config: EnvironmentConfig): PlayFormat {
  const format = bundledFormat(config.format ?? '');
  if (!format) {
    throw new Error(
      `Environment "${config.id}" names format "${config.format}", which is not defined in ` +
        `content/formats. Known formats: ${BUNDLED_FORMATS.map((entry) => entry.formatId).join(', ')}.`,
    );
  }
  return format;
}

export function resolveEnvironment(input: EnvironmentConfigInput): Environment {
  const config = environmentConfigSchema.parse(input);

  const byId = new Map<CardId, CardDefinition>(
    selectedCards(config).map((card) => [card.id, card]),
  );

  // Overrides first, patches second: a patch edits the definition the experiment
  // actually runs, which may itself have been supplied by an override.
  for (const override of config.cardOverrides) byId.set(override.id, override);
  for (const entry of config.cardPatches) {
    const base = byId.get(entry.cardId);
    if (!base) {
      throw new Error(
        `Environment "${config.id}" patches "${entry.cardId}", which does not exist in the ` +
          'resolved card pool. A patch edits a card; use `cardOverrides` to add one.',
      );
    }
    const patched = applyCardPatch(base, entry.patch);
    if (!patched.success) {
      throw new Error(
        `Environment "${config.id}" patches "${entry.cardId}" into an invalid card:\n` +
          patched.error.issues
            .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('\n'),
      );
    }
    byId.set(entry.cardId, patched.data);
  }
  const database = new CardDatabase([...byId.values()]);

  const banned = new Set(config.banCardIds);
  const allowed = config.allowCardIds === null ? null : new Set(config.allowCardIds);
  const permitted = (card: CardDefinition): boolean =>
    !banned.has(card.id) && (allowed === null || allowed.has(card.id));

  const pool = database.deckable().filter(permitted);
  const commanders = database.commanders().filter(permitted);

  const rulesConfig: RulesConfig = rulesConfigSchema.parse({
    ...DEFAULT_RULES_CONFIG,
    ...config.rulesConfig,
  });
  const deckFormat: DeckFormatConfig = { ...config.deckFormat };

  // Hashed over exactly the card set a snapshot will later freeze — the playable
  // cards plus the tokens they reach — so a frozen environment's hashes equal the
  // live one's rather than merely resembling them. Cards nobody could play are
  // excluded, so banning an unreachable card does not invalidate a comparison.
  const hashes = computeEnvironmentHashes({
    cards: snapshotCards(pool, commanders, database),
    rulesConfig,
    deckFormat,
    poolCardIds: pool.map((card) => card.id),
    commanderCardIds: commanders.map((card) => card.id),
  });

  return {
    id: config.id,
    label: config.label || config.id,
    hash: hashes.fullContentHash,
    // Every seed and match ID derives from `environmentId`, never from a hash, so
    // repointing these at the separated hashes moves no seed and renames no match.
    cardPoolHash: hashes.mechanicsHash,
    hashes,
    database,
    deckFormat,
    rulesConfig,
    pool,
    commanders,
    sets: [],
    formatId: config.format,
    config,
  };
}

/* ------------------------------------------------------------------- diffing */

export const environmentDiffSchema = z.strictObject({
  baselineId: z.string(),
  candidateId: z.string(),
  identical: z.boolean(),
  cardsAdded: z.array(cardIdSchema),
  cardsRemoved: z.array(cardIdSchema),
  /** Cards present in both but defined differently, with the changed fields. */
  cardsChanged: z.array(
    z.strictObject({
      cardId: cardIdSchema,
      fields: z.array(z.string()),
      before: z.string(),
      after: z.string(),
    }),
  ),
  rulesChanged: z.array(z.strictObject({ key: z.string(), before: z.string(), after: z.string() })),
  formatChanged: z.array(
    z.strictObject({ key: z.string(), before: z.string(), after: z.string() }),
  ),
});
export type EnvironmentDiff = z.infer<typeof environmentDiffSchema>;

/**
 * Exactly what differs between two environments.
 *
 * A comparison report has to lead with this: a reader cannot judge a result
 * without knowing precisely what changed, and "we changed one card" is a claim
 * the tooling should be able to check rather than repeat (CLAUDE.md §13.12).
 */
export function diffEnvironments(baseline: Environment, candidate: Environment): EnvironmentDiff {
  const before = new Map(baseline.pool.concat(baseline.commanders).map((c) => [c.id, c] as const));
  const after = new Map(candidate.pool.concat(candidate.commanders).map((c) => [c.id, c] as const));

  const cardsAdded = [...after.keys()].filter((id) => !before.has(id)).sort();
  const cardsRemoved = [...before.keys()].filter((id) => !after.has(id)).sort();

  const cardsChanged: EnvironmentDiff['cardsChanged'] = [];
  for (const id of [...before.keys()].filter((key) => after.has(key)).sort()) {
    const left = before.get(id) as CardDefinition;
    const right = after.get(id) as CardDefinition;
    const leftJson = canonicalJson(left);
    const rightJson = canonicalJson(right);
    if (leftJson === rightJson) continue;
    const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .filter(
        (key) =>
          canonicalJson((left as unknown as Record<string, unknown>)[key]) !==
          canonicalJson((right as unknown as Record<string, unknown>)[key]),
      )
      .sort();
    cardsChanged.push({ cardId: id, fields, before: leftJson, after: rightJson });
  }

  const rulesChanged = diffRecords(
    baseline.rulesConfig as unknown as Record<string, unknown>,
    candidate.rulesConfig as unknown as Record<string, unknown>,
  );
  const formatChanged = diffRecords(
    baseline.deckFormat as unknown as Record<string, unknown>,
    candidate.deckFormat as unknown as Record<string, unknown>,
  );

  return {
    baselineId: baseline.id,
    candidateId: candidate.id,
    identical: baseline.hash === candidate.hash,
    cardsAdded,
    cardsRemoved,
    cardsChanged,
    rulesChanged,
    formatChanged,
  };
}

function diffRecords(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): { key: string; before: string; after: string }[] {
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return keys
    .filter((key) => canonicalJson(left[key]) !== canonicalJson(right[key]))
    .map((key) => ({ key, before: canonicalJson(left[key]), after: canonicalJson(right[key]) }));
}

/* ------------------------------------------------------- declared changes */

/**
 * What a comparison *claims* to change (PHASE4_HARDENING §4).
 *
 * A comparison whose prose says "Scorch now deals one more damage" and whose
 * card pools are identical is worse than no comparison at all: it produces a
 * plausible-looking report about a change that never happened. The declaration
 * exists so the tooling can check the claim against the two resolved pools
 * before spending an hour of CPU measuring nothing.
 */
export const declaredChangesSchema = z.strictObject({
  /** Card IDs the candidate is expected to introduce. */
  cardsAdded: z.array(cardIdSchema).default([]),
  /** Card IDs the candidate is expected to remove from the playable pool. */
  cardsRemoved: z.array(cardIdSchema).default([]),
  /**
   * Cards expected to differ, with the exact fields expected to differ.
   *
   * Naming the fields is the point: `["effects"]` on a card whose targeting
   * filter also moved is a declaration that does not match what was run.
   */
  cardsChanged: z
    .array(
      z.strictObject({
        cardId: cardIdSchema,
        fields: z.array(z.string().min(1)).min(1),
        /** Optional human note; never used to decide whether the diff matches. */
        note: z.string().max(200).default(''),
      }),
    )
    .default([]),
  /** Rules-configuration keys expected to differ. */
  rulesChanged: z.array(z.string().min(1)).default([]),
  /** Deck-format keys expected to differ. */
  formatChanged: z.array(z.string().min(1)).default([]),
  /**
   * What to do about a difference the declaration did not mention.
   *
   * `reject` is the default because an undeclared difference means the
   * experiment is measuring more than one thing and cannot attribute the result
   * to the change it names.
   */
  onUndeclared: z.enum(['reject', 'warn']).default('reject'),
});
export type DeclaredChanges = z.infer<typeof declaredChangesSchema>;

export interface DeclaredDiffCheck {
  readonly ok: boolean;
  /** Mismatches that must stop the run. */
  readonly errors: readonly string[];
  /** Mismatches the configuration downgraded to a prominent report warning. */
  readonly warnings: readonly string[];
  /** The structured diff that was actually verified. */
  readonly diff: EnvironmentDiff;
}

/**
 * Checks a resolved environment diff against what the experiment declared.
 *
 * Three failures are distinguished because they mean different things:
 * a declared change that did not happen (the fixture is a lie), an undeclared
 * change that did (the experiment is confounded), and a declaration on a card
 * that is structurally identical in both pools (§4 requirement 5).
 */
export function checkDeclaredChanges(
  diff: EnvironmentDiff,
  declared: DeclaredChanges,
): DeclaredDiffCheck {
  const errors: string[] = [];
  const undeclared: string[] = [];

  const actualChanged = new Map(diff.cardsChanged.map((entry) => [entry.cardId, entry] as const));

  for (const entry of declared.cardsChanged) {
    const actual = actualChanged.get(entry.cardId);
    if (!actual) {
      errors.push(
        `The comparison declares that "${entry.cardId}" changes, but its definition is identical ` +
          'in the baseline and candidate pools. Nothing would be measured.',
      );
      continue;
    }
    const missing = entry.fields.filter((field) => !actual.fields.includes(field));
    if (missing.length > 0) {
      errors.push(
        `"${entry.cardId}" was declared to change in ${missing.join(', ')}, but ` +
          `only ${actual.fields.join(', ')} actually differ.`,
      );
    }
    const extra = actual.fields.filter((field) => !entry.fields.includes(field));
    if (extra.length > 0) {
      undeclared.push(
        `"${entry.cardId}" also differs in undeclared field(s): ${extra.join(', ')}.`,
      );
    }
  }

  for (const cardId of declared.cardsAdded) {
    if (!diff.cardsAdded.includes(cardId)) {
      errors.push(`"${cardId}" was declared as added, but it is not new in the candidate pool.`);
    }
  }
  for (const cardId of declared.cardsRemoved) {
    if (!diff.cardsRemoved.includes(cardId)) {
      errors.push(`"${cardId}" was declared as removed, but it is still in the candidate pool.`);
    }
  }
  for (const key of declared.rulesChanged) {
    if (!diff.rulesChanged.some((entry) => entry.key === key)) {
      errors.push(`Rules key "${key}" was declared to change, but both environments agree on it.`);
    }
  }
  for (const key of declared.formatChanged) {
    if (!diff.formatChanged.some((entry) => entry.key === key)) {
      errors.push(`Format key "${key}" was declared to change, but both environments agree on it.`);
    }
  }

  const declaredChangedIds = new Set(declared.cardsChanged.map((entry) => entry.cardId));
  for (const entry of diff.cardsChanged) {
    if (declaredChangedIds.has(entry.cardId)) continue;
    undeclared.push(`"${entry.cardId}" differs (${entry.fields.join(', ')}) but was not declared.`);
  }
  for (const cardId of diff.cardsAdded) {
    if (!declared.cardsAdded.includes(cardId)) {
      undeclared.push(`"${cardId}" is new in the candidate pool but was not declared.`);
    }
  }
  for (const cardId of diff.cardsRemoved) {
    if (!declared.cardsRemoved.includes(cardId)) {
      undeclared.push(`"${cardId}" was dropped from the candidate pool but was not declared.`);
    }
  }
  for (const entry of diff.rulesChanged) {
    if (!declared.rulesChanged.includes(entry.key)) {
      undeclared.push(
        `Rules key "${entry.key}" differs (${entry.before} → ${entry.after}) but was not declared.`,
      );
    }
  }
  for (const entry of diff.formatChanged) {
    if (!declared.formatChanged.includes(entry.key)) {
      undeclared.push(
        `Format key "${entry.key}" differs (${entry.before} → ${entry.after}) but was not declared.`,
      );
    }
  }

  const declaresSomething =
    declared.cardsAdded.length +
      declared.cardsRemoved.length +
      declared.cardsChanged.length +
      declared.rulesChanged.length +
      declared.formatChanged.length >
    0;

  if (declaresSomething && diff.identical) {
    errors.push(
      'The baseline and candidate environments hash identically. A comparison that declares a ' +
        'change and resolves to no change measures nothing.',
    );
  }

  const warnings: string[] = [];
  if (declared.onUndeclared === 'reject') errors.push(...undeclared);
  else warnings.push(...undeclared);

  return { ok: errors.length === 0, errors, warnings, diff };
}
