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
 *
 * The `server` project joined them in M09.7, for the same reason rather than a
 * new one: its mixed human/bot suites play complete two-to-four-seat matches
 * through `receive`, several per test, and one of them replays the same table
 * three times over. A hang there is still caught by something real — the
 * runner's per-seat decision limit and each test loop's own round ceiling — so
 * the 5-second default was only ever catching machine load.
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
          testTimeout: 60_000,
        },
      },
      {
        test: {
          // The admin catalog (M08.2). Every suite writes real files under a
          // temporary root and reads them back, because "a reader never sees
          // half a document" and "a restart never recovers running work as
          // completed" are claims about a filesystem, and a mocked one would
          // only prove the mock agrees with the code.
          name: 'admin-server',
          root: import.meta.dirname,
          include: ['apps/admin-server/src/**/*.test.ts'],
          environment: 'node',
          // M08.4's job-runner suite plays real matches: the bridge from a
          // catalog job to a canonical experiment directory is only proven by
          // driving the simulator's own `runExperiment` into a real directory
          // and reading the manifest it wrote. Same reason as the projects
          // above, and the same ceiling.
          testTimeout: 60_000,
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
      // The administrator bundle (M08.7). Its own config for the same reason the
      // player client has one — jsdom plus the Vite React setup — and its own
      // project rather than a folder inside the player's, because the two are
      // separate applications and a shared runner would be the first place they
      // stopped being separate.
      './apps/admin-client',
    ],
  },
});
