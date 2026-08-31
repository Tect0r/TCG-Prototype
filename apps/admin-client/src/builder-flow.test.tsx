import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { NO_PLAY_QUALITY_CAVEAT, PRESET_REGISTRY } from '@tcg/admin-contracts';

import { renderAdmin, stubLayout } from './test/harness.js';
import {
  contentCatalogFixture,
  fakeService,
  type FakeServiceOptions,
} from './test/fake-service.js';

/**
 * The New Test Batch screen, driven the way a person drives it.
 *
 * The whole application rather than the component, for the reason M08.7's suites
 * give: what this tranche promises — *the exact total is shown before anything
 * is enqueued*, *disabling mirrored seat orders is advanced and labelled*,
 * *validation against current content* — are properties of the surface, and a
 * test that mounted the form with a hand-made prop would prove that inputs
 * render.
 *
 * The fake service does not compute a schedule the way the estimator does, and
 * it must not: `buildSchedule` is the simulator's and the simulator is
 * server-only. What is asserted here is that the number the client was *given*
 * is the number it shows, and that it declines to enqueue until it has one for
 * the configuration currently on screen.
 */

const CHECKED_AT = new Date('2026-08-24T09:30:00.000Z');

async function openBuilder(options: FakeServiceOptions = {}) {
  stubLayout('wide');
  const service = fakeService(options);
  const harness = renderAdmin({ transport: service.transport, now: () => CHECKED_AT });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  await userEvent.click(screen.getByRole('button', { name: 'New Test Batch' }));
  await screen.findByRole('heading', { level: 1, name: 'New Test Batch' });
  return { ...harness, service };
}

const main = () => screen.getByRole('main');
const priceButton = () => within(main()).getByRole('button', { name: 'Check what this schedules' });
const enqueueButton = () =>
  within(main()).queryByRole('button', { name: 'Enqueue this test batch' });

/* --------------------------------------------------------------- content */

describe('the content the form offers', () => {
  it('is the lab’s own precons and pilots, not a list in this bundle', async () => {
    await openBuilder();

    for (const precon of contentCatalogFixture().precons) {
      expect(within(main()).getByText(precon.name)).toBeInTheDocument();
    }
    for (const pilot of contentCatalogFixture().pilots) {
      expect(within(main()).getByRole('checkbox', { name: pilot.pilotId })).toBeInTheDocument();
    }
  });

  it('shows a precon this environment refuses, disabled, with the reason', async () => {
    // Not filtered out: "this format has three precons" and "this format has
    // four and one of them is broken" are different facts.
    await openBuilder();

    const broken = within(main()).getByRole('checkbox', { name: 'Broken Deck' });
    expect(broken).toBeDisabled();
    expect(broken).not.toBeChecked();
    expect(main().textContent).toContain('cannot be played here');
  });

  it('selects every playable precon by default, and can select all or clear', async () => {
    await openBuilder();

    expect(within(main()).getByRole('checkbox', { name: 'Goblin Swarm' })).toBeChecked();
    await userEvent.click(within(main()).getByRole('button', { name: 'Clear selection' }));
    expect(within(main()).getByRole('checkbox', { name: 'Goblin Swarm' })).not.toBeChecked();

    await userEvent.click(within(main()).getByRole('button', { name: 'Select all' }));
    expect(within(main()).getByRole('checkbox', { name: 'Goblin Swarm' })).toBeChecked();
    // "All" never means the one the environment refuses.
    expect(within(main()).getByRole('checkbox', { name: 'Broken Deck' })).not.toBeChecked();
  });

  it('says the section failed without disconnecting, and offers to ask again', async () => {
    const service = fakeService({ refuse: { content: 'admin/rate_limited' } });
    stubLayout('wide');
    renderAdmin({ transport: service.transport, now: () => CHECKED_AT });
    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    await userEvent.click(screen.getByRole('button', { name: 'New Test Batch' }));

    const alert = await within(main()).findByRole('alert');
    expect(alert).toHaveTextContent('admin/rate_limited');
    expect(within(alert).getByRole('button', { name: 'Ask again' })).toBeInTheDocument();
    // Still connected: the shell and its other destination are untouched.
    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
  });
});

/* ---------------------------------------------------------------- depths */

