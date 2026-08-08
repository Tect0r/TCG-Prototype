import { parentPort, workerData } from 'node:worker_threads';
import { resolveEnvironment } from '../environment.js';
import { runOne } from '../run-one.js';
import { workerJobSchema, workerSetupSchema, type WorkerResult } from './protocol.js';

/**
 * Worker-thread entry point.
 *
 * Loaded through `bootstrap.mjs`, which registers the TypeScript resolve hook
 * first. This file must stay in erasable-syntax-only TypeScript (no enums, no
 * parameter properties, no namespaces) because Node strips types rather than
 * compiling them — see `pool.ts` for the whole story.
 *
 * The worker is a pure function of its inputs: it resolves the environment from
 * the same validated configuration the main thread used, then runs whichever
 * matches it is handed. It has no idea how many other workers exist, which is
 * exactly why the worker count cannot change a result.
 */

async function main(): Promise<void> {
  const port = parentPort;
  if (!port) throw new Error('simulator worker started without a parent port');

  const setup = workerSetupSchema.parse(workerData);
  const environment = resolveEnvironment(setup.environment);

  port.on('message', (raw: unknown) => {
    void (async () => {
      const job = workerJobSchema.parse(raw);
      try {
        const outcome = await runOne({
          experimentId: setup.experimentId,
          environment,
          decks: setup.decks,
          pilots: setup.pilots,
          limits: setup.limits,
          retention: setup.retention,
          softwareCommit: setup.softwareCommit,
          job,
        });
        const message: WorkerResult = {
          type: 'done',
          matchId: job.matchId,
          record: outcome.record,
          replay: outcome.replay,
        };
        port.postMessage(message);
      } catch (error) {
        const message: WorkerResult = {
          type: 'failed',
          matchId: job.matchId,
          message: error instanceof Error ? error.message : String(error),
        };
        port.postMessage(message);
      }
    })();
  });

  port.postMessage({ type: 'ready' });
}

await main();
