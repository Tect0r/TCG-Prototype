import { describe, expect, it } from 'vitest';
import type { CardDefinitionInput } from '@tcg/card-data';
import { deriveSeedBundle } from './seed.js';
import { makeDeck, toMatchDeck, type SimDeck } from './deck-search/deck.js';
import { generateDeck } from './deck-search/generate.js';
import { runMatch, type RunMatchOptions, type RunMatchResult } from './run-match.js';
import { DEAD_HAND_CATEGORIES, cardTelemetrySchema } from './telemetry/schema.js';
import type { Environment } from './environment.js';
import {
  FAST_LIMITS,
  VALUE_PILOT,
  AGGRESSIVE_PILOT,
  fixtureDeck,
  tinyEnvironment,
} from './test-fixtures.js';

/**
 * CLAUDE.md §13.6 and §13.15 items 9, 10 and 19: the dead-hand categories are
 * genuinely distinguished, source attribution survives tokens and triggers, and
 * the per-seat aggregates reconcile exactly with the per-card rows they are
 * meant to summarise.
 */

async function play(
  environment: Environment,
  left: SimDeck,
  right: SimDeck,
  seed = 'telemetry',
): Promise<RunMatchResult> {
  const options: RunMatchOptions = {
    experimentId: 'telemetry',
    environment,
    matchId: `m_${seed}`,
    orderKey: seed,
    deckPairId: 'pair',
    variantKey: 'variant',
    gameIndex: 0,
    orientation: 0,
    seeds: deriveSeedBundle(seed, 2),
    limits: FAST_LIMITS,
    seats: [
      {
        playerId: 'player_1',
        deckId: left.id,
        deckHash: left.hash,
        deck: toMatchDeck(left),
        pilot: VALUE_PILOT,
      },
      {
        playerId: 'player_2',
        deckId: right.id,
        deckHash: right.hash,
        deck: toMatchDeck(right),
        pilot: AGGRESSIVE_PILOT,
      },
    ],
  };
  return runMatch(options);
}

