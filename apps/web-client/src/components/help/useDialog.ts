import { useEffect, useRef, type RefObject } from 'react';

/**
 * Modal dialog plumbing shared by the rulebook and the card inspector.
 *
 * Escape closes, focus moves into the panel on open, Tab is trapped inside it,
 * and focus returns to whatever opened it on close. All of that is required for
 * a panel that covers the screen mid-match: a player who opened the rulebook
 * with the keyboard must be able to get back to the board the same way.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialog(open: boolean, onClose: () => void): RefObject<HTMLDivElement | null> {
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** Whatever had focus before the dialog opened, so it can be restored. */
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;

    const panel = panelRef.current;
    openerRef.current = document.activeElement;

    // Focus the panel itself rather than its first control: a screen reader
    // then announces the dialog before its contents.
    panel?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;

      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === panel,
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        // Nothing to tab to: keep focus on the panel rather than letting it
        // escape to the board behind.
        event.preventDefault();
        panel.focus();
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open, onClose]);

  return panelRef;
}
