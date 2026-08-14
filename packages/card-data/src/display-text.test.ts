import { describe, expect, it } from 'vitest';
import { cardDefinitionSchema, type CardDefinitionInput } from './index.js';
import { loadBundledCardData } from './default-set.js';
import { lintDisplayText } from './display-text.js';

/**
 * The per-card structure/text agreement check (M02.6).
 *
 * `lintDisplayText` runs in both directions and the two catch different bugs.
 * Prose promising behaviour the card does not have is a card that will
 * disappoint a player. Behaviour the prose never mentions is worse: the card
 * does something nobody reading it could have known about, and no amount of
 * hand-written flavour text makes that acceptable. Neither direction has an
 * exemption for a card whose `text` block is curated — a curated explanation
 * describes the same card the engine runs, or it is wrong.
 *
 * It is a warning at the loader, which is what lets a half-finished card in a
 * development set still load. In a `playtest` or `active` set the content build
 * turns every one of these warnings into a hard error, so for `precon_wave_1`
 * this is a gate rather than advice.
 */

const bundle = loadBundledCardData();
const wave1 = bundle.sets.find((set) => set.setId === 'precon_wave_1');
if (!wave1) throw new Error('No precon_wave_1 set in the bundled content.');

function card(overrides: Partial<CardDefinitionInput>): CardDefinitionInput {
  return {
    schemaVersion: 4,
    id: 'test_drift',
    name: 'Test Drift',
    type: 'spell',
    colorIdentity: ['blue'],
    cost: 2,
    ...overrides,
  } as CardDefinitionInput;
}

function codes(input: CardDefinitionInput): string[] {
  return lintDisplayText(cardDefinitionSchema.parse(input)).map((issue) => issue.code);
}

describe('the Wave 1 catalogue', () => {
  it('has 155 cards and every one of them is implemented', () => {
    expect(wave1.cards).toHaveLength(155);
    expect(wave1.cards.filter((entry) => !entry.implemented)).toEqual([]);
  });

  it('carries no obsolete unsupportedReason', () => {
    const stale = wave1.cards.filter((entry) => entry.unsupportedReason !== undefined);
    expect(stale.map((entry) => entry.id)).toEqual([]);
  });

  it.each(wave1.cards.map((entry) => [entry.id, entry] as const))(
    '%s says what it does and does what it says',
    (_id, definition) => {
      expect(lintDisplayText(definition)).toEqual([]);
    },
  );
});

describe('prose promising behaviour the card lacks', () => {
  it('is reported', () => {
    expect(
      codes(card({ displayText: 'Draw a card.', effects: [{ type: 'discard', amount: 1 }] })),
    ).toContain('display_text/effect_mismatch');
  });

  it('is not reported when the behaviour is really there', () => {
    expect(
      codes(
        card({
          displayText: 'Draw a card.',
          effects: [{ type: 'draw', player: 'self', amount: 1 }],
        }),
      ),
    ).toEqual([]);
  });
});

