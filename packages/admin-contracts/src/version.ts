import { z } from 'zod';

import { adminError, type AdminError } from './errors.js';

/**
 * The three version domains the admin surface has, and the one rule they all
 * obey: a record this build cannot read is refused with a readable message
 * rather than migrated on a guess.
 *
 * Two directions since M08.4, which is the first tranche to move one of these
 * numbers at all. A record from a *newer* build gets the sentence the rest of the
 * repository already refuses with; a record from an *older* build gets its
 * counterpart, because a `z.literal` failing as "expected 2, received 1" tells a
 * person nothing about what happened or what to do.
 *
 * Two rather than one, because
 * [ADR 0023](../../../docs/architecture/0023-admin-lab-boundary.md) §7 says they
 * are answers to different questions and can move independently:
 *
 * - **`ADMIN_CONTRACT_VERSION`** is what an admin client and an admin server
 *   agree on at the moment they talk. It is compared per request and its failure
 *   mode is "these two builds cannot converse".
 * - **`CATALOG_DOCUMENT_VERSION`** is what a persisted catalog document was
 *   written in. It is compared when a file is read, possibly months later, by a
 *   build that has no counterpart to negotiate with. Its failure mode is "this
 *   file is from the future".
 *
 * Collapsing them would mean either refusing to read a perfectly good stored
 * catalog because the request language moved, or claiming a stored document is
 * readable because the two ends of a socket happen to agree. Neither is true.
 *
 * - **`JOB_EVENT_VERSION`** is what a line in a job's append-only event log was
 *   written in. M08.1 named the test this constant had to pass before it could
 *   exist — *a third artifact with its own lifetime is a reason to add a third
 *   constant; a second schema inside the same family is not* — and M08.2's event
 *   log passes it. The log is a different artifact from the document beside it:
 *   the document is rewritten in place and only its latest state is ever read,
 *   while the log is appended to and never rewritten, so a build reads lines
 *   written by every build that came before it. Adding an event kind does not
 *   change a job document, and changing a job document does not make one
 *   historical line unreadable, which is exactly the independence two version
 *   numbers are for.
 *
 * Still no separate constant for the batch document and the job document. They
 * are one family — written by one store, into one directory, in one
 * transaction's worth of intent — and a build that can read a batch but not its
 * jobs has not read the batch.
 *
 * ## Why no play-contract version moves
 *
 * `PROTOCOL_VERSION`, `MATCH_SCHEMA_VERSION`, `RULES_VERSION`,
 * `CARD_SCHEMA_VERSION` and the `@tcg/bot-config` constants all stay exactly
 * where they are, and this is a claim about what M08.1 did rather than a
 * preference. It adds no message to the play wire, no field to a serialized
 * match, no rule, no card and no bot-seat field. Nothing here is reachable from
 * `@tcg/web-client` or `@tcg/multiplayer-server` at all. A version that moved
 * would refuse a build that has lost nothing — and, worse, would teach that
 * naming an experiment is a rules change.
 *
 * The simulator's artifact versions — `MANIFEST_SCHEMA_VERSION`,
 * `SUMMARY_SCHEMA_VERSION`, `CONFIG_SCHEMA_VERSION`, `HASH_VERSION` — do not
 * move either, for the stronger reason that M08.1 does not write those files.
 * The catalog *records* the manifest version a run was written with, which is
 * reading a number, not owning one.
 */

/**
 * The language `apps/admin-client` and `apps/admin-server` speak.
 *
 * - 1 — M08.1, the first shape.
 * - 2 (M08.4) — the closed error-code list gained `admin/run_failed`, and the
 *   job shapes both applications exchange gained `spec` and `execution`. M08.3
 *   wrote the test this bump had to pass and then declined to take it: *a policy
 *   refusal that is not a bad value — there is none in M08.3 — would be [a new
 *   code], and would move `ADMIN_CONTRACT_VERSION` deliberately.* A run that was
 *   accepted, started and then fell over is exactly that refusal, so the
 *   language moved. A build that speaks 1 would receive a code it cannot branch
 *   on and a job carrying two fields it does not know, which is what a contract
 *   version is for saying.
 */
