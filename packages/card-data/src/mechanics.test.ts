import { describe, expect, it } from 'vitest';
import {
  cardDefinitionSchema,
  type CardDefinition,
  type CardDefinitionInput,
} from './schema/card.js';
import { CARD_SCHEMA_VERSION } from './schema/primitives.js';
import {
  CARD_FIELD_KINDS,
  MECHANICS_CARD_FIELDS,
  PILOT_CARD_FIELDS,
  PRESENTATION_CARD_FIELDS,
  cardMechanics,
  cardPilotMetadata,
  cardPoolMechanicsJson,
  cardPresentation,
} from './mechanics.js';

/**
 * The canonical mechanics projection (M01.3).
 *
 * The claim under test is narrow and load-bearing: two cards produce the same
 * mechanics snapshot exactly when the engine and deck legality would treat them
 * identically. Every replay hash in the project is taken over this projection,
 * so a mechanic missing from it is a replay that stays "compatible" after the
 * game changed underneath it.
 */

/**
 * A Spell that pays an interactive additional cost.
 *
 * `selection: 'player_choice'` is the mechanic this tranche exists for: the
 * engine pauses and asks which Unit to feed the spell, so the two selection
 * modes are genuinely different games, and nothing else on the card moves
 * between them.
 */
const SACRIFICE_SPELL: CardDefinitionInput = {
  schemaVersion: CARD_SCHEMA_VERSION,
  id: 'fixture_sacrifice_spell',
  name: 'Fixture Sacrifice Spell',
  type: 'spell',
  colorIdentity: ['black', 'red'],
  cost: 2,
  tags: ['ritual', 'fixture'],
  keywords: [],
  additionalCosts: [{ type: 'sacrifice', amount: 1, selection: 'player_choice' }],
  effects: [{ type: 'draw', player: 'self', amount: 2 }],
  displayText: 'As an additional cost, sacrifice a Unit. Draw two cards.',
};

/** A Unit with an activated ability, so `activeZone` has somewhere to live. */
const ZONED_UNIT: CardDefinitionInput = {
  schemaVersion: CARD_SCHEMA_VERSION,
  id: 'fixture_zoned_unit',
  name: 'Fixture Zoned Unit',
  type: 'unit',
  colorIdentity: ['blue'],
  cost: 3,
  attack: 2,
  health: 3,
  activatedAbilities: [
    {
      id: 'fixture_zoned_unit_tap',
      name: 'Scry',
      costs: [{ type: 'exhaust_source' }],
      usageLimit: 'once_per_turn',
      activeZone: 'battlefield',
      effects: [{ type: 'draw', player: 'self', amount: 1 }],
    },
  ],
};

function card(input: CardDefinitionInput, patch: Record<string, unknown> = {}): CardDefinition {
  return cardDefinitionSchema.parse({ ...input, ...patch });
}

/** The snapshot a replay hash is taken over, for a one-card pool. */
function snapshot(input: CardDefinitionInput, patch: Record<string, unknown> = {}): string {
  return cardPoolMechanicsJson([card(input, patch)]);
}

describe('CARD_FIELD_KINDS', () => {
  // The compile-time guard is the mapped type on the constant itself: a new card
  // field that is not classified fails `tsc`. This is its runtime complement —
  // it fails if a field ever stops being reachable from a parsed card, which the
  // type alone cannot see.
  it('classifies every field a parsed card actually carries', () => {
    const parsed = card(SACRIFICE_SPELL) as unknown as Record<string, unknown>;
    for (const field of Object.keys(parsed)) {
      expect(CARD_FIELD_KINDS).toHaveProperty(field);
    }
  });

  it('puts the fields the engine and deck legality read in the mechanical set', () => {
    // Named individually rather than compared as a whole list, so this test says
    // what must be mechanical without also freezing what must not be.
    for (const field of [
      'additionalCosts',
      'abilities',
      'activatedAbilities',
      'staticAbilities',
      'effects',
      'reaction',
      'keywords',
      'tags',
      'unique',
      'collectible',
      'implemented',
      'cost',
      'attack',
      'health',
      'colorIdentity',
      'type',
      'schemaVersion',
    ] as const) {
      expect(CARD_FIELD_KINDS[field]).toBe('mechanics');
    }
  });

  it('keeps printed text and authored design labels out of the mechanical set', () => {
    expect(PRESENTATION_CARD_FIELDS).toEqual(['displayText', 'name', 'text', 'unsupportedReason']);
    expect(PILOT_CARD_FIELDS).toEqual(['design', 'powerClass', 'role']);
    for (const field of [...PRESENTATION_CARD_FIELDS, ...PILOT_CARD_FIELDS]) {
      expect(MECHANICS_CARD_FIELDS).not.toContain(field);
    }
  });
});

