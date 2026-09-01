import { deckDistance, makeDeck, type SimDeck } from '@tcg/simulator';
import { describe, expect, it } from 'vitest';

import {
  DIVERSITY_RULE,
  MIN_FINALIST_DISTANCE,
  buildChampionshipConfig,
  selectFinalists,
} from './championship.js';

/**
 * M08.15 — the finalist-selection rule and the championship it freezes.
 *
 * Every deck here is synthetic: `parseExperimentConfig` (which
 * `buildChampionshipConfig` runs through) checks card ID *shape*, never real
 * content, so a fixture deck with made-up card IDs is exactly as valid a test
 * subject as one drawn from a real search archive.
 */

/** A deck naming `distinctCards` distinct filler cards, the rest padded with `card_a`. */
function deckWith(commanderId: string, distinctCards: readonly string[], label: string): SimDeck {
  const cards = [
    ...distinctCards.map((cardId) => ({ cardId, quantity: 1 })),
    { cardId: 'card_a', quantity: 40 - distinctCards.length },
  ].filter((entry) => entry.quantity > 0);
  return makeDeck({ commanderId, cards, label });
}

describe('selectFinalists', () => {
  it('keeps every finalist at least the minimum distance from every other', () => {
    const decks = [
      deckWith('goblin_warboss', [], 'baseline'),
      deckWith('goblin_warboss', ['card_b'], 'one-off'),
      deckWith('goblin_warboss', ['card_b', 'card_c', 'card_d', 'card_e'], 'four-off'),
      deckWith('goblin_warboss', ['card_b', 'card_c', 'card_d', 'card_e', 'card_f'], 'five-off'),
    ];

    const result = selectFinalists('goblin_warboss', decks, 3);

    expect(result.finalists.length).toBeLessThanOrEqual(3);
    for (const left of result.finalists) {
      for (const right of result.finalists) {
        if (left.hash === right.hash) continue;
        expect(deckDistance(left, right)).toBeGreaterThanOrEqual(MIN_FINALIST_DISTANCE);
      }
    }
  });

  it('records a shortfall when the archive has fewer sufficiently distinct decks than requested', () => {
    // Only two decks in the whole archive are far enough apart to both qualify;
    // asking for four finalists must not manufacture two more.
    const decks = [
      deckWith('grave_matron', [], 'baseline'),
      deckWith('grave_matron', ['card_b'], 'one-off, too close to baseline'),
      deckWith('grave_matron', ['card_b', 'card_c', 'card_d', 'card_e'], 'four-off'),
    ];

    const result = selectFinalists('grave_matron', decks, 4);

    expect(result.requested).toBe(4);
    expect(result.finalists.length).toBeLessThan(4);
    expect(result.finalists.length).toBeGreaterThan(0);
  });

  it('is deterministic: the same archive and count always freeze the same finalists', () => {
    // Every pair among these four is exactly `MIN_FINALIST_DISTANCE` (4) apart —
    // the baseline against each variant, and each variant against the other two,
    // since their four-card differences from the baseline never overlap. That
    // makes every one of them a legal pick at every step, which is what actually
    // exercises the greedy max-min argmax and its hash tie-break across three
    // rounds, rather than a fixture where the very first round already has
    // nothing left to choose between.
    const decks = [
      deckWith('goblin_warboss', [], 'baseline'),
      deckWith('goblin_warboss', ['card_b', 'card_c', 'card_d', 'card_e'], 'a'),
      deckWith('goblin_warboss', ['card_f', 'card_g', 'card_h', 'card_i'], 'b'),
      deckWith('goblin_warboss', ['card_j', 'card_k', 'card_l', 'card_m'], 'c'),
    ];
    const shuffled = [
      decks[2] as SimDeck,
      decks[0] as SimDeck,
      decks[3] as SimDeck,
      decks[1] as SimDeck,
    ];

    const first = selectFinalists('goblin_warboss', decks, 3);
    const second = selectFinalists('goblin_warboss', shuffled, 3);

    expect(first.finalists).toHaveLength(3);
    expect(second.finalists.map((deck) => deck.hash)).toEqual(
      first.finalists.map((deck) => deck.hash),
    );
    // The selection is exactly the three lowest-hash decks: with every pairwise
    // distance tied at the threshold, the tie-break (earliest in sorted order)
    // decides every round.
    const sortedHashes = decks
      .map((deck) => deck.hash)
      .sort((left, right) => left.localeCompare(right));
    expect(first.finalists.map((deck) => deck.hash)).toEqual(sortedHashes.slice(0, 3));
  });

  it('never selects more finalists than the count requested', () => {
    const decks = [
      deckWith('goblin_warboss', ['card_b'], 'a'),
      deckWith('goblin_warboss', ['card_c'], 'b'),
      deckWith('goblin_warboss', ['card_b', 'card_c', 'card_d', 'card_e'], 'c'),
    ];
    const result = selectFinalists('goblin_warboss', decks, 1);
    expect(result.finalists).toHaveLength(1);
  });

  it('selects nothing from an empty archive, rather than failing', () => {
    const result = selectFinalists('goblin_warboss', [], 3);
    expect(result.finalists).toHaveLength(0);
    expect(result.requested).toBe(3);
  });

  it('honours a caller-supplied distance threshold', () => {
    const decks = [
      deckWith('goblin_warboss', [], 'baseline'),
      deckWith('goblin_warboss', ['card_b'], 'one-off'),
    ];
    // The default threshold (4) would refuse the second deck; a threshold of 1 accepts it.
    const strict = selectFinalists('goblin_warboss', decks, 2, MIN_FINALIST_DISTANCE);
    const loose = selectFinalists('goblin_warboss', decks, 2, 1);
    expect(strict.finalists).toHaveLength(1);
    expect(loose.finalists).toHaveLength(2);
  });
});

