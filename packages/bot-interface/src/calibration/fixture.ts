import { createRngState } from '@tcg/rules-engine';
import { agentClassSupports } from '../agent-class.js';
import { createPilot, PILOT_AGENT_CLASSES, PILOT_IDS, type PilotId } from '../registry.js';
import type { BotPolicy } from '../types.js';
import type { CalibrationFacet } from './facets.js';
import { CalibrationTable, type AskedDecision, type BotRng } from './table.js';

/**
 * A hand-authored tactical decision fixture (M05.6).
 *
 * The unit of calibration. A fixture puts a board in front of a pilot that a
 * person reading the deck would recognise, asks the pilot the one question that
 * board exists to ask, and says whether the answer was the **characteristic**
 * one — the play the deck is built to make.
 *
 * The load-bearing design decision is `knownGaps`. A fixture suite that only
 * contained decisions the pilots already make would measure nothing; one that
 * contained decisions they do not would simply be red. So a fixture records what
 * the pilot actually does either way, and `knownGaps` names the pilots that do
 * *not* make the characteristic decision together with why. The suite then
 * asserts the recorded behaviour in both directions: a gap that closes fails the
 * test just as loudly as a characteristic decision that regresses, because both
 * mean the written record has stopped being true. That is the difference between
 * a calibration instrument and a wish.
 */
export interface TacticalFixture {
  /** Stable, and prefixed with its precon so a failure names the deck. */
  readonly id: string;
  readonly preconId: string;
  readonly facet: CalibrationFacet;
  /**
   * The characteristic decision, in the language of the deck rather than of the
   * engine. It is the test name, so a failure reads as a sentence about play.
   */
  readonly claim: string;
  /** Starting Energy for both seats, when the fixture is about affordability. */
  readonly energy?: number;
  /**
   * Arranges the board, asks the pilot, and answers whether it decided
   * characteristically. Everything it needs — instance IDs, the table, the
   * pilot's generator — is in scope, so the assertion can be about the exact
   * card the fixture put down rather than about a count.
   */
  readonly play: (table: CalibrationTable, pilot: BotPolicy, rng: BotRng) => boolean;
  /**
   * Pilots that do not make this decision today, and why not.
   *
   * A note here is a finding, not an excuse: it names the part of the valuation
   * that cannot see the difference. Deleting the entry is what a fix looks like.
   */
  readonly knownGaps?: Readonly<Partial<Record<PilotId, string>>>;
}

/**
 * The pilots a tactical fixture is run against.
 *
 * A view of the agent class registry rather than a second list: the pilots whose
 * class can carry a claim about play quality are exactly the pilots it is
 * meaningful to ask whether a decision was characteristic. `random_legal` is
 * excluded because it is not trying — measuring it here would produce a number
 * that looks like a score and means a coin flip.
 */
export const CALIBRATED_PILOT_IDS: readonly PilotId[] = PILOT_IDS.filter((id) =>
  agentClassSupports(PILOT_AGENT_CLASSES[id], 'play_quality'),
);

export interface FixtureResult {
  readonly fixtureId: string;
  readonly preconId: string;
  readonly facet: CalibrationFacet;
  readonly pilotId: PilotId;
  /** What the pilot actually did. */
  readonly characteristic: boolean;
  /** What the fixture's written record says it does. */
  readonly expected: boolean;
  /** The two agreeing is the assertion; disagreement is a stale record. */
  readonly matchesRecord: boolean;
  /** Set when this pilot is a declared gap, so a report can print the reason. */
  readonly gapNote: string | null;
  readonly decisions: readonly AskedDecision[];
}

/**
 * The seed every pilot faces this fixture on.
 *
 * Derived from the fixture ID and nothing else, so "compare pilots on identical
 * seeds" is true by construction rather than by discipline: the board is fixed
 * by the fixture, the opponent is scripted, and the generator that breaks a tie
 * starts in the same state for every pilot. A difference between two pilots on a
 * fixture is therefore a difference in valuation and cannot be a difference in
 * luck.
 */
export function fixtureSeed(fixture: TacticalFixture): string {
  return `calibration:${fixture.id}`;
}

export function runFixture(fixture: TacticalFixture, pilotId: PilotId): FixtureResult {
  const pilot = createPilot({ id: pilotId });
  const table = CalibrationTable.open({
    preconId: fixture.preconId,
    ...(fixture.energy === undefined ? {} : { energy: fixture.energy }),
  });
  const rng: BotRng = { state: createRngState(fixtureSeed(fixture)) };

  const characteristic = fixture.play(table, pilot, rng);
  const gapNote = fixture.knownGaps?.[pilotId] ?? null;
  const expected = gapNote === null;

  return {
    fixtureId: fixture.id,
    preconId: fixture.preconId,
    facet: fixture.facet,
    pilotId,
    characteristic,
    expected,
    matchesRecord: characteristic === expected,
    gapNote,
    decisions: table.decisions(),
  };
}

/** Runs one fixture against every calibrated pilot, on the identical seed. */
export function runFixtureAcrossPilots(fixture: TacticalFixture): FixtureResult[] {
  return CALIBRATED_PILOT_IDS.map((pilotId) => runFixture(fixture, pilotId));
}