describe('projections', () => {
  it('gives the mechanics projection the card ID and every mechanical field', () => {
    const projection = cardMechanics(card(SACRIFICE_SPELL));
    expect(Object.keys(projection).sort()).toEqual(['id', ...MECHANICS_CARD_FIELDS].sort());
    expect(projection['additionalCosts']).toEqual([
      { type: 'sacrifice', amount: 1, excludeSource: false, selection: 'player_choice' },
    ]);
    expect(projection).not.toHaveProperty('name');
    expect(projection).not.toHaveProperty('displayText');
  });

  it('carries the card ID into the pilot and presentation projections too', () => {
    const subject = card(SACRIFICE_SPELL);
    expect(cardPilotMetadata(subject)['id']).toBe(SACRIFICE_SPELL.id);
    expect(cardPresentation(subject)['id']).toBe(SACRIFICE_SPELL.id);
    expect(cardPresentation(subject)['name']).toBe(SACRIFICE_SPELL.name);
  });

  it('normalises an absent optional field to null rather than omitting it', () => {
    // `attack`/`health` are absent on a Spell. They must snapshot as a value,
    // not as a missing key, so a card that gains one is a visible difference.
    const projection = cardMechanics(card(SACRIFICE_SPELL));
    expect(projection['attack']).toBeNull();
    expect(projection['health']).toBeNull();
    expect(projection['reaction']).toBeNull();
  });
});

describe('cardPoolMechanicsJson', () => {
  it('changes when only an interactive sacrifice cost changes', () => {
    // The regression this tranche was opened for. Nothing about the card moves
    // except who picks the sacrifice — which is a pause-and-ask in one case and
    // a deterministic engine pick in the other.
    const interactive = snapshot(SACRIFICE_SPELL);
    const automatic = snapshot(SACRIFICE_SPELL, {
      additionalCosts: [{ type: 'sacrifice', amount: 1, selection: 'automatic' }],
    });
    expect(automatic).not.toBe(interactive);
  });

  it('changes when an additional cost is added, resized or removed', () => {
    const base = snapshot(SACRIFICE_SPELL);
    expect(
      snapshot(SACRIFICE_SPELL, {
        additionalCosts: [{ type: 'sacrifice', amount: 2, selection: 'player_choice' }],
      }),
    ).not.toBe(base);
    expect(
      snapshot(SACRIFICE_SPELL, {
        additionalCosts: [{ type: 'discard', amount: 1 }],
      }),
    ).not.toBe(base);
    expect(snapshot(SACRIFICE_SPELL, { additionalCosts: [] })).not.toBe(base);
  });

  it('changes when a structured ability zone changes', () => {
    // `activeZone` decides whether the ability can be used at all (CLAUDE.md),
    // and it is the field the v3 → v4 migration had to stamp onto every ability.
    const base = snapshot(ZONED_UNIT);
    const moved = snapshot(ZONED_UNIT, {
      activatedAbilities: [
        {
          ...(ZONED_UNIT.activatedAbilities as Record<string, unknown>[])[0],
          activeZone: 'commander_zone',
        },
      ],
    });
    expect(moved).not.toBe(base);
  });

  it('changes when a card stops being playable', () => {
    // `implemented: false` makes every deck containing the card illegal (M01.2),
    // so it is a change to what can be played, not a note about the card.
    const base = snapshot(SACRIFICE_SPELL);
    const unfinished = snapshot(SACRIFICE_SPELL, {
      implemented: false,
      unsupportedReason: 'Waiting on a primitive.',
    });
    expect(unfinished).not.toBe(base);
  });

  it('changes when deck legality fields change', () => {
    const base = snapshot(SACRIFICE_SPELL);
    expect(snapshot(SACRIFICE_SPELL, { unique: true })).not.toBe(base);
    expect(snapshot(SACRIFICE_SPELL, { collectible: false })).not.toBe(base);
    expect(snapshot(SACRIFICE_SPELL, { colorIdentity: ['black'] })).not.toBe(base);
    expect(snapshot(SACRIFICE_SPELL, { tags: ['fixture'] })).not.toBe(base);
  });

  it('changes when instructions are reordered, because their order is the mechanic', () => {
    const base = snapshot(SACRIFICE_SPELL, {
      effects: [
        { type: 'draw', player: 'self', amount: 1 },
        { type: 'deal_damage', target: { kind: 'player', relation: 'opponent' }, amount: 2 },
      ],
    });
    const swapped = snapshot(SACRIFICE_SPELL, {
      effects: [
        { type: 'deal_damage', target: { kind: 'player', relation: 'opponent' }, amount: 2 },
        { type: 'draw', player: 'self', amount: 1 },
      ],
    });
    expect(swapped).not.toBe(base);
  });

  it('does not change when only printed text or design labels change', () => {
    const base = snapshot(SACRIFICE_SPELL);
    expect(
      snapshot(SACRIFICE_SPELL, {
        name: 'Fixture Sacrifice Spell (typo fixed)',
        displayText: 'Reworded, mechanically identical.',
        text: { summary: 'Feed a Unit to the spell, then draw two cards.' },
      }),
    ).toBe(base);
    expect(
      snapshot(SACRIFICE_SPELL, {
        role: 'support',
        powerClass: 'minor',
        design: { faction: 'cult', power: 'high' },
      }),
    ).toBe(base);
  });

  it('does not depend on pool order or on the order a set-valued field was written in', () => {
    const spell = card(SACRIFICE_SPELL);
    const unit = card(ZONED_UNIT);
    expect(cardPoolMechanicsJson([spell, unit])).toBe(cardPoolMechanicsJson([unit, spell]));
    expect(snapshot(SACRIFICE_SPELL, { tags: ['fixture', 'ritual'] })).toBe(
      snapshot(SACRIFICE_SPELL, { tags: ['ritual', 'fixture'] }),
    );
    expect(snapshot(SACRIFICE_SPELL, { colorIdentity: ['red', 'black'] })).toBe(
      snapshot(SACRIFICE_SPELL, { colorIdentity: ['black', 'red'] }),
    );
  });
});
