import { describe, expect, it } from 'vitest';
import {
  cardDefinitionSchema,
  staticAbilityDefinitionSchema,
  type CardDefinitionInput,
} from './index.js';
import { loadBundledCardData } from './default-set.js';

/**
 * The authoring contract for derived values and derived costs (M02.3).
 *
 * Two primitives, and the schema is the only place that can stop either from
 * being written somewhere it could never resolve:
 *
 *  - a value read off a card's statline needs a card to read, so an instruction
 *    with no target — or one aimed at a player — cannot carry one;
 *  - a cost reduction is a fact about its controller's own hand, so a reduction
 *    scoped to another seat or another zone is a printed clause nothing reads.
 *
 * Both would otherwise resolve silently to zero, which is the "approximate a
 * card rather than report it" failure ruleset update §1 forbids.
 */

function card(overrides: Partial<CardDefinitionInput> = {}): CardDefinitionInput {
  return {
    schemaVersion: 4,
    id: 'test_derived',
    name: 'Test Derived',
    type: 'spell',
    colorIdentity: ['white'],
    cost: 2,
    effects: [{ type: 'draw', amount: 1 }],
    ...overrides,
  } as CardDefinitionInput;
}

function messages(input: CardDefinitionInput): string[] {
  const result = cardDefinitionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

function staticMessages(input: unknown): string[] {
  const result = staticAbilityDefinitionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('values read from a statline', () => {
  it('accepts "equal to its ATK" on an instruction that has a target', () => {
    const parsed = cardDefinitionSchema.parse(
      card({
        effects: [
          {
            type: 'modify_stats',
            target: { kind: 'trigger_subject' },
            health: { kind: 'stat', of: 'effect_target', stat: 'attack' },
            duration: 'end_of_combat',
          },
        ],
      }),
    );
    const effect = parsed.effects[0];
    if (effect?.type !== 'modify_stats' || typeof effect.health === 'number') {
      throw new Error('shape');
    }
    expect(effect.health.kind).toBe('stat');
    // The knobs a derived value shares with a counted one, at their defaults.
    expect(effect.health).toMatchObject({ of: 'effect_target', stat: 'attack', plus: 0, sign: 1 });
  });

  it('defaults "it" to the card the instruction is acting on', () => {
    const parsed = cardDefinitionSchema.parse(
      card({
        effects: [
          {
            type: 'deal_damage',
            target: { kind: 'source' },
            amount: { kind: 'stat', stat: 'health' },
          },
        ],
      }),
    );
    const effect = parsed.effects[0];
    if (effect?.type !== 'deal_damage' || typeof effect.amount === 'number')
      throw new Error('shape');
    expect(effect.amount).toMatchObject({ of: 'effect_target', stat: 'health' });
  });

  it('rejects "its ATK" on an instruction with nothing to point at', () => {
    for (const effect of [
      { type: 'draw', amount: { kind: 'stat', of: 'effect_target', stat: 'attack' } },
      {
        type: 'create_token',
        tokenCardId: 'thrall_token',
        amount: { kind: 'stat', of: 'effect_target', stat: 'health' },
      },
    ]) {
      expect(messages(card({ effects: [effect] } as Partial<CardDefinitionInput>))).toContainEqual(
        expect.stringContaining('has no target'),
      );
    }
  });

  it('rejects "its ATK" on an instruction aimed at a player', () => {
    expect(
      messages(
        card({
          effects: [
            {
              type: 'deal_damage',
              target: { kind: 'player', relation: 'opponent' },
              amount: { kind: 'stat', of: 'effect_target', stat: 'attack' },
            },
          ],
        }),
      ),
    ).toContainEqual(expect.stringContaining('A player has no ATK or Health'));
  });

  it('allows "this card\'s ATK" and "the triggering card\'s ATK" anywhere', () => {
    for (const of of ['source', 'trigger_subject'] as const) {
      expect(
        messages(
          card({ effects: [{ type: 'draw', amount: { kind: 'stat', of, stat: 'attack' } }] }),
        ),
      ).toEqual([]);
    }
  });

  it('checks every instruction list, not only the top-level effects', () => {
    expect(
      messages(
        card({
          type: 'unit',
          attack: 1,
          health: 1,
          effects: [],
          abilities: [
            {
              id: 'greed',
              trigger: 'on_deployed',
              effects: [
                { type: 'draw', amount: { kind: 'stat', of: 'effect_target', stat: 'attack' } },
              ],
            },
          ],
        }),
      ),
    ).toContainEqual(expect.stringContaining('has no target'));
  });
});

describe('cost reduction authoring', () => {
  const ability = (overrides: Record<string, unknown> = {}) => ({
    id: 'discount',
    activeZone: 'hand',
    affects: { zone: 'hand', controller: 'self', onlySource: true },
    effect: {
      type: 'cost_reduction',
      amount: { kind: 'count', count: { subject: 'units_defeated_this_turn', controller: 'self' } },
      minimum: 3,
    },
    ...overrides,
  });

  it('accepts a self-scaling discount on a card in hand', () => {
    expect(staticMessages(ability())).toEqual([]);
  });

  it('rejects discounting another seat’s cards', () => {
    expect(
      staticMessages(ability({ affects: { zone: 'hand', controller: 'opponent' } })),
    ).toContainEqual(expect.stringContaining('applies to its own controller'));
  });

  it('rejects discounting a zone nothing is played from', () => {
    expect(
      staticMessages(ability({ affects: { zone: 'discard', controller: 'self' } })),
    ).toContainEqual(expect.stringContaining('cards in hand'));
  });

  it('rejects an ability that is both only-source and not-source', () => {
    expect(
      staticMessages(
        ability({
          affects: { zone: 'hand', controller: 'self', onlySource: true, excludeSource: true },
        }),
      ),
    ).toContainEqual(expect.stringContaining('opposites'));
  });

  it('treats an absent floor as "this can make a card free"', () => {
    const parsed = staticAbilityDefinitionSchema.parse(
      ability({
        effect: {
          type: 'cost_reduction',
          amount: { kind: 'count', count: { subject: 'units', controller: 'self' } },
        },
      }),
    );
    if (parsed.effect.type !== 'cost_reduction') throw new Error('shape');
    expect(parsed.effect.minimum).toBe(0);
  });
});

describe('the shipped derived-value cards', () => {
  const database = loadBundledCardData().database;

  it('implements Bastion Commander as a once-a-turn block bonus', () => {
    const definition = database.get('bastion_commander');
    expect(definition?.implemented).toBe(true);
    expect(definition?.unsupportedReason).toBeUndefined();

    const ability = definition?.abilities[0];
    expect(ability?.trigger).toBe('on_block');
    // "The first friendly Unit that blocks each turn": one fire per turn, and
    // only about a card its own controller controls.
    expect(ability?.limit).toBe('each_turn');
    expect(ability?.scope?.controller).toBe('self');
    // A Commander's ability is battlefield-only unless its text says otherwise
    // (rule adjustment §3), and this one does not.
    expect(ability?.activeZone).toBe('battlefield');

    const effect = ability?.effects[0];
    if (effect?.type !== 'modify_stats') throw new Error('shape');
    expect(effect.target.kind).toBe('trigger_subject');
    expect(effect.attack).toBe(0);
    expect(effect.health).toMatchObject({ kind: 'stat', of: 'effect_target', stat: 'attack' });
    // "for that combat" — gone before the second Main Phase.
    expect(effect.duration).toBe('end_of_combat');
  });

  it('implements Stitched Abomination as a self-scaling discount with a floor', () => {
    const definition = database.get('stitched_abomination');
    expect(definition?.implemented).toBe(true);
    expect(definition?.unsupportedReason).toBeUndefined();
    expect(definition?.cost).toBe(6);

    const ability = definition?.staticAbilities[0];
    expect(ability?.activeZone).toBe('hand');
    expect(ability?.affects.onlySource).toBe(true);
    if (ability?.effect.type !== 'cost_reduction') throw new Error('shape');
    expect(ability.effect.minimum).toBe(3);
    expect(ability.effect.amount).toMatchObject({
      kind: 'count',
      count: { subject: 'units_defeated_this_turn', controller: 'self' },
      per: 1,
    });
  });
});
