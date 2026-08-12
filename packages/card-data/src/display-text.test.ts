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
