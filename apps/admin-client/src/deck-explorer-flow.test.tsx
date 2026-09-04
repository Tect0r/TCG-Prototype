import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { ResultColumn, ResultRow } from '@tcg/admin-contracts';

import { renderAdmin, stubLayout } from './test/harness.js';
import {
  contentCatalogFixture,
  deckExplorerViewFixture,
  fakeService,
  playerMetaResultTableFixture,
} from './test/fake-service.js';

/**
 * The Deck Explorer panel (M08.26B): an entry form for a deck hash (and an
 * optional Adaptive Counter experiment ID), an immutable identity read off
 * one observed live match, `knownRevisions`'s honest `null`/`[]`/populated
 * three-way split, and its four reused Player Meta evidence tables.
 */

const main = () => screen.getByRole('main');
const VALID_HASH = '0123456789abcdef';

function plain(key: string, label: string, kind: ResultColumn['kind']): ResultColumn {
  return { key, label, kind, bounds: null };
}

const DECKS_COLUMNS: readonly ResultColumn[] = [
  plain('deckHash', 'Deck', 'identifier'),
  plain('matches', 'Games', 'count'),
];

const DECKS_ROWS: readonly ResultRow[] = [{ deckHash: VALID_HASH, matches: 12 }];

async function openDeckExplorer() {
  stubLayout('wide');
  const service = fakeService({ content: contentCatalogFixture() });
  const harness = renderAdmin({ transport: service.transport });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  await userEvent.click(screen.getByRole('button', { name: 'Results' }));
  await screen.findByRole('heading', { level: 1, name: 'Results' });
  await userEvent.click(within(main()).getByRole('button', { name: 'Deck Explorer' }));
  return { ...harness, service };
}

async function openDeck(service: ReturnType<typeof fakeService>, hash = VALID_HASH) {
  await userEvent.type(within(main()).getByLabelText('Deck hash'), hash);
  await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));
  return service;
}

describe('opening the Deck Explorer', () => {
  it('reads and shows a deck identity for the entered hash', async () => {
    const { service } = await openDeckExplorer();
    service.lab.seedDeckExplorer(VALID_HASH, deckExplorerViewFixture(VALID_HASH));

    await openDeck(service);

    expect(await within(main()).findByText('prototype_commander_fake')).toBeVisible();
    expect(await within(main()).findByText('prototype_card_fake')).toBeVisible();
    expect(service.requests.some((request) => request.path.includes('deck-explorer-view'))).toBe(
      true,
    );
  });

  it('refuses a malformed deck hash without sending a request', async () => {
    const { service } = await openDeckExplorer();

    await userEvent.type(within(main()).getByLabelText('Deck hash'), 'NOT-HEX');
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    expect(await within(main()).findByRole('alert')).toBeVisible();
    expect(service.requests.some((request) => request.path.includes('deck-explorer-view'))).toBe(
      false,
    );
  });

  it('shows an honest not-found state when no live match played this deck hash', async () => {
    const { service } = await openDeckExplorer();
    service.lab.seedDeckExplorer(VALID_HASH, {
      deckHash: VALID_HASH,
      identity: null,
      knownRevisions: null,
    });

    await openDeck(service);

    expect(await within(main()).findByText(/No live match .* played deck hash/)).toBeVisible();
  });

  it('distinguishes known revisions not checked from checked-and-empty', async () => {
    const { service } = await openDeckExplorer();
    service.lab.seedDeckExplorer(
      VALID_HASH,
      deckExplorerViewFixture(VALID_HASH, { knownRevisions: null }),
    );
    await openDeck(service);
    expect(await within(main()).findByText(/not checked/)).toBeVisible();

    service.lab.seedDeckExplorer(
      VALID_HASH,
      deckExplorerViewFixture(VALID_HASH, { knownRevisions: [] }),
    );
    await userEvent.type(
      within(main()).getByLabelText(
        'Adaptive Counter experiment ID (optional, for known revisions)',
      ),
      'goblin_counter',
    );
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    expect(
      await within(main()).findByText(/checked — no revision in the named experiment/),
    ).toBeVisible();
  });

  it('renders a populated revision lineage as a table', async () => {
    const { service } = await openDeckExplorer();
    service.lab.seedDeckExplorer(
      VALID_HASH,
      deckExplorerViewFixture(VALID_HASH, {
        knownRevisions: [
          {
            side: 'incumbent',
            revisionId: 'rev_abc',
            parentRevisionId: null,
            generation: 0,
            block: 0,
            opponentRevisionId: null,
            construction: 'root',
            swapCount: 0,
          },
        ],
      }),
    );

    await openDeck(service);

    expect(await within(main()).findByText('rev_abc')).toBeVisible();
    expect(within(main()).getByText('Incumbent')).toBeVisible();
    expect(within(main()).getByText('Root')).toBeVisible();
  });

  it('shows the reused Player Meta evidence tables narrowed to this deck, with drill-down', async () => {
    const { service } = await openDeckExplorer();
    service.lab.seedDeckExplorer(VALID_HASH, deckExplorerViewFixture(VALID_HASH));
    service.lab.seedPlayerMeta({
      tables: { decks: playerMetaResultTableFixture('decks', DECKS_COLUMNS, DECKS_ROWS) },
    });

    await openDeck(service);
    await within(main()).findByText('prototype_commander_fake');

    const exactTable = await within(main()).findByRole('table', { name: 'This deck — exact rows' });
    const rows = within(exactTable).getAllByRole('row');
    const firstDataRow = rows[1] as HTMLElement;

    await userEvent.click(within(firstDataRow).getByRole('button', { name: 'Exact row' }));

    const drill = await within(main()).findByRole('region', { name: /deck row/ });
    expect(within(drill).getByText(/Match Explorer/)).toBeVisible();

    await userEvent.click(within(drill).getByRole('button', { name: 'Close' }));
    expect(within(main()).queryByRole('region', { name: /deck row/ })).not.toBeInTheDocument();
  });

  it('shows the failure state when the read is refused as unauthorized', async () => {
    const { service } = await openDeckExplorer();
    service.lab.seedDeckExplorer(VALID_HASH, { refuse: 'admin/unauthorized' });

    await openDeck(service);

    const alert = await within(main()).findByRole('alert');
    expect(alert).toHaveTextContent('admin/unauthorized');
  });
});
