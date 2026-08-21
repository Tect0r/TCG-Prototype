import { z } from 'zod';

import { adminErrorSchema } from './errors.js';
import { catalogFilterSchema } from './filters.js';
import { annotationsSchema, catalogBatchViewSchema, catalogJobViewSchema } from './catalog.js';
import { batchIdSchema, jobIdSchema } from './identity.js';
import { jobActionSchema } from './lifecycle.js';
import { pageOf, pageRequestSchema } from './pagination.js';
import { contractVersionSchema } from './version.js';

/**
 * What an admin client asks for, and what it gets back.
 *
 * This module exists for two reasons that are easy to mistake for one.
 *
 * The first is that `ADMIN_CONTRACT_VERSION` needs an owner. ADR 0023 §7 asks
 * for a version an admin client and an admin server negotiate, and a constant
 * that no schema stamps is a number nobody can disagree over. The envelope below
 * is where it is stamped, which is what makes "current versions round-trip" and
 * "a future version is refused" statements about a real payload rather than
 * about an integer.
 *
 * The second is [ADR 0023](../../../docs/architecture/0023-admin-lab-boundary.md)
 * §5: *a request never names a filesystem path; it names an identifier that the
 * server resolves*. That is a property of the **input** types, and it is only
 * structural if there is nowhere in an input to put a path. There is not. The
 * one schema that can hold a `rootId` and a directory — `resultLocationSchema` —
 * is reachable from `catalogJobDocumentSchema` and from nothing here, and the
 * boundary test in `boundary.test.ts` reads these sources to keep it that way.
 *
 * What is deliberately **not** here: endpoints, methods, URLs, transport,
 * authentication, rate limits and body limits. Those are M08.6, and a contract
 * package that guessed at them would be writing the service's interface before
 * the service exists. These are the payload shapes M08.1's own vocabulary can
 * honestly describe, and no more.
 */

/* -------------------------------------------------------------- the envelope */

/**
 * Every request carries the contract version it was written in.
 *
 * On the request rather than only on the response, because both directions can
 * be the older build: a client that has not been reloaded since a deploy sends
 * an old request to a new server, and a client updated ahead of its server sends
 * a new one to an old server. One field, checked at both ends, covers both — and
 * `refuseFutureVersion` is what turns the second case into a readable sentence
 * instead of an unknown-field parse error.
 */
export function adminRequest<T extends z.ZodType>(payload: T) {
  return z.strictObject({
    contractVersion: contractVersionSchema,
    payload,
  });
}

/**
 * Every response says whether it worked, in a shape a client can switch on.
 *
 * A discriminated union rather than an optional `error` beside an optional
 * `data`, because the shape that can hold both can also hold neither, and a
 * client would have to check two fields to find out which happened.
 *
 * `errors` is an array rather than one error: a schema failure is naturally
 * several, `adminSchemaErrors` already returns a list, and a form that can only
 * show the first field a person got wrong makes them submit five times.
 */
export function adminResponse<T extends z.ZodType>(payload: T) {
  return z.discriminatedUnion('ok', [
    z.strictObject({
      ok: z.literal(true),
      contractVersion: contractVersionSchema,
      payload,
    }),
    z.strictObject({
      ok: z.literal(false),
      contractVersion: contractVersionSchema,
      errors: z.array(adminErrorSchema).min(1).max(64),
    }),
  ]);
}

/* ------------------------------------------------------------ list requests */

/**
 * How the catalog is browsed: a filter, a page, and nothing that resolves to a
 * file.
 *
 * `sort` is absent on purpose. The ordering is `createdAt` then ID, fixed rather
 * than chosen, because that is the ordering a continuation token encodes a
 * position in (`pagination.ts`) and a caller that could re-sort mid-listing
 * would be handing back a cursor into a sequence that no longer exists. A second
 * ordering is a thing M08.10 can ask for, with a cursor that survives it.
 */
