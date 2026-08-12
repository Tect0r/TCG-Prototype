import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatDatabase } from '@tcg/card-data';
import { DECK_STORAGE_KEY, MemoryStore } from '@tcg/deck';
import { DEFAULT_RULES_CONFIG } from '@tcg/rules-engine';
import {
  cardPoolHash,
  defaultSpectatorSetup,
  resolveSpectatorSetup,
  runSpectatorMatch,
  setupProvenance,
  spectatorDatabase,
} from '@tcg/spectator';
import { SpectatorSummary } from './components/spectator/SpectatorSummary.js';
import { App } from './App.js';
import { AppProvider } from './state/AppContext.js';
import { MatchProvider } from './state/MatchContext.js';

/**
 * The AI Spectator screen, driven through the real UI.
 *
 * The match it watches is a genuine four-bot match played by the real engine
 * and the real pilots — nothing here is a fixture — so these assertions are
 * about the shipping path: configure, run, watch, and never leak a hand while
 * doing it.
 */

function renderApp() {
  const store = new MemoryStore();
  store.setItem(DECK_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, decks: [] }));
  return render(
    <AppProvider database={formatDatabase('precon_wave_1')} store={store}>
      <MatchProvider>
        <App />
      </MatchProvider>
    </AppProvider>,
  );
}

/** The developer override, by the words the screen puts on it. */
const OVERRIDE_LABEL = /Developer: run decks containing cards that are not implemented yet/;

/** Opens the spectator, sets a fixed seed, and plays the match. */
async function startMatch(user: ReturnType<typeof userEvent.setup>, seed = 'ui-test-seed') {
  await user.click(screen.getByRole('button', { name: 'AI Spectator' }));
  const setup = screen.getByRole('region', { name: 'AI Spectator setup' });

  const seedField = within(setup).getByLabelText('Seed');
  await user.clear(seedField);
  await user.type(seedField, seed);

  // Since M02.5 every shipped precon is finished, so the default configuration
  // starts on its own and the override is not touched. Up to M02.4 this line
  // clicked it, and everything the suite watched was marked invalid.
  await user.click(within(setup).getByRole('button', { name: 'Start Match' }));
  // The match is played synchronously once the "running" state has painted.
  await waitFor(
    () => expect(screen.getByRole('group', { name: 'Playback controls' })).toBeTruthy(),
    { timeout: 30_000 },
  );

  // Playback starts running. Pause and rewind, so every test below drives the
  // position itself rather than racing a timer.
  const controls = screen.getByRole('group', { name: 'Playback controls' });
  await user.click(within(controls).getByRole('button', { name: 'Pause' }));
  await user.click(within(controls).getByRole('button', { name: 'Restart' }));
}

