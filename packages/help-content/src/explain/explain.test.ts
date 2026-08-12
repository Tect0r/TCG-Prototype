import { describe, expect, it } from 'vitest';
import {
  DURATIONS,
  EFFECT_TYPES,
  TRIGGER_IDS,
  cardDefinitionSchema,
  loadBundledCardData,
  type CardDefinition,
  type CardDefinitionInput,
  type Duration,
  type EffectDefinition,
  type EffectType,
  type TargetDefinition,
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
    keyword: 'rush',
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
    filter: { cardTypes: ['unit'], keywords: ['rush'] },
    amount: 1,
    destination: 'hand',
    reveal: true,
    upTo: true,
    remainder: 'unchanged',
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
  skip_next_ready: { type: 'skip_next_ready', target: { kind: 'blocked_by_source' } },
  move_card: { type: 'move_card', target: { kind: 'source' }, toZone: 'hand' },
  counter: { type: 'counter', unlessPays: 2 },
  schedule_delayed: { type: 'schedule_delayed', delayedAbilityId: 'later' },
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

  it('spells out a delayed effect rather than describing the bookkeeping', () => {
    const boundary = explainEffect(
      { type: 'schedule_delayed', delayedAbilityId: 'later' },
      {
        sourceNoun: 'this unit',
        delayedAbilities: [
          {
            id: 'later',
            boundary: 'end_of_turn',
            subject: 'source',
            effects: [{ type: 'return_to_hand', target: { kind: 'source' } }],
          },
        ],
      },
    );
    expect(boundary.text).toBe('At the end of the turn, return this unit to its owner’s hand.');

    const watch = explainEffect(
      { type: 'schedule_delayed', delayedAbilityId: 'later' },
      {
        database,
        sourceNoun: 'this spell',
        delayedAbilities: [
          {
            id: 'later',
            boundary: 'end_of_turn',
            trigger: 'on_defeated',
            subject: 'previous_target',
            effects: [
              { type: 'create_token', tokenCardId: 'thrall_token', amount: 2, controller: 'self' },
            ],
          },
        ],
      },
    );
    expect(watch.text).toMatch(/^When it is defeated this turn, create /);
    expect(watch.notes).toContain(
      'if that never happens, the delayed effect simply ends with the turn',
    );
  });

  it('says what the two zone transitions really do', () => {
    const buriedUnit: TargetDefinition = {
      kind: 'entity',
      selector: {
        zone: 'discard',
        controller: 'self',
        filter: { cardTypes: ['unit'] },
        count: 1,
        selection: 'player_choice',
        chooser: 'self',
        optional: false,
        excludeSource: false,
      },
    };

    const removal = explainEffect({ type: 'move_card', toZone: 'removed', target: buriedUnit });
    expect(removal.text).toMatch(/^Remove .* from the game\.$/);
    expect(removal.notes).toContain(
      'a card removed from the game is gone for good: nothing may target it and no effect returns it',
    );

    const revival = explainEffect({
      type: 'move_card',
      toZone: 'battlefield',
      entersExhausted: true,
      target: buriedUnit,
    });
    expect(revival.text).toMatch(/onto the battlefield Exhausted\.$/);
    expect(revival.notes).toContain(
      'this is not a deployment: abilities that watch for a Unit entering the battlefield see it, abilities that watch for one being deployed do not',
    );

    // A move that is only a move keeps the plain wording.
    const bounce = explainEffect({ type: 'move_card', toZone: 'hand', target: { kind: 'source' } });
    expect(bounce.text).toMatch(/^Move .* to its owner’s hand\.$/);
  });

  it('says only what it can when the delayed body was not supplied', () => {
    // The body is named by ID, so a caller without the card cannot resolve it.
    // The honest answer is a short sentence, never an invented one.
    const explanation = explainEffect({ type: 'schedule_delayed', delayedAbilityId: 'later' });
    expect(explanation.text).toBe('Set up a delayed effect.');
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
      keyword: 'resilient',
      duration: 'permanent',
    });
    expect(explanation.notes.join(' ')).toMatch(/no effect in the rules engine/i);
  });

  it('names the boundary of every duration a modifier can carry', () => {
    const clause = (duration: Duration): string =>
      explainEffect({
        type: 'modify_stats',
        target: { kind: 'source' },
        attack: 1,
        health: 0,
        duration,
      }).text;

    // The two narrow boundaries are the ones a player can misjudge: neither
    // means "until end of turn", and one of them deliberately outlasts it.
    expect(clause('end_of_combat')).toContain('for that combat');
    expect(clause('until_your_next_turn')).toContain('until the beginning of your next turn');
    for (const duration of DURATIONS) expect(clause(duration)).not.toBe('');
  });

  it('spells out every alternative of an "X or Y" filter', () => {
    const explanation = explainEffect({
      type: 'search_zone',
      player: 'self',
      zone: 'deck',
      fromTop: 4,
      filter: { anyOf: [{ tags: ['goblin'] }, { cardTypes: ['relic'] }] },
      amount: 1,
      destination: 'hand',
      reveal: false,
      upTo: true,
      remainder: 'bottom',
    });

    // A dropped alternative would read as a strictly narrower card than the one
    // that was authored, which is the failure this layer exists to prevent.
    expect(explanation.text).toContain('goblin');
    expect(explanation.text).toContain('relic');
    expect(explanation.text).toMatch(/\bor\b/);
  });

  it('does not offer to decline a look-at-the-top search that has no "may"', () => {
    // The engine treats a look-at-the-top effect as public, because the cards
    // were shown to the chooser. Saying otherwise would promise a choice
    // `applyAction` will reject.
    const explanation = explainEffect({
      type: 'search_zone',
      player: 'self',
      zone: 'deck',
      fromTop: 3,
      amount: 1,
      destination: 'hand',
      reveal: false,
      upTo: false,
      remainder: 'bottom',
    });

    expect(explanation.notes.join(' ')).toMatch(/must be taken/);
    expect(explanation.notes.join(' ')).not.toMatch(/may legally find nothing/);
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

  it('describes a computed amount rather than printing a number it cannot know', () => {
    // Ruleset update §15. An inspector that showed "deal 0 damage" for "damage
    // equal to the number of Goblins you control" would be actively misleading.
    const explanation = explainCard(
      card({
        type: 'spell',
        attack: undefined,
        health: undefined,
        effects: [
          {
            type: 'deal_damage',
            target: { kind: 'player', relation: 'opponent' },
            amount: {
              kind: 'count',
              count: { subject: 'units', controller: 'self', filter: { tags: ['goblin'] } },
            },
          },
        ],
      }),
      { database },
    );
    const steps = explanation.sections.flatMap((section) => section.steps.map((step) => step.text));
    expect(steps.join(' ')).toMatch(/the number of goblin units you control/i);
    expect(steps.join(' ')).not.toMatch(/deal zero damage/i);
  });

  it('spells out an instruction’s condition instead of dropping it', () => {
    const explanation = explainCard(
      card({
        type: 'spell',
        attack: undefined,
        health: undefined,
        effects: [
          {
            type: 'draw',
            player: 'self',
            amount: 1,
            condition: {
              kind: 'count',
              count: { subject: 'units_defeated_this_turn', controller: 'self' },
              comparison: 'at_least',
              value: 2,
            },
          },
        ],
      }),
      { database },
    );
    const steps = explanation.sections.flatMap((section) => section.steps.map((step) => step.text));
    // Ownership binds to the noun and the subject's time clause trails it, so
    // this reads "units you control defeated this turn" rather than the
    // garbled "units defeated this turn you control".
    expect(steps.join(' ')).toMatch(
      /only if there are at least two units you control defeated this turn/i,
    );
  });

  it('says a source-bound modifier lasts only while the source is in play', () => {
    // Readiness gate B1: the sentence was already written, but nothing expired
    // the modifier, so it was a promise the engine did not keep. It does now —
    // this pins the wording to the behaviour rather than the other way round.
    const explanation = explainCard(
      card({
        type: 'relic',
        attack: undefined,
        health: undefined,
        effects: [
          {
            type: 'modify_stats',
            target: {
              kind: 'entity',
              selector: { zone: 'battlefield', controller: 'self', count: 1 },
            },
            attack: 2,
            health: 0,
            duration: 'while_source_present',
          },
        ],
      }),
      { database },
    );
    const steps = explanation.sections.flatMap((section) => section.steps.map((step) => step.text));
    expect(steps.join(' ')).toMatch(/as long as the source remains in play/);
  });

  it('tells a relic’s owner that the next relic replaces it', () => {
    // Ruleset update §12. The distinction that matters to a player is that the
    // old relic is *not* destroyed: a card watching for a relic dying will not
    // fire, so the note has to say so rather than just "it goes away".
    const explanation = explainCard(
      card({ type: 'relic', attack: undefined, health: undefined, effects: [] }),
      { database },
    );
    const notes = explanation.notes.join(' ');
    expect(notes).toMatch(/replaces this one/i);
    expect(notes).toMatch(/not as a destruction or a sacrifice/i);
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

  // M02.4. A replacement gets its own sentence rather than the "your <cards>
  // <change>" shape a continuous ability takes, because that shape has nowhere
  // to put which event is being rewritten, the once-a-turn throttle, or the
  // price. These pin what a player actually reads.
  it('says which event a replacement rewrites, and its throttle', () => {
    const explanation = explainCard(
      card({
        type: 'relic',
        attack: undefined,
        health: undefined,
        staticAbilities: [
          {
            id: 'containment',
            activeZone: 'battlefield',
            affects: {
              zone: 'battlefield',
              controller: 'opponent',
              filter: { cardTypes: ['unit', 'token', 'commander'] },
            },
            effect: {
              type: 'replace_arrival',
              on: 'deployed',
              limit: 'first_each_turn',
              entersExhausted: true,
            },
          },
        ],
      }),
    );

    const text = explanation.sections.find((section) => section.kind === 'static')?.steps[0]?.text;
    expect(text).toMatch(/first/i);
    expect(text).toMatch(/enemy/i);
    expect(text).toMatch(/deployed/i);
    expect(text).toMatch(/each turn/i);
    expect(text).toMatch(/enters Exhausted/i);
  });

  it('names the price of a paid readiness replacement', () => {
    const explanation = explainCard(
      card({
        type: 'relic',
        attack: undefined,
        health: undefined,
        staticAbilities: [
          {
            id: 'drag',
            activeZone: 'battlefield',
            affects: { zone: 'battlefield', controller: 'opponent' },
            effect: { type: 'replace_ready', energyCost: 1, limit: 'first_each_turn' },
          },
        ],
      }),
    );

    const text = explanation.sections.find((section) => section.kind === 'static')?.steps[0]?.text;
    // The cost is the decision, so it has to be in the sentence a player reads.
    expect(text).toMatch(/1 energy|one energy/i);
    expect(text).toMatch(/ready/i);
    expect(text).toMatch(/^[A-Z].*[.]$/s);
  });

  it('grants a keyword through an arrival without inventing a throttle', () => {
    const explanation = explainCard(
      card({
        staticAbilities: [
          {
            id: 'warhorn',
            activeZone: 'battlefield',
            affects: {
              zone: 'battlefield',
              controller: 'self',
              filter: { cardTypes: ['token'], tags: ['goblin'] },
            },
            effect: {
              type: 'replace_arrival',
              on: 'entered_battlefield',
              onlyOnControllerTurn: true,
              grantKeyword: 'rush',
              grantDuration: 'end_of_turn',
            },
          },
        ],
      }),
    );

    const text = explanation.sections.find((section) => section.kind === 'static')?.steps[0]?.text;
    expect(text).toMatch(/Rush/);
    expect(text).toMatch(/during your turn/i);
    expect(text).toMatch(/until the end of that turn/i);
    // `unlimited` is the default here; nothing may print a limit that is not set.
    expect(text).not.toMatch(/first|each turn(?! )/i);
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

  it('says what a scoped trigger is actually watching', () => {
    // Regression: every scoped ability used to render the registry's bare
    // clause, so a card that watches the whole board read as one that watches
    // only itself — "When this unit is defeated" for an ability that never
    // fires on its own death.
    const explanation = explainCard(
      card({
        abilities: [
          {
            id: 'watch',
            trigger: 'on_defeated',
            scope: { controller: 'self', excludeSource: true, filter: { tags: ['goblin'] } },
            effects: [{ type: 'draw', player: 'self', amount: 1 }],
          },
        ],
      }),
      { database },
    );

    const title = explanation.sections.find((section) => section.kind === 'triggered')?.title ?? '';
    expect(title).toMatch(/another/i);
    expect(title).toMatch(/goblin/i);
    expect(title).not.toBe('When this unit is defeated');
  });

  it('says a throttled trigger only fires once a turn', () => {
    const explanation = explainCard(
      card({
        abilities: [
          {
            id: 'once',
            trigger: 'on_defeated',
            scope: { controller: 'self' },
            limit: 'each_turn',
            effects: [{ type: 'draw', player: 'self', amount: 1 }],
          },
        ],
      }),
      { database },
    );

    const section = explanation.sections.find((s) => s.kind === 'triggered');
    expect(section?.title).toMatch(/first time/i);
    expect(section?.title).toMatch(/each turn/i);
    // Also structured, so a UI can show the throttle without parsing the title.
    expect(section?.limit).toBe('Once each turn.');
  });

  it('spells out a condition that gates the trigger itself', () => {
    const explanation = explainCard(
      card({
        abilities: [
          {
            id: 'gated',
            trigger: 'on_turn_end',
            condition: { kind: 'active_turn', expected: true },
            effects: [{ type: 'draw', player: 'self', amount: 1 }],
          },
        ],
      }),
      { database },
    );

    const title = explanation.sections.find((s) => s.kind === 'triggered')?.title ?? '';
    expect(title).toMatch(/only if it is your turn/i);
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

  it('prefixes an optional instruction with "You may"', () => {
    const explanation = explainCard(
      card({ effects: [{ type: 'draw', optional: true, player: 'self', amount: 1 }] }),
      { database },
    );
    const step = explanation.sections.find((s) => s.kind === 'resolve')?.steps[0];
    expect(step?.text).toMatch(/^You may draw/i);
  });

  it('reads an "if you do" gate as the card idiom rather than the generic one', () => {
    const explanation = explainCard(
      card({
        effects: [
          { type: 'draw', optional: true, player: 'self', amount: 1 },
          {
            type: 'discard',
            condition: { kind: 'previous_step' },
            player: 'self',
            amount: 1,
          },
        ],
      }),
      { database },
    );
    const steps = explanation.sections.find((s) => s.kind === 'resolve')?.steps ?? [];
    expect(steps[1]?.text).toMatch(/if you did/i);
    expect(steps[1]?.text).not.toMatch(/but only if you did/i);
  });

  it('states an additional cost, and that countering does not refund it', () => {
    const explanation = explainCard(
      card({
        type: 'spell',
        attack: undefined,
        health: undefined,
        additionalCosts: [{ type: 'sacrifice', amount: 1, excludeSource: true }],
        effects: [{ type: 'draw', player: 'self', amount: 2 }],
      }),
      { database },
    );
    const section = explanation.sections.find((s) => s.kind === 'resolve');
    expect(section?.costs).toEqual(['sacrifice one other friendly unit']);
    expect(explanation.notes.join(' ')).toMatch(/nothing is refunded/i);
  });

  it('words a value read from a statline as "its ATK" (M02.3)', () => {
    const explanation = explainCard(database.getOrThrow('bastion_commander'), { database });
    const section = explanation.sections.find((entry) => entry.kind === 'triggered');

    expect(section?.title).toMatch(/^The first time .*blocks.* each turn$/i);
    // The number is described, never invented: "+0/+its ATK" is honest about
    // the fact that the amount depends on the unit it lands on.
    expect(section?.steps[0]?.text).toMatch(/\+0\/\+its ATK/);
    expect(section?.steps[0]?.text).toMatch(/for that combat/i);
    expect(section?.steps[0]?.notes.join(' ')).toMatch(
      /counted when the effect resolves, not when the card was played/,
    );
  });

  it('words a derived cost reduction as its own sentence (M02.3)', () => {
    const explanation = explainCard(database.getOrThrow('stitched_abomination'), { database });
    const section = explanation.sections.find((entry) => entry.kind === 'static');

    expect(section?.steps[0]?.text).toBe(
      'This unit costs one less for each unit you control defeated this turn, to a minimum cost of 3.',
    );
  });

  it('words an each-player selection as the simultaneous thing it is (M02.5)', () => {
    const explanation = explainCard(database.getOrThrow('equal_price'), { database });
    const step = explanation.sections.find((entry) => entry.kind === 'resolve')?.steps[0];

    // "friendly" would name the caster's side for three seats out of four, so
    // the ownership is worded relative to whoever is being asked.
    expect(step?.text).toBe('Sacrifice one unit or token controlled by each player.');
    expect(step?.notes.join(' ')).toMatch(/nothing happens until every answer is in/);
    expect(step?.notes.join(' ')).toMatch(/a player with no legal choice is skipped/);
    // The "N legal targets must exist" note is about a single-chooser selection
    // and would be wrong here.
    expect(step?.notes.join(' ')).not.toMatch(/must exist for this to happen/);
  });

  it('words a divided total as a split rather than an amount each (M02.5)', () => {
    const explanation = explainCard(database.getOrThrow('mass_offering'), { database });
    const steps = explanation.sections.find((entry) => entry.kind === 'resolve')?.steps;

    expect(steps?.[1]?.text).toBe(
      'Divide that many damage among all enemy units, tokens or Commanders as you choose.',
    );
    // "That many" is a reference, so the step spells out what it refers to.
    expect(steps?.[1]?.notes.join(' ')).toMatch(/the step before this one acted on/);
    expect(steps?.[1]?.notes.join(' ')).toMatch(/whole share as one hit/);
  });

  it('exposes keyword definitions from the shared registry', () => {
    const explanation = explainCard(database.getOrThrow('dread_sovereign'), { database });
    expect(explanation.keywords.map((keyword) => keyword.id)).toEqual(['venom', 'resilient']);
    // Resilient is inert, and the explanation says so rather than describing a
    // rule the engine does not implement.
    expect(explanation.notes.join(' ')).toMatch(/Resilient has no effect/);
  });
});