export const listJobsRequestSchema = z.strictObject({
  filter: catalogFilterSchema.prefault({}),
  page: pageRequestSchema.prefault({}),
});
export type ListJobsRequest = z.infer<typeof listJobsRequestSchema>;
export type ListJobsRequestInput = z.input<typeof listJobsRequestSchema>;

export const listBatchesRequestSchema = z.strictObject({
  page: pageRequestSchema.prefault({}),
});
export type ListBatchesRequest = z.infer<typeof listBatchesRequestSchema>;

/** One page of jobs, as a client sees them — views, so never a stored location. */
export const jobPageSchema = pageOf(catalogJobViewSchema);
export type JobPage = z.infer<typeof jobPageSchema>;

export const batchPageSchema = pageOf(catalogBatchViewSchema);
export type BatchPage = z.infer<typeof batchPageSchema>;

/* -------------------------------------------------------- mutation requests */

/**
 * Naming one job, and naming it the only way a request may.
 *
 * A `jobId` is minted by the store and means nothing outside it; resolving it to
 * a directory is the server's move, made against configuration a client cannot
 * see. That is the whole of ADR 0023 §5 expressed as a type: there is no field
 * here for an output root, and adding one would be a visible widening rather
 * than a habit somebody let slip.
 */
export const jobRefSchema = z.strictObject({ jobId: jobIdSchema });
export type JobRef = z.infer<typeof jobRefSchema>;

export const batchRefSchema = z.strictObject({ batchId: batchIdSchema });
export type BatchRef = z.infer<typeof batchRefSchema>;

/**
 * Replacing a job's annotations.
 *
 * The whole annotation block rather than a patch, because the three fields are
 * small, a patch needs a way to say "leave this one" that is distinguishable
 * from "clear it", and `null`-means-untouched is the ambiguity this repository's
 * schemas keep refusing. A client sends what it wants the annotations to be.
 *
 * This is also the clearest statement of the authority boundary in the package:
 * an administrator may write *these three fields*, they are stored beside the
 * run, and there is no request shape anywhere that reaches into the experiment
 * directory. Marking a baseline cannot mutate canonical output because no
 * request can express mutating it.
 */
export const setJobAnnotationsRequestSchema = z.strictObject({
  jobId: jobIdSchema,
  annotations: annotationsSchema,
});
export type SetJobAnnotationsRequest = z.infer<typeof setJobAnnotationsRequestSchema>;

/**
 * Asking a job to change state.
 *
 * The *action* travels, never the target state. A client that sent
 * `status: 'cancelled'` would be deciding the outcome of a transition the
 * lifecycle model owns, and two clients could then disagree about what `cancel`
 * means from `running` — which is exactly the split authority `lifecycle.ts`
 * exists to prevent. The server applies `applyJobTransition` and answers with
 * the state it reached, or with `admin/illegal_transition` and the actions that
 * were available instead.
 */
export const jobActionRequestSchema = z.strictObject({
  jobId: jobIdSchema,
  action: jobActionSchema,
});
export type JobActionRequest = z.infer<typeof jobActionRequestSchema>;

/**
 * Every request payload M08.1 defines, in one union.
 *
 * Exported so a boundary test can be total over them — "no request payload
 * admits a filesystem location" is a claim about a closed set, and a set nobody
 * enumerated is a set a later tranche adds to quietly.
 */
export const ADMIN_REQUEST_PAYLOAD_SCHEMAS = Object.freeze({
  listJobs: listJobsRequestSchema,
  listBatches: listBatchesRequestSchema,
  jobRef: jobRefSchema,
  batchRef: batchRefSchema,
  setJobAnnotations: setJobAnnotationsRequestSchema,
  jobAction: jobActionRequestSchema,
});

export type AdminRequestPayloadName = keyof typeof ADMIN_REQUEST_PAYLOAD_SCHEMAS;

export const ADMIN_REQUEST_PAYLOAD_NAMES = Object.keys(
  ADMIN_REQUEST_PAYLOAD_SCHEMAS,
) as readonly AdminRequestPayloadName[];
