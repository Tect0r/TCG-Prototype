import { describe, expect, it } from 'vitest';
import type { CardDefinitionInput } from '@tcg/card-data';
import { DEFAULT_RULES_CONFIG } from './config.js';
import { opponentOf } from './derive.js';
import { matchStateSchema } from './schema/state.js';
import { playerView } from './view.js';
import {
  apply,
  databaseWith,
  deployUnit,
  eventsOfType,
  giveCard,
  keepAllHands,
  keepBothHands,
  setEnergy,
  startMatch,
  startTable,
  testContext,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';

/**
 * Structured provenance on every pending choice (M05.3).
 *
 * What this file is really asserting is a *negative*: nothing downstream has to
 * read the source card to find out what a question means. Before this tranche a
 * pilot answered "is picking this good or bad for me" by scanning the whole
 * definition of whatever asked, so a card that removed one unit and buffed
 * another was hostile for both of its choices — and the resulting bad play is
 * invisible in a match result, which is why it survived so long.
 *
 * Every claim here is therefore about one question at a time: which instruction
 * raised it, who is answering, whose entities are on offer from that seat, and
 * what selecting one does to it.
 */

const CARDS: CardDefinitionInput[] = [
  {
    schemaVersion: 3,
    id: 'cp_body',
    name: 'Test Body',
    type: 'unit',
    colorIdentity: [],
    cost: 1,
    attack: 1,
    health: 2,
  },
  /**
   * The card the old card-wide scan could not read: one instruction that hurts
   * and one that helps, each with its own choice.
   */
  {
    schemaVersion: 3,
    id: 'cp_mixed',
    name: 'Cut and Bless',
    type: 'spell',
    colorIdentity: [],
    cost: 2,
    effects: [
      {
        type: 'destroy',
        target: {
          kind: 'entity',
          selector: { zone: 'battlefield', controller: 'opponent', count: 1 },
        },
      },
      {
        type: 'modify_stats',
        target: {
          kind: 'entity',
          selector: { zone: 'battlefield', controller: 'self', count: 1 },
        },
        attack: 2,
        health: 2,
      },
    ],
  },
  /** "You may sacrifice a Unit you control." A confirm, then a selection. */
  {
    schemaVersion: 3,
    id: 'cp_optional_sacrifice',
    name: 'Optional Offering',
    type: 'spell',
    colorIdentity: [],
    cost: 1,
    effects: [
      {
        type: 'sacrifice',
        optional: true,
        target: {
          kind: 'entity',
          selector: { zone: 'battlefield', controller: 'self', count: 1 },
        },
      },
    ],
  },
  /** An interactive additional cost, paid before anything commits. */
  {
    schemaVersion: 3,
    id: 'cp_cost_offering',
    name: 'Cost Offering',
    type: 'spell',
    colorIdentity: [],
    cost: 1,
    additionalCosts: [{ type: 'sacrifice', amount: 1 }],
    effects: [{ type: 'draw', player: 'self', amount: 1 }],
  },
  /** "Each player sacrifices a Unit they control." One question, every seat. */
  {
    schemaVersion: 3,
    id: 'cp_each_player',
    name: 'Shared Toll',
    type: 'spell',
    colorIdentity: [],
    cost: 2,
    effects: [
      {
        type: 'sacrifice',
        target: {
          kind: 'entity',
          selector: {
            zone: 'battlefield',
            controller: 'self',
            chooser: 'all_players',
            count: 1,
            selection: 'player_choice',
          },
        },
      },
    ],
  },
  /** "Deal 3 damage divided as you choose among enemy Units." */
  {
    schemaVersion: 3,
    id: 'cp_divided',
    name: 'Split Volley',
    type: 'spell',
    colorIdentity: [],
    cost: 2,
    effects: [
      {
        type: 'deal_damage',
        amount: 3,
        divided: true,
        target: {
          kind: 'entity',
          selector: { zone: 'battlefield', controller: 'opponent', count: 'all' },
        },
      },
    ],
  },
  /** "An opponent discards a card." Asks who, then asks them what. */
  {
    schemaVersion: 3,
    id: 'cp_opponent_discard',
    name: 'Pointed Question',
    type: 'spell',
    colorIdentity: [],
    cost: 2,
    effects: [{ type: 'discard', player: 'opponent', amount: 1, selection: 'player_choice' }],
  },
];

const database = databaseWith(CARDS);
const context = { ...testContext(DEFAULT_RULES_CONFIG), database };

const BODY = 'cp_body';

function pendingChoice(state: MatchState) {
  const choice = state.pendingChoice;
  if (!choice) throw new Error('Expected a pending choice');
  return choice;
}

function answer(state: MatchState, selectedIds: readonly string[]): MatchState {
  const choice = pendingChoice(state);
  return apply(
    state,
    {
      type: 'submit_choice',
      playerId: choice.playerId,
      choiceId: choice.id,
      selectedIds: [...selectedIds],
    },
    context,
  );
}

function play(state: MatchState, playerId: PlayerId, definitionId: string): MatchState {
  const placed = giveCard(state, playerId, definitionId);
  return apply(
    placed.state,
    { type: 'play_card', playerId, instanceId: placed.instanceId },
    context,
  );
}

function stock(state: MatchState, playerId: PlayerId, count: number): [MatchState, InstanceId[]] {
  let next = state;
  const ids: InstanceId[] = [];
  for (let i = 0; i < count; i += 1) {
    const placed = deployUnit(next, playerId, BODY);
    next = placed.state;
    ids.push(placed.instanceId);
  }
  return [next, ids];
}

/** A two-seat board where both sides hold `count` bodies and can pay for anything. */
function duel(count = 2): { state: MatchState; caster: PlayerId; other: PlayerId } {
  let state = keepBothHands(startMatch({ database }), context);
  const caster = state.activePlayerId;
  const other = opponentOf(state, caster);
  state = setEnergy(setEnergy(state, caster, 10), other, 10);
  [state] = stock(state, caster, count);
  [state] = stock(state, other, count);
  return { state, caster, other };
}

/* ------------------------------------------- 1. one card, two intents */

describe('provenance names the instruction, not the card (M05.3)', () => {
  it('gives the two halves of one card opposite intents', () => {
    const { state, caster } = duel();
    const cut = play(state, caster, 'cp_mixed');

    const removal = pendingChoice(cut).provenance;
    expect(removal.effectType).toBe('destroy');
    expect(removal.effectIndex).toBe(0);
    expect(removal.intent).toBe('detriment');
    expect(removal.targetRelation).toBe('opponent');

    const bless = pendingChoice(answer(cut, [pendingChoice(cut).validEntityIds[0] as string]));
    expect(bless.provenance.effectType).toBe('modify_stats');
    expect(bless.provenance.effectIndex).toBe(1);
    // The half a card-wide scan could not see: the same card, the opposite sign.
    expect(bless.provenance.intent).toBe('benefit');
    expect(bless.provenance.targetRelation).toBe('self');
  });

  it('files both questions against the same resolution item', () => {
    const { state, caster } = duel();
    const cut = play(state, caster, 'cp_mixed');
    const first = pendingChoice(cut).provenance;
    const second = pendingChoice(
      answer(cut, [pendingChoice(cut).validEntityIds[0] as string]),
    ).provenance;

    expect(first.itemId).not.toBeNull();
    expect(second.itemId).toBe(first.itemId);
    expect(first.origin).toBe('instruction');
    expect(second.origin).toBe('instruction');
  });
});

/* ---------------------------------------------- 2. optional sacrifice */

describe('an optional sacrifice (M05.3)', () => {
  it('carries the instruction it is offering on the yes/no', () => {
    const { state, caster } = duel(1);
    const asked = play(state, caster, 'cp_optional_sacrifice');

    const choice = pendingChoice(asked);
    expect(choice.type).toBe('confirm');
    expect(choice.reason).toBe('optional_effect');
    expect(choice.provenance.effectType).toBe('sacrifice');
    expect(choice.provenance.intent).toBe('detriment');
    // "Yes" is not a card, so there is no entity for a relation to be about.
    expect(choice.provenance.targetRelation).toBe('none');
    expect(choice.provenance.chooser).toBe('source_controller');
  });

  it('says the victim is our own once the offer is accepted', () => {
    const { state, caster } = duel(1);
    const picking = answer(play(state, caster, 'cp_optional_sacrifice'), ['yes']);

    const choice = pendingChoice(picking);
    expect(choice.reason).toBe('effect_target');
    expect(choice.provenance.intent).toBe('detriment');
    expect(choice.provenance.targetRelation).toBe('self');
  });
});

/* -------------------------------------------------- 3. divided damage */

describe('a divided damage total (M05.3)', () => {
  it('is one detriment aimed across the other side of the table', () => {
    const { state, caster } = duel(2);
    const split = play(state, caster, 'cp_divided');

    const choice = pendingChoice(split);
    expect(choice.type).toBe('divide_damage');
    expect(choice.provenance.effectType).toBe('deal_damage');
    expect(choice.provenance.intent).toBe('detriment');
    expect(choice.provenance.targetRelation).toBe('opponent');
    expect(choice.provenance.chooser).toBe('source_controller');
  });
});

/* --------------------------------------------- 4. multiplayer choices */

describe('choices spread across a four-seat table (M05.3)', () => {
  function table(): { state: MatchState; caster: PlayerId } {
    let state = keepAllHands(startTable(4, { database }), context);
    for (const playerId of state.seatOrder) {
      state = setEnergy(state, playerId, 10);
      [state] = stock(state, playerId, 2);
    }
    return { state, caster: state.activePlayerId };
  }

  it('reads "a Unit they control" from each seat that is asked', () => {
    const { state, caster } = table();
    let next = play(state, caster, 'cp_each_player');

    const seen: { playerId: PlayerId; chooser: string; relation: string }[] = [];
    for (let i = 0; i < 4; i += 1) {
      const choice = pendingChoice(next);
      seen.push({
        playerId: choice.playerId,
        chooser: choice.provenance.chooser,
        relation: choice.provenance.targetRelation,
      });
      next = answer(next, [choice.validEntityIds[0] as string]);
    }

    // Every seat is choosing among its **own** units, whoever printed the card.
    expect(seen.map((entry) => entry.relation)).toEqual(['self', 'self', 'self', 'self']);
    // And the caster is the only one answering their own card.
    expect(seen.map((entry) => entry.chooser)).toEqual([
      'source_controller',
      'opponent',
      'opponent',
      'opponent',
    ]);
    expect(seen[0]?.playerId).toBe(caster);
  });

  it('records the source controller on a question handed to somebody else', () => {
    const { state, caster } = table();
    const asking = play(state, caster, 'cp_opponent_discard');

    // With four seats "an opponent" is ambiguous, so the caster names one first.
    const whom = pendingChoice(asking);
    expect(whom.reason).toBe('select_opponent');
    expect(whom.provenance.effectType).toBe('discard');
    expect(whom.provenance.intent).toBe('detriment');
    expect(whom.provenance.targetRelation).toBe('opponent');

    const victim = whom.validEntityIds[0] as PlayerId;
    const discarding = pendingChoice(answer(asking, [victim]));
    expect(discarding.playerId).toBe(victim);
    expect(discarding.reason).toBe('discard_effect');
    expect(discarding.provenance.sourceControllerId).toBe(caster);
    expect(discarding.provenance.chooser).toBe('opponent');
    // Out of their own hand, which is the reading the seat being asked needs.
    expect(discarding.provenance.targetRelation).toBe('self');
    expect(discarding.provenance.intent).toBe('detriment');
  });
});

/* ------------------------------- 5. the questions no instruction asks */

describe('choices with no resolving instruction behind them (M05.3)', () => {
  it('marks an interactive cost as a cost, with nothing resolved yet', () => {
    const { state, caster } = duel(2);
    const paying = play(state, caster, 'cp_cost_offering');

    const choice = pendingChoice(paying);
    expect(choice.reason).toBe('sacrifice_cost');
    expect(choice.provenance.origin).toBe('cost');
    // Nothing has been queued, so there is no resolution item to point at.
    expect(choice.provenance.itemId).toBeNull();
    expect(choice.provenance.effectIndex).toBeNull();
    expect(choice.provenance.effectType).toBeNull();
    expect(choice.provenance.targetRelation).toBe('self');
    expect(choice.provenance.intent).toBe('detriment');
  });

  it('marks the hand-size discard as turn structure with no source at all', () => {
    // A small hand limit rather than a padded hand: the opening hand is already
    // over three, so the check fires on the ordinary end-of-turn path.
    const config = { ...DEFAULT_RULES_CONFIG, maxHandSize: 3 };
    const local = { database, config };
    const start = keepBothHands(startMatch({ database, config }), local);
    const active = start.activePlayerId;

    let next = apply(start, { type: 'pass_phase', playerId: active }, local);
    next = apply(next, { type: 'declare_attackers', playerId: active, attacks: [] }, local);
    next = apply(next, { type: 'pass_phase', playerId: active }, local);

    const choice = pendingChoice(next);
    expect(choice.reason).toBe('hand_size_discard');
    expect(choice.playerId).toBe(active);
    expect(choice.provenance.origin).toBe('turn_structure');
    expect(choice.provenance.sourceControllerId).toBeNull();
    expect(choice.provenance.chooser).toBe('none');
    expect(choice.provenance.targetRelation).toBe('self');
    expect(choice.provenance.intent).toBe('detriment');
  });
});

/* ------------------------------------- 6. it travels with the match */

describe('provenance is part of the record, not a convenience (M05.3)', () => {
  it('rides on the choice_requested event as well as the pending choice', () => {
    const { state, caster } = duel();
    const cut = play(state, caster, 'cp_mixed');

    const requested = eventsOfType(cut, 'choice_requested').at(-1);
    expect(requested?.provenance).toEqual(pendingChoice(cut).provenance);
  });

  it('reaches the seat being asked through its own view, unchanged', () => {
    const { state, caster, other } = duel();
    const cut = play(state, caster, 'cp_mixed');

    const mine = playerView(cut, caster, database, DEFAULT_RULES_CONFIG);
    expect(mine.pendingChoice?.provenance).toEqual(pendingChoice(cut).provenance);
    // The opponent never sees a choice that is not theirs; the provenance goes
    // with it rather than leaking out on its own.
    expect(playerView(cut, other, database, DEFAULT_RULES_CONFIG).pendingChoice).toBeNull();
  });

  it('survives a serialisation round trip', () => {
    const { state, caster } = duel();
    const cut = play(state, caster, 'cp_mixed');
    const round = matchStateSchema.parse(JSON.parse(JSON.stringify(cut)));
    expect(round.pendingChoice?.provenance).toEqual(cut.pendingChoice?.provenance);
  });

  it('carries no card identity, so being asked is not being shown', () => {
    const { state, caster } = duel();
    const cut = play(state, caster, 'cp_mixed');
    const provenance = pendingChoice(cut).provenance;
    expect(Object.keys(provenance).sort()).toEqual([
      'chooser',
      'effectIndex',
      'effectType',
      'intent',
      'itemId',
      'origin',
      'sourceControllerId',
      'targetRelation',
    ]);
  });
});
