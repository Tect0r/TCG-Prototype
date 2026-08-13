import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createMatch,
  DEFAULT_RULES_CONFIG,
  legalActions,
  playerView,
  type ChoiceProvenance,
  type MatchState,
  type PlayerId,
} from '@tcg/rules-engine';
import { unwrap } from '@tcg/shared';
import { scoreCandidate } from './heuristic.js';
import { DEFAULT_WEIGHTS } from './scoring.js';
import { botTestDatabase, GREEN_DECK, RED_DECK } from './test-driver.js';
import type { BotObservation } from './types.js';

/**
 * A pilot answers a choice from the resolving instruction, not the source card
 * (M05.3).
 *
 * The failure this file exists to prevent has a specific shape and is invisible
 * everywhere else. A pilot used to decide "is being picked good or bad" by
 * scanning the whole definition of whatever asked, so a card that removed one
 * unit and buffed another was *hostile for both of its questions* — and the
 * pilot dutifully buffed its worst unit. Nothing in a match result shows that:
 * the action is legal, the match finishes, the deck's win rate simply means
 * slightly less than it claims to.
 *
 * So the board here is held completely fixed and only the choice's provenance
 * moves. Every assertion below is of the form "the same seat, the same options,
 * the same source — and the preference flips because the instruction differs".
 */

const database = botTestDatabase();
const config = DEFAULT_RULES_CONFIG;

/** A big body and a small one, so "best" and "worst" are unambiguous. */
const BIG = 'bramble_titan';
const SMALL = 'goblin_scout';

function startedTable(): MatchState {
  let state = unwrap(
    createMatch({
      matchId: 'choice_intent',
      seed: 'choice-intent',
      database,
      config,
      preserveSeatOrder: true,
      seats: [
        { playerId: 'player_1', name: 'One', deck: RED_DECK },
        { playerId: 'player_2', name: 'Two', deck: GREEN_DECK },
      ],
    }),
    'choice-intent setup failed',
  ).state;

  for (const playerId of state.seatOrder) {
    state = unwrap(
      applyAction(
        state,
        { type: 'mulligan', playerId, returnInstanceIds: [] },
        { database, config },
      ),
      'mulligan failed',
    ).state;
  }
  return state;
}

/**
 * Puts named units straight onto a seat's battlefield.
 *
 * Written into state rather than played, for the reason the relic fixture beside
 * it is: what is under test is the scoring of one choice against one board, and
 * reaching that board through legal play would take a dozen turns and introduce
 * every other decision the pilot makes along the way.
 */
function withUnits(
  state: MatchState,
  playerId: PlayerId,
  definitionIds: readonly string[],
): {
  state: MatchState;
  instanceIds: string[];
} {
  const next = structuredClone(state);
  const player = next.players[playerId];
  if (!player) throw new Error('no seat');
  const template = Object.values(next.instances)[0] as (typeof next.instances)[string];

  const instanceIds: string[] = [];
  definitionIds.forEach((definitionId, index) => {
    const instanceId = `inst_${playerId}_${String(index)}`;
    next.instances[instanceId] = {
      ...template,
      instanceId,
      definitionId,
      ordinal: 9000 + index,
      owner: playerId,
      controller: playerId,
      zone: 'battlefield',
      exhausted: false,
      newlyDeployed: false,
      markedDamage: 0,
      statModifiers: [],
      grantedKeywords: [],
      removedKeywords: [],
      damageShields: [],
      counters: {},
      isToken: false,
    };
    player.units.push(instanceId);
    instanceIds.push(instanceId);
  });
  return { state: next, instanceIds };
}

const PROVENANCE: ChoiceProvenance = {
  origin: 'instruction',
  itemId: 'res_0001',
  effectIndex: 0,
  effectType: 'destroy',
  sourceControllerId: 'player_1',
  chooser: 'source_controller',
  targetRelation: 'self',
  intent: 'detriment',
};

/** The same pending `select_units`, differing only in the provenance stamped on it. */
function awaitingSelection(
  state: MatchState,
  playerId: PlayerId,
  validEntityIds: readonly string[],
  provenance: Partial<ChoiceProvenance>,
): MatchState {
  const next = structuredClone(state);
  next.status = 'waiting_for_choice';
  next.pendingChoice = {
    id: 'choice_intent',
    playerId,
    type: 'select_units',
    reason: 'effect_target',
    zone: 'battlefield',
    minimum: 1,
    maximum: 1,
    validEntityIds: [...validEntityIds],
    ordered: false,
    // One and the same source card throughout: only the instruction moves.
    sourceInstanceId: null,
    provenance: { ...PROVENANCE, ...provenance },
    continuation: {
      kind: 'resolution',
      itemId: 'res_0001',
      effectIndex: 0,
      selectionKey: '0',
    },
  };
  return next;
}

