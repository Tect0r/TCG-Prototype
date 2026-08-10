import { describe, expect, it } from 'vitest';
import { BUNDLED_PRECONS, bundledPrecon, formatDatabase } from '@tcg/card-data';
import { PRECON_WAVE_1_DECK_FORMAT } from './format.js';
import { preconDatabase, preconFormat, preconToDeck, validatePrecon } from './precon.js';
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

  it('is reported as not yet playable while it contains unimplemented cards', () => {
    // Honest by design: the deck is *format*-legal, and `validateDeck` refuses
    // it only because some printed behaviour is not structured yet
    // (ruleset update §1).
    if (!precon) throw new Error('precon_goblin_swarm is missing');
    const deck = preconToDeck(precon, { id: 'deck_copy', now: '2026-08-10T00:00:00.000Z' });
    const report = validateDeck(deck, preconDatabase(precon), preconFormat(precon));

    const reasons = new Set(codes(report.issues));
    expect(reasons).not.toContain('deck/size');
    expect(reasons).not.toContain('deck/color_identity');
    expect(reasons).not.toContain('deck/singleton');
    expect(reasons).toContain('deck/card_not_implemented');
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
