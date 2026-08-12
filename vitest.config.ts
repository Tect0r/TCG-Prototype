import { defineConfig } from 'vitest/config';

/**
 * Root test runner. Package tests are pure Node; the web client brings its own
 * config (jsdom + the Vite React setup) so it is referenced by path. The
 * `scripts` project covers the repository-level tooling in `scripts/`, which is
 * outside every workspace and would otherwise run untested.
 *
 * The Node projects get a generous per-test timeout because the Phase 4 suites
 * play whole matches: a defensive mirror runs to deck-out over ~50 turns, and a
 * batch test plays dozens of them. That is real work, not a hang — the runner's
 * own turn/action limits are what catch a genuine loop (CLAUDE.md §13.5).
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'packages',
          root: import.meta.dirname,
          include: ['packages/*/src/**/*.test.ts'],
          environment: 'node',
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'server',
          root: import.meta.dirname,
          include: ['apps/multiplayer-server/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'scripts',
          root: import.meta.dirname,
          include: ['scripts/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'simulator',
          root: import.meta.dirname,
          include: ['apps/simulator/src/**/*.test.ts'],
          environment: 'node',
          testTimeout: 120_000,
        },
      },
      './apps/web-client',
    ],
  },
});
