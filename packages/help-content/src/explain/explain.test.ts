import { describe, expect, it } from 'vitest';
import {
  EFFECT_TYPES,
  TRIGGER_IDS,
  cardDefinitionSchema,
  loadBundledCardData,
  type CardDefinition,
  type CardDefinitionInput,
  type EffectDefinition,
  type EffectType,
} from '@tcg/card-data';
import { DEFAULT_HELP_CONFIG } from '../references.js';
import { explainCard } from './card.js';
import { explainEffect } from './effects.js';

const { database } = loadBundledCardData();

/** Builds a valid card from a partial definition, so tests stay readable. */
function card(overrides: Partial<CardDefinitionInput> = {}): CardDefinition {
  return cardDefinitionSchema.parse({
    schemaVersion: 2,
    id: 'test_card',
    name: 'Test Card',
    type: 'unit',
    colorIdentity: ['blue'],
    cost: 2,
    attack: 2,
    health: 2,
    ...overrides,
  } satisfies CardDefinitionInput);
}

/**
 * One representative effect of every type in the schema union.
 *
 * The table is keyed by `EffectType`, so a new effect type is a compile error
 * here as well as in the renderer table — the two stay in step by construction.
 */
const SAMPLE_EFFECTS: { readonly [T in EffectType]: Extract<EffectDefinition, { type: T }> } = {
  draw: { type: 'draw', player: 'self', amount: 2 },
  discard: { type: 'discard', player: 'each_opponent', amount: 1, selection: 'random' },
  deal_damage: {
    type: 'deal_damage',
    target: { kind: 'player', relation: 'opponent', selection: 'player_choice' },
    amount: 3,
  },
  heal: { type: 'heal', target: { kind: 'source' }, amount: 2 },
  modify_stats: {
    type: 'modify_stats',
    target: { kind: 'source' },
    attack: 2,
    health: -1,
    duration: 'end_of_turn',
  },
  grant_keyword: {
    type: 'grant_keyword',
    target: { kind: 'source' },
    keyword: 'swift',
    duration: 'permanent',
  },
  remove_keyword: {
    type: 'remove_keyword',
    target: { kind: 'source' },
    keyword: 'evasive',
    duration: 'end_of_turn',
  },
  create_token: {
    type: 'create_token',
    tokenCardId: 'prototype_soldier_token',
    amount: 2,
    controller: 'self',
  },
  destroy: {
    type: 'destroy',
    target: {
      kind: 'entity',
      selector: {
        zone: 'battlefield',
        controller: 'opponent',
        count: 1,
        selection: 'player_choice',
        chooser: 'self',
        optional: false,
        excludeSource: false,
      },
    },
  },
  sacrifice: { type: 'sacrifice', target: { kind: 'source' } },
  return_to_hand: {
    type: 'return_to_hand',
    target: {
      kind: 'entity',
      selector: {
        zone: 'battlefield',
        controller: 'any',
        count: 'all',
        selection: 'automatic',
        chooser: 'self',
        optional: false,
        excludeSource: true,
      },
    },
  },
  search_zone: {
    type: 'search_zone',
    player: 'self',
    zone: 'deck',
    filter: { cardTypes: ['unit'], keywords: ['swift'] },
    amount: 1,
    destination: 'hand',
    reveal: true,
    upTo: true,
  },
  reorder_zone: { type: 'reorder_zone', player: 'self', zone: 'deck', amount: 3 },
  modify_cost: {
    type: 'modify_cost',
    player: 'self',
    filter: { cardTypes: ['spell'] },
    delta: -1,
    duration: 'end_of_turn',
  },
  prevent_damage: {
    type: 'prevent_damage',
    target: { kind: 'player', relation: 'self', selection: 'automatic' },
    amount: 2,
    duration: 'end_of_turn',
  },
  exhaust: {
    type: 'exhaust',
    target: {
      kind: 'entity',
      selector: {
        zone: 'battlefield',
        controller: 'opponent',
        filter: { exhausted: false },
        count: 1,
        selection: 'player_choice',
        chooser: 'self',
        optional: true,
        excludeSource: false,
      },
    },
  },
  ready: { type: 'ready', target: { kind: 'source' } },
  move_card: { type: 'move_card', target: { kind: 'source' }, toZone: 'hand' },
};

