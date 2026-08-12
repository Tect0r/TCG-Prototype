import { describe, expect, it } from 'vitest';
import { cardDefinitionSchema, type CardDefinitionInput } from './index.js';
import { loadBundledCardData } from './default-set.js';
import { CARD_FIELD_KINDS } from './mechanics.js';
import { lintDisplayText } from './display-text.js';

/**
 * The authoring contract for replacement effects (M02.4).
 *
 * A replacement rewrites an event that is about to happen, which makes the
 * schema the only place that can stop a card printing a rewrite the layer would
 * never read: a replacement scoped to a hand, or one that changes nothing at
 * all. Both are refused at load rather than accepted and quietly dropped.
 */

function card(overrides: Partial<CardDefinitionInput> = {}): CardDefinitionInput {
  return {
    schemaVersion: 4,
    id: 'test_replacement',
    name: 'Test Replacement',
    type: 'relic',
    colorIdentity: ['blue'],
    cost: 3,
    ...overrides,
  } as CardDefinitionInput;
}

function messages(input: CardDefinitionInput): string[] {
  const result = cardDefinitionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

function withStatic(effect: unknown, affects: unknown = { zone: 'battlefield' }) {
  return card({
    staticAbilities: [{ id: 'test_ability', affects, effect }],
  } as Partial<CardDefinitionInput>);
}

describe('replace_arrival authoring', () => {
  it('accepts an arrival rewritten to Exhausted', () => {
    const parsed = cardDefinitionSchema.parse(
      withStatic(
        {
          type: 'replace_arrival',
          on: 'deployed',
          limit: 'first_each_turn',
          entersExhausted: true,
        },
        { zone: 'battlefield', controller: 'opponent' },
      ),
    );
    const effect = parsed.staticAbilities[0]?.effect;
    expect(effect).toMatchObject({ type: 'replace_arrival', on: 'deployed' });
  });

  it('defaults to every arrival, every turn, with no throttle', () => {
    const parsed = cardDefinitionSchema.parse(
      withStatic({ type: 'replace_arrival', grantKeyword: 'rush' }),
    );
    expect(parsed.staticAbilities[0]?.effect).toMatchObject({
      on: 'entered_battlefield',
      limit: 'unlimited',
      grantDuration: 'end_of_turn',
    });
  });

  it('refuses a replacement that changes nothing about the arrival', () => {
    expect(messages(withStatic({ type: 'replace_arrival', on: 'deployed' }))).toContain(
      'A `replace_arrival` must change the arrival: set `entersExhausted`, `grantKeyword`, or both.',
    );
  });

  it('refuses a replacement scoped to a zone arrivals do not happen in', () => {
    expect(
      messages(withStatic({ type: 'replace_arrival', entersExhausted: true }, { zone: 'hand' })),
    ).toContain('A replacement effect applies on the battlefield; set `zone` to "battlefield".');
  });

  it('refuses a replacement aimed at its own arrival', () => {
    // Its static abilities only switch on once it is already in play, so the
    // moment it would be rewriting has already passed.
    expect(
      messages(
        withStatic(
          { type: 'replace_arrival', entersExhausted: true },
          { zone: 'battlefield', onlySource: true },
        ),
      ),
    ).toContain(
      'A replacement cannot rewrite its own arrival: its static abilities only switch on once it is already in play.',
    );
  });
});

describe('replace_ready authoring', () => {
  it('accepts a paid, once-a-turn readiness replacement', () => {
    const parsed = cardDefinitionSchema.parse(
      withStatic(
        { type: 'replace_ready', energyCost: 1, limit: 'first_each_turn' },
        { zone: 'battlefield', controller: 'opponent' },
      ),
    );
    expect(parsed.staticAbilities[0]?.effect).toMatchObject({
      type: 'replace_ready',
      energyCost: 1,
      limit: 'first_each_turn',
    });
  });

  it('defaults to a free, unthrottled replacement', () => {
    const parsed = cardDefinitionSchema.parse(withStatic({ type: 'replace_ready' }));
    expect(parsed.staticAbilities[0]?.effect).toMatchObject({ energyCost: 0, limit: 'unlimited' });
  });

  it('refuses a replacement scoped off the battlefield', () => {
    expect(messages(withStatic({ type: 'replace_ready' }, { zone: 'discard' }))).toContain(
      'A replacement effect applies on the battlefield; set `zone` to "battlefield".',
    );
  });
});

describe('skip_next_ready and its targets', () => {
  it('accepts the two targets that name a set nobody chooses', () => {
    for (const kind of ['blocked_by_source', 'previous_target'] as const) {
      const result = cardDefinitionSchema.safeParse(
        card({
          type: 'spell',
          effects: [{ type: 'skip_next_ready', target: { kind } }],
        } as Partial<CardDefinitionInput>),
      );
      expect(result.success).toBe(true);
    }
  });
});

describe('the shipped cards', () => {
  const { database } = loadBundledCardData();

  it('finishes the five M02.4 cards', () => {
    for (const id of [
      'containment_array',
      'goblin_warhorn_captain',
      'stasis_keeper',
      'stasis_seal',
      'temporal_anchor',
    ]) {
      const definition = database.getOrThrow(id);
      expect(definition.implemented).toBe(true);
      expect(definition.unsupportedReason).toBeUndefined();
    }
  });

  it('reports no prose drift on any of them', () => {
    for (const id of [
      'containment_array',
      'goblin_warhorn_captain',
      'stasis_keeper',
      'stasis_seal',
      'temporal_anchor',
    ]) {
      expect(lintDisplayText(database.getOrThrow(id))).toEqual([]);
    }
  });

  it('keeps the replacement fields inside the hashed mechanics projection', () => {
    // A replacement changes what a card does, so a card pool that could not see
    // it would hash two different games the same way (M01.3).
    expect(CARD_FIELD_KINDS.staticAbilities).toBe('mechanics');
    expect(CARD_FIELD_KINDS.abilities).toBe('mechanics');
    expect(CARD_FIELD_KINDS.effects).toBe('mechanics');
  });
});
