import { describe, expect, it } from 'vitest';
import { loadBundledCardData } from '@tcg/card-data';
import { applyAction, createMatch, playerView, type MatchState } from '@tcg/rules-engine';
import { unwrap } from '@tcg/shared';
import { contextMessages, publicCardContext } from './context.js';

/**
 * The inspector's contextual messages, checked against a real engine state.
 *
 * The point of these tests is not the wording. It is that a client asking "why
 * can't I play this?" can only ever be answered from the redacted view, and
 * that it never manufactures an answer the view does not contain.
 */

const { database } = loadBundledCardData();

function matchState(): MatchState {
  return unwrap(
    createMatch({
      matchId: 'help_context',
      seed: 'help-context-seed',
      database,
      seats: [
        {
          playerId: 'player_1',
          name: 'You',
          deck: {
            commanderId: 'prototype_commander_red',
            cards: [{ cardId: 'goblin_scout', quantity: 30 }],
          },
        },
        {
          playerId: 'player_2',
          name: 'Rival',
          deck: {
            commanderId: 'prototype_commander_green',
            cards: [{ cardId: 'thornback_calf', quantity: 30 }],
          },
        },
      ],
    }),
    'match setup',
  ).state;
}

/** Both players keep their opening hand, so the match reaches turn one. */
function startedMatch(): MatchState {
  let state = matchState();
  for (const playerId of ['player_1', 'player_2']) {
    state = unwrap(
      applyAction(state, { type: 'mulligan', playerId, returnInstanceIds: [] }, { database }),
      'mulligan',
    ).state;
  }
  return state;
}

