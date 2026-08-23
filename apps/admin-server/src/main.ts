/* eslint-disable no-console */
import { isErr } from '@tcg/shared';

import { openFileCatalogStore } from './catalog/file-catalog-store.js';
import { ExperimentRunner } from './run/job-runner.js';
import { JobQueue } from './run/queue.js';
import { ADMIN_ENVIRONMENT_KEYS, serviceConfigFromEnvironment } from './service/config.js';
import { AdminService } from './service/handlers.js';
import { startAdminHttpServer } from './service/http.js';
import { acquireOrchestratorLock } from './service/lock.js';

/**
 * The orchestration process — the first entry point this workspace has ever had.
 *
 * M08.2 through M08.5 deliberately built a store, an estimator, a runner and a
 * queue with nothing to start them, and said so in as many words: *an entry point
 * that bound nothing and ran nothing would be the decorative scaffolding the
 * milestone warns against; M08.6 adds one when it has a reason to.* This is that
 * reason, and the file is small because everything it starts already exists.
 *
 * The startup order is the order in which each step can refuse:
 *
 * 1. **Configuration**, which is where a non-loopback bind with no token is
 *    refused (ADR 0023 §4). Nothing is opened and nothing is bound first.
 * 2. **The lock**, so a second orchestrator against the same catalog is refused
 *    before it recovers anything. Recovery rewrites documents, and two processes
 *    doing it at once is exactly the state a lock exists to prevent.
 * 3. **The catalog**, whose opening *is* the restart recovery: in-flight work
 *    becomes `interrupted` and never `completed`, and nothing is re-queued
 *    automatically.
 * 4. **The queue**, which is told the bound and nothing else. It starts no job
 *    until something asks — an operator's `resume` or `retry`, or a preset being
 *    enqueued — because M08.5 made "nothing resumes by itself" a property rather
 *    than a habit.
 * 5. **The port**, last, once there is something behind it worth answering with.
 *
 * What is printed is deliberately spare. The bind, the versions, the bound, what
 * the restart found, and nothing else — **no token, no catalog root and no result
 * root**. ADR 0023 §4 keeps the token out of log lines and §5 keeps locations out
 * of anything that leaves the process; a start-up banner is where both are most
 * tempting and least necessary, because the person reading it is the person who
 * configured them.
 */
async function main(): Promise<number> {
  const config = serviceConfigFromEnvironment(process.env);
  if (isErr(config)) {
    console.error('The admin service cannot start with this configuration:');
    for (const problem of config.error) console.error(`  ${problem.code}: ${problem.message}`);
    console.error(
      `Set ${ADMIN_ENVIRONMENT_KEYS.catalogRoot} and ${ADMIN_ENVIRONMENT_KEYS.resultRoot} to absolute directories.`,
    );
    return 1;
  }

  const lock = await acquireOrchestratorLock(config.value.roots.catalogRoot);
  if (isErr(lock)) {
    for (const problem of lock.error) console.error(`${problem.code}: ${problem.message}`);
    return 1;
  }

  const opened = await openFileCatalogStore({ roots: config.value.roots });
  if (isErr(opened)) {
    for (const problem of opened.error) console.error(`${problem.code}: ${problem.message}`);
    await lock.value.release();
    return 1;
  }

  const { store, recovery } = opened.value;
  const runner = new ExperimentRunner({
    store,
    roots: config.value.roots,
    resultRootId: config.value.resultRootId,
  });
  const queue = new JobQueue({ store, runner, limits: config.value.limits });
  const service = new AdminService({ config: config.value, store, queue });
  const server = await startAdminHttpServer({ service });

  console.log(`Admin service listening on http://${server.host}:${String(server.port)}`);
  console.log(
    `Access: ${config.value.loopback ? 'loopback' : `bound ${config.value.host}`}, ` +
      `${config.value.token === null ? 'no token configured' : 'token required'}.`,
  );
  console.log(
    `Bound to ${String(config.value.limits.maxConcurrentJobs)} concurrent job(s) on up to ` +
      `${String(config.value.limits.maxWorkers)} simulator worker(s).`,
  );
  if (lock.value.tookOverStaleLock) {
    console.warn(
      'A previous orchestrator left a lock behind and is no longer running; this process took it over.',
    );
  }
  console.log(
    `Restart scanned ${String(recovery.scannedJobs)} job(s); ${String(recovery.recovered.length)} were interrupted and are waiting for an operator. Nothing resumes by itself.`,
  );
  for (const entry of recovery.unreadable) {
    console.warn(`A catalog entry could not be read: ${entry.id ?? 'unnamed'}`);
  }

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal}: closing the admin service.`);
    void server
      .close()
      .then(() => lock.value.release())
      .then(() => {
        process.exitCode = 0;
      });
  };
  process.once('SIGINT', () => {
    stop('SIGINT');
  });
  process.once('SIGTERM', () => {
    stop('SIGTERM');
  });

  return 0;
}

const code = await main();
if (code !== 0) process.exitCode = code;