describe('AI Spectator', () => {
  it('configures four bots on precons and plays a complete match', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('button', { name: 'AI Spectator' }));
    const setup = screen.getByRole('region', { name: 'AI Spectator setup' });

    // Four seats by default, each with a precon and a strategy.
    for (let seat = 1; seat <= 4; seat += 1) {
      expect(within(setup).getByLabelText(`Bot ${seat} precon`)).toBeTruthy();
      expect(within(setup).getByLabelText(`Bot ${seat} strategy`)).toBeTruthy();
    }

    await startMatch(user);

    const controls = screen.getByRole('group', { name: 'Playback controls' });
    expect(within(controls).getByRole('button', { name: 'Play' })).toBeTruthy();

    expect(within(controls).getByRole('button', { name: 'Step' })).toBeTruthy();
    expect(within(controls).getByRole('button', { name: 'Restart' })).toBeTruthy();
    expect(within(controls).getByLabelText('Playback speed')).toBeTruthy();
    expect(within(controls).getByLabelText('Information mode')).toBeTruthy();
  }, 40_000);

  it('starts on the shipped decks with no override at all (M02.5)', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('button', { name: 'AI Spectator' }));
    const setup = screen.getByRole('region', { name: 'AI Spectator setup' });

    // Up to M02.4 the default configuration was blocked and named the cards
    // blocking it. Every Wave 1 card is implemented now, so it is ready to run
    // as it stands — nothing to explain, nothing to tick.
    expect(within(setup).queryByRole('alert')).toBeNull();
    expect(within(setup).getByRole('button', { name: 'Start Match' })).toBeEnabled();
    expect(within(setup).getByLabelText(OVERRIDE_LABEL)).not.toBeChecked();
    expect(within(setup).queryByText(/Results invalid\./)).toBeNull();
  }, 40_000);

  it('shows no "results invalid" warning on a match that counts', async () => {
    const user = userEvent.setup();
    renderApp();
    await startMatch(user);

    expect(document.querySelector('.spectator__invalid')).toBeNull();

    const controls = screen.getByRole('group', { name: 'Playback controls' });
    await user.click(within(controls).getByRole('button', { name: 'Skip to result' }));
    const summary = await screen.findByRole(
      'region',
      { name: 'Match result' },
      { timeout: 20_000 },
    );
    expect(within(summary).queryByText(/Results invalid\./)).toBeNull();
  }, 40_000);

  it('still warns on the result screen when a replay says the result does not count', async () => {
    // The warning is driven entirely by `provenance.resultsValid`, and no
    // shipped deck can make that false any more — the override has nothing left
    // to override. So a real replay is run and its provenance replaced, which
    // keeps the wording checked against a real render rather than deleting the
    // assertion along with the last unfinished card (M02.5).
    const database = spectatorDatabase();
    const resolved = resolveSpectatorSetup(defaultSpectatorSetup('summary-warning', 2));
    expect(resolved.problems).toEqual([]);
    const replay = await runSpectatorMatch({
      seed: 'summary-warning',
      seats: resolved.seats,
      database,
      config: DEFAULT_RULES_CONFIG,
      cardDataHash: cardPoolHash(database),
      provenance: setupProvenance(resolved),
    });

    const invalid = render(
      <SpectatorSummary
        replay={{
          ...replay,
          provenance: {
            resultsValid: false,
            incompleteCards: [
              {
                playerId: 'player_1',
                preconId: 'precon_grave_sacrifice',
                cardIds: ['equal_price'],
              },
            ],
          },
        }}
      />,
    );
    expect(within(invalid.container).getByText(/Results invalid\./)).toBeTruthy();
    invalid.unmount();
  }, 40_000);

  it('shows two to four boards and never a bot hand in Normal Spectator', async () => {
    const user = userEvent.setup();
    renderApp();
    await startMatch(user);

    // Every seat's board is on screen…
    const board = document.querySelector('.spectator-board');
    expect(board).toBeTruthy();
    expect(board?.querySelectorAll('.spectator-seat').length).toBe(4);

    // …and not one hand is, because Normal Spectator hides them all.
    expect(document.querySelectorAll('.spectator-seat__hand')).toHaveLength(0);
    expect(document.querySelectorAll('.spectator-hand-card')).toHaveLength(0);
  }, 40_000);

  it('reveals every hand in Analysis Mode, and hides them again on the way back', async () => {
    const user = userEvent.setup();
    renderApp();
    await startMatch(user);

    // Step forward so there is something in a hand to reveal.
    const controls = screen.getByRole('group', { name: 'Playback controls' });
    for (let step = 0; step < 6; step += 1) {
      await user.click(within(controls).getByRole('button', { name: 'Step' }));
    }

    await user.selectOptions(within(controls).getByLabelText('Information mode'), 'analysis');
    await waitFor(() => expect(document.querySelectorAll('.spectator-seat__hand').length).toBe(4));
    expect(document.querySelectorAll('.spectator-hand-card').length).toBeGreaterThan(0);

    await user.selectOptions(within(controls).getByLabelText('Information mode'), 'normal');
    await waitFor(() => expect(document.querySelectorAll('.spectator-seat__hand')).toHaveLength(0));
  }, 40_000);

  it('steps and restarts without changing what the log says', async () => {
    const user = userEvent.setup();
    renderApp();
    await startMatch(user);

    const controls = screen.getByRole('group', { name: 'Playback controls' });
    const step = within(controls).getByRole('button', { name: 'Step' });

    await user.click(step);
    await user.click(step);
    await user.click(step);

    const readLog = (): string[] =>
      [...document.querySelectorAll('.spectator__log li')].map((item) => item.textContent ?? '');
    const first = readLog();
    expect(first).toHaveLength(3);

    await user.click(within(controls).getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(readLog()).toHaveLength(0));

    await user.click(step);
    await user.click(step);
    await user.click(step);
    // Restarting replays the same events in the same order: the log is a
    // function of the position, not of how the viewer got there.
    expect(readLog()).toEqual(first);
  }, 40_000);

  it('skips to the result and shows the board-size telemetry', async () => {
    const user = userEvent.setup();
    renderApp();
    await startMatch(user);

    const controls = screen.getByRole('group', { name: 'Playback controls' });
    await user.click(within(controls).getByRole('button', { name: 'Skip to result' }));

    const summary = await screen.findByRole(
      'region',
      { name: 'Match result' },
      { timeout: 20_000 },
    );
    expect(within(summary).getByText(/Peak units/)).toBeTruthy();
    expect(within(summary).getByText(/Largest stack/)).toBeTruthy();
    expect(within(summary).getByText(/Cmdr defeats/)).toBeTruthy();
    expect(within(summary).getByText(/Board stall/)).toBeTruthy();
    // The caveat is not decoration: a single match is not balance evidence.
    expect(within(summary).getByText(/not about whether they are balanced/)).toBeTruthy();
  }, 40_000);

  it('leaves the deck builder and the online match screens untouched', async () => {
    const user = userEvent.setup();
    renderApp();
    await startMatch(user);

    await user.click(screen.getByRole('button', { name: 'Deck Builder' }));
    expect(screen.getByRole('heading', { name: 'Deck Builder' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('heading', { name: 'Match' })).toBeTruthy();
  }, 40_000);
});
