import { describe, expect, it } from 'vitest';

import {
  EMPTY_MATCH_EXPLORER_FILTER,
  matchExplorerArtifactStatusLabel,
  matchExplorerEndReasonLabel,
  matchExplorerFilterIsEmpty,
  matchExplorerParticipantKindLabel,
  matchExplorerPhaseLabel,
  matchExplorerSourceLabel,
  matchExplorerTerminationLabel,
  toMatchExplorerFilterInput,
  type MatchExplorerFilterState,
} from './match-explorer-view.js';

describe('label functions', () => {
  it('labels every live match source in words', () => {
    expect(matchExplorerSourceLabel('human_human')).toBe('Human vs human');
    expect(matchExplorerSourceLabel('human_ai')).toBe('Human vs AI');
    expect(matchExplorerSourceLabel('ai_ai')).toBe('AI vs AI');
  });

  it('labels every termination origin in words', () => {
    expect(matchExplorerTerminationLabel('concede_action')).toBe('Conceded (in-match action)');
    expect(matchExplorerTerminationLabel('concede_leave')).toBe('Conceded (left the match)');
    expect(matchExplorerTerminationLabel('disconnect_timeout')).toBe('Disconnect timeout');
    expect(matchExplorerTerminationLabel('rules_victory')).toBe('Rules victory');
    expect(matchExplorerTerminationLabel('server_failure')).toBe('Server failure');
    expect(matchExplorerTerminationLabel('abandoned_unrecordable')).toBe(
      'Abandoned (unrecordable)',
    );
  });

  it('labels both participant kinds in words', () => {
    expect(matchExplorerParticipantKindLabel('human')).toBe('Human');
    expect(matchExplorerParticipantKindLabel('bot')).toBe('Bot');
  });

  it('labels every match phase in words', () => {
    expect(matchExplorerPhaseLabel('setup')).toBe('Setup');
    expect(matchExplorerPhaseLabel('complete')).toBe('Complete');
  });

  it('labels every end reason in words', () => {
    expect(matchExplorerEndReasonLabel('health_depleted')).toBe('Health depleted');
    expect(matchExplorerEndReasonLabel('engine_error')).toBe('Engine error');
  });

  it('labels every artifact status in words', () => {
    expect(matchExplorerArtifactStatusLabel('present')).toBe('Present');
    expect(matchExplorerArtifactStatusLabel('not_retained')).toBe('Not retained');
    expect(matchExplorerArtifactStatusLabel('not_applicable')).toBe('Not applicable');
  });
});

describe('matchExplorerFilterIsEmpty', () => {
  it('is true for the empty filter', () => {
    expect(matchExplorerFilterIsEmpty(EMPTY_MATCH_EXPLORER_FILTER)).toBe(true);
  });

  it('is false once any field narrows', () => {
    expect(matchExplorerFilterIsEmpty({ ...EMPTY_MATCH_EXPLORER_FILTER, sources: ['ai_ai'] })).toBe(
      false,
    );
    expect(
      matchExplorerFilterIsEmpty({
        ...EMPTY_MATCH_EXPLORER_FILTER,
        deckHashes: '0123456789abcdef',
      }),
    ).toBe(false);
  });
});

describe('toMatchExplorerFilterInput', () => {
  it('converts the empty filter to the unfiltered query', () => {
    const result = toMatchExplorerFilterInput(EMPTY_MATCH_EXPLORER_FILTER);
    expect(result).toEqual({
      ok: true,
      value: {
        contentVersions: [],
        sources: [],
        commanderIds: [],
        deckHashes: [],
        terminations: [],
      },
    });
  });

  it('parses comma-separated content versions, trimming and deduplicating', () => {
    const state: MatchExplorerFilterState = {
      ...EMPTY_MATCH_EXPLORER_FILTER,
      contentVersions: ' 3, 4,3 ',
    };
    const result = toMatchExplorerFilterInput(state);
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ contentVersions: [3, 4] }),
    });
  });

  it('rejects a content version that is not a positive integer', () => {
    const result = toMatchExplorerFilterInput({
      ...EMPTY_MATCH_EXPLORER_FILTER,
      contentVersions: 'not-a-number',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a deck hash of the wrong shape', () => {
    const result = toMatchExplorerFilterInput({
      ...EMPTY_MATCH_EXPLORER_FILTER,
      deckHashes: 'not-a-hash',
    });
    expect(result.ok).toBe(false);
  });

  it('passes sources and terminations through unchanged', () => {
    const result = toMatchExplorerFilterInput({
      ...EMPTY_MATCH_EXPLORER_FILTER,
      sources: ['ai_ai', 'human_ai'],
      terminations: ['rules_victory'],
    });
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        sources: ['ai_ai', 'human_ai'],
        terminations: ['rules_victory'],
      }),
    });
  });
});
