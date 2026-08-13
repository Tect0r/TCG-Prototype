import { describe, expect, it } from 'vitest';
import {
  ABILITY_COST_TYPES,
  CONDITION_KINDS,
  EFFECT_TYPES,
  KEYWORD_IDS,
  MECHANIC_KINDS,
  MECHANIC_SUPPORT_LIST,
  STATIC_ABILITY_EFFECT_TYPES,
  SUPPORT_DIMENSIONS,
  TRIGGER_IDS,
  VALUE_EXPRESSION_KINDS,
  assertSupportRegistryComplete,
  describeCardSupport,
  limitingMechanics,
  loadBundledCardData,
  mechanicKey,
  mechanicSupport,
  mechanicsUsedBy,
  mechanicsUsedByAll,
  strongestSupport,
  supportRegistryGaps,
  weakestSupport,
  type CardDefinition,
  type MechanicKind,
} from './index.js';

/**
 * The support registry is the machine-readable answer to "how well is this
 * mechanic actually supported" (M05.1). These tests hold it to three promises:
 * it covers every vocabulary exhaustively, it is derived from the card data
 * rather than from an author's claim, and the levels it reports are the ones the
 * shipped content actually reaches.
 */

const EMPTY_CARD = {
  schemaVersion: 4,
  id: 'fixture',
  name: 'Fixture',
  type: 'unit',
  colorIdentity: [],
  cost: 1,
  attack: 1,
  health: 1,
  unique: false,
  collectible: true,
  tags: [],
  keywords: [],
  effects: [],
  additionalCosts: [],
  abilities: [],
  activatedAbilities: [],
  staticAbilities: [],
  delayedAbilities: [],
  implemented: true,
} as unknown as CardDefinition;

function card(overrides: Partial<CardDefinition>): CardDefinition {
  return { ...EMPTY_CARD, ...overrides } as CardDefinition;
}

describe('mechanic support registry', () => {
  it('classifies every member of every executable vocabulary', () => {
    expect(supportRegistryGaps()).toEqual([]);
    expect(() => assertSupportRegistryComplete()).not.toThrow();
  });

  it('covers exactly the schema vocabularies, with nothing extra', () => {
    const byKind = new Map<MechanicKind, string[]>();
    for (const entry of MECHANIC_SUPPORT_LIST) {
      byKind.set(entry.kind, [...(byKind.get(entry.kind) ?? []), entry.id]);
    }

    expect([...byKind.keys()].sort()).toEqual([...MECHANIC_KINDS].sort());
    expect(byKind.get('effect')).toEqual([...EFFECT_TYPES]);
    expect(byKind.get('static_effect')).toEqual([...STATIC_ABILITY_EFFECT_TYPES]);
    expect(byKind.get('trigger')).toEqual([...TRIGGER_IDS]);
    expect(byKind.get('keyword')).toEqual([...KEYWORD_IDS]);
    expect(byKind.get('condition')).toEqual([...CONDITION_KINDS]);
    expect(byKind.get('value')).toEqual([...VALUE_EXPRESSION_KINDS]);
    expect(byKind.get('cost')).toEqual([...ABILITY_COST_TYPES]);
  });

  it('gives every entry a level in all four dimensions and a note saying where it came from', () => {
    for (const entry of MECHANIC_SUPPORT_LIST) {
      for (const dimension of SUPPORT_DIMENSIONS) {
        expect(entry[dimension], mechanicKey(entry)).toBeTypeOf('string');
      }
      expect(entry.where.length, mechanicKey(entry)).toBeGreaterThan(20);
    }
  });

  it('refuses to invent a level for an unclassified mechanic', () => {
    expect(() => mechanicSupport({ kind: 'effect', id: 'teleport' })).toThrow(
      /No support classification for effect:teleport/,
    );
  });

  it('records resilient as the one inert mechanic in the whole vocabulary', () => {
    const inert = MECHANIC_SUPPORT_LIST.filter((entry) => entry.engine === 'none');
    expect(inert.map(mechanicKey)).toEqual(['keyword:resilient']);
  });

  it('records that a counter is now priced, and that only an inert keyword is not', () => {
    // The gap this registry was written to expose: `ungatedEffectValue` had no
    // `counter` case, so a Reaction whose whole text is a counter was priced as
    // a blank card. M05.2 repaired it, and the registry has to say so — a level
    // that stayed `legal_only` after the fix would make every Reaction deck's
    // report decline a claim the run can now support.
    expect(mechanicSupport({ kind: 'effect', id: 'counter' }).pilot).toBe('approximate');

    // What is left is the honest remainder: `resilient` is deliberately inert
    // pending Q4, so there is nothing for a pilot to play well.
    const blind = MECHANIC_SUPPORT_LIST.filter((entry) => entry.pilot === 'legal_only');
    expect(blind.map(mechanicKey).sort()).toEqual(['keyword:resilient']);
  });
});

