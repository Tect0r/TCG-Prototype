import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadBundledCardData } from '@tcg/card-data';
import { createMatch, type CardInstance, type MatchState } from '@tcg/rules-engine';
import type { SpectatorSeat } from '@tcg/spectator';
import { unwrap } from '@tcg/shared';
import { SpectatorBoard } from './SpectatorBoard.js';

/**
 * The spectator board's Token stacks (M06.3).
 *
 * These are view-model tests against a hand-built frame rather than a played
 * match, because the point is a board Wave 1 reaches only occasionally and the
 * states that must not be hidden inside a stack: a damaged Token, an Exhausted
 * one, one whose Barrier is gone, one in combat, and the one a playback step is
 * about. A real four-bot match is exercised in `spectator-flow.test.tsx`.
 *
 * The rule under test is the same rule the match board is held to — the layer
 * is shared — so what these add is that the spectator *uses* it, and that
 * Analysis Mode does not change it.
 */

const { database } = loadBundledCardData();

function baseState(): MatchState {
  return unwrap(
    createMatch({
      matchId: 'spectator_board_test',
      seed: 'spectator-board-seed',
      database,
      preserveSeatOrder: true,
      seats: [
        {
          playerId: 'player_1',
          name: 'Bot 1',
          deck: {
            commanderId: 'prototype_commander_red',
            cards: [{ cardId: 'goblin_scout', quantity: 30 }],
          },
        },
        {
          playerId: 'player_2',
          name: 'Bot 2',
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

const SEATS: readonly SpectatorSeat[] = [
  {
    playerId: 'player_1',
    name: 'Bot 1',
    seatIndex: 0,
    preconId: null,
    commanderId: 'prototype_commander_red',
    cardIds: ['goblin_scout'],
    pilotId: 'aggressive',
    pilotVersion: '1.1.0',
    pilotSeed: 'seed',
  },
  {
    playerId: 'player_2',
    name: 'Bot 2',
    seatIndex: 1,
    preconId: null,
    commanderId: 'prototype_commander_green',
    cardIds: ['thornback_calf'],
    pilotId: 'defensive',
    pilotVersion: '1.1.0',
    pilotSeed: 'seed',
  },
];

/**
 * A Token on `player_1`'s battlefield.
 *
 * Cloned from an instance the engine itself created, so every field of
 * `CardInstance` is present and valid without this test having to enumerate a
 * schema it does not own.
 */
function tokenise(
  template: CardInstance,
  instanceId: string,
  overrides: Partial<CardInstance> = {},
): CardInstance {
  return {
    ...template,
    instanceId,
    definitionId: 'prototype_soldier_token',
    owner: 'player_1',
    controller: 'player_1',
    zone: 'battlefield',
    isToken: true,
    markedDamage: 0,
    exhausted: false,
    newlyDeployed: false,
    barrierSpent: false,
    statModifiers: [],
    grantedKeywords: [],
    removedKeywords: [],
    ...overrides,
  };
}

/** Puts `count` Tokens on `player_1`'s battlefield, plus any odd ones out. */
function boardWith(count: number, odd: readonly Partial<CardInstance>[] = []): MatchState {
  const state = baseState();
  const template = Object.values(state.instances)[0];
  if (!template) throw new Error('the engine created no instances');

  const tokens = [
    ...Array.from({ length: count }, (_, index) => tokenise(template, `tok_${index + 1}`)),
    ...odd.map((overrides, index) => tokenise(template, `odd_${index + 1}`, overrides)),
  ];

  const player = state.players.player_1;
  if (!player) throw new Error('no player_1');
  return {
    ...state,
    players: {
      ...state.players,
      player_1: { ...player, units: tokens.map((token) => token.instanceId) },
    },
    instances: {
      ...state.instances,
      ...Object.fromEntries(tokens.map((token) => [token.instanceId, token])),
    },
  };
}

function renderBoard(
  state: MatchState,
  options: {
    readonly highlight?: readonly string[];
    readonly mode?: 'normal' | 'analysis';
    readonly grouping?: boolean;
  } = {},
) {
  const user = userEvent.setup();
  const view = render(
    <SpectatorBoard
      state={state}
      seats={SEATS}
      database={database}
      mode={options.mode ?? 'normal'}
      visibleHands={
        options.mode === 'analysis' ? { player_1: state.players.player_1?.hand ?? [] } : {}
      }
      highlight={new Set(options.highlight ?? [])}
      grouping={options.grouping ?? true}
    />,
  );
  return { user, unmount: view.unmount };
}

const row = (): HTMLElement => screen.getByLabelText('Bot 1 units');
const tiles = (): HTMLElement[] => within(row()).queryAllByRole('button');

describe('the spectator board stacks Tokens the way a match does', () => {
  it('draws a hundred identical Tokens as one tile', () => {
    renderBoard(boardWith(100));

    const [tile, ...rest] = tiles();
    expect(rest).toHaveLength(0);
    expect(tile).toHaveAccessibleName(/Soldier stack of 100/);
    expect(tile).toHaveAttribute('aria-expanded', 'false');
  });

  /**
   * The Q42 finding, on the surface that used to contradict it: this board is
   * one Token short of the worst Wave 1 produces, and grouping by definition
   * alone — which is what this file did until M06.3 — would have drawn it as a
   * single chip saying ×117 with no hint that 64 of them could not attack.
   */
  it('splits the worst board Wave 1 makes by the state that decides a combat', () => {
    const state = boardWith(
      53,
      Array.from({ length: 64 }, () => ({ newlyDeployed: true })),
    );
    renderBoard(state);

    const names = tiles().map((tile) => tile.getAttribute('aria-label') ?? '');
    expect(names).toHaveLength(2);
    expect(names.some((name) => /stack of 53 —.*ready/.test(name))).toBe(true);
    expect(names.some((name) => /stack of 64 —.*newly deployed/.test(name))).toBe(true);
  });

  it('never hides a damaged, Exhausted or spent-Barrier Token inside a stack', () => {
    const state = boardWith(6, [{ markedDamage: 1 }, { exhausted: true }, { barrierSpent: true }]);
    renderBoard(state);

    // Six interchangeable Tokens are one tile; the three that answer combat
    // differently are three chips of their own, not a badge on somebody else's.
    const names = tiles().map((tile) => tile.getAttribute('aria-label') ?? '');
    expect(names).toEqual([expect.stringMatching(/stack of 6 —/)]);

    const chips = within(row()).getAllByTitle(/./);
    expect(chips).toHaveLength(3);
    // The damaged one shows its own damage, which a stack could not have said.
    expect(chips.map((chip) => chip.textContent)).toContain('Soldier1/0 (1)');
  });

  it('separates the Tokens that are attacking from the ones that are not', () => {
    const state = boardWith(5);
    const withCombat: MatchState = {
      ...state,
      combat: {
        ...state.combat,
        attacks: [
          { attackerInstanceId: 'tok_1', defenderPlayerId: 'player_2' },
          { attackerInstanceId: 'tok_2', defenderPlayerId: 'player_2' },
        ],
      },
    };
    renderBoard(withCombat);

    const names = tiles().map((tile) => tile.getAttribute('aria-label') ?? '');
    expect(names).toEqual([
      expect.stringMatching(/stack of 2 —.*attacking Bot 2/),
      expect.stringMatching(/stack of 3 —/),
    ]);
    expect(names[1]).not.toMatch(/attacking/);
  });

  /**
   * Replay stepping. The step's own Tokens are marked, so they leave the stack
   * — a highlight painted on a tile standing for a hundred Tokens would say the
   * step was about all hundred.
   */
  it('shows exactly which Tokens the current step is about', () => {
    renderBoard(boardWith(20), { highlight: ['tok_4', 'tok_9'] });

    const names = tiles().map((tile) => tile.getAttribute('aria-label') ?? '');
    expect(names).toEqual([
      expect.stringMatching(/stack of 18 —/),
      expect.stringMatching(/stack of 2 —.*this step/),
    ]);
    expect(names[0]).not.toMatch(/this step/);
  });

  it('expands a stack into every Token behind it, as a labelled list', async () => {
    const harness = renderBoard(boardWith(12));

    await harness.user.click(tiles()[0] as HTMLElement);
    const members = within(row()).getByRole('list', { name: 'Soldier, 12 shown' });
    expect(within(members).getAllByRole('listitem')).toHaveLength(12);
    // Each member is named for a screen reader, because twelve identical chips
    // are otherwise twelve identical announcements.
    expect(within(members).getByLabelText('Soldier 7 of 12')).toBeInTheDocument();
  });

  it('draws every Token on its own when stacking is turned off', () => {
    renderBoard(boardWith(12), { grouping: false });

    expect(tiles()).toHaveLength(0);
    expect(within(row()).getAllByTitle(/./)).toHaveLength(12);
  });

  it('groups identically in Analysis Mode, which only reveals hands', () => {
    const state = boardWith(6, [{ markedDamage: 1 }]);

    const normal = renderBoard(state, { mode: 'normal' });
    const before = tiles().map((tile) => tile.getAttribute('aria-label'));
    expect(screen.queryByLabelText('Bot 1 hand')).not.toBeInTheDocument();
    normal.unmount();

    renderBoard(state, { mode: 'analysis' });
    // The mode reveals a hand and changes nothing about the board: a tile is
    // cut from public state, and a hand is not part of it.
    expect(screen.getByLabelText('Bot 1 hand')).toBeInTheDocument();
    expect(tiles().map((tile) => tile.getAttribute('aria-label'))).toEqual(before);
  });
});