export const ADMIN_CONTRACT_VERSION = 2;

/**
 * The version stamped into a persisted catalog document.
 *
 * - 1 — M08.1, the first shape. Nothing has been written yet: M08.2 owns the
 *   store, so there is no v0 document anywhere and no migration to write.
 * - 2 (M08.4) — a job document records **what it will run** and **where it ran**:
 *   `spec` carries the experiment's identity, kind, seed and configuration hash
 *   before a single match is played, and `execution` carries the canonical
 *   directory the job owns, how it was executed and how many attempts it has
 *   had. Both are required rather than optional, because a job with no spec is a
 *   job nothing can start, and M08.2's own recorded limitation — *a queued job
 *   has no kind to filter on* — was a consequence of their absence rather than a
 *   design.
 *
 * **There is no migration from 1, and that is a decision rather than an
 * omission.** A v1 job document never recorded which configuration it held, and
 * inventing one would be inventing the run. So a v1 document is refused with the
 * older-build sentence below rather than guessed at. The blast radius is
 * genuinely nothing: `@tcg/admin-server` has never had an entry point, a port or
 * a `start` script, so the only v1 documents that have ever existed were written
 * by these tests into temporary directories.
 *
 * The batch document's shape did not change and its version moved anyway,
 * because M08.1 chose one constant for the family and gave the reason: *a build
 * that can read a batch but not its jobs has not read the batch.* Splitting them
 * now to avoid one unnecessary refusal would trade a stated invariant for a
 * saved keystroke.
 */
export const CATALOG_DOCUMENT_VERSION = 2;

/**
 * The version stamped into one line of a job's append-only event log.
 *
 * - 1 — M08.2, the first shape. Nothing has been written by an earlier build,
 *   so there is no older line anywhere and no migration to write.
 */
export const JOB_EVENT_VERSION = 1;

/** Every version the admin surface stamps, in one object. */
export const CURRENT_ADMIN_VERSIONS = Object.freeze({
  contract: ADMIN_CONTRACT_VERSION,
  catalogDocument: CATALOG_DOCUMENT_VERSION,
  jobEvent: JOB_EVENT_VERSION,
});

/** Names the version domain an error is about, so a caller can say which failed. */
export type AdminVersionField = keyof typeof CURRENT_ADMIN_VERSIONS;

/** Every version field, for a caller that has to be total over them. */
export const ADMIN_VERSION_FIELDS = Object.keys(
  CURRENT_ADMIN_VERSIONS,
) as readonly AdminVersionField[];

const VERSION_LABELS: Readonly<Record<AdminVersionField, string>> = Object.freeze({
  contract: 'admin contract',
  catalogDocument: 'admin catalog document',
  jobEvent: 'admin job event',
});

/**
 * The version a payload of this kind must declare.
 *
 * `z.literal` rather than a range: a request is written by the build that sends
 * it, so anything but the current number is either a future build — refused
 * below, before the schema is reached — or an older one, which has no migration
 * and must not be guessed at.
 */
export const contractVersionSchema = z.literal(ADMIN_CONTRACT_VERSION);
export const catalogDocumentVersionSchema = z.literal(CATALOG_DOCUMENT_VERSION);
export const jobEventVersionSchema = z.literal(JOB_EVENT_VERSION);

/**
 * Whether `found` is a readable version number this build is simply too old for.
 *
 * Deliberately narrower than `refuseFutureVersion`, which also answers "this
 * record declares no readable version at all". A caller standing at a decode
 * boundary needs the two apart: a value that names a **newer build** deserves
 * the readable refusal below, and everything else — a missing field, a string, a
 * fraction, a zero, a negative number — is an ordinary malformed value.
 */
export function isFutureVersion(field: AdminVersionField, found: unknown): found is number {
  return (
    typeof found === 'number' &&
    Number.isInteger(found) &&
    found >= 1 &&
    found > CURRENT_ADMIN_VERSIONS[field]
  );
}

