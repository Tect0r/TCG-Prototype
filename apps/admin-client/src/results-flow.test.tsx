import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderAdmin, stubLayout } from './test/harness.js';
import {
  contentCatalogFixture,
  fakeService,
  resultIdentityFixture,
  resultSummaryFixture,
  type FakeService,
} from './test/fake-service.js';

/**
 * The Results screen, driven the way an operator drives it: filter, browse,
 * open one run, and read what it has to say about itself.
 *
 * The whole application, for the reason every other flow suite in this
 * directory gives: what M08.10 promises — a filterable, paginated listing,
 * provenance and evidence standing on every detail view, annotations stored
 * beside a run rather than inside it, and an honest report of a result this
 * build cannot read — are properties of the surface, not of one function.
 */

const main = () => screen.getByRole('main');

async function openResults(seed?: (service: FakeService) => void) {
  stubLayout('wide');
  const service = fakeService({ content: contentCatalogFixture() });
  seed?.(service);
  const harness = renderAdmin({ transport: service.transport });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  await userEvent.click(screen.getByRole('button', { name: 'Results' }));
  await screen.findByRole('heading', { level: 1, name: 'Results' });
  return { ...harness, service };
}

describe('browsing the catalog', () => {
  it('lists every job when nothing is filtered', async () => {
    await openResults((service) => {
      service.lab.seedResult({ label: 'Goblin Swarm run' });
      service.lab.seedResult({ label: 'Bastion Guardians run' });
    });

    expect(await within(main()).findByRole('button', { name: /Goblin Swarm run/ })).toBeVisible();
    expect(within(main()).getByRole('button', { name: /Bastion Guardians run/ })).toBeVisible();
  });

  it('says so, rather than showing an empty table, when nothing matches', async () => {
    await openResults();
    expect(await within(main()).findByText(/no job in this catalog/i)).toBeVisible();
  });

  it('narrows to a status once it is ticked and applied', async () => {
    await openResults((service) => {
      service.lab.seedResult({ label: 'Completed run', status: 'completed' });
      service.lab.seedResult({ label: 'Failed run', status: 'failed' });
    });
    await within(main()).findByRole('button', { name: /Completed run/ });

    await userEvent.click(within(main()).getByRole('checkbox', { name: 'Failed' }));
    await userEvent.click(within(main()).getByRole('button', { name: 'Show results' }));

    await waitFor(() => {
      expect(within(main()).queryByRole('button', { name: /Completed run/ })).toBeNull();
    });
    expect(within(main()).getByRole('button', { name: /Failed run/ })).toBeVisible();
  });

  it('narrows to a precon once it is ticked and applied', async () => {
    await openResults((service) => {
      service.lab.seedResult({ label: 'Goblin run', preconIds: ['precon_goblin_swarm'] });
      service.lab.seedResult({ label: 'Bastion run', preconIds: ['precon_bastion_guardians'] });
    });
    await within(main()).findByRole('button', { name: /Goblin run/ });

    await userEvent.click(within(main()).getByRole('checkbox', { name: 'Goblin Swarm' }));
    await userEvent.click(within(main()).getByRole('button', { name: 'Show results' }));

    await waitFor(() => {
      expect(within(main()).queryByRole('button', { name: /Bastion run/ })).toBeNull();
    });
    expect(within(main()).getByRole('button', { name: /Goblin run/ })).toBeVisible();
  });

  it('clears every filter and shows everything again', async () => {
    await openResults((service) => {
      service.lab.seedResult({ label: 'Completed run', status: 'completed' });
      service.lab.seedResult({ label: 'Failed run', status: 'failed' });
    });
    await within(main()).findByRole('button', { name: /Completed run/ });

    await userEvent.click(within(main()).getByRole('checkbox', { name: 'Failed' }));
    await userEvent.click(within(main()).getByRole('button', { name: 'Show results' }));
    await waitFor(() => {
      expect(within(main()).queryByRole('button', { name: /Completed run/ })).toBeNull();
    });

    await userEvent.click(within(main()).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => {
      expect(within(main()).getByRole('button', { name: /Completed run/ })).toBeVisible();
    });
    expect(within(main()).getByRole('button', { name: /Failed run/ })).toBeVisible();
  });

  it('offers a way to see more once the page is not the whole catalog', async () => {
    await openResults((service) => {
      for (let index = 0; index < 60; index += 1) {
        service.lab.seedResult({ label: `Run ${String(index)}` });
      }
    });

    expect(await within(main()).findByText(/60 jobs match/i)).toBeVisible();
    const more = within(main()).getByRole('button', { name: 'Show more' });
    await userEvent.click(more);

    await waitFor(() => {
      expect(within(main()).getByRole('button', { name: /Run 59/ })).toBeVisible();
    });
  });
});

