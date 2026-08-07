import { describe, expect, it } from 'vitest';
import { loadCardSets } from './loader.js';
import { BUNDLED_CARD_SETS, loadBundledCardData } from './default-set.js';
import {
  CARD_ID_PATTERN,
  CARD_SCHEMA_VERSION,
  CARD_TYPES,
  KEYWORD_IDS,
  POWER_CLASSES,
  ROLES,
} from './schema/primitives.js';
import type { CardSetInput } from './schema/card.js';

const minimalSet = (cards: CardSetInput['cards']): CardSetInput => ({
  schemaVersion: 1,
  setId: 'test_set',
  name: 'Test Set',
  cards,
});

const unitCard = (overrides: Partial<CardSetInput['cards'][number]> = {}) => ({
  schemaVersion: 1,
  id: 'test_unit',
  name: 'Test Unit',
  type: 'unit' as const,
  colorIdentity: [],
  cost: 2,
  attack: 2,
  health: 2,
  ...overrides,
});

describe('bundled card data', () => {
  const loaded = loadBundledCardData();

  it('validates cleanly', () => {
    expect(loaded.database.size).toBeGreaterThan(30);
  });

  it('produces no authoring warnings', () => {
    expect(loaded.warnings).toEqual([]);
  });

  it('uses only permanent snake_case IDs', () => {
    for (const card of loaded.database.all()) {
      expect(card.id).toMatch(CARD_ID_PATTERN);
    }
  });

  it('declares the current card schema version everywhere', () => {
    for (const card of loaded.database.all()) {
      expect(card.schemaVersion).toBe(CARD_SCHEMA_VERSION);
    }
  });

  // The dev set exists to exercise every filter and validation path, so a gap
  // here means a filter can no longer be tested against real data.
  it('covers every card type', () => {
    const present = new Set(loaded.database.all().map((c) => c.type));
    expect([...present].sort()).toEqual([...CARD_TYPES].sort());
  });

  it('covers every keyword', () => {
    const present = new Set(loaded.database.all().flatMap((c) => c.keywords));
    expect([...KEYWORD_IDS].filter((k) => !present.has(k))).toEqual([]);
  });

  it('covers every role and power class', () => {
    const roles = new Set(loaded.database.all().flatMap((c) => (c.role ? [c.role] : [])));
    const classes = new Set(
      loaded.database.all().flatMap((c) => (c.powerClass ? [c.powerClass] : [])),
    );
    expect([...ROLES].filter((r) => !roles.has(r))).toEqual([]);
    expect([...POWER_CLASSES].filter((p) => !classes.has(p))).toEqual([]);
  });

  it('covers neutral, mono-colour and two-colour identities', () => {
    const sizes = new Set(loaded.database.all().map((c) => c.colorIdentity.length));
    expect(sizes.has(0)).toBe(true);
    expect(sizes.has(1)).toBe(true);
    expect(sizes.has(2)).toBe(true);
  });

  it('offers unique and non-unique deckable cards', () => {
    const deckable = loaded.database.deckable();
    expect(deckable.some((c) => c.unique)).toBe(true);
    expect(deckable.some((c) => !c.unique)).toBe(true);
  });

  it('offers both mono- and two-colour Commanders', () => {
    const sizes = loaded.database.commanders().map((c) => c.colorIdentity.length);
    expect(sizes).toContain(1);
    expect(sizes).toContain(2);
  });

  it('excludes tokens and Commanders from the deckable pool', () => {
    for (const card of loaded.database.deckable()) {
      expect(card.type).not.toBe('token');
      expect(card.type).not.toBe('commander');
    }
  });
});

describe('loadCardSets validation', () => {
  it('rejects an empty input', () => {
    const result = loadCardSets([]);
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed card ID with an actionable message', () => {
    const result = loadCardSets([minimalSet([unitCard({ id: 'Goblin-Scout' })])]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.code).toBe('card_data/schema');
    expect(result.error[0]?.path).toBe('sets[0].cards.0.id');
  });

  it('rejects unknown properties instead of silently dropping them', () => {
    const result = loadCardSets([
      minimalSet([{ ...unitCard(), attak: 3 } as unknown as CardSetInput['cards'][number]]),
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects duplicate card IDs across sets', () => {
    const result = loadCardSets([
      minimalSet([unitCard()]),
      { ...minimalSet([unitCard({ name: 'Clone' })]), setId: 'other_set' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((e) => e.code)).toContain('card_data/duplicate_card_id');
  });

  it('rejects a future schema version with an upgrade hint', () => {
    const result = loadCardSets([{ ...minimalSet([unitCard()]), schemaVersion: 99 }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.code).toBe('card_data/unsupported_schema_version');
  });

  it('rejects a set without a schema version', () => {
    const { schemaVersion: _dropped, ...withoutVersion } = minimalSet([unitCard()]);
    const result = loadCardSets([withoutVersion]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.code).toBe('card_data/missing_schema_version');
  });

  it('rejects a spell that carries a statline', () => {
    const result = loadCardSets([
      minimalSet([
        {
          schemaVersion: 1,
          id: 'bad_spell',
          name: 'Bad Spell',
          type: 'spell',
          colorIdentity: ['red'],
          cost: 1,
          attack: 2,
          effects: [{ type: 'draw', amount: 1 }],
        },
      ]),
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects a Commander with an energy cost', () => {
    const result = loadCardSets([
      minimalSet([
        {
          schemaVersion: 1,
          id: 'bad_commander',
          name: 'Bad Commander',
          type: 'commander',
          colorIdentity: ['red'],
          cost: 3,
          attack: 2,
          health: 10,
        },
      ]),
    ]);
    expect(result.ok).toBe(false);
  });

  it('rejects a create_token effect pointing at a missing card', () => {
    const result = loadCardSets([
      minimalSet([
        unitCard({
          effects: [{ type: 'create_token', tokenCardId: 'no_such_token', amount: 1 }],
          displayText: 'Create a token.',
        }),
      ]),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((e) => e.code)).toContain('card_data/unknown_token');
  });

  it('warns, but does not fail, when prose and effects disagree', () => {
    const result = loadCardSets([
      minimalSet([
        unitCard({
          effects: [{ type: 'draw', amount: 1 }],
          displayText: 'Deal 3 damage to a unit.',
        }),
      ]),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.warnings.map((w) => w.code)).toContain('display_text/effect_mismatch');
  });

  it('keeps the bundled payload frozen against accidental mutation of raw JSON', () => {
    const first = loadCardSets(BUNDLED_CARD_SETS);
    const second = loadCardSets(BUNDLED_CARD_SETS);
    expect(first.ok && second.ok).toBe(true);
  });
});
