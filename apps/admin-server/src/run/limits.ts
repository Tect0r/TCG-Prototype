import { availableParallelism } from 'node:os';

import { adminError, type AdminError } from '@tcg/admin-contracts';
import { err, ok, type Result } from '@tcg/shared';
import { z } from 'zod';

/**
 * How much of a machine the lab is allowed to take.
 *
 * M08.5's first requirement is *bounded concurrency and worker limits*, and
 * ADR 0023 states the reason in its consequences: **the admin server can
 * saturate a machine**, and where it shares one with the live match server that
 * matters. The bound is what makes "saturate" a choice rather than an accident.
 *
 * ## Why this lives here and not in `@tcg/admin-contracts`
 *
 * The contract package is the language the admin *client* and the admin *server*
 * speak — identity, lifecycle, progress, result references, pagination and
 * errors. A resource limit is none of those: it is a property of the machine the
 * orchestrator runs on, it crosses no wire in this tranche, and no client sends
 * one. Putting it in the shared vocabulary now would be adding a schema to a
 * contract before anything speaks it, which is the premature scaffolding M08
 * warns against; M08.6 owns the capabilities endpoint and decides then whether a
 * client is told these numbers, in a shape it can also decide.
 *
 * It is still a **schema** rather than three loose numbers, for the reason every
 * other admin input has one: an operator's configuration is input, an
 * unvalidated `maxWorkers: 0` would deadlock the queue silently, and a strict
 * object refuses a misspelled key instead of ignoring it.
 *
 * ## The three numbers, and why three
 *
 * - **`maxConcurrentJobs`** bounds how many experiments are in flight. It is not
 *   derivable from the worker budget: a job with one worker still holds a
 *   catalog document, a poller and an open stream, and ten of those is ten
 *   directories being written whether or not the CPU notices.
 * - **`maxWorkers`** bounds the simulator worker threads across *every* running
 *   job. This is the number that decides whether the machine is oversubscribed,
 *   and it is the one a per-job limit cannot express.
 * - **`maxWorkersPerJob`** bounds one job's share, so a single wide experiment
 *   cannot take the whole budget and leave the queue behind it stalled. It is a
 *   ceiling and never a floor: a configuration asking for fewer gets fewer.
 *
 * A configuration's own `workers` is still honoured *within* the grant, because
 * it is the run's stated shape and `configHashOf` deliberately excludes it —
 * changing it cannot make a resumed run into a different run.
 */

/** Most experiments the orchestrator will run at once, whatever it is configured with. */
export const MAX_CONCURRENT_JOBS = 32;

/**
 * Most simulator workers the orchestrator will run at once.
 *
 * The same 64 `experimentConfigSchema` and `jobExecutionSchema` both cap a
 * single run at, because a total budget smaller than one run's ceiling would
 * make a legal configuration permanently unstartable.
 */
export const MAX_TOTAL_WORKERS = 64;

export const resourceLimitsSchema = z
  .strictObject({
    maxConcurrentJobs: z.number().int().min(1).max(MAX_CONCURRENT_JOBS),
    maxWorkers: z.number().int().min(1).max(MAX_TOTAL_WORKERS),
    maxWorkersPerJob: z.number().int().min(1).max(MAX_TOTAL_WORKERS),
  })
  .refine(
    (limits) => limits.maxWorkersPerJob <= limits.maxWorkers,
    'One job may not be allowed more workers than the whole orchestrator has.',
  );
export type ResourceLimits = z.infer<typeof resourceLimitsSchema>;
export type ResourceLimitsInput = Partial<ResourceLimits>;

/**
 * What the orchestrator does when nobody has told it anything.
 *
 * **One job at a time**, because the queue is ordered and two experiments each
 * running at half speed finish later than the same two run one after the other —
 * while the first of them finishes much later. Concurrency is worth having when
 * a job cannot use the whole budget; it is not a default.
 *
 * **One fewer worker than the machine has**, because `availableParallelism` is
 * what Node reports as the useful parallelism here, and leaving one thread is
 * what keeps the box answering while a search runs. It is read once rather than
 * per job: a bound that moved underneath a running queue would be a bound that
 * cannot be reported.
 */
export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = Object.freeze(
  resourceLimitsSchema.parse({
    maxConcurrentJobs: 1,
    maxWorkers: defaultWorkerBudget(),
    maxWorkersPerJob: defaultWorkerBudget(),
  }),
);

function defaultWorkerBudget(): number {
  const detected = availableParallelism();
  return Math.min(MAX_TOTAL_WORKERS, Math.max(1, detected - 1));
}

/**
 * Fills in what an operator did not say, and refuses what they said wrongly.
 *
 * A `Result` rather than a throw, like every other admin boundary: the caller is
 * a request handler in M08.6 and a constructor here, and both would rather
 * report `admin/schema` naming the field than unwind.
 */
export function parseResourceLimits(
  input: ResourceLimitsInput = {},
): Result<ResourceLimits, readonly AdminError[]> {
  const parsed = resourceLimitsSchema.safeParse({ ...DEFAULT_RESOURCE_LIMITS, ...input });
  if (parsed.success) return ok(parsed.data);
  return err(
    parsed.error.issues.map((issue) =>
      adminError('admin/schema', issue.message, {
        ...(issue.path.length > 0 ? { path: issue.path.join('.') } : {}),
      }),
    ),
  );
}

/**
 * How many workers a job may have, given what it wants and what is left.
 *
 * `null` means *not now* — the caller must not start this job — and it is a
 * different answer from `1`. The distinction matters because a queue that
 * started a job with zero workers would be a queue that had quietly ignored its
 * own bound, and a queue that started it with one would be a queue that had
 * quietly rewritten the operator's budget.
 *
 * The order of the three ceilings is deliberate: the configuration's own request
 * is the *most* a job gets, so raising `maxWorkersPerJob` never widens a run
 * that did not ask to be wide.
 */
export function grantWorkers(
  limits: ResourceLimits,
  requested: number,
  used: { readonly jobs: number; readonly workers: number },
): number | null {
  if (used.jobs >= limits.maxConcurrentJobs) return null;
  const remaining = limits.maxWorkers - used.workers;
  if (remaining < 1) return null;
  const grant = Math.min(requested, limits.maxWorkersPerJob, remaining);
  return grant >= 1 ? grant : null;
}
