import { z } from 'zod';

import { annotationsSchema, runIdentitySchema } from './catalog.js';
import { adminErrorSchema } from './errors.js';
import {
  batchIdSchema,
  experimentPurposeSchema,
  jobIdSchema,
  labelSchema,
  sourceClassesSchema,
  timestampSchema,
} from './identity.js';
import { jobActionSchema, jobStatusSchema } from './lifecycle.js';
import { jobEventVersionSchema } from './version.js';

/**
 * What happened to one job, in the order it happened — the append-only half of
 * the catalog [ADR 0023](../../../docs/architecture/0023-admin-lab-boundary.md)
 * §3 describes.
 *
 * The document beside this log says what a job **is** right now. It is rewritten
 * in place, so it cannot answer "how did it get here" — and three of the things
 * M08 requires are exactly that question:
 *
 * - **`retry` is a visible lifecycle action, never a silent automatic success**
 *   (M08.5). A job document that went `failed → queued → running → completed`
 *   ends up spelling `completed`, and a reader who only has the document cannot
 *   tell it from a job that succeeded first time. The log can.
 * - **Recovered work is recovered, not finished** (M08.2). An `interrupted`
 *   status says a restart happened; it does not say the orchestrator decided
 *   that rather than an operator. `cause` does.
 * - **Annotations are additive and never rewrite historical raw output**
 *   (M08.27). Replacing the annotation block is how the request contract works;
 *   keeping every replacement is what makes the previous one still readable.
 *
 * ## What is deliberately not an event
 *
 * **Progress is not logged.** A batch of 2,000 matches would write 2,000 lines
 * that say a counter moved, and the answer to "how far along is it" is on the
 * document, exactly and cheaply. The log records the things that are *decisions*
 * — a state changed, an annotation was replaced, a result was linked — because
 * those are the ones a later reader cannot reconstruct.
 *
 * **There is no sequence number.** The file is append-only, so its own line
 * order *is* the order, and a number beside it would only be a second copy of
 * that fact that could disagree with it. A damaged final line is dropped and
 * reported by the reader (the discipline `readJsonl` already fixed for
 * `matches.jsonl`), which is a different failure from a gap in the middle — and
 * an append-only file has no middle to lose.
 *
 * **There is no location.** `result_attached` carries the run's *identity* and
 * not `storedResultReferenceSchema`, even though the log never leaves the
 * server. A log line outlives the configuration that resolved its root, so a
 * path written into one is a path that can be wrong later as well as a path that
 * can leak.
 */

/* ------------------------------------------------------------------ causes */

/**
 * Who caused a transition.
 *
 * Three answers rather than a boolean, because the interesting question is not
 * "was this automatic" but "which authority decided it". An operator's `cancel`
 * and a crash-recovery `interrupt` are both things that happened to a running
 * job, and a queue screen that showed them the same way would be reporting the
 * consequence and hiding the cause.
 */
export const JOB_EVENT_CAUSES = [
  /** An administrator asked for it. */
  'operator',
  /** The job's own execution reported it — it finished, or it fell over. */
  'runner',
  /** The orchestration process restarted and found this job in flight. */
  'recovery',
] as const;
export const jobEventCauseSchema = z.enum(JOB_EVENT_CAUSES);
export type JobEventCause = z.infer<typeof jobEventCauseSchema>;

/* ------------------------------------------------------------------ events */

/** Every line carries the version it was written in, its subject and its instant. */
const eventCore = {
  eventVersion: jobEventVersionSchema,
  jobId: jobIdSchema,
  at: timestampSchema,
};

export const JOB_EVENT_KINDS = ['created', 'transition', 'annotated', 'result_attached'] as const;
export const jobEventKindSchema = z.enum(JOB_EVENT_KINDS);
export type JobEventKind = z.infer<typeof jobEventKindSchema>;

/**
 * The job appeared, with the classification it was created under.
 *
 * The classification is copied into the first line rather than left to the
 * document, because `sourceClasses` is what keeps AI, human, mixed, precon,
 * search and adaptive evidence distinguishable, and a reader asking whether a
 * run was ever reclassified needs the value it started with.
 */
export const jobCreatedEventSchema = z.strictObject({
  ...eventCore,
  kind: z.literal('created'),
  batchId: batchIdSchema,
  label: labelSchema,
  purpose: experimentPurposeSchema,
  sourceClasses: sourceClassesSchema,
});

/**
 * The job moved, by a named action, from a named state to a named state.
 *
 * `from` and `to` are both recorded even though the lifecycle table can derive
 * `to` from the other two: the table is this build's, and a line written by a
 * build whose table differed would otherwise be silently re-interpreted rather
 * than read.
 *
 * `failure` is nullable rather than absent so a `fail` transition and its
 * diagnostics are one line. A separate failure event could be written without
 * its transition, or after it, and the pair would then have an order to get
 * wrong.
 */
export const jobTransitionEventSchema = z.strictObject({
  ...eventCore,
  kind: z.literal('transition'),
  action: jobActionSchema,
  from: jobStatusSchema,
  to: jobStatusSchema,
  cause: jobEventCauseSchema,
  failure: adminErrorSchema.nullable(),
});

/** An administrator replaced the annotation block. The whole new block is the record. */
export const jobAnnotatedEventSchema = z.strictObject({
  ...eventCore,
  kind: z.literal('annotated'),
  annotations: annotationsSchema,
});

/** The job's canonical experiment directory was identified. Identity only, never a path. */
export const jobResultAttachedEventSchema = z.strictObject({
  ...eventCore,
  kind: z.literal('result_attached'),
  identity: runIdentitySchema,
});

export const jobEventSchema = z.discriminatedUnion('kind', [
  jobCreatedEventSchema,
  jobTransitionEventSchema,
  jobAnnotatedEventSchema,
  jobResultAttachedEventSchema,
]);
export type JobEvent = z.infer<typeof jobEventSchema>;

/**
 * A log as it was read back, including what could not be read.
 *
 * `skipped` is part of the value rather than a thrown error or a warning nobody
 * catches, because M08.10 has to *report* a damaged record rather than hide it,
 * and a reader that returned only the good lines would make a truncated log
 * indistinguishable from a short one.
 */
export const jobEventLogSchema = z.strictObject({
  jobId: jobIdSchema,
  events: z.array(jobEventSchema),
  skipped: z.array(
    z.strictObject({
      line: z.number().int().min(1),
      reason: z.string().min(1).max(500),
    }),
  ),
});
export type JobEventLog = z.infer<typeof jobEventLogSchema>;
