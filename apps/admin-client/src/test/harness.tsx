import { act, render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';

import { App } from '../App.js';
import { WIDE_LAYOUT_QUERY, type LayoutMode } from '../lib/layout.js';
import { AdminSession } from '../net/session.js';
import type { AdminTransport } from '../net/transport.js';
import { AdminProvider } from '../state/AdminContext.js';

/**
 * Rendering the whole application against a lab that answers.
 *
 * The application rather than a component in isolation, because the properties
 * this tranche promises — *authenticated connection state*, an *honest
 * Overview*, global loading, error and empty states — are properties of the
 * shell as a whole, and a test that mounted `OverviewScreen` with a hand-made
 * prop would prove that a table renders rather than that the surface behaves.
 */

export interface HarnessOptions {
  readonly transport: AdminTransport;
  readonly now?: () => Date;
}

export interface Harness extends RenderResult {
  readonly session: AdminSession;
}

export function renderAdmin(options: HarnessOptions): Harness {
  const session = new AdminSession({
    transport: options.transport,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const result = render(
    <AdminProvider session={session}>
      <App />
    </AdminProvider>,
  );
  return { ...result, session };
}

/**
 * jsdom has no `matchMedia`, so a layout has to be stated rather than measured.
 *
 * The stub answers the shell's own query and nothing else — a test that asked
 * about a different breakpoint would get `false`, which is the honest answer for
 * a query this stub was not told about. `set` dispatches a `change` event the
 * way a real viewport does, so the listener path is exercised rather than only
 * the first read.
 */
export function stubLayout(initial: LayoutMode): { set(mode: LayoutMode): void } {
  let mode = initial;
  const listeners = new Set<() => void>();

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query,
      // A getter rather than a value: the shell reads `matches` again when it is
      // told the viewport changed, and a snapshot taken when the query object
      // was made would answer with the width the page opened at forever.
      get matches() {
        return query === WIDE_LAYOUT_QUERY && mode === 'wide';
      },
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
      addListener: (listener: () => void) => listeners.add(listener),
      removeListener: (listener: () => void) => listeners.delete(listener),
      dispatchEvent: () => true,
      onchange: null,
    }),
  });

  return {
    set(next) {
      mode = next;
      // Inside `act`, because a viewport change is a real event that produces a
      // React update, and an update outside `act` is one the assertion after it
      // may not have seen.
      act(() => {
        for (const listener of [...listeners]) listener();
      });
    },
  };
}
