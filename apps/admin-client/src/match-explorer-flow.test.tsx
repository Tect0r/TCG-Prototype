import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { PAGE_SIZE_DEFAULT, REPRESENTATIVE_MATCH_KINDS } from '@tcg/admin-contracts';

import { renderAdmin, stubLayout } from './test/harness.js';
import {
  contentCatalogFixture,
  deckExplorerViewFixture,
  fakeService,
  matchExplorerViewFixture,
  matchRepresentativesViewFixture,
  type FakeService,
} from './test/fake-service.js';

const LIVE_MATCH_EVIDENCE = {
  realm: 'live_match' as const,
  source: 'ai_ai' as const,
  contentVersion: 1,
  rulesVersion: '1.0.0',
};

/**
 * The Match Explorer panel (M08.26D): a filterable match table read off the
 * same live-match record Deck Explorer (M08.26B) and Card Explorer (M08.26C)
 * already read, opening to one match's termination context, deck snapshots,
 * the three-state artifact availability split, its flattened event timeline
 * (only once retained) and selected decision diagnostics.
 */

const main = () => screen.getByRole('main');

async function openMatchExplorer(seed?: (service: FakeService) => void) {
  stubLayout('wide');
  const service = fakeService({ content: contentCatalogFixture() });
  seed?.(service);
  const harness = renderAdmin({ transport: service.transport });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  await userEvent.click(screen.getByRole('button', { name: 'Results' }));
  await screen.findByRole('heading', { level: 1, name: 'Results' });
  await userEvent.click(within(main()).getByRole('button', { name: 'Match Explorer' }));
  return { ...harness, service };
}

