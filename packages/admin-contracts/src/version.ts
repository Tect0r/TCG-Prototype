import { z } from 'zod';

import { adminError, type AdminError } from './errors.js';

/**
 * The two version domains the admin surface has, and the one rule both obey: a
 * record from a *newer* build is refused with a readable message rather than
 * migrated on a guess.
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

/** The language `apps/admin-client` and `apps/admin-server` speak. */
export const ADMIN_CONTRACT_VERSION = 1;

/**
 * The version stamped into a persisted catalog document.
 *
 * - 1 — M08.1, the first shape. Nothing has been written yet: M08.2 owns the
 *   store, so there is no v0 document anywhere and no migration to write.
 */
export const CATALOG_DOCUMENT_VERSION = 1;

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
    return adminError(
      'admin/unsupported_version',
      `This record was written by a newer build (${VERSION_LABELS[field]} version ${String(found)}; this build reads up to ${String(supported)}). Update the application.`,
      { path, context: { field, found, supported } },
    );
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
