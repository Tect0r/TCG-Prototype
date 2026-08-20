import { describe, expect, it } from 'vitest';
import {
  BOT_STYLES,
  BOT_STYLE_REGISTRY,
  EASY_SELECTION,
  difficultySelection,
  type DifficultySelection,
} from '@tcg/bot-config';
import { DEFAULT_RULES_CONFIG, type Action, type RngState } from '@tcg/rules-engine';
import { createPilot, createStyledPilot, PILOT_BASE_WEIGHTS, type PilotId } from './registry.js';
import { botTestDatabase, driveMatch, type DriveOutcome } from './test-driver.js';
import type { BotDecision, BotDiagnostics, BotObservation, BotPolicy } from './types.js';

/**
 * Difficulty: how a bot picks among the candidates its style already scored
 * (M09.13).
 *
 * Difficulty is one parameter — the selection — and this file exists to make
 * that literal rather than aspirational. Every assertion below is of the form
 * "the same style, the same weights, the same seed, the same scored candidate
 * list, and only the selection differs".
 *
 * Six claims:
 *
 * 1. **Normal is the published heuristic, unchanged.** Per style, seed for seed,
 *    a whole match played by `createPilot` and one played through the new
 *    selection parameter at `best` are the same match, action for action.
 * 2. **Easy is legal.** It finishes matches without a fallback, an illegal
 *    action or a refused one — `driveMatch` throws on any of those.
 * 3. **Easy is bounded.** Every choice it makes is inside the band the registry
 *    publishes: never below half the spread of what it was offered, never
 *    outside the best three.
 * 4. **Easy is reproducible, and seeded.** The same seed replays exactly; a
 *    different one does not.
 * 5. **Easy differs from Normal** — and the claim is only that, not that every
 *    Easy choice is worse. Most of them are the same choice.
 * 6. **The axes stay independent.** Easy-aggressive still values what aggressive
 *    values, and a difficulty cannot be put on a pilot that is not trying.
 */

const database = botTestDatabase();
const config = DEFAULT_RULES_CONFIG;
const BEST: DifficultySelection = { kind: 'best' };

function styledPilotIdOf(style: (typeof BOT_STYLES)[number]): PilotId {
  return BOT_STYLE_REGISTRY[style].pilotId as PilotId;
}

/** A pilot that keeps the diagnostics of every decision it made. */
function recording(inner: BotPolicy, into: BotDiagnostics[]): BotPolicy {
  return {
    id: inner.id,
    version: inner.version,
    config: inner.config,
    decide(observation: BotObservation, rng: RngState): BotDecision {
      const decision = inner.decide(observation, rng);
      if (decision instanceof Promise) throw new Error('The built-in pilots are synchronous.');
      if (decision.diagnostics) into.push(decision.diagnostics);
      return decision;
    },
  };
}

/** Both seats on the same style and difficulty, so the match isolates one variable. */
async function matchWith(
  pilotId: PilotId,
  selection: DifficultySelection,
  seed: string,
  recorder?: BotDiagnostics[],
): Promise<DriveOutcome> {
  const build = (): BotPolicy => {
    const pilot = createStyledPilot({ pilotId, selection });
    return recorder ? recording(pilot, recorder) : pilot;
  };
  return driveMatch({ seed, pilots: [build(), build()], database, config });
}

/** Everything about a finished match that a difficulty could have changed. */
function shapeOf(outcome: DriveOutcome) {
  return {
    actions: outcome.actions.map((action: Action) => JSON.stringify(action)),
    sequence: outcome.state.sequence,
    turn: outcome.state.turn,
    result: outcome.state.result,
    stoppedEarly: outcome.stoppedEarly,
    failures: outcome.failures,
  };
}

/* ------------------------------------------------------- 1. Normal is unchanged */

describe('Normal is the published heuristic, seed for seed', () => {
  it.each(BOT_STYLES)('plays %s exactly as it always did', async (style) => {
    const pilotId = styledPilotIdOf(style);
    const seed = `normal-equivalence:${style}`;

    // The path that shipped, untouched by this tranche...
    const published = await driveMatch({
      seed,
      pilots: [createPilot({ id: pilotId }), createPilot({ id: pilotId })],
      database,
      config,
    });
    // ...and the same style reached through the new parameter at `best`.
    const throughSelection = await matchWith(pilotId, BEST, seed);

    expect(published.stoppedEarly).toBe(false);
    expect(shapeOf(throughSelection)).toEqual(shapeOf(published));
    // Not a claim about a short game: a whole match's worth of decisions agreed.
    expect(published.actions.length).toBeGreaterThan(20);
  });

  it('is what the registry says Normal selects', () => {
    // The equivalence above is only worth anything if `normal` is actually
    // wired to `best`. This is the join between the two.
    expect(difficultySelection('normal')).toEqual(BEST);
  });

  it('defaults to `best`, so a caller that names no selection gets the old one', () => {
    const defaulted = createPilot({ id: 'value' });
    expect(defaulted.config.selection).toEqual(BEST);
  });
});

/* ------------------------------------------------------------- 2 & 3. Easy */

