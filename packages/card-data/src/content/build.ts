import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { error, hasErrors, warning, type Issue } from '@tcg/shared';
import {
  cardDefinitionSchema,
  cardSetSchema,
  type CardDefinition,
  type CardSet,
} from '../schema/card.js';
import { playFormatSchema, type PlayFormat } from '../schema/format.js';
import { preconDefinitionSchema, type PreconDefinition } from '../schema/precon.js';
import {
  deckPlanSchema,
  MAX_PLAN_SHARE,
  planCardIds,
  planSlotCount,
  type DeckPlan,
} from '../schema/deck-plan.js';
import { CARD_SCHEMA_VERSION, STRICT_SET_STATUSES } from '../schema/primitives.js';
import { archetypeGaps, missingRolesOf } from '../archetype.js';
import { describeCardSupport, limitingMechanics, mechanicKey } from '../support.js';
import { loadCardSets, zodIssuesToIssues } from '../loader.js';
import { migrateCardSet } from '../migrate.js';
import {
  CONTENT_BUNDLE_SCHEMA_VERSION,
  CONTENT_SOURCE_DIR,
  GENERATED_BANNER,
  setManifestSchema,
} from './source.js';

/** Sub-directories of a set that hold card files. Both are optional. */
const CARD_DIRS = ['cards', 'tokens'] as const;

export interface ContentBundle {
  readonly schemaVersion: number;
  readonly generated: string;
  readonly sets: readonly CardSet[];
  readonly formats: readonly PlayFormat[];
  readonly precons: readonly PreconDefinition[];
  /** Authored package structure, one plan per strategy (M05.5). */
  readonly deckPlans: readonly DeckPlan[];
}

export interface BuildContentResult {
  readonly bundle: ContentBundle;
  readonly warnings: readonly Issue[];
}

/** Lists `*.json` files in a directory in stable, locale-independent order. */
function jsonFilesIn(dir: string): string[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function directoriesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Repo-relative POSIX path, so an error message reads the same on every OS. */
function displayPath(root: string, absolute: string): string {
  const relative = absolute.startsWith(root) ? absolute.slice(root.length + 1) : absolute;
  return relative.split(sep).join(posix.sep);
}

function readJson(path: string, label: string): { value: unknown } | { issue: Issue } {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) as unknown };
  } catch (cause) {
    return {
      issue: error(
        'content/unreadable',
        `${label} is not valid JSON: ${(cause as Error).message}`,
        {
          path: label,
        },
      ),
    };
  }
}

/**
 * Reads `content/` and assembles the bundle the runtime consumes.
 *
 * Every error carries the source file it came from — with one card per file,
 * "which card is broken" should never require a search (readiness spec C1.2).
 */
