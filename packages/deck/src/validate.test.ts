import { describe, expect, it } from 'vitest';
import { CardDatabase } from '@tcg/card-data';
import {
  commanderColorIdentity,
  commanderIssues,
  deckStats,
  playableCommanders,
  validateDeck,
} from './validate.js';
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

  describe('a Commander whose printed behaviour is not implemented yet (M01.2)', () => {
    // Built by hand rather than pointed at a shipped card, so the rule stays
    // under test after M02 finishes the cards that are unfinished today.
    const withUnfinishedCommander = new CardDatabase(
      database.all().map((card) =>
        card.id === 'prototype_commander_blue_red'
          ? {
              ...card,
              implemented: false,
              unsupportedReason: 'its Guardian ability is not structured yet',
            }
          : card,
      ),
    );

    it('makes the deck illegal and says what is missing', () => {
      const report = validateDeck(legalDeck(), withUnfinishedCommander, DEVELOPMENT_DECK_FORMAT);
      const issue = report.issues.find((i) => i.code === 'deck/commander_not_implemented');

      expect(issue?.severity).toBe('error');
      expect(issue?.path).toBe('commanderId');
      expect(issue?.context).toMatchObject({ cardId: 'prototype_commander_blue_red' });
      expect(issue?.message).toMatch(/Guardian ability is not structured yet/);
      expect(report.legal).toBe(false);
    });

    it('is the only thing wrong with an otherwise legal deck', () => {
      // The same deck is legal on the real database, so nothing else in the
      // report is reacting to the substitution.
      expect(validateDeck(legalDeck(), database, DEVELOPMENT_DECK_FORMAT).legal).toBe(true);

      const report = validateDeck(legalDeck(), withUnfinishedCommander, DEVELOPMENT_DECK_FORMAT);
      expect(codes(report.issues.filter((i) => i.severity === 'error'))).toEqual([
        'deck/commander_not_implemented',
      ]);
    });

    it('does not stop the rest of the deck being checked', () => {
      // The Commander is still returned, so colour identity is still enforced
      // against it rather than silently skipped.
      const report = validateDeck(
        deckWith([['bramble_titan', 1]]),
        withUnfinishedCommander,
        DEVELOPMENT_DECK_FORMAT,
      );
      expect(codes(report.issues)).toContain('deck/commander_not_implemented');
      expect(codes(report.issues)).toContain('deck/color_identity');
    });
  });

  describe('an ordinary card whose printed behaviour is not implemented yet (M01.2)', () => {
    // Built by hand for the same reason the Commander case above is, and since
    // M02.5 that reason is no longer hypothetical: every bundled precon is
    // finished, so no shipped deck exercises this path any more. The rule still
    // has to hold for the next card somebody starts and does not finish.
    const withUnfinishedCard = new CardDatabase(
      database.all().map((card) =>
        card.id === 'pyre_champion'
          ? {
              ...card,
              implemented: false,
              unsupportedReason: 'its damage trigger is not structured yet',
            }
          : card,
      ),
    );

    it('makes the deck illegal and says which card is missing', () => {
      const report = validateDeck(legalDeck(), withUnfinishedCard, DEVELOPMENT_DECK_FORMAT);
      const issue = report.issues.find((i) => i.code === 'deck/card_not_implemented');

      expect(issue?.severity).toBe('error');
      expect(issue?.context).toMatchObject({ cardId: 'pyre_champion' });
      expect(issue?.message).toMatch(/damage trigger is not structured yet/);
      expect(report.legal).toBe(false);
    });

    it('is the only thing wrong with an otherwise legal deck', () => {
      expect(validateDeck(legalDeck(), database, DEVELOPMENT_DECK_FORMAT).legal).toBe(true);

      const report = validateDeck(legalDeck(), withUnfinishedCard, DEVELOPMENT_DECK_FORMAT);
      expect(codes(report.issues.filter((i) => i.severity === 'error'))).toEqual([
        'deck/card_not_implemented',
      ]);
    });
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

/**
 * The Commander rule, read on its own (M09.9).
 *
 * `commanderIssues` was extracted from `validateDeck` so a caller that has not
 * built a deck yet — the lobby offering Commanders for a bot to generate under,
 * and the server refusing the ones it will not honour — asks the same question
 * with the same answers. These tests are what keep the two from drifting: the
 * codes below are the ones `validateDeck` raises above.
 */
describe('commanderIssues', () => {
  it('raises exactly what validateDeck raises about the same Commander', () => {
    for (const commanderId of [null, 'deleted_commander', 'goblin_scout']) {
      const standalone = commanderIssues(commanderId, database, DEVELOPMENT_DECK_FORMAT);
      const inADeck = validateDeck(
        deckWith([], commanderId),
        database,
        DEVELOPMENT_DECK_FORMAT,
      ).issues.filter((issue) => issue.path === 'commanderId');
      expect(codes(standalone)).toEqual(codes(inADeck));
    }
  });

  it('says nothing about a Commander this format leaves playable', () => {
    expect(
      commanderIssues('prototype_commander_blue_red', database, DEVELOPMENT_DECK_FORMAT),
    ).toEqual([]);
  });

  it('refuses a Commander with more colours than the format allows', () => {
    const monoColor = { ...DEVELOPMENT_DECK_FORMAT, maxCommanderColors: 1 };
    expect(codes(commanderIssues('prototype_commander_blue_red', database, monoColor))).toEqual([
      'deck/commander_too_many_colors',
    ]);
  });

  it('refuses a Commander whose behaviour is not structured yet', () => {
    const real = database.getOrThrow('prototype_commander_blue_red');
    const crippled = new CardDatabase([
      ...database.all().filter((card) => card.id !== real.id),
      { ...real, implemented: false, unsupportedReason: 'no structured effect yet' },
    ]);
    expect(codes(commanderIssues(real.id, crippled, DEVELOPMENT_DECK_FORMAT))).toEqual([
      'deck/commander_not_implemented',
    ]);
  });
});

describe('playableCommanders', () => {
  it('is every collectible Commander the format leaves usable', () => {
    const offered = playableCommanders(database, DEVELOPMENT_DECK_FORMAT).map((card) => card.id);
    expect(offered).toEqual(database.commanders().map((card) => card.id));
  });

  it('drops the ones a narrower format cannot seat', () => {
    const monoColor = { ...DEVELOPMENT_DECK_FORMAT, maxCommanderColors: 1 };
    const offered = playableCommanders(database, monoColor);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((card) => card.colorIdentity.length <= 1)).toBe(true);
  });
});
