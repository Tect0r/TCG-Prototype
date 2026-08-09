import { z } from 'zod';
import {
  CardDatabase,
  cardDefinitionSchema,
  cardIdSchema,
  loadBundledCardData,
  type CardDefinition,
  type CardId,
} from '@tcg/card-data';
import { DEFAULT_DECK_FORMAT, type DeckFormatConfig } from '@tcg/deck';
import { DEFAULT_RULES_CONFIG, rulesConfigSchema, type RulesConfig } from '@tcg/rules-engine';
import { canonicalJson, digestOf } from './hash.js';

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
  deckSize: z.number().int().min(1).max(200).default(DEFAULT_DECK_FORMAT.deckSize),
  copyLimit: z.number().int().min(1).max(20).default(DEFAULT_DECK_FORMAT.copyLimit),
  uniqueCopyLimit: z.number().int().min(1).max(20).default(DEFAULT_DECK_FORMAT.uniqueCopyLimit),
  maxCommanderColors: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(DEFAULT_DECK_FORMAT.maxCommanderColors),
});

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
   * Card definitions layered over the bundled set. A definition whose ID already
   * exists *replaces* it — that is how a candidate environment changes a card's
   * numbers without editing the shipped data files.
   */
  cardOverrides: z.array(cardDefinitionSchema).default([]),
  /** When set, only these IDs may appear in a generated or accepted deck. */
  allowCardIds: z.array(cardIdSchema).nullable().default(null),
  banCardIds: z.array(cardIdSchema).default([]),
  deckFormat: deckFormatSchema.prefault({}),
  rulesConfig: rulesConfigSchema.partial().default({}),
});
export type EnvironmentConfig = z.infer<typeof environmentConfigSchema>;
export type EnvironmentConfigInput = z.input<typeof environmentConfigSchema>;

export interface Environment {
  readonly id: string;
  readonly label: string;
  /** Content hash of the whole bundle. Two equal hashes are the same rules. */
  readonly hash: string;
  /** Content hash of just the playable card pool and its definitions. */
  readonly cardPoolHash: string;
  readonly database: CardDatabase;
  readonly deckFormat: DeckFormatConfig;
  readonly rulesConfig: RulesConfig;
  /** Deckable, collectible, allowed cards — the pool deck generation draws from. */
  readonly pool: readonly CardDefinition[];
  readonly commanders: readonly CardDefinition[];
  readonly config: EnvironmentConfig;
}

let bundled: CardDatabase | undefined;
function bundledDatabase(): CardDatabase {
  bundled ??= loadBundledCardData().database;
  return bundled;
}

export function resolveEnvironment(input: EnvironmentConfigInput): Environment {
  const config = environmentConfigSchema.parse(input);

  const byId = new Map<CardId, CardDefinition>(
    bundledDatabase()
      .all()
      .map((card) => [card.id, card]),
  );
  for (const override of config.cardOverrides) byId.set(override.id, override);
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

  // Only the cards that can actually appear in a match contribute to the pool
  // hash, so banning a card nobody could play does not invalidate a comparison.
  const cardPoolHash = digestOf({
    pool: pool.map((card) => card),
    commanders: commanders.map((card) => card),
  });

  return {
    id: config.id,
    label: config.label || config.id,
    hash: digestOf({ cardPoolHash, rulesConfig, deckFormat }),
    cardPoolHash,
    database,
    deckFormat,
    rulesConfig,
    pool,
    commanders,
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
