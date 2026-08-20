import { describe, expect, it } from 'vitest';
import type { CardFilter } from '@tcg/card-data';
import { matchesCardFilter, satisfiesCardTypes } from './derive.js';
import { legalActions } from './legal-actions.js';
import {
  apply,
  deployUnit,
  giveCard,
  giveDiscard,
  instanceIn,
  keepBothHands,
  setEnergy,
  startMatch,
  testContext,
  testDatabase,
} from './test-fixtures.js';
import type { CardInstance, MatchState } from './schema/state.js';

/**
 * A Token on the battlefield **is a Unit** (owner ruling, 2026-08-20).
 *
 * The ruling in the owner's own words: *"Tokens count as Units while they are on
 * the battlefield. Any rule, target, or additional cost that says 'Unit'
 * includes Unit Tokens unless it explicitly says 'nontoken Unit' or 'Unit card.'
 * A token-only filter remains token-only."*
 *
 * It is a correction to one sentence in `matchesCardFilter` rather than to any
 * card, so this file tests the sentence and then tests the two shipped cards
 * that were wrong because of it. Nothing here knows a card ID that the ruling
 * itself does not imply: `forbidden_offering` and `divide_the_offering` appear
 * because they are the pair the calibration suite could not run, and the engine
 * treats them like every other `cardTypes: ['unit']` filter in the catalog.
 *
 * The four boundary cases matter as much as the widening. A `['token']` filter
 * is an authored restriction and stays token-only; a Token is never a *Unit
 * card*, so the discard-pile and deck filters that say "Unit card" are untouched;
 * and a filter asked about a definition with no instance is not being asked
 * about anything in play, so it does not widen either.
 */

const context = testContext();
const database = testDatabase();

/** A match at player_1's Main Phase with the shipped pool and Energy to spend. */
function shipped(energy = 10): MatchState {
  return setEnergy(keepBothHands(startMatch(), context), 'player_1', energy);
}

const UNIT: CardFilter = { cardTypes: ['unit'] };
const TOKEN_ONLY: CardFilter = { cardTypes: ['token'] };
const UNIT_OR_TOKEN: CardFilter = { cardTypes: ['unit', 'token'] };

function matches(state: MatchState, instanceId: string, filter: CardFilter): boolean {
  const instance: CardInstance = instanceIn(state, instanceId);
  return matchesCardFilter(database.getOrThrow(instance.definitionId), instance, filter);
}

describe('a Token on the battlefield satisfies a Unit filter', () => {
  it('matches a printed Unit against a Unit filter, as it always did', () => {
    const vermin = deployUnit(shipped(), 'player_1', 'ashen_vermin');
    expect(matches(vermin.state, vermin.instanceId, UNIT)).toBe(true);
  });

  it('matches a battlefield Token against a Unit filter', () => {
    const thrall = deployUnit(shipped(), 'player_1', 'thrall_token');
    expect(matches(thrall.state, thrall.instanceId, UNIT)).toBe(true);
  });

  it('keeps a token-only filter token-only', () => {
    const thrall = deployUnit(shipped(), 'player_1', 'thrall_token');
    expect(matches(thrall.state, thrall.instanceId, TOKEN_ONLY)).toBe(true);
  });

  it('does not let a printed Unit satisfy a token-only filter', () => {
    const vermin = deployUnit(shipped(), 'player_1', 'ashen_vermin');
    // The widening is one-way on purpose. "Every Token with the same Token
    // definition" and "Goblin Tokens you create" are restrictions an author
    // wrote, not shorthand for "Unit".
    expect(matches(vermin.state, vermin.instanceId, TOKEN_ONLY)).toBe(false);
  });

  it('leaves the fourteen shipped `unit, token` filters matching both', () => {
    const vermin = deployUnit(shipped(), 'player_1', 'ashen_vermin');
    const thrall = deployUnit(vermin.state, 'player_1', 'thrall_token');
    expect(matches(thrall.state, vermin.instanceId, UNIT_OR_TOKEN)).toBe(true);
    expect(matches(thrall.state, thrall.instanceId, UNIT_OR_TOKEN)).toBe(true);
  });

  it('does not make a Token a Unit *card*', () => {
    // Two ways the distinction is asked, and both still say no.
    //
    // By zone: "Return a Unit card from your discard pile" is `zone: 'discard'`
    // with `cardTypes: ['unit']`. A Token cannot survive the trip in the shipped
    // engine, but the filter must not be what permits it if one ever did.
    const dead = giveDiscard(shipped(), 'player_1', 'thrall_token');
    expect(matches(dead.state, dead.instanceId, UNIT)).toBe(false);
    expect(matches(dead.state, dead.instanceId, TOKEN_ONLY)).toBe(true);

    // By having no instance at all: a cost modifier read off a card in hand, or
    // a turn-event entry for a card that has already gone, is not a question
    // about something in play.
    const definition = database.getOrThrow('thrall_token');
    expect(matchesCardFilter(definition, null, UNIT)).toBe(false);
    expect(satisfiesCardTypes(definition, null, ['unit'])).toBe(false);
  });

  it('adds nothing beyond Unit', () => {
    const thrall = deployUnit(shipped(), 'player_1', 'thrall_token');
    expect(matches(thrall.state, thrall.instanceId, { cardTypes: ['commander'] })).toBe(false);
    expect(matches(thrall.state, thrall.instanceId, { cardTypes: ['spell'] })).toBe(false);
    // Every other predicate is still applied on top: the widening decides the
    // type test and nothing else.
    expect(
      matches(thrall.state, thrall.instanceId, { cardTypes: ['unit'], attack: { min: 3 } }),
    ).toBe(false);
  });
});

