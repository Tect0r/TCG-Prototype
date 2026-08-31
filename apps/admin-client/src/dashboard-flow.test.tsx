import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderAdmin, stubLayout } from './test/harness.js';
import {
  contentCatalogFixture,
  decksTableFixture,
  fakeService,
  matchupsTableFixture,
  pilotsTableFixture,
  resultSummaryFixture,
  seatsTableFixture,
  terminationsTableFixture,
  type FakeService,
} from './test/fake-service.js';

/**
 * The precon result dashboard (M08.11): win-rate bars, an ordered matchup
 * heatmap with an exact-value fallback, the seat/pilot/length/termination and
 * replicate views, drill-down to the exact row a bar or cell summarizes, and
 * the milestone's own exclusion — no automatic balanced/unbalanced verdict,
 * anywhere on the screen.
 */

const main = () => screen.getByRole('main');

const GOBLIN = {
  deckHash: 'deck-goblin-swarm',
  commanderId: 'goblin_warboss',
  matches: 20,
  winRate: { point: 0.65, low: 0.45, high: 0.81, total: 20 },
};
const BASTION = {
  deckHash: 'deck-bastion-guardians',
  commanderId: 'bastion_marshal',
  matches: 20,
  winRate: { point: 0.35, low: 0.19, high: 0.55, total: 20 },
};

/** Seeds one completed benchmark with every dashboard table filled in. */
function seedBenchmark(
  service: FakeService,
  overrides: {
    readonly decks?: readonly Parameters<typeof decksTableFixture>[1][number][];
    readonly matchups?: readonly Parameters<typeof matchupsTableFixture>[1][number][];
  } = {},
): { jobId: string; batchId: string } {
  const seeded = service.lab.seedResult({
    label: 'Precon benchmark',
    summary: resultSummaryFixture({
      readings: [
        { key: 'matches', label: 'Games played', value: 40, kind: 'count' },
        { key: 'turnsMean', label: 'Turns, mean', value: 9.4, kind: 'number' },
        { key: 'turnsMedian', label: 'Turns, median', value: 9, kind: 'number' },
        { key: 'turnsP10', label: 'Turns, 10th percentile', value: 6, kind: 'number' },
        { key: 'turnsP90', label: 'Turns, 90th percentile', value: 13, kind: 'number' },
        { key: 'turnsMax', label: 'Turns, longest', value: 20, kind: 'number' },
      ],
    }),
  });
  const jobId = seeded.jobId;
  service.lab.seedTables(jobId, {
    decks: decksTableFixture(jobId, overrides.decks ?? [GOBLIN, BASTION]),
    matchups: matchupsTableFixture(
      jobId,
      overrides.matchups ?? [
        {
          deckHash: GOBLIN.deckHash,
          opponentHash: BASTION.deckHash,
          rate: { point: 0.65, low: 0.45, high: 0.81, total: 20 },
        },
        // The reverse pairing is deliberately absent: a missing cell, not a
        // fabricated complement.
      ],
    ),
    seats: seatsTableFixture(jobId, [
      { key: 0, rate: { point: 0.55, low: 0.35, high: 0.74, total: 20 } },
      { key: 1, rate: { point: 0.45, low: 0.26, high: 0.65, total: 20 } },
    ]),
    pilots: pilotsTableFixture(jobId, [
      { key: 'random_legal', rate: { point: 0.5, low: 0.3, high: 0.7, total: 20 } },
    ]),
    terminations: terminationsTableFixture(jobId, [
      { kind: 'combat', matches: 18, abnormal: false },
      { kind: 'turn_limit', matches: 2, abnormal: true },
    ]),
  });
  return seeded;
}

async function openDashboard(
  seed: (service: FakeService) => { jobId: string; batchId: string },
): Promise<{ service: FakeService; jobId: string; batchId: string }> {
  stubLayout('wide');
  const service = fakeService({ content: contentCatalogFixture() });
  const seeded = seed(service);
  renderAdmin({ transport: service.transport });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  await userEvent.click(screen.getByRole('button', { name: 'Results' }));
  await screen.findByRole('heading', { level: 1, name: 'Results' });
  await userEvent.click(await within(main()).findByRole('button', { name: /Precon benchmark/ }));
  await within(main()).findByRole('heading', { level: 3, name: 'Precon result dashboard' });
  return { service, ...seeded };
}

