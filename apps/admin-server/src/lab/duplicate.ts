import { parseExperimentConfig, type ExperimentConfig } from '@tcg/simulator';

/**
 * What a copy of a queued job actually is (M08.9).
 *
 * The milestone asks a queue screen to let an administrator *duplicate* a job in
 * a batch that has not started. The naive reading — write the same configuration
 * a second time — produces something worse than nothing: an experiment's seed is
 * what every shuffle, mulligan and pilot decision in it derives from, so two jobs
 * on one seed play **the same matches** and land two identical run directories in
 * the catalog. A reader who found them would have two records that look like
 * independent evidence and are one measurement counted twice, which is precisely
 * the "never pool unlike evidence into one unexplained win rate" failure with the
 * sign flipped.
 *
 * So a copy is a **replicate**, and it is derived exactly the way M08.8 already
 * derives one: a suffixed experiment ID and a suffixed seed, so the whole set is
 * still reproducible from the single seed an administrator typed. `expand.ts`
 * spells a replicate `-r{n}` / `|r{n}`; a copy is spelled `-c{n}` / `|c{n}`,
 * because the two are not the same claim. A replicate was *scheduled* as one of
 * n, and the estimate that priced the batch counted it; a copy was added
 * afterwards by somebody looking at a queue, and the batch it joins was priced
 * before it existed.
 *
 * Nothing else about the configuration moves. The precons, the pilots, the
 * depth, the seat orders and the retention are the source's, because a control
 * that quietly changed one of them would be a builder hiding inside a queue.
 */

/** The suffix a copy carries, in both the experiment ID and the seed. */
const COPY_ID_SUFFIX = /-c(\d+)$/;
const COPY_SEED_SUFFIX = /\|c(\d+)$/;

/** `experimentSlugSchema` caps an authored ID at this many characters. */
const MAX_EXPERIMENT_ID = 40;

export interface DuplicateProblem {
  readonly message: string;
}

/**
 * A configuration for a copy of `source`, distinct from every ID already taken.
 *
 * `taken` is the set of experiment IDs the batch already holds, which the caller
 * reads off the members it is about to insert into. Numbering from the *taken
 * set* rather than from a counter is what makes the result stable under
 * withdrawal: a batch whose `-c2` was cancelled and left in place still has that
 * ID, so the next copy is `-c3` and no two members of one batch ever claim the
 * same experiment identity.
 *
 * A copy of a copy re-derives from the **base** rather than nesting, so
 * `bench-c2` copies to `bench-c3` and never to `bench-c2-c2`. Nesting would run
 * an ID into its 40-character ceiling after four copies and would spell a seed
 * family that no longer says which run it descends from.
 *
 * The answer is re-parsed by the simulator before it is returned. Editing two
 * string fields of a valid configuration cannot make it invalid in any way this
 * module can foresee, which is exactly why it is checked rather than assumed:
 * the failure this guards against is `experimentSlugSchema` refusing a truncated
 * ID, and it is far better found here than by `createJob`.
 */
export function duplicateConfig(
  source: ExperimentConfig,
  taken: readonly string[],
):
  | { readonly ok: true; readonly config: ExperimentConfig }
  | {
      readonly ok: false;
      readonly problem: DuplicateProblem;
    } {
  const baseId = source.id.replace(COPY_ID_SUFFIX, '');
  const baseSeed = source.seed.replace(COPY_SEED_SUFFIX, '');
  const held = new Set(taken);

  for (let ordinal = 2; ordinal <= MAX_COPIES; ordinal += 1) {
    const suffix = `-c${String(ordinal)}`;
    const id = `${baseId.slice(0, MAX_EXPERIMENT_ID - suffix.length)}${suffix}`;
    if (held.has(id)) continue;
    try {
      return {
        ok: true,
        config: parseExperimentConfig({
          ...source,
          id,
          seed: `${baseSeed}|c${String(ordinal)}`,
        }),
      };
    } catch (cause) {
      return {
        ok: false,
        problem: {
          message: `A copy of this job could not be configured: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        },
      };
    }
  }

  return {
    ok: false,
    problem: {
      message:
        `This batch already holds ${String(MAX_COPIES - 1)} copies of that job, which is as many ` +
        'distinct seed families as one experiment identity is numbered for. Duplicate a different ' +
        'job, or start this batch and configure another one.',
    },
  };
}

/**
 * How many copies of one job a batch may hold.
 *
 * A bound rather than a limit anybody asked for: the ordinal is part of an ID
 * whose length is capped, and a search that could run forever is a search that
 * hangs a request. `MAX_JOBS_PER_BATCH` is 500, so this can only ever be reached
 * by somebody deliberately pressing the same button 499 times.
 */
export const MAX_COPIES = 500;
