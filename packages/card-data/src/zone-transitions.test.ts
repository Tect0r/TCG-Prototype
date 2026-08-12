import { describe, expect, it } from 'vitest';
import {
  cardDefinitionSchema,
  type CardDefinitionInput,
  type TargetDefinitionInput,
} from './index.js';
import { loadBundledCardData } from './default-set.js';

/**
 * The authoring contract for zone transitions (M02.2).
 *
 * `move_card` is one instruction for every destination, so the schema is the
 * only place that can stop a card claiming something a destination cannot do.
 * "Arrives Exhausted" is the case that matters: readiness exists only on the
 * battlefield, so printing it on a move to a hand or a discard pile would be a
 * detail the engine drops — the silent approximation ruleset update §1 forbids.
 */

function card(overrides: Partial<CardDefinitionInput> = {}): CardDefinitionInput {
  return {
    schemaVersion: 4,
    id: 'test_zone_move',
    name: 'Test Zone Move',
    type: 'spell',
    colorIdentity: ['black'],
    cost: 2,
    effects: [{ type: 'draw', amount: 1 }],
    ...overrides,
  } as CardDefinitionInput;
}

const FROM_DISCARD: TargetDefinitionInput = {
  kind: 'entity',
  selector: { zone: 'discard', controller: 'self', filter: { cardTypes: ['unit'] }, count: 1 },
};

function messages(input: CardDefinitionInput): string[] {
  const result = cardDefinitionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('move_card authoring', () => {
  it('accepts a revival that arrives Exhausted', () => {
    const result = cardDefinitionSchema.safeParse(
      card({
        effects: [
          {
            type: 'move_card',
            toZone: 'battlefield',
            entersExhausted: true,
            target: FROM_DISCARD,
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('treats an absent flag as arriving Ready', () => {
    const parsed = cardDefinitionSchema.parse(
      card({ effects: [{ type: 'move_card', toZone: 'battlefield', target: FROM_DISCARD }] }),
    );
    const effect = parsed.effects[0];
    if (effect?.type !== 'move_card') throw new Error('shape');
    expect(effect.entersExhausted).toBeUndefined();
  });

  it('rejects arriving Exhausted anywhere but the battlefield', () => {
    for (const toZone of ['hand', 'discard', 'removed', 'deck'] as const) {
      expect(
        messages(
          card({
            effects: [{ type: 'move_card', toZone, entersExhausted: true, target: FROM_DISCARD }],
          }),
        ),
      ).toContainEqual(expect.stringContaining('can arrive Exhausted'));
    }
  });

  it('checks the rule inside every instruction list, not only top-level effects', () => {
    expect(
      messages(
        card({
          type: 'unit',
          attack: 1,
          health: 1,
          effects: [],
          activatedAbilities: [
            {
              id: 'dig',
              name: 'Dig',
              costs: [{ type: 'exhaust_source' }],
              usageLimit: 'unlimited',
              effects: [
                {
                  type: 'move_card',
                  toZone: 'removed',
                  entersExhausted: true,
                  target: FROM_DISCARD,
                },
              ],
            },
          ],
        }),
      ),
    ).toContainEqual(expect.stringContaining('can arrive Exhausted'));
  });
});

describe('the shipped zone-transition cards', () => {
  const database = loadBundledCardData().database;

  it('implements Corpse Stitcher as a removal from the discard pile', () => {
    const definition = database.get('corpse_stitcher');
    expect(definition?.implemented).toBe(true);
    expect(definition?.unsupportedReason).toBeUndefined();

    const ability = definition?.activatedAbilities[0];
    expect(ability?.costs.map((cost) => cost.type).sort()).toEqual(['energy', 'exhaust_source']);
    const [removal, tokens] = ability?.effects ?? [];
    expect(removal?.type === 'move_card' && removal.toZone).toBe('removed');
    expect(
      removal?.type === 'move_card' &&
        removal.target.kind === 'entity' &&
        removal.target.selector.zone,
    ).toBe('discard');
    expect(tokens?.type === 'create_token' && tokens.tokenCardId).toBe('thrall_token');
  });

  it('implements Grave Reassembly as an optional two-card revival', () => {
    const definition = database.get('grave_reassembly');
    expect(definition?.implemented).toBe(true);
    expect(definition?.unsupportedReason).toBeUndefined();

    const effect = definition?.effects[0];
    expect(effect?.type).toBe('move_card');
    if (effect?.type !== 'move_card' || effect.target.kind !== 'entity') throw new Error('shape');
    expect(effect.toZone).toBe('battlefield');
    expect(effect.entersExhausted).toBe(true);
    expect(effect.target.selector.zone).toBe('discard');
    expect(effect.target.selector.count).toBe(2);
    // "Up to two" — the spell resolves with one, or with none.
    expect(effect.target.selector.optional).toBe(true);
    expect(effect.target.selector.filter?.cost?.max).toBe(3);
  });
});
