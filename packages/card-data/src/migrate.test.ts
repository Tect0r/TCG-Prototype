import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canMigrateCardSet, migrateCardSet } from './migrate.js';
import { loadCardSets } from './loader.js';
import { loadBundledCardData, BUNDLED_CARD_SETS } from './default-set.js';
import { CARD_SCHEMA_VERSION } from './schema/primitives.js';
import { setManifestSchema } from './content/source.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The version at which `entity_or_player` entered the target language.
 *
 * Written down rather than derived, because it is the fact the compatibility
 * boundary rests on: a build that understands at most v4 has a
 * `targetDefinitionSchema` with no such member, so it cannot read a card that
 * uses one however the card is declared. Any set carrying one must therefore
 * declare at least this, or its declared version stops predicting whether a
 * build can load it.
 */
const ENTITY_OR_PLAYER_SINCE = 5;

const rawSet = (schemaVersion: number, cards: Record<string, unknown>[]) => ({
  schemaVersion,
  setId: 'test_set',
  name: 'Test Set',
  cards: cards.map((card) => ({ schemaVersion, ...card })),
});

const v4Unit = (overrides: Record<string, unknown> = {}) => ({
  id: 'test_unit',
  name: 'Test Unit',
  type: 'unit',
  colorIdentity: ['green'],
  cost: 2,
  attack: 2,
  health: 2,
  ...overrides,
});

describe('the migration chain', () => {
  it('has a step for every version this build claims to understand', () => {
    for (let version = 1; version <= CARD_SCHEMA_VERSION; version += 1) {
      expect(canMigrateCardSet(version)).toBe(true);
    }
  });

  it('has no path from a version this build does not understand', () => {
    expect(canMigrateCardSet(CARD_SCHEMA_VERSION + 1)).toBe(false);
  });

  // A gap in `STEPS` does not throw: `migrateCardSet` stops at it and returns a
  // set stamped part-way. That is the failure this asserts against, because the
  // stamp is what every later reader treats as "which reading was this
  // validated as".
  it('stamps the set and every card with the current version, from any origin', () => {
    for (let version = 1; version <= CARD_SCHEMA_VERSION; version += 1) {
      const migrated = migrateCardSet(rawSet(version, [v4Unit()]), version);
      expect(migrated['schemaVersion']).toBe(CARD_SCHEMA_VERSION);
      for (const card of migrated['cards'] as Record<string, unknown>[]) {
        expect(card['schemaVersion']).toBe(CARD_SCHEMA_VERSION);
      }
    }
  });

  it('still applies the real reshaping steps on the way past them', () => {
    // v2 → v3 renames `swift`; v3 → v4 stamps an ability's `activeZone`. A v2
    // set has to arrive at v5 having had both done to it, which is the whole
    // reason the v4 → v5 stamp cannot simply be skipped.
    const migrated = migrateCardSet(
      rawSet(2, [
        v4Unit({
          keywords: ['swift'],
          activatedAbilities: [{ id: 'poke', costs: [], effects: [{ type: 'draw', amount: 1 }] }],
        }),
      ]),
      2,
    );
    const card = (migrated['cards'] as Record<string, unknown>[])[0]!;
    expect(card['keywords']).toEqual(['rush']);
    expect((card['activatedAbilities'] as Record<string, unknown>[])[0]!['activeZone']).toBe(
      'battlefield',
    );
    expect(card['schemaVersion']).toBe(CARD_SCHEMA_VERSION);
  });

  it('reshapes nothing between v4 and v5 beyond the stamp', () => {
    // v5 widened the target language and rewrote no data. If this ever fails, a
    // real migration has been hidden inside a step documented as a version
    // stamp, and every v4 card on disk now means something it did not.
    const before = rawSet(4, [
      v4Unit({
        keywords: ['rush'],
        activatedAbilities: [
          { id: 'poke', costs: [], effects: [{ type: 'draw', amount: 1 }], activeZone: 'hand' },
        ],
      }),
    ]);
    const after = migrateCardSet(structuredClone(before), 4);

    const stripVersion = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(stripVersion)
        : typeof value === 'object' && value !== null
          ? Object.fromEntries(
              Object.entries(value)
                .filter(([key]) => key !== 'schemaVersion')
                .map(([key, entry]) => [key, stripVersion(entry)]),
            )
          : value;

    expect(stripVersion(after)).toEqual(stripVersion(before));
    expect(after['schemaVersion']).toBe(5);
  });
});

describe('refusing card data this build cannot read', () => {
  it('refuses a set from a newer build, and says what to do about it', () => {
    const ahead = CARD_SCHEMA_VERSION + 1;
    const result = loadCardSets([rawSet(ahead, [v4Unit()])]);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const [refusal] = result.error;
    expect(refusal?.code).toBe('card_data/unsupported_schema_version');
    expect(refusal?.message).toContain(`schemaVersion ${ahead}`);
    expect(refusal?.message).toContain(`at most ${CARD_SCHEMA_VERSION}`);
    expect(refusal?.message).toContain('Update the application.');
    expect(refusal?.context).toMatchObject({ found: ahead, supported: CARD_SCHEMA_VERSION });
  });

  it('refuses a set manifest from a newer build with the same instruction', () => {
    const parsed = setManifestSchema.safeParse({
      schemaVersion: CARD_SCHEMA_VERSION + 1,
      setId: 'test_set',
      name: 'Test Set',
      status: 'development',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toContain('Update the application.');
  });

  // This is the refusal a v4 build gives the content this repository now ships,
  // reproduced one version up so it stays true after the next bump.
  it('refuses the shipped sets when read by a build one version behind', () => {
    for (const set of BUNDLED_CARD_SETS) {
      const declared = (set as { schemaVersion: number }).schemaVersion;
      expect(declared).toBe(CARD_SCHEMA_VERSION);
    }
  });
});

describe('the version a set declares predicts whether a build can read it', () => {
  const usesEntityOrPlayer = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(usesEntityOrPlayer);
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    if (record['kind'] === 'entity_or_player') return true;
    return Object.values(record).some(usesEntityOrPlayer);
  };

  it('is carried by at least one shipped card, so this is not a hypothetical', () => {
    const cards = loadBundledCardData().database.all();
    expect(cards.filter((card) => usesEntityOrPlayer(card)).map((card) => card.id)).toEqual([
      'mass_offering',
    ]);
  });

  it('makes every source manifest holding one declare at least v5', () => {
    // The manifest is what an authoring tool reads, and it is the only place the
    // claim can be made before the bundle is generated.
    for (const setId of ['precon_wave_1', 'prototype_core']) {
      const manifest = setManifestSchema.parse(
        JSON.parse(readFileSync(join(REPO_ROOT, 'content/sets', setId, 'set.json'), 'utf8')),
      );
      const cards = loadBundledCardData()
        .sets.filter((set) => set.setId === setId)
        .flatMap((set) => set.cards);
      if (!cards.some((card) => usesEntityOrPlayer(card))) continue;
      expect(manifest.schemaVersion).toBeGreaterThanOrEqual(ENTITY_OR_PLAYER_SINCE);
    }
  });
});