describe('the depth control', () => {
  it('offers the three precon-benchmark presets with their published limitations', async () => {
    await openBuilder();

    for (const id of ['precon_smoke', 'precon_standard', 'precon_deep'] as const) {
      const preset = PRESET_REGISTRY[id];
      expect(within(main()).getByRole('radio', { name: preset.label })).toBeInTheDocument();
      for (const limitation of preset.limitations) {
        expect(main().textContent).toContain(limitation);
      }
    }
  });

  it('offers no preset from another test style', async () => {
    await openBuilder();
    for (const label of ['Open Meta Search', 'Engine Soak', 'Adaptive Counter Search']) {
      expect(within(main()).queryByRole('radio', { name: label })).toBeNull();
    }
  });
});

/* -------------------------------------------------------------- workload */

describe('the workload and pilot controls', () => {
  it('leaves the custom games field disabled until custom is chosen', async () => {
    await openBuilder();

    const games = within(main()).getByRole('spinbutton', { name: 'Games per seat order' });
    expect(games).toBeDisabled();
    await userEvent.click(within(main()).getByRole('radio', { name: /Set my own/ }));
    expect(games).toBeEnabled();
    expect(main().textContent).toContain('not the support that name implies');
  });

  it('warns when the pilot selection cannot produce balance evidence', async () => {
    await openBuilder();

    // The form opens on the first pilot whose class can carry a play-quality
    // claim, so reaching the warning means deselecting it and selecting one that
    // cannot.
    await userEvent.click(within(main()).getByRole('checkbox', { name: 'aggressive' }));
    await userEvent.click(within(main()).getByRole('checkbox', { name: 'random_legal' }));
    expect(main().textContent).toContain(NO_PLAY_QUALITY_CAVEAT);

    await userEvent.click(within(main()).getByRole('checkbox', { name: 'value' }));
    expect(main().textContent).not.toContain(NO_PLAY_QUALITY_CAVEAT);
  });

  it('bounds the worker request by what the lab said one job may have', async () => {
    await openBuilder();
    const workers = within(main()).getByRole('spinbutton', {
      name: 'Simulator threads to ask for',
    });
    // 7 is `maxWorkersPerJob` in the capabilities fixture.
    expect(workers).toHaveAttribute('max', '7');
    expect(main().textContent).toContain('A request, not a grant');
  });
});

/* ------------------------------------------------ mirrored seat orders */

describe('mirrored seat orders', () => {
  it('are on by default and live behind an advanced disclosure', async () => {
    await openBuilder();

    const mirror = within(main()).getByRole('checkbox', {
      name: 'Play every pairing in both seat orders',
    });
    expect(mirror).toBeChecked();
    expect(within(main()).getByRole('heading', { name: 'Advanced' })).toBeInTheDocument();
    expect(main().textContent).toContain('which is the default');
  });

  it('carry a visible limitation the moment they are turned off', async () => {
    await openBuilder();

    await userEvent.click(
      within(main()).getByRole('checkbox', { name: 'Play every pairing in both seat orders' }),
    );
    expect(main().textContent).toContain('cannot separate deck strength from seat advantage');
  });
});

/* -------------------------------------------------------------- estimate */