export function buildContent(root: string): { bundle?: ContentBundle; issues: Issue[] } {
  const issues: Issue[] = [];
  const contentRoot = join(root, CONTENT_SOURCE_DIR);
  const setsRoot = join(contentRoot, 'sets');

  if (!existsSync(setsRoot)) {
    return {
      issues: [
        error('content/missing_source', `No card content found at ${CONTENT_SOURCE_DIR}/sets.`),
      ],
    };
  }

  const sets: CardSet[] = [];

  for (const setDir of directoriesIn(setsRoot)) {
    const setPath = join(setsRoot, setDir);
    const manifestPath = join(setPath, 'set.json');
    const manifestLabel = displayPath(root, manifestPath);

    if (!existsSync(manifestPath)) {
      issues.push(
        error('content/missing_manifest', `Set directory "${setDir}" has no set.json.`, {
          path: manifestLabel,
        }),
      );
      continue;
    }

    const rawManifest = readJson(manifestPath, manifestLabel);
    if ('issue' in rawManifest) {
      issues.push(rawManifest.issue);
      continue;
    }

    const manifest = setManifestSchema.safeParse(rawManifest.value);
    if (!manifest.success) {
      issues.push(...zodIssuesToIssues(manifest.error, manifestLabel));
      continue;
    }

    // The directory name is the set's identity on disk; a mismatch means one of
    // the two is a typo and there is no way to tell which.
    if (manifest.data.setId !== setDir) {
      issues.push(
        error(
          'content/set_id_mismatch',
          `Set directory "${setDir}" declares setId "${manifest.data.setId}". They must agree.`,
          { path: manifestLabel, context: { directory: setDir, setId: manifest.data.setId } },
        ),
      );
      continue;
    }

    const rawCards: { label: string; body: object }[] = [];
    let cardFileError = false;

    for (const cardDir of CARD_DIRS) {
      const dirPath = join(setPath, cardDir);
      for (const fileName of jsonFilesIn(dirPath)) {
        const filePath = join(dirPath, fileName);
        const label = displayPath(root, filePath);
        const raw = readJson(filePath, label);
        if ('issue' in raw) {
          issues.push(raw.issue);
          cardFileError = true;
          continue;
        }
        const body = raw.value;
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          issues.push(
            error('content/malformed_card', 'A card file must contain a JSON object.', {
              path: label,
            }),
          );
          cardFileError = true;
          continue;
        }

        const expectedId = fileName.slice(0, -'.json'.length);
        const declaredId = (body as { id?: unknown }).id;
        if (declaredId !== expectedId) {
          issues.push(
            error(
              'content/card_id_mismatch',
              `File "${fileName}" declares id ${JSON.stringify(declaredId)}. The filename and the permanent card ID must agree.`,
              { path: label, context: { fileName, declaredId: String(declaredId) } },
            ),
          );
          cardFileError = true;
          continue;
        }

        if ('schemaVersion' in body) {
          issues.push(
            error(
              'content/card_schema_version',
              'A card file must not declare schemaVersion; its set.json owns the version for the whole set.',
              { path: label },
            ),
          );
          cardFileError = true;
          continue;
        }

        rawCards.push({ label, body: body as object });
      }
    }

    if (cardFileError) continue;

    // A set may declare an older schema version; migrations run here so the
    // sources do not have to be rewritten by hand on every schema bump, exactly
    // as they would for a persisted set arriving through `loadCardSets`. The
    // card order is preserved, so each migrated card keeps its filename.
    const migratedSet = migrateCardSet(
      {
        schemaVersion: manifest.data.schemaVersion,
        cards: rawCards.map((entry) => ({
          ...entry.body,
          schemaVersion: manifest.data.schemaVersion,
        })),
      },
      manifest.data.schemaVersion,
    );
    const migratedCards = Array.isArray(migratedSet['cards']) ? migratedSet['cards'] : [];

    const cards: CardDefinition[] = [];
    for (const [index, candidate] of migratedCards.entries()) {
      // Validated one file at a time so a schema complaint is reported against
      // the file that caused it rather than an array index (readiness C1.2).
      const label = rawCards[index]?.label ?? `content/sets/${setDir}`;
      const parsedCard = cardDefinitionSchema.safeParse(candidate);
      if (!parsedCard.success) {
        issues.push(...zodIssuesToIssues(parsedCard.error, label));
        cardFileError = true;
        continue;
      }
      cards.push(parsedCard.data);
    }

    if (cardFileError) continue;

    if (cards.length === 0) {
      issues.push(
        error('content/empty_set', `Set "${setDir}" contains no card files.`, {
          path: displayPath(root, setPath),
        }),
      );
      continue;
    }

    const parsedSet = cardSetSchema.safeParse({
      // The bundle always carries the current version: migrations already ran.
      schemaVersion: CARD_SCHEMA_VERSION,
      setId: manifest.data.setId,
      name: manifest.data.name,
      status: manifest.data.status,
      ...(manifest.data.description ? { description: manifest.data.description } : {}),
      cards,
    });
    if (!parsedSet.success) {
      issues.push(...zodIssuesToIssues(parsedSet.error, `content/sets/${setDir}`));
      continue;
    }

    // Stable order regardless of filesystem enumeration, so the emitted bundle
    // is byte-identical on every machine.
    sets.push({
      ...parsedSet.data,
      cards: [...parsedSet.data.cards].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    });
  }

  const formats: PlayFormat[] = [];
  const formatsRoot = join(contentRoot, 'formats');
  for (const fileName of jsonFilesIn(formatsRoot)) {
    const filePath = join(formatsRoot, fileName);
    const label = displayPath(root, filePath);
    const raw = readJson(filePath, label);
    if ('issue' in raw) {
      issues.push(raw.issue);
      continue;
    }
    const parsed = playFormatSchema.safeParse(raw.value);
    if (!parsed.success) {
      issues.push(...zodIssuesToIssues(parsed.error, label));
      continue;
    }
    const expectedId = fileName.slice(0, -'.json'.length);
    if (parsed.data.formatId !== expectedId) {
      issues.push(
        error(
          'content/format_id_mismatch',
          `File "${fileName}" declares formatId "${parsed.data.formatId}". They must agree.`,
          { path: label },
        ),
      );
      continue;
    }
    formats.push(parsed.data);
  }

  const precons: PreconDefinition[] = [];
  const preconsRoot = join(contentRoot, 'precons');
  for (const fileName of jsonFilesIn(preconsRoot)) {
    const filePath = join(preconsRoot, fileName);
    const label = displayPath(root, filePath);
    const raw = readJson(filePath, label);
    if ('issue' in raw) {
      issues.push(raw.issue);
      continue;
    }
    const parsed = preconDefinitionSchema.safeParse(raw.value);
    if (!parsed.success) {
      issues.push(...zodIssuesToIssues(parsed.error, label));
      continue;
    }
    if (parsed.data.id !== fileName.slice(0, -'.json'.length)) {
      issues.push(
        error(
          'content/precon_id_mismatch',
          `File "${fileName}" declares id "${parsed.data.id}". They must agree.`,
          { path: label },
        ),
      );
      continue;
    }
    precons.push(parsed.data);
  }

  const deckPlans: DeckPlan[] = [];
  const plansRoot = join(contentRoot, 'deck-plans');
  for (const fileName of jsonFilesIn(plansRoot)) {
    const filePath = join(plansRoot, fileName);
    const label = displayPath(root, filePath);
    const raw = readJson(filePath, label);
    if ('issue' in raw) {
      issues.push(raw.issue);
      continue;
    }
    const parsed = deckPlanSchema.safeParse(raw.value);
    if (!parsed.success) {
      issues.push(...zodIssuesToIssues(parsed.error, label));
      continue;
    }
    if (parsed.data.id !== fileName.slice(0, -'.json'.length)) {
      issues.push(
        error(
          'content/deck_plan_id_mismatch',
          `File "${fileName}" declares id "${parsed.data.id}". They must agree.`,
          { path: label },
        ),
      );
      continue;
    }
    deckPlans.push(parsed.data);
  }

  if (hasErrors(issues)) return { issues };

  issues.push(...validateCrossReferences(sets, formats, precons, deckPlans));
  if (hasErrors(issues)) return { issues };

  const bundle: ContentBundle = {
    schemaVersion: CONTENT_BUNDLE_SCHEMA_VERSION,
    generated: GENERATED_BANNER,
    sets,
    formats,
    precons,
    deckPlans,
  };

  return { bundle, issues };
}