describe('effect explanations', () => {
  it('covers every effect type the card schema can express', () => {
    expect(Object.keys(SAMPLE_EFFECTS).sort()).toEqual([...EFFECT_TYPES].sort());
  });

  it('produces a readable sentence for every effect type', () => {
    for (const type of EFFECT_TYPES) {
      const explanation = explainEffect(SAMPLE_EFFECTS[type], { database });
      expect(explanation.type, type).toBe(type);
      expect(explanation.text.length, type).toBeGreaterThan(10);
      // Sentences, not fragments: capitalised and terminated.
      expect(explanation.text, type).toMatch(/^[A-Z].*[.]$/s);
      // No unsubstituted placeholder ever reaches a player.
      expect(explanation.text, type).not.toMatch(/\{[a-zA-Z]/);
      expect(explanation.text, type).not.toMatch(/undefined|NaN|\[object/);
    }
  });

  it('is deterministic', () => {
    for (const type of EFFECT_TYPES) {
      const first = explainEffect(SAMPLE_EFFECTS[type], { database });
      const second = explainEffect(SAMPLE_EFFECTS[type], { database });
      expect(first).toEqual(second);
    }
  });

  it('names the source by its card type', () => {
    const asUnit = explainEffect(SAMPLE_EFFECTS.sacrifice, { sourceNoun: 'this unit' });
    const asRelic = explainEffect(SAMPLE_EFFECTS.sacrifice, { sourceNoun: 'this relic' });
    expect(asUnit.text).toContain('this unit');
    expect(asRelic.text).toContain('this relic');
  });

  it('pluralises a multi-type target correctly', () => {
    const explanation = explainEffect({
      type: 'deal_damage',
      amount: 2,
      target: {
        kind: 'entity',
        selector: {
          zone: 'battlefield',
          controller: 'any',
          filter: { cardTypes: ['unit', 'token'] },
          count: 'all',
          selection: 'automatic',
          chooser: 'self',
          optional: false,
          excludeSource: false,
        },
      },
    });
    expect(explanation.text).toContain('all units or tokens');
  });

  it('warns when an effect grants a keyword the engine ignores', () => {
    const explanation = explainEffect({
      type: 'grant_keyword',
      target: { kind: 'source' },
      keyword: 'guardian',
      duration: 'permanent',
    });
    expect(explanation.notes.join(' ')).toMatch(/no effect in the rules engine/i);
  });
});

describe('card explanations', () => {
  it('explains every bundled card completely', () => {
    for (const definition of database.all()) {
      const explanation = explainCard(definition, { database });
      expect(explanation.summary.length, definition.id).toBeGreaterThan(0);
      expect(explanation.summary, definition.id).not.toMatch(/\{[a-zA-Z]/);

      const executable =
        definition.effects.length +
        definition.abilities.length +
        definition.activatedAbilities.length +
        definition.staticAbilities.length;
      if (executable > 0) {
        expect(explanation.sections.length, definition.id).toBeGreaterThan(0);
      }
      for (const section of explanation.sections) {
        expect(section.title.length, definition.id).toBeGreaterThan(0);
        expect(section.timing.length, definition.id).toBeGreaterThan(0);
        expect(section.steps.length, definition.id).toBeGreaterThan(0);
        for (const step of section.steps) {
          expect(step.text.trim().length, `${definition.id} ${section.id}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('preserves effect order', () => {
    const explanation = explainCard(
      card({
        type: 'spell',
        attack: undefined,
        health: undefined,
        effects: [SAMPLE_EFFECTS.discard, SAMPLE_EFFECTS.draw],
      }),
      { database },
    );
    const steps = explanation.sections[0]?.steps ?? [];
    expect(steps[0]?.text).toMatch(/discard/i);
    expect(steps[1]?.text).toMatch(/draw/i);
  });

  it('covers every trigger in the vocabulary with timing text', () => {
    for (const trigger of TRIGGER_IDS) {
      const explanation = explainCard(
        card({ abilities: [{ id: 'test_ability', trigger, effects: [SAMPLE_EFFECTS.draw] }] }),
      );
      const section = explanation.sections.find((entry) => entry.kind === 'triggered');
      expect(section?.title.length, trigger).toBeGreaterThan(0);
      expect(section?.timing.length, trigger).toBeGreaterThan(0);
    }
  });

  it('describes activation costs, limits and continuous effects', () => {
    const explanation = explainCard(
      card({
        activatedAbilities: [
          {
            id: 'test_activated',
            name: 'Test Ability',
            usageLimit: 'once_per_match',
            costs: [
              { type: 'energy', amount: 2 },
              { type: 'exhaust_source' },
              { type: 'sacrifice', amount: 1, filter: { cardTypes: ['token'] } },
            ],
            effects: [SAMPLE_EFFECTS.draw],
          },
        ],
        staticAbilities: [
          {
            id: 'test_static',
            affects: { zone: 'battlefield', controller: 'self', excludeSource: true },
            effect: { type: 'modify_stats', attack: 1, health: 0 },
          },
        ],
      }),
    );

    const activated = explanation.sections.find((section) => section.kind === 'activated');
    expect(activated?.costs).toEqual(['two energy', 'exhaust this unit', 'sacrifice one token']);
    expect(activated?.limit).toBe('Once per match.');

    const staticSection = explanation.sections.find((section) => section.kind === 'static');
    expect(staticSection?.steps[0]?.text).toContain('+1/+0');
    expect(staticSection?.steps[0]?.text).toContain('not this unit itself');
  });

  it('never derives behaviour from displayText', () => {
    // Deliberately wrong prose: the explanation must describe the structured
    // effect and must not repeat the lie.
    const explanation = explainCard(
      card({
        displayText: 'Deal 99 damage to every opponent.',
        effects: [SAMPLE_EFFECTS.draw],
      }),
      { database },
    );
    const text = JSON.stringify(explanation);
    expect(text).not.toContain('99');
    expect(explanation.sections[0]?.steps[0]?.text).toMatch(/draw/i);
  });

  it('uses curated text when supplied, and marks it as curated', () => {
    const generated = explainCard(card({ effects: [SAMPLE_EFFECTS.draw] }));
    expect(generated.summaryIsCurated).toBe(false);

    const curated = explainCard(
      card({
        effects: [SAMPLE_EFFECTS.draw],
        text: {
          summary: 'Refills your hand.',
          effectExplanations: ['Two cards, one at a time.'],
          notes: ['Your maximum hand size is {matchConfig.maxHandSize}.'],
        },
      }),
    );
    expect(curated.summaryIsCurated).toBe(true);
    expect(curated.summary).toBe('Refills your hand.');
    // Curated text supplements the generated step; it never replaces it.
    expect(curated.sections[0]?.steps[0]?.curated).toBe('Two cards, one at a time.');
    expect(curated.sections[0]?.steps[0]?.text).toMatch(/draw/i);
    expect(curated.notes).toContain('Your maximum hand size is 10.');
  });

  it('resolves configuration references rather than hard-coding numbers', () => {
    const explanation = explainCard(
      card({ text: { notes: ['Armored reduces damage by {matchConfig.armoredReduction}.'] } }),
      {
        config: {
          ...DEFAULT_HELP_CONFIG,
          matchConfig: { ...DEFAULT_HELP_CONFIG.matchConfig, armoredReduction: 7 },
        },
      },
    );
    expect(explanation.notes).toContain('Armored reduces damage by 7.');
  });

  it('produces identical output for identical input', () => {
    const definition = database.getOrThrow('dread_sovereign');
    expect(explainCard(definition, { database })).toEqual(explainCard(definition, { database }));
  });

  it('exposes keyword definitions from the shared registry', () => {
    const explanation = explainCard(database.getOrThrow('dread_sovereign'), { database });
    expect(explanation.keywords.map((keyword) => keyword.id)).toEqual(['venom', 'resilient']);
    // Resilient is inert, and the explanation says so rather than describing a
    // rule the engine does not implement.
    expect(explanation.notes.join(' ')).toMatch(/Resilient has no effect/);
  });
});