describe('public card context', () => {
  it('describes a card in the viewer’s own hand', () => {
    const view = playerView(startedMatch(), 'player_1', database);
    const instanceId = view.hand[0];
    expect(instanceId).toBeDefined();

    const context = publicCardContext(view, instanceId as string);
    expect(context?.zone).toBe('hand');
    expect(context?.ownedByViewer).toBe(true);
  });

  it('cannot reach a card in another player’s hand', () => {
    const state = startedMatch();
    const view = playerView(state, 'player_1', database);
    const opponentHand = state.players.player_2?.hand ?? [];
    expect(opponentHand.length).toBeGreaterThan(0);

    for (const instanceId of opponentHand) {
      expect(view.instances[instanceId]).toBeUndefined();
      expect(publicCardContext(view, instanceId)).toBeNull();
    }
  });

  it('cannot reach a card still in a deck', () => {
    const state = startedMatch();
    const view = playerView(state, 'player_1', database);
    for (const instanceId of (state.players.player_1?.deck ?? []).slice(0, 5)) {
      expect(publicCardContext(view, instanceId)).toBeNull();
    }
  });

  it('can reach a Commander, which is public', () => {
    const view = playerView(startedMatch(), 'player_1', database);
    const rival = view.players.find((player) => player.playerId === 'player_2');
    const context = publicCardContext(view, rival?.commanderInstanceId ?? '');
    expect(context?.zone).toBe('commander_zone');
    expect(context?.ownedByViewer).toBe(false);
    const messages = contextMessages(context!).join(' ');
    expect(messages).toMatch(/Command Zone/);
    // It is a deployable permanent that comes back here, not a fixture that
    // "stays in the Commander zone for the whole match" (ADR 0016 §4).
    expect(messages).toMatch(/deployed to the battlefield for its cost/);
    expect(messages).toMatch(/returns here rather than to a discard pile/);
    // A rival's Commander is never offered to this seat as playable.
    expect(messages).not.toMatch(/You can deploy it right now/);
  });

  it('quotes the engine’s own energy cost when the engine says a card is playable', () => {
    const state = startedMatch();
    const view = playerView(state, state.activePlayerId, database);
    const playable = view.legalActions.playableCards[0];
    if (!playable) return; // The active seat may open with nothing affordable.

    const context = publicCardContext(view, playable.instanceId);
    expect(context?.playableForEnergy).toBe(playable.energyCost);
    expect(contextMessages(context!).join(' ')).toContain(`${playable.energyCost} energy`);
  });

  it('says a card is not playable outside your Main Phase, without guessing why', () => {
    const state = startedMatch();
    // The non-active seat can never play a card, whatever it costs.
    const idle = state.activePlayerId === 'player_1' ? 'player_2' : 'player_1';
    const view = playerView(state, idle, database);
    const instanceId = view.hand[0] as string;

    const context = publicCardContext(view, instanceId);
    expect(context?.playableForEnergy).toBeNull();
    expect(context?.holdsReactionPriority).toBe(false);
    const messages = contextMessages(context!);
    expect(messages.join(' ')).toMatch(/only be played during your own Main Phase/);
    // …and it names the one exception rather than leaving the sentence absolute.
    expect(messages.join(' ')).toMatch(/A Reaction is the exception/);
  });

  /**
   * The Reaction branches, varied off a real context rather than an invented one.
   *
   * `prototype_core` holds no Reaction card and the engine's own fixtures are not
   * exported, so a genuine window is out of reach from here — the engine's
   * `reactions.test.ts` owns that. What is checked here is the part that lives in
   * this module: an open window pre-empts the ordinary play path, so the "only
   * during your own Main Phase" answer must not be given while the engine is
   * actively waiting on this seat.
   */
  describe('while a Reaction window is open', () => {
    /** A real out-of-turn hand-card context, which is the one this can reach. */
    function idleHandContext() {
      const state = startedMatch();
      const idle = state.activePlayerId === 'player_1' ? 'player_2' : 'player_1';
      const view = playerView(state, idle, database);
      const context = publicCardContext(view, view.hand[0] as string);
      if (!context) throw new Error('expected a hand card');
      return context;
    }

    it('offers the card at the price the engine quoted for the window', () => {
      const messages = contextMessages({
        ...idleHandContext(),
        holdsReactionPriority: true,
        reactionForEnergy: 2,
      });
      expect(messages.join(' ')).toMatch(/A Reaction window is open and you can play this into it/);
      expect(messages.join(' ')).toContain('2 energy');
      expect(messages.join(' ')).not.toMatch(/only be played during your own Main Phase/);
    });

    it('does not fall back to the Main Phase answer for a card it cannot admit', () => {
      const messages = contextMessages({
        ...idleHandContext(),
        holdsReactionPriority: true,
        reactionForEnergy: null,
      });
      expect(messages.join(' ')).toMatch(/but this card cannot be played into it/);
      expect(messages.join(' ')).not.toMatch(/only be played during your own Main Phase/);
    });
  });

  it('admits it does not know, rather than inventing a rule', () => {
    const state = startedMatch();
    const active = state.activePlayerId;
    const view = playerView(state, active, database);
    // Anything in hand the engine has not offered, during a phase where play is
    // otherwise allowed: the honest answer is "the server did not offer it".
    const unplayable = view.hand.find(
      (instanceId) =>
        !view.legalActions.playableCards.some((card) => card.instanceId === instanceId),
    );
    if (unplayable === undefined) return;

    const context = publicCardContext(view, unplayable);
    const messages = contextMessages(context!);
    expect(messages.join(' ')).toMatch(/not offering this card as playable|Main Phase/);
  });

  it('reads a deployed unit’s state straight from the view', () => {
    let state = startedMatch();
    const active = state.activePlayerId;
    const opening = playerView(state, active, database);
    const playable = opening.legalActions.playableCards[0];
    expect(playable, 'the opening seat should be able to afford a one-cost unit').toBeDefined();

    state = unwrap(
      applyAction(
        state,
        { type: 'play_card', playerId: active, instanceId: playable!.instanceId },
        { database },
      ),
      'play card',
    ).state;

    const view = playerView(state, active, database);
    const context = publicCardContext(view, playable!.instanceId);
    expect(context?.zone).toBe('battlefield');
    expect(context?.newlyDeployed).toBe(true);

    const messages = contextMessages(context!);
    expect(messages.join(' ')).toMatch(/arrived this turn/);
    // The state is named, and the player is told what it does not stop.
    expect(messages.join(' ')).toMatch(/Newly Deployed/);
    expect(messages.join(' ')).toMatch(/can still block/);
  });
});
