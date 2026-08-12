import { describe, expect, it } from 'vitest';
import { cardDefinitionSchema, isDistributedSelection, type CardDefinitionInput } from './index.js';
import { loadBundledCardData } from './default-set.js';
import { CARD_FIELD_KINDS } from './mechanics.js';
import { lintDisplayText } from './display-text.js';

/**
 * The authoring contract for each-player choices and divided totals (M02.5).
 *
 * Both mechanics reinterpret a field that already existed — `chooser` decides
 * how many seats are asked, `divided` decides what `amount` means — so the
 * schema is the only place that can refuse a combination the engine would have
 * to quietly reinterpret. Every rejection here is a card that would otherwise
 * print a clause nothing reads.
 */

function card(overrides: Partial<CardDefinitionInput> = {}): CardDefinitionInput {
  return {
    schemaVersion: 4,
    id: 'test_shared_choice',
    name: 'Test Shared Choice',
    type: 'spell',
    colorIdentity: ['black'],
    cost: 2,
    ...overrides,
  } as CardDefinitionInput;
}

function messages(input: CardDefinitionInput): string[] {
  const result = cardDefinitionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

const battlefield = (extra: Record<string, unknown> = {}) => ({
  zone: 'battlefield',
  controller: 'self',
  count: 1,
  selection: 'player_choice',
  ...extra,
});

/* ------------------------------------------------ 1. plural choosers */

describe('an each-player selection', () => {
  it('accepts a plural chooser on a player_choice selector', () => {
    const parsed = cardDefinitionSchema.parse(
      card({
        effects: [
          {
            type: 'sacrifice',
            target: { kind: 'entity', selector: battlefield({ chooser: 'all_players' }) },
          },
        ],
      } as Partial<CardDefinitionInput>),
    );
    const effect = parsed.effects[0];
    if (effect?.type !== 'sacrifice' || effect.target.kind !== 'entity') {
      throw new Error('Expected an entity sacrifice');
    }
    expect(isDistributedSelection(effect.target.selector)).toBe(true);
  });

  it('rejects a plural chooser nobody is asked for', () => {
    for (const selection of ['random', 'automatic']) {
      expect(
        messages(
          card({
            effects: [
              {
                type: 'sacrifice',
                target: {
                  kind: 'entity',
                  selector: battlefield({ chooser: 'each_opponent', selection }),
                },
              },
            ],
          } as Partial<CardDefinitionInput>),
        ).join(' '),
      ).toMatch(/only means anything when `selection` is "player_choice"/);
    }
  });

  it('leaves every single-chooser selector alone', () => {
    // The default `self` chooser is one seat, so nothing about the existing
    // catalogue changes: `isDistributedSelection` is false for all of it.
    const { database } = loadBundledCardData();
    const distributed = database
      .all()
      .flatMap((definition) => [
        ...definition.effects,
        ...definition.abilities.flatMap((ability) => ability.effects),
        ...definition.activatedAbilities.flatMap((ability) => ability.effects),
        ...definition.delayedAbilities.flatMap((ability) => ability.effects),
      ])
      .filter(
        (effect) =>
          'target' in effect &&
          effect.target.kind === 'entity' &&
          isDistributedSelection(effect.target.selector),
      );

    // Exactly one card in Wave 1 prints "each player chooses".
    expect(distributed).toHaveLength(1);
  });
});

/* ------------------------------------------------- 2. divided totals */

describe('a divided damage total', () => {
  const divided = (overrides: Record<string, unknown> = {}, amount: unknown = 3) =>
    card({
      effects: [
        {
          type: 'deal_damage',
          amount,
          divided: true,
          target: {
            kind: 'entity',
            selector: {
              zone: 'battlefield',
              controller: 'opponent',
              count: 'all',
              selection: 'player_choice',
              ...overrides,
            },
          },
        },
      ],
    } as Partial<CardDefinitionInput>);

  it('accepts a chosen pool of every legal target', () => {
    expect(messages(divided())).toEqual([]);
  });

  it('rejects a fixed count, which the allocation would never honour', () => {
    expect(messages(divided({ count: 2 })).join(' ')).toMatch(/set `count` to "all"/);
  });

  it('rejects a selection nobody makes', () => {
    expect(messages(divided({ selection: 'automatic' })).join(' ')).toMatch(
      /set `selection` to "player_choice"/,
    );
  });

  it('rejects several seats allocating one total', () => {
    expect(messages(divided({ chooser: 'all_players' })).join(' ')).toMatch(
      /allocated by one player/,
    );
  });

  it('rejects a target that is not a chosen set', () => {
    expect(
      messages(
        card({
          effects: [
            {
              type: 'deal_damage',
              amount: 3,
              divided: true,
              target: { kind: 'players', relation: 'each_opponent' },
            },
          ],
        } as Partial<CardDefinitionInput>),
      ).join(' '),
    ).toMatch(/needs a set of entity targets/);
  });

  it('rejects a total read off a target that has not been chosen yet', () => {
    expect(
      messages(divided({}, { kind: 'stat', of: 'effect_target', stat: 'attack' })).join(' '),
    ).toMatch(/read before any target is chosen/);
  });

  it('leaves an ordinary damage instruction untouched', () => {
    const parsed = cardDefinitionSchema.parse(
      card({
        effects: [
          {
            type: 'deal_damage',
            amount: 2,
            target: { kind: 'entity', selector: battlefield({ controller: 'opponent' }) },
          },
        ],
      } as Partial<CardDefinitionInput>),
    );
    const effect = parsed.effects[0];
    if (effect?.type !== 'deal_damage') throw new Error('Expected damage');
    // Absent, not `false`: no existing card's serialized form gains a field.
    expect(effect.divided).toBeUndefined();
  });
});

/* --------------------------------------------- 3. previous_targets */

describe('a previous_targets amount', () => {
  it('is rejected on the first instruction of a list', () => {
    expect(
      messages(
        card({
          effects: [
            {
              type: 'deal_damage',
              amount: { kind: 'previous_targets' },
              divided: true,
              target: {
                kind: 'entity',
                selector: {
                  zone: 'battlefield',
                  controller: 'opponent',
                  count: 'all',
                  selection: 'player_choice',
                },
              },
            },
          ],
        } as Partial<CardDefinitionInput>),
      ).join(' '),
    ).toMatch(/the first instruction has none/);
  });

  it('is accepted once there is a step before it to count', () => {
    expect(
      messages(
        card({
          effects: [
            {
              type: 'sacrifice',
              target: { kind: 'entity', selector: battlefield({ count: 3, optional: true }) },
            },
            {
              type: 'deal_damage',
              amount: { kind: 'previous_targets' },
              divided: true,
              target: {
                kind: 'entity',
                selector: {
                  zone: 'battlefield',
                  controller: 'opponent',
                  count: 'all',
                  selection: 'player_choice',
                },
              },
            },
          ],
        } as Partial<CardDefinitionInput>),
      ),
    ).toEqual([]);
  });
});

/* ------------------------------------------------- 4. the two cards */

describe('the two shipped cards', () => {
  const { database } = loadBundledCardData();

  it('equal_price asks every seat for one of their own units', () => {
    const definition = database.getOrThrow('equal_price');
    expect(definition.implemented).toBe(true);

    const effect = definition.effects[0];
    if (effect?.type !== 'sacrifice' || effect.target.kind !== 'entity') {
      throw new Error('Expected an entity sacrifice');
    }
    const selector = effect.target.selector;
    expect(selector.chooser).toBe('all_players');
    expect(selector.controller).toBe('self');
    expect(selector.count).toBe(1);
    expect(selector.filter?.cardTypes).toEqual(['unit', 'token']);
  });

  it('mass_offering divides as much damage as it sacrificed', () => {
    const definition = database.getOrThrow('mass_offering');
    expect(definition.implemented).toBe(true);

    const [sacrifice, damage] = definition.effects;
    if (sacrifice?.type !== 'sacrifice' || sacrifice.target.kind !== 'entity') {
      throw new Error('Expected an entity sacrifice');
    }
    expect(sacrifice.target.selector.count).toBe(5);
    expect(sacrifice.target.selector.optional).toBe(true);

    if (damage?.type !== 'deal_damage') throw new Error('Expected damage');
    expect(damage.divided).toBe(true);
    expect(damage.amount).toMatchObject({ kind: 'previous_targets' });
  });

  it('neither reads as drift against its printed text', () => {
    for (const cardId of ['equal_price', 'mass_offering']) {
      expect(lintDisplayText(database.getOrThrow(cardId))).toEqual([]);
    }
  });

  it('moves every card-pool hash, because both are mechanics fields', () => {
    expect(CARD_FIELD_KINDS.effects).toBe('mechanics');
    expect(CARD_FIELD_KINDS.implemented).toBe('mechanics');
  });
});