function observationFor(state: MatchState, playerId: PlayerId): BotObservation {
  const view = playerView(state, playerId, database, config);
  return {
    view,
    legal: legalActions(state, playerId, { database, config }),
    history: view.log,
    database,
    rulesConfig: config,
    decisionIndex: 0,
  };
}

/** What the pilot thinks of naming exactly this option. */
function scoreOf(state: MatchState, playerId: PlayerId, selectedId: string): number {
  const observation = observationFor(state, playerId);
  const choice = observation.legal.pendingChoice;
  if (!choice) throw new Error('expected a pending choice');
  return scoreCandidate(
    observation,
    {
      action: { type: 'submit_choice', playerId, choiceId: choice.id, selectedIds: [selectedId] },
      family: 'submit_choice',
      key: `choice:${selectedId}`,
    },
    DEFAULT_WEIGHTS,
  );
}

describe('one card, two instructions, two answers (M05.3)', () => {
  /** Our own big and small unit, with an identical enemy board beside them. */
  function board(): { state: MatchState; mine: string[]; theirs: string[] } {
    const ours = withUnits(startedTable(), 'player_1', [BIG, SMALL]);
    const both = withUnits(ours.state, 'player_2', [BIG, SMALL]);
    return { state: both.state, mine: ours.instanceIds, theirs: both.instanceIds };
  }

  it('sacrifices its worst unit when the instruction is a detriment', () => {
    const { state, mine } = board();
    const [big, small] = mine as [string, string];
    const asked = awaitingSelection(state, 'player_1', mine, {
      effectType: 'sacrifice',
      intent: 'detriment',
      targetRelation: 'self',
    });

    expect(scoreOf(asked, 'player_1', small)).toBeGreaterThan(scoreOf(asked, 'player_1', big));
  });

  it('buffs its best unit when the instruction is a benefit — same card, same board', () => {
    const { state, mine } = board();
    const [big, small] = mine as [string, string];
    const asked = awaitingSelection(state, 'player_1', mine, {
      effectType: 'modify_stats',
      intent: 'benefit',
      targetRelation: 'self',
    });

    // The half the old card-wide scan got backwards. Nothing about the board has
    // changed between this test and the one above it.
    expect(scoreOf(asked, 'player_1', big)).toBeGreaterThan(scoreOf(asked, 'player_1', small));
  });

  it('destroys the opponent’s best unit rather than their worst', () => {
    const { state, theirs } = board();
    const [big, small] = theirs as [string, string];
    const asked = awaitingSelection(state, 'player_1', theirs, {
      effectType: 'destroy',
      intent: 'detriment',
      targetRelation: 'opponent',
    });

    expect(scoreOf(asked, 'player_1', big)).toBeGreaterThan(scoreOf(asked, 'player_1', small));
  });

  it('declines to help the opponent’s best unit when handed a benefit aimed at them', () => {
    const { state, theirs } = board();
    const [big, small] = theirs as [string, string];
    const asked = awaitingSelection(state, 'player_1', theirs, {
      effectType: 'modify_stats',
      intent: 'benefit',
      targetRelation: 'opponent',
    });

    // Forced to help somebody, help them least.
    expect(scoreOf(asked, 'player_1', small)).toBeGreaterThan(scoreOf(asked, 'player_1', big));
  });

  it('treats an instruction with no valence as no reason to prefer either', () => {
    const { state, mine } = board();
    const [big, small] = mine as [string, string];
    const asked = awaitingSelection(state, 'player_1', mine, {
      effectType: 'schedule_delayed',
      intent: 'neutral',
      targetRelation: 'self',
    });

    // A tie, broken by the pilot's seeded tie-break rather than by a guess.
    expect(scoreOf(asked, 'player_1', big)).toBe(scoreOf(asked, 'player_1', small));
  });
});

describe('a cost is a detriment paid with your own cards (M05.3)', () => {
  it('pays with its worst unit without a list of costly reasons to consult', () => {
    const ours = withUnits(startedTable(), 'player_1', [BIG, SMALL]);
    const [big, small] = ours.instanceIds as [string, string];
    const asked = awaitingSelection(ours.state, 'player_1', ours.instanceIds, {
      origin: 'cost',
      itemId: null,
      effectIndex: null,
      effectType: null,
      intent: 'detriment',
      targetRelation: 'self',
    });
    // `reason` is what the old pilot keyed off; it is left as `effect_target`
    // here on purpose, to prove the answer now comes from the provenance.
    expect(asked.pendingChoice?.reason).toBe('effect_target');
    expect(scoreOf(asked, 'player_1', small)).toBeGreaterThan(scoreOf(asked, 'player_1', big));
  });
});
