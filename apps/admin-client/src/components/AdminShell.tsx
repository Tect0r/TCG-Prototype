import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { useLayoutMode } from '../lib/layout.js';
import { ADMIN_SECTIONS, sectionById, type AdminSectionId } from '../sections.js';

/**
 * The layout every administrator screen sits in: a banner, a navigation
 * landmark, and one main region.
 *
 * ## What the two layouts do and do not change
 *
 * `data-layout` is `wide` or `narrow`, read from the same media query the
 * stylesheet uses, and it changes **arrangement only**. The navigation is a rail
 * beside the content at wide widths and a row above it at narrow ones; the DOM
 * order is identical in both, because a layout that reorders the document for
 * one viewport reorders the tab order with it.
 *
 * What it must never change is *what is on the page*. A narrow layout that
 * dropped a control would be a shell where an administrator's options depend on
 * their window, and the component test requires every destination and every
 * connection control to be present in both modes.
 *
 * ## Keyboard order is the document's, and the first stop is the way out of it
 *
 * A skip link is the first focusable element, because the navigation is the
 * first landmark and everything after it is repeated on every screen. The
 * heading of the main region takes focus when a destination is chosen, so a
 * keyboard user lands where the content changed rather than staying on a
 * navigation item that no longer describes what is in front of them; it is
 * `tabIndex={-1}` so it is a focus target without joining the tab order.
 *
 * `aria-current="page"` marks the destination in view. The buttons are ordinary
 * buttons rather than a `tablist`, because these are pages rather than panels
 * and arrow-key navigation would be a second, undiscoverable interaction model
 * over the one every browser already gives.
 */

interface AdminShellProps {
  readonly section: AdminSectionId;
  readonly onSelectSection: (id: AdminSectionId) => void;
  /** The connection badge and its controls. Rendered in the banner, in both layouts. */
  readonly connection: ReactNode;
  readonly children: ReactNode;
}

export function AdminShell({ section, onSelectSection, connection, children }: AdminShellProps) {
  const layout = useLayoutMode();
  const heading = useRef<HTMLHeadingElement>(null);
  const current = sectionById(section);

  useEffect(() => {
    heading.current?.focus();
  }, [section]);

  return (
    <div className="admin" data-layout={layout}>
      <a className="skip-link" href="#admin-main">
        Skip to content
      </a>

      <header className="admin__banner">
        <div className="admin__brand">
          <p className="admin__product">AI Lab</p>
          <p className="admin__scope">Administrator surface · local orchestration process</p>
        </div>
        <div className="admin__connection">{connection}</div>
      </header>

      <nav className="admin__nav" aria-label="Lab sections">
        <ul>
          {ADMIN_SECTIONS.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className={entry.id === section ? 'is-current' : ''}
                aria-current={entry.id === section ? 'page' : undefined}
                onClick={() => {
                  onSelectSection(entry.id);
                  heading.current?.focus();
                }}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <main className="admin__main" id="admin-main">
        <h1 className="admin__title" ref={heading} tabIndex={-1}>
          {current.title}
        </h1>
        <p className="admin__summary">{current.summary}</p>
        {children}
      </main>
    </div>
  );
}
