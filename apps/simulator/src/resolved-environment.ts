import { z } from 'zod';
import {
  CARD_SCHEMA_VERSION,
  CardDatabase,
  cardDefinitionSchema,
  cardIdSchema,
} from '@tcg/card-data';
import { rulesConfigSchema } from '@tcg/rules-engine';
import { deckFormatSchema, environmentSetSchema, type Environment } from './environment.js';
import {
  computeEnvironmentHashes,
  environmentHashesSchema,
  snapshotCards,
  type EnvironmentHashes,
} from './content-hash.js';
import { canonicalJson } from './hash.js';

/**
 * A frozen, content-addressed environment (readiness §9 G1).
 *
 * ## Why this exists
 *
 * An `EnvironmentConfig` is a *recipe*: "the bundled card set, with these two
 * overrides". A replay bundle that stores the recipe therefore resolves against
 * whatever card data the working tree happens to contain when it is replayed.
 * Edit a card's cost six weeks later and an old replay silently reproduces a
 * different match while still carrying its original environment hash — the
 * artefact claims a reproducibility it does not have.
 *
 * A `ResolvedEnvironment` is the *result*: every card definition that could
 * appear in the match, written out in full, plus the exact rules configuration
 * and deck format. Replaying reads only this. There is deliberately no fallback
 * to the current bundled database, because a fallback is precisely the failure
 * this type exists to make impossible.
 *
 * ## Which cards are in it
 *
 * Every playable card, every Commander, and every token (or other
 * non-deckable definition) those cards can reach. Nothing else: a snapshot is
 * carried in every replay bundle, so including unreachable cards would inflate
 * every artefact for no reproducibility gain.
 *
 * The four hashes it carries are defined in `content-hash.ts`, which is also
 * where the projections they are taken over live — deliberately in a module that
 * depends on neither this one nor `environment.ts`, so a resolved environment and
 * a live one can be hashed by the same code without importing each other.
 */

export const RESOLVED_ENVIRONMENT_SCHEMA_VERSION = 1;

export const resolvedEnvironmentSchema = z.strictObject({
  schemaVersion: z.literal(RESOLVED_ENVIRONMENT_SCHEMA_VERSION),
  environmentId: z.string().min(1),
  label: z.string(),
  /** Card schema version the definitions below were validated against. */
  cardSchemaVersion: z.number().int().min(1),
  /** `RulesConfig.version` the match was created under. */
  rulesVersion: z.string().min(1),
  /**
   * Every definition the match can reach, sorted by ID so the snapshot is
   * byte-identical whenever its content is.
   */
  cards: z.array(cardDefinitionSchema),
  /** Cards a deck may contain in this environment. */
  poolCardIds: z.array(cardIdSchema),
  /** Commanders that may be chosen in this environment. */
  commanderCardIds: z.array(cardIdSchema),
  /**
   * Content sets the cards came from, with their versions. Populated once sets
   * are explicit source manifests; empty means "the bundled prototype data".
   */
  sets: z.array(environmentSetSchema),
  /** Format manifest this environment was selected by, when it had one. */
  formatId: z.string().nullable(),
  rulesConfig: rulesConfigSchema,
  deckFormat: deckFormatSchema,
  hashes: environmentHashesSchema,
});
export type ResolvedEnvironment = z.infer<typeof resolvedEnvironmentSchema>;

/* ---------------------------------------------------------------- freezing */

/**
 * Writes an environment out in full.
 *
 * The snapshot is self-contained by construction: `restoreEnvironment` never
 * consults the bundled database, so anything omitted here would surface as a
 * hard error at replay time rather than as a silent substitution.
 *
 * The hashes are recomputed here rather than copied off the environment, over
 * exactly the card list being written. `resolveEnvironment` hashes the same list,
 * so the two agree — but freezing recomputes so that the numbers in the file
 * always describe the file, not whatever produced it.
 */
