import { describe, expect, it } from 'vitest';

import {
  MATCH_EXPLORER_ARTIFACT_STATUSES,
  MATCH_EXPLORER_END_REASONS,
  MATCH_EXPLORER_MAX_DECK_ENTRIES,
  MATCH_EXPLORER_MAX_RECENT_EVENTS,
  MATCH_EXPLORER_PARTICIPANT_KINDS,
  MATCH_EXPLORER_PHASES,
  matchExplorerArtifactAvailabilitySchema,
  matchExplorerDeckSnapshotSchema,
  matchExplorerDecisionDiagnosticsSchema,
  matchExplorerEventTimelineSchema,
  matchExplorerFlattenedEventSchema,
  matchExplorerListSchema,
  matchExplorerOutcomeSchema,
  matchExplorerParticipantIdSchema,
  matchExplorerRowSchema,
  matchExplorerSeatSchema,
  matchExplorerSeatSummarySchema,
  matchExplorerViewSchema,
} from './match-explorer.js';
import {
  matchExplorerEventTimelineRequestSchema,
  matchExplorerListRequestSchema,
  matchExplorerViewRequestSchema,
} from './requests.js';

const VALID_MATCH_ID = 'match_a';
const VALID_DECK_HASH = '0123456789abcdef';
const VALID_EVIDENCE = {
  realm: 'live_match' as const,
  source: 'human_ai' as const,
  contentVersion: 5,
  rulesVersion: '1.0.0',
};

const VALID_DECK_SNAPSHOT = {
  commanderId: 'chief_containment_scholar',
  cards: [
    {
      cardId: 'arcane_snare',
      quantity: 2,
      cardRef: { kind: 'card' as const, cardId: 'arcane_snare' },
    },
  ],
  deckHash: VALID_DECK_HASH,
};

const VALID_DECK_REF = { kind: 'deck' as const, deckHash: VALID_DECK_HASH };

const VALID_SEAT_SUMMARY = {
  seatIndex: 0 as const,
  playerId: 'player_1',
  kind: 'human' as const,
  commanderId: 'chief_containment_scholar',
  deckHash: VALID_DECK_HASH,
  deckRef: VALID_DECK_REF,
};

const OTHER_SEAT_SUMMARY = { ...VALID_SEAT_SUMMARY, seatIndex: 1 as const, playerId: 'player_2' };

const VALID_SEAT = {
  seatIndex: 0 as const,
  playerId: 'player_1',
  kind: 'human' as const,
  deck: VALID_DECK_SNAPSHOT,
  deckRef: VALID_DECK_REF,
};

const OTHER_SEAT = { ...VALID_SEAT, seatIndex: 1 as const, playerId: 'player_2' };

const VALID_OUTCOME = {
  outcome: 'win' as const,
  winnerId: 'player_1',
  loserIds: ['player_2'],
  reason: 'health_depleted' as const,
  finalTurn: 6,
  finalSequence: 120,
  diagnostics: null,
};

const VALID_ARTIFACTS = {
  rawEvent: 'present' as const,
  replay: 'not_retained' as const,
  preActionCapture: 'not_applicable' as const,
};

const VALID_FLATTENED_EVENT = {
  sequence: 3,
  type: 'unit_deployed',
  summary: 'player_1 deployed arcane_snare.',
};

const VALID_DECISION_DIAGNOSTICS = {
  playerId: 'player_1',
  origin: 'concede_action' as const,
  turn: 4,
  phase: 'main_1' as const,
  activePlayerId: 'player_1',
  sequence: 42,
  inCombat: false,
  reactionWindowOpen: false,
  pendingChoiceOpen: false,
  pendingChoiceType: null,
  recentEvents: [VALID_FLATTENED_EVENT],
};

describe('restated literal values', () => {
  it('pins the participant kinds, phases, end reasons and artifact statuses restated elsewhere', () => {
    expect([...MATCH_EXPLORER_PARTICIPANT_KINDS]).toEqual(['human', 'bot']);
    expect(MATCH_EXPLORER_PHASES).toHaveLength(12);
    expect([...MATCH_EXPLORER_END_REASONS]).toEqual([
      'health_depleted',
      'empty_deck',
      'concede',
      'timeout',
      'simultaneous_loss',
      'engine_error',
    ]);
    expect([...MATCH_EXPLORER_ARTIFACT_STATUSES]).toEqual([
      'present',
      'not_retained',
      'not_applicable',
    ]);
  });
});