describe('the exact total, before anything is enqueued', () => {
  it('is absent until it is asked for, and so is the enqueue', async () => {
    await openBuilder();

    expect(enqueueButton()).toBeNull();
    expect(main().textContent).toContain('No total yet');
  });

  it('shows the number the lab answered with, and the stages behind it', async () => {
    await openBuilder();

    await userEvent.click(priceButton());
    await within(main()).findByText('Stages this configuration schedules');

    // Three playable precons is three pairings — the schedule enumerates
    // combinations of *distinct* decks — each played in both seat orders, four
    // games per seat order, one pilot tuple. 3 x 2 x 4 x 1.
    //
    // Three times on the page, and that is the assertion rather than an
    // accident: the summary sentence, the one stage's row and the enqueue
    // panel's restatement all name the number the lab answered with, so a
    // screen that recomputed any of them would disagree with itself here.
    expect(within(main()).getAllByText('24')).toHaveLength(3);
    expect(main().textContent).toContain('exactly');
    expect(enqueueButton()).toBeInTheDocument();
  });

  it('shows the forced-inclusion floor and the caveat that goes with it', async () => {
    await openBuilder();
    await userEvent.click(priceButton());
    await within(main()).findByText('What the format leaves each Commander');
    expect(main().textContent).toContain('goblin_warboss');
    expect(main().textContent).toContain('forced-inclusion floor');
  });

  it('withdraws the total, and the enqueue with it, when the form changes', async () => {
    // The property that makes "shown before anything is enqueued" structural: an
    // edited form is a different configuration, and the number is about the old
    // one.
    await openBuilder();

    await userEvent.click(priceButton());
    expect(enqueueButton()).toBeInTheDocument();

    await userEvent.click(
      within(main()).getByRole('radio', { name: PRESET_REGISTRY.precon_deep.label }),
    );
    expect(enqueueButton()).toBeNull();
    expect(main().textContent).toContain('no longer about this configuration');

    await userEvent.click(priceButton());
    expect(enqueueButton()).toBeInTheDocument();
  });

  it('keeps the total when only the batch label is renamed', async () => {
    await openBuilder();
    await userEvent.click(priceButton());
    await userEvent.clear(within(main()).getByRole('textbox', { name: 'Batch label' }));
    await userEvent.type(within(main()).getByRole('textbox', { name: 'Batch label' }), 'Renamed');
    expect(enqueueButton()).toBeInTheDocument();
  });

  it('refuses to ask at all while the form is not a request, and says why', async () => {
    await openBuilder();

    await userEvent.click(within(main()).getByRole('button', { name: 'Clear selection' }));
    expect(priceButton()).toBeDisabled();
    expect(within(main()).getByRole('alert').textContent).toContain('at least two precons');
  });
});

/* --------------------------------------------------------- stale content */

describe('a precon that has gone away since the form was filled in', () => {
  it('is refused by the lab, in the lab’s own words, naming the precon', async () => {
    const { service } = await openBuilder();
    service.configure({ withdrawn: ['precon_goblin_swarm'] });

    await userEvent.click(priceButton());
    const alert = await within(main()).findByRole('alert');
    expect(alert.textContent).toContain('precon_goblin_swarm');
    expect(alert.textContent).toContain('admin/schema');
    // And nothing is enqueueable off the back of a refusal.
    expect(enqueueButton()).toBeNull();
  });
});

/* --------------------------------------------------------------- enqueue */

describe('enqueueing', () => {
  it('creates the batch and reports the jobs it made', async () => {
    await openBuilder();

    await userEvent.click(priceButton());
    await userEvent.click(enqueueButton() as HTMLElement);

    const status = await within(main()).findByText(/Enqueued/);
    expect(status.textContent).toContain('1');
    expect(within(main()).getByText('Jobs this enqueue created')).toBeInTheDocument();
    expect(main().textContent).toContain('queued');
  });

  it('creates one job per replicate, which the preview already said', async () => {
    await openBuilder();

    const replicates = within(main()).getByRole('spinbutton', { name: 'Independent replicates' });
    await userEvent.clear(replicates);
    await userEvent.type(replicates, '3');
    await userEvent.click(priceButton());
    expect(main().textContent).toContain('3 jobs');

    await userEvent.click(enqueueButton() as HTMLElement);
    const status = await within(main()).findByText(/Enqueued/);
    expect(status.textContent).toContain('3');
  });

  it('shows the lab’s refusal rather than a paraphrase of it', async () => {
    const { service } = await openBuilder();
    await userEvent.click(priceButton());
    service.configure({ refuse: { createBatch: 'admin/rate_limited' } });

    await userEvent.click(enqueueButton() as HTMLElement);
    const alert = await within(main()).findByRole('alert');
    expect(alert.textContent).toContain('admin/rate_limited');
  });
});

/* -------------------------------------------------- saved configurations */