/**
 * Cross-file rules: references resolve, IDs are unique across sets, formats
 * select real sets, and a strict-status set carries no warnings.
 */
function validateCrossReferences(
  sets: readonly CardSet[],
  formats: readonly PlayFormat[],
  precons: readonly PreconDefinition[],
  deckPlans: readonly DeckPlan[],
): Issue[] {
  const issues: Issue[] = [];

  const setOfCard = new Map<string, string>();
  for (const set of sets) {
    for (const card of set.cards) {
      const owner = setOfCard.get(card.id);
      if (owner !== undefined) {
        issues.push(
          error(
            'content/duplicate_card_id',
            `Card "${card.id}" is defined in both "${owner}" and "${set.setId}". A card belongs to exactly one set.`,
            { context: { cardId: card.id, sets: [owner, set.setId] } },
          ),
        );
        continue;
      }
      setOfCard.set(card.id, set.setId);
    }
  }

  const knownSets = new Set(sets.map((set) => set.setId));
  const formatIds = new Set<string>();
  for (const format of formats) {
    if (formatIds.has(format.formatId)) {
      issues.push(
        error('content/duplicate_format_id', `Duplicate format ID "${format.formatId}".`, {
          context: { formatId: format.formatId },
        }),
      );
    }
    formatIds.add(format.formatId);

    for (const setId of format.setIds) {
      if (!knownSets.has(setId)) {
        issues.push(
          error(
            'content/unknown_set',
            `Format "${format.formatId}" includes set "${setId}", which does not exist.`,
            { path: `content/formats/${format.formatId}.json`, context: { setId } },
          ),
        );
      }
    }
    for (const cardId of format.bannedCardIds) {
      if (!setOfCard.has(cardId)) {
        issues.push(
          error(
            'content/unknown_banned_card',
            `Format "${format.formatId}" bans "${cardId}", which is not defined in any set.`,
            { path: `content/formats/${format.formatId}.json`, context: { cardId } },
          ),
        );
      }
    }
  }

  // A precon must name a format that exists and cards that format contains.
  // Full legality (size, singleton, colour identity) is `validatePrecon`'s job
  // in @tcg/deck; what belongs here is that the *references resolve*.
  const formatSets = new Map(formats.map((format) => [format.formatId, new Set(format.setIds)]));
  const preconIds = new Set<string>();
  for (const precon of precons) {
    if (preconIds.has(precon.id)) {
      issues.push(
        error('content/duplicate_precon_id', `Duplicate precon ID "${precon.id}".`, {
          context: { preconId: precon.id },
        }),
      );
    }
    preconIds.add(precon.id);

    const includedSets = formatSets.get(precon.formatId);
    if (!includedSets) {
      issues.push(
        error(
          'content/precon_unknown_format',
          `Precon "${precon.id}" declares format "${precon.formatId}", which does not exist.`,
          { path: `content/precons/${precon.id}.json`, context: { formatId: precon.formatId } },
        ),
      );
      continue;
    }
    for (const cardId of [precon.commanderId, ...precon.cardIds]) {
      const owner = setOfCard.get(cardId);
      if (owner === undefined || !includedSets.has(owner)) {
        issues.push(
          error(
            'content/precon_unknown_card',
            `Precon "${precon.id}" references "${cardId}", which is not in the "${precon.formatId}" pool.`,
            { path: `content/precons/${precon.id}.json`, context: { cardId } },
          ),
        );
      }
    }
  }

  issues.push(...validateDeckPlans(deckPlans, formats, precons, setOfCard));

  // An unsupported card is an inventory item, not a silent gap: it warns in a
  // draft set and is rejected outright in one people will play with.
  for (const set of sets) {
    const strict = STRICT_SET_STATUSES.includes(set.status);
    for (const card of set.cards) {
      if (card.implemented) continue;
      const message = `"${card.name}" (${card.id}) is not implemented: ${card.unsupportedReason}`;
      issues.push(
        strict
          ? error('content/unimplemented_card', `[${set.setId}] ${message}`, {
              path: `content/sets/${set.setId}/cards/${card.id}.json`,
              context: { cardId: card.id, setId: set.setId },
            })
          : warning('content/unimplemented_card', message, {
              path: `content/sets/${set.setId}/cards/${card.id}.json`,
              context: { cardId: card.id, setId: set.setId },
            }),
      );
    }
  }

  // Support is *derived*, never read off the card (M05.1). `implemented: true`
  // is a sentence an author typed; this walks the structured data the engine
  // actually executes and asks the mechanic support registry about every piece
  // of it. A set nobody will play with may carry an inert mechanic and be told
  // so; a `playtest` or `active` set may not, which is what keeps an unfinished
  // keyword out of playable content without anybody having to remember.
  for (const set of sets) {
    const strict = STRICT_SET_STATUSES.includes(set.status);
    for (const card of set.cards) {
      const support = describeCardSupport(card);
      if (support.executable) continue;
      const inert = limitingMechanics(support.mechanics, 'engine').map(mechanicKey);
      const message =
        `"${card.name}" (${card.id}) is built on ${inert.length === 1 ? 'a mechanic' : 'mechanics'} ` +
        `the rules engine does not execute: ${inert.join(', ')}.`;
      const context = { cardId: card.id, setId: set.setId, mechanics: inert.join(',') };
      const path = `content/sets/${set.setId}/cards/${card.id}.json`;
      issues.push(
        strict
          ? error('content/unsupported_mechanic', `[${set.setId}] ${message}`, { path, context })
          : warning('content/unsupported_mechanic', message, { path, context }),
      );
    }
  }

  // The loader owns token resolution, colour leak and display-text linting.
  // Running it here means the content build fails on the same rules the runtime
  // would, rather than shipping a bundle that only breaks at startup.
  const loaded = loadCardSets(sets);
  if (!loaded.ok) return [...issues, ...loaded.error];

  const strictSets = new Set(
    sets.filter((set) => STRICT_SET_STATUSES.includes(set.status)).map((set) => set.setId),
  );
  for (const problem of loaded.value.warnings) {
    const cardId = (problem.context as { cardId?: string } | undefined)?.cardId;
    const owningSet = cardId ? setOfCard.get(cardId) : undefined;
    if (owningSet !== undefined && strictSets.has(owningSet)) {
      // Warnings are fine for a fixture set and unacceptable for one people
      // will playtest with (readiness spec C4).
      issues.push(
        error(problem.code, `[${owningSet}] ${problem.message}`, {
          ...(problem.path ? { path: problem.path } : {}),
          ...(problem.context ? { context: problem.context } : {}),
        }),
      );
    } else {
      issues.push(problem);
    }
  }

  return issues;
}