describe('browsing the Match Explorer', () => {
  it('shows an empty state when no live match is recorded', async () => {
    await openMatchExplorer();

    expect(
      await within(main()).findByText(/No match in this server's one configured result root/),
    ).toBeVisible();
  });

  it('lists a seeded match and shows its termination, seats and artifact availability', async () => {
    const { service } = await openMatchExplorer((fake) => {
      fake.lab.seedMatchExplorer('match_1', matchExplorerViewFixture('match_1'));
    });

    await userEvent.click(await within(main()).findByRole('button', { name: /match_1/ }));
    const detail = await within(main()).findByRole('region', { name: 'Match match_1' });

    expect(await within(detail).findByText('Rules victory')).toBeVisible();
    expect(within(detail).getByText('prototype_commander_fake')).toBeVisible();
    expect(within(detail).getByText('prototype_commander_fake_two')).toBeVisible();
    expect(within(detail).getAllByText('Not retained')).toHaveLength(2);
    expect(within(detail).getByText('Not applicable')).toBeVisible();
    expect(within(detail).queryByRole('button', { name: 'View event timeline' })).toBeNull();
    expect(service.requests.some((request) => request.path.includes('match-explorer-list'))).toBe(
      true,
    );
    expect(service.requests.some((request) => request.path.includes('match-explorer-view'))).toBe(
      true,
    );
  });

  it('offers a way to see more once the listing is not the whole record', async () => {
    await openMatchExplorer((fake) => {
      for (let index = 0; index < 60; index += 1) {
        fake.lab.seedMatchExplorer(
          `match_${String(index).padStart(3, '0')}`,
          matchExplorerViewFixture(`match_${String(index).padStart(3, '0')}`),
        );
      }
    });

    expect(await within(main()).findByText(/60 matches match/i)).toBeVisible();
    await userEvent.click(within(main()).getByRole('button', { name: 'Show more' }));

    expect(await within(main()).findByRole('button', { name: /match_059/ })).toBeVisible();
  });

  it('rejects a malformed deck hash in the filter without sending a new listing request', async () => {
    const { service } = await openMatchExplorer();
    const before = service.requests.filter((request) =>
      request.path.includes('match-explorer-list'),
    ).length;

    await userEvent.type(
      within(main()).getByLabelText('Deck hashes (comma-separated)'),
      'not-a-hash',
    );
    await userEvent.click(within(main()).getByRole('button', { name: 'Show matches' }));

    expect(await within(main()).findByRole('alert')).toBeVisible();
    const after = service.requests.filter((request) =>
      request.path.includes('match-explorer-list'),
    ).length;
    expect(after).toBe(before);
  });

  it('gates the event timeline behind a present raw-event artifact, and pages it', async () => {
    const events = Array.from({ length: 55 }, (_unused, sequence) => ({
      sequence,
      type: 'turn_advanced',
      summary: `Turn advanced to ${String(sequence)}`,
    }));
    const { service } = await openMatchExplorer((fake) => {
      fake.lab.seedMatchExplorer(
        'match_present',
        matchExplorerViewFixture('match_present', {
          artifacts: {
            rawEvent: 'present',
            replay: 'not_retained',
            preActionCapture: 'not_applicable',
          },
        }),
        events,
      );
    });

    await userEvent.click(await within(main()).findByRole('button', { name: /match_present/ }));
    await userEvent.click(
      await within(main()).findByRole('button', { name: 'View event timeline' }),
    );

    expect(await within(main()).findByText('Turn advanced to 0')).toBeVisible();
    await userEvent.click(within(main()).getByRole('button', { name: 'Show more' }));
    expect(await within(main()).findByText('Turn advanced to 54')).toBeVisible();
    expect(
      service.requests.some((request) => request.path.includes('match-explorer-event-timeline')),
    ).toBe(true);
  });

  it('shows an honest note when the raw-event log was not retained', async () => {
    await openMatchExplorer((fake) => {
      fake.lab.seedMatchExplorer('match_1', matchExplorerViewFixture('match_1'));
    });

    await userEvent.click(await within(main()).findByRole('button', { name: /match_1/ }));

    expect(
      await within(main()).findByText(/did not keep this match's raw-event log/),
    ).toBeVisible();
  });

  it('shows selected decision diagnostics for a voluntary termination', async () => {
    await openMatchExplorer((fake) => {
      fake.lab.seedMatchExplorer(
        'match_conceded',
        matchExplorerViewFixture('match_conceded', {
          terminationOrigin: 'concede_action',
          artifacts: {
            rawEvent: 'not_retained',
            replay: 'not_retained',
            preActionCapture: 'present',
          },
          decisionDiagnostics: {
            playerId: 'player_2',
            origin: 'concede_action',
            turn: 4,
            phase: 'main_1',
            activePlayerId: 'player_2',
            sequence: 17,
            inCombat: false,
            reactionWindowOpen: false,
            pendingChoiceOpen: true,
            pendingChoiceType: 'target_selection',
            recentEvents: [{ sequence: 16, type: 'card_played', summary: 'Played a card.' }],
          },
        }),
      );
    });

    await userEvent.click(await within(main()).findByRole('button', { name: /match_conceded/ }));

    expect(await within(main()).findByText('target_selection')).toBeVisible();
    expect(within(main()).getByText('Played a card.')).toBeVisible();
  });

  it('shows the failure state when a match read is refused', async () => {
    const { service } = await openMatchExplorer((fake) => {
      fake.lab.seedMatchExplorer('match_1', matchExplorerViewFixture('match_1'));
    });
    const row = await within(main()).findByRole('button', { name: /match_1/ });
    service.lab.seedMatchExplorer('match_1', { refuse: 'admin/unauthorized' });

    await userEvent.click(row);

    const alert = await within(main()).findByRole('alert');
    expect(alert).toHaveTextContent('admin/unauthorized');
  });
});

describe('cross-navigating from the Match Explorer (M08.26E)', () => {
  it("opens a seat's deck in the Deck Explorer, pre-populated", async () => {
    const { service } = await openMatchExplorer((fake) => {
      fake.lab.seedMatchExplorer('match_1', matchExplorerViewFixture('match_1'));
    });
    service.lab.seedDeckExplorer('0123456789abcdef', deckExplorerViewFixture('0123456789abcdef'));

    await userEvent.click(await within(main()).findByRole('button', { name: /match_1/ }));
    const detail = await within(main()).findByRole('region', { name: 'Match match_1' });
    const openDeckButtons = within(detail).getAllByRole('button', {
      name: 'Open in Deck Explorer',
    });
    await userEvent.click(openDeckButtons[0] as HTMLElement);

    expect(within(main()).getByRole('heading', { level: 2, name: 'Deck Explorer' })).toBeVisible();
    expect(await within(main()).findByLabelText('Deck hash')).toHaveValue('0123456789abcdef');
  });
});

describe('the Representative matches tab (M08.26E)', () => {
  async function openRepresentatives(seed?: (service: FakeService) => void) {
    const opened = await openMatchExplorer(seed);
    await userEvent.click(within(main()).getByRole('button', { name: 'Representative matches' }));
    return opened;
  }

  it('shows all seven categories, each honestly empty when nothing was seeded', async () => {
    await openRepresentatives();

    await userEvent.click(within(main()).getByRole('button', { name: 'Show representatives' }));

    for (const label of [
      'Closest matchup',
      'Largest upset',
      'Most one-sided',
      'Shortest',
      'Longest',
      'Pre-adaptation',
      'Deterministic ordinary sample',
    ]) {
      expect(await within(main()).findByText(label)).toBeVisible();
    }
    expect(within(main()).getAllByText('No eligible match found for this category.')).toHaveLength(
      7,
    );
    expect(
      await within(main()).findByText(
        /No abnormal match — disconnect, server failure or unrecordable — matches this filter/,
      ),
    ).toBeVisible();
  });

  it('opens a populated representative match without leaving the Match Explorer', async () => {
    await openRepresentatives((fake) => {
      fake.lab.seedMatchExplorer('match_rep', matchExplorerViewFixture('match_rep'));
      fake.lab.seedMatchRepresentatives(
        matchRepresentativesViewFixture({
          representatives: REPRESENTATIVE_MATCH_KINDS.map((kind) => ({
            kind,
            match:
              kind === 'closest'
                ? {
                    kind: 'closest' as const,
                    ref: { kind: 'match' as const, matchId: 'match_rep' },
                    observedIn: LIVE_MATCH_EVIDENCE,
                    reason: 'Nearly equal matchup strength.',
                  }
                : null,
          })),
        }),
      );
    });

    await userEvent.click(within(main()).getByRole('button', { name: 'Show representatives' }));
    expect(await within(main()).findByText('Nearly equal matchup strength.')).toBeVisible();

    await userEvent.click(within(main()).getByRole('button', { name: 'Open' }));

    expect(await within(main()).findByRole('region', { name: 'Match match_rep' })).toBeVisible();
  });

  it('lists every abnormal match this filter finds, and pages through more', async () => {
    const { service } = await openRepresentatives((fake) => {
      fake.lab.seedMatchExplorer('match_abnormal_1', matchExplorerViewFixture('match_abnormal_1'));
      fake.lab.seedMatchExplorer('match_abnormal_2', matchExplorerViewFixture('match_abnormal_2'));
      fake.lab.seedMatchRepresentatives(
        matchRepresentativesViewFixture({
          abnormalMatches: {
            items: [
              {
                ref: { kind: 'match', matchId: 'match_abnormal_1' },
                observedIn: LIVE_MATCH_EVIDENCE,
                reason: 'Disconnected mid-match.',
              },
            ],
            page: { returned: 1, limit: PAGE_SIZE_DEFAULT, nextCursor: 'more', total: 2 },
          },
        }),
      );
    });

    await userEvent.click(within(main()).getByRole('button', { name: 'Show representatives' }));
    expect(await within(main()).findByText('Disconnected mid-match.')).toBeVisible();

    service.lab.seedMatchRepresentatives(
      matchRepresentativesViewFixture({
        abnormalMatches: {
          items: [
            {
              ref: { kind: 'match', matchId: 'match_abnormal_2' },
              observedIn: LIVE_MATCH_EVIDENCE,
              reason: 'Server failure mid-match.',
            },
          ],
          page: { returned: 1, limit: PAGE_SIZE_DEFAULT, nextCursor: null, total: 2 },
        },
      }),
    );
    await userEvent.click(within(main()).getByRole('button', { name: 'Show more' }));

    expect(await within(main()).findByText('Server failure mid-match.')).toBeVisible();
    expect(within(main()).getByText('Disconnected mid-match.')).toBeVisible();
    expect(within(main()).queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('rejects a malformed deck hash in the representatives filter without sending a request', async () => {
    const { service } = await openRepresentatives();
    const before = service.requests.filter((request) =>
      request.path.includes('match-representatives'),
    ).length;

    await userEvent.type(
      within(main()).getByLabelText('Deck hashes (comma-separated)'),
      'not-a-hash',
    );
    await userEvent.click(within(main()).getByRole('button', { name: 'Show representatives' }));

    expect(await within(main()).findByRole('alert')).toBeVisible();
    const after = service.requests.filter((request) =>
      request.path.includes('match-representatives'),
    ).length;
    expect(after).toBe(before);
  });
});
