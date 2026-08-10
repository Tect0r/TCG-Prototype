import { describe, expect, it } from 'vitest';
import { validateDeck, deckStats, commanderColorIdentity } from './validate.js';
import { DEVELOPMENT_DECK_FORMAT } from './format.js';
import { setCardQuantity, setCommander } from './operations.js';
import { database, deckWith, fixedClock, legalDeck } from './test-fixtures.js';
import type { Issue } from '@tcg/shared';

const codes = (issues: readonly Issue[]) => issues.map((i) => i.code);

describe('validateDeck', () => {
  it('accepts a complete, legal deck', () => {
    const report = validateDeck(legalDeck(), database, DEVELOPMENT_DECK_FORMAT);
    expect(codes(report.issues.filter((i) => i.severity === 'error'))).toEqual([]);
    expect(report.legal).toBe(true);
  });

  it('requires a Commander', () => {
    const report = validateDeck(deckWith([], null), database, DEVELOPMENT_DECK_FORMAT);
    expect(codes(report.issues)).toContain('deck/commander_missing');
    expect(report.legal).toBe(false);
  });

  it('reports a Commander that no longer exists', () => {
    const report = validateDeck(
      deckWith([], 'deleted_commander'),
      database,
      DEVELOPMENT_DECK_FORMAT,
    );
    expect(codes(report.issues)).toContain('deck/commander_unresolved');
  });

  it('rejects a non-Commander card in the Commander slot', () => {
    const report = validateDeck(deckWith([], 'goblin_scout'), database, DEVELOPMENT_DECK_FORMAT);
    expect(codes(report.issues)).toContain('deck/commander_wrong_type');
  });

  it('rejects cards outside the Commander colour identity', () => {
    const report = validateDeck(
      deckWith([['bramble_titan', 1]]),
      database,
      DEVELOPMENT_DECK_FORMAT,
    );
    const issue = report.issues.find((i) => i.code === 'deck/color_identity');
    expect(issue?.message).toMatch(/Bramble Titan/);
    expect(issue?.message).toMatch(/Arc Tactician/);
  });

  it('accepts neutral cards under any Commander', () => {
    const report = validateDeck(
      deckWith([['prototype_scout', 2]], 'prototype_commander_green'),
      database,
    );
    expect(codes(report.issues)).not.toContain('deck/color_identity');
  });

  it('accepts a two-colour card only when both colours are covered', () => {
    const underBlueRed = validateDeck(
      deckWith([['stormforge_adept', 1]]),
      database,
      DEVELOPMENT_DECK_FORMAT,
    );
    expect(codes(underBlueRed.issues)).not.toContain('deck/color_identity');

    const underBlue = validateDeck(
      deckWith([['stormforge_adept', 1]], 'prototype_commander_blue'),
      database,
    );
    expect(codes(underBlue.issues)).toContain('deck/color_identity');
  });

  it('enforces the regular copy limit', () => {
    const report = validateDeck(deckWith([['goblin_scout', 3]]), database, DEVELOPMENT_DECK_FORMAT);
    const issue = report.issues.find((i) => i.code === 'deck/copy_limit');
    expect(issue?.context).toMatchObject({ cardId: 'goblin_scout', quantity: 3, limit: 2 });
  });

  it('enforces the single-copy limit for unique cards', () => {
    const report = validateDeck(
      deckWith([['overload_conduit', 2]]),
      database,
      DEVELOPMENT_DECK_FORMAT,
    );
    const issue = report.issues.find((i) => i.code === 'deck/copy_limit');
    expect(issue?.message).toMatch(/limited to 1 copy/);
  });

  it('allows one copy of a unique card', () => {
    const report = validateDeck(
      deckWith([['overload_conduit', 1]]),
      database,
      DEVELOPMENT_DECK_FORMAT,
    );
    expect(codes(report.issues)).not.toContain('deck/copy_limit');
  });

  it('reports unknown card IDs without discarding the rest of the deck', () => {
    const report = validateDeck(
      deckWith([
        ['goblin_scout', 2],
        ['removed_card', 1],
      ]),
      database,
    );
    expect(codes(report.issues)).toContain('deck/unknown_card');
    expect(report.stats.unresolvedCardIds).toEqual(['removed_card']);
    expect(report.stats.totalCards).toBe(3);
  });

  it('rejects tokens and Commanders in the deck list', () => {
    const tokens = validateDeck(
      deckWith([['prototype_spark_token', 1]]),
      database,
      DEVELOPMENT_DECK_FORMAT,
    );
    expect(codes(tokens.issues)).toContain('deck/card_not_deckable');

    const commander = validateDeck(
      deckWith([['prototype_commander_blue', 1]]),
      database,
      DEVELOPMENT_DECK_FORMAT,
    );
    expect(codes(commander.issues)).toContain('deck/card_not_deckable');
  });

  it('reports deck size in both directions', () => {
    const short = validateDeck(deckWith([['goblin_scout', 2]]), database, DEVELOPMENT_DECK_FORMAT);
    expect(short.issues.find((i) => i.code === 'deck/size')?.message).toMatch(/add 28 more/);

    const long = setCardQuantity(legalDeck(), 'prototype_drone', 3, { clock: fixedClock });
    expect(
      validateDeck(long, database, DEVELOPMENT_DECK_FORMAT).issues.find(
        (i) => i.code === 'deck/size',
      )?.message,
    ).toMatch(/3 over/);
  });

  it('honours a custom format configuration', () => {
    const deck = deckWith([['goblin_scout', 4]]);
    const report = validateDeck(deck, database, {
      ...DEVELOPMENT_DECK_FORMAT,
      deckSize: 4,
      copyLimit: 4,
    });
    expect(report.legal).toBe(true);
  });

  it('rejects a Commander with more colours than the format allows', () => {
    const report = validateDeck(deckWith([], 'prototype_commander_blue_red'), database, {
      ...DEVELOPMENT_DECK_FORMAT,
      maxCommanderColors: 1,
    });
    expect(codes(report.issues)).toContain('deck/commander_too_many_colors');
  });

  it('warns without blocking when a deck has no units', () => {
    const spellsOnly = deckWith([
      ['scorch', 2],
      ['desperate_insight', 2],
    ]);
    const report = validateDeck(spellsOnly, database, DEVELOPMENT_DECK_FORMAT);
    const noUnits = report.issues.find((i) => i.code === 'deck/no_units');
    expect(noUnits?.severity).toBe('warning');
  });

  it('warns when a Commander colour is unused', () => {
    const monoRed = deckWith([['goblin_scout', 2]]);
    const report = validateDeck(monoRed, database, DEVELOPMENT_DECK_FORMAT);
    expect(report.issues.find((i) => i.code === 'deck/unused_commander_color')?.severity).toBe(
      'warning',
    );
  });

  it('flags a duplicated deck-list entry', () => {
    const deck = deckWith([['goblin_scout', 1]]);
    const withDuplicate = {
      ...deck,
      cards: [...deck.cards, { cardId: 'goblin_scout', quantity: 1 }],
    };
    expect(codes(validateDeck(withDuplicate, database, DEVELOPMENT_DECK_FORMAT).issues)).toContain(
      'deck/duplicate_entry',
    );
  });
});