describe('the overview view', () => {
  it('draws win-rate bars ordered richest first, with the exact interval and count', async () => {
    await openDashboard((service) => seedBenchmark(service));

    const bars = within(main()).getByRole('table', {
      name: 'Win rate by precon, with interval and sample count',
    });
    const rows = within(bars).getAllByRole('row');
    // Goblin Swarm (65%) sorts before Bastion Guardians (35%).
    expect(within(rows[0] as HTMLElement).getByText('Goblin Swarm')).toBeVisible();
    expect(within(rows[1] as HTMLElement).getByText('Bastion Guardians')).toBeVisible();
    expect(within(bars).getByText(/65\.0% \(45\.0%–81\.0%, n=20\)/)).toBeVisible();
  });

  it('shows the exact matchup value in every heatmap cell, and a missing pair honestly', async () => {
    await openDashboard((service) => seedBenchmark(service));

    const heatmap = within(main()).getByRole('table', {
      name: "Matchup win rate: the row deck's exact win rate against the column deck",
    });
    expect(within(heatmap).getByRole('button', { name: /65\.0%/ })).toBeVisible();
    // The reverse pairing was never seeded: an honest dash, not a fabricated 35%.
    const missing = within(heatmap).getByRole('button', {
      name: /Bastion Guardians against Goblin Swarm.*Insufficient data/,
    });
    expect(missing).toHaveTextContent('—');
  });

  it('marks a zero-sample deck as insufficient data rather than drawing a zero-width bar', async () => {
    await openDashboard((service) =>
      seedBenchmark(service, {
        decks: [
          GOBLIN,
          { ...BASTION, matches: 0, winRate: { point: 0, low: 0, high: 0, total: 0 } },
        ],
      }),
    );

    expect(within(main()).getByText('Insufficient data — no games recorded')).toBeVisible();
  });

  it('never prints a balanced or unbalanced verdict anywhere on the page', async () => {
    await openDashboard((service) => seedBenchmark(service));

    expect(screen.queryByText(/\bbalanced\b/i)).toBeNull();
    expect(screen.queryByText(/\bunbalanced\b/i)).toBeNull();
    expect(screen.queryByText(/\breview recommended\b/i)).toBeNull();
  });

  it('opens the exact contributing row on drill-down, and says replays are not reachable here', async () => {
    await openDashboard((service) => seedBenchmark(service));

    const row = within(main()).getAllByRole('button', { name: 'Exact row' })[0] as HTMLElement;
    await userEvent.click(row);

    const drill = await within(main()).findByRole('region', { name: /deck row/ });
    expect(within(drill).getByText(/Commander/)).toBeVisible();
    expect(within(drill).getByText(/Match Explorer/)).toBeVisible();

    await userEvent.click(within(drill).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(within(main()).queryByRole('region', { name: /deck row/ })).toBeNull();
    });
  });

  it('never claims "no games" for a pair sitting past a truncated matchups page', async () => {
    await openDashboard((service) => {
      const seeded = service.lab.seedResult({
        label: 'Precon benchmark',
        summary: resultSummaryFixture(),
      });
      const jobId = seeded.jobId;
      service.lab.seedTables(jobId, {
        decks: decksTableFixture(jobId, [GOBLIN, BASTION]),
        // Truncated: the fake reports more matchup rows exist than were sent,
        // so the reverse pairing's absence from this page is not confirmed.
        matchups: matchupsTableFixture(
          jobId,
          [
            {
              deckHash: GOBLIN.deckHash,
              opponentHash: BASTION.deckHash,
              rate: { point: 0.65, low: 0.45, high: 0.81, total: 20 },
            },
          ],
          { truncated: true },
        ),
      });
      return seeded;
    });

    expect(await within(main()).findByText(/this view is incomplete/i)).toBeVisible();

    const heatmap = within(main()).getByRole('table', {
      name: "Matchup win rate: the row deck's exact win rate against the column deck",
    });
    const unread = within(heatmap).getByRole('button', {
      name: /Bastion Guardians against Goblin Swarm.*not confirmed/i,
    });
    expect(unread).toBeVisible();
    expect(screen.queryByText(/no completed games between these two decks/i)).toBeNull();

    await userEvent.click(unread);
    const drill = await within(main()).findByRole('region', { name: /Matchup/ });
    expect(within(drill).getByText(/not among the matchup rows this screen read/i)).toBeVisible();
  });
});