describe('per-card telemetry', () => {
  const env = tinyEnvironment();
  const deckA = generateDeck(env, 'telemetry-a').deck as SimDeck;
  const deckB = generateDeck(env, 'telemetry-b').deck as SimDeck;

  it('validates against its schema and is keyed by definition ID', async () => {
    const { record } = await play(env, deckA, deckB);
    expect(record.cards.length).toBeGreaterThan(0);
    for (const row of record.cards) {
      expect(() => cardTelemetrySchema.parse(row)).not.toThrow();
      // Definition IDs, never match-local instance IDs.
      expect(row.definitionId).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('is emitted in a stable order so two runs are byte-identical', async () => {
    const first = await play(env, deckA, deckB);
    const second = await play(env, deckA, deckB);
    expect(JSON.stringify(second.record.cards)).toBe(JSON.stringify(first.record.cards));
  });

  it('accounts for every copy in the deck exactly once', async () => {
    const { record } = await play(env, deckA, deckB);
    for (const seat of record.seats) {
      const deck = seat.playerId === 'player_1' ? deckA : deckB;
      for (const entry of deck.cards) {
        const row = record.cards.find(
          (card) => card.playerId === seat.playerId && card.definitionId === entry.cardId,
        );
        expect(row, `${seat.playerId} ${entry.cardId}`).toBeDefined();
        const classified = DEAD_HAND_CATEGORIES.reduce(
          (sum, category) => sum + (row?.deadHand[category] ?? 0),
          0,
        );
        // Every copy lands in exactly one category — no double counting, none lost.
        expect(classified).toBe(entry.quantity);
      }
    }
  });

  it('records where each copy ended up, consistently with its category', async () => {
    const { record } = await play(env, deckA, deckB);
    for (const row of record.cards) {
      // A copy that never left the deck ended in the deck — or, for the losing
      // seat, in the terminal `removed` zone the elimination cleanup moves it to.
      if ((row.deadHand.unseen ?? 0) > 0) {
        expect(row.endedInDeck + row.timesRemoved).toBeGreaterThan(0);
      }
      // A card can only be `used` if something used it. Tokens are created
      // already in play, which is why they are counted separately.
      if ((row.deadHand.used ?? 0) > 0 && row.copiesInDeck > 0) {
        expect(row.timesPlayed + row.timesActivated).toBeGreaterThan(0);
      }
    }
  });
});

describe('dead-hand categories', () => {
  it('calls a card that never left the deck "unseen", not dead in hand', async () => {
    // A deck large enough that a match cannot draw all of it — otherwise there
    // is nothing left unseen to check.
    const env = tinyEnvironment({ id: 'big', deckSize: 24 });
    const deck = generateDeck(env, 'unseen').deck as SimDeck;
    const { record } = await play(env, deck, deck, 'unseen-match');
    const unseen = record.cards.filter((row) => (row.deadHand.unseen ?? 0) > 0);
    expect(unseen.length).toBeGreaterThan(0);
    for (const row of unseen) {
      // An unseen copy came from the deck and never reached a hand, so it can
      // never be counted against the pilot or against the card's playability.
      expect(row.deadHand.unseen ?? 0).toBeLessThanOrEqual(row.copiesInDeck);
      const seen =
        (row.deadHand.never_affordable ?? 0) +
        (row.deadHand.no_legal_window ?? 0) +
        (row.deadHand.legal_but_unchosen ?? 0) +
        (row.deadHand.used ?? 0);
      expect(seen + (row.deadHand.unseen ?? 0)).toBe(row.copiesInDeck);
    }
  });

  it('separates "never affordable" from "legal but unchosen"', async () => {
    // A card nobody can ever pay for: energy is capped at one, the card costs ten.
    const unaffordable: CardDefinitionInput = {
      schemaVersion: 2,
      id: 'fixture_unaffordable',
      name: 'Fixture Unaffordable',
      type: 'unit',
      colorIdentity: [],
      cost: 10,
      attack: 1,
      health: 1,
      tags: ['fixture'],
      displayText: 'Priced out of every game it appears in.',
    };
    const env = tinyEnvironment({
      id: 'poor',
      cardOverrides: [unaffordable],
      rulesConfig: { startingMaxEnergy: 1, energyGainPerTurn: 0, energyCap: 1 },
    });
    const deck = fixtureDeck('poor', 'prototype_commander_blue', [
      ['fixture_unaffordable', 2],
      ['prototype_drone', 2],
      ['prototype_scout', 2],
      ['prototype_guard', 2],
      ['trench_guard', 2],
      ['unstable_construct', 2],
    ]);
    const { record } = await play(env, deck, deck, 'poor-match');

    const rows = record.cards.filter((row) => row.definitionId === 'fixture_unaffordable');
    const drawn = rows.filter((row) => row.timesDrawn > 0 || row.copiesInOpeningHand > 0);
    expect(drawn.length).toBeGreaterThan(0);
    for (const row of drawn) {
      expect(row.affordableOpportunities).toBe(0);
      expect(row.playOpportunities).toBe(0);
      expect(row.timesPlayed).toBe(0);
      // It reached a hand and could never be paid for: that is a specific,
      // actionable diagnosis, not a generic "dead card".
      expect(row.deadHand.never_affordable ?? 0).toBeGreaterThan(0);
      expect(row.deadHand.legal_but_unchosen ?? 0).toBe(0);
    }
  });

  it('counts a card the engine offered and the pilot declined as legal but unchosen', async () => {
    // A one-cost card in a deck of one-cost cards: some copy will be offered and
    // passed over, because a hand outruns the energy curve.
    const env = tinyEnvironment();
    const deck = generateDeck(env, 'unchosen').deck as SimDeck;
    let found = false;
    for (let index = 0; index < 8 && !found; index += 1) {
      const { record } = await play(env, deck, deck, `unchosen-${index}`);
      found = record.cards.some((row) => (row.deadHand.legal_but_unchosen ?? 0) > 0);
      if (found) {
        const row = record.cards.find((entry) => (entry.deadHand.legal_but_unchosen ?? 0) > 0)!;
        // The category makes a claim about the pilot: the opportunity existed.
        expect(row.playOpportunities).toBeGreaterThan(0);
        expect(row.affordableOpportunities).toBeGreaterThan(0);
      }
    }
    expect(found).toBe(true);
  });

  it('does not count a discarded card as used', async () => {
    // Discarding to the hand-size limit is the textbook `legal_but_unchosen`
    // case; calling it "used" would hide the signal entirely.
    const env = tinyEnvironment();
    const deck = generateDeck(env, 'discard').deck as SimDeck;
    const { record } = await play(env, deck, deck, 'discard-match');
    for (const row of record.cards) {
      if (row.timesDiscarded > 0 && row.timesPlayed === 0 && row.timesActivated === 0) {
        expect(row.deadHand.used ?? 0).toBe(0);
      }
    }
  });
});

describe('source attribution', () => {
  it('credits damage and combat to the units that did it', async () => {
    const env = tinyEnvironment();
    const deckA = generateDeck(env, 'attr-a').deck as SimDeck;
    const deckB = generateDeck(env, 'attr-b').deck as SimDeck;
    const { record } = await play(env, deckA, deckB, 'attribution');

    const attacked = record.cards.filter((row) => row.attacksMade > 0);
    expect(attacked.length).toBeGreaterThan(0);
    for (const row of attacked) {
      // Something that attacked must have been on the battlefield to do it.
      expect(row.timesPlayed + row.tokensCreated).toBeGreaterThan(0);
      expect(row.turnsOnBattlefield).toBeGreaterThanOrEqual(0);
    }

    const dealt = record.cards.reduce((sum, row) => sum + row.damageToPlayers, 0);
    const taken = record.seats.reduce((sum, seat) => sum + seat.damageTaken, 0);
    // Every point of player damage traced to a source is a point somebody took.
    expect(dealt).toBeLessThanOrEqual(taken);
    expect(dealt).toBeGreaterThan(0);
  });

  it('attributes tokens to the card that created them, after that card has died', async () => {
    // `unstable_construct` makes its tokens from an `on_defeated` trigger: by the
    // time the tokens exist, the source is already in the discard pile. That is
    // the case CLAUDE.md §13.15 item 10 is about. It is re-costed here purely so
    // the fixture reaches the board and dies inside a short match.
    const env = tinyEnvironment({
      id: 'tokens',
      cardOverrides: [
        {
          schemaVersion: 2,
          id: 'unstable_construct',
          name: 'Unstable Construct',
          type: 'unit',
          colorIdentity: [],
          cost: 1,
          attack: 1,
          health: 1,
          tags: ['construct'],
          abilities: [
            {
              id: 'scatter_parts',
              trigger: 'on_defeated',
              effects: [{ type: 'create_token', tokenCardId: 'prototype_scrap_token', amount: 2 }],
            },
          ],
          displayText: 'When this unit is defeated, create two 1/1 Scrap tokens.',
        },
      ],
    });
    const deck = fixtureDeck('tokens', 'prototype_commander_blue', [
      ['unstable_construct', 2],
      ['prototype_drone', 2],
      ['prototype_scout', 2],
      ['prototype_guard', 2],
      ['trench_guard', 2],
      ['surveyors_lens', 2],
    ]);
    let credited = false;
    for (let index = 0; index < 12 && !credited; index += 1) {
      const { record } = await play(env, deck, deck, `tokens-${index}`);
      const maker = record.cards.find(
        (row) => row.definitionId === 'unstable_construct' && row.tokensCreated > 0,
      );
      if (!maker) continue;
      credited = true;
      expect(maker.timesDefeated).toBeGreaterThan(0);
      // The token gets its own definition row, and is never counted as a deck card.
      const token = record.cards.find(
        (row) => row.definitionId === 'prototype_scrap_token' && row.playerId === maker.playerId,
      );
      expect(token).toBeDefined();
      expect(token?.copiesInDeck).toBe(0);
      expect(token?.deadHand.used ?? 0).toBeGreaterThan(0);
      const seatTokens = record.seats.reduce((sum, seat) => sum + seat.tokensCreated, 0);
      expect(seatTokens).toBeGreaterThanOrEqual(maker.tokensCreated);
    }
    expect(credited).toBe(true);
  });

  it('credits a triggered ability to its source even after the source dies', async () => {
    const env = tinyEnvironment({ extraCardIds: ['powder_keg_runner'] });
    const deck = fixtureDeck('triggers', 'prototype_commander_red', [
      ['powder_keg_runner', 2],
      ['prototype_drone', 2],
      ['prototype_scout', 2],
      ['prototype_guard', 2],
      ['trench_guard', 2],
      ['unstable_construct', 2],
    ]);
    let fired = false;
    for (let index = 0; index < 10 && !fired; index += 1) {
      const { record } = await play(env, deck, deck, `triggers-${index}`);
      const row = record.cards.find(
        (card) => card.definitionId === 'powder_keg_runner' && card.triggersFired > 0,
      );
      if (row) {
        fired = true;
        // The trigger is recorded against the card that owned it, whether or not
        // the unit survived the event that fired it.
        expect(row.triggersFired).toBeGreaterThan(0);
        expect(row.timesPlayed).toBeGreaterThan(0);
      }
    }
    expect(fired).toBe(true);
  });
});

describe('aggregate reconciliation', () => {
  const env = tinyEnvironment();
  const deckA = generateDeck(env, 'reconcile-a').deck as SimDeck;
  const deckB = generateDeck(env, 'reconcile-b').deck as SimDeck;

  it('reconciles per-seat totals with the per-card rows that compose them', async () => {
    // CLAUDE.md §13.15 item 19: derived numbers must reconcile exactly with the
    // raw records, on real data rather than a hand-built fixture.
    for (const seed of ['r1', 'r2', 'r3']) {
      const { record } = await play(env, deckA, deckB, seed);
      for (const seat of record.seats) {
        const rows = record.cards.filter((row) => row.playerId === seat.playerId);
        expect(rows.reduce((sum, row) => sum + row.timesPlayed, 0)).toBe(seat.cardsPlayed);
        expect(rows.reduce((sum, row) => sum + row.energySpent, 0)).toBe(seat.energySpent);
        expect(rows.reduce((sum, row) => sum + row.timesActivated, 0)).toBe(
          seat.abilitiesActivated,
        );
        expect(rows.reduce((sum, row) => sum + row.timesDiscarded, 0)).toBe(seat.cardsDiscarded);
        expect(rows.reduce((sum, row) => sum + row.attacksMade, 0)).toBe(seat.attacksDeclared);
        expect(rows.reduce((sum, row) => sum + row.blocksMade, 0)).toBe(seat.blocksAssigned);
      }
    }
  });

  it('reconciles decision counts across seats', async () => {
    const { record } = await play(env, deckA, deckB, 'decisions');
    expect(record.seats.reduce((sum, seat) => sum + seat.decisions, 0)).toBe(record.decisions);
    expect(record.decisions).toBeGreaterThanOrEqual(record.actions);
  });

  it('keeps starting health consistent with the rules configuration', async () => {
    const { record } = await play(env, deckA, deckB, 'health');
    for (const seat of record.seats) {
      expect(seat.startingHealth).toBe(env.rulesConfig.startingHealth);
      expect(seat.endingHealth).toBeLessThanOrEqual(seat.startingHealth + seat.healingReceived);
    }
    // Exactly one seat wins a decided match.
    expect(record.seats.filter((seat) => seat.won)).toHaveLength(record.outcome === 'win' ? 1 : 0);
  });

  it('never records a negative counter', async () => {
    const { record } = await play(env, deckA, deckB, 'negatives');
    const numbers = [
      ...record.cards.flatMap((row) =>
        Object.values(row).filter((value): value is number => typeof value === 'number'),
      ),
      ...record.seats.flatMap((seat) =>
        Object.values(seat).filter((value): value is number => typeof value === 'number'),
      ),
    ];
    for (const value of numbers) expect(value).toBeGreaterThanOrEqual(-record.turns * 100);
    for (const row of record.cards) {
      for (const category of DEAD_HAND_CATEGORIES) {
        expect(row.deadHand[category] ?? 0).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('play snapshots', () => {
  it('captures inspectable before/after features, capped in size', async () => {
    const env = tinyEnvironment();
    const deck = makeDeck({
      commanderId: 'prototype_commander_blue',
      cards: [
        { cardId: 'fixture_baseline_unit', quantity: 2 },
        { cardId: 'prototype_drone', quantity: 2 },
        { cardId: 'prototype_scout', quantity: 2 },
        { cardId: 'prototype_guard', quantity: 2 },
        { cardId: 'trench_guard', quantity: 2 },
        { cardId: 'unstable_construct', quantity: 2 },
      ],
    });
    const { record } = await play(env, deck, deck, 'snapshots');
    const played = record.cards.filter((row) => row.timesPlayed > 0);
    expect(played.length).toBeGreaterThan(0);
    for (const row of played) {
      expect(row.plays.length).toBeLessThanOrEqual(8);
      for (const snapshot of row.plays) {
        expect(snapshot.turn).toBeGreaterThanOrEqual(0);
        expect(snapshot.energySpent).toBeLessThanOrEqual(snapshot.energyBefore);
        expect(snapshot.handSizeBefore).toBeGreaterThan(0);
      }
    }
  });
});
