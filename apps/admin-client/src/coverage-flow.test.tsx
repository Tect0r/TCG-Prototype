import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderAdmin, stubLayout } from './test/harness.js';
import {
  catalogCoverageReportFixture,
  contentCatalogFixture,
  fakeService,
  playerMetaCoverageReportFixture,
} from './test/fake-service.js';

/**
 * The Coverage panel (M08.27C): two never-merged domains, a Catalog run
 * entered by Job ID and a Player Meta partition entered by
 * source/contentVersion/rulesVersion, each showing three-valued
 * (`reached`/`not_reached`/`unavailable`) coverage rather than a fabricated
 * number.
 */

const main = () => screen.getByRole('main');
const VALID_JOB = 'job_00000000000000000000000000000000';

async function openCoverage() {
  stubLayout('wide');
  const service = fakeService({ content: contentCatalogFixture() });
  const harness = renderAdmin({ transport: service.transport });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  await userEvent.click(screen.getByRole('button', { name: 'Results' }));
  await screen.findByRole('heading', { level: 1, name: 'Results' });
  await userEvent.click(within(main()).getByRole('button', { name: 'Coverage' }));
  return { ...harness, service };
}

describe('opening the Catalog run coverage tab', () => {
  it('reads and shows coverage by stage for the entered job ID', async () => {
    const { service } = await openCoverage();
    service.lab.seedCatalogCoverage(
      VALID_JOB,
      catalogCoverageReportFixture(VALID_JOB, {
        cards: [
          {
            cardId: 'arcane_snare',
            eligibility: 'reached',
            inclusion: 'reached',
            draw: 'reached',
            play: 'not_reached',
            activation: 'unavailable',
            trigger: 'not_reached',
            unavailableReasons: { activation: 'no data' },
          },
        ],
        mechanics: [
          {
            kind: 'keyword',
            id: 'flying',
            mechanicKey: 'keyword:flying',
            cardsUsing: 1,
            status: 'reached',
            unavailableReason: null,
          },
        ],
      }),
    );

    await userEvent.type(within(main()).getByLabelText('Job ID'), VALID_JOB);
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    expect(await within(main()).findByText('arcane_snare')).toBeVisible();
    expect(within(main()).getByText('keyword:flying')).toBeVisible();
    expect(service.requests.some((request) => request.path.includes('catalog-coverage-view'))).toBe(
      true,
    );
  });

  it('refuses a malformed job ID without sending a request', async () => {
    const { service } = await openCoverage();

    await userEvent.type(within(main()).getByLabelText('Job ID'), 'not-a-job-id');
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    expect(await within(main()).findByRole('alert')).toBeVisible();
    expect(service.requests.some((request) => request.path.includes('catalog-coverage-view'))).toBe(
      false,
    );
  });

  it('falls back to the empty default fixture for an unseeded job ID', async () => {
    await openCoverage();

    await userEvent.type(within(main()).getByLabelText('Job ID'), VALID_JOB);
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    expect(
      await within(main()).findByText(/No card is in this run.s whole vocabulary\./),
    ).toBeVisible();
  });

  it('shows the failure state when the read is refused, with a working retry', async () => {
    const { service } = await openCoverage();
    service.lab.seedCatalogCoverage(VALID_JOB, { refuse: 'admin/unauthorized' });

    await userEvent.type(within(main()).getByLabelText('Job ID'), VALID_JOB);
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    const alert = await within(main()).findByRole('alert');
    expect(alert).toHaveTextContent('admin/unauthorized');

    service.lab.seedCatalogCoverage(VALID_JOB, catalogCoverageReportFixture(VALID_JOB));
    await userEvent.click(within(main()).getByRole('button', { name: 'Try again' }));

    expect(
      await within(main()).findByText(/No card is in this run.s whole vocabulary\./),
    ).toBeVisible();
  });
});

describe('opening the Player Meta partition coverage tab', () => {
  async function openPlayerMetaTab() {
    const opened = await openCoverage();
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

  it('reads and shows observation coverage for the entered partition', async () => {
    const { service } = await openPlayerMetaTab();
    service.lab.seedPlayerMetaCoverage(
      playerMetaCoverageReportFixture(
        { source: 'ai_ai', contentVersion: 1, rulesVersion: '1.0.0' },
        {
          cards: [
            { cardId: 'arcane_snare', observation: 'reached', unavailableReason: null },
            { cardId: 'dormant_relic', observation: 'unavailable', unavailableReason: 'no data' },
          ],
        },
      ),
    );

    await fillPartitionForm();

    expect(await within(main()).findByText('arcane_snare')).toBeVisible();
    expect(within(main()).getByText('dormant_relic')).toBeVisible();
    expect(within(main()).getByText(/1 reached, 0 not reached, 1 unavailable/)).toBeVisible();
    expect(
      service.requests.some((request) => request.path.includes('player-meta-coverage-view')),
    ).toBe(true);
  });

  it('requires a rules version before sending a request', async () => {
    const { service } = await openPlayerMetaTab();

    await fillPartitionForm('');

    expect(await within(main()).findByRole('alert')).toHaveTextContent(
      'Rules version is required.',
    );
    expect(
      service.requests.some((request) => request.path.includes('player-meta-coverage-view')),
    ).toBe(false);
  });

  it('falls back to the empty default fixture for an unseeded partition', async () => {
    await openPlayerMetaTab();

    await fillPartitionForm();

    expect(
      await within(main()).findByText('No card was observed in this partition.'),
    ).toBeVisible();
  });

  it('shows the failure state when the read is refused', async () => {
    const { service } = await openPlayerMetaTab();
    service.lab.seedPlayerMetaCoverage({ refuse: 'admin/unauthorized' });

    await fillPartitionForm();

    const alert = await within(main()).findByRole('alert');
    expect(alert).toHaveTextContent('admin/unauthorized');
  });
});
