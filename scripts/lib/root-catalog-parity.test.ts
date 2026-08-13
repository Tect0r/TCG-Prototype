import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  collectRootCatalogParity,
  compareCards,
  comparePrecons,
  renderParityReport,
  type RootCard,
  type RootPreconCatalog,
} from './root-catalog-parity.js';
import {
  bundledFormat,
  type CardDefinition,
  type PlayFormat,
  type PreconDefinition,
} from '@tcg/card-data';

/** The shipped Wave 1 format, which the root catalogues claim to describe. */
function wave1Format(): PlayFormat {
  const format = bundledFormat('precon_wave_1');
  if (!format) throw new Error('The `precon_wave_1` format must be bundled for this test.');
  return format;
}

/**
 * The measurement behind Q40 (M07.6), asserted rather than narrated.
 *
 * Two halves. The first is the comparison itself, on synthetic inputs: a field
 * that differs has to be reported, an ID present on one side only has to be
 * reported as such rather than as a difference, and the two places where order
 * genuinely carries no meaning — a colour identity, a keyword list, a precon's
 * card list — must not be reported as drift.
 *
 * The second is the repository: the tracked root `cards.json` / `precons.json`
 * against the content the game actually plays. The verdict this records is that
 * the import was faithful in every structural field and that the six remaining
 * differences are all printed rules text where the **root copy is the stale
 * one**, describing rules this game no longer has. That is the evidence Q40's
 * answer rests on, so it is a test rather than a sentence.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

function rootCard(overrides: Partial<RootCard> = {}): RootCard {
  return {
    id: 'test_card',
    name: 'Test Card',
    type: 'unit',
    faction: 'goblin',
    colorIdentity: ['red'],
    power: 'low',
    identity: 'Swarm Unit',
    cost: 2,
    attack: 2,
    health: 2,
    keywords: [],
    rulesText: null,
    collectible: true,
    ...overrides,
  };
}

function contentCard(overrides: Partial<CardDefinition> = {}): CardDefinition {
  return {
    schemaVersion: 3,
    id: 'test_card',
    name: 'Test Card',
    type: 'unit',
    colorIdentity: ['red'],
    cost: 2,
    attack: 2,
    health: 2,
    unique: false,
    collectible: true,
    tags: [],
    keywords: [],
    design: { faction: 'goblin', identity: 'Swarm Unit', power: 'low' },
    effects: [],
    additionalCosts: [],
    abilities: [],
    activatedAbilities: [],
    staticAbilities: [],
    delayedAbilities: [],
    implemented: true,
    ...overrides,
  } as CardDefinition;
}

describe('compareCards', () => {
  it('reports a field the two representations disagree about', () => {
    const parity = compareCards(
      [rootCard({ rulesText: 'Deal 1 damage to the enemy Commander.' })],
      [contentCard({ displayText: 'Deal 1 damage to an opponent.' })],
    );

    expect(parity.onlyInRoot).toEqual([]);
    expect(parity.onlyInContent).toEqual([]);
    expect(parity.differences).toEqual([
      {
        subject: 'test_card',
        field: 'rulesText → displayText',
        root: '"Deal 1 damage to the enemy Commander."',
        content: '"Deal 1 damage to an opponent."',
      },
    ]);
  });

  it('sees through the two shapes: design labels are nested in a runtime card', () => {
    const parity = compareCards(
      [rootCard({ faction: 'guardian', identity: 'Wall', power: 'high' })],
      [contentCard({ design: { faction: 'guardian', identity: 'Wall', power: 'high' } })],
    );
    expect(parity.differences).toEqual([]);
  });

  it('reports a missing card as missing rather than as a difference', () => {
    const parity = compareCards(
      [rootCard({ id: 'only_authored' }), rootCard({ id: 'shared' })],
      [contentCard({ id: 'shared' }), contentCard({ id: 'only_shipped' })],
    );

    expect(parity.onlyInRoot).toEqual(['only_authored']);
    expect(parity.onlyInContent).toEqual(['only_shipped']);
    expect(parity.differences).toEqual([]);
    expect(parity.rootCount).toBe(2);
    expect(parity.contentCount).toBe(2);
  });

  it('treats a colour identity and a keyword list as sets, because they are', () => {
    const parity = compareCards(
      [rootCard({ colorIdentity: ['red', 'white'], keywords: ['guardian', 'armored'] })],
      [contentCard({ colorIdentity: ['white', 'red'], keywords: ['armored', 'guardian'] })],
    );
    expect(parity.differences).toEqual([]);
  });

  it('still catches a keyword that was gained or lost', () => {
    const parity = compareCards(
      [rootCard({ keywords: ['guardian'] })],
      [contentCard({ keywords: [] })],
    );
    expect(parity.differences.map((entry) => entry.field)).toEqual(['keywords']);
  });

  it('distinguishes an absent statline from a zero one', () => {
    const parity = compareCards([rootCard({ attack: 0 })], [contentCard({ attack: undefined })]);
    expect(parity.differences).toEqual([
      { subject: 'test_card', field: 'attack', root: '0', content: 'null' },
    ]);
  });
});

describe('comparePrecons', () => {
  const format = wave1Format();

  function rootCatalog(overrides: Partial<RootPreconCatalog['format']> = {}): RootPreconCatalog {
    return {
      schemaVersion: 1,
      catalogId: 'precon_wave_1',
      format: {
        deckSize: format.deck.size,
        singleton: format.deck.singleton,
        commanderOutsideDeck: format.deck.commanderOutsideDeck,
        ...overrides,
      },
      precons: [
        {
          id: 'precon_goblin_swarm',
          name: 'Goblin Swarm',
          strategy: 'Go wide.',
          commanderId: 'goblin_warboss',
          cardIds: ['goblin_sneak', 'goblin_spearman'],
        },
      ],
    };
  }

  const shipped: PreconDefinition = {
    schemaVersion: 1,
    id: 'precon_goblin_swarm',
    name: 'Goblin Swarm',
    formatId: 'precon_wave_1',
    strategy: 'Go wide.',
    commanderId: 'goblin_warboss',
    cardIds: ['goblin_spearman', 'goblin_sneak'],
  };

  it('accepts a different card order, which a precon says is not meaningful', () => {
    expect(comparePrecons(rootCatalog(), [shipped], format).differences).toEqual([]);
  });

  it('catches a substituted card', () => {
    const parity = comparePrecons(
      rootCatalog(),
      [{ ...shipped, cardIds: ['goblin_spearman', 'goblin_bruiser'] }],
      format,
    );
    expect(parity.differences.map((entry) => entry.field)).toEqual(['cardIds']);
  });

  it('compares the construction rules the root file states, not only the decks', () => {
    const parity = comparePrecons(rootCatalog({ deckSize: 30 }), [shipped], format);
    expect(parity.differences).toEqual([
      {
        subject: 'format',
        field: 'deckSize',
        root: '30',
        content: String(format.deck.size),
      },
    ]);
  });
});

describe('this repository', () => {
  const parity = collectRootCatalogParity(REPO_ROOT);

  it('describes the same set and format on both sides, card for card', () => {
    expect(parity.catalogId).toBe('precon_wave_1');
    expect(parity.cards.onlyInRoot).toEqual([]);
    expect(parity.cards.onlyInContent).toEqual([]);
    expect(parity.cards.rootCount).toBe(parity.cards.contentCount);
  });

  it('agrees on every structural field of every card', () => {
    // Everything a card *is* — its name, type, colour, cost, statline, keywords,
    // collectibility and the designer's three labels. The import lost none of it.
    const structural = parity.cards.differences.filter(
      (entry) => entry.field !== 'rulesText → displayText',
    );
    expect(structural).toEqual([]);
  });

  it('ships the four authored precons unchanged, under the authored format rules', () => {
    expect(parity.precons.onlyInRoot).toEqual([]);
    expect(parity.precons.onlyInContent).toEqual([]);
    expect(parity.precons.differences).toEqual([]);
    expect(parity.precons.rootCount).toBe(4);
  });

  it('differs only in printed text, and only where the root copy is the stale one', () => {
    expect(parity.cards.differences.map((entry) => entry.subject).sort()).toEqual([
      'chief_containment_scholar',
      'containment_pulse',
      'cruel_preacher',
      'dismantle_the_device',
      'retaliating_guard',
      'soul_furnace',
    ]);

    // Each root text names a rule this game does not have: damage aimed at "the
    // enemy Commander" rather than at a player (CLAUDE.md's player versus
    // deployed-Commander distinction), "Destroy" rather than Defeat, and a
    // "Token stack" rather than same-definition Tokens (M06.1). The shipped text
    // is the corrected one in every case, which is why parity failing here is an
    // argument for deleting the root copy rather than for restoring it.
    const stale = /enemy Commander|Destroy the active Relic|Token stack/;
    for (const difference of parity.cards.differences) {
      expect(difference.root, `${difference.subject} root text`).toMatch(
        difference.subject === 'chief_containment_scholar'
          ? /costs 1 less/ // states no zone and no timing; the shipped text states both.
          : stale,
      );
      expect(difference.content, `${difference.subject} shipped text`).not.toMatch(stale);
    }
  });

  it('is not in exact parity, and the report says which way', () => {
    expect(parity.exact).toBe(false);
    const report = renderParityReport(parity);
    expect(report).toContain('NOT in parity');
    expect(report).toContain('Precons: 4 in the root catalogue, 4 in content/.');
  });
});
