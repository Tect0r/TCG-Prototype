import type * as NodeOs from 'node:os';
import { constants as osConstants } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

const setPriorityMock = vi.fn();

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os');
  return { ...actual, setPriority: (...args: unknown[]) => setPriorityMock(...args) };
});

const { lowerSimulatorProcessPriority } = await import('./priority.js');

/**
 * OS process priority (M08.28A) — a shared machine's scheduler, not either
 * event loop, is what makes simulator work yield to live multiplayer work.
 */

describe('lowerSimulatorProcessPriority', () => {
  afterEach(() => {
    setPriorityMock.mockReset();
  });

  it('asks the OS to lower this process to the lowest priority level', () => {
    setPriorityMock.mockReturnValue(undefined);
    const outcome = lowerSimulatorProcessPriority();
    expect(setPriorityMock).toHaveBeenCalledTimes(1);
    expect(setPriorityMock).toHaveBeenCalledWith(osConstants.priority.PRIORITY_LOW);
    expect(outcome).toEqual({ applied: true, reason: null });
  });

  it('reports a failure instead of throwing, so startup is never blocked by it', () => {
    setPriorityMock.mockImplementation(() => {
      throw new Error('EPERM: operation not permitted');
    });
    const outcome = lowerSimulatorProcessPriority();
    expect(outcome).toEqual({ applied: false, reason: 'EPERM: operation not permitted' });
  });

  it('reports a non-Error throw by its string form', () => {
    setPriorityMock.mockImplementation(() => {
      throw 'not an Error instance';
    });
    const outcome = lowerSimulatorProcessPriority();
    expect(outcome).toEqual({ applied: false, reason: 'not an Error instance' });
  });
});
