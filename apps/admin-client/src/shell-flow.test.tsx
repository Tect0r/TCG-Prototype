import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ADMIN_SECTIONS } from './sections.js';
import { renderAdmin, stubLayout } from './test/harness.js';
import { fakeService } from './test/fake-service.js';

/**
 * The shell: what it offers, how it is reached from a keyboard, and what it does
 * at two window widths.
 *
 * The checklist line is *keyboard navigation and narrow/wide layouts tested at
 * component level*, and the property that matters most is the negative one: the
 * narrow layout must not be a smaller surface. A shell whose controls appear
 * only when the window is wide is a shell where an administrator's options
 * depend on their window, and that failure is invisible in a screenshot taken at
 * the developer's own width.
 */

async function renderShell() {
  const service = fakeService();
  const harness = renderAdmin({ transport: service.transport });
  await screen.findByRole('heading', { level: 1, name: 'Overview' });
  return harness;
}

describe('what the navigation offers', () => {
  it('is exactly the sections this build can honestly show', async () => {
    await renderShell();

    const nav = screen.getByRole('navigation', { name: 'Lab sections' });
    const entries = within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent);
    expect(entries).toEqual(ADMIN_SECTIONS.map((section) => section.label));
  });

  it('is one entry, because one page is finished', async () => {
    await renderShell();

    // The milestone's information architecture names nine destinations and says
    // a navigation entry arrives with the tranche that makes its page honest. A
    // greyed-out "Queue" leading to "coming soon" is the decorative empty page
    // it forbids, so the list is short rather than aspirational.
    expect(ADMIN_SECTIONS.map((section) => section.id)).toEqual(['overview']);
    expect(
      screen.queryByRole('button', { name: /queue|results|player meta|explorer/i }),
    ).toBeNull();
  });

  it('marks the section in view as the current page', async () => {
    await renderShell();

    const nav = screen.getByRole('navigation', { name: 'Lab sections' });
    expect(within(nav).getByRole('button', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('has one first-level heading, and it names the section', async () => {
    await renderShell();

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Overview');
  });
});

describe('the keyboard', () => {
  it('puts the skip link first in the document, pointing at the main region', async () => {
    await renderShell();

    const tabbable = [
      ...document.querySelectorAll('a[href], button, input, [tabindex]:not([tabindex="-1"])'),
    ];
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(tabbable[0]).toBe(skip);
    expect(skip).toHaveAttribute('href', '#admin-main');
    expect(document.querySelector('#admin-main')?.tagName).toBe('MAIN');
  });

  it('reaches the navigation before the content, in document order', async () => {
    const user = userEvent.setup();
    await renderShell();

    screen.getByRole('link', { name: 'Skip to content' }).focus();
    await user.tab();
    // The banner's connection controls come after the skip link and before the
    // rail in the document, so the first stop after the link is "Check again".
    expect(screen.getByRole('button', { name: 'Check again' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Overview' })).toHaveFocus();
  });

  it('moves focus to the heading when a section is chosen with the keyboard', async () => {
    const user = userEvent.setup();
    await renderShell();

    screen.getByRole('button', { name: 'Overview' }).focus();
    await user.keyboard('{Enter}');

    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toHaveFocus();
  });

  it('activates a section with the space bar as well, because it is a button', async () => {
    const user = userEvent.setup();
    await renderShell();

    screen.getByRole('button', { name: 'Overview' }).focus();
    await user.keyboard(' ');

    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toHaveFocus();
  });

  it('keeps the heading out of the tab order while still being focusable', async () => {
    await renderShell();

    expect(screen.getByRole('heading', { level: 1 })).toHaveAttribute('tabindex', '-1');
  });
});

describe('the two layouts', () => {
  it('reports the wide arrangement when the viewport is wide', async () => {
    stubLayout('wide');
    await renderShell();

    expect(document.querySelector('.admin')).toHaveAttribute('data-layout', 'wide');
  });

  it('reports the narrow arrangement when it is not', async () => {
    stubLayout('narrow');
    await renderShell();

    expect(document.querySelector('.admin')).toHaveAttribute('data-layout', 'narrow');
  });

  it('falls back to the narrow arrangement when the browser cannot be asked', async () => {
    // jsdom with no `matchMedia` stub. Narrow rather than wide, because the
    // narrow arrangement is the one that fits everywhere.
    await renderShell();

    expect(document.querySelector('.admin')).toHaveAttribute('data-layout', 'narrow');
  });

  it('follows the viewport when it changes, without a remount', async () => {
    const layout = stubLayout('narrow');
    await renderShell();

    layout.set('wide');
    await waitFor(() => {
      expect(document.querySelector('.admin')).toHaveAttribute('data-layout', 'wide');
    });
  });

  it('offers every destination and every connection control in both', async () => {
    const layout = stubLayout('narrow');
    await renderShell();

    const present = (): readonly string[] =>
      screen
        .getAllByRole('button')
        .map((button) => button.textContent ?? '')
        .sort();

    const narrow = present();
    layout.set('wide');
    await waitFor(() => {
      expect(document.querySelector('.admin')).toHaveAttribute('data-layout', 'wide');
    });

    expect(present()).toEqual(narrow);
    expect(narrow).toContain('Overview');
    expect(narrow).toContain('Check again');
  });

  it('keeps the document order the same in both, so the tab order does not move', async () => {
    const layout = stubLayout('narrow');
    await renderShell();

    const order = (): readonly string[] =>
      [...document.querySelectorAll('.admin > *')].map((node) => node.className);

    const narrow = order();
    layout.set('wide');
    await waitFor(() => {
      expect(document.querySelector('.admin')).toHaveAttribute('data-layout', 'wide');
    });

    expect(order()).toEqual(narrow);
  });
});
