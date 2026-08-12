/**
 * The `cards:new` scaffolder, separated from its CLI shell.
 *
 * The logic lives here so it can be exercised against every card type without
 * spawning a process or writing into the repository's own `content/` tree: the
 * only thing a caller has to redirect is `root`. Templates are always read from
 * the repository, because the thing worth proving is that the *shipped*
 * template for each type still scaffolds into legal content.
 *
 * It deliberately knows nothing about game design: it copies a template,
 * rewrites identity, and stops. Names, mechanics, lore and balance are the
 * author's job (readiness spec C2).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_ID_PATTERN, CARD_TYPES, type CardType } from '@tcg/card-data';

/** The repository root: the default content root, and the template source. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The shipped card templates. */
export const TEMPLATE_DIR = join(REPO_ROOT, 'docs/templates/cards');

/** Default template per card type. `--template` overrides it. */
export const DEFAULT_TEMPLATE: Record<CardType, string> = {
  unit: 'template_basic_unit',
  spell: 'template_basic_spell',
  reaction: 'template_basic_reaction',
  relic: 'template_static_relic',
  commander: 'template_commander',
  token: 'template_token',
};

/**
 * A refusal to scaffold: a bad argument, a missing set, an occupied card ID.
 *
 * Distinct from an ordinary exception so the CLI can print it as a one-line
 * message and exit 1, while a caller in-process can assert on it.
 */
export class ScaffoldError extends Error {
  override readonly name = 'ScaffoldError';
}

export interface ScaffoldOptions {
  /** Root the `content/sets/<setId>/…` target path is resolved against. */
  readonly root?: string;
}

export interface ScaffoldResult {
  /** Absolute path of the file written. */
  readonly targetPath: string;
  /** The same path relative to the content root, for messages. */
  readonly relativePath: string;
  /** The template the card was copied from. */
  readonly templateName: string;
  /** The card body as written, in its final key order. */
  readonly card: Record<string, unknown>;
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
    } else {
      args[token.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return args;
}

function isCardType(value: string): value is CardType {
  return (CARD_TYPES as readonly string[]).includes(value);
}

function titleCase(cardId: string): string {
  return cardId
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** The `--help` text, listing the real card types and the real templates. */
export function usage(templateDir: string = TEMPLATE_DIR): string {
  return (
    'Usage: npm run cards:new -- --set <setId> --type <type> --id <card_id> [--template <name>]\n' +
    `  types:     ${CARD_TYPES.join(', ')}\n` +
    `  templates: ${readdirSync(templateDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .join(', ')}\n`
  );
}

/** Writes one placeholder card file, or throws `ScaffoldError` explaining why not. */
export function scaffoldCard(
  argv: readonly string[],
  options: ScaffoldOptions = {},
): ScaffoldResult {
  const root = options.root ?? REPO_ROOT;
  const args = parseArgs(argv);

  const setId = args.set;
  const cardId = args.id;
  const type = args.type;

  if (!setId) throw new ScaffoldError('--set is required.');
  if (!cardId) throw new ScaffoldError('--id is required.');
  if (!type) throw new ScaffoldError(`--type is required (one of ${CARD_TYPES.join(', ')}).`);
  if (!isCardType(type)) {
    throw new ScaffoldError(
      `unknown card type "${type}". Expected one of ${CARD_TYPES.join(', ')}.`,
    );
  }
  if (!CARD_ID_PATTERN.test(cardId)) {
    throw new ScaffoldError(
      `"${cardId}" is not a legal card ID. Use lowercase_english_snake_case starting with a letter.`,
    );
  }

  const setDir = join(root, 'content/sets', setId);
  if (!existsSync(join(setDir, 'set.json'))) {
    throw new ScaffoldError(
      `set "${setId}" does not exist. Expected content/sets/${setId}/set.json.`,
    );
  }

  // Tokens live beside the cards that create them but are not deckable, so they
  // get their own directory — the content build reads both.
  const subDirectory = type === 'token' ? 'tokens' : 'cards';
  const targetPath = join(setDir, subDirectory, `${cardId}.json`);

  // A card ID is permanent. Overwriting one silently would rewrite whatever the
  // existing decks, replays and logs already mean by that ID.
  for (const dir of ['cards', 'tokens']) {
    const candidate = join(setDir, dir, `${cardId}.json`);
    if (existsSync(candidate)) {
      throw new ScaffoldError(
        `content/sets/${setId}/${dir}/${cardId}.json already exists. Card IDs are permanent.`,
      );
    }
  }

  const templateName = args.template ?? DEFAULT_TEMPLATE[type];
  const templatePath = join(TEMPLATE_DIR, `${templateName}.json`);
  if (!existsSync(templatePath)) {
    throw new ScaffoldError(`template "${templateName}" does not exist in docs/templates/cards.`);
  }

  const parsed: unknown = JSON.parse(readFileSync(templatePath, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ScaffoldError(`template "${templateName}" does not contain a JSON object.`);
  }
  const template: Record<string, unknown> = { ...parsed };
  if (template.type !== type) {
    throw new ScaffoldError(
      `template "${templateName}" is a ${String(template.type)}, but --type is "${type}". Pass a matching --template.`,
    );
  }

  // `schemaVersion` is owned by set.json, so a card file must not carry one.
  delete template.schemaVersion;
  const card: Record<string, unknown> = { ...template, id: cardId, name: titleCase(cardId) };
  // Placeholder prose from the template would otherwise read as real rules text.
  delete card.text;
  card.displayText = 'TODO: describe this card, generated from its structured effects.';

  // `id`, `name` and `type` first; the rest keeps the template's order.
  const ordered: Record<string, unknown> = {
    id: card.id,
    name: card.name,
    type: card.type,
    ...Object.fromEntries(
      Object.entries(card).filter(([key]) => !['id', 'name', 'type'].includes(key)),
    ),
  };

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(ordered, null, 2)}\n`);

  return {
    targetPath,
    relativePath: `content/sets/${setId}/${subDirectory}/${cardId}.json`,
    templateName,
    card: ordered,
  };
}
