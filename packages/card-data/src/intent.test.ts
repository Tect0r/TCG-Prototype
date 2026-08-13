import { describe, expect, it } from 'vitest';
import { effectDefinitionSchema, type EffectDefinition, type EffectType } from './schema/effect.js';
import { CHOICE_INTENTS, effectIntent, effectIntentGaps, type ChoiceIntent } from './intent.js';

/**
 * The valence of every instruction a choice can be raised for (M05.3).
 *
 * The claim under test is narrow and load-bearing: an instruction's intent comes
 * from the instruction, and from nothing else. The pilots used to derive it by
 * scanning a card's whole effect list, which cannot distinguish the two halves of
 * a card that removes one unit and buffs another — so a table keyed by
 * instruction is the thing that has to be right, and a table keyed by card is
 * the thing that was wrong.
 *
 * The case table is a mapped type over the schema's own `EffectType`, so adding
 * an instruction without classifying its valence here is a **compile error** in
 * this file as well as in `intent.ts`.
 */

const effect = (input: unknown): EffectDefinition => effectDefinitionSchema.parse(input);

const oneUnit = (controller: 'self' | 'opponent' = 'self') => ({
  kind: 'entity' as const,
  selector: { zone: 'battlefield', controller, count: 1, selection: 'player_choice' },
});

const fromDiscard = () => ({
  kind: 'entity' as const,
  selector: { zone: 'discard', controller: 'self', count: 1, selection: 'player_choice' },
});

describe('every instruction has a classified intent', () => {
  it('classifies every effect the schema defines, and no others', () => {
    expect(effectIntentGaps()).toEqual([]);
  });

  /** One representative instruction per member of the vocabulary. */
  const CASES: { readonly [K in EffectType]: { input: unknown; intent: ChoiceIntent } } = {
    draw: { input: { type: 'draw', player: 'self', amount: 1 }, intent: 'benefit' },
    discard: { input: { type: 'discard', player: 'opponent', amount: 1 }, intent: 'detriment' },
    deal_damage: {
      input: { type: 'deal_damage', target: oneUnit('opponent'), amount: 2 },
      intent: 'detriment',
    },
    heal: { input: { type: 'heal', target: oneUnit(), amount: 2 }, intent: 'benefit' },
    modify_stats: {
      input: { type: 'modify_stats', target: oneUnit(), attack: 2, health: 2 },
      intent: 'benefit',
    },
    grant_keyword: {
      input: { type: 'grant_keyword', target: oneUnit(), keyword: 'guardian' },
      intent: 'benefit',
    },
    remove_keyword: {
      input: { type: 'remove_keyword', target: oneUnit('opponent'), keyword: 'guardian' },
      intent: 'detriment',
    },
    create_token: {
      input: { type: 'create_token', tokenCardId: 'goblin_token', amount: 1 },
      intent: 'benefit',
    },
    destroy: { input: { type: 'destroy', target: oneUnit('opponent') }, intent: 'detriment' },
    sacrifice: { input: { type: 'sacrifice', target: oneUnit() }, intent: 'detriment' },
    return_to_hand: {
      input: { type: 'return_to_hand', target: oneUnit('opponent') },
      intent: 'detriment',
    },
    search_zone: {
      input: { type: 'search_zone', player: 'self', zone: 'deck', destination: 'hand' },
      intent: 'benefit',
    },
    reorder_zone: {
      input: { type: 'reorder_zone', player: 'self', zone: 'deck', amount: 3 },
      intent: 'benefit',
    },
    modify_cost: { input: { type: 'modify_cost', player: 'self', delta: -1 }, intent: 'benefit' },
    prevent_damage: {
      input: { type: 'prevent_damage', target: oneUnit(), amount: 2 },
      intent: 'benefit',
    },
    exhaust: { input: { type: 'exhaust', target: oneUnit('opponent') }, intent: 'detriment' },
    ready: { input: { type: 'ready', target: oneUnit() }, intent: 'benefit' },
    skip_next_ready: {
      input: { type: 'skip_next_ready', target: oneUnit('opponent') },
      intent: 'detriment',
    },
    move_card: {
      input: { type: 'move_card', target: fromDiscard(), toZone: 'battlefield' },
      intent: 'benefit',
    },
    counter: { input: { type: 'counter', unlessPays: 0 }, intent: 'detriment' },
    schedule_delayed: {
      input: { type: 'schedule_delayed', delayedAbilityId: 'later' },
      intent: 'neutral',
    },
  };

  for (const [type, entry] of Object.entries(CASES)) {
    it(`reads ${type} as ${entry.intent}`, () => {
      expect(effectIntent(effect(entry.input))).toBe(entry.intent);
    });
  }

  it('only ever answers with a member of the vocabulary', () => {
    for (const entry of Object.values(CASES)) {
      expect(CHOICE_INTENTS).toContain(effectIntent(effect(entry.input)));
    }
  });
});

describe('the four instructions whose printed numbers decide their direction', () => {
  it('reads a negative stat modifier as a detriment and a positive one as a benefit', () => {
    expect(effectIntent(effect({ type: 'modify_stats', target: oneUnit(), attack: -2 }))).toBe(
      'detriment',
    );
    expect(effectIntent(effect({ type: 'modify_stats', target: oneUnit(), attack: 2 }))).toBe(
      'benefit',
    );
    // "+0/+0" changes nothing, and saying so beats guessing a direction.
    expect(effectIntent(effect({ type: 'modify_stats', target: oneUnit() }))).toBe('neutral');
  });

  it('reads a derived stat modifier by its sign rather than by its magnitude', () => {
    const shrink = {
      type: 'modify_stats',
      target: oneUnit('opponent'),
      attack: { kind: 'count', count: { subject: 'units', controller: 'self' }, sign: -1 },
    };
    expect(effectIntent(effect(shrink))).toBe('detriment');
  });

  it('reads a discount as a benefit and a tax as a detriment', () => {
    expect(effectIntent(effect({ type: 'modify_cost', player: 'self', delta: -2 }))).toBe(
      'benefit',
    );
    expect(effectIntent(effect({ type: 'modify_cost', player: 'opponent', delta: 2 }))).toBe(
      'detriment',
    );
  });

  it('reads a search by where the chosen card ends up, not by the fact of searching', () => {
    const find = { type: 'search_zone', player: 'self', zone: 'deck', destination: 'hand' };
    // "Look at the top three, put one on the bottom" is the same instruction
    // asking for the card the chooser wants least.
    const bury = {
      type: 'search_zone',
      player: 'self',
      zone: 'deck',
      destination: 'deck',
      fromTop: 3,
    };
    expect(effectIntent(effect(find))).toBe('benefit');
    expect(effectIntent(effect(bury))).toBe('detriment');
  });

  it('reads a zone move by the journey rather than the destination alone', () => {
    const revive = { type: 'move_card', target: fromDiscard(), toZone: 'battlefield' };
    const recur = { type: 'move_card', target: fromDiscard(), toZone: 'hand' };
    const bounce = { type: 'move_card', target: oneUnit('opponent'), toZone: 'hand' };
    const exile = { type: 'move_card', target: oneUnit('opponent'), toZone: 'removed' };

    expect(effectIntent(effect(revive))).toBe('benefit');
    expect(effectIntent(effect(recur))).toBe('benefit');
    expect(effectIntent(effect(bounce))).toBe('detriment');
    expect(effectIntent(effect(exile))).toBe('detriment');
  });
});