/**
 * The single refusal, shared by both version fields. `null` when readable.
 *
 * The wording is deliberately the sentence `@tcg/bot-config` already uses, and
 * this is a copy of one sentence rather than a dependency on the package that
 * holds it. `refuseFutureVersion` there is closed over `BotConfigVersionField`
 * and reports `bot_config/*` codes; reusing it would mean either widening a bot
 * seat's vocabulary to include the admin catalog, or reporting an admin failure
 * under a bot's code. Neither is worth avoiding one duplicated string, and
 * ADR 0023 §7 asks for the treatment, not the module.
 */
export function refuseFutureVersion(
  field: AdminVersionField,
  found: unknown,
  path: string,
): AdminError | null {
  const supported = CURRENT_ADMIN_VERSIONS[field];
  if (isFutureVersion(field, found)) {
    return newerBuild(VERSION_LABELS[field], found, supported, path, { field });
  }
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    return adminError(
      'admin/missing_version',
      `This record does not declare a readable ${VERSION_LABELS[field]} version, so it cannot be read.`,
      { path, context: { field, supported } },
    );
  }
  return null;
}

/**
 * The other end of the same rule: a record from an **older** build, which this
 * one has no migration for.
 *
 * A separate function rather than a fourth branch inside `refuseFutureVersion`,
 * because the name of that function is a promise about what it answers and
 * M08.1's record names it. A caller that reads persisted documents asks both
 * questions in order; a caller negotiating a live request asks only the first,
 * since an older client is refused by the request schema before anything is
 * stored.
 *
 * It exists because M08.4 is the first tranche to move `CATALOG_DOCUMENT_VERSION`
 * at all. Without it a v1 job document would fail its `z.literal` as
 * `admin/schema` — *expected 2, received 1* — which tells a person nothing about
 * what happened or what to do, and would be the exact failure the newer-build
 * sentence exists to prevent, pointing the other way.
 */
export function refusePastVersion(
  field: AdminVersionField,
  found: unknown,
  path: string,
): AdminError | null {
  const supported = CURRENT_ADMIN_VERSIONS[field];
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) return null;
  if (found >= supported) return null;
  return olderBuild(VERSION_LABELS[field], found, supported, path, { field });
}

/**
 * The same two refusals for a version this build **reads but does not own**.
 *
 * The admin catalog holds one such number: an experiment configuration declares
 * `@tcg/simulator`'s `CONFIG_SCHEMA_VERSION`, and M08.4 stores a copy of that
 * configuration beside the job that runs it. The number is the simulator's, so
 * there is no `AdminVersionField` for it and there must not be one — an admin
 * version field is something this package moves, and inventing one here would be
 * the admin layer claiming ownership of a schema it only calls.
 *
 * What is shared is the treatment, which is what ADR 0023 §7 actually asks for:
 * a record from a newer build gets the readable sentence, a record from an older
 * build gets the readable counterpart, and anything that is not a version number
 * at all is reported as such.
 */
export function refuseForeignVersion(
  record: string,
  found: unknown,
  supported: number,
  path: string,
): AdminError | null {
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    return adminError(
      'admin/missing_version',
      `This record does not declare a readable ${record} version, so it cannot be read.`,
      { path, context: { record, supported } },
    );
  }
  if (found > supported) return newerBuild(record, found, supported, path, { record });
  if (found < supported) return olderBuild(record, found, supported, path, { record });
  return null;
}

function newerBuild(
  label: string,
  found: number,
  supported: number,
  path: string,
  extra: Readonly<Record<string, string>>,
): AdminError {
  return adminError(
    'admin/unsupported_version',
    `This record was written by a newer build (${label} version ${String(found)}; this build reads up to ${String(supported)}). Update the application.`,
    { path, context: { ...extra, found, supported } },
  );
}

function olderBuild(
  label: string,
  found: number,
  supported: number,
  path: string,
  extra: Readonly<Record<string, string>>,
): AdminError {
  return adminError(
    'admin/unsupported_version',
    `This record was written by an older build (${label} version ${String(found)}; this build reads version ${String(supported)}) and there is no migration for it, so it was left where it is rather than guessed at.`,
    { path, context: { ...extra, found, supported } },
  );
}