describe('matchExplorerParticipantIdSchema', () => {
  it('accepts a seat-derived id and refuses a display name', () => {
    expect(matchExplorerParticipantIdSchema.safeParse('player_1').success).toBe(true);
    expect(matchExplorerParticipantIdSchema.safeParse('player_5').success).toBe(false);
    expect(matchExplorerParticipantIdSchema.safeParse('Tector').success).toBe(false);
  });
});

describe('matchExplorerOutcomeSchema', () => {
  it('accepts a win and a draw with no winner', () => {
    expect(matchExplorerOutcomeSchema.safeParse(VALID_OUTCOME).success).toBe(true);
    expect(
      matchExplorerOutcomeSchema.safeParse({
        ...VALID_OUTCOME,
        outcome: 'draw',
        winnerId: null,
        loserIds: [],
      }).success,
    ).toBe(true);
  });

  it('refuses more than two losers', () => {
    expect(
      matchExplorerOutcomeSchema.safeParse({
        ...VALID_OUTCOME,
        loserIds: ['player_2', 'player_3', 'player_4'],
      }).success,
    ).toBe(false);
  });
});

describe('matchExplorerDeckSnapshotSchema', () => {
  it('accepts a well-formed snapshot and refuses more entries than the bound allows', () => {
    expect(matchExplorerDeckSnapshotSchema.safeParse(VALID_DECK_SNAPSHOT).success).toBe(true);
    const manyCards = Array.from({ length: MATCH_EXPLORER_MAX_DECK_ENTRIES + 1 }, (_, index) => ({
      cardId: `card_${String(index)}`,
      quantity: 1,
    }));
    expect(
      matchExplorerDeckSnapshotSchema.safeParse({ ...VALID_DECK_SNAPSHOT, cards: manyCards })
        .success,
    ).toBe(false);
  });

  it('refuses an empty card list', () => {
    expect(
      matchExplorerDeckSnapshotSchema.safeParse({ ...VALID_DECK_SNAPSHOT, cards: [] }).success,
    ).toBe(false);
  });
});

describe('matchExplorerSeatSummarySchema / matchExplorerSeatSchema', () => {
  it('accept well-formed entries', () => {
    expect(matchExplorerSeatSummarySchema.safeParse(VALID_SEAT_SUMMARY).success).toBe(true);
    expect(matchExplorerSeatSchema.safeParse(VALID_SEAT).success).toBe(true);
  });

  it('refuses a seat index outside the two-player boundary', () => {
    expect(
      matchExplorerSeatSummarySchema.safeParse({ ...VALID_SEAT_SUMMARY, seatIndex: 2 }).success,
    ).toBe(false);
  });
});

describe('matchExplorerRowSchema / matchExplorerListSchema', () => {
  const VALID_ROW = {
    matchId: VALID_MATCH_ID,
    terminationOrigin: 'rules_victory' as const,
    actionCount: 40,
    seats: [VALID_SEAT_SUMMARY, OTHER_SEAT_SUMMARY] as const,
    outcome: VALID_OUTCOME,
    observedIn: VALID_EVIDENCE,
  };

  it('accepts a well-formed row and a null-outcome row (still in progress)', () => {
    expect(matchExplorerRowSchema.safeParse(VALID_ROW).success).toBe(true);
    expect(matchExplorerRowSchema.safeParse({ ...VALID_ROW, outcome: null }).success).toBe(true);
  });

  it('pages rows the same way every other explorer list does', () => {
    const page = {
      items: [VALID_ROW],
      page: { returned: 1, limit: 50, nextCursor: null, total: 1 },
    };
    expect(matchExplorerListSchema.safeParse(page).success).toBe(true);
    expect(
      matchExplorerListSchema.safeParse({
        items: [VALID_ROW, VALID_ROW],
        page: { returned: 1, limit: 50, nextCursor: null, total: 2 },
      }).success,
    ).toBe(false);
  });
});

describe('matchExplorerArtifactAvailabilitySchema', () => {
  it('accepts every artifact status, including not_applicable', () => {
    expect(matchExplorerArtifactAvailabilitySchema.safeParse(VALID_ARTIFACTS).success).toBe(true);
  });

  it('refuses an unknown artifact status', () => {
    expect(
      matchExplorerArtifactAvailabilitySchema.safeParse({ ...VALID_ARTIFACTS, rawEvent: 'stale' })
        .success,
    ).toBe(false);
  });
});

describe('matchExplorerFlattenedEventSchema', () => {
  it('accepts a well-formed event and refuses a summary past the bound', () => {
    expect(matchExplorerFlattenedEventSchema.safeParse(VALID_FLATTENED_EVENT).success).toBe(true);
    expect(
      matchExplorerFlattenedEventSchema.safeParse({
        ...VALID_FLATTENED_EVENT,
        summary: 'x'.repeat(201),
      }).success,
    ).toBe(false);
  });
});

