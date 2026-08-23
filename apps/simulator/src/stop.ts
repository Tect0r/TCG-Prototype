/**
 * Asking a run in flight to stop, without asking it to lie about what it did.
 *
 * M08.5 needs an operator to be able to **pause** and **cancel** a long
 * experiment, and it fixes the meaning of both: *pause stops scheduling new
 * match work and lets in-flight matches reach their normal record boundary*, and
 * *cancel is graceful and preserves inspectable partial output*. Neither of
 * those is a property the admin layer can supply from outside — killing a
 * process at an arbitrary instant abandons a match halfway and leaves a
 * half-written final line — so the check belongs where the matches are handed
 * out, which is here.
 *
 * ## What a stop is, and what it is not
 *
 * A stop is checked **between matches**, never inside one. A match that has
 * started runs to its termination and its record is committed to the stream
 * exactly as it would have been; what a stop prevents is the *next* match being
 * dispatched. That is what makes a paused run and an uninterrupted one the same
 * evidence: every record on disk is a whole match played under the run's own
 * configuration, and resume skips precisely those.
 *
 * A stop is **not a failure**, and it is not a completion either. So a stopped
 * run throws `ExperimentStopped` rather than returning, which has two
 * consequences that are the whole reason for the choice:
 *
 * - **No manifest, no summary and no report are written.** `runExperiment`
 *   builds those in `finish()`, after the matches; unwinding past it means a
 *   partial run cannot leave behind a document that reads like a finished one.
 *   ADR 0012 makes the directory the deliverable, and a report over half a
 *   schedule would be a deliverable that is wrong.
 * - **Every experiment kind gets it for free.** A batch, a replacement's
 *   variants, a search's generations, a comparison's two arms and a robustness
 *   run's arms all play their matches through `runBatch`. A returned flag would
 *   have to be checked and propagated at each of those call sites, and the first
 *   one that forgot would silently publish a partial run.
 *
 * Nothing here removes anything. The partial `matches.jsonl`, its sidecar
 * header and every checkpoint written so far stay exactly where they are, which
 * is what makes `resume: true` on the next attempt a continuation rather than a
 * restart.
 *
 * ## Why a callback rather than an `AbortSignal`
 *
 * `AbortSignal` is an event target: a listener fires, and the code that has to
 * act on it is somewhere other than the loop that dispatches work. The question
 * this answers is synchronous and is asked at exactly one instant — *may I hand
 * out another match?* — and a predicate is the shape of that question. It also
 * keeps the simulator free of any opinion about who is allowed to stop a run and
 * why: `null` means carry on, and a reason means stop, and the caller owns both.
 */

/** Why a run was asked to stop. The simulator records it and never interprets it. */
export type StopReason = string;

/**
 * Asked before each match is dispatched. `null` carries on; a reason stops.
 *
 * Must be cheap and must not throw — it is called once per match, on the hot
 * path of a run that may play thousands.
 */
export type StopSignal = () => StopReason | null;

/**
 * Thrown out of `runExperiment` when a run stopped because it was asked to.
 *
 * A named class rather than a plain `Error` so a caller can tell "the operator
 * pressed pause" from "the run fell over", which are different lifecycle
 * outcomes and would otherwise both arrive as an exception with a message.
 */
export class ExperimentStopped extends Error {
  readonly reason: StopReason;
  /** Matches committed to the stream by this attempt before it stopped. */
  readonly completedThisAttempt: number;

  constructor(reason: StopReason, completedThisAttempt: number) {
    super(
      `This run stopped after ${String(completedThisAttempt)} match(es) because it was asked to (${reason}). ` +
        'Every record it played is committed; nothing was written over it, and resuming continues from there.',
    );
    this.name = 'ExperimentStopped';
    this.reason = reason;
    this.completedThisAttempt = completedThisAttempt;
  }
}

/** Whether a thrown value is a deliberate stop rather than a failure. */
export function isExperimentStopped(value: unknown): value is ExperimentStopped {
  return value instanceof ExperimentStopped;
}