describe('saving, reopening and duplicating a configuration', () => {
  it('keeps nothing in the browser: the list comes from the lab', async () => {
    const { service } = await openBuilder();
    const asked = service.requests.map((request) => request.path);
    expect(asked.some((path) => path.endsWith('/saved-choices'))).toBe(true);
  });

  it('saves the form under a name and offers it back', async () => {
    await openBuilder();

    await userEvent.type(
      within(main()).getByRole('textbox', { name: 'Name this configuration' }),
      'Three decks, one pilot',
    );
    await userEvent.click(within(main()).getByRole('button', { name: 'Save this configuration' }));

    expect(await within(main()).findByText(/Saved as/)).toBeInTheDocument();
    expect(
      within(main()).getByRole('button', { name: 'Open “Three decks, one pilot”' }),
    ).toBeInTheDocument();
  });

  it('restores every control when a kept configuration is reopened', async () => {
    await openBuilder();

    // Move the form well away from its defaults, keep it, change it again, then
    // reopen — which is the form-restoration property in one gesture.
    await userEvent.click(within(main()).getByRole('radio', { name: /Set my own/ }));
    const games = within(main()).getByRole('spinbutton', { name: 'Games per seat order' });
    await userEvent.clear(games);
    await userEvent.type(games, '7');
    await userEvent.click(
      within(main()).getByRole('checkbox', { name: 'Play every pairing in both seat orders' }),
    );
    await userEvent.type(
      within(main()).getByRole('textbox', { name: 'Name this configuration' }),
      'Seven, one way round',
    );
    await userEvent.click(within(main()).getByRole('button', { name: 'Save this configuration' }));
    await within(main()).findByText(/Saved as/);

    await userEvent.click(
      within(main()).getByRole('radio', { name: PRESET_REGISTRY.precon_smoke.label }),
    );
    await userEvent.click(
      within(main()).getByRole('checkbox', { name: 'Play every pairing in both seat orders' }),
    );

    await userEvent.click(
      within(main()).getByRole('button', { name: 'Open “Seven, one way round”' }),
    );

    expect(within(main()).getByRole('radio', { name: /Set my own/ })).toBeChecked();
    expect(within(main()).getByRole('spinbutton', { name: 'Games per seat order' })).toHaveValue(7);
    expect(
      within(main()).getByRole('checkbox', { name: 'Play every pairing in both seat orders' }),
    ).not.toBeChecked();
  });

  it('withdraws a stale total when a configuration is reopened', async () => {
    await openBuilder();
    await userEvent.type(
      within(main()).getByRole('textbox', { name: 'Name this configuration' }),
      'Kept',
    );
    await userEvent.click(within(main()).getByRole('button', { name: 'Save this configuration' }));
    await within(main()).findByText(/Saved as/);

    await userEvent.click(priceButton());
    expect(enqueueButton()).toBeInTheDocument();

    await userEvent.click(within(main()).getByRole('button', { name: 'Open “Kept”' }));
    expect(enqueueButton()).toBeNull();
  });

  it('duplicates by saving an opened configuration under another name', async () => {
    await openBuilder();

    const nameField = () =>
      within(main()).getByRole('textbox', { name: 'Name this configuration' });
    await userEvent.type(nameField(), 'Original');
    await userEvent.click(within(main()).getByRole('button', { name: 'Save this configuration' }));
    await within(main()).findByText(/Saved as/);

    await userEvent.click(
      within(main()).getByRole('radio', { name: PRESET_REGISTRY.precon_deep.label }),
    );
    await userEvent.type(nameField(), 'Deeper copy');
    await userEvent.click(within(main()).getByRole('button', { name: 'Save this configuration' }));

    expect(
      await within(main()).findByRole('button', { name: 'Open “Deeper copy”' }),
    ).toBeInTheDocument();
    expect(within(main()).getByRole('button', { name: 'Open “Original”' })).toBeInTheDocument();
  });

  it('will not save a form that is not a request', async () => {
    await openBuilder();
    await userEvent.click(within(main()).getByRole('button', { name: 'Clear selection' }));
    await userEvent.type(
      within(main()).getByRole('textbox', { name: 'Name this configuration' }),
      'Broken',
    );
    expect(within(main()).getByRole('button', { name: 'Save this configuration' })).toBeDisabled();
  });
});

/* -------------------------------------------------- what is not on the page */

describe('what the builder deliberately does not show', () => {
  it('offers no estimated runtime and no estimated storage, and says why', async () => {
    await openBuilder();
    await userEvent.click(priceButton());

    expect(main().textContent).toContain('never measured how long a match takes');
    expect(main().textContent).not.toMatch(/estimated (?:runtime|duration) of/i);
  });

  it('offers no chart', async () => {
    await openBuilder();
    await userEvent.click(priceButton());
    expect(main().querySelector('svg')).toBeNull();
    expect(main().querySelector('canvas')).toBeNull();
  });

  it('offers no builder for any other test style', async () => {
    await openBuilder();
    for (const label of ['Commander', 'Open Meta', 'Soak', 'Robustness', 'Candidate']) {
      expect(within(main()).queryByRole('heading', { name: new RegExp(label, 'i') })).toBeNull();
    }
  });
});
