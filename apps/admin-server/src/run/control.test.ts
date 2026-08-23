import { JOB_LIFECYCLE, JOB_STATUSES, legalJobActions } from '@tcg/admin-contracts';
import { describe, expect, it } from 'vitest';

import { JobStopControl, SETTLE_ACTIONS, settleActionFor } from './control.js';

/**
 * The switch an operator throws at a run in flight, and how such a run finishes
 * (M08.5).
 *
 * Two claims, and the second is the one that would rot: the settling actions are
 * a two-entry table, and a two-entry table stays right only while nobody adds a
 * third in-flight state. So it is checked against `JOB_LIFECYCLE` itself rather
 * than against a copy of what it says today.
 */

describe('the switch latches, and cancel wins', () => {
  it('carries on until it is asked to stop', () => {
    const control = new JobStopControl();
    expect(control.stopRequested()).toBeNull();
  });

  it('stays stopped once it has stopped', () => {
    // The simulator asks this once per match on the hot path of a run that may
    // play thousands. A switch that could go back off would mean a job in
    // `pausing` that quietly went on playing matches.
    const control = new JobStopControl();
    control.request('pause');
    expect(control.stopRequested()).toBe('pause');
    expect(control.stopRequested()).toBe('pause');
  });

  it('lets a cancel escalate a pause', () => {
    const control = new JobStopControl();
    control.request('pause');
    control.request('cancel');
    expect(control.stopRequested()).toBe('cancel');
  });

  it('does not let a pause de-escalate a cancel', () => {
    // Nothing is stronger than cancel that still lets the in-flight matches
    // finish, so there is nothing for a later request to say.
    const control = new JobStopControl();
    control.request('cancel');
    control.request('pause');
    expect(control.stopRequested()).toBe('cancel');
  });
});

describe('how a stopped run settles', () => {
  it('sends a pausing job to paused and a cancelling job to cancelled', () => {
    expect(settleActionFor('pausing')).toBe('pause_settled');
    expect(settleActionFor('cancelling')).toBe('cancel_settled');
  });

  it('has no settlement for a state that is not stopping', () => {
    for (const status of JOB_STATUSES) {
      if (status === 'pausing' || status === 'cancelling') continue;
      expect(`${status}: ${String(settleActionFor(status))}`).toBe(`${status}: null`);
    }
  });

  it('names exactly the states the lifecycle table settles out of', () => {
    // Derived rather than transcribed: a state whose only outgoing move is a
    // `*_settled` action is a state a stopped run has to be able to leave, and a
    // third one added to the table would arrive here as a failure rather than as
    // a job nothing can finish.
    const settling = JOB_STATUSES.filter((status) =>
      legalJobActions(status).some((action) => action.endsWith('_settled')),
    );
    expect(settling.sort()).toEqual(['cancelling', 'pausing']);
    expect(Object.keys(SETTLE_ACTIONS).sort()).toEqual(settling.sort());
  });

  it('names an action the table really offers from that state', () => {
    for (const [status, action] of Object.entries(SETTLE_ACTIONS)) {
      const offered = JOB_LIFECYCLE.transitions.filter(
        (transition) => transition.from === status && transition.action === action,
      );
      expect(`${status}/${String(action)}: ${String(offered.length)}`).toBe(
        `${status}/${String(action)}: 1`,
      );
    }
  });
});
