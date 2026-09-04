import { describe, expect, it } from 'vitest';

import {
  LIVE_MATCH_DECK_HASH_LENGTH,
  LIVE_MATCH_SOURCES,
  LIVE_MATCH_TERMINATION_ORIGINS,
  NO_PLAYER_META_FILTER,
  liveMatchDeckHashSchema,
  playerMetaFilterSchema,
  type PlayerMetaFilterInput,
} from './player-meta.js';
import { MAX_FILTER_VALUES } from './filters.js';

const parse = (input: PlayerMetaFilterInput) => playerMetaFilterSchema.safeParse(input);

describe('restated literal values', () => {
  it('pins the sources this build restates from `@tcg/match-telemetry`', () => {
    expect([...LIVE_MATCH_SOURCES]).toEqual(['human_human', 'human_ai', 'ai_ai']);
  });

  it('pins the termination origins this build restates from `@tcg/match-telemetry`', () => {
    expect([...LIVE_MATCH_TERMINATION_ORIGINS]).toEqual([
      'concede_action',
      'concede_leave',
      'disconnect_timeout',
      'rules_victory',
      'server_failure',
      'abandoned_unrecordable',
    ]);
  });

  it('pins the deck hash length this build restates from `@tcg/deck`', () => {
    expect(LIVE_MATCH_DECK_HASH_LENGTH).toBe(16);
  });
});

describe('the unfiltered query', () => {
  it('is what `{}` means, so a client never enumerates what it does not care about', () => {
    expect(playerMetaFilterSchema.parse({})).toEqual(NO_PLAYER_META_FILTER);
  });

  it('filters on nothing: every field is an empty array', () => {
    for (const value of Object.values(NO_PLAYER_META_FILTER)) {
      expect(value).toEqual([]);
    }
  });

  it('round-trips through JSON unchanged', () => {
    expect(playerMetaFilterSchema.parse(JSON.parse(JSON.stringify(NO_PLAYER_META_FILTER)))).toEqual(
      NO_PLAYER_META_FILTER,
    );
  });
});

describe('filter combinations', () => {
  it('accepts several values for one field', () => {
    const parsed = playerMetaFilterSchema.parse({ sources: ['human_human', 'ai_ai'] });
    expect(parsed.sources).toEqual(['human_human', 'ai_ai']);
  });

  it('accepts every source and every termination origin as a filter value', () => {
    expect(parse({ sources: [...LIVE_MATCH_SOURCES] }).success).toBe(true);
    expect(parse({ terminations: [...LIVE_MATCH_TERMINATION_ORIGINS] }).success).toBe(true);
  });

  it('accepts several fields at once, each narrowing independently', () => {
    const parsed = playerMetaFilterSchema.parse({
      contentVersions: [5],
      sources: ['human_human'],
      commanderIds: ['prototype_commander_blue'],
      deckHashes: ['0123456789abcdef'],
      terminations: ['rules_victory'],
    });
    expect(parsed.contentVersions).toEqual([5]);
    expect(parsed.commanderIds).toEqual(['prototype_commander_blue']);
  });

  it('accepts up to MAX_FILTER_VALUES content versions and refuses one more', () => {
    const many = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => i + 1);
    expect(parse({ contentVersions: many }).success).toBe(false);
    expect(parse({ contentVersions: many.slice(0, MAX_FILTER_VALUES) }).success).toBe(true);
  });

  it('refuses duplicate values in one field', () => {
    expect(parse({ sources: ['human_human', 'human_human'] }).success).toBe(false);
  });

  it('refuses an unknown field', () => {
    expect(parse({ notAField: true } as unknown as PlayerMetaFilterInput).success).toBe(false);
  });
});

describe('liveMatchDeckHashSchema', () => {
  it('accepts a 16-character lowercase hex hash', () => {
    expect(liveMatchDeckHashSchema.safeParse('0123456789abcdef').success).toBe(true);
  });

  it('refuses the wrong length or an uppercase/non-hex character', () => {
    expect(liveMatchDeckHashSchema.safeParse('0123456789abcde').success).toBe(false);
    expect(liveMatchDeckHashSchema.safeParse('0123456789ABCDEF').success).toBe(false);
    expect(liveMatchDeckHashSchema.safeParse('0123456789abcdeg').success).toBe(false);
  });
});
