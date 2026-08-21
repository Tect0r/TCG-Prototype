import { describe, expect, it } from 'vitest';
import { applyAction, createRngState, DEFAULT_RULES_CONFIG, type Action } from '@tcg/rules-engine';
import { CalibrationTable } from './calibration/table.js';
import { createRandomLegalPilot } from './random-legal.js';
import { createTacticalPilot } from './registry.js';
import { decideSafely } from './run-pilot.js';
import { BASELINE_TACTICS } from './tactics.js';
import { checkActionOffered } from './validate.js';

/**
 * A `divide_damage` allocation is not a selection (M09.19).
 *
 * The engine has said so since M02.5: `submitChoice` exempts `divide_damage`
 * from the "the same option was selected twice" rule, because one entry per
 * point of damage *is* the answer and naming a target twice is how a chooser
 * gives it two. `legalActions` builds its own canonical answer the same way —
 * everything on the first legal target, repeated `minimum` times.
 *
 * Two things above the engine disagreed with it, and both are on the live bot
 * path:
 *
 * 1. **`checkActionOffered` refused the repeat.** The guard the runner uses to
 *    catch an illegal pilot answer *before* it reaches `applyAction` is a subset
 *    check against `LegalActions`, and a subset check that is narrower than the
 *    engine turns a pilot's considered answer into a recorded `illegal_action`
 *    and hands the decision to the substituted fallback. Every `divide:*`
 *    candidate the enumerator has ever produced was discarded this way.
 * 2. **The fallback could not answer it either.** `random_legal` drew *distinct*
 *    options, so its answer was short — and illegal — whenever there was more
 *    damage than there were targets. In the live runner that is
 *    `engine_rejected`, and the seat stops being asked for the rest of the
 *    match.
 *
 * Both cards that produce the choice — `divide_the_offering` and
 * `mass_offering` — are in the `precon_wave_1` pool, so this was reachable in a
 * real match rather than theoretical.
 */

const config = DEFAULT_RULES_CONFIG;

/**
 * A board where `mass_offering` has already eaten its fodder and the pending
 * choice is the allocation itself.
 *
 * `bodies` sets how much damage there is to divide, and `foeUnits` how many
 * targets there are besides the opposing player — so one call gives the case
 * where the total fits the target list and another gives the case where it does
 * not.
 */
function allocationTable(bodies: number, foeUnits: number): CalibrationTable {
  const table = CalibrationTable.open({ preconId: 'precon_grave_sacrifice', energy: 8 });
  for (let i = 0; i < bodies; i += 1) table.board('ashen_vermin');
  for (let i = 0; i < foeUnits; i += 1) table.board('veteran_guard', table.foe);
  const spell = table.give('mass_offering');
  table.toPhase('main_1');
  table.act({ type: 'play_card', playerId: table.self, instanceId: spell });

  // The sacrifice is scenery: the fixture pays the whole cost so that the
  // decision under test is the allocation and nothing before it.
  const sacrifice = table.state.pendingChoice;
  if (!sacrifice) throw new Error('mass_offering did not ask for a sacrifice.');
  table.act({
    type: 'submit_choice',
    playerId: table.self,
    choiceId: sacrifice.id,
    selectedIds: [...sacrifice.validEntityIds],
  });

  const allocation = table.state.pendingChoice;
  if (allocation?.type !== 'divide_damage') {
    throw new Error(`Expected a divide_damage choice, got ${allocation?.type ?? 'none'}.`);
  }
  return table;
}

describe('a pilot may put two points of damage on one target', () => {
  it('accepts the repeat the engine accepts, rather than calling it illegal', () => {
    const table = allocationTable(2, 2);
    const observation = table.observationFor(table.self);
    const choice = observation.legal.pendingChoice;
    expect(choice?.type).toBe('divide_damage');
    expect(choice?.minimum).toBe(2);

    const concentrated: Action = {
      type: 'submit_choice',
      playerId: table.self,
      choiceId: choice?.id as string,
      selectedIds: [choice?.validEntityIds[0] as string, choice?.validEntityIds[0] as string],
    };

    expect(checkActionOffered(observation.legal, concentrated, config).ok).toBe(true);
    // And the engine agrees, which is the whole standard this check is held to.
    expect(applyAction(table.state, concentrated, table.context).ok).toBe(true);
  });

  it('still refuses a repeat on any other kind of choice', () => {
    const table = CalibrationTable.open({ preconId: 'precon_grave_sacrifice', energy: 8 });
    table.board('ashen_vermin');
    table.board('ashen_vermin');
    const spell = table.give('mass_offering');
    table.toPhase('main_1');
    table.act({ type: 'play_card', playerId: table.self, instanceId: spell });

    const observation = table.observationFor(table.self);
    const choice = observation.legal.pendingChoice;
    expect(choice?.type).toBe('select_units');
    const twice: Action = {
      type: 'submit_choice',
      playerId: table.self,
      choiceId: choice?.id as string,
      selectedIds: [choice?.validEntityIds[0] as string, choice?.validEntityIds[0] as string],
    };

    const check = checkActionOffered(observation.legal, twice, config);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('the same option was selected twice');
  });

  it('is asked for and kept, rather than recorded as a pilot failure', async () => {
    const table = allocationTable(2, 2);
    const observation = table.observationFor(table.self);
    const pilot = createTacticalPilot({ pilotId: 'aggressive', tactics: BASELINE_TACTICS });

    const outcome = await decideSafely(pilot, observation, createRngState('divide'), {
      config,
      decisionBudget: 100,
    });

    expect(outcome.failure).toBeNull();
    expect(outcome.usedFallback).toBe(false);
    // The pilot's own considered answer, and the engine takes it.
    expect(outcome.decision.diagnostics?.chosenKey).toMatch(/^divide:/);
    expect(applyAction(table.state, outcome.decision.action, table.context).ok).toBe(true);
  });
});

describe('the substituted fallback can answer an allocation too', () => {
  it('spends every point when there are fewer targets than damage', () => {
    // Three bodies, and an opponent with an empty board: the only legal target
    // is the opposing player, so a distinct draw could only ever be one point
    // long.
    const table = allocationTable(3, 0);
    const observation = table.observationFor(table.self);
    const choice = observation.legal.pendingChoice;
    expect(choice?.minimum).toBe(3);
    expect(choice?.validEntityIds).toHaveLength(1);

    const answer = createRandomLegalPilot().decide(observation, createRngState('fallback'));
    if (answer instanceof Promise) throw new Error('The fallback must be synchronous.');

    expect(checkActionOffered(observation.legal, answer.action, config).ok).toBe(true);
    expect(applyAction(table.state, answer.action, table.context).ok).toBe(true);
  });

  it('draws the same allocation from the same stream, and a different one otherwise', () => {
    const table = allocationTable(3, 2);
    const observation = table.observationFor(table.self);
    const fallback = createRandomLegalPilot();

    const first = fallback.decide(observation, createRngState('stream-a'));
    const again = fallback.decide(observation, createRngState('stream-a'));
    const other = fallback.decide(observation, createRngState('stream-b'));
    if (first instanceof Promise || again instanceof Promise || other instanceof Promise) {
      throw new Error('The fallback must be synchronous.');
    }

    expect(again.action).toEqual(first.action);
    // Not an assertion that they differ — two streams may agree by chance on a
    // short allocation — but that the draw is a function of the stream alone.
    expect(other.rng).not.toEqual(first.rng);
  });
});
