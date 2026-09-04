import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NO_PLAYER_META_FILTER,
  pageRequestSchema,
  type PlayerMetaFilter,
} from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';

import { readPlayerMetaSummary, readPlayerMetaTable } from './player-meta-results.js';

/**
 * M08.25B — the Player Meta read model over a resolved root directory of
 * `LiveMatchFileStore`-shaped match directories: filtering, partitioning,
 * table building and pagination composed straight out of `@tcg/simulator`'s
 * M08.24/M08.25A pieces, never recomputed here.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tcg-admin-player-meta-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const page = pageRequestSchema.parse({});
const filter: PlayerMetaFilter = NO_PLAYER_META_FILTER;

const winOutcome: LiveMatchEnvelope['outcome'] = {
  outcome: 'win',
  winnerId: 'player_1',
  loserIds: ['player_2'],
  reason: 'health_depleted',
  finalTurn: 10,
  finalSequence: 200,
  diagnostics: null,
};

function envelope(matchId: string, overrides: Partial<LiveMatchEnvelope> = {}): LiveMatchEnvelope {
  return {
    schemaVersion: 3,
    matchId,
    source: 'human_human',
    formatId: 'precon_wave_1',
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    seats: [
      {
        seatIndex: 0,
        playerId: 'player_1',
        kind: 'human',
        deck: freezeLiveMatchDeckSnapshot({
          commanderId: 'prototype_commander_blue',
          cards: [{ cardId: 'prototype_drone', quantity: 40 }],
        }),
      },
      {
        seatIndex: 1,
        playerId: 'player_2',
        kind: 'human',
        deck: freezeLiveMatchDeckSnapshot({
          commanderId: 'prototype_commander_red',
          cards: [{ cardId: 'prototype_scout', quantity: 40 }],
        }),
      },
    ],
    actionCount: 40,
    terminationOrigin: 'rules_victory',
    outcome: winOutcome,
    ...overrides,
  };
}

function writeMatch(matchId: string, match: LiveMatchEnvelope): void {
  const directory = join(root, matchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'envelope.json'), JSON.stringify(match), 'utf8');
}

describe('an empty root', () => {
  it('is a valid, all-zero answer — never a refusal', () => {
    const summary = unwrap(readPlayerMetaSummary(root, filter));
    expect(summary.source).toEqual({ recordsRead: 0, recordsSkipped: 0 });
    expect(summary.partitions).toEqual([]);
    expect(summary.tables.every((entry) => entry.rows === 0)).toBe(true);

    const table = unwrap(readPlayerMetaTable(root, 'commanders', filter, page));
    expect(table.rows).toEqual([]);
    expect(table.page).toEqual({ returned: 0, limit: page.limit, nextCursor: null, total: 0 });
  });
});

describe('a summary over live matches', () => {
  it('reports one partition per (source, contentVersion, rulesVersion), with both weightings', () => {
    writeMatch('match_a', envelope('match_a'));
    writeMatch('match_b', envelope('match_b'));

    const summary = unwrap(readPlayerMetaSummary(root, filter));
    expect(summary.source).toEqual({ recordsRead: 2, recordsSkipped: 0 });
    expect(summary.partitions).toHaveLength(1);
    expect(summary.partitions[0]?.matches).toBe(2);
    expect(summary.partitions[0]?.uniqueDecks).toBeGreaterThan(0);
    expect(summary.limitations.length).toBeGreaterThan(0);
  });

  it('counts a damaged match directory as skipped, not read', () => {
    writeMatch('match_good', envelope('match_good'));
    mkdirSync(join(root, 'match_bad'), { recursive: true });
    writeFileSync(join(root, 'match_bad', 'envelope.json'), 'not json', 'utf8');

    const summary = unwrap(readPlayerMetaSummary(root, filter));
    expect(summary.source).toEqual({ recordsRead: 1, recordsSkipped: 1 });
  });

  it('applies the filter before aggregating, the same way M08.25A defines it', () => {
    writeMatch('match_human', envelope('match_human', { source: 'human_human' }));
    writeMatch(
      'match_ai',
      envelope('match_ai', {
        source: 'ai_ai',
        seats: [
          {
            seatIndex: 0,
            playerId: 'player_1',
            kind: 'bot',
            deck: freezeLiveMatchDeckSnapshot({
              commanderId: 'prototype_commander_blue',
              cards: [{ cardId: 'prototype_drone', quantity: 40 }],
            }),
          },
          {
            seatIndex: 1,
            playerId: 'player_2',
            kind: 'bot',
            deck: freezeLiveMatchDeckSnapshot({
              commanderId: 'prototype_commander_red',
              cards: [{ cardId: 'prototype_scout', quantity: 40 }],
            }),
          },
        ],
      }),
    );

    const summary = unwrap(
      readPlayerMetaSummary(root, { ...NO_PLAYER_META_FILTER, sources: ['ai_ai'] }),
    );
    expect(summary.source.recordsRead).toBe(1);
    expect(summary.partitions).toHaveLength(1);
    expect(summary.partitions[0]?.partition.source).toBe('ai_ai');
  });
});

describe('the commanders table', () => {
  it('carries partition columns on every row plus a win-rate interval', () => {
    writeMatch('match_a', envelope('match_a'));

    const table = unwrap(readPlayerMetaTable(root, 'commanders', filter, page));
    expect(table.rows.length).toBeGreaterThan(0);
    const row = table.rows[0];
    expect(row?.source).toBe('human_human');
    expect(row?.contentVersion).toBe(5);
    expect(row?.rulesVersion).toBe('1.0.0');
    expect(row).toHaveProperty('winRate');
    expect(row).toHaveProperty('winRateLow');
    expect(row).toHaveProperty('winRateHigh');
  });

  it('reads a zero-observation win rate as null rather than a fabricated proportion', () => {
    writeMatch(
      'match_abandoned',
      envelope('match_abandoned', { terminationOrigin: 'abandoned_unrecordable', outcome: null }),
    );

    const table = unwrap(readPlayerMetaTable(root, 'commanders', filter, page));
    for (const row of table.rows) {
      expect(row.winRate).toBeNull();
      expect(row.winRateLow).toBeNull();
      expect(row.winRateHigh).toBeNull();
    }
  });
});

describe('the duration table', () => {
  it('has exactly one row per partition', () => {
    writeMatch('match_a', envelope('match_a'));
    writeMatch('match_b', envelope('match_b'));

    const table = unwrap(readPlayerMetaTable(root, 'duration', filter, page));
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.decisiveMatches).toBe(2);
  });
});

describe('the terminations table', () => {
  it('has one row per partition per termination origin observed', () => {
    writeMatch('match_a', envelope('match_a', { terminationOrigin: 'rules_victory' }));
    writeMatch(
      'match_b',
      envelope('match_b', { terminationOrigin: 'abandoned_unrecordable', outcome: null }),
    );

    const table = unwrap(readPlayerMetaTable(root, 'terminations', filter, page));
    const origins = table.rows.map((row) => row.origin).sort();
    expect(origins).toEqual(['abandoned_unrecordable', 'rules_victory']);
  });
});

describe('pagination', () => {
  it('pages through rows with a cursor, never re-reading a row twice', () => {
    for (let index = 0; index < 5; index += 1) {
      writeMatch(
        `match_${String(index)}`,
        envelope(`match_${String(index)}`, {
          provenance: {
            softwareVersion: '1.0.0',
            contentVersion: 5 + index,
            rulesVersion: '1.0.0',
          },
        }),
      );
    }

    const firstPage = unwrap(
      readPlayerMetaTable(root, 'duration', filter, pageRequestSchema.parse({ limit: 2 })),
    );
    expect(firstPage.rows).toHaveLength(2);
    expect(firstPage.page.nextCursor).not.toBeNull();

    const cursor = firstPage.page.nextCursor;
    if (cursor === null) throw new Error('expected a cursor');
    const secondPage = unwrap(
      readPlayerMetaTable(root, 'duration', filter, pageRequestSchema.parse({ limit: 2, cursor })),
    );
    expect(secondPage.rows).toHaveLength(2);

    const firstVersions = firstPage.rows.map((row) => row.contentVersion);
    const secondVersions = secondPage.rows.map((row) => row.contentVersion);
    expect(new Set([...firstVersions, ...secondVersions]).size).toBe(4);
  });

  it('refuses a garbled cursor rather than guessing an offset', () => {
    writeMatch('match_a', envelope('match_a'));
    const result = readPlayerMetaTable(
      root,
      'duration',
      filter,
      pageRequestSchema.parse({ cursor: 'not-a-real-cursor' }),
    );
    expect(isErr(result)).toBe(true);
  });
});
