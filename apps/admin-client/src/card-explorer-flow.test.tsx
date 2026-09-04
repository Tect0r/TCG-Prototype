import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderAdmin, stubLayout } from './test/harness.js';
import { cardExplorerViewFixture, contentCatalogFixture, fakeService } from './test/fake-service.js';

/**
 * The Card Explorer panel (M08.26C): an entry form for a card ID (and an
 * optional job ID), eligible-inclusion and partner evidence across live
 * matches, the `experimentEvidence` `null`/checked-empty/populated three-way
 * split, and contributing decks/matches.
 */

const main = () => screen.getByRole('main');
const VALID_CARD = 'arcane_snare';
const VALID_JOB = 'job_00000000000000000000000000000000';

async function openCardExplorer() {
  stubLayout('wide');
  const service = fakeService({ content: contentCatalogFixture() });
  const harness = renderAdmin({ transport: service.transport });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  await userEvent.click(screen.getByRole('button', { name: 'Results' }));
  await screen.findByRole('heading', { level: 1, name: 'Results' });
  await userEvent.click(within(main()).getByRole('button', { name: 'Card Explorer' }));
  return { ...harness, service };
}

async function openCard(
  service: ReturnType<typeof fakeService>,
  cardId = VALID_CARD,
  jobId = '',
) {
  await userEvent.type(within(main()).getByLabelText('Card ID'), cardId);
  if (jobId !== '') {
    await userEvent.type(
      within(main()).getByLabelText('Job ID (optional, for draw/play/dead-hand evidence)'),
      jobId,
    );
  }
  await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));
  return service;
}

describe('opening the Card Explorer', () => {
  it('reads and shows inclusion evidence for the entered card ID', async () => {
    const { service } = await openCardExplorer();
    service.lab.seedCardExplorer(
      VALID_CARD,
      cardExplorerViewFixture(VALID_CARD, {
        inclusions: [
          {
            commanderId: 'chief_containment_scholar',
            status: 'played',
            commanderMatches: 10,
            matchesIncluding: 5,
            inclusion: 0.5,
            uniqueDecks: 8,
            decksIncluding: 4,
            inclusionByUniqueDeck: 0.5,
            observedIn: {
              realm: 'live_match',
              source: 'ai_ai',
              contentVersion: 1,
              rulesVersion: '1.0.0',
            },
          },
        ],
      }),
    );

    await openCard(service);

    expect(await within(main()).findByText('chief_containment_scholar')).toBeVisible();
    expect(within(main()).getByText('Played')).toBeVisible();
    expect(service.requests.some((request) => request.path.includes('card-explorer-view'))).toBe(
      true,
    );
  });

  it('refuses a malformed card ID without sending a request', async () => {
    const { service } = await openCardExplorer();

    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    expect(await within(main()).findByRole('alert')).toBeVisible();
    expect(service.requests.some((request) => request.path.includes('card-explorer-view'))).toBe(
      false,
    );
  });

  it('shows an empty state when no live match includes this card', async () => {
    const { service } = await openCardExplorer();
    service.lab.seedCardExplorer(VALID_CARD, cardExplorerViewFixture(VALID_CARD));

    await openCard(service);

    expect(
      await within(main()).findByText(/No live match this server finds includes this card/),
    ).toBeVisible();
  });

  it('distinguishes experiment evidence not checked from checked-and-empty', async () => {
    const { service } = await openCardExplorer();
    service.lab.seedCardExplorer(VALID_CARD, cardExplorerViewFixture(VALID_CARD));
    await openCard(service);
    expect(await within(main()).findByText(/not checked/)).toBeVisible();

    service.lab.seedCardExplorer(
      VALID_CARD,
      cardExplorerViewFixture(VALID_CARD, {
        experimentEvidence: {
          jobId: VALID_JOB,
          row: null,
          observedIn: {
            realm: 'experiment',
            sourceClasses: ['ai'],
            environment: {
              environmentId: 'baseline',
              hashes: {
                mechanicsHash: '1111111111111111',
                pilotInputHash: '2222222222222222',
                presentationHash: '3333333333333333',
                fullContentHash: '4444444444444444',
              },
            },
          },
        },
      }),
    );
    await userEvent.type(
      within(main()).getByLabelText('Job ID (optional, for draw/play/dead-hand evidence)'),
      VALID_JOB,
    );
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    expect(
      await within(main()).findByText(/checked — the named job's own/),
    ).toBeVisible();
  });

  it('renders a populated experiment evidence row as facts', async () => {
    const { service } = await openCardExplorer();
    service.lab.seedCardExplorer(
      VALID_CARD,
      cardExplorerViewFixture(VALID_CARD, {
        experimentEvidence: {
          jobId: VALID_JOB,
          row: { definitionId: VALID_CARD, deadInHandShare: 0.25 },
          observedIn: {
            realm: 'experiment',
            sourceClasses: ['ai'],
            environment: {
              environmentId: 'baseline',
              hashes: {
                mechanicsHash: '1111111111111111',
                pilotInputHash: '2222222222222222',
                presentationHash: '3333333333333333',
                fullContentHash: '4444444444444444',
              },
            },
          },
        },
      }),
    );

    await openCard(service, VALID_CARD, VALID_JOB);

    expect(await within(main()).findByText('deadInHandShare')).toBeVisible();
    expect(within(main()).getByText('0.25')).toBeVisible();
  });

  it('shows the failure state when the read is refused as unauthorized', async () => {
    const { service } = await openCardExplorer();
    service.lab.seedCardExplorer(VALID_CARD, { refuse: 'admin/unauthorized' });

    await openCard(service);

    const alert = await within(main()).findByRole('alert');
    expect(alert).toHaveTextContent('admin/unauthorized');
  });
});
