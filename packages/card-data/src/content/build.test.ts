import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContent, serializeBundle } from './build.js';
import { GENERATED_BUNDLE_PATH } from './source.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** A minimal card that satisfies `cardDefinitionSchema` once the set adds a version. */
const unitCard = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: 'Test Unit',
  type: 'unit',
  colorIdentity: ['green'],
  cost: 2,
  attack: 2,
  health: 2,
  displayText: 'A plain unit with no special rules.',
  ...overrides,
});

describe('the checked-in content bundle', () => {
  it('is exactly what the current sources build to', () => {
    const { bundle, issues } = buildContent(REPO_ROOT);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(bundle).toBeDefined();

    const onDisk = readFileSync(join(REPO_ROOT, GENERATED_BUNDLE_PATH), 'utf8');
    // Same assertion `npm run content:check` makes, so a stale bundle fails the
    // test suite too rather than only the verify script.
    expect(serializeBundle(bundle!)).toBe(onDisk);
  });

  it('orders cards by ID so the output is byte-identical on every machine', () => {
    const { bundle } = buildContent(REPO_ROOT);
    for (const set of bundle!.sets) {
      const ids = set.cards.map((card) => card.id);
      expect(ids).toEqual([...ids].sort());
    }
  });

  it('builds the same bytes when run twice', () => {
    const first = buildContent(REPO_ROOT).bundle!;
    const second = buildContent(REPO_ROOT).bundle!;
    expect(serializeBundle(first)).toBe(serializeBundle(second));
  });
});

