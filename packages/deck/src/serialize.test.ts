import { describe, expect, it } from 'vitest';
import {
  exportDeckToJson,
  exportDecksToJson,
  parseDecksFromJson,
  prepareImportedDeck,
  suggestDeckFilename,
} from './serialize.js';
import { renameDeck } from './operations.js';
import { deckWith, fixedClock, fixedIdSources, legalDeck } from './test-fixtures.js';

describe('exportDeckToJson', () => {
  const json = exportDeckToJson(legalDeck());

  it('emits readable, versioned JSON', () => {
    expect(json).toContain('\n  "schemaVersion": 1');
    expect(json.endsWith('\n')).toBe(true);
  });

  it('references cards by permanent ID only, never by display name', () => {
    expect(json).toContain('"cardId": "goblin_scout"');
    expect(json).not.toContain('Goblin Scout');
  });

  it('matches the documented minimum save format', () => {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      'schemaVersion',
      'id',
      'name',
      'commanderId',
      'cards',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('sorts entries by card ID so diffs stay stable', () => {
    const base = deckWith([]);
    const a = {
      ...base,
      cards: [
        { cardId: 'scorch', quantity: 1 },
        { cardId: 'goblin_scout', quantity: 1 },
      ],
    };
    const b = {
      ...base,
      cards: [
        { cardId: 'goblin_scout', quantity: 1 },
        { cardId: 'scorch', quantity: 1 },
      ],
    };
    expect(exportDeckToJson(a)).toBe(exportDeckToJson(b));
  });

  it('round-trips through import unchanged', () => {
    const original = legalDeck();
    const result = parseDecksFromJson(exportDeckToJson(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decks[0]).toEqual({
      ...original,
      cards: [...original.cards].sort((x, y) => x.cardId.localeCompare(y.cardId)),
    });
  });
});

describe('parseDecksFromJson', () => {
  it('accepts a bare deck object', () => {
    const result = parseDecksFromJson(exportDeckToJson(deckWith([['goblin_scout', 1]])));
    expect(result.ok && result.value.decks).toHaveLength(1);
  });

  it('accepts an array of decks', () => {
    const json = exportDecksToJson([deckWith([['goblin_scout', 1]]), legalDeck()]);
    const result = parseDecksFromJson(json);
    expect(result.ok && result.value.decks).toHaveLength(2);
  });

  it('reports invalid JSON instead of throwing', () => {
    const result = parseDecksFromJson('{ not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.code).toBe('deck/invalid_json');
  });

  it('rejects a file that is not a deck at all', () => {
    const result = parseDecksFromJson(JSON.stringify({ hello: 'world' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.code).toBe('deck/missing_schema_version');
  });

  it('rejects a deck saved by a newer build', () => {
    const future = { ...deckWith([]), schemaVersion: 99 };
    const result = parseDecksFromJson(JSON.stringify(future));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.code).toBe('deck/unsupported_schema_version');
    expect(result.error[0]?.message).toMatch(/Update the app/);
  });

  it('rejects a deck with a malformed card entry', () => {
    const broken = { ...deckWith([]), cards: [{ cardId: 'Goblin Scout', quantity: 2 }] };
    expect(parseDecksFromJson(JSON.stringify(broken)).ok).toBe(false);
  });

  it('rejects the whole file if any deck in it is invalid', () => {
    const json = JSON.stringify([deckWith([['goblin_scout', 1]]), { schemaVersion: 1 }]);
    const result = parseDecksFromJson(json);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.path).toMatch(/^decks\[1\]/);
  });

  it('rejects an empty array', () => {
    const result = parseDecksFromJson('[]');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error[0]?.code).toBe('deck/empty_import');
  });
});

describe('prepareImportedDeck', () => {
  const incoming = deckWith([['goblin_scout', 1]]);

  it('leaves a non-colliding deck untouched', () => {
    expect(prepareImportedDeck(incoming, { existing: [] })).toBe(incoming);
  });

  it('re-issues an ID that would overwrite an existing deck', () => {
    const existing = renameDeck(incoming, 'Something Else', fixedClock);
    const prepared = prepareImportedDeck(incoming, {
      existing: [existing],
      clock: fixedClock,
      idSources: fixedIdSources,
    });
    expect(prepared.id).not.toBe(existing.id);
    expect(prepared.cards).toEqual(incoming.cards);
  });

  it('disambiguates a colliding name', () => {
    const existing = { ...incoming, id: 'deck_other' };
    const prepared = prepareImportedDeck(incoming, {
      existing: [existing],
      clock: fixedClock,
      idSources: fixedIdSources,
    });
    expect(prepared.name).toBe('Test Deck (imported)');
  });

  it('keeps counting up when the disambiguated name also collides', () => {
    const existing = [
      { ...incoming, id: 'a' },
      { ...incoming, id: 'b', name: 'Test Deck (imported)' },
    ];
    const prepared = prepareImportedDeck(incoming, {
      existing,
      clock: fixedClock,
      idSources: fixedIdSources,
    });
    expect(prepared.name).toBe('Test Deck (imported 2)');
  });
});

describe('suggestDeckFilename', () => {
  it('slugifies the deck name', () => {
    expect(suggestDeckFilename(renameDeck(deckWith([]), 'Arc Tactician — Burn!', fixedClock))).toBe(
      'arc-tactician-burn.deck.json',
    );
  });

  it('falls back when the name has no usable characters', () => {
    expect(suggestDeckFilename(renameDeck(deckWith([]), '???', fixedClock))).toBe('deck.deck.json');
  });
});
