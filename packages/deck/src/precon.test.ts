import { describe, expect, it } from 'vitest';
import { BUNDLED_PRECONS, bundledPrecon, CardDatabase, formatDatabase } from '@tcg/card-data';
import { DEVELOPMENT_DECK_FORMAT, PRECON_WAVE_1_DECK_FORMAT } from './format.js';
import {
  preconDatabase,
  preconFormat,
  preconToDeck,
  reviewPrecon,
  validatePrecon,
} from './precon.js';
import { validateDeck } from './validate.js';

const codes = (issues: readonly { code: string }[]) => issues.map((issue) => issue.code);

describe('built-in precons', () => {
  it('ships the four authored decks', () => {
    expect(BUNDLED_PRECONS.map((precon) => precon.id).sort()).toEqual([
      'precon_bastion_guardians',
      'precon_containment_control',
      'precon_goblin_swarm',
      'precon_grave_sacrifice',
    ]);
  });

  it.each(BUNDLED_PRECONS.map((precon) => [precon.id, precon] as const))(
    '%s resolves every ID and passes format validation',
    (_id, precon) => {
      const report = validatePrecon(precon, preconDatabase(precon));
      expect(report.issues.map((issue) => `${issue.code}: ${issue.message}`)).toEqual([]);
      expect(report.legal).toBe(true);
    },
  );

  it.each(BUNDLED_PRECONS.map((precon) => [precon.id, precon] as const))(
    '%s has exactly 40 distinct cards plus one external Commander',
    (_id, precon) => {
      expect(precon.cardIds).toHaveLength(40);
      expect(new Set(precon.cardIds).size).toBe(40);
      expect(precon.cardIds).not.toContain(precon.commanderId);

      const commander = preconDatabase(precon).getOrThrow(precon.commanderId);
      expect(commander.type).toBe('commander');
    },
  );

  it('builds to the 40-card singleton format', () => {
    for (const precon of BUNDLED_PRECONS) {
      expect(preconFormat(precon)).toEqual(PRECON_WAVE_1_DECK_FORMAT);
    }
  });
});

describe('copying a precon into an editable deck', () => {
  const precon = bundledPrecon('precon_goblin_swarm');

  it('produces a deck with its own identity, leaving the precon untouched', () => {
    if (!precon) throw new Error('precon_goblin_swarm is missing');
    const before = structuredClone(precon);

    const deck = preconToDeck(precon, { id: 'deck_copy', now: '2026-08-10T00:00:00.000Z' });

    expect(deck.id).toBe('deck_copy');
    expect(deck.commanderId).toBe(precon.commanderId);
    expect(deck.cards).toHaveLength(40);
    expect(deck.cards.every((entry) => entry.quantity === 1)).toBe(true);
    // The source definition is immutable (ruleset update §3).
    expect(precon).toEqual(before);
  });

  it('round-trips the exact card list', () => {
    if (!precon) throw new Error('precon_goblin_swarm is missing');
    const deck = preconToDeck(precon, { id: 'deck_copy', now: '2026-08-10T00:00:00.000Z' });
    expect(deck.cards.map((entry) => entry.cardId).sort()).toEqual([...precon.cardIds].sort());
  });

  it.each(BUNDLED_PRECONS.map((entry) => [entry.id, entry] as const))(
    '%s copies into a deck that is playable outright (M02.5)',
    (_id, source) => {
      // Since M02.5 there is no unfinished card left in any bundled precon, so
      // every one of the four copies to a list a player can take into a match.
      // Asserted for all four rather than for one: the interesting fact is that
      // the set is now empty, and a single named deck would keep passing if one
      // of the others regressed.
      const deck = preconToDeck(source, { id: 'deck_copy', now: '2026-08-10T00:00:00.000Z' });
      const report = validateDeck(deck, preconDatabase(source), preconFormat(source));

      expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
      expect(report.legal).toBe(true);
    },
  );
});

