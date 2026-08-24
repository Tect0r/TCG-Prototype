import { useEffect, useState } from 'react';

/**
 * Which of the two layouts the shell is in, as a value rather than only as CSS.
 *
 * The narrow and wide arrangements differ in more than spacing: wide puts the
 * navigation beside the content as a rail, narrow puts it above as a row, and
 * the two need different ARIA orientation and different tab order relative to
 * the main region. A pure media query cannot say which one is in force, so a
 * component test could only assert that a class name exists — which is a test of
 * a stylesheet rather than of a layout.
 *
 * Reading it here makes both arrangements checkable: a test stubs `matchMedia`
 * and requires that every navigation destination is present, reachable and
 * correctly oriented in each. The same query drives the stylesheet, so the two
 * cannot disagree about where the boundary is.
 */

/** The one breakpoint this shell has. Kept beside the stylesheet's own copy. */
export const WIDE_LAYOUT_QUERY = '(min-width: 60rem)';

export type LayoutMode = 'narrow' | 'wide';

/**
 * A browser with no `matchMedia` — jsdom without a stub, an old embedded view —
 * gets the narrow layout.
 *
 * Narrow rather than wide on purpose: the narrow arrangement is the one that
 * fits everywhere, so an unknown viewport is served the layout that cannot be
 * too small for it.
 */
function readMode(): LayoutMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'narrow';
  return window.matchMedia(WIDE_LAYOUT_QUERY).matches ? 'wide' : 'narrow';
}

export function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(readMode);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(WIDE_LAYOUT_QUERY);
    const update = (): void => {
      setMode(query.matches ? 'wide' : 'narrow');
    };
    update();
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);

  return mode;
}