describe('behaviour the prose never mentions', () => {
  it('is reported for an effect', () => {
    expect(
      codes(
        card({
          displayText: 'Draw a card.',
          effects: [
            { type: 'draw', player: 'self', amount: 1 },
            { type: 'discard', amount: 1 },
          ],
        }),
      ),
    ).toContain('display_text/unstated_effect');
  });

  it('is reported for a keyword the card carries', () => {
    expect(
      codes(
        card({
          id: 'test_quiet_body',
          type: 'unit',
          attack: 2,
          health: 2,
          keywords: ['guardian'],
          displayText: 'A stoic body.',
        }),
      ),
    ).toContain('display_text/unstated_keyword');
  });

  it('is not reported for a keyword used only to choose a target', () => {
    expect(
      codes(
        card({
          displayText: 'A friendly Guardian gains Barrier.',
          effects: [
            {
              type: 'grant_keyword',
              keyword: 'barrier',
              target: {
                kind: 'entity',
                selector: {
                  zone: 'battlefield',
                  controller: 'self',
                  filter: { keywords: ['guardian'] },
                  count: 1,
                },
              },
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('is reported even when the card carries curated explanatory text', () => {
    const codesFound = codes(
      card({
        displayText: 'Draw a card.',
        effects: [
          { type: 'draw', player: 'self', amount: 1 },
          { type: 'discard', amount: 1 },
        ],
        text: {
          summary: 'A careful trade.',
          notes: ['You draw first, then choose what to let go of.'],
        },
      }),
    );
    expect(codesFound).toContain('display_text/unstated_effect');
  });

  it('does not report a trigger the card only waits for', () => {
    // "The first time you sacrifice a Unit each turn, draw a card" performs a
    // draw and no sacrifice; requiring the word would be requiring the card to
    // narrate somebody else's action.
    expect(
      codes(
        card({
          id: 'test_watcher',
          type: 'unit',
          attack: 1,
          health: 1,
          displayText: 'The first time you sacrifice a Unit each turn, draw a card.',
          abilities: [
            {
              id: 'watch',
              trigger: 'on_sacrifice',
              scope: { controller: 'self' },
              limit: 'each_turn',
              effects: [{ type: 'draw', player: 'self', amount: 1 }],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

/**
 * M07.8. The three cards below are reproduced exactly as they shipped before the
 * consistency pass, so this suite fails if any of them is ever put back.
 *
 * Each rule is asserted twice — against the broken card and against the
 * corrected one — because a semantic check that has quietly stopped matching
 * reports a clean catalogue in the same words as one that works.
 */
describe('prose and structured targets that disagree about who is reached', () => {
  it('rejects "restore Health to your Commander" on a card that heals the player', () => {
    // `mourning_keeper`, verbatim, before the correction.
    const broken = card({
      id: 'test_mourner',
      type: 'unit',
      colorIdentity: ['black'],
      attack: 2,
      health: 3,
      displayText:
        'The first time another friendly Unit is defeated each turn, restore 1 Health to your Commander.',
      abilities: [
        {
          id: 'mourn',
          trigger: 'on_defeated',
          scope: { controller: 'self', excludeSource: true },
          limit: 'each_turn',
          effects: [
            {
              type: 'heal',
              target: { kind: 'player', relation: 'self', selection: 'automatic' },
              amount: 1,
            },
          ],
        },
      ],
    });
    expect(codes(broken)).toContain('display_text/player_as_commander');

    const corrected = card({
      ...broken,
      displayText:
        'The first time another friendly Unit is defeated each turn, restore 1 Health to you.',
    });
    expect(codes(corrected)).toEqual([]);
  });

  it('rejects "damage to a Commander" on a card that damages the player', () => {
    const broken = card({
      id: 'test_blaster',
      displayText: 'Deal 2 damage to the enemy Commander.',
      effects: [
        { type: 'deal_damage', target: { kind: 'player', relation: 'opponent' }, amount: 2 },
      ],
    });
    expect(codes(broken)).toContain('display_text/player_as_commander');

    const corrected = card({ ...broken, displayText: 'Deal 2 damage to an opponent.' });
    expect(codes(corrected)).toEqual([]);
  });

  it('allows Commander prose on a card that really targets the permanent', () => {
    // The exemption is semantic, not a card-ID list: this card selects a
    // Commander on the battlefield, so naming one is describing what it does.
    expect(
      codes(
        card({
          id: 'test_permanent_hit',
          displayText: 'Deal 2 damage to an enemy Unit or Commander.',
          effects: [
            {
              type: 'deal_damage',
              target: {
                kind: 'entity',
                selector: {
                  zone: 'battlefield',
                  controller: 'opponent',
                  filter: { cardTypes: ['unit', 'commander'] },
                },
              },
              amount: 2,
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('rejects player-damage prose on a card that only selects battlefield entities', () => {
    // `goblin_powder_runner`'s corrected wording on its old structured target.
    const broken = card({
      id: 'test_runner',
      type: 'unit',
      colorIdentity: ['red'],
      attack: 2,
      health: 1,
      displayText: 'When this Unit is defeated, deal 1 damage to an opponent.',
      abilities: [
        {
          id: 'powder_blast',
          trigger: 'on_defeated',
          effects: [
            {
              type: 'deal_damage',
              amount: 1,
              target: {
                kind: 'entity',
                selector: {
                  zone: 'battlefield',
                  controller: 'opponent',
                  filter: { cardTypes: ['unit', 'token', 'commander'] },
                },
              },
            },
          ],
        },
      ],
    });
    expect(codes(broken)).toContain('display_text/unstated_player_target');

    const corrected = card({
      ...broken,
      abilities: [
        {
          id: 'powder_blast',
          trigger: 'on_defeated',
          effects: [
            {
              type: 'deal_damage',
              amount: 1,
              target: { kind: 'player', relation: 'opponent' },
            },
          ],
        },
      ],
    });
    expect(codes(corrected)).toEqual([]);
  });

  it('rejects "enters the battlefield" on a card whose arrival is the deploy form', () => {
    // `goblin_recruiter`, verbatim, before Q48 was answered.
    const broken = card({
      id: 'test_recruiter',
      type: 'unit',
      colorIdentity: ['red'],
      attack: 2,
      health: 2,
      displayText: 'When this Unit enters the battlefield, create one Goblin Token.',
      effects: [
        { type: 'create_token', tokenCardId: 'goblin_token', amount: 1, controller: 'self' },
      ],
    });
    expect(codes(broken)).toContain('display_text/entry_timing');

    const corrected = card({ ...broken, displayText: 'When deployed, create one Goblin Token.' });
    expect(codes(corrected)).toEqual([]);
  });

  it('allows "enters the battlefield" on a card that really uses the wider trigger', () => {
    expect(
      codes(
        card({
          id: 'test_reviver',
          type: 'unit',
          colorIdentity: ['red'],
          attack: 2,
          health: 2,
          displayText: 'When this Unit enters the battlefield, create one Goblin Token.',
          abilities: [
            {
              id: 'arrive',
              trigger: 'on_entered_battlefield',
              effects: [
                {
                  type: 'create_token',
                  tokenCardId: 'goblin_token',
                  amount: 1,
                  controller: 'self',
                },
              ],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });
});
