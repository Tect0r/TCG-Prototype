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

  it('covers every keyword, printed or granted', () => {
    // A keyword need not be printed on a card to be real: `untargetable_by_
    // opponents` only ever arrives through a `grant_keyword` effect. What must
    // never happen is a keyword no card can produce at all.
    const present = new Set<string>();
    for (const card of loaded.database.all()) {
      for (const keyword of card.keywords) present.add(keyword);
      const effects = [
        ...card.effects,
        ...card.abilities.flatMap((a) => a.effects),
        ...card.activatedAbilities.flatMap((a) => a.effects),
      ];
      for (const effect of effects) {
        if (effect.type === 'grant_keyword') present.add(effect.keyword);
      }
      for (const ability of card.staticAbilities) {
        if (ability.effect.type === 'grant_keyword') present.add(ability.effect.keyword);
      }
    }
    // Every keyword now reaches the board somewhere. `untargetable_by_opponents`
    // was the last exception, and it arrived with Scatter once Reaction timing
    // windows made that card playable (rule adjustment §5).
    expect([...KEYWORD_IDS].filter((k) => !present.has(k))).toEqual([]);
    expect(loaded.database.getOrThrow('scatter').implemented).toBe(true);
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

  // Taken off the constant rather than a round number, so the *next* version is
  // refused as soon as the constant moves. `migrate.test.ts` asserts the message
  // and context this refusal carries.
  it('rejects a future schema version with an upgrade hint', () => {
    const result = loadCardSets([
      { ...minimalSet([unitCard()]), schemaVersion: CARD_SCHEMA_VERSION + 1 },
    ]);
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

  it('accepts a Commander with an energy cost, which makes it deployable', () => {
    // Reversed by the Precon Wave 1 ruleset: a Commander's printed cost is what
    // moves it from the Commander zone onto the battlefield (ADR 0016 §4). A
    // null cost still means the older, undeployable model.
    const deployable = loadCardSets([
      minimalSet([
        {
          schemaVersion: 1,
          id: 'deployable_commander',
          name: 'Deployable Commander',
          type: 'commander',
          colorIdentity: ['red'],
          cost: 3,
          attack: 2,
          health: 10,
        },
      ]),
    ]);
    expect(deployable.ok).toBe(true);

    const zoneOnly = loadCardSets([
      minimalSet([
        {
          schemaVersion: 1,
          id: 'zone_only_commander',
          name: 'Zone Only Commander',
          type: 'commander',
          colorIdentity: ['red'],
          cost: null,
          attack: 2,
          health: 10,
        },
      ]),
    ]);
    expect(zoneOnly.ok).toBe(true);
  });

  it('still rejects a token that costs energy', () => {
    const result = loadCardSets([
      minimalSet([
        {
          schemaVersion: 1,
          id: 'priced_token',
          name: 'Priced Token',
          type: 'token',
          colorIdentity: ['red'],
          cost: 3,
          attack: 1,
          health: 1,
          collectible: false,
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
