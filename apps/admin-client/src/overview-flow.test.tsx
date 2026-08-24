import {
  MAX_FILTER_VALUES,
  MAX_JOBS_PER_BATCH,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PRESET_REGISTRY,
} from '@tcg/admin-contracts';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderAdmin } from './test/harness.js';
import { fakeService } from './test/fake-service.js';

/**
 * The Overview, checked against the answer it was given.
 *
 * The checklist line is *an honest Overview*, and honesty here has a precise
 * meaning: every value on the page is a field of the `capabilities` or `presets`
 * answer, printed exactly, with no derived score and nothing this bundle knows
 * on its own. So these tests read the same fixture the service answered with and
 * require the page to show it — including the parts that are inconvenient, like
 * a preset this build cannot schedule and a limitation a result may never be
 * cited against.
 */

const CHECKED_AT = new Date('2026-08-24T09:30:00.000Z');

/**
 * One preset's row, found by its own label rather than by any text that matches.
 *
 * `getByText` is ambiguous here for a reason worth keeping: three presets share
 * a test style whose label is the same words as one preset's name — "Open Meta
 * Search" is both — so the row is located by its row header's first line, which
 * is the preset's authored label and nothing else.
 */
function presetRow(label: string): HTMLElement {
  const table = screen.getByRole('table', { name: /presets this build publishes/i });
  const header = within(table)
    .getAllByRole('rowheader')
    .find((cell) => cell.firstElementChild?.textContent === label);
  const row = header?.closest('tr');
  if (!row) throw new Error(`No preset row labelled ${label}`);
  return row;
}

/** The value cell beside one row header, in the fact tables. */
function fact(label: string): string {
  const header = screen.getByRole('rowheader', { name: label });
  const row = header.closest('tr');
  const value = row?.querySelector('td');
  return value?.textContent ?? '';
}

async function renderConnected() {
  const service = fakeService();
  const harness = renderAdmin({ transport: service.transport, now: () => CHECKED_AT });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  return { ...harness, service };
}

describe('the connection panel', () => {
  it('prints the address as a relative path on this page’s own origin', async () => {
    await renderConnected();

    expect(fact('Address')).toContain('/admin/v3');
    expect(fact('Address')).toContain('own origin');
  });

  it('prints the access facts the service reported about itself', async () => {
    await renderConnected();

    expect(fact('Interface')).toContain('Loopback only');
    expect(fact('Authentication')).toContain('No token configured');
  });

  it('prints all three admin version numbers', async () => {
    await renderConnected();

    expect(fact('Admin contract version')).toContain('3');
    expect(fact('Catalog document version')).toContain('3');
    expect(fact('Job event version')).toContain('1');
  });

  it('prints the process start time and how long it has been up at the last check', async () => {
    await renderConnected();

    expect(fact('Process started')).toContain('2026-08-24T09:00:00.000Z');
    expect(fact('Process started')).toContain('Up for 30 minutes');
    expect(fact('Last checked')).toContain('2026-08-24T09:30:00.000Z');
  });
});

describe('the bound and the limits', () => {
  it('prints the three orchestrator numbers the service reported', async () => {
    await renderConnected();

    expect(fact('Experiments at once')).toContain('1');
    expect(fact('Simulator threads, total')).toContain('7');
    expect(fact('Simulator threads per job')).toContain('7');
  });

  it('explains a wait as the bound rather than as a refusal', async () => {
    await renderConnected();

    expect(fact('Experiments at once')).toContain('wait in the queue rather than being refused');
  });

  it('prints every request limit, with the exact byte count beside the readable one', async () => {
    await renderConnected();

    expect(fact('Largest request body')).toContain('131072 bytes');
    expect(fact('Largest request body')).toContain('128 KiB');
    expect(fact('Requests per window')).toContain('240 per 60 seconds');
    expect(fact('Page size')).toContain(
      `${String(PAGE_SIZE_DEFAULT)} by default, ${String(PAGE_SIZE_MAX)} at most`,
    );
    expect(fact('Filter values per field')).toContain(String(MAX_FILTER_VALUES));
    expect(fact('Jobs per batch')).toContain(String(MAX_JOBS_PER_BATCH));
  });
});

