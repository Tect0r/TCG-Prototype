import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * `publicDir` points at the repo-level `assets/` folder so card art is served
 * straight from `assets/card-art/<card_id>.png` with no build step and no copy:
 * dropping a correctly named PNG in there is all it takes (CLAUDE.md §6).
 */
export default defineConfig({
  plugins: [react()],
  publicDir: fileURLToPath(new URL('../../assets', import.meta.url)),
  server: { port: 5173 },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    name: 'web-client',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
