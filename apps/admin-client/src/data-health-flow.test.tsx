import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderAdmin, stubLayout } from './test/harness.js';
import {
  catalogDataHealthReportFixture,
  contentCatalogFixture,
  fakeService,
  playerMetaDataHealthReportFixture,
} from './test/fake-service.js';

/**
 * The Data Health panel (M08.27D): two never-merged domains, a Catalog run
 * entered by Job ID and a Player Meta partition entered by
 * source/contentVersion/rulesVersion, each showing nine named categories as
 * measured or `Unavailable` with a reason, never a fabricated number.
 */

const main = () => screen.getByRole('main');
const VALID_JOB = 'job_00000000000000000000000000000000';

async function openDataHealth() {
  stubLayout('wide');
  const service = fakeService({ content: contentCatalogFixture() });
  const harness = renderAdmin({ transport: service.transport });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  await userEvent.click(screen.getByRole('button', { name: 'Results' }));
  await screen.findByRole('heading', { level: 1, name: 'Results' });
  await userEvent.click(within(main()).getByRole('button', { name: 'Data Health' }));
  return { ...harness, service };
}

describe('opening the Catalog run data health tab', () => {
  it('reads and shows every category for the entered job ID', async () => {
    const { service } = await openDataHealth();
    service.lab.seedCatalogDataHealth(
      VALID_JOB,
      catalogDataHealthReportFixture(VALID_JOB, {
        recoveredRecords: { count: 1, entries: [{ line: 42, reason: 'malformed json' }] },
        failures: { count: 2, byKind: { engine_error: 2 }, unavailableReason: null },
      }),
    );

    await userEvent.type(within(main()).getByLabelText('Job ID'), VALID_JOB);
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    expect(await within(main()).findByText('line 42')).toBeVisible();
    expect(within(main()).getByText('malformed json')).toBeVisible();
    expect(within(main()).getByText('2 (engine_error: 2)')).toBeVisible();
    expect(
      service.requests.some((request) => request.path.includes('catalog-data-health-view')),
    ).toBe(true);
  });

  it('refuses a malformed job ID without sending a request', async () => {
    const { service } = await openDataHealth();

    await userEvent.type(within(main()).getByLabelText('Job ID'), 'not-a-job-id');
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    expect(await within(main()).findByRole('alert')).toBeVisible();
    expect(
      service.requests.some((request) => request.path.includes('catalog-data-health-view')),
    ).toBe(false);
  });

  it('falls back to the empty default fixture for an unseeded job ID', async () => {
    await openDataHealth();

    await userEvent.type(within(main()).getByLabelText('Job ID'), VALID_JOB);
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    const failuresRow = (await within(main()).findByText('Failures')).closest('tr');
    expect(failuresRow).toHaveTextContent('0 (none by kind)');
  });

  it('shows the failure state when the read is refused, with a working retry', async () => {
    const { service } = await openDataHealth();
    service.lab.seedCatalogDataHealth(VALID_JOB, { refuse: 'admin/unauthorized' });

    await userEvent.type(within(main()).getByLabelText('Job ID'), VALID_JOB);
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    const alert = await within(main()).findByRole('alert');
    expect(alert).toHaveTextContent('admin/unauthorized');

    service.lab.seedCatalogDataHealth(VALID_JOB, catalogDataHealthReportFixture(VALID_JOB));
    await userEvent.click(within(main()).getByRole('button', { name: 'Try again' }));

    const failuresRow = (await within(main()).findByText('Failures')).closest('tr');
    expect(failuresRow).toHaveTextContent('0 (none by kind)');
  });
});

describe('opening the Player Meta partition data health tab', () => {
  async function openPlayerMetaTab() {
    const opened = await openDataHealth();
    await userEvent.click(within(main()).getByRole('tab', { name: 'Player Meta partition' }));
    return opened;
  }

  async function fillPartitionForm(rulesVersion = '1.0.0') {
    await userEvent.clear(within(main()).getByLabelText('Rules version'));
    if (rulesVersion !== '') {
      await userEvent.type(within(main()).getByLabelText('Rules version'), rulesVersion);
    }
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));
  }

  it('reads and shows the exclusion count for the entered partition', async () => {
    const { service } = await openPlayerMetaTab();
    service.lab.seedPlayerMetaDataHealth(
      playerMetaDataHealthReportFixture(
        { source: 'ai_ai', contentVersion: 1, rulesVersion: '1.0.0' },
        { exclusions: { count: 3, entries: [{ matchId: 'match_1', reason: 'no outcome' }] } },
      ),
    );

    await fillPartitionForm();

    expect(await within(main()).findByText('match_1')).toBeVisible();
    expect(within(main()).getByText('no outcome')).toBeVisible();
    expect(
      service.requests.some((request) => request.path.includes('player-meta-data-health-view')),
    ).toBe(true);
  });

  it('requires a rules version before sending a request', async () => {
    const { service } = await openPlayerMetaTab();

    await fillPartitionForm('');

    expect(await within(main()).findByRole('alert')).toHaveTextContent(
      'Rules version is required.',
    );
    expect(
      service.requests.some((request) => request.path.includes('player-meta-data-health-view')),
    ).toBe(false);
  });

  it('falls back to the empty default fixture for an unseeded partition', async () => {
    await openPlayerMetaTab();

    await fillPartitionForm();

    const failuresRow = (await within(main()).findByText('Failures')).closest('tr');
    expect(failuresRow).toHaveTextContent('0 (none by kind)');
  });

  it('shows the failure state when the read is refused', async () => {
    const { service } = await openPlayerMetaTab();
    service.lab.seedPlayerMetaDataHealth({ refuse: 'admin/unauthorized' });

    await fillPartitionForm();

    const alert = await within(main()).findByRole('alert');
    expect(alert).toHaveTextContent('admin/unauthorized');
  });
});
