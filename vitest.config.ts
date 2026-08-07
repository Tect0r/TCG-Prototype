import { defineConfig } from 'vitest/config';

/**
 * Root test runner. Package tests are pure Node; the web client brings its own
 * config (jsdom + the Vite React setup) so it is referenced by path.
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
        },
      },
      './apps/web-client',
    ],
  },
});
