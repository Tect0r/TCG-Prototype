import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { ResultColumn, ResultRow } from '@tcg/admin-contracts';

import { renderAdmin, stubLayout } from './test/harness.js';
import {
  adaptiveResultTableFixture,
  adaptiveRunSummaryFixture,
  contentCatalogFixture,
  fakeService,
} from './test/fake-service.js';

/**
 * The Adaptive Counter run panel (M08.19C): a directory-keyed run entered by
 * its `experimentId` rather than selected from the job catalog, read through
 * `adaptiveRunSummary`/`adaptiveResultTable` exactly as `results-flow.test.tsx`
 * exercises the catalog job path.
 */

const main = () => screen.getByRole('main');

function plain(key: string, label: string, kind: ResultColumn['kind']): ResultColumn {
  return { key, label, kind, bounds: null };
}

const SERIES_COLUMNS: readonly ResultColumn[] = [
  plain('generation', 'Generation', 'count'),
  plain('block', 'Block', 'count'),
  plain('incumbentRevisionId', 'Incumbent revision', 'identifier'),
  plain('opponentRevisionId', 'Opponent revision', 'identifier'),
  plain('incumbentDeckHash', 'Incumbent deck', 'identifier'),
  plain('opponentDeckHash', 'Opponent deck', 'identifier'),
  plain('decisionKind', 'Decision', 'identifier'),
  plain('decisionLoser', 'Loser', 'identifier'),
  plain('decisionReason', 'No-decision reason', 'text'),
];

const SERIES_ROWS: readonly ResultRow[] = [
  {
    generation: 1,
    block: 1,
    incumbentRevisionId: 'rev_i1',
    opponentRevisionId: 'rev_o1',
    incumbentDeckHash: 'deck_i1',
    opponentDeckHash: 'deck_o1',
    decisionKind: 'win',
    decisionLoser: 'opponent',
    decisionReason: null,
  },
  {
    generation: 1,
    block: 2,
    incumbentRevisionId: 'rev_i1',
    opponentRevisionId: 'rev_o1',
    incumbentDeckHash: 'deck_i1',
    opponentDeckHash: 'deck_o1',
    decisionKind: 'win',
    decisionLoser: 'incumbent',
    decisionReason: null,
  },
  {
    generation: 2,
    block: 1,
    incumbentRevisionId: 'rev_i2',
    opponentRevisionId: 'rev_o1',
    incumbentDeckHash: 'deck_i2',
    opponentDeckHash: 'deck_o1',
    decisionKind: 'tie',
    decisionLoser: null,
    decisionReason: null,
  },
];

const REVISIONS_COLUMNS: readonly ResultColumn[] = [
  plain('side', 'Lineage', 'identifier'),
  plain('revisionId', 'Revision', 'identifier'),
  plain('parentRevisionId', 'Parent revision', 'identifier'),
  plain('generation', 'Generation', 'count'),
  plain('block', 'Block', 'count'),
  plain('opponentRevisionId', 'Opponent revision', 'identifier'),
  plain('construction', 'Construction', 'identifier'),
  plain('swapCount', 'Swaps', 'count'),
  plain('deckHash', 'Deck', 'identifier'),
  plain('commanderId', 'Commander', 'identifier'),
];

const REVISIONS_ROWS: readonly ResultRow[] = [
  {
    side: 'incumbent',
    revisionId: 'rev_i1',
    parentRevisionId: null,
    generation: 0,
    block: 0,
    opponentRevisionId: null,
    construction: 'root',
    swapCount: 0,
    deckHash: 'deck_i1',
    commanderId: 'goblin_warboss',
  },
];

async function openAdaptive() {
  stubLayout('wide');
  const service = fakeService({ content: contentCatalogFixture() });
  const harness = renderAdmin({ transport: service.transport });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  await userEvent.click(screen.getByRole('button', { name: 'Results' }));
  await screen.findByRole('heading', { level: 1, name: 'Results' });
  await userEvent.click(within(main()).getByRole('button', { name: 'Adaptive Counter run' }));
  return { ...harness, service };
}

describe('opening an Adaptive Counter run', () => {
  it('refuses an experiment ID the contract does not accept, without asking the network', async () => {
    const { service } = await openAdaptive();
    await userEvent.type(within(main()).getByLabelText('Experiment ID'), 'NOT VALID');
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    expect(await within(main()).findByRole('alert')).toHaveTextContent(/lowercase/i);
    expect(service.requests.some((request) => request.path.includes('adaptive'))).toBe(false);
  });

  it('reports honestly when this experiment has produced no adaptive result yet', async () => {
    await openAdaptive();
    await userEvent.type(within(main()).getByLabelText('Experiment ID'), 'goblin_counter');
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    expect(await within(main()).findByText(/produced no adaptive result yet/i)).toBeVisible();
  });

  it('shows the summary, the series tally and the exact rows of every table', async () => {
    const { service } = await openAdaptive();
    service.lab.seedAdaptiveRun('goblin_counter', {
      summary: adaptiveRunSummaryFixture({ experimentId: 'goblin_counter' }),
      tables: {
        series: adaptiveResultTableFixture('goblin_counter', 'series', SERIES_COLUMNS, SERIES_ROWS),
        revisions: adaptiveResultTableFixture(
          'goblin_counter',
          'revisions',
          REVISIONS_COLUMNS,
          REVISIONS_ROWS,
        ),
      },
    });

    await userEvent.type(within(main()).getByLabelText('Experiment ID'), 'goblin_counter');
    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    expect(await within(main()).findByText('goblin_counter', { exact: false })).toBeVisible();
    expect(within(main()).getByText('Blocks decided')).toBeVisible();

    // Series tab is the default view: two incumbent wins and one tie, cumulative.
    await waitFor(() => {
      expect(within(main()).getAllByText('rev_i1').length).toBeGreaterThan(0);
    });
    const cumulativeTable = within(main()).getByText('Cumulative — every decided block so far')
      .nextElementSibling as HTMLElement;
    const finalRow = within(cumulativeTable).getAllByRole('row').at(-1) as HTMLElement;
    const finalCells = within(finalRow).getAllByRole('cell');
    // generation, block, decision, incumbentWins, opponentWins, ties, noDecisions
    expect(finalCells[3]).toHaveTextContent('1');
    expect(finalCells[4]).toHaveTextContent('1');
    expect(finalCells[5]).toHaveTextContent('1');
    expect(finalCells[6]).toHaveTextContent('0');

    await userEvent.click(within(main()).getByRole('button', { name: 'Revisions' }));
    expect(await within(main()).findByText('goblin_warboss')).toBeVisible();
  });
});