describe('Easy is a bounded, legal degradation', () => {
  it.each(BOT_STYLES)('finishes a whole %s match without a single failure', async (style) => {
    // `driveMatch` throws if the engine ever rejects a returned action, so
    // "finished" already means "every decision was legal".
    const outcome = await matchWith(styledPilotIdOf(style), EASY_SELECTION, `easy-legal:${style}`);
    expect(outcome.stoppedEarly).toBe(false);
    expect(outcome.failures).toEqual([]);
    expect(outcome.state.status).toBe('complete');
  });

  it('never chooses below the published bound, on any board of a real match', async () => {
    const seen: BotDiagnostics[] = [];
    const outcome = await matchWith('value', EASY_SELECTION, 'easy-bounded', seen);
    expect(outcome.stoppedEarly).toBe(false);
    expect(seen.length).toBeGreaterThan(20);

    if (EASY_SELECTION.kind !== 'bounded_error') throw new Error('Easy is not a bounded error.');
    let everBelowBest = 0;
    for (const diagnostics of seen) {
      const finite = diagnostics.scores.filter((entry) => Number.isFinite(entry.score));
      const chosen = diagnostics.scores.find((entry) => entry.key === diagnostics.chosenKey);
      expect(chosen).toBeDefined();
      const score = chosen?.score ?? -Infinity;
      // Never a concession, never anything else priced as unplayable.
      expect(Number.isFinite(score)).toBe(true);

      const best = Math.max(...finite.map((entry) => entry.score));
      const worst = Math.min(...finite.map((entry) => entry.score));
      // The bound the registry publishes, checked against the pilot's own record
      // of what it was offered rather than against a re-derivation of it.
      expect(score).toBeGreaterThanOrEqual(best - EASY_SELECTION.errorBudget * (best - worst));

      const rank = finite.filter((entry) => entry.score > score).length;
      expect(rank).toBeLessThan(EASY_SELECTION.maxBand);
      if (score < best) everBelowBest += 1;
    }
    // And it really did take a worse option sometimes: a bound nothing ever
    // reached would make every assertion above vacuous.
    expect(everBelowBest).toBeGreaterThan(0);
  });

  it('never concedes and never times out', async () => {
    const pilot = createStyledPilot({ pilotId: 'value', selection: EASY_SELECTION });
    // Structural: conceding is not even enumerated as a candidate, so there is
    // nothing for a band to accidentally include.
    expect(pilot.config.mayConcede).toBe(false);

    const outcome = await matchWith('aggressive', EASY_SELECTION, 'easy-never-concedes');
    for (const action of outcome.actions) {
      expect(action.type).not.toBe('concede');
      expect(action.type).not.toBe('server_timeout');
    }
  });
});

/* ------------------------------------------------------- 4. reproducible */

describe('Easy is reproducible and seeded', () => {
  it('replays exactly from the same seed, and differs from another', async () => {
    const once = await matchWith('value', EASY_SELECTION, 'easy-replay');
    const again = await matchWith('value', EASY_SELECTION, 'easy-replay');
    const elsewhere = await matchWith('value', EASY_SELECTION, 'easy-replay-other');

    expect(shapeOf(again)).toEqual(shapeOf(once));
    // Bounded suboptimality is a *choice among* candidates, so a different
    // stream picks differently inside the same band. If this ever matched, Easy
    // would be a deterministic second heuristic rather than a difficulty.
    expect(shapeOf(elsewhere)).not.toEqual(shapeOf(once));
  });
});

/* --------------------------------------------------------- 5. Easy differs */

describe('Easy differs from Normal, and that is the whole claim', () => {
  it('plays a different match, without every choice being a worse one', async () => {
    const seen: BotDiagnostics[] = [];
    const easy = await matchWith('value', EASY_SELECTION, 'easy-vs-normal', seen);
    const normal = await matchWith('value', BEST, 'easy-vs-normal');

    expect(easy.stoppedEarly).toBe(false);
    expect(normal.stoppedEarly).toBe(false);
    expect(shapeOf(easy)).not.toEqual(shapeOf(normal));

    // The honest half. Most Easy decisions are the decision Normal would have
    // made — on most boards the best candidate is the only one in the band —
    // and a claim that Easy always plays worse would be false.
    const bestChoices = seen.filter((diagnostics) => {
      const finite = diagnostics.scores.filter((entry) => Number.isFinite(entry.score));
      const chosen = diagnostics.scores.find((entry) => entry.key === diagnostics.chosenKey);
      return chosen?.score === Math.max(...finite.map((entry) => entry.score));
    });
    expect(bestChoices.length).toBeGreaterThan(0);
    expect(bestChoices.length).toBeLessThan(seen.length);
  });
});

/* ------------------------------------------------------- 6. axes stay apart */

describe('difficulty and style stay independent', () => {
  it('gives an Easy bot its style’s published weights, unmodified', () => {
    for (const style of BOT_STYLES) {
      const pilotId = styledPilotIdOf(style);
      const easy = createStyledPilot({ pilotId, selection: EASY_SELECTION });
      const normal = createStyledPilot({ pilotId, selection: BEST });
      // Difficulty touches the selection and nothing else: the two differ in
      // exactly one member of their exported configuration.
      expect(easy.config.weights).toEqual(PILOT_BASE_WEIGHTS[pilotId]);
      expect(easy.config.weights).toEqual(normal.config.weights);
      expect(easy.config.selection).toEqual(EASY_SELECTION);
      expect(easy.id).toBe(normal.id);
      expect(easy.version).toBe(normal.version);
    }
  });

  it('still plays two styles differently at the same difficulty', async () => {
    const aggressive = await matchWith('aggressive', EASY_SELECTION, 'easy-styles');
    const defensive = await matchWith('defensive', EASY_SELECTION, 'easy-styles');
    // If a difficulty had swallowed the styles, these would converge.
    expect(shapeOf(aggressive)).not.toEqual(shapeOf(defensive));
  });

  it('refuses to put a difficulty on the pilot that is not trying', () => {
    // A bounded degradation of a uniform sampler is not an easier player, it is
    // noise with a bound printed on it. `random_legal` is not a style either
    // (`style.ts`), so nothing in the lobby can reach this — it is the second
    // lock rather than the only one.
    expect(() => createStyledPilot({ pilotId: 'random_legal', selection: EASY_SELECTION })).toThrow(
      /no attempt to play well/,
    );
  });
});