describe('evidence and format', () => {
  it('names result roots by identifier and says that is what they are', async () => {
    await renderConnected();

    expect(fact('Result roots')).toContain('default');
    expect(fact('Result roots')).toContain('Identifiers, not paths');
  });

  it('names the format every preset in this build runs', async () => {
    await renderConnected();

    expect(fact('Format')).toContain('precon_wave_1');
  });

  it('shows no filesystem path anywhere on the page', async () => {
    await renderConnected();

    // ADR 0023 §5: an identifier is what a person can act on, and it is not a
    // location. The service never sends one; this is the check that the client
    // never invents one either.
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/[A-Za-z]:\\/);
    expect(text).not.toMatch(/\/(?:home|Users|var|tmp)\//);
  });
});

describe('what this build can run', () => {
  it('lists every preset the service published, with its authored summary', async () => {
    await renderConnected();

    for (const preset of Object.values(PRESET_REGISTRY)) {
      expect(presetRow(preset.label).textContent).toContain(preset.summary);
    }
  });

  it('shows each preset’s published limitations, because a result carries them', async () => {
    await renderConnected();

    for (const preset of Object.values(PRESET_REGISTRY)) {
      for (const limitation of preset.limitations) {
        expect(presetRow(preset.label).textContent).toContain(limitation);
      }
    }
  });

  it('says outright that a reserved preset cannot be scheduled by this build', async () => {
    await renderConnected();

    const row = presetRow(PRESET_REGISTRY.adaptive_counter.label);
    expect(row.textContent).toContain('Reserved — this build cannot schedule one');
    // No kinds and no source classes, printed as the em dash that means "none"
    // rather than as an empty cell a reader could mistake for "not loaded".
    expect(row.textContent).toContain('—');
  });

  it('keeps evidence classes distinguishable on the row that produces them', async () => {
    await renderConnected();

    const row = presetRow(PRESET_REGISTRY.precon_smoke.label);
    expect(row.textContent).toContain('AI, Precon');
    expect(row.textContent).toContain('Precon Benchmark');
  });

  it('offers nothing that starts a run', async () => {
    await renderConnected();

    // M08.8 owns the builder. A shell that offered an enqueue control would be
    // the decorative half of a page nobody can finish.
    for (const label of ['Start', 'Run', 'Enqueue', 'New test batch']) {
      expect(
        screen.queryByRole('button', { name: new RegExp(label, 'i') }),
      ).not.toBeInTheDocument();
    }
  });
});

describe('when a reading fails or is stale', () => {
  it('shows the preset section as failed while the connection stays up', async () => {
    const service = fakeService({ refuse: { presets: 'admin/rate_limited' } });
    renderAdmin({ transport: service.transport, now: () => CHECKED_AT });

    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('admin/rate_limited');
    // The connection panel is still there: one section failed, not the page.
    expect(fact('Format')).toContain('precon_wave_1');
  });

  it('reloads the preset section alone when asked again', async () => {
    const user = userEvent.setup();
    const service = fakeService({ refuse: { presets: 'admin/rate_limited' } });
    renderAdmin({ transport: service.transport, now: () => CHECKED_AT });

    await screen.findByRole('button', { name: 'Ask again' });
    service.configure({});
    await user.click(screen.getByRole('button', { name: 'Ask again' }));

    await screen.findByRole('table', { name: /presets this build publishes/i });
    expect(presetRow(PRESET_REGISTRY.precon_smoke.label)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reports a restart of the orchestration process, and what it means', async () => {
    const user = userEvent.setup();
    const service = fakeService();
    renderAdmin({ transport: service.transport, now: () => CHECKED_AT });
    await screen.findByRole('heading', { level: 1, name: 'Overview' });

    service.configure({ capabilities: { startedAt: '2026-08-24T09:29:00.000Z' } });
    await user.click(screen.getByRole('button', { name: 'Check again' }));

    const notice = await screen.findByText(/has restarted since this page last asked/i);
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toContain('recovered as interrupted');
    expect(notice.textContent).toContain('nothing resumes on its own');
  });

  it('does not announce a restart when nothing restarted', async () => {
    const user = userEvent.setup();
    const service = fakeService();
    renderAdmin({ transport: service.transport, now: () => CHECKED_AT });
    await screen.findByRole('heading', { level: 1, name: 'Overview' });

    await user.click(screen.getByRole('button', { name: 'Check again' }));

    expect(screen.queryByText(/has restarted/i)).not.toBeInTheDocument();
  });
});