describe('mechanicsUsedBy', () => {
  it('walks keywords, costs, triggers, conditions, values and continuous effects', () => {
    const walked = mechanicsUsedBy(
      card({
        keywords: ['guardian'],
        additionalCosts: [
          { type: 'sacrifice', amount: 1, excludeSource: false, selection: 'player_choice' },
        ],
        effects: [
          {
            type: 'draw',
            player: 'self',
            amount: {
              kind: 'count',
              count: { subject: 'units', controller: 'self', excludeSource: false },
              per: 1,
              plus: 0,
              minimum: 0,
            },
            condition: { kind: 'active_turn', expected: true },
          },
        ],
        abilities: [
          {
            id: 'a',
            trigger: 'on_defeated',
            activeZone: 'battlefield',
            effects: [
              {
                type: 'grant_keyword',
                target: { kind: 'source' },
                keyword: 'rush',
                duration: 'end_of_turn',
              },
            ],
          },
        ],
        staticAbilities: [
          {
            id: 's',
            activeZone: 'battlefield',
            affects: { zone: 'battlefield', controller: 'self', excludeSource: false },
            effect: { type: 'modify_stats', attack: 1, health: 0 },
          },
        ],
      } as unknown as Partial<CardDefinition>),
    ).map(mechanicKey);

    expect(walked).toEqual([
      'condition:active_turn',
      'cost:sacrifice',
      'effect:draw',
      'effect:grant_keyword',
      'keyword:guardian',
      'keyword:rush',
      'static_effect:modify_stats',
      'trigger:on_defeated',
      'value:count',
    ]);
  });

  it('counts a granted keyword as a mechanic the card depends on', () => {
    // Granting an inert keyword makes the instruction inert, however well
    // `grant_keyword` itself works — so the grant has to carry the keyword's
    // support, not its own.
    const granting = card({
      effects: [
        {
          type: 'grant_keyword',
          target: { kind: 'source' },
          keyword: 'resilient',
          duration: 'permanent',
        },
      ] as unknown as CardDefinition['effects'],
    });
    expect(describeCardSupport(granting).executable).toBe(false);
    expect(limitingMechanics(mechanicsUsedBy(granting), 'engine').map(mechanicKey)).toEqual([
      'keyword:resilient',
    ]);
  });

  it('treats a vanilla card as fully supported, because there is nothing to get wrong', () => {
    const support = describeCardSupport(card({}));
    expect(support.mechanics).toEqual([]);
    expect(support.weakest).toEqual({
      engine: 'full',
      help: 'full',
      pilot: 'full',
      telemetry: 'full',
    });
    expect(support.executable).toBe(true);
    expect(support.pilotBlind).toBe(false);
    // A card with no mechanics at all is not "invisible to telemetry": its
    // plays, draws and deaths are recorded like any other card's.
    expect(support.telemetryBlind).toBe(false);
  });
});

describe('weakest and strongest support', () => {
  const refs = [
    { kind: 'effect', id: 'draw' },
    { kind: 'effect', id: 'modify_stats' },
    { kind: 'keyword', id: 'resilient' },
  ] as const;

  it('folds each dimension independently', () => {
    expect(weakestSupport(refs)).toEqual({
      engine: 'none',
      help: 'full',
      pilot: 'legal_only',
      telemetry: 'none',
    });
    expect(strongestSupport(refs)).toEqual({
      engine: 'full',
      help: 'full',
      pilot: 'approximate',
      telemetry: 'full',
    });
  });

  it('names the mechanics holding a set back in one dimension', () => {
    expect(limitingMechanics(refs, 'telemetry').map(mechanicKey)).toEqual([
      'effect:modify_stats',
      'keyword:resilient',
    ]);
  });
});

describe('the shipped catalog', () => {
  it('runs every mechanic in the playtest set through an engine that executes it', () => {
    const unsupported = loadBundledCardData()
      .database.all()
      .map((entry) => describeCardSupport(entry))
      .filter((support) => !support.executable)
      .map((support) => support.cardId);

    // `dread_sovereign` prints `resilient` and lives in the `prototype_core`
    // development fixture set, which is not in any playtest format. The content
    // build warns about it there and would refuse it in a strict set.
    expect(unsupported).toEqual(['dread_sovereign']);
  });

  it('reports which mechanics limit the bundled pool in each dimension', () => {
    const refs = mechanicsUsedByAll(loadBundledCardData().database.all());
    expect(weakestSupport(refs)).toEqual({
      engine: 'none',
      help: 'full',
      pilot: 'legal_only',
      telemetry: 'none',
    });
    expect(limitingMechanics(refs, 'pilot').map(mechanicKey)).toEqual(['keyword:resilient']);
  });
});