describe('buildChampionshipConfig', () => {
  const environment = { id: 'test_env' };

  it('freezes every selected finalist into one mirrored round-robin batch', () => {
    const goblinDecks = [
      deckWith('goblin_warboss', [], 'a'),
      deckWith('goblin_warboss', ['card_b'], 'b'),
    ];
    const graveDecks = [deckWith('grave_matron', [], 'c')];

    const config = buildChampionshipConfig({
      experimentId: 'championship-test',
      seed: 'champ-seed',
      pilots: [{ id: 'value' }],
      gamesPerPairing: 4,
      environment,
      groups: [
        { commanderId: 'goblin_warboss', decks: goblinDecks },
        { commanderId: 'grave_matron', decks: graveDecks },
      ],
    });

    expect(config.kind).toBe('batch');
    if (config.kind !== 'batch') throw new Error('unreachable');
    expect(config.decks.kind).toBe('inline');
    if (config.decks.kind !== 'inline') throw new Error('unreachable');
    expect(config.decks.decks).toHaveLength(3);
    expect(config.decks.decks.map((deck) => deck.commanderId).sort()).toEqual([
      'goblin_warboss',
      'goblin_warboss',
      'grave_matron',
    ]);
    expect(config.schedule).toBe('round_robin');
    expect(config.mirrorSeats).toBe(true);
    expect(config.gamesPerPairing).toBe(4);
  });

  it('refuses to build a championship with no finalists at all', () => {
    expect(() =>
      buildChampionshipConfig({
        experimentId: 'championship-empty',
        seed: 'champ-seed',
        pilots: [{ id: 'value' }],
        gamesPerPairing: 4,
        environment,
        groups: [],
      }),
    ).toThrow();
  });
});

describe('the diversity rule name', () => {
  it('is the one value the closed schema on JobOrigin accepts', () => {
    expect(DIVERSITY_RULE).toBe('greedy_min_pairwise_deck_distance');
  });
});
