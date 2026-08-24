import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * The administrator bundle — its own Vite application, its own `index.html` and
 * its own output directory (ADR 0023 §1). Nothing here is reachable from
 * `@tcg/web-client`, and a player build that has never heard of this file cannot
 * ship an admin control by accident.
 *
 * ## The origin policy M08.6 left for this tranche
 *
 * M08.6 recorded it as a limitation in as many words: *no CORS headers are sent,
 * and M08.7 has to decide the origin policy... choosing its origin policy here —
 * before the client exists and with no way to test the choice — would be widening
 * the boundary on a guess.* The decision is to **keep sending none**, and to make
 * the browser's request same-origin instead: this dev server forwards `/admin` to
 * the orchestration process, so the page and the API share an origin and the
 * question of which other origins may read an answer never arises.
 *
 * The alternative — teaching `apps/admin-server` an allowed-origin list — was
 * rejected because it turns a closed door into a configurable one. A CORS
 * allowance is a standing statement that *some* other origin may read a lab's
 * answers, and the value that decides which one would be configuration on the
 * same machine that holds the token. A proxy needs no such statement: the server
 * keeps refusing every cross-origin reader, including this one, and what crosses
 * the boundary is a Node process the operator started, not a page somebody
 * visited.
 *
 * Both `server` and `preview` carry it, so a built bundle behaves the way the dev
 * one does rather than working only under `vite dev`.
 *
 * `changeOrigin` stays off deliberately. The service binds loopback and does not
 * route on `Host`, and rewriting the header would put a name in a request the
 * operator never typed.
 *
 * ## The two constants below are the service's, restated
 *
 * `apps/admin-client` must not import `apps/admin-server` — that is the boundary
 * this whole workspace exists to keep — so the default host and port are written
 * here rather than imported. `boundary.test.ts` reads both files and fails when
 * they disagree, which is the only honest way to hold a restated constant still.
 * `TCG_ADMIN_HOST` and `TCG_ADMIN_PORT` are the *same* environment keys the
 * service reads, so one setting moves both ends.
 */

/** Where the orchestration process listens when nobody has said otherwise. */
const ADMIN_SERVICE_HOST = process.env.TCG_ADMIN_HOST ?? '127.0.0.1';
const ADMIN_SERVICE_PORT = process.env.TCG_ADMIN_PORT ?? '8788';

const adminProxy = {
  '/admin': {
    target: `http://${ADMIN_SERVICE_HOST}:${ADMIN_SERVICE_PORT}`,
    changeOrigin: false,
  },
};

export default defineConfig({
  plugins: [react()],
  // No public directory: the lab serves no card art and no static asset, and a
  // shared one would put the player's `assets/` on the administrator's origin.
  publicDir: false,
  server: { port: 5174, proxy: adminProxy },
  preview: { port: 5174, proxy: adminProxy },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    name: 'admin-client',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