describe('opening one run', () => {
  it('shows provenance, completion quality and evidence standing', async () => {
    const jobId = 'job_fake000001';
    await openResults((service) => {
      service.lab.seedResult({
        label: 'Precon Wave 1 benchmark',
        summary: resultSummaryFixture({ jobId }),
      });
    });

    await userEvent.click(
      await within(main()).findByRole('button', { name: /Precon Wave 1 benchmark/ }),
    );

    const detail = await within(main()).findByRole('heading', {
      level: 2,
      name: 'Precon Wave 1 benchmark',
    });
    const panel = detail.closest('section') as HTMLElement;

    expect(await within(panel).findByText('calibration')).toBeVisible();
    expect(within(panel).getByText(/matches usable/i)).toBeVisible();
    expect(within(panel).getByText(resultIdentityFixture().seed, { exact: false })).toBeVisible();
  });

  it('reports a run with no calibration standing honestly, rather than hiding it', async () => {
    await openResults((service) => {
      service.lab.seedResult({
        label: 'Old build run',
        summary: {
          refuse: 'admin/no_result',
          message: 'This run was written before the calibration standing existed.',
        },
      });
    });

    await userEvent.click(await within(main()).findByRole('button', { name: /Old build run/ }));

    expect(
      await within(main()).findByText(/written before the calibration standing existed/i),
    ).toBeVisible();
  });

  it('lists downloadable documents, present or not, and lets a present one be downloaded', async () => {
    const blobs: Blob[] = [];
    const createObjectURL = URL.createObjectURL;
    const revokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return 'blob:result-artifact';
    };
    URL.revokeObjectURL = () => {};

    try {
      await openResults((service) => {
        service.lab.seedResult({
          label: 'Downloadable run',
          artifacts: { report: '# A written report\n' },
        });
      });

      await userEvent.click(
        await within(main()).findByRole('button', { name: /Downloadable run/ }),
      );

      const download = await within(main()).findByRole('button', {
        name: /Download report/,
      });
      await userEvent.click(download);

      expect(blobs).toHaveLength(1);
      expect(await blobs[0]?.text()).toBe('# A written report\n');
      expect(within(main()).getByText('decks')).toBeVisible();
      expect(within(main()).getAllByText(/this run wrote none/i).length).toBeGreaterThan(0);
    } finally {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
    }
  });
});

describe('notes, tags and baseline', () => {
  it('are saved beside the run, and the confirmation says canonical output is untouched', async () => {
    await openResults((service) => {
      service.lab.seedResult({ label: 'Annotatable run' });
    });

    await userEvent.click(await within(main()).findByRole('button', { name: /Annotatable run/ }));
    const detail = await within(main()).findByRole('heading', {
      level: 2,
      name: 'Annotatable run',
    });
    const panel = detail.closest('section') as HTMLElement;

    expect(within(panel).getByText(/never changes the run's own canonical output/i)).toBeVisible();

    await userEvent.type(within(panel).getByLabelText(/tags, separated by commas/i), 'wave-1');
    await userEvent.click(within(panel).getByLabelText(/mark as baseline/i));
    await userEvent.click(within(panel).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(within(main()).getByText(/· baseline/)).toBeVisible();
    });
  });
});
