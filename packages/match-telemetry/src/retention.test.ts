import { describe, expect, it } from 'vitest';
import type { GameEvent, LoggedAction } from '@tcg/rules-engine';
import { LIVE_MATCH_TERMINATION_ORIGINS, type LiveMatchTerminationOrigin } from './schema.js';
import {
  LIVE_MATCH_FORCED_RAW_EVENT_ORIGINS,
  LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION,
  LIVE_MATCH_REPLAY_SCHEMA_VERSION,
  decideLiveMatchRetention,
  describeLiveMatchRawEventVersionProblem,
  describeLiveMatchReplayVersionProblem,
  isForcedLiveMatchRawEventOrigin,
  liveMatchRawEventArtifactSchema,
  liveMatchReplayArtifactSchema,
  liveMatchRetentionConfigSchema,
  parseLiveMatchRawEventArtifact,
  parseLiveMatchReplayArtifact,
  type LiveMatchRawEventArtifact,
  type LiveMatchReplayArtifact,
} from './retention.js';

/**
 * Retention and artifact contracts (M08.21C): the raw-event and replay
 * artifacts a deployment may keep beyond the mandatory summary envelope, and
 * the pure decision of what to actually retain for one match. No sink or
 * storage here — only schema round trip, future/older-version refusal and the
 * forced-retention rule for diagnostically valuable termination origins.
 */

const concedeAction: LoggedAction = {
  index: 0,
  action: { type: 'concede', playerId: 'player_1' },
  sequenceAfter: 1,
};

const matchStartedEvent: GameEvent = {
  type: 'match_started',
  sequence: 0,
  cause: { actionType: null, sourceInstanceId: null, resolutionId: null },
  playerIds: ['player_1', 'player_2'],
  seatOrder: ['player_1', 'player_2'],
  startingPlayerId: 'player_1',
  rulesVersion: '1.0.0',
};

function validRawEventArtifact(): LiveMatchRawEventArtifact {
  return {
    schemaVersion: LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION,
    matchId: 'match_001',
    log: [matchStartedEvent],
    actionLog: [concedeAction],
  };
}

function validReplayArtifact(): LiveMatchReplayArtifact {
  return {
    schemaVersion: LIVE_MATCH_REPLAY_SCHEMA_VERSION,
    matchId: 'match_001',
    seed: 'match_001-seed',
    actionLog: [concedeAction],
  };
}

describe('liveMatchRawEventArtifactSchema', () => {
  it('round trips a valid artifact', () => {
    const artifact = validRawEventArtifact();
    expect(liveMatchRawEventArtifactSchema.parse(artifact)).toEqual(artifact);
  });

  it('refuses an unknown field', () => {
    const withExtra = { ...validRawEventArtifact(), unexpected: true };
    expect(() => liveMatchRawEventArtifactSchema.parse(withExtra)).toThrow();
  });

  it('refuses a missing or non-numeric schema version', () => {
    expect(describeLiveMatchRawEventVersionProblem(undefined)).toMatch(/does not declare/);
    expect(describeLiveMatchRawEventVersionProblem('1')).toMatch(/does not declare/);
  });

  it('refuses a newer schema version with a readable message', () => {
    const problem = describeLiveMatchRawEventVersionProblem(
      LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION + 1,
    );
    expect(problem).toMatch(/newer build/);
  });

  it('refuses schema version 0 as unreadable, below the version floor', () => {
    // The raw-event schema has never had a version below 1, so there is no
    // real "older build" to construct here (unlike the envelope, which has
    // shipped versions 1 and 2) — this exercises the same "does not declare
    // a readable version" branch as `undefined`, not a distinct older-build path.
    const problem = describeLiveMatchRawEventVersionProblem(0);
    expect(problem).toMatch(/does not declare/);
  });

  it('accepts the current schema version', () => {
    expect(describeLiveMatchRawEventVersionProblem(LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION)).toBeNull();
  });
});

describe('parseLiveMatchRawEventArtifact', () => {
  it('throws the readable refusal before the strict schema runs', () => {
    const artifact = {
      ...validRawEventArtifact(),
      schemaVersion: LIVE_MATCH_RAW_EVENT_SCHEMA_VERSION + 1,
    };
    expect(() => parseLiveMatchRawEventArtifact(artifact)).toThrow(/newer build/);
  });

  it('parses a valid artifact', () => {
    expect(parseLiveMatchRawEventArtifact(validRawEventArtifact())).toEqual(
      validRawEventArtifact(),
    );
  });
});

