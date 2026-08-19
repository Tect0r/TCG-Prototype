import { describe, expect, it } from 'vitest';
import { createMatch, type GameEvent, type MatchState } from '@tcg/rules-engine';
import { isErr } from '@tcg/shared';
import { TelemetryCollector, type SeatSetup } from './telemetry/collector.js';
import { toMatchDeck } from '@tcg/deck-generator';
import { fixtureDeck, tinyEnvironment } from './test-fixtures.js';

/**
 * M02.4: a replacement is attributed to the card that did the replacing.
 *
 * A static ability that rewrites an arrival or a Ready Step never reaches the
 * resolution queue, so it produces no `trigger_queued` and no play or
 * activation of its own after the turn it landed. Without an explicit rule here
 * a Relic whose entire text is a replacement would report zero of everything
 * and read, to balance work, as a card nobody ever used — the inference the
 * milestone forbids drawing from final state.
 *
 * These drive the collector with the exact events the engine emits rather than
 * playing a match, because what is under test is the attribution rule and not
 * whether a pilot happens to deploy a Relic before its opponent deploys a Unit.
 * The engine-side behaviour those events describe is covered by
 * `packages/rules-engine/src/replacement.test.ts`.
 */

const REPLACEMENT_CARDS = ['containment_array', 'temporal_anchor', 'stasis_seal'] as const;

/** The envelope every emitted event carries; irrelevant to attribution here. */
function envelope(sourceInstanceId: string): Pick<GameEvent, 'sequence' | 'cause'> {
  return { sequence: 1, cause: { actionType: null, sourceInstanceId, resolutionId: null } };
}

interface Harness {
  readonly collector: TelemetryCollector;
  readonly state: MatchState;
  /** First instance of `definitionId` owned by `player_1`. */
  instanceOf: (definitionId: string) => string;
}

function harness(): Harness {
  const environment = tinyEnvironment({
    id: 'tiny_replacement',
    extraCardIds: REPLACEMENT_CARDS,
  });
  const deck = fixtureDeck('replacement', 'prototype_commander_blue', [
    ['containment_array', 1],
    ['temporal_anchor', 1],
    ['stasis_seal', 1],
    ['prototype_drone', 2],
    ['prototype_scout', 2],
    ['prototype_guard', 2],
    ['trench_guard', 2],
  ]);

  const started = createMatch({
    matchId: 'm_replacement_telemetry',
    database: environment.database,
    config: environment.rulesConfig,
    seed: 'replacement-telemetry',
    seats: [
      { playerId: 'player_1', name: 'Player One', deck: toMatchDeck(deck) },
      { playerId: 'player_2', name: 'Player Two', deck: toMatchDeck(deck) },
    ],
  });
  if (isErr(started)) throw new Error(started.error.message);
  const state = started.value.state;

  const setups: SeatSetup[] = ['player_1', 'player_2'].map((playerId, seatIndex) => ({
    playerId,
    seatIndex,
    deckId: deck.id,
    deckHash: deck.hash,
    deck: toMatchDeck(deck),
    pilotId: 'value',
    pilotVersion: '0',
    pilotConfigHash: 'hash',
    pilotSeed: 'seed',
  }));

  return {
    collector: new TelemetryCollector(environment.database, setups, state, environment.rulesConfig),
    state,
    instanceOf: (definitionId) => {
      const instance = Object.values(state.instances).find(
        (candidate) => candidate.definitionId === definitionId && candidate.owner === 'player_1',
      );
      if (!instance) throw new Error(`no instance of ${definitionId} in the fixture deck`);
      return instance.instanceId;
    },
  };
}

function rowFor(
  collector: TelemetryCollector,
  state: MatchState,
  definitionId: string,
): { triggersFired: number } {
  const record = collector.finish(state, []);
  const row = record.cards.find(
    (card) => card.playerId === 'player_1' && card.definitionId === definitionId,
  );
  if (!row) throw new Error(`no telemetry row for ${definitionId}`);
  return row;
}

describe('replacement telemetry attribution', () => {
  it('credits a rewritten arrival to the Relic that rewrote it, not the card that arrived', () => {
    const { collector, state, instanceOf } = harness();
    const source = instanceOf('containment_array');
    const arriving = instanceOf('prototype_drone');

    const event: GameEvent = {
      ...envelope(source),
      type: 'arrival_replaced',
      playerId: 'player_2',
      instanceId: arriving,
      definitionId: 'prototype_drone',
      sourceInstanceId: source,
      sourceDefinitionId: 'containment_array',
      abilityId: 'containment_field',
      exhausted: true,
      keyword: null,
    };
    collector.observeEvents([event], state);

    expect(rowFor(collector, state, 'containment_array').triggersFired).toBe(1);
    expect(rowFor(collector, state, 'prototype_drone').triggersFired).toBe(0);
  });

  it('credits a paid readiness replacement to the standing ability that offered it', () => {
    const { collector, state, instanceOf } = harness();
    const source = instanceOf('temporal_anchor');

    collector.observeEvents(
      [
        {
          ...envelope(source),
          type: 'ready_prevented',
          instanceId: instanceOf('prototype_scout'),
          playerId: 'player_2',
          sourceInstanceId: source,
          sourceDefinitionId: 'temporal_anchor',
          abilityId: 'temporal_drag',
          energySpent: 1,
        },
      ],
      state,
    );

    expect(rowFor(collector, state, 'temporal_anchor').triggersFired).toBe(1);
  });

  it('does not bill a stored skip twice: the instruction that armed it was already counted', () => {
    const { collector, state, instanceOf } = harness();
    const source = instanceOf('stasis_seal');

    // `abilityId: null` is how the engine marks the prevention that came from a
    // `skip_next_ready` sitting on the permanent. The Spell that armed it was
    // counted when it was played; counting the payoff too would report one card
    // doing two things for one decision.
    collector.observeEvents(
      [
        {
          ...envelope(source),
          type: 'ready_prevented',
          instanceId: instanceOf('prototype_guard'),
          playerId: 'player_2',
          sourceInstanceId: source,
          sourceDefinitionId: 'stasis_seal',
          abilityId: null,
          energySpent: 0,
        },
      ],
      state,
    );

    expect(rowFor(collector, state, 'stasis_seal').triggersFired).toBe(0);
  });
});
