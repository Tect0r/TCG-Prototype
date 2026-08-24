import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * The player client's setup clears `window.localStorage` between tests. This one
 * deliberately does not, and the absence is the point: ADR 0023 §4 says the
 * administrator token is never *anything the browser persists*, so this
 * application writes to no storage at all and `boundary.test.ts` reads its
 * sources to keep that true. A teardown that cleared storage would quietly make
 * a future violation invisible.
 *
 * What it does remove is the layout stub. `stubLayout` installs a `matchMedia`
 * on the window, and the window is shared by every test in a file — so a test
 * that meant to check the no-`matchMedia` fallback would silently be checking
 * whatever the previous test installed, and would pass for the wrong reason.
 */
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'matchMedia');
});
