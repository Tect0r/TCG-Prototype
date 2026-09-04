import { z } from 'zod';

import { adminError, type AdminError } from './errors.js';

/**
 * The four version domains the admin surface has, and the one rule they all
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
 * - **`SAVED_CHOICE_VERSION`** is what a builder form an administrator kept was
 *   written in. M08.8 added it under the same test: a saved choice holds a
 *   `presetChoice` and nothing about a run, so its shape moves when a *builder*
 *   gains a control — and stamping it with the catalog's number would mean that
 *   adding a knob to a form makes every stored batch and job unreadable.
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
 * - 3 (M08.6) — the language acquired a **service**. Six codes were added to the
 *   closed list for failures that only exist once there is a boundary and a
 *   process to fail at — `admin/unauthorized`, `admin/rate_limited`,
 *   `admin/payload_too_large`, `admin/unknown_endpoint`, `admin/no_result` and
 *   `admin/already_running` — thirteen endpoints were
 *   named with a request and a response shape each, and `jobActionRequestSchema`
 *   was **narrowed**: its `action` is now one of the four verbs an operator has
 *   rather than any member of `jobActionSchema`, because `start`, `complete`,
 *   `fail`, `interrupt` and the two settling actions are the runner's and the
 *   recovery's and were never a request. A build speaking 2 would send an action
 *   this one refuses and receive codes it cannot branch on, which is exactly what
 *   a contract version is for saying — and the version segment in every endpoint
 *   path is derived from this constant, so the refusal is readable rather than a
 *   bare 404.
 * - 4 (M08.8) — the language acquired a **builder**. Four endpoints were added —
 *   `content`, `estimate`, `save-choice` and `saved-choices` — because a form
 *   that offers precons and pilots has to be told which ones exist, a total that
 *   is shown *before* anything is enqueued has to be obtainable without
 *   enqueueing, and a configuration an administrator keeps has to be stored
 *   somewhere the browser is not. One code was added to the closed list,
 *   `admin/catalog_limit`. `capabilities.versions` gained a fourth
 *   member, and `presetChoiceSchema` **widened**: the three precon-benchmark
 *   presets now carry a `settings` block — workload, replicates, seat-order
 *   mirroring, replay retention and a worker request — which M08.3 said in as
 *   many words would happen here: *M08.8 owns the custom-workload control and
 *   will widen this shape visibly when it adds one.*
 *
 *   A build speaking 3 would send a precon choice with no `settings` — accepted,
 *   since the block prefaults — but would receive a `capabilities` answer
 *   carrying a version field it does not know and would be unable to reach any
 *   of the four new addresses. That is what a contract version is for saying.
 * - 5 (M08.9) — the language acquired a **queue**, and the move that matters
 *   most is not one of the three new addresses. `enqueue-preset` **no longer
 *   starts anything**: it fills a batch and leaves it `draft`, and
 *   `start-batch` is what releases it. Until this version the batch lifecycle's
 *   `draft` state existed and had zero width — the same call that created the
 *   jobs took the `enqueue` transition in the next statement — so *add,
 *   duplicate, remove and reorder before start*, which M08.9 owes, had no
 *   window to happen in. Opening that window is a change to what an existing
 *   address does rather than to its shape, which is precisely the kind of change
 *   a payload schema cannot express and a contract version has to.
 *
 *   The three addresses are `reorder-batch`, `duplicate-job` and `start-batch`,
 *   and all three answer with the whole `batchDetail` rather than an
 *   acknowledgement, because every one of them changes the ordering and a client
 *   that patched its own copy would become a second author of the order.
 *   `reorderBatchRequestSchema` is the one new payload shape; it carries the
 *   **whole** order rather than a move, so a stale client is refused rather than
 *   silently applying its move to an order somebody else has already changed.
 *
 *   Removing a job before start added **no** address: it is the existing
 *   `job-action` with `cancel`, which the lifecycle table has always permitted
 *   from `queued`. A withdrawn job stays in its batch, spelling `cancelled`,
 *   because ADR 0023 §3 gives this workspace no delete and inventing one for the
 *   convenience of a tidy list would be the unsafe delete button M08.28 is
 *   supposed to decide about.
 *
 *   A build speaking 4 would enqueue a preset and wait forever for work that
 *   this build will not start without `start-batch`, and could not reach any of
 *   the three new addresses to fix it. That is what a contract version is for
 *   saying.
 * - 6 (M08.10) — the language acquired a **result catalog**. Two addresses were
 *   added, `result-artifacts` and `result-artifact`, so that the canonical
 *   documents a run already wrote — `summary.json`, `report.md`, the CSV exports
 *   — can be listed and downloaded unchanged rather than regenerated by a screen
 *   (`artifacts.ts` gives the argument). They are two rather than one because a
 *   summary this build refuses to read must not make the raw evidence
 *   unreachable, and folding availability into `resultSummary` would have done
 *   exactly that.
 *
 *   `catalogFilterSchema` **widened** by two fields, `preconIds` and
 *   `commanderIds`, which M08.1 had deferred with a reason this tranche answers
 *   rather than overrules: the objection was that the contract did not model
 *   them, and `contentPreconSchema` models both. One code was added to the
 *   closed list, `admin/artifact_too_large`.
 *
 *   A build speaking 5 would send a filter with neither field — accepted, since
 *   both default to *all of them* — and would be unable to reach either new
 *   address, so its result view could show numbers and offer no file. That is
 *   what a contract version is for saying.
 * - 7 (M08.15) — the language acquired a **finalist championship**. One address
 *   was added, `schedule-championship`, so a Commander Search's frozen finalist
 *   round — deferred since M08.13 because its decks do not exist until the
 *   named searches finish — can be turned into a real, running job once they
 *   have. Its request names the completed `commander_search` batch and the
 *   diversity settings an administrator chooses at that moment (how many
 *   finalists per Commander, how many fresh-seed games), not a filesystem
 *   location or a hand-assembled configuration; its response is the same
 *   `batchDetail` `start-batch` answers with, because scheduling a championship
 *   creates a batch exactly the way filling one from a preset does.
 *
 *   A build speaking 6 could see a Commander Search's jobs complete and could
 *   not reach the one address that turns them into the comparison the preset
 *   named in advance — its own `deferredStages` entry would stay deferred
 *   forever. That is what a contract version is for saying.
 * - 8 (M08.19C) — the language acquired a **directory-keyed Adaptive Counter
 *   run**. Two addresses were added, `adaptive-summary` and
 *   `adaptive-result-table`, so that an Adaptive Counter run's evidence
 *   (`adaptive-results.ts`, M08.19B) can be shown the way every other run's
 *   already is, even though it has no `CatalogStore` job and no `JobId` to key
 *   one by. Both requests name an `experimentId` and nothing shaped like a
 *   location; the server resolves it against its own configured result root
 *   exactly as `resolveResultLocation` does for every other result (ADR 0023
 *   §5).
 *
 *   A build speaking 7 could enqueue and watch every catalog job this
 *   language knows, and could not reach either new address, so an Adaptive
 *   Counter run's series, revisions, screening, deck diff or reference-field
 *   evidence would stay unreadable no matter how many times its result
 *   document was regenerated. That is what a contract version is for saying.
 * - 9 (M08.25C) — the language acquired directory-keyed **Player Meta**
 *   reads. Two addresses were added, `player-meta-summary` and
 *   `player-meta-result-table`, so that a filtered read over live matches
 *   (`player-meta-results.ts`, M08.25B) can be shown a Commander, deck/
 *   cluster, eligible card, pair, matchup, duration and termination view at
 *   a time. Neither request names a run identifier at all — a Player Meta
 *   read has no `experimentId`-shaped sub-path, only a `filter`
 *   (`playerMetaFilterSchema`) — because the server's one configured
 *   default result root already names the whole answer; the server
 *   resolves that root directly rather than through
 *   `resolveResultLocation`, which requires a relative directory Player
 *   Meta has no equivalent for.
 *
 *   A build speaking 8 could read every catalog job's results and an
 *   Adaptive Counter run's evidence, and could not reach either new
 *   address, so no Commander, deck, cluster, card, pair, matchup, duration
 *   or termination table computed from live matches would be visible no
 *   matter how many matches had been played. That is what a contract
 *   version is for saying.
 */
