import { describe, expect, it } from 'vitest';
import { serializeMatchState } from '../serialize.js';
import { runScriptedMatch } from './scripted-match.js';

/**
 * The acceptance-criteria harness: complete matches with no React, no network,
 * no database and no wall clock (CLAUDE.md §10).
 */
describe('scripted match harness', () => {
  const seeds = ['harness-1', 'harness-2', 'harness-3', 'harness-4'];

  it.each(seeds)('plays seed "%s" to a real conclusion', (seed) => {
    const outcome = runScriptedMatch({ seed });

    expect(outcome.stoppedEarly).toBe(false);
    expect(outcome.state.status).toBe('complete');
    expect(outcome.state.result).not.toBeNull();
    // A match that ends in an engine fault is a bug, not a result.
    expect(outcome.state.result?.reason).not.toBe('engine_error');
    expect(outcome.events.length).toBeGreaterThan(50);
    expect(outcome.state.log.at(-1)?.type).toBe('match_ended');
  });

  it('replays identically from the same seed', () => {
    const left = runScriptedMatch({ seed: 'replay' });
    const right = runScriptedMatch({ seed: 'replay' });

    expect(serializeMatchState(left.state)).toBe(serializeMatchState(right.state));
    expect(left.actions).toEqual(right.actions);
  });

  it('produces different matches from different seeds', () => {
    const left = runScriptedMatch({ seed: 'replay' });
    const right = runScriptedMatch({ seed: 'replay-other' });
    expect(serializeMatchState(left.state)).not.toBe(serializeMatchState(right.state));
  });

  it('numbers every event densely and in order', () => {
    const outcome = runScriptedMatch({ seed: 'sequence' });
    outcome.events.forEach((event, index) => {
      expect(event.sequence).toBe(index + 1);
    });
  });
});