describe('unfinished precons are refused, card by card (M01.2)', () => {
  /** Every card in a precon — Commander included — that cannot be played yet. */
  const unplayableIn = (preconId: string): string[] => {
    const precon = bundledPrecon(preconId);
    if (!precon) throw new Error(`${preconId} is missing`);
    const database = preconDatabase(precon);
    return [precon.commanderId, ...precon.cardIds].filter(
      (cardId) => database.get(cardId)?.implemented === false,
    );
  };

  /** Codes and card IDs `validateDeck` blocks a precon with. */
  const blockedBy = (preconId: string): { codes: string[]; cardIds: string[] } => {
    const precon = bundledPrecon(preconId);
    if (!precon) throw new Error(`${preconId} is missing`);
    const deck = preconToDeck(precon, { id: 'deck_check', now: '2026-08-11T00:00:00.000Z' });
    const errors = validateDeck(deck, preconDatabase(precon), preconFormat(precon)).issues.filter(
      (issue) => issue.severity === 'error',
    );
    return {
      codes: codes(errors),
      cardIds: errors.map((issue) => String(issue.context?.['cardId'] ?? '')).filter(Boolean),
    };
  };

  it('passes the Guardian precon now that its Commander is finished', () => {
    // Bastion's forty cards were always all implemented and its Commander was
    // not, which is the exact hole M01.2 closed: a deck could otherwise have
    // been legal through its Commander. `bastion_commander` shipped in M02.3,
    // so this precon is the first with nothing unfinished in it at all — and
    // the same two lists that used to name the Commander must now both be
    // empty rather than merely agreeing with each other.
    expect(unplayableIn('precon_bastion_guardians')).toEqual([]);

    const blocked = blockedBy('precon_bastion_guardians');
    expect(blocked.codes).not.toContain('deck/commander_not_implemented');
    expect(blocked.codes).toEqual([]);
  });

  it('passes the Control and Swarm precons now that M02.4 has shipped', () => {
    // The five replacement cards were the last thing holding these two back:
    // Containment Control held `containment_array`, `stasis_keeper`,
    // `stasis_seal` and `temporal_anchor`, and Goblin Swarm held
    // `goblin_warhorn_captain`. Asserted by name rather than left to the
    // `it.each` below, which only checks the two lists agree with each other
    // and would keep passing if both went wrong together.
    for (const preconId of ['precon_containment_control', 'precon_goblin_swarm']) {
      expect(unplayableIn(preconId)).toEqual([]);
      expect(blockedBy(preconId).codes).toEqual([]);
    }
  });

  it('passes the Sacrifice precon now that M02.5 has shipped', () => {
    // `equal_price` and `mass_offering` were the last two unfinished cards in
    // the whole of Wave 1, so this is the deck that used to name a list of
    // missing behaviour and now names none. The refusal machinery itself is
    // still covered — by `validate.test.ts`, against a synthetic database, which
    // is where it belongs now that no shipped deck can exercise it.
    expect(unplayableIn('precon_grave_sacrifice')).toEqual([]);
    expect(blockedBy('precon_grave_sacrifice').codes).toEqual([]);
  });

  it('leaves nothing unfinished anywhere in Wave 1 (M02.5)', () => {
    const remaining = BUNDLED_PRECONS.flatMap((precon) => unplayableIn(precon.id));
    expect(remaining).toEqual([]);
  });

  it.each(BUNDLED_PRECONS.map((precon) => [precon.id] as const))(
    '%s is legal exactly when nothing in it is unfinished',
    (preconId) => {
      const unplayable = unplayableIn(preconId);
      const blocked = blockedBy(preconId);
      expect(blocked.codes.length === 0).toBe(unplayable.length === 0);
      expect(blocked.cardIds.sort()).toEqual([...unplayable].sort());
    },
  );
});

