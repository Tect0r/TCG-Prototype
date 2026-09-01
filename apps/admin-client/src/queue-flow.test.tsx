import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { JOB_STATUSES } from '@tcg/admin-contracts';

import { JOB_STATUS_WORDING, ORDER_IS_NOT_STATE } from './lib/queue-view.js';
import { renderAdmin, stubLayout } from './test/harness.js';
import { fakeService, type FakeService } from './test/fake-service.js';

/**
 * The Queue screen, driven the way a person drives it.
 *
 * The whole application rather than the component, for the reason M08.7 and
 * M08.8 give: what this tranche promises — *ordered batch editing before start,
 * keyboard-reachable*, *every lifecycle state visible and named*, *remaining
 * time shown only when it is honestly available*, *queue order does not imply
 * shared state* — are properties of the surface.
 *
 * The fake lab holds a real catalog and moves documents through the contract's
 * own transition table, so a state a test reaches here is a state the store
 * could reach. What it does not do is play a match or enforce the service's
 * policy; both have their own suites in `apps/admin-server`, and re-implementing
 * either here would be the client growing a second opinion about the lab.
 */

const main = () => screen.getByRole('main');

async function openQueue(seed?: (service: FakeService) => void) {
  stubLayout('wide');
  const service = fakeService();
  seed?.(service);
  const harness = renderAdmin({ transport: service.transport });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  await userEvent.click(screen.getByRole('button', { name: 'Queue' }));
  await screen.findByRole('heading', { level: 1, name: 'Queue' });
  return { ...harness, service };
}

/**
 * A batch that has already been started, with its jobs driven before the screen
 * ever reads it.
 *
 * Seeded inside the callback rather than after rendering, because a draft polls
 * nothing — deliberately, since nothing in one can change — so a batch released
 * behind the screen's back would not be noticed until something asked. Setting
 * the world up first is what an operator arriving at a lab that has been running
 * actually finds.
 */
async function openStarted(
  count: number,
  drive: (lab: FakeService['lab'], jobIds: string[]) => void,
) {
  let seeded = { batchId: '', jobIds: [] as string[] };
  const opened = await openQueue((service) => {
    seeded = service.lab.seedDraft('August sweep', count);
    service.lab.release(seeded.batchId);
    drive(service.lab, seeded.jobIds);
  });
  await within(main()).findByRole('heading', { level: 2, name: 'August sweep' });
  return { ...opened, ...seeded };
}

/** A draft of three, already selected, with its rows on screen. */
async function openDraft(count = 3) {
  let seeded = { batchId: '', jobIds: [] as string[] };
  const opened = await openQueue((service) => {
    seeded = service.lab.seedDraft('August sweep', count);
  });
  await within(main()).findByRole('heading', { level: 2, name: 'August sweep' });
  return { ...opened, ...seeded };
}

const rowLabels = (): string[] =>
  within(main())
    .getAllByRole('article')
    .map((row) => within(row).getByText(/^Stage /).textContent ?? '');

/* ---------------------------------------------------------------- empty */

describe('a lab with nothing in it', () => {
  it('says the catalog is empty rather than showing an empty table', async () => {
    await openQueue();
    expect(await within(main()).findByText(/holds no test batches yet/)).toBeInTheDocument();
  });

  it('reports a refused listing as a refusal, and offers to ask again', async () => {
    stubLayout('wide');
    const service = fakeService({ refuse: { listBatches: 'admin/rate_limited' } });
    renderAdmin({ transport: service.transport });
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    await userEvent.click(screen.getByRole('button', { name: 'Queue' }));

    const alert = await within(main()).findByRole('alert');
    expect(alert).toHaveTextContent('admin/rate_limited');
    // An empty answer and a refused one are different facts.
    expect(within(main()).queryByText(/holds no test batches yet/)).toBeNull();
  });
});

/* ------------------------------------------------------------- the draft */

