import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { ResultColumn, ResultRow } from '@tcg/admin-contracts';

import { renderAdmin, stubLayout } from './test/harness.js';
import {
  contentCatalogFixture,
  fakeService,
  playerMetaResultTableFixture,
  playerMetaRunSummaryFixture,
} from './test/fake-service.js';

/**
 * The Player Meta dashboard (M08.25C): unlike the Adaptive Counter run panel,
 * this has no entry form — it fetches the one configured root's summary
 * unconditionally on opening the tab, exactly as `PlayerMetaDashboard.tsx`'s
 * own doc comment explains.
 */

const main = () => screen.getByRole('main');

function plain(key: string, label: string, kind: ResultColumn['kind']): ResultColumn {
  return { key, label, kind, bounds: null };
}

const COMMANDERS_COLUMNS: readonly ResultColumn[] = [
  plain('commanderId', 'Commander', 'identifier'),
  plain('matches', 'Games', 'count'),
  plain('uniqueDecks', 'Distinct decks', 'count'),
];

const COMMANDERS_ROWS: readonly ResultRow[] = [
  { commanderId: 'commander_low_matches_high_unique', matches: 10, uniqueDecks: 9 },
  { commanderId: 'commander_high_matches_low_unique', matches: 40, uniqueDecks: 2 },
];

async function openPlayerMeta() {
  stubLayout('wide');
  const service = fakeService({ content: contentCatalogFixture() });
  const harness = renderAdmin({ transport: service.transport });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  await userEvent.click(screen.getByRole('button', { name: 'Results' }));
  await screen.findByRole('heading', { level: 1, name: 'Results' });
  await userEvent.click(within(main()).getByRole('button', { name: 'Player Meta' }));
  return { ...harness, service };
}

describe('opening the Player Meta dashboard', () => {
  it('fetches and shows the summary with no run identifier to enter', async () => {
    const { service } = await openPlayerMeta();

    expect(await within(main()).findByText(/Matches read/i)).toBeVisible();
    expect(service.requests.some((request) => request.path.includes('player-meta-summary'))).toBe(
      true,
    );
  });

  it('shows the exact rows of the selected table, and reorders them by the chosen weighting', async () => {
    const { service } = await openPlayerMeta();
    service.lab.seedPlayerMeta({
      summary: playerMetaRunSummaryFixture(),
      tables: {
        commanders: playerMetaResultTableFixture('commanders', COMMANDERS_COLUMNS, COMMANDERS_ROWS),
      },
    });

    // Re-open to force a fresh fetch against the newly seeded fixture.
    await userEvent.click(within(main()).getByRole('button', { name: 'Adaptive Counter run' }));
    await userEvent.click(within(main()).getByRole('button', { name: 'Player Meta' }));

    await within(main()).findByText('commander_low_matches_high_unique');

    const exactTable = () => within(main()).getByRole('table', { name: 'Commanders — exact rows' });

    const rowsByMatches = within(exactTable()).getAllByRole('row');
    const firstDataRow = rowsByMatches[1] as HTMLElement;
    expect(within(firstDataRow).getByText('commander_high_matches_low_unique')).toBeVisible();

    await userEvent.click(within(main()).getByRole('button', { name: 'By unique decks' }));

    const rowsByUnique = within(exactTable()).getAllByRole('row');
    const firstUniqueRow = rowsByUnique[1] as HTMLElement;
    expect(within(firstUniqueRow).getByText('commander_low_matches_high_unique')).toBeVisible();
  });

  it('shows an empty state for a table that matched no row', async () => {
    const { service } = await openPlayerMeta();
    service.lab.seedPlayerMeta({
      summary: playerMetaRunSummaryFixture(),
      tables: { commanders: playerMetaResultTableFixture('commanders', COMMANDERS_COLUMNS, []) },
    });

    await userEvent.click(within(main()).getByRole('button', { name: 'Adaptive Counter run' }));
    await userEvent.click(within(main()).getByRole('button', { name: 'Player Meta' }));

    expect(
      await within(main()).findByText('This query matched no row for this table.'),
    ).toBeVisible();
  });

  it('reads a zero-observation rate cell as insufficient data, never a fabricated proportion', async () => {
    const { service } = await openPlayerMeta();
    const rateColumns: readonly ResultColumn[] = [
      plain('commanderId', 'Commander', 'identifier'),
      {
        key: 'winRate',
        label: 'Win rate',
        kind: 'interval',
        bounds: { low: 'winRateLow', high: 'winRateHigh' },
      },
      plain('winRateGames', 'Win-rate games', 'count'),
    ];
    const rows: readonly ResultRow[] = [
      {
        commanderId: 'commander_untested',
        winRate: 0,
        winRateLow: 0,
        winRateHigh: 0,
        winRateGames: 0,
      },
    ];
    service.lab.seedPlayerMeta({
      summary: playerMetaRunSummaryFixture(),
      tables: { commanders: playerMetaResultTableFixture('commanders', rateColumns, rows) },
    });

    await userEvent.click(within(main()).getByRole('button', { name: 'Adaptive Counter run' }));
    await userEvent.click(within(main()).getByRole('button', { name: 'Player Meta' }));

    expect(await within(main()).findByText('Insufficient data — no games recorded')).toBeVisible();
  });

  it('names a skipped record count rather than leaving it as a bare figure', async () => {
    const { service } = await openPlayerMeta();
    service.lab.seedPlayerMeta({
      summary: playerMetaRunSummaryFixture({ source: { recordsRead: 4, recordsSkipped: 2 } }),
    });

    await userEvent.click(within(main()).getByRole('button', { name: 'Adaptive Counter run' }));
    await userEvent.click(within(main()).getByRole('button', { name: 'Player Meta' }));

    expect(await within(main()).findByText(/could not be read and were skipped/i)).toBeVisible();
  });

  it('shows the failure state when the summary is refused as unauthorized', async () => {
    const { service } = await openPlayerMeta();
    service.lab.seedPlayerMeta({ summary: { refuse: 'admin/unauthorized' } });

    await userEvent.click(within(main()).getByRole('button', { name: 'Adaptive Counter run' }));
    await userEvent.click(within(main()).getByRole('button', { name: 'Player Meta' }));

    const alert = await within(main()).findByRole('alert');
    expect(alert).toHaveTextContent('admin/unauthorized');
  });

  it('opens and closes a row’s exact-row drill-down with the Match Explorer disclaimer', async () => {
    const { service } = await openPlayerMeta();
    service.lab.seedPlayerMeta({
      summary: playerMetaRunSummaryFixture(),
      tables: {
        commanders: playerMetaResultTableFixture('commanders', COMMANDERS_COLUMNS, COMMANDERS_ROWS),
      },
    });

    await userEvent.click(within(main()).getByRole('button', { name: 'Adaptive Counter run' }));
    await userEvent.click(within(main()).getByRole('button', { name: 'Player Meta' }));

    await within(main()).findByText('commander_low_matches_high_unique');
    const exactTable = within(main()).getByRole('table', { name: 'Commanders — exact rows' });
    const rows = within(exactTable).getAllByRole('row');
    const firstDataRow = rows[1] as HTMLElement;

    await userEvent.click(within(firstDataRow).getByRole('button', { name: 'Exact row' }));

    const drill = await within(main()).findByRole('region', {
      name: /Commander row/,
    });
    expect(within(drill).getByText(/Match Explorer/)).toBeVisible();

    await userEvent.click(within(drill).getByRole('button', { name: 'Close' }));
    expect(within(main()).queryByRole('region', { name: /Commander row/ })).not.toBeInTheDocument();
  });
});
