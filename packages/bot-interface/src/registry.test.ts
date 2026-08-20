import { describe, expect, it } from 'vitest';
import { EASY_SELECTION } from '@tcg/bot-config';
import {
  createPilot,
  createStyledPilot,
  PILOT_BASE_WEIGHTS,
  PILOT_IDS,
  PILOT_VERSIONS,
  STYLED_PILOT_IDS,
  type PilotId,
} from './registry.js';

/**
 * The pilot registry's two tables, checked against the pilots they describe.
 *
 * `PILOT_VERSIONS` and `PILOT_BASE_WEIGHTS` are copies: each pilot already
 * carries its own version and its own weights, and the tables exist so a caller
 * that has only an ID can reach them. A copy that drifts is worse than no copy,
 * because a match record would then cite a version no pilot ever flew — so both
 * are read back off a freshly built pilot here rather than trusted.
 */

describe('the pilot registry describes the pilots it names', () => {
  it.each(PILOT_IDS)('gives "%s" the version the pilot itself reports', (id: PilotId) => {
    expect(createPilot({ id }).version).toBe(PILOT_VERSIONS[id]);
  });

  it.each(PILOT_IDS)('gives "%s" the weights the pilot itself was built with', (id: PilotId) => {
    const built = createPilot({ id });
    // `random_legal` does not score, so it carries no weight vector to compare;
    // its entry is `DEFAULT_WEIGHTS` so the table can stay total over `PilotId`.
    if (id === 'random_legal') {
      expect(built.config.weights).toBeUndefined();
      return;
    }
    expect(built.config.weights).toEqual(PILOT_BASE_WEIGHTS[id]);
  });

  it('is total over the IDs, both ways', () => {
    expect(Object.keys(PILOT_VERSIONS).sort()).toEqual([...PILOT_IDS].sort());
    expect(Object.keys(PILOT_BASE_WEIGHTS).sort()).toEqual([...PILOT_IDS].sort());
  });
});

describe('a styled pilot is the same pilot with one parameter set', () => {
  it.each(STYLED_PILOT_IDS)('reports "%s" and its published version', (pilotId: PilotId) => {
    // The id and the version identify the *scorer*, and a difficulty does not
    // change the scorer. Which difficulty was flown is recorded by the caller
    // that knows its name — the server's `BotSeatActivity` — rather than smuggled
    // into a version string here, where nothing could parse it back out.
    const easy = createStyledPilot({ pilotId, selection: EASY_SELECTION });
    expect(easy.id).toBe(pilotId);
    expect(easy.version).toBe(PILOT_VERSIONS[pilotId]);
    expect(easy.config.weights).toEqual(PILOT_BASE_WEIGHTS[pilotId]);
  });

  it('applies a weight override the same way the style factories do', () => {
    const overridden = createStyledPilot({
      pilotId: 'value',
      selection: { kind: 'best' },
      weights: { cardDraw: 9.5 },
    });
    expect(overridden.config.weights).toEqual({ ...PILOT_BASE_WEIGHTS.value, cardDraw: 9.5 });
  });

  it('excludes the pilot that is not trying', () => {
    expect(STYLED_PILOT_IDS).not.toContain('random_legal');
    expect(STYLED_PILOT_IDS.length).toBe(PILOT_IDS.length - 1);
  });
});