describe('the shipped cards the ruling corrects', () => {
  it('lets Forbidden Offering take a Thrall Token as its additional cost', () => {
    const thrall = deployUnit(shipped(), 'player_1', 'thrall_token');
    const spell = giveCard(thrall.state, 'player_1', 'forbidden_offering');

    const legal = legalActions(spell.state, 'player_1', context);
    expect(legal.playableCards.map((card) => card.instanceId)).toContain(spell.instanceId);

    const handBefore = spell.state.players.player_1?.hand.length ?? 0;
    const played = apply(
      spell.state,
      { type: 'play_card', playerId: 'player_1', instanceId: spell.instanceId },
      context,
    );

    // One legal payer, so the cost settles without a pause — and the Token is
    // gone rather than in a discard pile, because a Token that leaves the
    // battlefield ceases to exist.
    expect(played.instances[thrall.instanceId]).toBeUndefined();
    expect(played.players.player_1?.units).not.toContain(thrall.instanceId);
    // Minus the spell itself, plus the two it draws.
    expect(played.players.player_1?.hand.length).toBe(handBefore + 1);
  });

  it('still refuses Forbidden Offering with nothing at all to offer', () => {
    const spell = giveCard(shipped(), 'player_1', 'forbidden_offering');
    const legal = legalActions(spell.state, 'player_1', context);
    expect(legal.playableCards.map((card) => card.instanceId)).not.toContain(spell.instanceId);
  });

  it('makes the fodder-then-spend line legal on three Energy', () => {
    // The `grave_sacrifice/make_fodder_before_spending_it` line, played by hand:
    // one body, two cards, exactly enough Energy for both, and only in one
    // order. Before the ruling the second card was unplayable however it was
    // sequenced, so the fixture asked for something no player could do either.
    let state = shipped(3);
    const body = deployUnit(state, 'player_1', 'ashen_vermin');
    const convert = giveCard(body.state, 'player_1', 'divide_the_offering');
    const draw = giveCard(convert.state, 'player_1', 'forbidden_offering');
    state = draw.state;

    state = apply(
      state,
      { type: 'play_card', playerId: 'player_1', instanceId: convert.instanceId },
      context,
    );
    // The converter's sacrifice is a targeted instruction with one legal victim.
    const choice = state.pendingChoice;
    if (choice) {
      state = apply(
        state,
        {
          type: 'submit_choice',
          playerId: 'player_1',
          choiceId: choice.id,
          selectedIds: [body.instanceId],
        },
        context,
      );
    }

    const thralls = state.players.player_1?.units ?? [];
    expect(thralls).toHaveLength(2);
    expect(state.players.player_1?.energy).toBe(1);

    // The draw spell is now payable by a Thrall, which is the whole correction.
    const legal = legalActions(state, 'player_1', context);
    expect(legal.playableCards.map((card) => card.instanceId)).toContain(draw.instanceId);

    state = apply(
      state,
      { type: 'play_card', playerId: 'player_1', instanceId: draw.instanceId },
      context,
    );
    if (state.pendingChoice) {
      const pending = state.pendingChoice;
      state = apply(
        state,
        {
          type: 'submit_choice',
          playerId: 'player_1',
          choiceId: pending.id,
          selectedIds: [pending.validEntityIds[0] ?? ''],
        },
        context,
      );
    }

    expect(instanceIn(state, convert.instanceId).zone).toBe('discard');
    expect(instanceIn(state, draw.instanceId).zone).toBe('discard');
    expect(state.players.player_1?.units).toHaveLength(1);
  });
});