describe('matchExplorerDecisionDiagnosticsSchema', () => {
  it('accepts a well-formed capture and refuses more recent events than the bound allows', () => {
    expect(
      matchExplorerDecisionDiagnosticsSchema.safeParse(VALID_DECISION_DIAGNOSTICS).success,
    ).toBe(true);
    const manyEvents = Array.from(
      { length: MATCH_EXPLORER_MAX_RECENT_EVENTS + 1 },
      () => VALID_FLATTENED_EVENT,
    );
    expect(
      matchExplorerDecisionDiagnosticsSchema.safeParse({
        ...VALID_DECISION_DIAGNOSTICS,
        recentEvents: manyEvents,
      }).success,
    ).toBe(false);
  });

  it('carries no board, Health or resource state — structural fields only', () => {
    const parsed = matchExplorerDecisionDiagnosticsSchema.parse(VALID_DECISION_DIAGNOSTICS);
    expect(Object.keys(parsed)).toEqual([
      'playerId',
      'origin',
      'turn',
      'phase',
      'activePlayerId',
      'sequence',
      'inCombat',
      'reactionWindowOpen',
      'pendingChoiceOpen',
      'pendingChoiceType',
      'recentEvents',
    ]);
  });
});

describe('matchExplorerViewSchema', () => {
  const VALID_VIEW = {
    matchId: VALID_MATCH_ID,
    terminationOrigin: 'concede_action' as const,
    actionCount: 40,
    seats: [VALID_SEAT, OTHER_SEAT] as const,
    outcome: VALID_OUTCOME,
    artifacts: VALID_ARTIFACTS,
    decisionDiagnostics: VALID_DECISION_DIAGNOSTICS,
    observedIn: VALID_EVIDENCE,
  };

  it('accepts a full view, and a view with no diagnostics (capture not present)', () => {
    expect(matchExplorerViewSchema.safeParse(VALID_VIEW).success).toBe(true);
    expect(
      matchExplorerViewSchema.safeParse({ ...VALID_VIEW, decisionDiagnostics: null }).success,
    ).toBe(true);
  });

  it('refuses an extra field', () => {
    expect(matchExplorerViewSchema.safeParse({ ...VALID_VIEW, extra: true }).success).toBe(false);
  });
});

describe('matchExplorerEventTimelineSchema', () => {
  const VALID_PAGE = {
    items: [VALID_FLATTENED_EVENT],
    page: { returned: 1, limit: 50, nextCursor: null, total: 1 },
  };

  it('accepts a present status carrying a page, and a not_retained status carrying none', () => {
    expect(
      matchExplorerEventTimelineSchema.safeParse({ status: 'present', page: VALID_PAGE }).success,
    ).toBe(true);
    expect(
      matchExplorerEventTimelineSchema.safeParse({ status: 'not_retained', page: null }).success,
    ).toBe(true);
  });

  it('refuses a present status with no page, and a not_retained status carrying one', () => {
    expect(
      matchExplorerEventTimelineSchema.safeParse({ status: 'present', page: null }).success,
    ).toBe(false);
    expect(
      matchExplorerEventTimelineSchema.safeParse({ status: 'not_retained', page: VALID_PAGE })
        .success,
    ).toBe(false);
  });
});

describe('matchExplorerListRequestSchema', () => {
  it('defaults filter and page to their own empty forms', () => {
    expect(matchExplorerListRequestSchema.parse({})).toEqual({
      filter: {
        contentVersions: [],
        sources: [],
        commanderIds: [],
        deckHashes: [],
        terminations: [],
      },
      page: { limit: 50, cursor: null },
    });
  });
});

describe('matchExplorerViewRequestSchema', () => {
  it('accepts a matchId and refuses an empty one', () => {
    expect(matchExplorerViewRequestSchema.safeParse({ matchId: VALID_MATCH_ID }).success).toBe(
      true,
    );
    expect(matchExplorerViewRequestSchema.safeParse({ matchId: '' }).success).toBe(false);
  });
});

describe('matchExplorerEventTimelineRequestSchema', () => {
  it('defaults page and accepts an explicit cursor', () => {
    expect(matchExplorerEventTimelineRequestSchema.parse({ matchId: VALID_MATCH_ID })).toEqual({
      matchId: VALID_MATCH_ID,
      page: { limit: 50, cursor: null },
    });
  });
});
