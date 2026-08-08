import { Worker } from 'node:worker_threads';
import {
  workerResultSchema,
  type WorkerJob,
  type WorkerResult,
  type WorkerSetup,
} from './protocol.js';

/**
 * A fixed pool of worker threads (CLAUDE.md §13.7).
 *
 * **Determinism.** The pool decides only *where* a match runs, never *what* it
 * is: identity, seeds and seat assignment are fixed by the schedule before any
 * worker starts, and every result is re-sorted by its stable order key before
 * anything is aggregated. `workers: 1` and `workers: 8` therefore produce the
 * same records in the same order, and a slow worker cannot change an average.
 *
 * **Why a bootstrap file.** The repository has no build step for its Node code —
 * every workspace package resolves to TypeScript sources. Node can strip the
 * types by itself, but it will not rewrite the `./x.js` specifiers those sources
 * use, so the worker starts in `bootstrap.mjs`, registers a five-line resolve
 * hook, and only then loads the worker. If a worker cannot start, the pool says
 * so and names the sequential fallback rather than quietly changing the run.
 */

export interface PoolOptions {
  readonly workers: number;
  readonly setup: WorkerSetup;
  /** Called as each result arrives, in completion order. */
  readonly onResult: (result: WorkerResult) => void;
}

export class WorkerPoolStartupError extends Error {
  constructor(cause: string) {
    super(
      `Could not start a simulator worker thread: ${cause}\n` +
        'Re-run with `--workers 1` for sequential execution, which produces identical results.',
    );
    this.name = 'WorkerPoolStartupError';
  }
}

/**
 * Runs every job across `workers` threads.
 *
 * Jobs are handed out on demand rather than pre-sharded, so one slow match does
 * not leave a thread idle — safe precisely because the result of a job does not
 * depend on which thread ran it or on when it finished.
 */
export async function runJobsInPool(
  jobs: readonly WorkerJob[],
  options: PoolOptions,
): Promise<void> {
  if (jobs.length === 0) return;

  const count = Math.max(1, Math.min(options.workers, jobs.length));
  const bootstrap = new URL('./bootstrap.mjs', import.meta.url);

  const workers: Worker[] = [];
  let nextJob = 0;
  let outstanding = 0;
  let settled = false;

  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      for (const worker of workers) void worker.terminate();
      if (error) reject(error);
      else resolve();
    };

    const dispatch = (worker: Worker): void => {
      if (settled) return;
      if (nextJob >= jobs.length) {
        if (outstanding === 0) finish();
        return;
      }
      const job = jobs[nextJob];
      nextJob += 1;
      if (!job) return;
      outstanding += 1;
      worker.postMessage(job);
    };

    for (let index = 0; index < count; index += 1) {
      let worker: Worker;
      try {
        worker = new Worker(bootstrap, { workerData: options.setup });
      } catch (error) {
        finish(new WorkerPoolStartupError(error instanceof Error ? error.message : String(error)));
        return;
      }
      workers.push(worker);

      worker.on('message', (raw: unknown) => {
        if (settled) return;
        if (
          typeof raw === 'object' &&
          raw !== null &&
          (raw as { type?: string }).type === 'ready'
        ) {
          dispatch(worker);
          return;
        }
        const parsed = workerResultSchema.safeParse(raw);
        if (!parsed.success) {
          finish(new Error(`Worker sent an unrecognised message: ${parsed.error.message}`));
          return;
        }
        outstanding -= 1;
        options.onResult(parsed.data);
        dispatch(worker);
        if (nextJob >= jobs.length && outstanding === 0) finish();
      });

      worker.on('error', (error: Error) => {
        finish(
          nextJob === 0 && outstanding === 0 ? new WorkerPoolStartupError(error.message) : error,
        );
      });

      worker.on('exit', (code: number) => {
        if (settled) return;
        if (code !== 0) finish(new Error(`Simulator worker exited with code ${code}.`));
      });
    }
  });
}