export const ADMIN_CONTRACT_VERSION = 9;

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
 *
 * - 3 (M08.6) — a job document records **what asked for it**. `origin` names the
 *   preset and the stage a job was expanded from, or says `direct` when a
 *   configuration was handed to the store without one. It is required rather
 *   than optional for the reason `spec` is: the field exists to bind a preset's
 *   published limitations to the run it produced, and an optional field is one a
 *   result view has to be prepared to find missing — which is the same as not
 *   having it.
 *
 * **There is no migration from 2 either, and the blast radius is again
 * nothing.** M08.6 is the first tranche to give this workspace an entry point
 * and a `start` script, so at the moment this number moved no catalog had ever
 * been written outside a test's temporary directory. That is exactly the
 * argument M08.4 made for the 1 → 2 move, and it is the last time it will be
 * available: after this build ships, a catalog exists on somebody's disk and the
 * next change to this shape has to be migrated rather than refused.
 *
 * - 4 (M08.15) — `jobOriginSchema` gained a third member, `commander_championship`,
 *   naming the batch a frozen finalist round was scheduled from and the diversity
 *   rule and per-Commander shortfall that selected it.
 *
 * **There is still no migration, and the 2 → 3 entry's promise — that the next
 * shape change would need one — is corrected rather than kept.** The shape
 * change itself is additive and harmless in one direction only: every `origin`
 * this build has ever written (`preset`, `direct`) still parses unchanged under
 * the wider `jobOriginSchema`, so a v3 *document's own content* is not the
 * problem. The `documentVersion` field is: `catalogDocumentVersionSchema` is a
 * `z.literal`, checked before the shape at all, so a v3 document is refused on
 * that field alone regardless of whether its `origin` would have parsed. That
 * refusal was never given the readable sentence `refusePastVersion` exists for
 * — `apps/admin-server`'s `readDocument` had only ever called
 * `refuseFutureVersion`, because no version before this one had moved since
 * `refusePastVersion` was written at M08.4, and this tranche is the first to
 * wire the older-build half in. The blast radius of not also migrating the
 * content is the same nothing the 1 → 2 and 2 → 3 moves both had: this
 * workspace has never had a real deployment, so no catalog exists on a real
 * disk to be orphaned by it, only test fixtures written to temporary
 * directories — which is the argument this file has made at every move so far,
 * restated because the next one should not repeat the promise this entry is
 * correcting.
 */
