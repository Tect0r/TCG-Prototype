import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatDatabase } from '@tcg/card-data';
import { DECK_STORAGE_KEY, MemoryStore } from '@tcg/deck';
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

/** Opens the spectator, sets a fixed seed, and plays the match. */
async function startMatch(user: ReturnType<typeof userEvent.setup>, seed = 'ui-test-seed') {
  await user.click(screen.getByRole('button', { name: 'AI Spectator' }));
  const setup = screen.getByRole('region', { name: 'AI Spectator setup' });

  const seedField = within(setup).getByLabelText('Seed');
  await user.clear(seedField);
  await user.type(seedField, seed);

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