/**
 * Deck-plan rules (M05.5).
 *
 * A plan is a *claim about a deck*, so all of it is checkable and all of it is
 * checked here rather than at run time: the archetype exists, the format exists,
 * every card is in that format's pool, the packages do not overlap, the
 * archetype's required roles are all supplied, the plan leaves room for a search
 * to explore outside it, and — when the plan names a precon — the Commander and
 * every card actually belong to that precon.
 *
 * Every one of these is an error rather than a warning, in every set status.
 * A `development` set may contain a card the engine cannot run, because that is
 * inventory; a plan that misdescribes a deck is not inventory, it is a search
 * input that would quietly steer a whole population wrong.
 */
function validateDeckPlans(
  deckPlans: readonly DeckPlan[],
  formats: readonly PlayFormat[],
  precons: readonly PreconDefinition[],
  setOfCard: ReadonlyMap<string, string>,
): Issue[] {
  const issues: Issue[] = [];
  if (deckPlans.length === 0) return issues;

  // The registry is a compile-time total `Record`; this is the runtime twin, and
  // it runs here because a plan arrives as JSON and never sees the type.
  for (const problem of archetypeGaps()) {
    issues.push(error('content/archetype_registry_gap', problem));
  }

  const formatById = new Map(formats.map((format) => [format.formatId, format]));
  const preconById = new Map(precons.map((precon) => [precon.id, precon]));
  const planIds = new Set<string>();

  for (const plan of deckPlans) {
    const path = `content/deck-plans/${plan.id}.json`;
    const context = { deckPlanId: plan.id };

    if (planIds.has(plan.id)) {
      issues.push(
        error('content/duplicate_deck_plan_id', `Duplicate deck plan ID "${plan.id}".`, {
          path,
          context,
        }),
      );
    }
    planIds.add(plan.id);

    const packageIds = new Set<string>();
    const owner = new Map<string, string>();
    for (const group of plan.packages) {
      if (packageIds.has(group.id)) {
        issues.push(
          error(
            'content/duplicate_package_id',
            `Deck plan "${plan.id}" declares package "${group.id}" twice.`,
            { path, context },
          ),
        );
      }
      packageIds.add(group.id);

      for (const cardId of group.cardIds) {
        const holder = owner.get(cardId);
        if (holder !== undefined) {
          // Overlapping packages would make "is this package intact" ambiguous
          // and would let one removal break two packages at once.
          issues.push(
            error(
              'content/package_card_overlap',
              `Deck plan "${plan.id}" lists "${cardId}" in both "${holder}" and "${group.id}". A card belongs to at most one package.`,
              { path, context: { ...context, cardId } },
            ),
          );
          continue;
        }
        owner.set(cardId, group.id);
      }
    }

    const missing = missingRolesOf(plan);
    if (missing.length > 0) {
      issues.push(
        error(
          'content/deck_plan_incomplete',
          `Deck plan "${plan.id}" claims archetype "${plan.archetypeId}" but supplies no ${missing.join(', ')} package.`,
          { path, context: { ...context, missing: missing.join(',') } },
        ),
      );
    }
    if (!plan.packages.some((group) => group.core)) {
      issues.push(
        error(
          'content/deck_plan_no_core',
          `Deck plan "${plan.id}" marks no package core, so there is nothing for a search to protect or replace.`,
          { path, context },
        ),
      );
    }

    const format = formatById.get(plan.formatId);
    if (!format) {
      issues.push(
        error(
          'content/deck_plan_unknown_format',
          `Deck plan "${plan.id}" declares format "${plan.formatId}", which does not exist.`,
          { path, context: { ...context, formatId: plan.formatId } },
        ),
      );
      continue;
    }

    const includedSets = new Set(format.setIds);
    const banned = new Set(format.bannedCardIds);
    for (const cardId of [plan.commanderId, ...planCardIds(plan)]) {
      const set = setOfCard.get(cardId);
      if (set === undefined || !includedSets.has(set) || banned.has(cardId)) {
        issues.push(
          error(
            'content/deck_plan_unknown_card',
            `Deck plan "${plan.id}" references "${cardId}", which is not in the "${plan.formatId}" pool.`,
            { path, context: { ...context, cardId } },
          ),
        );
      }
    }

    // The ceiling is the structural half of "search must remain able to explore
    // outside plans": a plan that could fill a deck would make that a matter of
    // generator configuration instead of a property of the data.
    const slots = planSlotCount(plan);
    const ceiling = Math.floor(format.deck.size * MAX_PLAN_SHARE);
    if (slots > ceiling) {
      issues.push(
        error(
          'content/deck_plan_too_large',
          `Deck plan "${plan.id}" asks for ${slots} of ${format.deck.size} slots; at most ${ceiling} (${Math.round(MAX_PLAN_SHARE * 100)}%) may be planned so a search always has room to explore outside it.`,
          { path, context: { ...context, slots: String(slots), ceiling: String(ceiling) } },
        ),
      );
    }

    if (plan.preconId === undefined) continue;

    const precon = preconById.get(plan.preconId);
    if (!precon) {
      issues.push(
        error(
          'content/deck_plan_unknown_precon',
          `Deck plan "${plan.id}" describes precon "${plan.preconId}", which does not exist.`,
          { path, context: { ...context, preconId: plan.preconId } },
        ),
      );
      continue;
    }
    if (precon.formatId !== plan.formatId) {
      issues.push(
        error(
          'content/deck_plan_precon_format',
          `Deck plan "${plan.id}" is built to "${plan.formatId}" but describes precon "${precon.id}", which is built to "${precon.formatId}".`,
          { path, context: { ...context, preconId: precon.id } },
        ),
      );
    }
    if (precon.commanderId !== plan.commanderId) {
      issues.push(
        error(
          'content/deck_plan_precon_commander',
          `Deck plan "${plan.id}" names Commander "${plan.commanderId}" but precon "${precon.id}" runs "${precon.commanderId}".`,
          { path, context: { ...context, preconId: precon.id } },
        ),
      );
    }
    // A plan that names a precon is describing *that* deck, so a card the precon
    // does not run makes the description false rather than merely aspirational.
    const inPrecon = new Set(precon.cardIds);
    for (const cardId of planCardIds(plan)) {
      if (inPrecon.has(cardId)) continue;
      issues.push(
        error(
          'content/deck_plan_card_not_in_precon',
          `Deck plan "${plan.id}" packages "${cardId}", which precon "${precon.id}" does not contain.`,
          { path, context: { ...context, cardId, preconId: precon.id } },
        ),
      );
    }
  }

  return issues;
}

/**
 * Serializes the bundle exactly as it is written to disk.
 *
 * `--check` compares this string to the checked-in file, so the formatting here
 * is part of the contract: two spaces, trailing newline, and whatever key order
 * `buildContent` produced.
 */
export function serializeBundle(bundle: ContentBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** Warnings only; `buildContent` already folded strict-set warnings into errors. */
export function warningsOfBuild(issues: readonly Issue[]): readonly Issue[] {
  return issues.filter((problem) => problem.severity === 'warning');
}