describe('content source validation', () => {
  let root: string;

  /** Writes a whole content tree, then builds it. */
  const write = (path: string, body: unknown) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${JSON.stringify(body, null, 2)}\n`);
  };

  const manifest = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 2,
    setId: 'test_set',
    name: 'Test Set',
    status: 'development',
    ...overrides,
  });

  const errorCodes = () =>
    buildContent(root)
      .issues.filter((i) => i.severity === 'error')
      .map((i) => i.code);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tcg-content-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts a well-formed set', () => {
    write('content/sets/test_set/set.json', manifest());
    write('content/sets/test_set/cards/alpha.json', unitCard('alpha'));
    const { bundle, issues } = buildContent(root);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const set = bundle?.sets[0];
    expect(set?.cards.map((c) => c.id)).toEqual(['alpha']);
    expect(set?.status).toBe('development');
  });

  it('rejects a file whose name disagrees with the card ID it declares', () => {
    write('content/sets/test_set/set.json', manifest());
    write('content/sets/test_set/cards/alpha.json', unitCard('beta'));
    expect(errorCodes()).toContain('content/card_id_mismatch');
  });

  it('rejects a card file that declares its own schemaVersion', () => {
    write('content/sets/test_set/set.json', manifest());
    write('content/sets/test_set/cards/alpha.json', unitCard('alpha', { schemaVersion: 2 }));
    expect(errorCodes()).toContain('content/card_schema_version');
  });

  it('rejects a set whose directory and setId disagree', () => {
    write('content/sets/test_set/set.json', manifest({ setId: 'other_set' }));
    write('content/sets/test_set/cards/alpha.json', unitCard('alpha'));
    expect(errorCodes()).toContain('content/set_id_mismatch');
  });

  it('rejects the same card ID defined in two sets', () => {
    write('content/sets/test_set/set.json', manifest());
    write('content/sets/test_set/cards/alpha.json', unitCard('alpha'));
    write('content/sets/second_set/set.json', manifest({ setId: 'second_set', name: 'Second' }));
    write('content/sets/second_set/cards/alpha.json', unitCard('alpha'));
    expect(errorCodes()).toContain('content/duplicate_card_id');
  });

  it('names the offending file in the error', () => {
    write('content/sets/test_set/set.json', manifest());
    write('content/sets/test_set/cards/alpha.json', unitCard('alpha', { cost: 'free' }));
    const paths = buildContent(root)
      .issues.filter((i) => i.severity === 'error')
      .map((i) => i.path ?? '');
    expect(paths.some((p) => p.includes('alpha'))).toBe(true);
  });

  it('rejects a format that names a set which does not exist', () => {
    write('content/sets/test_set/set.json', manifest());
    write('content/sets/test_set/cards/alpha.json', unitCard('alpha'));
    write('content/formats/testing.json', {
      schemaVersion: 1,
      formatId: 'testing',
      name: 'Testing',
      setIds: ['no_such_set'],
      deck: { size: 40, singleton: true, maxCommanderColors: 2 },
    });
    expect(errorCodes()).toContain('content/unknown_set');
  });

  it('rejects a format that bans a card nothing defines', () => {
    write('content/sets/test_set/set.json', manifest());
    write('content/sets/test_set/cards/alpha.json', unitCard('alpha'));
    write('content/formats/testing.json', {
      schemaVersion: 1,
      formatId: 'testing',
      name: 'Testing',
      setIds: ['test_set'],
      bannedCardIds: ['ghost_card'],
      deck: { size: 40, singleton: true, maxCommanderColors: 2 },
    });
    expect(errorCodes()).toContain('content/unknown_banned_card');
  });

  it('reports an unresolvable token reference', () => {
    write('content/sets/test_set/set.json', manifest());
    write(
      'content/sets/test_set/cards/alpha.json',
      unitCard('alpha', {
        effects: [{ type: 'create_token', tokenCardId: 'missing_token', amount: 1 }],
      }),
    );
    expect(errorCodes()).toContain('card_data/unknown_token');
  });

  it('lets a development set warn but fails the same warning in a playtest set', () => {
    // An orphan token warns; the status is the only difference between the two.
    const token = {
      id: 'lonely_token',
      name: 'Lonely Token',
      type: 'token',
      colorIdentity: ['green'],
      cost: null,
      attack: 1,
      health: 1,
      collectible: false,
      displayText: 'A 1/1 token.',
    };

    write('content/sets/test_set/set.json', manifest());
    write('content/sets/test_set/cards/alpha.json', unitCard('alpha'));
    write('content/sets/test_set/tokens/lonely_token.json', token);
    const lenient = buildContent(root);
    expect(lenient.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(lenient.issues.map((i) => i.code)).toContain('card_data/orphan_token');

    write('content/sets/test_set/set.json', manifest({ status: 'playtest' }));
    expect(errorCodes()).toContain('card_data/orphan_token');
  });

  it('derives support from the mechanic registry rather than from the card’s own claim', () => {
    // `resilient` is authored, printed, filterable — and inert. The card says
    // `implemented: true` (the schema default) and is structurally valid; the
    // only thing that knows better is the support registry (M05.1).
    const resilientUnit = unitCard('alpha', {
      keywords: ['resilient'],
      displayText: 'A plain unit with Resilient.',
    });

    write('content/sets/test_set/set.json', manifest());
    write('content/sets/test_set/cards/alpha.json', resilientUnit);
    const lenient = buildContent(root);
    expect(lenient.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const warned = lenient.issues.find((i) => i.code === 'content/unsupported_mechanic');
    expect(warned?.severity).toBe('warning');
    expect(warned?.message).toContain('keyword:resilient');

    // The status is the only thing that changes. A set people will play with
    // may not contain a mechanic the engine does not execute.
    write('content/sets/test_set/set.json', manifest({ status: 'playtest' }));
    expect(errorCodes()).toContain('content/unsupported_mechanic');
  });

  it('follows a granted keyword into the instruction that grants it', () => {
    // `grant_keyword` is fully executed; granting an inert keyword is not, and a
    // check that only looked at `card.keywords` would miss it entirely.
    write('content/sets/test_set/set.json', manifest({ status: 'playtest' }));
    write(
      'content/sets/test_set/cards/alpha.json',
      unitCard('alpha', {
        effects: [{ type: 'grant_keyword', target: { kind: 'source' }, keyword: 'resilient' }],
        displayText: 'When this unit is deployed, it gains Resilient.',
      }),
    );
    expect(errorCodes()).toContain('content/unsupported_mechanic');
  });

  it('accepts a playtest set built entirely from executed mechanics', () => {
    write('content/sets/test_set/set.json', manifest({ status: 'playtest' }));
    write(
      'content/sets/test_set/cards/alpha.json',
      unitCard('alpha', {
        keywords: ['guardian'],
        displayText: 'Guardian.',
      }),
    );
    expect(errorCodes()).not.toContain('content/unsupported_mechanic');
  });

  it('rejects a set directory with no cards', () => {
    write('content/sets/test_set/set.json', manifest());
    expect(errorCodes()).toContain('content/empty_set');
  });

  it('rejects a set directory with no manifest', () => {
    mkdirSync(join(root, 'content/sets/test_set/cards'), { recursive: true });
    write('content/sets/test_set/cards/alpha.json', unitCard('alpha'));
    expect(errorCodes()).toContain('content/missing_manifest');
  });

  /* --------------------------------------------------------- deck plans */

  /**
   * A deck plan is a claim about a deck (M05.5), so every part of the claim is
   * checked at build time rather than trusted at search time: a plan that
   * misdescribes its deck would steer a whole generated population wrong and
   * would never fail visibly.
   */
  describe('deck plans', () => {
    /** Twelve cards, a Commander, a format and a precon for a plan to describe. */
    const CARDS = Array.from(
      { length: 12 },
      (_, index) => `c${String(index + 1).padStart(2, '0')}`,
    );

    const planFixture = () => {
      write('content/sets/test_set/set.json', manifest({ status: 'development' }));
      for (const id of [...CARDS, 'leader']) {
        write(`content/sets/test_set/cards/${id}.json`, unitCard(id));
      }
      write('content/formats/test_format.json', {
        schemaVersion: 1,
        formatId: 'test_format',
        name: 'Test Format',
        setIds: ['test_set'],
        // Twelve slots, so the 75% ceiling is nine and a legal plan has room.
        deck: { size: 12, singleton: true, maxCommanderColors: 1 },
      });
      write('content/precons/test_precon.json', {
        schemaVersion: 1,
        id: 'test_precon',
        name: 'Test Precon',
        formatId: 'test_format',
        strategy: 'Do the thing.',
        commanderId: 'leader',
        cardIds: CARDS,
      });
    };

    const pack = (
      id: string,
      role: string,
      cardIds: readonly string[],
      core = false,
    ): Record<string, unknown> => ({
      id,
      label: `Package ${id}`,
      role,
      rationale: 'These cards only mean anything together.',
      core,
      cardIds: [...cardIds],
    });

    /** A valid `sacrifice_value` plan: engine, payoff and interaction, six slots. */
    const plan = (overrides: Record<string, unknown> = {}) => ({
      schemaVersion: 1,
      id: 'test_plan',
      name: 'Test Plan',
      archetypeId: 'sacrifice_value',
      formatId: 'test_format',
      commanderId: 'leader',
      preconId: 'test_precon',
      summary: 'Make things, spend things, be paid for spending them.',
      packages: [
        pack('engine_pack', 'engine', ['c01', 'c02'], true),
        pack('payoff_pack', 'payoff', ['c03', 'c04'], true),
        pack('answer_pack', 'interaction', ['c05', 'c06']),
      ],
      ...overrides,
    });

    it('accepts a plan whose claims all hold', () => {
      planFixture();
      write('content/deck-plans/test_plan.json', plan());
      const built = buildContent(root);
      expect(built.issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(built.bundle?.deckPlans.map((entry) => entry.id)).toEqual(['test_plan']);
      expect(built.bundle?.schemaVersion).toBe(2);
    });

    it('refuses a plan that omits a role its archetype requires', () => {
      planFixture();
      // `token_swarm` requires engine, payoff *and* curve; this plan has no curve.
      write('content/deck-plans/test_plan.json', plan({ archetypeId: 'token_swarm' }));
      expect(errorCodes()).toContain('content/deck_plan_incomplete');
    });

    it('refuses an archetype the registry does not publish', () => {
      planFixture();
      write('content/deck-plans/test_plan.json', plan({ archetypeId: 'ramp' }));
      // Caught by the schema's own enum, before any cross-reference runs.
      expect(buildContent(root).bundle?.deckPlans ?? []).toEqual([]);
      expect(errorCodes().length).toBeGreaterThan(0);
    });

    it('refuses a plan that lists one card in two packages', () => {
      planFixture();
      write(
        'content/deck-plans/test_plan.json',
        plan({
          packages: [
            pack('engine_pack', 'engine', ['c01', 'c02'], true),
            pack('payoff_pack', 'payoff', ['c02', 'c03']),
            pack('answer_pack', 'interaction', ['c05', 'c06']),
          ],
        }),
      );
      expect(errorCodes()).toContain('content/package_card_overlap');
    });

    it('refuses a plan whose packages leave the search no room outside them', () => {
      planFixture();
      // Ten of twelve slots, over the 75% ceiling.
      write(
        'content/deck-plans/test_plan.json',
        plan({
          packages: [
            pack('engine_pack', 'engine', ['c01', 'c02', 'c03', 'c04'], true),
            pack('payoff_pack', 'payoff', ['c05', 'c06', 'c07', 'c08']),
            pack('answer_pack', 'interaction', ['c09', 'c10']),
          ],
        }),
      );
      expect(errorCodes()).toContain('content/deck_plan_too_large');
    });

    it('refuses a plan that packages a card its precon does not run', () => {
      planFixture();
      write(
        'content/deck-plans/test_plan.json',
        plan({
          packages: [
            pack('engine_pack', 'engine', ['c01', 'leader'], true),
            pack('payoff_pack', 'payoff', ['c03', 'c04']),
            pack('answer_pack', 'interaction', ['c05', 'c06']),
          ],
        }),
      );
      expect(errorCodes()).toContain('content/deck_plan_card_not_in_precon');
    });

    it('refuses a plan whose Commander is not the precon’s', () => {
      planFixture();
      write('content/deck-plans/test_plan.json', plan({ commanderId: 'c01' }));
      expect(errorCodes()).toContain('content/deck_plan_precon_commander');
    });

    it('refuses a plan naming a precon that does not exist', () => {
      planFixture();
      write('content/deck-plans/test_plan.json', plan({ preconId: 'no_such_precon' }));
      expect(errorCodes()).toContain('content/deck_plan_unknown_precon');
    });

    it('refuses a plan naming a card outside the format pool', () => {
      planFixture();
      write('content/formats/test_format.json', {
        schemaVersion: 1,
        formatId: 'test_format',
        name: 'Test Format',
        setIds: ['test_set'],
        bannedCardIds: ['c01'],
        deck: { size: 12, singleton: true, maxCommanderColors: 1 },
      });
      write('content/deck-plans/test_plan.json', plan());
      expect(errorCodes()).toContain('content/deck_plan_unknown_card');
    });

    it('refuses a plan whose file name and ID disagree', () => {
      planFixture();
      write('content/deck-plans/other_name.json', plan());
      expect(errorCodes()).toContain('content/deck_plan_id_mismatch');
    });

    it('refuses a plan that marks no package core', () => {
      planFixture();
      write(
        'content/deck-plans/test_plan.json',
        plan({ packages: plan().packages.map((entry) => ({ ...entry, core: false })) }),
      );
      expect(errorCodes()).toContain('content/deck_plan_no_core');
    });
  });

  it('reports unparseable JSON against the file that contains it', () => {
    write('content/sets/test_set/set.json', manifest());
    mkdirSync(join(root, 'content/sets/test_set/cards'), { recursive: true });
    writeFileSync(join(root, 'content/sets/test_set/cards/alpha.json'), '{ not json');
    const problems = buildContent(root).issues;
    expect(problems.map((i) => i.code)).toContain('content/unreadable');
    expect(problems[0]?.path).toContain('alpha.json');
  });
});

describe('generated output', () => {
  it('carries a do-not-edit banner', () => {
    const { bundle } = buildContent(REPO_ROOT);
    expect(bundle!.generated).toMatch(/do not edit/i);
  });

  it('is checked in', () => {
    expect(existsSync(join(REPO_ROOT, GENERATED_BUNDLE_PATH))).toBe(true);
  });
});