describe('reviewPrecon: can this precon be played here (M03.1)', () => {
  const waveOne = formatDatabase('precon_wave_1');

  it.each(BUNDLED_PRECONS.map((precon) => [precon.id, precon] as const))(
    '%s is playable in its own format',
    (_id, precon) => {
      const report = reviewPrecon(precon, waveOne, PRECON_WAVE_1_DECK_FORMAT);
      expect(report.issues.map((issue) => `${issue.code}: ${issue.message}`)).toEqual([]);
      expect(report.legal).toBe(true);
    },
  );

  it('refuses a precon from another format instead of reporting 40 missing cards', () => {
    const precon = bundledPrecon('precon_goblin_swarm');
    if (!precon) throw new Error('precon_goblin_swarm is missing');

    // The development pool contains none of Wave 1, so the interesting part is
    // that the report says why *once* rather than card by card.
    const report = reviewPrecon(precon, formatDatabase('development'), DEVELOPMENT_DECK_FORMAT);
    expect(codes(report.issues)).toEqual(['precon/format_mismatch']);
    expect(report.issues[0]?.message).toMatch(/built for "precon_wave_1"/);
    expect(report.legal).toBe(false);
  });

  it('reports a definition problem without going on to validate the deck', () => {
    const precon = bundledPrecon('precon_goblin_swarm');
    if (!precon) throw new Error('precon_goblin_swarm is missing');
    const ghost = { ...precon, cardIds: [...precon.cardIds.slice(0, 39), 'no_such_card'] };

    const report = reviewPrecon(ghost, waveOne, PRECON_WAVE_1_DECK_FORMAT);
    expect(codes(report.issues)).toEqual(['precon/unknown_card']);
    expect(report.legal).toBe(false);
  });

  it('reports an unfinished card in a well-formed list', () => {
    const precon = bundledPrecon('precon_goblin_swarm');
    if (!precon) throw new Error('precon_goblin_swarm is missing');
    // Synthetic, because since M02.5 no shipped precon contains one — and this
    // is the refusal that must keep working for the next card someone starts.
    const doctored = new CardDatabase(
      [...waveOne.all()].map((card) =>
        card.id === 'goblin_spearman'
          ? { ...card, implemented: false, unsupportedReason: 'its attack trigger is not wired up' }
          : card,
      ),
    );

    const report = reviewPrecon(precon, doctored, PRECON_WAVE_1_DECK_FORMAT);
    const issue = report.issues.find((entry) => entry.code === 'deck/card_not_implemented');
    expect(issue?.context).toMatchObject({ cardId: 'goblin_spearman' });
    expect(issue?.message).toMatch(/attack trigger is not wired up/);
    expect(report.legal).toBe(false);
  });

  it('does not mutate the precon it checks', () => {
    const precon = bundledPrecon('precon_bastion_guardians');
    if (!precon) throw new Error('precon_bastion_guardians is missing');
    const before = structuredClone(precon);
    reviewPrecon(precon, waveOne, PRECON_WAVE_1_DECK_FORMAT);
    expect(precon).toEqual(before);
  });
});

describe('precon validation catches broken lists', () => {
  const base = bundledPrecon('precon_goblin_swarm');
  const database = formatDatabase('precon_wave_1');

  it('rejects a list that is the wrong size', () => {
    if (!base) throw new Error('missing precon');
    const short = { ...base, cardIds: base.cardIds.slice(0, 39) };
    expect(codes(validatePrecon(short, database).issues)).toContain('precon/size');
  });

  it('rejects a repeated card in a singleton format', () => {
    if (!base) throw new Error('missing precon');
    const repeated = {
      ...base,
      cardIds: [...base.cardIds.slice(0, 39), base.cardIds[0] as string],
    };
    expect(codes(validatePrecon(repeated, database).issues)).toContain('precon/duplicate_card');
  });

  it('rejects a Token in the deck list', () => {
    if (!base) throw new Error('missing precon');
    const withToken = { ...base, cardIds: [...base.cardIds.slice(0, 39), 'goblin_token'] };
    expect(codes(validatePrecon(withToken, database).issues)).toContain('precon/not_deckable');
  });

  it('rejects an unresolvable card ID', () => {
    if (!base) throw new Error('missing precon');
    const ghost = { ...base, cardIds: [...base.cardIds.slice(0, 39), 'no_such_card'] };
    expect(codes(validatePrecon(ghost, database).issues)).toContain('precon/unknown_card');
  });

  it('rejects a Commander that is not a Commander', () => {
    if (!base) throw new Error('missing precon');
    const wrong = { ...base, commanderId: 'goblin_spearman' };
    expect(codes(validatePrecon(wrong, database).issues)).toContain('precon/commander_wrong_type');
  });

  it('rejects a card outside the Commander’s colour identity', () => {
    if (!base) throw new Error('missing precon');
    // Goblin Swarm is mono-red; a black card is illegal under it.
    const offColor = { ...base, cardIds: [...base.cardIds.slice(0, 39), 'raise_a_thrall'] };
    expect(codes(validatePrecon(offColor, database).issues)).toContain('precon/color_identity');
  });
});