export function freezeEnvironment(environment: Environment): ResolvedEnvironment {
  const cards = snapshotCards(environment.pool, environment.commanders, environment.database);
  const poolCardIds = environment.pool.map((card) => card.id).sort();
  const commanderCardIds = environment.commanders.map((card) => card.id).sort();

  return {
    schemaVersion: RESOLVED_ENVIRONMENT_SCHEMA_VERSION,
    environmentId: environment.id,
    label: environment.label,
    cardSchemaVersion: CARD_SCHEMA_VERSION,
    rulesVersion: environment.rulesConfig.version,
    cards,
    poolCardIds,
    commanderCardIds,
    sets: [...environment.sets],
    formatId: environment.formatId,
    rulesConfig: environment.rulesConfig,
    deckFormat: environment.deckFormat,
    hashes: computeEnvironmentHashes({
      cards,
      rulesConfig: environment.rulesConfig,
      deckFormat: environment.deckFormat,
      poolCardIds,
      commanderCardIds,
    }),
  };
}

/**
 * Recomputes a snapshot's hashes from its own content.
 *
 * A snapshot whose stored hashes disagree with its content has been edited, and
 * is a hard error rather than a warning: it is the one artefact the whole replay
 * guarantee rests on.
 */
export function verifyEnvironmentHashes(snapshot: ResolvedEnvironment): string[] {
  const recomputed = computeEnvironmentHashes({
    cards: snapshot.cards,
    rulesConfig: snapshot.rulesConfig,
    deckFormat: snapshot.deckFormat,
    poolCardIds: snapshot.poolCardIds,
    commanderCardIds: snapshot.commanderCardIds,
  });
  const problems: string[] = [];
  for (const key of Object.keys(recomputed) as (keyof EnvironmentHashes)[]) {
    if (recomputed[key] === snapshot.hashes[key]) continue;
    problems.push(
      `${key} does not match the snapshot's own content: stored ${snapshot.hashes[key]}, ` +
        `recomputed ${recomputed[key]}. The frozen environment has been edited.`,
    );
  }
  return problems;
}

/**
 * Rebuilds a usable `Environment` from a frozen snapshot.
 *
 * Deliberately does **not** merge in the bundled card database. A snapshot that
 * is missing a card the replay needs must fail loudly at lookup time, not
 * silently resolve against whatever the repository contains today.
 */
export function restoreEnvironment(snapshot: ResolvedEnvironment): Environment {
  const problems = verifyEnvironmentHashes(snapshot);
  if (problems.length > 0) {
    throw new Error(
      `Frozen environment "${snapshot.environmentId}" failed hash verification:\n  ` +
        problems.join('\n  '),
    );
  }

  const database = new CardDatabase([...snapshot.cards]);
  const poolIds = new Set(snapshot.poolCardIds);
  const commanderIds = new Set(snapshot.commanderCardIds);

  const pool = snapshot.cards.filter((card) => poolIds.has(card.id));
  const commanders = snapshot.cards.filter((card) => commanderIds.has(card.id));

  return {
    id: snapshot.environmentId,
    label: snapshot.label || snapshot.environmentId,
    hash: snapshot.hashes.fullContentHash,
    hashes: snapshot.hashes,
    cardPoolHash: snapshot.hashes.mechanicsHash,
    database,
    deckFormat: snapshot.deckFormat,
    rulesConfig: rulesConfigSchema.parse(snapshot.rulesConfig),
    pool,
    commanders,
    sets: snapshot.sets,
    formatId: snapshot.formatId,
    // A restored environment has no recipe: it *is* the result. Reconstructing a
    // plausible-looking config would invite someone to re-resolve it against the
    // current card data, which is the whole failure this type prevents.
    config: {
      id: snapshot.environmentId,
      label: snapshot.label,
      cardOverrides: [...snapshot.cards],
      cardPatches: [],
      allowCardIds: [...snapshot.poolCardIds, ...snapshot.commanderCardIds].sort(),
      banCardIds: [],
      deckFormat: snapshot.deckFormat,
      rulesConfig: snapshot.rulesConfig,
      sets: [],
      format: snapshot.formatId,
    },
  };
}

/** Stable file name for a snapshot, keyed by its own content. */
export function snapshotFileName(snapshot: ResolvedEnvironment): string {
  return `${snapshot.environmentId}.${snapshot.hashes.fullContentHash}.json`;
}

/** Canonical serialization, so two equal snapshots are byte-identical on disk. */
export function serializeSnapshot(snapshot: ResolvedEnvironment): string {
  return canonicalJson(snapshot);
}
