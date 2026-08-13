import { describe, expect, it } from 'vitest';
import { loadBundledCardData } from '@tcg/card-data';
import { createMatch, playerView, type CardInstanceView, type PlayerView } from '@tcg/rules-engine';
import { unwrap } from '@tcg/shared';
import {
  DEFAULT_MINIMUM_GROUP_SIZE,
  entryInstanceIds,
  groupBattlefield,
  tokenGroupKey,
  tokenGroupSummary,
  TOKEN_GROUP_KEY_FIELDS,
  type BoardEntry,
} from './token-grouping.js';

/**
 * The Q42 grouping key, tested as a rule rather than as a rendering.
 *
 * Every field the key is cut from gets its own case, driven off
 * `TOKEN_GROUP_KEY_FIELDS` so a field added to the key without a test does not
 * pass. The invariant that matters most — that grouping loses no Token — is
 * checked as a multiset on every board these tests build.
 */

const { database } = loadBundledCardData();

function baseView(): PlayerView {
  const state = unwrap(
    createMatch({
      matchId: 'grouping_test',
      seed: 'grouping-seed',
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
  return playerView(state, 'player_1', database);
}

/** A Token on the viewer's battlefield, identical to its siblings by default. */
function token(instanceId: string, overrides: Partial<CardInstanceView> = {}): CardInstanceView {
  return {
    instanceId,
    definitionId: 'prototype_soldier_token',
    owner: 'player_1',
    controller: 'player_1',
    zone: 'battlefield',
    attack: 1,
    health: 1,
    markedDamage: 0,
    exhausted: false,
    summoningSick: false,
    keywords: [],
    isToken: true,
    willNotReady: false,
    barrierSpent: false,
    energyCost: null,
    ...overrides,
  };
}

/** Puts a set of instances on `player_1`'s battlefield, in the order given. */
function boardOf(instances: readonly CardInstanceView[]): PlayerView {
  const base = baseView();
  return {
    ...base,
    players: base.players.map((player) =>
      player.playerId === 'player_1'
        ? { ...player, units: instances.map((instance) => instance.instanceId) }
        : player,
    ),
    instances: {
      ...base.instances,
      ...Object.fromEntries(instances.map((instance) => [instance.instanceId, instance])),
    },
  };
}

function unitsOf(view: PlayerView): readonly string[] {
  return view.players.find((player) => player.playerId === 'player_1')?.units ?? [];
}

function layOut(view: PlayerView, enabled = true): BoardEntry[] {
  const entries = groupBattlefield(view, unitsOf(view), { enabled });
  // The invariant, asserted on every board these tests build rather than in one
  // test of its own: grouping loses nothing and invents nothing.
  expect([...entryInstanceIds(entries)].sort()).toEqual([...unitsOf(view)].sort());
  return entries;
}

function groups(entries: readonly BoardEntry[]): Extract<BoardEntry, { kind: 'group' }>[] {
  return entries.filter(
    (entry): entry is Extract<BoardEntry, { kind: 'group' }> => entry.kind === 'group',
  );
}

describe('token grouping', () => {
  it('stacks identical Tokens into one tile that counts them', () => {
    const view = boardOf([token('t1'), token('t2'), token('t3')]);
    const entries = layOut(view);

    expect(entries).toHaveLength(1);
    const [group] = groups(entries);
    expect(group?.instanceIds).toEqual(['t1', 't2', 't3']);
    // The tile draws the first arrival, so it does not change appearance when a
    // later member is defeated.
    expect(group?.representativeInstanceId).toBe('t1');
  });

  it('never groups a non-Token Unit, however many copies are out', () => {
    const view = boardOf([
      token('u1', { isToken: false }),
      token('u2', { isToken: false }),
      token('u3', { isToken: false }),
    ]);
    const entries = layOut(view);
    expect(entries.map((entry) => entry.kind)).toEqual(['single', 'single', 'single']);
  });

  it('keeps two Tokens of different definitions apart', () => {
    const view = boardOf([
      token('t1'),
      token('t2', { definitionId: 'prototype_beast_token' }),
      token('t3'),
    ]);
    const entries = layOut(view);
    expect(entries).toHaveLength(2);
    // The first group holds its position even though its second member arrived
    // after another group had started.
    expect(groups(entries)[0]?.instanceIds).toEqual(['t1', 't3']);
  });

  it('keeps two Tokens with different controllers apart', () => {
    const view = boardOf([token('t1'), token('t2', { controller: 'player_2' })]);
    const entries = layOut(view);
    expect(entries.map((entry) => entry.kind)).toEqual(['single', 'single']);
  });

  /**
   * The Q42 answer, field by field. Each case makes one member differ in one
   * way and asserts the tile splits — which is the whole reason the strict key
   * was chosen over grouping by definition alone.
   */
  const splitters: Readonly<Record<string, Partial<CardInstanceView>>> = {
    attack: { attack: 2 },
    health: { health: 2 },
    markedDamage: { markedDamage: 1 },
    exhausted: { exhausted: true },
    summoningSick: { summoningSick: true },
    keywords: { keywords: ['guardian'] },
    willNotReady: { willNotReady: true },
    barrierSpent: { barrierSpent: true },
  };

  for (const [field, override] of Object.entries(splitters)) {
    it(`splits a stack when one member's ${field} differs`, () => {
      const view = boardOf([token('t1'), token('t2'), token('t3', override)]);
      const entries = layOut(view);
      expect(entries).toHaveLength(2);
      expect(groups(entries)[0]?.instanceIds).toEqual(['t1', 't2']);
      // The lone divergent member is not a group of one; it is a card.
      expect(entries[1]).toEqual({ kind: 'single', key: 't3', instanceId: 't3' });
    });
  }

  it('splits a stack by what each Token is doing in combat', () => {
    const base = boardOf([token('t1'), token('t2'), token('t3')]);
    const view: PlayerView = {
      ...base,
      combat: {
        ...base.combat,
        attacks: [{ attackerInstanceId: 't1', defenderPlayerId: 'player_2' }],
        blocks: [{ attackerInstanceId: 'enemy_1', blockerInstanceId: 't2' }],
      },
    };
    const entries = layOut(view);
    // Attacker, blocker and bystander are three different things to click on.
    expect(entries.map((entry) => entry.kind)).toEqual(['single', 'single', 'single']);
  });

  it('separates two attackers aimed at different seats', () => {
    const base = boardOf([token('t1'), token('t2'), token('t3'), token('t4')]);
    const view: PlayerView = {
      ...base,
      combat: {
        ...base.combat,
        attacks: [
          { attackerInstanceId: 't1', defenderPlayerId: 'player_2' },
          { attackerInstanceId: 't2', defenderPlayerId: 'player_2' },
          { attackerInstanceId: 't3', defenderPlayerId: 'player_1' },
        ],
      },
    };
    const entries = layOut(view);
    const attacking = groups(entries).find((group) => group.instanceIds.includes('t1'));
    expect(attacking?.instanceIds).toEqual(['t1', 't2']);
    expect(attacking?.role.attackingPlayerId).toBe('player_2');
  });

  it('reads the viewer’s own unconfirmed blocker submission', () => {
    const base = boardOf([token('t1'), token('t2')]);
    const view: PlayerView = {
      ...base,
      combat: {
        ...base.combat,
        // Public `blocks` is still empty: nobody else has answered yet. The
        // viewer's own submission is theirs to see, and is already on screen.
        submissions: [
          {
            defenderPlayerId: 'player_1',
            blocks: [{ attackerInstanceId: 'enemy_1', blockerInstanceId: 't1' }],
          },
        ],
      },
    };
    const entries = layOut(view);
    expect(entries.map((entry) => entry.kind)).toEqual(['single', 'single']);
  });

  it('ignores keyword order', () => {
    const view = boardOf([
      token('t1', { keywords: ['guardian', 'rush'] }),
      token('t2', { keywords: ['rush', 'guardian'] }),
    ]);
    expect(layOut(view)).toHaveLength(1);
  });

  it('does not make a tile out of a single Token', () => {
    const view = boardOf([token('t1')]);
    expect(layOut(view)).toEqual([{ kind: 'single', key: 't1', instanceId: 't1' }]);
    expect(DEFAULT_MINIMUM_GROUP_SIZE).toBe(2);
  });

  it('returns the untouched board when grouping is off', () => {
    const view = boardOf([token('t1'), token('t2'), token('t3')]);
    const entries = layOut(view, false);
    // Same units, same order, one tile each — the pre-M06 board exactly.
    expect(entryInstanceIds(entries)).toEqual([...unitsOf(view)]);
    expect(entries.every((entry) => entry.kind === 'single')).toBe(true);
  });

  it('offers the same Tokens with grouping on as with it off', () => {
    const view = boardOf([
      token('t1'),
      token('t2', { exhausted: true }),
      token('t3'),
      token('u1', { isToken: false }),
      token('t4', { markedDamage: 1 }),
    ]);
    expect([...entryInstanceIds(layOut(view, true))].sort()).toEqual(
      [...entryInstanceIds(layOut(view, false))].sort(),
    );
  });

  it('cuts the key from every field it claims to', () => {
    const role = { attackingPlayerId: null, blockingInstanceId: null };
    const reference = tokenGroupKey(token('t1'), role);
    // Identity is state, not instance: two different instances in the same
    // state are the same key.
    expect(tokenGroupKey(token('t2'), role)).toBe(reference);

    for (const [field, override] of Object.entries(splitters)) {
      expect(tokenGroupKey(token('t2', override), role), field).not.toBe(reference);
    }
    expect(tokenGroupKey(token('t2'), { ...role, attackingPlayerId: 'player_2' })).not.toBe(
      reference,
    );
    expect(tokenGroupKey(token('t2'), { ...role, blockingInstanceId: 'enemy_1' })).not.toBe(
      reference,
    );
    // Every field named in the exported list is one of the cases above, so a
    // field added to the key without a test here fails.
    expect([...TOKEN_GROUP_KEY_FIELDS].sort()).toEqual(
      [...Object.keys(splitters), 'controller', 'definitionId', 'attacking', 'blocking'].sort(),
    );
  });

  it('summarises a group only by state the whole group shares', () => {
    const summary = tokenGroupSummary(
      token('t1', { markedDamage: 1, health: 3, exhausted: true, barrierSpent: true }),
      { attackingPlayerId: 'player_2', blockingInstanceId: null },
      (playerId) => (playerId === 'player_2' ? 'Rival' : playerId),
    );
    expect(summary).toEqual(['1 / 2', '1 dmg', 'exhausted', 'barrier spent', 'attacking Rival']);
  });
});