describe('a draft, before anything has started', () => {
  it('says it is a draft and that its jobs are held', async () => {
    await openDraft();
    expect(main().textContent).toContain('Draft');
    expect(main().textContent).toContain('none of them will run until it is started');
    expect(main().textContent).toContain('Nothing in this batch has run');
  });

  it('offers move, duplicate and withdraw on every row, and no pause or resume', async () => {
    await openDraft();
    const row = within(main()).getAllByRole('article')[0] as HTMLElement;

    expect(within(row).getByRole('button', { name: 'Move down' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: 'Duplicate' })).toBeEnabled();
    expect(within(row).getByRole('button', { name: 'Withdraw' })).toBeEnabled();
    // A queued job has no pause and no resume in the lifecycle table.
    expect(within(row).queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Resume' })).toBeNull();
  });

  it('disables the move that would go off the end, rather than hiding it', async () => {
    await openDraft();
    const rows = within(main()).getAllByRole('article');
    expect(within(rows[0] as HTMLElement).getByRole('button', { name: 'Move up' })).toBeDisabled();
    expect(
      within(rows[2] as HTMLElement).getByRole('button', { name: 'Move down' }),
    ).toBeDisabled();
  });
});

/* --------------------------------------------------------- reordering */

describe('reordering with a keyboard alone', () => {
  it('moves a job down and shows the order the lab answered with', async () => {
    const user = userEvent.setup();
    await openDraft();
    expect(rowLabels()).toEqual(['Stage 1', 'Stage 2', 'Stage 3']);

    const first = within(main()).getAllByRole('article')[0] as HTMLElement;
    within(first).getByRole('button', { name: 'Move down' }).focus();
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(rowLabels()).toEqual(['Stage 2', 'Stage 1', 'Stage 3']);
    });
  });

  it('moves a job up with the space bar, because the control is an ordinary button', async () => {
    const user = userEvent.setup();
    await openDraft();

    const third = within(main()).getAllByRole('article')[2] as HTMLElement;
    within(third).getByRole('button', { name: 'Move up' }).focus();
    await user.keyboard(' ');

    await waitFor(() => {
      expect(rowLabels()).toEqual(['Stage 1', 'Stage 3', 'Stage 2']);
    });
  });

  it('sends the whole order rather than the move', async () => {
    // The concurrent-update contract, seen from the client end: a request that
    // said "swap two rows" would be describing the batch as it was when the
    // button was drawn.
    const { service } = await openDraft();
    const before = service.requests.length;

    const first = within(main()).getAllByRole('article')[0] as HTMLElement;
    await userEvent.click(within(first).getByRole('button', { name: 'Move down' }));

    const sent = service.requests
      .slice(before)
      .find((request) => request.path.endsWith('/reorder-batch'));
    expect(sent).toBeDefined();
    const payload = JSON.parse(sent?.body ?? '{}') as { payload: { jobIds: string[] } };
    expect(payload.payload.jobIds).toHaveLength(3);
  });

  it('reports a refused reorder in the lab’s own words and re-reads the batch', async () => {
    const { service } = await openDraft();
    service.configure({ refuse: { reorderBatch: 'admin/schema' } });

    const first = within(main()).getAllByRole('article')[0] as HTMLElement;
    await userEvent.click(within(first).getByRole('button', { name: 'Move down' }));

    const alert = await within(main()).findByRole('alert');
    expect(alert).toHaveTextContent('admin/schema');
    // The order on screen is the one the lab still holds, not the one that failed.
    expect(rowLabels()).toEqual(['Stage 1', 'Stage 2', 'Stage 3']);
  });

  it('offers no ordering control once the batch has been started', async () => {
    const { batchId, service } = await openDraft();
    service.lab.release(batchId);
    await userEvent.click(within(main()).getByRole('button', { name: 'Start this batch' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start it' }));

    await waitFor(() => {
      expect(within(main()).queryByRole('button', { name: 'Move up' })).toBeNull();
    });
    expect(within(main()).queryByRole('button', { name: 'Duplicate' })).toBeNull();
  });
});

/* -------------------------------------------------------- duplicating */

describe('duplicating a job', () => {
  it('adds a copy immediately after its source', async () => {
    await openDraft();

    const first = within(main()).getAllByRole('article')[0] as HTMLElement;
    await userEvent.click(within(first).getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => {
      expect(within(main()).getAllByRole('article')).toHaveLength(4);
    });
    expect(rowLabels()).toEqual(['Stage 1', 'Stage 1', 'Stage 2', 'Stage 3']);
  });

  it('shows that the copy has its own seed family, so it is not the same run twice', async () => {
    await openDraft();

    const first = within(main()).getAllByRole('article')[0] as HTMLElement;
    await userEvent.click(within(first).getByRole('button', { name: 'Duplicate' }));

    await waitFor(() => {
      expect(within(main()).getAllByRole('article')).toHaveLength(4);
    });
    const copy = within(main()).getAllByRole('article')[1] as HTMLElement;
    expect(copy.textContent).toContain('bench-r1-c2');
    expect(copy.textContent).toContain('seed|r1|c2');
  });
});

/* ---------------------------------------------------------- withdrawing */

describe('withdrawing a job before start', () => {
  it('asks first, and says what withdrawing means', async () => {
    await openDraft();

    const second = within(main()).getAllByRole('article')[1] as HTMLElement;
    await userEvent.click(within(second).getByRole('button', { name: 'Withdraw' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('never run');
    expect(dialog).toHaveTextContent('nothing is deleted');
    expect(within(dialog).getByRole('button', { name: 'Withdraw' })).toHaveFocus();
  });

  it('leaves the job alone when the confirmation is declined', async () => {
    await openDraft();

    const second = within(main()).getAllByRole('article')[1] as HTMLElement;
    await userEvent.click(within(second).getByRole('button', { name: 'Withdraw' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Leave it alone' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(main().textContent).not.toContain('Withdrawn before this batch was started');
  });

  it('marks it cancelled, keeps it listed, and says it will never run', async () => {
    await openDraft();

    const second = within(main()).getAllByRole('article')[1] as HTMLElement;
    await userEvent.click(within(second).getByRole('button', { name: 'Withdraw' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));

    await waitFor(() => {
      expect(main().textContent).toContain('Withdrawn before this batch was started');
    });
    // Still three rows: nothing in this lab deletes a record.
    expect(within(main()).getAllByRole('article')).toHaveLength(3);
    expect(main().textContent).toContain('Cancelled');
  });
});

/* ------------------------------------------------------- starting a batch */

describe('starting a batch', () => {
  it('asks first, and states the two consequences', async () => {
    await openDraft();
    await userEvent.click(within(main()).getByRole('button', { name: 'Start this batch' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('settles its order');
    expect(dialog).toHaveTextContent('no job can be added, duplicated, withdrawn or reordered');
  });

  it('starts nothing when the confirmation is declined', async () => {
    const { service } = await openDraft();
    await userEvent.click(within(main()).getByRole('button', { name: 'Start this batch' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Leave it alone' }));

    expect(service.requests.some((request) => request.path.endsWith('/start-batch'))).toBe(false);
  });

  it('releases the batch and stops offering to start it again', async () => {
    await openDraft();
    await userEvent.click(within(main()).getByRole('button', { name: 'Start this batch' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Start it' }));

    await waitFor(() => {
      expect(within(main()).queryByRole('button', { name: 'Start this batch' })).toBeNull();
    });
    expect(main().textContent).toContain('The order is settled');
  });
});

/* ------------------------------------------- scheduling a championship (M08.15) */

describe('scheduling a finalist championship', () => {
  it('offers nothing when the batch holds no completed Commander Search job', async () => {
    await openDraft();
    expect(within(main()).queryByRole('button', { name: 'Schedule championship' })).toBeNull();
  });

  it('offers the form once every Commander Search job in the batch has completed', async () => {
    const opened = await openQueue((service) => {
      const first = service.lab.seedResult({
        label: 'Search: goblin_warboss',
        status: 'completed',
        origin: { kind: 'preset', presetId: 'commander_search', stageId: 'search-goblin-warboss' },
        commanderIds: ['goblin_warboss'],
      });
      service.lab.seedResult({
        label: 'Search: grave_matriarch',
        status: 'completed',
        origin: { kind: 'preset', presetId: 'commander_search', stageId: 'search-grave-matriarch' },
        commanderIds: ['grave_matriarch'],
        batchId: first.batchId,
      });
    });
    await userEvent.click(within(main()).getByRole('button', { name: /Search: goblin_warboss/ }));

    expect(
      await within(main()).findByRole('heading', { name: 'Schedule the finalist championship' }),
    ).toBeVisible();
    expect(opened.service).toBeDefined();
  });

  it('does not offer the form while one Commander Search job is still running', async () => {
    await openQueue((service) => {
      const first = service.lab.seedResult({
        label: 'Search: goblin_warboss',
        status: 'completed',
        origin: { kind: 'preset', presetId: 'commander_search', stageId: 'search-goblin-warboss' },
      });
      service.lab.seedResult({
        label: 'Search: grave_matriarch',
        status: 'running',
        origin: { kind: 'preset', presetId: 'commander_search', stageId: 'search-grave-matriarch' },
        batchId: first.batchId,
      });
    });
    await userEvent.click(within(main()).getByRole('button', { name: /Search: goblin_warboss/ }));

    await within(main()).findByRole('heading', { level: 2, name: 'Search: goblin_warboss' });
    expect(
      within(main()).queryByRole('heading', { name: 'Schedule the finalist championship' }),
    ).toBeNull();
  });

  it('schedules a new draft batch, and selects it', async () => {
    await openQueue((service) => {
      const first = service.lab.seedResult({
        label: 'Search: goblin_warboss',
        status: 'completed',
        origin: { kind: 'preset', presetId: 'commander_search', stageId: 'search-goblin-warboss' },
        commanderIds: ['goblin_warboss'],
      });
      service.lab.seedResult({
        label: 'Search: grave_matriarch',
        status: 'completed',
        origin: { kind: 'preset', presetId: 'commander_search', stageId: 'search-grave-matriarch' },
        commanderIds: ['grave_matriarch'],
        batchId: first.batchId,
      });
    });
    await userEvent.click(within(main()).getByRole('button', { name: /Search: goblin_warboss/ }));
    await within(main()).findByRole('heading', { name: 'Schedule the finalist championship' });

    await userEvent.click(within(main()).getByRole('button', { name: 'Schedule championship' }));

    await within(main()).findByRole('heading', {
      level: 2,
      name: /Commander Search finalist championship/,
    });
    expect(within(main()).getByText('Frozen finalist championship')).toBeVisible();
    expect(within(main()).getAllByText('Draft').length).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------- lifecycle UI */

describe('watching work that has started', () => {
  it('offers pause and cancel on a running job, and resume on a paused one', async () => {
    const { jobIds, service } = await openStarted(1, (lab, ids) => {
      lab.drive(ids[0] as string, 'start');
    });

    expect(within(main()).getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(within(main()).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

    await userEvent.click(within(main()).getByRole('button', { name: 'Pause' }));
    // Pause needs no confirmation: everything it stops is recoverable.
    expect(screen.queryByRole('alertdialog')).toBeNull();

    service.lab.drive(jobIds[0] as string, 'pause_settled');
    await userEvent.click(within(main()).getByRole('button', { name: 'Read this batch again' }));
    await waitFor(() => {
      expect(within(main()).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    });
  });

  it('shows an interrupted job as resumable and says a restart caused it', async () => {
    await openStarted(1, (lab, ids) => {
      lab.drive(ids[0] as string, 'start');
      lab.drive(ids[0] as string, 'interrupt');
    });

    expect(main().textContent).toContain(JOB_STATUS_WORDING.interrupted.meaning);
    expect(within(main()).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(within(main()).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('offers retry on a failed job, and nothing at all on a completed one', async () => {
    await openStarted(2, (lab, ids) => {
      lab.drive(ids[0] as string, 'start');
      lab.drive(ids[0] as string, 'fail');
      lab.drive(ids[1] as string, 'start');
      lab.drive(ids[1] as string, 'complete');
    });

    expect(within(main()).getByRole('button', { name: 'Retry' })).toBeInTheDocument();

    const finished = within(main()).getAllByRole('article')[1] as HTMLElement;
    for (const verb of ['Pause', 'Resume', 'Cancel', 'Retry']) {
      expect(within(finished).queryByRole('button', { name: verb })).toBeNull();
    }
  });

  it('reports a refused action without pretending it worked', async () => {
    const { service } = await openStarted(1, (lab, ids) => {
      lab.drive(ids[0] as string, 'start');
    });

    service.configure({ refuse: { jobAction: 'admin/illegal_transition' } });
    await userEvent.click(within(main()).getByRole('button', { name: 'Pause' }));

    const alert = await within(main()).findByRole('alert');
    expect(alert).toHaveTextContent('admin/illegal_transition');
    // The row still says what the lab says it is.
    expect(main().textContent).toContain(JOB_STATUS_WORDING.running.label);
  });
});

/* ------------------------------------------------------------- progress */

describe('progress, elapsed time and what cannot be extrapolated', () => {
  it('shows the exact counts and the measured pace once there is enough of it', async () => {
    await openStarted(1, (lab, ids) => {
      lab.drive(ids[0] as string, 'start');
      lab.setProgress(ids[0] as string, {
        completedMatches: 20,
        scheduledMatches: 60,
        elapsedMs: 40_000,
      });
    });

    expect(main().textContent).toContain('20 of 60 matches committed.');
    expect(main().textContent).toContain('40s of measured run time');
    expect(main().textContent).toContain('1m 20s');
    expect(main().textContent).toContain('2s per match');
  });

  it('says why a remaining time is not available rather than leaving the cell blank', async () => {
    await openStarted(1, (lab, ids) => {
      lab.drive(ids[0] as string, 'start');
      lab.setProgress(ids[0] as string, {
        completedMatches: 4,
        scheduledMatches: 60,
        elapsedMs: 8_000,
      });
    });

    expect(main().textContent).toContain('Not available.');
    expect(main().textContent).toContain('too few for a rate that is not mostly noise');
  });

  it('never shows a remaining time for a job that has not started', async () => {
    await openDraft(1);
    expect(main().textContent).toContain('Not available.');
    expect(main().textContent).toContain('while a job is running');
  });
});

/* ------------------------------------------------------------- the poll */

describe('the poll', () => {
  it('re-reads a running job on its own, without a click', async () => {
    const { jobIds, service } = await openStarted(1, (lab, ids) => {
      lab.drive(ids[0] as string, 'start');
    });
    expect(main().textContent).toContain(JOB_STATUS_WORDING.running.label);

    service.lab.setProgress(jobIds[0] as string, {
      completedMatches: 30,
      scheduledMatches: 60,
      elapsedMs: 60_000,
    });

    await waitFor(
      () => {
        expect(main().textContent).toContain('30 of 60 matches committed.');
      },
      { timeout: 6_000 },
    );
  });

  it('asks nothing on its own for a draft, because nothing in one can change', async () => {
    const { service } = await openDraft();
    const before = service.requests.length;
    await act(async () => {
      await new Promise((settle) => setTimeout(settle, 300));
    });
    expect(service.requests.length).toBe(before);
  });
});

/* -------------------------------------------------------------- legend */

describe('the legend', () => {
  it('names every state a job can be in, whether or not one is in it', async () => {
    await openDraft();
    for (const status of JOB_STATUSES) {
      expect(main().textContent).toContain(JOB_STATUS_WORDING[status].meaning);
    }
  });

  it('says on the page that order carries nothing between jobs', async () => {
    await openQueue();
    expect(main().textContent).toContain(ORDER_IS_NOT_STATE);
  });
});
