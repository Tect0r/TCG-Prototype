import { describe, expect, it } from 'vitest';
import { DECK_MIGRATIONS, migrateSavedDeck, type DeckMigration } from './migrate.js';
import { DECK_SCHEMA_VERSION } from './schema.js';
import { deckWith, legalDeck } from './test-fixtures.js';

describe('migrateSavedDeck', () => {
  it('passes a current-version deck straight through', () => {
    const deck = legalDeck();
    const result = migrateSavedDeck(structuredClone(deck));
    expect(result.ok && result.value).toEqual(deck);
  });

  it('rejects anything that is not a plain object', () => {
    for (const input of [null, 42, 'deck', ['a']]) {
      const result = migrateSavedDeck(input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error[0]?.code).toBe('deck/malformed');
    }
  });

  it('rejects a payload with no usable schema version', () => {
    for (const version of [undefined, 'one', 0.5, -1]) {
      const result = migrateSavedDeck({ ...deckWith([]), schemaVersion: version });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error[0]?.code).toBe('deck/missing_schema_version');
    }
  });

  it('rejects a deck saved by a newer build', () => {
    const result = migrateSavedDeck({ ...deckWith([]), schemaVersion: DECK_SCHEMA_VERSION + 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.code).toBe('deck/unsupported_schema_version');
  });

  it('ships with no migrations, because v1 is the first released format', () => {
    expect(DECK_MIGRATIONS).toEqual([]);
  });

  // The registry is empty today; these cover the chain runner that the next
  // schema bump plugs into.
  it('applies every step needed to reach the current version', () => {
    const applied: number[] = [];
    const renameTitle: DeckMigration = {
      from: 0,
      describe: 'rename `title` to `name`',
      migrate: (deck) => {
        applied.push(0);
        const { title, ...rest } = deck as { title?: unknown };
        return { ...rest, name: title };
      },
    };

    const legacy = {
      schemaVersion: 0,
      id: 'deck_legacy',
      title: 'Legacy Deck',
      commanderId: 'prototype_commander_red',
      cards: [{ cardId: 'goblin_scout', quantity: 2 }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    const result = migrateSavedDeck(legacy, [renameTitle]);
    expect(applied).toEqual([0]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('Legacy Deck');
    expect(result.value.schemaVersion).toBe(DECK_SCHEMA_VERSION);
  });

  it('fails clearly when a step in the chain is missing', () => {
    const result = migrateSavedDeck({ ...deckWith([]), schemaVersion: 0 }, []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.code).toBe('deck/no_migration_path');
  });

  it('still validates the result after migrating', () => {
    const result = migrateSavedDeck({ schemaVersion: 0, id: 'deck_x' }, [
      { from: 0, describe: 'no-op', migrate: (deck) => deck },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.code).toBe('card_data/schema');
  });

  it('does not mutate the input, even if a migration step is careless', () => {
    const input = { ...deckWith([['goblin_scout', 1]]), schemaVersion: 0 };
    const snapshot = structuredClone(input);
    migrateSavedDeck(input, [
      {
        from: 0,
        describe: 'careless in-place step',
        migrate: (deck) => {
          (deck as { name: string }).name = 'Clobbered';
          return deck;
        },
      },
    ]);
    expect(input).toEqual(snapshot);
  });
});
