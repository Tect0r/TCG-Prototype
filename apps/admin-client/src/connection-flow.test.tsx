import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderAdmin } from './test/harness.js';
import { fakeService } from './test/fake-service.js';

/**
 * The connection, from the operator's side.
 *
 * The tranche's checklist line is *authenticated connection state*, and the
 * behaviour it names is what these drive: the application asks first and prompts
 * second, it shows the service's own refusal rather than a paraphrase, it holds
 * the token for exactly as long as the tab is open, and it never shows a
 * navigation rail over a connection it does not have.
 */

const TOKEN = 'z'.repeat(32);

describe('a lab that needs no token', () => {
  it('connects without ever showing a token field', async () => {
    renderAdmin({ transport: fakeService().transport });

    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Administrator token')).not.toBeInTheDocument();
    expect(screen.getByText(/no token required/i)).toBeInTheDocument();
  });

  it('offers no way to forget a token it is not holding', async () => {
    renderAdmin({ transport: fakeService().transport });

    await screen.findByRole('heading', { level: 1, name: 'Overview' });
    expect(screen.queryByRole('button', { name: 'Forget token' })).not.toBeInTheDocument();
  });
});

describe('a lab that requires a token', () => {
  it('shows the gate instead of the shell, with no navigation behind it', async () => {
    renderAdmin({ transport: fakeService({ token: TOKEN }).transport });

    expect(
      await screen.findByRole('heading', { name: /requires an administrator token/i }),
    ).toBeInTheDocument();
    // Nothing to navigate to, so nothing pretends there is.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Overview' })).not.toBeInTheDocument();
  });

  it('says what the token is and is not, before it is typed', async () => {
    renderAdmin({ transport: fakeService({ token: TOKEN }).transport });

    await screen.findByLabelText('Administrator token');
    expect(screen.getByText(/held in this tab only/i)).toBeInTheDocument();
    expect(screen.getByText(/entered again after a reload/i)).toBeInTheDocument();
  });

  it('will not send an empty field', async () => {
    renderAdmin({ transport: fakeService({ token: TOKEN }).transport });

    await screen.findByLabelText('Administrator token');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('connects on the right token and reports the connection as authenticated', async () => {
    const user = userEvent.setup();
    renderAdmin({ transport: fakeService({ token: TOKEN }).transport });

    await user.type(await screen.findByLabelText('Administrator token'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText(/token required/i)).toBeInTheDocument();
    expect(screen.getByText(/sending the token, and holds it in memory only/i)).toBeInTheDocument();
  });

  it('prints the service’s own refusal when the token is wrong', async () => {
    const user = userEvent.setup();
    renderAdmin({ transport: fakeService({ token: TOKEN }).transport });

    await user.type(await screen.findByLabelText('Administrator token'), 'not-the-token');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('admin/unauthorized');
    expect(alert).toHaveTextContent(/requires an administrator token in the/i);
  });

  it('clears the field after a refusal, so a retry does not re-send the old value', async () => {
    const user = userEvent.setup();
    renderAdmin({ transport: fakeService({ token: TOKEN }).transport });

    const field = await screen.findByLabelText('Administrator token');
    await user.type(field, 'not-the-token');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await screen.findByRole('alert');
    expect(await screen.findByLabelText('Administrator token')).toHaveValue('');
  });

  it('does not put the token into the address or the body of any request', async () => {
    const user = userEvent.setup();
    const service = fakeService({ token: TOKEN });
    renderAdmin({ transport: service.transport });

    await user.type(await screen.findByLabelText('Administrator token'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('heading', { level: 1, name: 'Overview' });

    expect(service.requests.length).toBeGreaterThan(1);
    for (const request of service.requests) {
      expect(request.path).not.toContain(TOKEN);
      expect(request.body).not.toContain(TOKEN);
    }
  });

  it('writes nothing to storage the browser keeps', async () => {
    const user = userEvent.setup();
    renderAdmin({ transport: fakeService({ token: TOKEN }).transport });

    await user.type(await screen.findByLabelText('Administrator token'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('heading', { level: 1, name: 'Overview' });

    // ADR 0023 §4: never anything the browser persists. The boundary suite reads
    // the sources for the same claim; this one watches the real APIs.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });

  it('returns to the gate when the token is forgotten', async () => {
    const user = userEvent.setup();
    renderAdmin({ transport: fakeService({ token: TOKEN }).transport });

    await user.type(await screen.findByLabelText('Administrator token'), TOKEN);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByRole('heading', { level: 1, name: 'Overview' });

    await user.click(screen.getByRole('button', { name: 'Forget token' }));

    expect(
      await screen.findByRole('heading', { name: /requires an administrator token/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

describe('a lab that is not running', () => {
  it('says so, and offers to ask again rather than showing an empty page', async () => {
    const service = fakeService({ unreachable: true });
    renderAdmin({ transport: service.transport });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/did not answer/i);
    expect(screen.getByRole('heading', { name: 'The lab did not answer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('connects on a retry once the process is up', async () => {
    const user = userEvent.setup();
    const service = fakeService({ unreachable: true });
    renderAdmin({ transport: service.transport });

    await screen.findByRole('button', { name: 'Try again' });
    service.configure({});
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  });

  it('does not offer a retry for a version mismatch, and says why', async () => {
    renderAdmin({
      transport: () =>
        Promise.resolve({
          status: 200,
          body: JSON.stringify({ ok: true, contractVersion: 99, payload: {} }),
        }),
    });

    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent(/newer build/i);
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByText(/same revision/i)).toBeInTheDocument();
  });

  it('shows a busy state while the first question is outstanding', async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = fakeService();
    renderAdmin({
      transport: async (request) => {
        await pending;
        return service.transport(request);
      },
    });

    expect(await screen.findByRole('status')).toHaveTextContent(/what it is/i);
    release();
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
    });
  });
});
