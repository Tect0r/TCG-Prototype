import { describe, expect, it } from 'vitest';
import {
  BUNDLED_PRECONS,
  DEFAULT_FORMAT_ID,
  formatCardPool,
  loadBundledCardData,
  loadFormatCardData,
  preconsForFormat,
  resolveFormatId,
} from './default-set.js';

/**
 * The shared format-pool API every shipping entry point resolves its pool
 * through (M01.1). The point of these tests is that "the bundled universe" and
 * "a legal pool" can never quietly become the same thing again.
 */

const idsOf = (cards: readonly { id: string }[]) => cards.map((card) => card.id).sort();

/** A card that exists only in the development fixture set. */
const FIXTURE_CARD_ID = 'goblin_scout';
/** A Commander that exists only in the development fixture set. */
const FIXTURE_COMMANDER_ID = 'prototype_commander_red';

describe('preconsForFormat', () => {
  it('lists only the precons published for that format, in file order', () => {
    const wave1 = preconsForFormat('precon_wave_1');
    expect(wave1.map((precon) => precon.id)).toEqual(
      BUNDLED_PRECONS.filter((precon) => precon.formatId === 'precon_wave_1').map(
        (precon) => precon.id,
      ),
    );
    expect(wave1.every((precon) => precon.formatId === 'precon_wave_1')).toBe(true);
  });

  it('is empty for a format with no published precons, rather than falling back', () => {
    // The fixture format has none. Substituting another format's would put a
    // development deck in front of a Wave 1 player (M01.1, M03.2).
    expect(preconsForFormat('development')).toEqual([]);
    expect(preconsForFormat('no_such_format')).toEqual([]);
  });
});

describe('resolveFormatId', () => {
  it('falls back to the shipping format when nothing is requested', () => {
    expect(resolveFormatId()).toBe(DEFAULT_FORMAT_ID);
    expect(resolveFormatId(undefined)).toBe(DEFAULT_FORMAT_ID);
    expect(resolveFormatId(null)).toBe(DEFAULT_FORMAT_ID);
    expect(resolveFormatId('   ')).toBe(DEFAULT_FORMAT_ID);
  });

  it('keeps an explicitly requested format, including the development one', () => {
    expect(resolveFormatId('development')).toBe('development');
    expect(resolveFormatId(' development ')).toBe('development');
  });

  // An unknown ID must surface as an error from `loadFormatCardData`, never be
  // swapped for the default: silently running a different format than the one
  // asked for is exactly the drift this tranche removes.
  it('does not substitute the default for an unknown format', () => {
    expect(resolveFormatId('no_such_format')).toBe('no_such_format');
  });
});

describe('loadFormatCardData', () => {
  it('returns only the cards legal in the requested format', () => {
    const loaded = loadFormatCardData('precon_wave_1');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(idsOf(loaded.value.database.all())).toEqual(idsOf(formatCardPool('precon_wave_1')));
    expect(loaded.value.formatId).toBe('precon_wave_1');
    expect(loaded.value.format.deck.size).toBe(40);
    expect(loaded.value.sets.map((set) => set.setId)).toEqual(['precon_wave_1']);
  });

  it('keeps development fixtures out of the Wave 1 pool', () => {
    const loaded = loadFormatCardData('precon_wave_1');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.database.has(FIXTURE_CARD_ID)).toBe(false);
    expect(loaded.value.database.has(FIXTURE_COMMANDER_ID)).toBe(false);
    expect(
      loaded.value.database.commanders().some((card) => card.id.startsWith('prototype_')),
    ).toBe(false);

    // The universe still holds them, so saved decks and replays keep resolving.
    const universe = loadBundledCardData().database;
    expect(universe.has(FIXTURE_CARD_ID)).toBe(true);
    expect(universe.size).toBeGreaterThan(loaded.value.database.size);
  });

  it('still serves the development fixture pool when it is asked for', () => {
    const loaded = loadFormatCardData('development');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.database.has(FIXTURE_CARD_ID)).toBe(true);
    expect(loaded.value.format.deck.size).toBe(30);
    expect(loaded.value.format.deck.singleton).toBe(false);
    // ...and nothing from the playtest catalog leaks the other way.
    expect(loaded.value.database.has('bastion_commander')).toBe(false);
  });

  it('reports an unknown format as a structured error', () => {
    const loaded = loadFormatCardData('no_such_format');
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;

    expect(loaded.error[0]?.code).toBe('card_data/unknown_format');
    expect(loaded.error[0]?.message).toContain('precon_wave_1');
  });

  it('resolves the shipping format by default', () => {
    const byDefault = loadFormatCardData(resolveFormatId());
    expect(byDefault.ok).toBe(true);
    if (!byDefault.ok) return;
    expect(byDefault.value.formatId).toBe(DEFAULT_FORMAT_ID);
  });
});
