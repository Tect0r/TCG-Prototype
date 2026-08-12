import { describe, expect, it } from 'vitest';
import { cardDefinitionSchema, type CardDefinitionInput } from './index.js';
import { CARD_FIELD_KINDS } from './mechanics.js';

/**
 * The authoring contract for delayed effects (M02.1).
 *
 * A `schedule_delayed` instruction and the `delayedAbilities` entry it names are
 * two halves of one card, and the schema is the only thing that can keep them in
 * step. Every rule here exists because breaking it produces a card that reads as
 * doing something and does nothing — the silent approximation ruleset update §1
 * forbids.
 */

function card(overrides: Partial<CardDefinitionInput> = {}): CardDefinitionInput {
  return {
    schemaVersion: 4,
    id: 'test_delayed',
    name: 'Test Delayed',
    type: 'spell',
    colorIdentity: ['black'],
    cost: 2,
    effects: [{ type: 'draw', amount: 1 }],
    ...overrides,
  } as CardDefinitionInput;
}

type DelayedInput = NonNullable<CardDefinitionInput['delayedAbilities']>[number];

const DRAW_LATER: DelayedInput = {
  id: 'later',
  boundary: 'end_of_turn',
  effects: [{ type: 'draw', amount: 1 }],
};

function messages(input: CardDefinitionInput): string[] {
  const result = cardDefinitionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe('delayed ability wiring', () => {
  it('accepts a scheduled delayed ability', () => {
    const result = cardDefinitionSchema.safeParse(
      card({
        effects: [{ type: 'schedule_delayed', delayedAbilityId: 'later' }],
        delayedAbilities: [DRAW_LATER],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a schedule that names no entry', () => {
    expect(
      messages(card({ effects: [{ type: 'schedule_delayed', delayedAbilityId: 'missing' }] })),
    ).toContainEqual(expect.stringContaining('No `delayedAbilities` entry with id "missing"'));
  });

  it('rejects a delayed ability nothing schedules', () => {
    expect(messages(card({ delayedAbilities: [DRAW_LATER] }))).toContainEqual(
      expect.stringContaining('Nothing on this card schedules "later"'),
    );
  });

  it('rejects two delayed abilities sharing an ID', () => {
    expect(
      messages(
        card({
          effects: [{ type: 'schedule_delayed', delayedAbilityId: 'later' }],
          delayedAbilities: [DRAW_LATER, DRAW_LATER],
        }),
      ),
    ).toContainEqual(expect.stringContaining('must be unique'));
  });

  it('rejects a watch with nothing to watch', () => {
    expect(
      messages(
        card({
          effects: [{ type: 'schedule_delayed', delayedAbilityId: 'later' }],
          delayedAbilities: [{ ...DRAW_LATER, trigger: 'on_defeated' }],
        }),
      ),
    ).toContainEqual(expect.stringContaining('must name the subject'));
  });

  it('rejects a delayed ability scheduling another one', () => {
    expect(
      messages(
        card({
          effects: [{ type: 'schedule_delayed', delayedAbilityId: 'later' }],
          delayedAbilities: [
            {
              id: 'later',
              boundary: 'end_of_turn',
              effects: [{ type: 'schedule_delayed', delayedAbilityId: 'later' }],
            },
          ],
        }),
      ),
    ).toContainEqual('A delayed ability cannot schedule another delayed ability.');
  });

  it('rejects countering from inside a delayed body', () => {
    expect(
      messages(
        card({
          type: 'reaction',
          reaction: { windows: ['when_opponent_plays_spell'] },
          effects: [{ type: 'schedule_delayed', delayedAbilityId: 'later' }],
          delayedAbilities: [
            { id: 'later', boundary: 'end_of_turn', effects: [{ type: 'counter' }] },
          ],
        }),
      ),
    ).toContainEqual(expect.stringContaining('Countering happens inside a Reaction window'));
  });

  it('rejects "the previous target" when there is no previous instruction', () => {
    expect(
      messages(
        card({
          effects: [{ type: 'schedule_delayed', delayedAbilityId: 'later' }],
          delayedAbilities: [{ ...DRAW_LATER, subject: 'previous_target' }],
        }),
      ),
    ).toContainEqual(expect.stringContaining('the first instruction has none'));
  });

  it('accepts "the previous target" once something precedes it', () => {
    const result = cardDefinitionSchema.safeParse(
      card({
        effects: [
          {
            type: 'modify_stats',
            target: {
              kind: 'entity',
              selector: { zone: 'battlefield', controller: 'self', count: 1 },
            },
            attack: 1,
          },
          { type: 'schedule_delayed', delayedAbilityId: 'later' },
        ],
        delayedAbilities: [{ ...DRAW_LATER, trigger: 'on_defeated', subject: 'previous_target' }],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a source-bound modifier inside a spell’s delayed body', () => {
    expect(
      messages(
        card({
          effects: [{ type: 'schedule_delayed', delayedAbilityId: 'later' }],
          delayedAbilities: [
            {
              id: 'later',
              boundary: 'end_of_turn',
              effects: [
                {
                  type: 'modify_stats',
                  target: { kind: 'source' },
                  attack: 1,
                  duration: 'while_source_present',
                },
              ],
            },
          ],
        }),
      ),
    ).toContainEqual(expect.stringContaining('cannot sustain a `while_source_present` modifier'));
  });

  it('counts as a mechanic, so a delayed edit moves every replay hash', () => {
    expect(CARD_FIELD_KINDS.delayedAbilities).toBe('mechanics');
  });
});
