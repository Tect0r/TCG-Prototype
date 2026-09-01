import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderAdmin, stubLayout } from './test/harness.js';
import {
  cardsTableFixture,
  commanderGenerationsTableFixture,
  commanderMatchupsTableFixture,
  commandersTableFixture,
  contentCatalogFixture,
  decksTableFixture,
  fakeService,
  matchupsTableFixture,
  pilotsTableFixture,
  resultSummaryFixture,
  searchGenerationsTableFixture,
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

/* ------------------------------------------------------- the Open Meta views (M08.14) */

/** Seeds one completed Open Meta search with the four M08.14 result tables filled in. */
function seedOpenMetaSearch(service: FakeService): { jobId: string; batchId: string } {
  const seeded = service.lab.seedResult({
    label: 'Open Meta search',
    summary: resultSummaryFixture({ kind: 'search' }),
  });
  const jobId = seeded.jobId;
  service.lab.seedTables(jobId, {
    decks: decksTableFixture(jobId, [GOBLIN, BASTION]),
    commanders: commandersTableFixture(jobId, [
      {
        commanderId: GOBLIN.commanderId,
        matches: 30,
        winRate: { point: 0.6, low: 0.42, high: 0.76, total: 30 },
        decks: 4,
        deckDiversity: 0.7,
        topDeckFitness: 1.3,
        medianDeckFitness: 0.9,
      },
      {
        commanderId: BASTION.commanderId,
        matches: 30,
        winRate: { point: 0.4, low: 0.24, high: 0.58, total: 30 },
        decks: 3,
        deckDiversity: 0.5,
        topDeckFitness: 1.0,
        medianDeckFitness: 0.7,
      },
    ]),
    commander_matchups: commanderMatchupsTableFixture(jobId, [
      {
        commanderId: GOBLIN.commanderId,
        opponentCommanderId: BASTION.commanderId,
        rate: { point: 0.6, low: 0.42, high: 0.76, total: 30 },
      },
    ]),
    commander_generations: commanderGenerationsTableFixture(jobId, [
      { generation: 0, replicate: 0, commanderId: GOBLIN.commanderId, share: 0.625 },
      { generation: 0, replicate: 0, commanderId: BASTION.commanderId, share: 0.375 },
      { generation: 1, replicate: 0, commanderId: GOBLIN.commanderId, share: 0.75 },
      { generation: 1, replicate: 0, commanderId: BASTION.commanderId, share: 0.25 },
    ]),
    search_generations: searchGenerationsTableFixture(jobId, [
      {
        generation: 0,
        replicate: 0,
        cardEntropy: 0.82,
        meanPairwiseDistance: 5.1,
        commanderCount: 2,
        bestScore: 1.1,
      },
      {
        generation: 1,
        replicate: 0,
        cardEntropy: 0.6,
        meanPairwiseDistance: 3.4,
        commanderCount: 2,
        bestScore: 1.4,
      },
    ]),
    cards: cardsTableFixture(jobId, [
      {
        definitionId: 'goblin_scout',
        decksIncluding: 4,
        eligibleDecks: 4,
        inclusionAmongEligibleShare: 1,
        inclusionWinRateLift: 0.05,
      },
    ]),
  });
  return seeded;
}

async function openOpenMetaDashboard(): Promise<{
  service: FakeService;
  jobId: string;
  batchId: string;
}> {
  stubLayout('wide');
  const service = fakeService({ content: contentCatalogFixture() });
  const seeded = seedOpenMetaSearch(service);
  renderAdmin({ transport: service.transport });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  await userEvent.click(screen.getByRole('button', { name: 'Results' }));
  await screen.findByRole('heading', { level: 1, name: 'Results' });
  await userEvent.click(await within(main()).findByRole('button', { name: /Open Meta search/ }));
  await within(main()).findByRole('heading', { level: 3, name: 'Open Meta result dashboard' });
  return { service, ...seeded };
}

describe('the Open Meta search views (M08.14)', () => {
  it('adds the Commander, Diversity and Card inclusion tabs only for a search run', async () => {
    await openOpenMetaDashboard();

    expect(within(main()).getByRole('button', { name: 'Commanders' })).toBeVisible();
    expect(within(main()).getByRole('button', { name: 'Diversity' })).toBeVisible();
    expect(within(main()).getByRole('button', { name: 'Card inclusion' })).toBeVisible();
  });

  it('does not add the search tabs to a batch run', async () => {
    await openDashboard((service) => seedBenchmark(service));

    expect(within(main()).queryByRole('button', { name: 'Commanders' })).toBeNull();
    expect(within(main()).queryByRole('button', { name: 'Diversity' })).toBeNull();
    expect(within(main()).queryByRole('button', { name: 'Card inclusion' })).toBeNull();
  });

  it('draws Commander win-rate bars, a Commander matchup heatmap, and top decks, with drill-down', async () => {
    await openOpenMetaDashboard();
    await userEvent.click(within(main()).getByRole('button', { name: 'Commanders' }));

    const bars = within(main()).getByRole('table', {
      name: 'Win rate by Commander, with interval and sample count',
    });
    expect(within(bars).getByText(/60\.0% \(42\.0%–76\.0%, n=30\)/)).toBeVisible();

    const heatmap = within(main()).getByRole('table', {
      name: "Matchup win rate: the row Commander's exact win rate against the column Commander",
    });
    expect(within(heatmap).getByRole('button', { name: /60\.0%/ })).toBeVisible();

    // Report drill-down: the Commander row's exact fitness numbers, otherwise
    // never rendered directly on this screen, reach the reader through this.
    const row = within(bars).getAllByRole('button', { name: 'Exact row' })[0] as HTMLElement;
    await userEvent.click(row);
    const drill = await within(main()).findByRole('region', { name: /Commander row/ });
    expect(within(drill).getByText('Top deck fitness')).toBeVisible();
    expect(within(drill).getByText('1.3')).toBeVisible();
    expect(within(drill).getByText('Median deck fitness')).toBeVisible();
  });

  it('renders card entropy and mean pairwise distance per generation, with report drill-down', async () => {
    await openOpenMetaDashboard();
    await userEvent.click(within(main()).getByRole('button', { name: 'Diversity' }));

    const table = within(main()).getByRole('table', {
      name: /Card entropy, mean pairwise distance/,
    });
    const rows = within(table).getAllByRole('row');
    const row0 = rows[1] as HTMLElement;
    const row1 = rows[2] as HTMLElement;
    expect(within(row0).getByText('0.82')).toBeVisible();
    expect(within(row0).getByText('5.1')).toBeVisible();
    expect(within(row1).getByText('0.6')).toBeVisible();

    await userEvent.click(within(row1).getByRole('button', { name: 'Exact row' }));
    const drill = await within(main()).findByRole('region', { name: /generation 1/ });
    expect(within(drill).getByText('Card entropy')).toBeVisible();
  });

  it('keeps two replicates as separate series rather than collapsing shared generation numbers (M08.14)', async () => {
    stubLayout('wide');
    const service = fakeService({ content: contentCatalogFixture() });
    const seeded = service.lab.seedResult({
      label: 'Open Meta search, two replicates',
      summary: resultSummaryFixture({ kind: 'search' }),
    });
    const jobId = seeded.jobId;
    service.lab.seedTables(jobId, {
      decks: decksTableFixture(jobId, [GOBLIN, BASTION]),
      commanders: commandersTableFixture(jobId, [
        {
          commanderId: GOBLIN.commanderId,
          matches: 30,
          winRate: { point: 0.6, low: 0.42, high: 0.76, total: 30 },
          decks: 4,
          deckDiversity: 0.7,
        },
      ]),
      search_generations: searchGenerationsTableFixture(jobId, [
        {
          generation: 0,
          replicate: 0,
          cardEntropy: 0.82,
          meanPairwiseDistance: 5.1,
          commanderCount: 1,
        },
        {
          generation: 0,
          replicate: 1,
          cardEntropy: 0.5,
          meanPairwiseDistance: 3.2,
          commanderCount: 1,
        },
      ]),
      commander_generations: commanderGenerationsTableFixture(jobId, [
        { generation: 0, replicate: 0, commanderId: GOBLIN.commanderId, share: 1 },
        { generation: 0, replicate: 1, commanderId: BASTION.commanderId, share: 1 },
      ]),
    });

    stubLayout('wide');
    renderAdmin({ transport: service.transport });
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    await userEvent.click(screen.getByRole('button', { name: 'Results' }));
    await screen.findByRole('heading', { level: 1, name: 'Results' });
    await userEvent.click(
      await within(main()).findByRole('button', { name: /Open Meta search, two replicates/ }),
    );
    await within(main()).findByRole('heading', { level: 3, name: 'Open Meta result dashboard' });
    await userEvent.click(within(main()).getByRole('button', { name: 'Diversity' }));

    const generationsTable = within(main()).getByRole('table', {
      name: /Card entropy, mean pairwise distance/,
    });
    const generationRows = within(generationsTable).getAllByRole('row');
    const genRow0 = generationRows[1] as HTMLElement;
    const genRow1 = generationRows[2] as HTMLElement;
    // Both rows say "generation 0" — only the Replicate column (this row's
    // header cell) tells them apart.
    expect(within(genRow0).getByRole('rowheader')).toHaveTextContent('0');
    expect(within(genRow0).getByText('0.82')).toBeVisible();
    expect(within(genRow1).getByRole('rowheader')).toHaveTextContent('1');
    expect(within(genRow1).getByText('0.5')).toBeVisible();

    // Each replicate's Commander holds 100% of its own population — never 200%
    // of one collapsed "generation 0".
    const sharesTable = within(main()).getByRole('table', {
      name: /Each Commander's share of the population/,
    });
    const shareRows = within(sharesTable).getAllByRole('row').slice(1) as HTMLElement[];
    expect(shareRows).toHaveLength(2);
    for (const row of shareRows) {
      expect(within(row).getByText('100.0%')).toBeVisible();
    }
  });

  it('renders Commander share by generation, converging toward the fitter Commander', async () => {
    await openOpenMetaDashboard();
    await userEvent.click(within(main()).getByRole('button', { name: 'Diversity' }));

    expect(within(main()).getByText('Commander share by generation')).toBeVisible();
    expect(within(main()).getByText('62.5%')).toBeVisible();
    expect(within(main()).getByText('75.0%')).toBeVisible();
  });

  it('shows the forced-inclusion caveat beside card inclusion, unconditionally', async () => {
    await openOpenMetaDashboard();
    await userEvent.click(within(main()).getByRole('button', { name: 'Card inclusion' }));

    expect(within(main()).getByText(/forced-inclusion floor/i)).toBeVisible();
    expect(within(main()).getByText('goblin_scout')).toBeVisible();
  });

  it('opens the exact contributing row for a card, including its included/absent sample counts', async () => {
    await openOpenMetaDashboard();
    await userEvent.click(within(main()).getByRole('button', { name: 'Card inclusion' }));

    await userEvent.click(within(main()).getByRole('button', { name: 'Exact row' }));
    const drill = await within(main()).findByRole('region', { name: /card row/ });
    expect(within(drill).getByText('Inclusion lift')).toBeVisible();
  });
});

/** Seeds one completed finalist championship, an ordinary batch run with a `commander_championship` origin. */
function seedChampionship(service: FakeService): { jobId: string; batchId: string } {
  const seeded = service.lab.seedResult({
    label: 'Frozen finalist championship',
    summary: resultSummaryFixture({ kind: 'batch' }),
    origin: {
      kind: 'commander_championship',
      sourceBatchId: 'batch_sourcefixture',
      finalists: [
        {
          commanderId: GOBLIN.commanderId,
          requested: 3,
          selected: 2,
          diversityRule: 'greedy_min_pairwise_deck_distance',
          minDistance: 4,
        },
        {
          commanderId: BASTION.commanderId,
          requested: 3,
          selected: 3,
          diversityRule: 'greedy_min_pairwise_deck_distance',
          minDistance: 4,
        },
      ],
    },
  });
  const jobId = seeded.jobId;
  service.lab.seedTables(jobId, {
    decks: decksTableFixture(jobId, [GOBLIN, BASTION]),
    commanders: commandersTableFixture(jobId, [
      {
        commanderId: GOBLIN.commanderId,
        matches: 30,
        winRate: { point: 0.6, low: 0.42, high: 0.76, total: 30 },
        decks: 2,
        deckDiversity: 0.7,
        topDeckFitness: 0,
        medianDeckFitness: 0,
      },
      {
        commanderId: BASTION.commanderId,
        matches: 30,
        winRate: { point: 0.4, low: 0.24, high: 0.58, total: 30 },
        decks: 3,
        deckDiversity: 0.5,
        topDeckFitness: 0,
        medianDeckFitness: 0,
      },
    ]),
    commander_matchups: commanderMatchupsTableFixture(jobId, [
      {
        commanderId: GOBLIN.commanderId,
        opponentCommanderId: BASTION.commanderId,
        rate: { point: 0.6, low: 0.42, high: 0.76, total: 30 },
      },
    ]),
  });
  return seeded;
}

async function openChampionshipDashboard(): Promise<{
  service: FakeService;
  jobId: string;
  batchId: string;
}> {
  stubLayout('wide');
  const service = fakeService({ content: contentCatalogFixture() });
  const seeded = seedChampionship(service);
  renderAdmin({ transport: service.transport });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  await userEvent.click(screen.getByRole('button', { name: 'Results' }));
  await screen.findByRole('heading', { level: 1, name: 'Results' });
  await userEvent.click(
    await within(main()).findByRole('button', { name: /Frozen finalist championship/ }),
  );
  await within(main()).findByRole('heading', {
    level: 3,
    name: 'Finalist championship result dashboard',
  });
  return { service, ...seeded };
}

describe('the finalist championship views (M08.15)', () => {
  it('adds only the Commanders tab to a championship run, never Diversity or Card inclusion', async () => {
    await openChampionshipDashboard();

    expect(within(main()).getByRole('button', { name: 'Commanders' })).toBeVisible();
    expect(within(main()).queryByRole('button', { name: 'Diversity' })).toBeNull();
    expect(within(main()).queryByRole('button', { name: 'Card inclusion' })).toBeNull();
  });

  it('shows the frozen finalist selection per Commander, and flags a shortfall honestly', async () => {
    await openChampionshipDashboard();
    await userEvent.click(within(main()).getByRole('button', { name: 'Commanders' }));

    const selections = within(main()).getAllByRole('table', { name: /Finalist selection for/ });
    expect(selections).toHaveLength(2);
    const [goblin, bastion] = selections as [HTMLElement, HTMLElement];
    expect(within(goblin).getByText('3')).toBeVisible();
    expect(within(goblin).getByText('2')).toBeVisible();
    expect(within(goblin).getByText('greedy_min_pairwise_deck_distance')).toBeVisible();
    expect(within(goblin).getByText(/fewer sufficiently distinct decks existed/i)).toBeVisible();
    expect(within(bastion).queryByText(/fewer sufficiently distinct decks existed/i)).toBeNull();
  });

  it('still renders the Commander win-rate bars and matchup heatmap for a championship run', async () => {
    await openChampionshipDashboard();
    await userEvent.click(within(main()).getByRole('button', { name: 'Commanders' }));

    const bars = within(main()).getByRole('table', {
      name: 'Win rate by Commander, with interval and sample count',
    });
    expect(within(bars).getByText(/60\.0% \(42\.0%–76\.0%, n=30\)/)).toBeVisible();

    const heatmap = within(main()).getByRole('table', {
      name: "Matchup win rate: the row Commander's exact win rate against the column Commander",
    });
    expect(within(heatmap).getByRole('button', { name: /60\.0%/ })).toBeVisible();
  });
});