describe('liveMatchReplayArtifactSchema', () => {
  it('round trips a valid artifact', () => {
    const artifact = validReplayArtifact();
    expect(liveMatchReplayArtifactSchema.parse(artifact)).toEqual(artifact);
  });

  it('refuses an unknown field', () => {
    const withExtra = { ...validReplayArtifact(), unexpected: true };
    expect(() => liveMatchReplayArtifactSchema.parse(withExtra)).toThrow();
  });

  it('refuses a missing or non-numeric schema version', () => {
    expect(describeLiveMatchReplayVersionProblem(undefined)).toMatch(/does not declare/);
    expect(describeLiveMatchReplayVersionProblem('1')).toMatch(/does not declare/);
  });

  it('refuses a newer schema version with a readable message', () => {
    const problem = describeLiveMatchReplayVersionProblem(LIVE_MATCH_REPLAY_SCHEMA_VERSION + 1);
    expect(problem).toMatch(/newer build/);
  });

  it('accepts the current schema version', () => {
    expect(describeLiveMatchReplayVersionProblem(LIVE_MATCH_REPLAY_SCHEMA_VERSION)).toBeNull();
  });
});

describe('parseLiveMatchReplayArtifact', () => {
  it('throws the readable refusal before the strict schema runs', () => {
    const artifact = {
      ...validReplayArtifact(),
      schemaVersion: LIVE_MATCH_REPLAY_SCHEMA_VERSION + 1,
    };
    expect(() => parseLiveMatchReplayArtifact(artifact)).toThrow(/newer build/);
  });

  it('parses a valid artifact', () => {
    expect(parseLiveMatchReplayArtifact(validReplayArtifact())).toEqual(validReplayArtifact());
  });
});

describe('liveMatchRetentionConfigSchema', () => {
  it('defaults both dials to false', () => {
    expect(liveMatchRetentionConfigSchema.parse({})).toEqual({ rawEvent: false, replay: false });
  });

  it('round trips an explicit configuration', () => {
    const config = { rawEvent: true, replay: true };
    expect(liveMatchRetentionConfigSchema.parse(config)).toEqual(config);
  });

  it('refuses an unknown field', () => {
    expect(() =>
      liveMatchRetentionConfigSchema.parse({ rawEvent: true, unexpected: true }),
    ).toThrow();
  });
});

describe('decideLiveMatchRetention', () => {
  it('names exactly server_failure and abandoned_unrecordable as forced origins', () => {
    expect(LIVE_MATCH_FORCED_RAW_EVENT_ORIGINS).toEqual([
      'server_failure',
      'abandoned_unrecordable',
    ]);
  });

  it('follows the configured policy for a normal origin', () => {
    const origin: LiveMatchTerminationOrigin = 'rules_victory';
    expect(decideLiveMatchRetention(origin, { rawEvent: false, replay: false })).toEqual({
      rawEvent: false,
      replay: false,
    });
    expect(decideLiveMatchRetention(origin, { rawEvent: true, replay: true })).toEqual({
      rawEvent: true,
      replay: true,
    });
  });

  it.each(LIVE_MATCH_FORCED_RAW_EVENT_ORIGINS)(
    'forces rawEvent retention for %s even when the policy declines it',
    (origin) => {
      expect(decideLiveMatchRetention(origin, { rawEvent: false, replay: false })).toEqual({
        rawEvent: true,
        replay: false,
      });
    },
  );

  it('never forces replay retention, even for a forced-rawEvent origin', () => {
    for (const origin of LIVE_MATCH_FORCED_RAW_EVENT_ORIGINS) {
      expect(decideLiveMatchRetention(origin, { rawEvent: false, replay: false }).replay).toBe(
        false,
      );
    }
  });

  it('reports every non-forced origin as not forced', () => {
    for (const origin of LIVE_MATCH_TERMINATION_ORIGINS) {
      const expected = LIVE_MATCH_FORCED_RAW_EVENT_ORIGINS.includes(origin);
      expect(isForcedLiveMatchRawEventOrigin(origin)).toBe(expected);
    }
  });
});