export const CATALOG_DOCUMENT_VERSION = 4;

/**
 * The version stamped into one line of a job's append-only event log.
 *
 * - 1 — M08.2, the first shape. Nothing has been written by an earlier build,
 *   so there is no older line anywhere and no migration to write.
 */
export const JOB_EVENT_VERSION = 1;

/**
 * The version stamped into a saved builder configuration (M08.8).
 *
 * - 1 — M08.8, the first shape. Nothing has been written by an earlier build, so
 *   there is no older document anywhere and no migration to write.
 *
 * **A fourth constant rather than a fourth use of `CATALOG_DOCUMENT_VERSION`**,
 * and the test M08.1 set for adding one is the test this passes: *a third
 * artifact with its own lifetime is a reason to add a third constant; a second
 * schema inside the same family is not.* A saved configuration is not in the
 * batch-and-job family. It is written by a person filling in a form and read
 * months later by whichever build is running then; it holds a `presetChoice`,
 * whose shape moves whenever a preset gains a knob, and it holds nothing about a
 * run. Stamping it with the catalog's number would mean that adding a control to
 * a builder makes every stored batch and job unreadable — and that reading a job
 * document proves a saved form is readable, which it does not.
 *
 * This is the same argument `JOB_EVENT_VERSION` was added under, applied to the
 * other new artifact this milestone has produced.
 */
export const SAVED_CHOICE_VERSION = 1;

/** Every version the admin surface stamps, in one object. */
export const CURRENT_ADMIN_VERSIONS = Object.freeze({
  contract: ADMIN_CONTRACT_VERSION,
  catalogDocument: CATALOG_DOCUMENT_VERSION,
  jobEvent: JOB_EVENT_VERSION,
  savedChoice: SAVED_CHOICE_VERSION,
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
  savedChoice: 'admin saved test configuration',
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
export const savedChoiceVersionSchema = z.literal(SAVED_CHOICE_VERSION);

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
