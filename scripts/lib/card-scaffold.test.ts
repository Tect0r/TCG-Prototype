import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CARD_TYPES, loadCardSets, type CardType } from '@tcg/card-data';
import {
  DEFAULT_TEMPLATE,
  ScaffoldError,
  TEMPLATE_DIR,
  scaffoldCard,
  usage,
} from './card-scaffold.js';

/**
 * `cards:new` is the only supported way to start a card, so every card type it
 * advertises has to produce content the loader accepts. These tests scaffold
 * into a throwaway root but read the *shipped* templates, because a template
 * that has drifted out of schema is exactly the failure worth catching.
 */

/** The card body a scaffolded file contains. */
type CardBody = Record<string, unknown>;

const placeholderText = 'TODO: describe this card, generated from its structured effects.';

let root: string;

const readTemplate = (templateName: string): CardBody =>
  JSON.parse(readFileSync(join(TEMPLATE_DIR, `${templateName}.json`), 'utf8')) as CardBody;

const writeSet = (setId: string, schemaVersion: number, status = 'development') => {
  const path = join(root, 'content/sets', setId, 'set.json');
  mkdirSync(join(root, 'content/sets', setId), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ schemaVersion, setId, name: 'Test Set', status }, null, 2)}\n`,
  );
};

/**
 * Runs the scaffolded file through the real loader, exactly as the content
 * build does: the set manifest owns the version, so each card is stamped with
 * it and migrations run from there.
 */
const loadScaffolded = (schemaVersion: number, cards: readonly CardBody[]) =>
  loadCardSets([
    {
      schemaVersion,
      setId: 'test_set',
      name: 'Test Set',
      status: 'development',
      cards: cards.map((card) => ({ ...card, schemaVersion })),
    },
  ]);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tcg-scaffold-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('cards:new scaffolds every supported card type', () => {
  it('has a default template for each type and no others', () => {
    expect(Object.keys(DEFAULT_TEMPLATE).sort()).toEqual([...CARD_TYPES].sort());
  });

  it.each([...CARD_TYPES])('scaffolds a %s the loader accepts', (type: CardType) => {
    const templateName = DEFAULT_TEMPLATE[type];
    const schemaVersion = readTemplate(templateName).schemaVersion as number;
    writeSet('test_set', schemaVersion);

    const cardId = `scaffolded_${type}`;
    const result = scaffoldCard(['--set', 'test_set', '--type', type, '--id', cardId], { root });

    expect(result.templateName).toBe(templateName);
    const body = JSON.parse(readFileSync(result.targetPath, 'utf8')) as CardBody;

    // Identity is rewritten; the type comes from the template and must survive.
    expect(body.id).toBe(cardId);
    expect(body.type).toBe(type);
    expect(Object.keys(body).slice(0, 3)).toEqual(['id', 'name', 'type']);

    // set.json owns the version, and template flavour must not read as rules.
    expect(body).not.toHaveProperty('schemaVersion');
    expect(body).not.toHaveProperty('text');
    expect(body.displayText).toBe(placeholderText);

    const loaded = loadScaffolded(schemaVersion, [body]);
    expect(loaded.ok ? [] : loaded.error).toEqual([]);
    expect(loaded.ok && loaded.value.database.get(cardId)?.type).toBe(type);
  });

  it('keeps a Reaction playable only in the windows its template names', () => {
    const schemaVersion = readTemplate(DEFAULT_TEMPLATE.reaction).schemaVersion as number;
    writeSet('test_set', schemaVersion);

    const result = scaffoldCard(
      ['--set', 'test_set', '--type', 'reaction', '--id', 'scaffolded_reaction'],
      { root },
    );

    // A Reaction with no windows is a Reaction that can never be played, and a
    // Reaction with every window is one whose text no longer describes it.
    const loaded = loadScaffolded(schemaVersion, [result.card]);
    expect(loaded.ok).toBe(true);
    const card = loaded.ok ? loaded.value.database.get('scaffolded_reaction') : undefined;
    expect(card?.reaction?.windows.length).toBeGreaterThan(0);
    expect(card?.reaction?.windows).toEqual(
      (readTemplate(DEFAULT_TEMPLATE.reaction).reaction as { windows: string[] }).windows,
    );
  });

  it('writes tokens to tokens/ and everything else to cards/', () => {
    writeSet('test_set', readTemplate(DEFAULT_TEMPLATE.token).schemaVersion as number);

    const token = scaffoldCard(['--set', 'test_set', '--type', 'token', '--id', 'ember_token'], {
      root,
    });
    const unit = scaffoldCard(['--set', 'test_set', '--type', 'unit', '--id', 'ember_soldier'], {
      root,
    });

    expect(token.relativePath).toBe('content/sets/test_set/tokens/ember_token.json');
    expect(unit.relativePath).toBe('content/sets/test_set/cards/ember_soldier.json');
    expect(existsSync(token.targetPath)).toBe(true);
    expect(existsSync(unit.targetPath)).toBe(true);
  });

  it('titles the card from its ID and accepts --key=value form', () => {
    writeSet('test_set', readTemplate(DEFAULT_TEMPLATE.unit).schemaVersion as number);
    const result = scaffoldCard(['--set=test_set', '--type=unit', '--id=grove_pike_bearer'], {
      root,
    });
    expect(result.card.name).toBe('Grove Pike Bearer');
  });
});

describe('cards:new refuses rather than guessing', () => {
  const version = () => readTemplate(DEFAULT_TEMPLATE.unit).schemaVersion as number;

  it('will not overwrite an existing card ID, in either directory', () => {
    writeSet('test_set', version());
    scaffoldCard(['--set', 'test_set', '--type', 'token', '--id', 'ember_token'], { root });

    // Same ID, different type: still the same permanent identity.
    expect(() =>
      scaffoldCard(['--set', 'test_set', '--type', 'unit', '--id', 'ember_token'], { root }),
    ).toThrow(ScaffoldError);
  });

  it('refuses an unknown card type', () => {
    writeSet('test_set', version());
    expect(() =>
      scaffoldCard(['--set', 'test_set', '--type', 'enchantment', '--id', 'alpha'], { root }),
    ).toThrow(/unknown card type "enchantment"/);
  });

  it('refuses an ID that is not lowercase snake_case', () => {
    writeSet('test_set', version());
    expect(() =>
      scaffoldCard(['--set', 'test_set', '--type', 'unit', '--id', 'Ember Soldier'], { root }),
    ).toThrow(/legal card ID/);
  });

  it('refuses a set that does not exist', () => {
    expect(() =>
      scaffoldCard(['--set', 'no_such_set', '--type', 'unit', '--id', 'alpha'], { root }),
    ).toThrow(/does not exist/);
  });

  it('refuses a --template whose type disagrees with --type', () => {
    writeSet('test_set', version());
    expect(() =>
      scaffoldCard(
        ['--set', 'test_set', '--type', 'unit', '--id', 'alpha', '--template', 'template_token'],
        { root },
      ),
    ).toThrow(/is a token, but --type is "unit"/);
  });

  it('requires each of --set, --type and --id', () => {
    writeSet('test_set', version());
    expect(() => scaffoldCard(['--type', 'unit', '--id', 'alpha'], { root })).toThrow('--set');
    expect(() => scaffoldCard(['--set', 'test_set', '--id', 'alpha'], { root })).toThrow('--type');
    expect(() => scaffoldCard(['--set', 'test_set', '--type', 'unit'], { root })).toThrow('--id');
  });
});

describe('cards:new usage', () => {
  it('lists every card type and every shipped template', () => {
    const text = usage();
    for (const type of CARD_TYPES) expect(text).toContain(type);
    for (const template of Object.values(DEFAULT_TEMPLATE)) expect(text).toContain(template);
  });
});
