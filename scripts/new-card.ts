/**
 * Card scaffolder — `npm run cards:new -- --set <setId> --type <type> --id <cardId>`.
 *
 * Writes one placeholder card file into `content/sets/<setId>/`. It deliberately
 * knows nothing about game design: it copies a template, rewrites identity, and
 * stops. Names, mechanics, lore and balance are the author's job (readiness
 * spec C2).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CARD_ID_PATTERN, CARD_TYPES, type CardType } from '@tcg/card-data';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = join(ROOT, 'docs/templates/cards');

/** Default template per card type. `--template` overrides it. */
const DEFAULT_TEMPLATE: Record<CardType, string> = {
  unit: 'template_basic_unit',
  spell: 'template_basic_spell',
  relic: 'template_static_relic',
  commander: 'template_commander',
  token: 'template_token',
};

function parseArgs(argv: readonly string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
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

function fail(message: string): never {
  process.stderr.write(`cards:new: ${message}\n`);
  process.exit(1);
}

function titleCase(cardId: string): string {
  return cardId
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function main(argv: readonly string[]): void {
  const args = parseArgs(argv);

  if (args.help !== undefined || argv.length === 0) {
    process.stdout.write(
      'Usage: npm run cards:new -- --set <setId> --type <type> --id <card_id> [--template <name>]\n' +
        `  types:     ${CARD_TYPES.join(', ')}\n` +
        `  templates: ${readdirSync(TEMPLATE_DIR)
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.slice(0, -5))
          .join(', ')}\n`,
    );
    return;
  }

  const setId = args.set;
  const cardId = args.id;
  const type = args.type as CardType;

  if (!setId) fail('--set is required.');
  if (!cardId) fail('--id is required.');
  if (!type) fail(`--type is required (one of ${CARD_TYPES.join(', ')}).`);
  if (!CARD_TYPES.includes(type)) {
    fail(`unknown card type "${type}". Expected one of ${CARD_TYPES.join(', ')}.`);
  }
  if (!CARD_ID_PATTERN.test(cardId)) {
    fail(
      `"${cardId}" is not a legal card ID. Use lowercase_english_snake_case starting with a letter.`,
    );
  }

  const setDir = join(ROOT, 'content/sets', setId);
  if (!existsSync(join(setDir, 'set.json'))) {
    fail(`set "${setId}" does not exist. Expected content/sets/${setId}/set.json.`);
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
      fail(`content/sets/${setId}/${dir}/${cardId}.json already exists. Card IDs are permanent.`);
    }
  }

  const templateName = args.template ?? DEFAULT_TEMPLATE[type];
  const templatePath = join(TEMPLATE_DIR, `${templateName}.json`);
  if (!existsSync(templatePath)) {
    fail(`template "${templateName}" does not exist in docs/templates/cards.`);
  }

  const template = JSON.parse(readFileSync(templatePath, 'utf8')) as Record<string, unknown>;
  if (template.type !== type) {
    fail(
      `template "${templateName}" is a ${String(template.type)}, but --type is "${type}". Pass a matching --template.`,
    );
  }

  // `schemaVersion` is owned by set.json, so a card file must not carry one.
  delete template.schemaVersion;
  const card = { ...template, id: cardId, name: titleCase(cardId) };
  // Placeholder prose from the template would otherwise read as real rules text.
  delete card.text;
  card.displayText = 'TODO: describe this card, generated from its structured effects.';

  // `id`, `name` and `type` first; the rest keeps the template's order.
  const ordered = {
    id: card.id,
    name: card.name,
    type: card.type,
    ...Object.fromEntries(
      Object.entries(card).filter(([key]) => !['id', 'name', 'type'].includes(key)),
    ),
  };

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(ordered, null, 2)}\n`);

  process.stdout.write(
    `cards:new: wrote content/sets/${setId}/${subDirectory}/${cardId}.json from ${templateName}.\n` +
      `  Edit it, then validate with:  npm run content:check\n`,
  );
}

main(process.argv.slice(2));
