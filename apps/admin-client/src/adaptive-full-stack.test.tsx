import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AdminService,
  ExperimentRunner,
  JobQueue,
  openFileCatalogStore,
  parseServiceConfig,
  startAdminHttpServer,
  type AdminHttpServer,
} from '@tcg/admin-server';
import { unwrap } from '@tcg/shared';

import { renderAdmin, stubLayout } from './test/harness.js';
import type { AdminHttpRequest, AdminHttpReply, AdminTransport } from './net/transport.js';

/**
 * The milestone's own acceptance line for M08.R6: a full-stack test from form
 * submission through persisted job, runner execution, result envelopes,
 * reader and dashboard — not a fixture copied into a directory.
 *
 * So this drives the real admin-client UI, against a real `admin-server` HTTP
 * server bound to a real loopback socket, backed by a real `FileCatalogStore`
 * and a real `ExperimentRunner` running the real simulator (the adaptive job
 * kind has no injectable `runExperiment` seam, unlike the batch path
 * `http.test.ts` stands in for). The budget is the smallest one
 * `job-runner-adaptive.test.ts` already established as a real block plus a
 * real generation of screening.
 */

interface RealServer {
  readonly origin: string;
  readonly queue: JobQueue;
  close(): Promise<void>;
}

async function startRealServer(): Promise<RealServer> {
  const base = await mkdtemp(join(tmpdir(), 'tcg-admin-client-fullstack-'));
  const catalogRoot = join(base, 'catalog');
  const resultRoot = join(base, 'results');
  await mkdir(resultRoot, { recursive: true });

  const config = unwrap(
    parseServiceConfig({
      host: '127.0.0.1',
      port: 0,
      catalogRoot,
      resultRoots: { local: resultRoot },
      limits: { maxConcurrentJobs: 1, maxWorkers: 1, maxWorkersPerJob: 1 },
    }),
  );
  const opened = unwrap(await openFileCatalogStore({ roots: config.roots }));
  const runner = new ExperimentRunner({
    store: opened.store,
    roots: config.roots,
    resultRootId: 'local',
    pollEveryMs: 20,
  });
  const queue = new JobQueue({ store: opened.store, runner, limits: config.limits });
  const service = new AdminService({ config, store: opened.store, queue });
  const server: AdminHttpServer = await startAdminHttpServer({ service });
  const origin = `http://127.0.0.1:${String(server.port)}`;

  return {
    origin,
    queue,
    close: async () => {
      await server.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

/** A transport that actually crosses a socket, to the real bound port above. */
function realServerTransport(origin: string): AdminTransport {
  return async (request: AdminHttpRequest): Promise<AdminHttpReply> => {
    const response = await fetch(`${origin}${request.path}`, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });
    return { status: response.status, body: await response.text() };
  };
}

let server: RealServer | null = null;

afterEach(async () => {
  if (server === null) return;
  // Settled before removed, the same reason `http.test.ts` gives: a run still
  // writing into the temporary tree must not have that tree pulled out from
  // under it.
  await server.queue.drain();
  await server.close();
  server = null;
});

describe('an Adaptive Counter run, driven through the real form into the real dashboard', () => {
  it(
    'schedules, enqueues, runs, completes and reads back through the real reader',
    async () => {
      server = await startRealServer();
      const user = userEvent.setup();

      renderAdmin({ transport: realServerTransport(server.origin) });
      stubLayout('wide');

      await screen.findByRole('heading', { level: 1, name: 'Overview' });

      await user.click(screen.getByRole('button', { name: 'New Test Batch' }));
      await screen.findByRole('heading', { level: 1, name: 'New Test Batch' });
      const main = screen.getByRole('main');

      await user.click(within(main).getByRole('radio', { name: /Adaptive Counter Search/ }));

      const preconGroup = within(main).getByRole('group', { name: 'Starting deck(s)' });
      const preconCheckboxes = within(preconGroup).getAllByRole('checkbox');
      expect(preconCheckboxes.length).toBeGreaterThan(0);
      await user.click(preconCheckboxes[0]!);

      const setNumber = async (label: string, value: number): Promise<void> => {
        const input = within(main).getByLabelText(label) as HTMLInputElement;
        await user.clear(input);
        await user.type(input, String(value));
      };
      await setNumber('Total learning budget (games)', 6);
      await setNumber('Block size (games per evaluation block)', 1);
      await setNumber('Candidate count', 2);
      await setNumber('Final validation games', 1);

      await user.click(within(main).getByRole('button', { name: 'Check what this schedules' }));
      const enqueueButton = await within(main).findByRole('button', {
        name: 'Enqueue this adaptive run',
      });
      await user.click(enqueueButton);

      await within(main).findByText('Job this added to the draft');

      await user.click(screen.getByRole('button', { name: 'Queue' }));
      await screen.findByRole('heading', { level: 1, name: 'Queue' });
      const queueMain = screen.getByRole('main');

      await user.click(
        await within(queueMain).findByRole('button', { name: /Adaptive Counter Search/ }),
      );
      await user.click(await within(queueMain).findByRole('button', { name: 'Start this batch' }));
      await screen.findByRole('heading', { name: 'Start this batch?' });
      await user.click(screen.getByRole('button', { name: 'Start it' }));

      const completedArticle = await waitFor(
        () => {
          const article = within(queueMain).getByRole('article');
          expect(article).toHaveAttribute('aria-label', expect.stringContaining('Completed'));
          return article;
        },
        { timeout: 20_000, interval: 250 },
      );

      await user.click(
        within(completedArticle).getByRole('button', { name: 'View in Adaptive Dashboard' }),
      );

      await screen.findByRole('heading', { level: 1, name: 'Results' });
      const resultsMain = screen.getByRole('main');
      await within(resultsMain).findByRole('heading', { level: 2, name: 'Adaptive Counter run' });

      const factsTable = (
        await within(resultsMain).findByText('What this run has produced so far')
      ).closest('table');
      expect(factsTable).not.toBeNull();
      const facts = within(factsTable as HTMLTableElement);
      expect(facts.getByText('adaptive-counter')).toBeInTheDocument();
      expect(await facts.findByText(/adaptive-result\.json/)).toBeInTheDocument();
    },
    30_000,
  );
});