describe('deckStats', () => {
  it('summarises size, curve and types', () => {
    const stats = deckStats(legalDeck(), database);
    expect(stats.totalCards).toBe(30);
    expect(stats.distinctCards).toBe(15);
    expect(stats.typeCounts.unit).toBeGreaterThan(0);
    expect(stats.typeCounts.spell).toBeGreaterThan(0);
    expect(stats.typeCounts.relic).toBe(2);
    expect(Object.values(stats.costCurve).reduce((a, b) => a + b, 0)).toBe(30);
  });

  it('derives colour identity from the Commander and the cards', () => {
    const stats = deckStats(deckWith([['goblin_scout', 1]]), database);
    expect(stats.colorIdentity).toEqual(['blue', 'red']);
  });

  it('counts unresolved cards toward deck size but not toward the curve', () => {
    const stats = deckStats(deckWith([['ghost_card', 4]]), database);
    expect(stats.totalCards).toBe(4);
    expect(stats.costCurve).toEqual({});
    expect(stats.unresolvedCardIds).toEqual(['ghost_card']);
  });
});

describe('commanderColorIdentity', () => {
  it('is empty without a Commander and for unknown Commanders', () => {
    expect(commanderColorIdentity(deckWith([], null), database)).toEqual([]);
    expect(commanderColorIdentity(deckWith([], 'nope'), database)).toEqual([]);
  });

  it('follows the chosen Commander', () => {
    const deck = setCommander(deckWith([]), 'prototype_commander_green', fixedClock);
    expect(commanderColorIdentity(deck, database)).toEqual(['green']);
  });
});