describe('switching views', () => {
  it('shows the seat table under the seat-order tab', async () => {
    await openDashboard((service) => seedBenchmark(service));

    await userEvent.click(within(main()).getByRole('button', { name: 'Seat order' }));

    expect(
      within(main()).getByRole('table', {
        name: 'Win rate by seat, with interval and sample count',
      }),
    ).toBeVisible();
    expect(within(main()).getByText('Seat 0')).toBeVisible();
  });

  it('shows exact turn readings under the match-length tab, without a chart', async () => {
    await openDashboard((service) => seedBenchmark(service));

    await userEvent.click(within(main()).getByRole('button', { name: 'Match length' }));

    expect(within(main()).getByText('Turns, mean')).toBeVisible();
  });

  it('shows termination counts and which are excluded from statistics', async () => {
    await openDashboard((service) => seedBenchmark(service));

    await userEvent.click(within(main()).getByRole('button', { name: 'Termination' }));

    const row = within(main()).getByRole('row', { name: /turn_limit/ });
    expect(within(row).getByText('Yes')).toBeVisible();
  });

  it('has no replicate siblings for a lone job, and says so', async () => {
    await openDashboard((service) => seedBenchmark(service));

    await userEvent.click(within(main()).getByRole('button', { name: 'Replicates' }));

    expect(await within(main()).findByText(/no replicate siblings/i)).toBeVisible();
  });

  it('compares win rate across replicate siblings in the same batch', async () => {
    const service = fakeService({ content: contentCatalogFixture() });
    const first = service.lab.seedResult({
      label: 'Precon benchmark, replicate 1',
      summary: resultSummaryFixture(),
      origin: { kind: 'preset', presetId: 'precon_smoke', stageId: 'matches-r1' },
    });
    service.lab.seedTables(first.jobId, {
      decks: decksTableFixture(first.jobId, [
        { ...GOBLIN, winRate: { point: 0.65, low: 0.45, high: 0.81, total: 20 } },
      ]),
    });
    const second = service.lab.seedResult({
      label: 'Precon benchmark, replicate 2',
      summary: resultSummaryFixture(),
      batchId: first.batchId,
      origin: { kind: 'preset', presetId: 'precon_smoke', stageId: 'matches-r2' },
    });
    service.lab.seedTables(second.jobId, {
      decks: decksTableFixture(second.jobId, [
        { ...GOBLIN, winRate: { point: 0.55, low: 0.34, high: 0.75, total: 20 } },
      ]),
    });

    stubLayout('wide');
    renderAdmin({ transport: service.transport });
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    await userEvent.click(screen.getByRole('button', { name: 'Results' }));
    await screen.findByRole('heading', { level: 1, name: 'Results' });
    await userEvent.click(
      await within(main()).findByRole('button', { name: /Precon benchmark, replicate 1/ }),
    );
    await within(main()).findByRole('heading', { level: 3, name: 'Precon result dashboard' });

    await userEvent.click(within(main()).getByRole('button', { name: 'Replicates' }));

    const table = await within(main()).findByRole('table', {
      name: 'Win rate per precon, by replicate',
    });
    expect(within(table).getByRole('columnheader', { name: 'matches-r1' })).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: 'matches-r2' })).toBeVisible();
    expect(within(table).getByText(/65\.0%/)).toBeVisible();
    expect(within(table).getByText(/55\.0%/)).toBeVisible();
  });
});
