# M08 — AI Lab and Player Meta

The administrator-only surface for configuring, queueing, running and reading
balance experiments, and the durable home for evidence from real human matches.
Owner-approved on 2026-08-14 as the milestone after M07.

This file is the only detailed scope document for M08.
[`IMPLEMENTATION_PLAN.md`](../../IMPLEMENTATION_PLAN.md) carries one status row
and names the next tranche; nothing else describes this milestone.

## Preconditions

Run after M07.9. M08 depends on the simulator being a library rather than only a
command, on experiment directories being canonical, and on the evidence-claim
system that decides what a run may be cited for — all of which M05 and M07
finished.

## Objective

Build an admin-only surface that can:

1. Configure multiple tests through ordinary controls rather than hand-authored
   JSON.
2. Put tests into a durable queue in a chosen order.
3. State the exact scheduled match count before starting.
4. Pause, resume, cancel safely, and recover after a process restart.
5. Present readable results with graphs, exact tables, limitations, and
   drill-down to decks, matches and retained replays.
6. Compare result sets across deliberate content changes.
7. Preserve real human-match deck and choice data as a separate evidence source.
8. Capture the state and recent context of explicit surrenders without
   pretending that surrender alone proves a balance problem.

Four primary test styles: **Precon Benchmark** (selected precons against each
other in mirrored seat orders), **Open Meta Search** (the search chooses legal
Commanders and builds its own decks), **Commander Search** (equal-budget searches
constrained to selected Commanders, then a frozen finalist tournament), and
**Adaptive Counter Search** (decks revise between evaluation blocks, with the
cumulative series and the frozen final strength recorded separately).

Three advanced templates expose laboratory capabilities that already exist,
without presenting them as new balance authorities: **Candidate Patch
Comparison**, **Pilot Robustness**, and **Engine Soak** termination testing.

## Revalidated baseline — read from code at `6727841`, 2026-08-14

Every line below was re-checked against the branch during M08.0 rather than
copied from the proposal.

### Versions

| Constant                                           | Value   |
| -------------------------------------------------- | ------- |
| `CARD_SCHEMA_VERSION`                              | 5       |
| `MATCH_SCHEMA_VERSION`                             | 7       |
| `PROTOCOL_VERSION`                                 | 6       |
| `RULES_VERSION`                                    | `0.4.0` |
| `CONFIG_SCHEMA_VERSION` (experiment configuration) | 1       |
| `MANIFEST_SCHEMA_VERSION`                          | 8       |
| `SUMMARY_SCHEMA_VERSION`                           | 7       |
| `REPORT_SCHEMA_VERSION`                            | 8       |
| `TELEMETRY_SCHEMA_VERSION`                         | 6       |
| `SEARCH_CHECKPOINT_VERSION`                        | 2       |
| `SEED_DERIVATION_VERSION`                          | 2       |
| `HASH_VERSION`                                     | 1       |
| `MATCH_STREAM_HEADER_VERSION`                      | 1       |
| `SPECTATOR_REPLAY_VERSION`                         | 6       |
| `BOARD_TELEMETRY_VERSION`                          | 3       |

`docs/status-audit.md` holds the complete generated list; the rows above are the
ones M08 is most likely to move, recorded here so a later tranche can say what
changed and what deliberately did not.

### What exists

- **The simulator is an importable library.** `@tcg/simulator` points `main` and
  `exports` at `src/index.ts`, and the barrel exports `runExperiment`,
  `buildSchedule`, `runJobsInPool`, every configuration schema, every analysis
  function and every artifact version constant. M08 does not need to drive the
  CLI to run an experiment.
- **`experimentConfigSchema` is a strict discriminated union of five kinds** —
  `batch`, `search`, `comparison`, `replacement`, `robustness` — built from
  `z.strictObject` throughout. Unknown fields are already refused.
- **An experiment is a directory** whose file and directory names are fixed by
  `experimentPaths`, and `results/` is git-ignored. Resume is defined by what is
  on disk; `readJsonl` already drops and reports a truncated final line.
- **The web client is one Vite application with three screens** — deck builder,
  match, spectator — plus help. There is no admin surface and no second entry
  point.
- **The multiplayer server keeps lobbies and matches in memory and has no
  analytics sink.** Neither `apps/multiplayer-server/src` nor `@tcg/protocol`
  mentions analytics; restarting the process ends every live match.
- **`concede` and `server_timeout` are already distinct engine actions**, routed
  to `handleTermination` with different reasons. What is not distinct is the
  _origin_ of a concession: `match-server.ts` turns a player leaving a live match
  into the same `concede` action an explicit button produces, so the difference
  M08.21 and M08.23 need has to be preserved above the engine, not inside it.
- **The shipped pilots are calibration instruments.** Four of them —
  `aggressive`, `defensive`, `value`, `random-legal` — and ADR 0022 already
  makes "what may this run be cited for" a machine-readable field. None is
  archetype-aware and none is human.
- **M01–M07.9 are complete**, and the next non-code activity on record is
  structured manual playtesting of the four 40-card precons. The 50-card
  expansion is not started.

### Corrections to the proposal, found by re-checking

- The proposal described concession and disconnect timeout as different engine
  actions and implied the remaining gap was only a durable envelope. Half of that
  holds. The engine distinction is real, but **explicit concede and
  leave-message concession are already indistinguishable at the engine
  boundary** — both are `concede` — so M08.21 must carry the origin as an
  analytics field rather than expect to read it off the action.
- The proposal's own file, placed at the repository root, **fails
  `npm run audit:check`**: `PERMITTED_ROOT_DOCS` allows exactly `README.md`,
  `CLAUDE.md` and `IMPLEMENTATION_PLAN.md`, and the audit lists every other root
  Markdown file as unexpected. The file belongs outside the repository, as it
  says of itself.

## Locked interpretation

Do not reopen these while implementing M08.

- "Change cards between matches" means changing **deck membership**. An adaptive
  run never rewrites card definitions.
- AI results remain **calibration evidence** under the existing evidence-claim
  system. The admin panel must not promote them to final balance conclusions.
- Human telemetry is another **observation source**, not an automatic balance
  score.
- Explicit surrender is a perceived-hopelessness, pacing and friction signal. It
  can correlate with balance. The system must never label the nearest card
  "overpowered" from proximity alone.
- Wave 1 Commander-legal pools are **41–42 cards for a 40-card singleton deck**.
  Search reports must display the forced-inclusion floor and must not read
  near-universal card inclusion as preference.
- The admin panel **configures and visualizes** the simulator. It must not fork
  or duplicate simulator rules, deck legality, scheduling, aggregation or report
  meaning.
- **Experiment directories and their validated raw records remain canonical.** A
  catalog may index them; it must not replace their provenance contract with an
  opaque database.
- Raw AI, human, mixed, precon, search and adaptive results stay
  **distinguishable**. Never pool unlike evidence into one unexplained win rate.
- **Discovery and validation are different stages.** Decks found on search games
  are frozen and evaluated on fresh seed families before a validation claim is
  shown.

## Exclusions

Not part of M08 unless the owner separately changes scope.

- Authoring cards, rebalancing precons, or moving the deck size from 40 to 50.
- Resolving Q4, Q44, Q45 or Q46.
- Public matchmaking, accounts, MMR, moderation, or a generic operations console.
- Public feedback prompts or surrender questionnaires. M08 captures the
  mechanical foundation; feedback UI waits for public testing.
- Tracking deck-builder hovers, searches, or every card considered. Submitted
  deck snapshots, revisions and match decisions are sufficient.
- Claiming a stable unique-player count. Match-local participant IDs are not
  people, and the product has no identity contract.
- Letting the admin service accept shell commands, arbitrary filesystem paths,
  arbitrary output roots, or unvalidated JSON blobs.
- Automatically publishing candidate card changes, or letting an AI edit live
  content.
- Adding a Unit cap, or reading a large board as proof that one is needed.
- Mid-match AI continuation from a human surrender state. Preserve enough state
  to enable a later milestone; do not hide new engine or replay work inside
  telemetry capture.
- Simulator CPU work anywhere in the live multiplayer event loop.

## Architecture

Decided in [ADR 0023](../architecture/0023-admin-lab-boundary.md): a separate
admin client bundle, a separate admin orchestration process, a shared strict
contracts package, a file-backed catalog behind an interface that indexes rather
than copies canonical experiment directories, loopback binding with an explicit
refusal to start unauthenticated off loopback, and no charting dependency adopted
before a tranche needs one.

## Information architecture

Used consistently across the service, the client and this document:

| Concept            | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| **Test batch**     | An ordered collection of jobs chosen by the administrator.           |
| **Experiment job** | One validated execution unit in the queue.                           |
| **Stage**          | A declared part of a composite job, e.g. search then finalist round. |
| **Match**          | One played game.                                                     |
| **Run result**     | Immutable output from one job, config, content and seed identity.    |
| **Baseline**       | A run deliberately pinned for later comparison.                      |

Final navigation: Overview, New Test Batch, Queue, Results, Player Meta, Deck
Explorer, Card Explorer, Match Explorer, Versions/Data Health. A navigation entry
is added only by the tranche that makes its page honest and usable. No decorative
empty pages.

## Result rules that apply to every result view

Visible before a reader may treat a number as evidence:

- Content, rules, schema, telemetry, pilot, analysis and software provenance.
- Completed, abnormal, failed, surrendered, timed-out and excluded counts.
- Denominator and sample support.
- Seat orientation, and the pilot and source split.
- Confidence or uncertainty wherever the existing statistics contract provides
  it.
- Replicate disagreement.
- Evidence-claim and calibration standing.
- Whether the run was exploration or fresh-seed validation.
- Whether compared result sets have compatible or deliberately different content
  hashes.

Two rules that are defects until a tranche fixes them:

- **Zero observations are not a zero win rate.** When either the included or the
  excluded comparison group is empty, inclusion lift is `insufficient_data`.
  Tests must cover a card present in every deck and a card present in none.
- **Card inclusion uses an eligibility-aware denominator.** A card is not
  unpopular in a deck whose Commander could never legally include it.

Charts supplement exact tables and never replace them. A tooltip is never the
only way to obtain a value.

---

## M08.0 — Milestone record and architecture decision — **done (2026-08-14)**

Start M08 without implementing product behaviour: re-audit the current
boundaries, create the milestone record and the ADR, convert the owner decisions
into locked scope and a tranche checklist, and record version baselines from code
rather than from prose.

### Checklist

- [x] **Every baseline re-read from the branch, not transcribed.** The version
      table above was taken from the constants themselves —
      `CARD_SCHEMA_VERSION` 5, `MATCH_SCHEMA_VERSION` 7, `PROTOCOL_VERSION` 6 —
      and the "What exists" section from `apps/simulator/src/index.ts`,
      `apps/simulator/src/config.ts`, `apps/simulator/src/reporting/sinks.ts`,
      `apps/web-client/src/App.tsx`, `apps/multiplayer-server/src/main.ts` and
      `packages/rules-engine/src/engine.ts`.
- [x] **Two claims in the proposal were wrong and are corrected here, not
      quietly adopted.** Explicit concede and leave-message concession are the
      same `concede` action by the time the engine sees them, which moves work
      into M08.21; and the proposal's own file at the repository root fails
      `npm run audit:check` against `PERMITTED_ROOT_DOCS`, so it was moved out of
      the repository rather than committed.
- [x] Exactly one M08 milestone file — this one — and exactly one M08 row in
      `IMPLEMENTATION_PLAN.md`. The plan's **next bounded task** now names M08.1;
      the manual playtests it previously named are preserved as the parallel
      non-code activity they always were, because M08 is an implementation
      milestone and does not replace them.
- [x] [ADR 0023](../architecture/0023-admin-lab-boundary.md) records the four
      decisions M08.0 owes: the admin application and service boundary
      (`apps/admin-client`, `apps/admin-server`, `packages/admin-contracts`, all
      separate from the player bundle and the live match process), catalog
      persistence (validated JSON documents plus per-job JSONL, atomic by
      temporary file and `rename`, behind an interface), the authentication
      boundary (loopback by default, refuse to start off loopback without a
      configured token, header only, never a URL or a log), and how experiment
      directories stay canonical (the catalog indexes and annotates; it never
      copies evidence).
- [x] The charting-dependency question is answered **now, as a default** rather
      than left to be decided implicitly: none is adopted, hand-authored SVG plus
      the mandatory exact table is the baseline, and any tranche that adopts one
      records its bundle and accessibility cost at the point of adoption.
- [x] Every owner decision in the proposal appears above as objective, locked
      interpretation, exclusion, information architecture, result rule, or a
      tranche below. Nothing was dropped and nothing was added.
- [x] **No runtime behaviour changed.** The tranche touches three documents:
      this file, the ADR, and `IMPLEMENTATION_PLAN.md`, plus the regenerated
      `docs/status-audit.md` whose ADR and milestone inventories moved as a
      result.
- [x] Verified: `npm run check:consistency`, `npm run audit:check` and
      `npm run verify` all pass.

### Versions — deliberately unchanged

Nothing moved. M08.0 adds no schema, no message and no artifact; the first
version constant M08 introduces is `packages/admin-contracts`' own, in M08.1, and
ADR 0023 records why it is independent of the play-contract versions.

---

## M08.1 — Shared admin contracts and experiment catalog model — **done (2026-08-21)**

Define the versioned language the service and the client both speak: job and
batch identity, job and stage status, progress, result reference, experiment
purpose (`exploration` or `validation`), source class and timestamps; the legal
state transitions and terminal states; a catalog entry that **references** a
canonical experiment directory and its manifest and config hashes rather than
copying them as authority; pagination, filter and structured-error contracts; and
version constants with future-version refusal.

**Acceptance:** exhaustive transition and schema tests, round trips,
unknown-field refusals, and `npm run verify`.

**Exclusion:** no filesystem store, no server, no UI, no job execution.

### Post-M09 baseline, re-read 2026-08-21

M08.0's baseline was taken at `6727841` on 2026-08-14 and is deliberately left
where it is. M09 ran between then and now, so the rows below record what moved
and — more usefully — what did not.

| Constant                         | M08.0   | Now     | What that means for M08                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROTOCOL_VERSION`               | 6       | 11      | Five bot-seat message shapes. No M08 tranche reads this wire.                                                                                                                                                                                                                                                                      |
| `RULES_VERSION`                  | `0.4.0` | `1.0.0` | Q49: a Token on the battlefield is a Unit. Replays recorded before it are refused, which M08.10 must report rather than hide.                                                                                                                                                                                                      |
| `CARD_SCHEMA_VERSION`            | 5       | 5       | Unchanged.                                                                                                                                                                                                                                                                                                                         |
| `MATCH_SCHEMA_VERSION`           | 7       | 7       | Unchanged.                                                                                                                                                                                                                                                                                                                         |
| Every simulator artifact version | —       | —       | `CONFIG_SCHEMA_VERSION` 1, `MANIFEST_SCHEMA_VERSION` 8, `SUMMARY_SCHEMA_VERSION` 7, `REPORT_SCHEMA_VERSION` 8, `TELEMETRY_SCHEMA_VERSION` 6, `SEARCH_CHECKPOINT_VERSION` 2, `SEED_DERIVATION_VERSION` 2, `HASH_VERSION` 1 — **all exactly as M08.0 found them.** M08.3, M08.4 and M08.5 face the surface they were scoped against. |

Four M09 additions change later M08 work, and each is a thing to **use** rather
than to rebuild:

- **`BotSummarySink` is the human-match ingestion seam, and it already exists.**
  M09.17 defined one interface with one method and one call site in
  `apps/multiplayer-server/src/bot-match-summary.ts`, checked by a source scan,
  and `NO_DURABLE_SUMMARY_STORE` says in a constant that M08 Player Meta owns the
  store. **M08.22 implements that interface**; it does not invent a second one,
  and M08.1 defines no summary shape, because `botMatchSummarySchema` in
  `@tcg/protocol` at `BOT_SUMMARY_SCHEMA_VERSION` 1 is already the record.
- **`@tcg/deck-generator` was extracted in M09.8** and owns deck identity, the
  legality check, deck plan resolution and `HASH_VERSION`. It declares itself
  **server-only** (`node:crypto`). M08's admin client must not import it; the
  admin server may.
- **`@tcg/bot-config` (M09.1) owns controller provenance, the difficulty and
  style registries and the four deck-source modes.** `DIFFICULTY_REGISTRY_VERSION`
  is now 3 with three available difficulties — easy, normal and hard — and
  `DifficultyDefinition` carries `tactics`. M08.8's pilot and difficulty controls
  read those registries; nothing in M08 restates them.
- **The future-version refusal now has a settled shape.**
  `@tcg/bot-config#refuseFutureVersion` fixes the sentence, `isFutureVersion`
  fixes how narrow the predicate is, and `@tcg/protocol/bot-compatibility` shows
  the decode-boundary form. M08.1 follows all three.

One correction M08.1 had to make to its own first draft, found by reading the
manifest rather than the brief: **there is no single content hash on a run.**
`environmentHashesSchema` splits the address four ways — `mechanicsHash`,
`pilotInputHash`, `presentationHash`, `fullContentHash` — because M01.3 found
that one hash made a flavour-text fix invalidate every experiment that had used
the card, and a manifest records one such set **per environment** with none
marked primary. A `comparison` or `replacement` run has two on purpose. The
catalog therefore references an array of environments, and the filter is named
`fullContentHash` rather than `contentHash` so nobody has to guess which of the
four it matches.

### What M08.1 built

`packages/admin-contracts` — `@tcg/admin-contracts`, the third workspace
[ADR 0023](../architecture/0023-admin-lab-boundary.md) §1 named, exporting one
barrel and depending on exactly `@tcg/shared` and `zod`.

**The lifecycle policy has one implementation.** `JOB_LIFECYCLE` and
`BATCH_LIFECYCLE` are tables; `nextState`, `legalActions`, `isTerminal`,
`applyTransition` and `reachableStates` read them, and the tests read them too,
so a queue screen, a store and a runner cannot hold three copies that disagree.
A job has nine states and a batch eight, and the differences are the argument:
there is no batch `failed` or `interrupted` — a batch of ten jobs where two
failed has not failed, and a batch owns no worker to interrupt — and no job
`draft`, because M08.9 edits membership before start and a job is validated when
it is created. `cancelling` exists because M08.5's cancel is graceful, and a
screen that showed `running` after the operator cancelled, or `cancelled` while
matches were still being written, would be telling the same class of lie as
recovering `running` work as `completed`. **`interrupted` cannot reach
`completed` at all.** `retry` is the milestone's one declared exception to
terminality, which is why `terminal` is declared rather than derived from "has no
outgoing row".

**The catalog indexes and never copies.** A job document holds identity —
experiment ID, kind, seed, config hash, per-environment content hashes, manifest
version, software commit — plus lifecycle, progress, timestamps and annotations,
and **no result**. Two projections rather than one habit: `storedResultReference`
carries a `rootId` and a relative directory and never leaves the server;
`resultReference` has no `location` to strip, so a future tranche that wants one
must widen the schema deliberately. `statusTimestampProblems` is the single rule
both shapes apply, and it is what makes `retry` honest — `failed → queued` is
only a legal document once `completedAt` is cleared. Deleting an entry cannot
mean deleting a run, because nothing in the package can express removing one.

**Requests name identifiers, and there is nowhere to put a path.** Every request
payload is a strict object over IDs, and the closed set is exported so the test
can be total over it. `jobActionRequestSchema` carries the _action_, never the
target state, so no client decides what `cancel` means from `running`.

### Checklist

- [x] **Strict schemas for identity, status, progress, result reference, purpose,
      source class and timestamps.** IDs are prefixed and restricted to
      `[a-z0-9]` because M08.2 uses them as file names, so the alphabet _is_ the
      traversal defence. Timestamps are UTC ISO 8601 with milliseconds — stricter
      than a saved deck's — so lexicographic and chronological order are the same
      order, which is what lets a continuation token mean anything. Source class
      is a **set** of the milestone's six words, canonically ordered so two equal
      classifications serialize to equal bytes, with `mixed` refused beside `ai`
      or `human` because it already means both.
- [x] **Legal state transitions and terminal states, exhaustively tested.** Every
      declared row is applied and checked; every state/action pair the tables do
      **not** declare is applied and refused, derived from the tables rather than
      listed. Terminal states, unreachable states, unused actions, duplicate rows
      and batch/job separation are all asserted from the models.
- [x] **Catalog entry references the experiment directory and its hashes.** Per
      the correction above, an array of environments each carrying the four
      addresses, beside the config hash, the manifest version and the commit. A
      test asserts the reference retains hashes and canonical-run identity while
      the document carries no field that could hold a result.
- [x] **Pagination, filter and structured-error contracts.** Pagination is
      bounded at 1–200 with a base64url cursor that cannot spell a path; `total`
      is nullable because a file-backed store can answer "here are fifty" far
      more cheaply than "there are 8,412". The filter covers what M08.1 itself
      defines and nothing more — no Commander and no precon, because a filter for
      a field this contract does not model could not be honoured. Errors are a
      closed code list with context validated rather than trusted: a forbidden
      key is matched as a case-insensitive substring, and unsafe context is
      **refused with a visible marker** rather than silently redacted.
- [x] **Version constant, and a future version refused with a readable message.**
      Two constants, both `1`, both owned by a named schema — see below.
- [x] Verified: 254 focused tests in 9 files, `npm run check:consistency`,
      `npm run audit:check` and `npm run verify` all pass.

### Versions

Two introduced, and no other constant in the repository moved.

| Constant                   | Value | Owned by                                                    |
| -------------------------- | ----- | ----------------------------------------------------------- |
| `ADMIN_CONTRACT_VERSION`   | 1     | `adminRequest` / `adminResponse` — the negotiated language. |
| `CATALOG_DOCUMENT_VERSION` | 1     | `catalogJobDocumentSchema` / `catalogBatchDocumentSchema`.  |

**Two rather than one**, because ADR 0023 §7 says they answer different
questions: a contract version fails as "these two builds cannot converse", and a
document version fails as "this file is from the future", read possibly months
later by a build with no counterpart to negotiate with. Collapsing them would
mean either refusing a perfectly good stored catalog because the request language
moved, or claiming a stored document is readable because two ends of a socket
agree.

**Two rather than four**: the batch document and the job document are one family,
written by one store into one directory, and a build that can read a batch but
not its jobs has not read the batch. M08.2's per-job event log is a separate
artifact with its own lifetime and would be a reason to add a third.

**No play-contract version moves, and this is a claim about what M08.1 did.**
`PROTOCOL_VERSION`, `MATCH_SCHEMA_VERSION`, `RULES_VERSION`,
`CARD_SCHEMA_VERSION` and every `@tcg/bot-config` constant stay exactly where
they are: this tranche adds no message to the play wire, no field to a serialized
match, no rule, no card and no bot-seat field. The strongest form of the claim is
structural rather than promised — `@tcg/admin-contracts` depends on `@tcg/shared`
and `zod` and nothing else, so none of those constants is reachable from it, and
a test reads the manifest to keep it that way. The simulator's artifact versions
do not move either, for the stronger reason that M08.1 writes none of those
files: the catalog **records** the manifest version a run was written with, which
is reading a number rather than owning one.

`refuseFutureVersion` copies `@tcg/bot-config`'s sentence rather than importing
its function. That function is closed over `BotConfigVersionField` and reports
`bot_config/*` codes, so reusing it would mean either widening a bot seat's
vocabulary to include the admin catalog or reporting an admin failure under a
bot's code. ADR 0023 §7 asks for the treatment, not the module.

### Exclusions honoured

No filesystem store, no HTTP server, no admin client, no job execution, no
estimator, no preset, no queue control and no chart. The package imports no Node
built-in at all, spawns nothing, and is depended on by neither
`@tcg/web-client` nor `@tcg/multiplayer-server` — each asserted by a source scan
over the package's own sources and the two manifests, so the absence fails when
it stops being true rather than when somebody notices.

## M08.2 — Durable catalog and queue store — **done (2026-08-21)**

Persist batches and jobs and recover their truthful state: the catalog behind an
interface, atomic write and append discipline, validation on read and on write,
`running` work recovered after restart as an explicit resumable or interrupted
state and **never** as completed, ordered batch membership with independent jobs,
and refusal of duplicate IDs and unsafe result-root references.

**Acceptance:** restart, truncated and corrupt tail, duplicate, ordering,
transition and path-boundary tests.

**Exclusion:** no simulator process, no HTTP API.

### What M08.2 built

`apps/admin-server` — `@tcg/admin-server`, the second of the three workspaces
[ADR 0023](../architecture/0023-admin-lab-boundary.md) §1 named, depending on
exactly `@tcg/admin-contracts`, `@tcg/shared` and `zod`.

It is a **store and nothing else**, and the absence is deliberate: there is no
`main.ts`, no `start` script and no port. M08.4 adds the `@tcg/simulator`
dependency and the first thing that runs an experiment; M08.6 adds the HTTP
boundary and the loopback refusal. An entry point that bound nothing would be the
decorative scaffolding the milestone warns against, so the boundary suite asserts
the manifest declares `typecheck` and no other script.

**The catalog is a directory keyed by identifier.** `batches/batch_<id>.json`,
`jobs/job_<id>.json`, `events/job_<id>.jsonl`. Flat, because M08.1 chose the ID
alphabet for exactly this and said so — an ID body is lowercase letters and
digits, with no dot, no separator, no parent reference and no uppercase, so a
document name is safe by construction rather than by escaping, and two IDs cannot
collide on a case-insensitive filesystem. The traversal defence is the alphabet,
and this tranche is where it started earning that description.

**A reader never sees half a document.** Every write is a temporary file in the
destination's own directory, then a flush, then a `rename`. A crash leaves the
previous document whole and at most one temporary file, which no listing reads
because listings match `.json` only. This differs from `@tcg/simulator`'s
`writeJson` on purpose: a run's own output belongs to a run that is gone if it
was killed mid-write, while a catalog document is read by the _next_ process.

**Nothing is trusted in one direction only.** Every document is parsed by its
schema before it is written and again after it is read, and the four ways a read
can fail are kept apart because a caller does four different things about them:
absent, unparseable, from a newer build, or the wrong shape. The version is read
**before** the schema, so a document from a future build gets the repository's
sentence — _this record was written by a newer build … update the application_ —
rather than a literal mismatch nobody can act on.

**Recovered work is never finished work, and the rule is derived rather than
listed.** Recovery interrupts exactly the statuses the lifecycle table gives an
`interrupt` transition — today `running`, `pausing` and `cancelling` — so a state
added to the table later is swept or left alone by the table's own decision.
`queued` and `paused` are settled and durable and are left byte-for-byte
untouched; terminal jobs are finished and are not reopened. That `completed` is
unreachable is asserted from the model rather than from an example, and every one
of the nine job statuses is driven into a real store, restarted over, and
checked. Recovery is part of opening the catalog, so no caller can forget it and
then read a `running` that no process is running.

**Jobs are independent, and batch membership is ordered.** A job is its own file
with its own lifecycle; moving one rewrites neither its siblings nor its batch,
which is asserted by comparing the untouched documents rather than by inspection.
Membership is the array's order and never a sort, and it is editable only while
the batch is a `draft` — `enqueue` is the moment an ordering becomes final, and a
job appearing in a batch that had already started would change what "the
scheduled work" meant after a person had read it. M08.9 owns the controls for
adding, duplicating, removing and reordering; M08.2 owns the invariant they will
act through.

**Identifiers are minted by the store.** The contract says why — _minting one is
the store's job, never a caller's_ — so a job input has nowhere to put an ID, and
`admin/duplicate_id` is tested by injecting an `IdSources` that repeats itself
rather than by waiting for a collision that should never happen. A refused
duplicate leaves the first entry intact and does not join the batch.

**A result reference is checked before it is stored, never after.** Resolution
looks the root identifier up in configuration, re-applies
`experimentDirectorySchema` rather than trusting a document that may not have
come from this build, and then compares the **real** path of the longest existing
prefix against the real root — which is the only check that sees a symlink. Real
directory links are created in the tests, and both an escaping leaf and an
escaping _parent_ are refused; a link that stays inside the root is followed. The
comparison uses `relative` rather than a string prefix, so a sibling directory
whose name merely starts with the root's is not read as being inside it. No
refusal names a path: the message and the context carry the identifier the
administrator configured, and a test walks every refusal asserting no separator,
drive letter or parent reference reaches either.

**The store writes nothing inside a result root at all.** It indexes runs; it
does not produce them, and a test asserts the result root is never even created.
There is no delete, no remove and no move anywhere in the interface, which is
what makes "deleting a catalog entry must not delete an experiment directory" a
property rather than a policy — M08.28 decides whether deletion exists, with the
standing preference that omission beats an unsafe delete button.

**The per-job event log is the history the document cannot hold.** Four kinds —
`created`, `transition`, `annotated`, `result_attached` — appended one line at a
time and never rewritten. It is what makes M08.5's _retry is a visible lifecycle
action, never a silent automatic success_ true: a job that went
`failed → queued → running → completed` ends up spelling `completed` on its
document, and only the log can say it failed once. A cause of `operator`,
`runner` or `recovery` keeps a crash-recovery interrupt distinguishable from an
operator's cancel. **Progress is not logged** — 2,000 matches would write 2,000
lines saying a counter moved, and the document answers that exactly and cheaply.
A truncated final line is dropped and reported, the discipline `readJsonl`
already fixed for `matches.jsonl`.

**The document is written before its event.** A crash between the two loses a
line of history about a change that really happened, which is recoverable; the
reverse would leave a log claiming a transition the catalog never made, which is
not.

**The cursor is a position, not an offset.** The pagination contract says
stability is the store's promise rather than the schema's, and this is that
promise: a token encodes the creation instant and the ID in base64url — an
alphabet with no slash, plus or padding, so the contract's path-free guarantee
holds by construction — and a listing walks every row exactly once even when
entries are created underneath it, which is tested by inserting one mid-listing.
A token this build did not issue is refused with `admin/invalid_cursor`, and with
the same sentence however it failed.

### One platform finding, measured rather than assumed

`rename` over a destination another handle has open **fails on Windows**; POSIX
replaces it silently. This was found by a test, not predicted. Two things answer
it, and the second is a limit rather than a fix:

- **In-process, reads take the same per-document lock writes do.** That removes
  the collision the store would otherwise have with itself — the one M08.6's
  concurrent request handlers would create — and it is why the concurrency test
  lives at the store level, where a reader hammering a job beside forty rewrites
  always gets a whole, schema-valid document.
- **Out of process, a bounded retry absorbs ordinary overlap and then reports.**
  Measured at roughly a quarter of renames colliding under a tight external
  reader, with almost all landing within five attempts. The rest do not land at
  all: a destination held open **continuously** cannot be replaced on Windows,
  and a jittered backoff was tried and did marginally worse, because the cause is
  occupancy rather than phase. So the write fails loudly after about a fifth of a
  second, leaving the previous document intact — asserted as a test rather than
  left as a hope.

### Checklist

- [x] **Store behind an interface, with the smallest justified local
      persistence.** `CatalogStore` is written against the successor ADR 0023 §3
      keeps the option open for rather than against a directory of JSON: every
      method is asynchronous, no method takes or returns a path, and identifiers
      are minted rather than passed in. The persistence is files plus one
      append-only log per job, exactly what the ADR chose and no more — no
      database, no index, no second copy of a run.
- [x] **Atomic writes; every document validated both directions.** Temporary file
      plus flush plus `rename`, with the Windows contention finding above; and
      both the write path and the read path parse through the same schema, with
      the version read first so a newer build is refused readably.
- [x] **Restart recovers `running` as resumable or interrupted, never completed.**
      Derived from the lifecycle table, applied by a second store over the same
      directory — which is what a restarted process actually is — and checked for
      every one of the nine statuses. `interrupted` resumes to `queued`, so
      `start` stays the only thing that claims a worker.
- [x] **Ordered batch membership; jobs independent.** Creation order is the
      administrator's order and nothing sorts it; a job's move rewrites nothing
      else; concurrent mutations of four jobs all land; and a batch that has left
      `draft` refuses a new member.
- [x] **Duplicate IDs and result-root escapes refused.** A repeated mint is
      refused without overwriting or joining the batch; an unknown root, a
      lexical traversal, an escaping link and an escaping parent link are all
      refused, and no refusal carries a path.
- [x] Verified: 142 focused tests in 6 files in the new `admin-server` project
      and 277 in 10 files in `packages`; `npm run check:consistency`,
      `npm run audit:check` and `npm run verify` all pass.

### Versions

One introduced. No other constant in the repository moved.

| Constant            | Value | Owned by                                          |
| ------------------- | ----- | ------------------------------------------------- |
| `JOB_EVENT_VERSION` | 1     | `jobEventSchema` — one line of a job's event log. |

**A third, and M08.1 wrote the test it had to pass**: _a third artifact with its
own lifetime is a reason to add a third constant; a second schema inside the same
family is not._ The event log passes it. A job document is rewritten in place and
only its latest state is ever read; a log is appended to and never rewritten, so
a build reads lines written by every build before it. Adding an event kind does
not change a document, and changing a document does not make one historical line
unreadable — which is the independence two numbers are for.

**`ADMIN_CONTRACT_VERSION` and `CATALOG_DOCUMENT_VERSION` both stay 1**, and both
for a reason rather than by omission. No request or response shape changed, so
two builds that could converse still can. No persisted document shape changed
either: M08.1 defined the job and batch documents and M08.2 is the first thing to
_write_ one, so there is no older file anywhere and nothing to migrate.

**No play-contract or simulator artifact version moves.** `PROTOCOL_VERSION`,
`MATCH_SCHEMA_VERSION`, `RULES_VERSION`, `CARD_SCHEMA_VERSION`,
`MANIFEST_SCHEMA_VERSION`, `SUMMARY_SCHEMA_VERSION` and every other artifact
constant are exactly where M08.1 found them. The strongest form of the claim is
structural: `@tcg/admin-server` depends on `@tcg/admin-contracts`, `@tcg/shared`
and `zod`, so none of those constants is reachable from it, and a source scan
names each of them and requires the sources not to.

### Exclusions honoured

No simulator import, no experiment execution, no HTTP server, no socket, no child
process, no shell, no UI. Each is a scan over the workspace's own sources rather
than a promise, so it fails when it stops being true rather than when somebody
notices. Nothing under `apps/web-client` or `apps/multiplayer-server` depends on
either admin workspace, and `@tcg/admin-contracts`' own boundary test was widened
from "imported by nobody" — which was only true while no admin application
existed — to "imported by admin workspaces and nothing else", with a second test
asserting the allowance actually matches something so it cannot pass for the
wrong reason.

### Limitations recorded rather than worked around

- **`kinds` and `fullContentHash` can only match a job that has a result.** Both
  read the run identity, and a job acquires one when its experiment directory
  exists. The job document carries no configuration reference at all — M08.1
  stopped deliberately short of one — so a queued job has no kind to filter on.
  **M08.4** is the tranche that maps a job to a config and a directory and is the
  first that could put a kind on a job before it runs; until then a job with no
  result matches neither filter, which is the honest answer for a run that is not
  yet a run. Tested in both states.
- **Cross-process exclusion is not claimed.** Mutations are serialized per
  document within one process, which is what ADR 0023 §4 describes — one
  administrator, one orchestration process. A second _reader_ is always safe
  because of the `rename`; a second writer is out of scope, and there is no lock
  file to go stale.
- **`total` is reported exactly because every document is read anyway.** ADR 0023
  §3 accepted that cost, and the contract makes `total` nullable precisely so a
  successor that cannot count cheaply can decline to.

## M08.3 — Match-count estimator and honest presets

Let the UI state exactly how much work a configuration schedules, by reusing the
simulator's real scheduling semantics rather than a second formula that can
drift. Typed presets for Precon Smoke/Standard/Deep, Open Meta, Commander Search,
Candidate Comparison, Pilot Robustness and Engine Soak, each expanding into an
ordinary validated config or stage plan and recording every value it chose.
Display games **per seat order**, state when a search or adaptive total is a
bound rather than exact, and report the forced-inclusion floor per Commander from
legal pool size and deck size.

**Acceptance:** the estimator equals the real generated schedule on
representative configs; preset snapshots and legal-pool calculations tested.

**Exclusion:** Adaptive Counter Search is a reserved type only. Its algorithm is
M08.16 and later.

### Checklist

- [ ] Estimator derived from `buildSchedule`, not reimplemented.
- [ ] Seven typed presets, each expanding into a validated config or stage plan.
- [ ] Games per seat order; bounds labelled as bounds.
- [ ] Forced-inclusion floor per Commander.

## M08.4 — Existing-experiment execution bridge

Execute one existing simulator config through the catalog without changing
simulator semantics: call simulator APIs directly or spawn a fixed executable
with a fixed argument vector, translate one catalog job into one canonical
experiment directory and record its process and result identity, derive progress
from canonical output and checkpoint state rather than a second counter, preserve
partial results and resume identities on ordinary success or failure, and capture
structured failure diagnostics without leaking secrets.

**Acceptance:** complete, failure, progress, result-link, fixed-argument and
duplicate-start tests.

**Exclusion:** no network service, no UI.

### Checklist

- [ ] One job maps to one canonical experiment directory.
- [ ] Progress derived from canonical state.
- [ ] Fixed argument vector; no shell, ever.
- [ ] Partial results and resume identity preserved on failure.

## M08.5 — Runner lifecycle, recovery and resource bounds

Truthful control over long-running work: bounded concurrency and worker limits;
**pause** stops scheduling new match work and lets in-flight matches reach their
normal record boundary; **resume** uses the existing JSONL and checkpoint
contracts; **cancel** is graceful and preserves inspectable partial output;
interrupted jobs recover after an orchestration restart without duplicating
matches or lineage; **retry** is a visible lifecycle action, never silent
automatic success.

**Acceptance:** pause/resume, cancel, crash and restart, worker-limit,
duplicate-resume and interrupted-state tests; a resumed run stays equivalent to
uninterrupted execution wherever the simulator promises it.

**Exclusion:** no network service, no UI.

### Checklist

- [ ] Bounded concurrency and worker limits.
- [ ] Pause, resume, cancel with the semantics above.
- [ ] Restart recovery without duplicated matches or lineage.
- [ ] Retry is an explicit action with its own record.

## M08.6 — Admin service and access boundary

Expose the catalog and runner safely to one admin client: the separate service
ADR 0023 chose, loopback by default with the non-loopback authentication refusal
enforced, versioned endpoints for capabilities and presets, batch creation, list
and detail, queue actions, progress, result summaries and bounded result tables,
request and response schemas validated on both boundaries, rate, body and
pagination limits, and path-traversal tests. Arbitrary experiment paths and raw
command execution stay impossible.

**Acceptance:** authorization, malformed input, future version, traversal,
pagination, lifecycle and restart integration tests.

**Exclusion:** no visual UI, no multiplayer telemetry.

### Checklist

- [ ] Loopback default; non-loopback refuses to start unauthenticated.
- [ ] Versioned endpoints, both boundaries schema-validated.
- [ ] Rate, body and pagination limits.
- [ ] Traversal and symlink-escape tests.

## M08.7 — Admin client shell

A usable, protected, responsive admin surface that does not pretend unfinished
pages work: the separate client ADR 0023 chose, authenticated connection state,
top-level layout, an Overview holding only real capability and health data,
accessible navigation, and global loading, error and empty states. The project's
visual language, kept readable at analytical density.

**Acceptance:** typecheck and build, component flows, access failure, and
empty/error states; `npm run verify`.

**Exclusion:** no experiment form, no chart.

### Checklist

- [ ] Separate client bundle; nothing admin reachable from the player bundle.
- [ ] Authenticated connection state and honest Overview.
- [ ] Keyboard navigation and narrow/wide layouts tested at component level.

## M08.8 — Precon Benchmark builder

Configure and enqueue the first immediately useful test without JSON:
multi-select shipped precons, pilots, preset or custom games per seat order,
replicates, retention and worker limit. Seat orders mirrored by default, with
disabling it an advanced action carrying a visible limitation. Exact total matches
and, where available, estimated storage and runtime. Validation against current
content and format at submission time. Save, reload and duplicate a form
configuration as an admin preset.

**Acceptance:** all/some/invalid precon, workload, mirrored orientation, stale
content, enqueue and form-restoration tests.

**Exclusion:** no result charts, no other builder.

### Checklist

- [ ] Precon, pilot, workload, replicate, retention and worker controls.
- [ ] Mirrored seat orders by default; disabling is advanced and labelled.
- [ ] Exact total matches shown before enqueue.
- [ ] Submission-time validation against current content.

## M08.9 — Queue UI and batch ordering

Make ordered work observable and controllable: create an ordered batch, add,
duplicate and remove jobs before start, reorder with accessible controls where
drag is an enhancement and never the only control. Show queued, running, pausing,
paused, interrupted, completed, failed and cancelled states, exact completed and
total matches where known, current stage or generation, elapsed time, and honest
remaining-time availability. Wire pause, resume, cancel and retry with
confirmations proportional to their consequences, and make clear that queue order
does not share experimental state.

**Acceptance:** state transition, keyboard reordering, restart recovery,
concurrent update and action-failure UI tests.

### Checklist

- [ ] Ordered batch editing before start, keyboard-reachable.
- [ ] Every lifecycle state visible and named.
- [ ] Remaining time shown only when it is honestly available.
- [ ] Queue order does not imply shared state.

## M08.10 — Result catalog and generic run detail

Browse completed and partial evidence before specialized charts exist: list and
filter by date, type, status, source, content hash, Commander or precon, and
exploration versus validation. Render provenance, configuration, completion
quality, evidence standing, exclusions, limitations and exact downloadable JSON,
CSV and Markdown artifacts. Notes, tags and a deliberate **mark as baseline**
action that never mutates canonical experiment output. Partial, old or refused,
corrupt and unsupported result schemas handled honestly.

**Acceptance:** pagination and filter, partial and corrupt result, download
authorization, baseline, and schema-refusal tests.

### Checklist

- [ ] Filterable list over the catalog, bounded and paginated.
- [ ] Provenance, completion quality and evidence standing on every detail view.
- [ ] Baseline, notes and tags stored beside the run, never inside it.
- [ ] Unsupported and corrupt results reported, not hidden.

## M08.11 — Precon result dashboard

Answer whether the current precons look uneven **under the selected instrument**:
overall win-rate bars with intervals and sample counts, an ordered matchup
heatmap with an exact-value table fallback, seat-order, pilot, match-length,
termination and replicate views, and click-through from a cell or bar to the
exact contributing matches, decks and replays. Calibration standing appears
before any "review" language. **No automatic balanced/unbalanced verdict.**

**Acceptance:** known fixture matrices, missing cells, ties, insufficient
samples, accessibility, filtering and drill-down tests.

### Checklist

- [ ] Win-rate bars with intervals and counts.
- [ ] Ordered heatmap plus exact table; no red/green-only meaning.
- [ ] Seat, pilot, length, termination and replicate views.
- [ ] Drill-down to exact matches, decks and replays.
- [ ] Calibration standing shown before any recommendation language.

## M08.12 — Card-inclusion integrity

Make card-selection numbers mathematically defined before more dashboards are
built on them: fix the zero-observation included/excluded defect so an undefined
contrast returns `insufficient_data` rather than a fabricated zero rate or a
recommendation; add eligibility-aware card denominators globally and per
Commander; report forced-inclusion floors from legal pool size and deck size;
preserve source, construction, pilot class, replicate and exploration/validation
partitions in card aggregates; and version every changed summary, report or API
contract with deliberate refusal or migration reasoning.

**Acceptance:** universal-card, absent-card, colour-ineligible-card,
forced-inclusion, mixed-source and regeneration tests.

**Exclusion:** no new Commander aggregate, no Open Meta UI.

### Checklist

- [ ] Undefined contrast returns `insufficient_data`.
- [ ] Eligibility-aware denominators, global and per Commander.
- [ ] Forced-inclusion floor reported wherever inclusion is shown.
- [ ] Partitions preserved; contract versions moved deliberately.

## M08.13 — Commander aggregates

Add the reusable Commander-level evidence the current reports lack: match counts,
overall, seat and pilot win rates, an opponent-Commander matrix, turn and
end-reason distributions, top and median deck fitness, population and archive
share, and within-Commander deck diversity where supported. Source, construction,
pilot class, replicate and exploration/validation partitions preserved, and every
changed contract versioned with reasoning.

**Acceptance:** small-sample, ordered Commander-matrix, seat and pilot partition,
population and archive, diversity, mixed-source and regeneration tests.

**Exclusion:** no Open Meta UI yet.

### Checklist

- [ ] Commander counts, win rates and opponent matrix.
- [ ] Turn and end-reason distributions; deck fitness and diversity.
- [ ] Partitions preserved; contract versions moved deliberately.

## M08.14 — Open Meta workflow

Let the AI choose among legal Commanders and cards, and show what emerges: all or
selected Commanders, unconstrained or plan seed policy, population, generations,
elite, mutation and crossover, opponents, games, archive, replicates, pilots and
retention through progressive disclosure. Render Commander share over
generations, win and matchup views, top and median deck results, top decklists,
card inclusion, and diversity and convergence. The forced-inclusion warning is
always beside selection statistics.

**Acceptance:** all and selected Commander, legality, workload, replicate,
forced-inclusion warning, convergence and report drill-down tests.

**Exclusion:** no per-Commander finalist championship.

### Checklist

- [ ] Progressive-disclosure search form over existing search config.
- [ ] Commander share by generation; diversity and convergence.
- [ ] Forced-inclusion warning beside every selection statistic.

## M08.15 — Commander Search and finalist championship

Compare equal-budget Commander ecosystems on fresh validation games: equal-budget
independent searches for selected Commanders, mutation and crossover kept
Commander-legal with locked mode never silently changing Commander, a
configurable number of sufficiently distinct finalists per Commander with the
diversity rule and any shortfall recorded, finalists frozen, and a fresh-seed
mirrored championship stage. Render best and median deck strength, exact lists,
within-Commander diversity, the opponent-Commander matrix, the seat and pilot
split, and final validation standing.

**Acceptance:** single and multiple Commander, equal-budget, lock, finalist
diversity, shortfall, frozen list, fresh-seed, mirrored championship and
drill-down tests.

### Checklist

- [ ] Equal-budget independent searches; lock never changes Commander.
- [ ] Finalist selection records its diversity rule and any shortfall.
- [ ] Frozen finalists, fresh seeds, mirrored championship.

## M08.16 — Adaptive Counter schema and deck lineage

Define a reproducible adaptive experiment and its immutable deck revision history
**without running adaptation yet**.

Default policy: Commander locked; the loser adapts after a mirrored evaluation
block; meta-aware objective; bounded 1–5-card legal swaps; the previous
successful revision retained; final decks frozen for a fresh-seed validation
stage.

Strict config for starting deck sources, Commander policy (`locked`, selected or
open), information policy (`public_observation` or an explicit
`analysis_full_deck`), total learning budget, block size, candidate count, swap
bound, optional deterministic rebuild trigger, reference-field share, retention
and final validation games. Immutable deck revision IDs with parent, exact swaps,
generation and block, opponent revision, construction and seed paths.
Deterministic legal candidate generation, with rejected candidates and their
reasons recorded. Strict raw, checkpoint and result schemas with a compatibility
policy. `public_observation` preserves the normal bot observation boundary;
full-deck mode is analysis-only and unmistakable in provenance.

**Acceptance:** schema refusal, deterministic candidate generation, legality,
Commander lock and open, bounded swaps and rebuild, rejected-candidate, lineage
and observation-policy tests.

**Exclusion:** no claim that the algorithm understands _why_ a card counters
another, no candidate evaluation or promotion, no card-definition mutation.

### Checklist

- [ ] Strict adaptive config with the full policy surface above.
- [ ] Immutable revision lineage with exact swaps and seed paths.
- [ ] Deterministic candidate generation; rejections recorded with reasons.
- [ ] Observation boundary preserved; analysis mode unmistakable.

## M08.17 — Adaptive evaluation and promotion loop

Let competing deck revisions respond to evaluated results inside a bounded
learning budget: never adapt from one isolated loss — the configured mirrored
block is the decision unit; default to loser adaptation with deterministic tie
and no-decision behaviour; evaluate candidates against the current opponent and
reference field according to the recorded objective, with pure-counter mode
allowed but labelled; promote or roll back using recorded evidence and
deterministic selection and tie-breaking; record every match against the exact
active revisions and keep cumulative series wins separate from candidate
screening; stop exactly at the declared budget or report why the final partial
block could not be scheduled.

**Acceptance:** block boundary, candidate promotion, rollback, tie, pure and
meta-aware objective, moving opponent, exact budget and deterministic replay
tests.

**Exclusion:** no checkpoint or resume, no final validation, no UI.

### Checklist

- [ ] Block is the decision unit; single losses never adapt.
- [ ] Deterministic promotion, rollback and tie-breaking.
- [ ] Series wins recorded separately from candidate screening.
- [ ] Budget honoured exactly, or the shortfall explained.

## M08.18 — Adaptive checkpointing, final validation and raw report

Make adaptive runs resumable and separate learned-series success from final deck
strength: checkpoint active revisions, candidate state, spent budget, reference
field, lineage and the next seed path; resume without changing lineage, replaying
a recorded match, or spending a seed twice; freeze final decks and run a
fresh-seed mirrored validation stage; produce machine-readable and Markdown
output for cumulative learning-series score, candidate screenings, revision
history, final deck diff, reference-field performance and frozen validation; and
detect repeated revision states and cycles **descriptively**, never as a verdict
that the meta is healthy.

**Acceptance:** checkpoint and resume equivalence, partial block, lineage,
fresh-seed, frozen-list, series-versus-validation separation, cycle fixture and
schema regeneration tests.

**Exclusion:** no admin UI.

### Checklist

- [ ] Checkpoint and resume without replaying or double-spending a seed.
- [ ] Frozen final decks, fresh-seed mirrored validation.
- [ ] Series score and validation standing reported separately.
- [ ] Cycles described, not interpreted.

## M08.19 — Adaptive Counter builder and dashboard

Make adaptive series configurable and understandable: starting deck selectors,
Commander, information and adaptation policy, match budget, block, candidate and
swap controls, counter-focus presets, reference field, and final validation
configuration. Explain total series wins versus final frozen-deck strength in both
the form and the report. Render cumulative and rolling win rates, the revision
timeline, cards added and removed, promotion evidence, starting and final deck
diff, reference-field performance, the final playoff, and detected recurring
revision cycles. Every revision and chart segment links to exact matches and
replays.

**Acceptance:** configuration restoration, workload, public and full-information
labelling, revision drill-down, cycle fixture and incomplete-run tests.

### Checklist

- [ ] Full adaptive configuration through controls.
- [ ] Series versus frozen strength explained in form and report.
- [ ] Revision timeline linking to exact matches and replays.

## M08.20 — Advanced test templates

Expose existing controlled tools without inventing new engines: Candidate Patch
Comparison maps to the existing baseline and candidate comparison contract with
identical reference population and seeds; Pilot Robustness maps to the existing
robustness contract and never pools profiles into one unexplained rate; Engine
Soak maps to a bounded batch and random-legal termination configuration and
reports crashes, stalls, loops, illegal choices, limit trips, deterministic
replay failures and coverage — **not balance**. Replacement and insertion tests
are exposed under advanced card analysis if their current contract remains sound.
A candidate change is a temporary experiment environment and can never publish
live content.

**Acceptance:** UI-to-config equivalence, declared-change refusal, shared-seed,
profile partition, soak failure retention and labelling tests.

### Checklist

- [ ] Three templates mapping onto existing contracts with no new engine.
- [ ] Soak reports engine health, never balance.
- [ ] Candidate environments cannot publish live content.

## M08.21 — Live human-match telemetry contract

Define durable human evidence without forcing it into simulator fields whose
meanings do not fit: a strict, versioned live-match analytics envelope reusing
shared telemetry payloads where semantics match. Record content, rules and
software provenance, source (`human_human`, `human_ai`, `ai_ai`), format, exact
immutable deck snapshots and hashes, Commander, seat order, turn, action and
event counts, outcome, and termination origin. Distinguish explicit concede
action, leave-message concession, disconnect timeout, rules victory, server
failure, and abandoned or unrecordable match — the first two are the same
`concede` action inside the engine, so the origin is an analytics field, not an
engine reading. Configurable summary, raw-event and replay retention. Display
names, invite and reconnect codes, IP addresses, authentication secrets and chat
stay out of analytics records. Match-local pseudonymous participant IDs only: no
claim of unique people and no cross-session tracking without a later identity and
privacy decision.

**Acceptance:** schema round trip, future-version refusal, privacy-field absence,
exact deck snapshot, source classification, and every termination-origin test.

**Exclusion:** no multiplayer write path, no feedback prompt.

### Checklist

- [ ] Strict versioned envelope reusing shared telemetry payloads.
- [ ] Six termination origins distinguished, including the two concessions.
- [ ] Privacy fields provably absent.
- [ ] Match-local pseudonymous participant IDs only.

## M08.22 — Multiplayer telemetry sink

Persist ordinary live-match evidence without changing gameplay: an injectable,
failure-contained analytics sink on the authoritative match server, where
analytics failure can neither corrupt nor block a live match. One canonical
live-match record and the configured retained artifacts at completion or
interruption. Idempotent duplicate, reconnect and retry handling. The gameplay
outcome stays authoritative even if analytics persistence fails.

**Acceptance:** normal victory, reconnect, disconnect timeout, server restart and
interruption, duplicate completion, configured retention and sink-failure tests.

**Exclusion:** no special surrender snapshot, no dashboard, no feedback prompt.

### Checklist

- [ ] Injectable sink; failure contained and never fatal to a match.
- [ ] One canonical record per match; writes idempotent.
- [ ] No simulator-grade work in the live event loop.

## M08.23 — Surrender context capture

Preserve what the match looked like when a human decided not to continue, without
assigning a cause: at explicit or leave concession, capture the pre-action state,
the pending choice or combat and reaction context, the last meaningful event
chain, the current and previous turn window, and the state summary later analysis
needs. Distinguish explicit concede from leave-message concession in the live
analytics envelope even though both correctly produce an engine concession. Keep
timeout and disconnect evidence separate and never fabricate a voluntary
surrender snapshot for it. Full-state snapshots contain hidden information and are
admin-only artifacts. Retain the exact content and deck identity, and the
event-distance windows exposure-adjusted analysis needs.

**Acceptance:** explicit concede, leave concede, pending choice, combat and
reaction window, recent-event window, timeout exclusion, idempotence, retention
and hidden-artifact authorization tests.

**Exclusion:** no surrender-reason UI, no causal "card made them quit" label, no
AI continuation from the state.

### Checklist

- [ ] Pre-action state, pending context and event windows captured.
- [ ] Explicit and leave concession distinguished; timeout excluded.
- [ ] Snapshots admin-only and authorization-tested.

## M08.24 — Player Meta aggregates

Compute what real testers choose and what happens, separately from AI: Commander
selection, exact deck and deck-cluster use, eligibility-aware card inclusion,
common card pairs, cards played, held and unusable, matchup results, match
duration and termination origin. Match-weighted and unique-deck-weighted views —
**no player-weighted popularity**, because there is no valid stable identity
denominator. Surrender rate by Commander, deck, turn and phase; board, Health and
resource state at surrender; and exposure-adjusted "surrender within action
chain, turn or round of card X" statistics that carry exposure and event-distance
counts and never auto-flag a cause. AI and human results side by side, never
silently combined.

**Acceptance:** source separation, no-stable-player identity, eligibility,
exposure denominator, surrender proximity windows, timeout exclusion, version
filter and sparse-data tests.

**Exclusion:** no Player Meta page.

### Checklist

- [ ] Selection, deck, card, pair, matchup, duration and termination aggregates.
- [ ] Match-weighted and unique-deck-weighted only.
- [ ] Exposure-adjusted surrender proximity with correlation semantics.
- [ ] AI and human never pooled.

## M08.25 — Player Meta dashboard

Present human choice and surrender evidence readably and honestly: Commander
selection, exact deck and cluster use, eligible card inclusion, card pairs,
matchups, duration and termination views; match-weighted and
unique-deck-weighted controls with no fake player-weighted option; surrender turn
and phase distribution, state summaries, and exposure-adjusted recent-card and
event tables in correlation language; filters by content version, date, source,
Commander, deck cluster, termination and private test label. AI and human views
sit side by side only where each denominator and evidence class stays explicit.

**Acceptance:** accessibility, filters, source labels, denominator display,
empty, sparse and corrupt states, surrender correlation wording, and aggregate
drill-down tests.

### Checklist

- [ ] Every M08.24 aggregate presented with its denominator visible.
- [ ] Correlation wording enforced on surrender proximity views.
- [ ] Empty, sparse and corrupt states designed, not incidental.

## M08.26 — Deck, Card and Match explorers

Make every aggregate inspectable. **Deck Explorer:** immutable list, Commander,
provenance and source, construction, revisions where known, matches, matchup
split, similar-deck cluster, and both AI and human evidence. **Card Explorer:**
eligible inclusion by source and Commander, draw, play and dead-hand metrics,
partners and replacements, contributing decks and matches, and explicit
insufficient-data states. **Match Explorer:** filterable match table, termination
context, event timeline, deck snapshots, selected decision diagnostics, and
authorized replay and surrender artifact links. Representative matches surfaced
automatically: closest, largest upset, shortest, longest, most one-sided,
pre-adaptation change, a random ordinary sample, and every abnormal match. Never
load unlimited raw rows into the browser.

**Acceptance:** cross-navigation, pagination, authorization, hidden information,
representative-selection determinism, unsupported replay and large-fixture tests.

### Checklist

- [ ] Three explorers that cross-navigate.
- [ ] Representative-match selection is deterministic and documented.
- [ ] Hidden information stays behind authorization.
- [ ] Bounded pagination everywhere.

## M08.27 — Version comparison, coverage and data health

Turn stored evidence into a reliable iteration loop: compare a selected baseline
with a later result across precon and Commander matchup delta, card inclusion
delta, duration and termination delta, deck-family appearance or disappearance,
and surrender-pattern delta. Refuse accidental comparison of incompatible runs;
allow deliberate content differences only with both hashes and versions and the
declared change shown. Coverage for cards and mechanics never eligible, included,
drawn, played, activated, triggered, targeted or observed by telemetry. Data
Health for corrupt or skipped records, failures, abnormal and stalled matches,
excluded comparisons, replicate disagreement, seat bias, pilot sensitivity,
unsupported mechanics and deterministic replay status. Annotations explain why a
candidate balance change was tested, and never rewrite historical raw output.

**Acceptance:** compatible, refused and deliberately-different comparison, delta
math, missing metric, coverage, corrupt record and annotation-immutability tests.

### Checklist

- [ ] Baseline comparison with refusal of incompatible runs.
- [ ] Coverage across the whole card and mechanic vocabulary.
- [ ] Data Health page over real recorded defects.
- [ ] Annotations additive; raw output immutable.

## M08.28 — Operational hardening and milestone acceptance

Finish the admin system without silently expanding it: enforce simulator resource
priority below live multiplayer work wherever they share a machine, and document
the deployment and process separation. Bounded retention, archive and export
controls — any deletion feature is separately confirmed, path-bounded and tested,
and omission is preferable to an unsafe delete button. Verify no secret or private
snapshot appears in logs, public client bundles, unauthenticated endpoints, or
exports claiming to be aggregate-only. End-to-end flows for each primary and
advanced test style, partial and resumed work, human match ingestion, surrender
context, explorer drill-down and before/after comparison. Representative UI visual
checks at wide and narrow widths, recording any unavailable visual tooling rather
than claiming inspection. Update the user-facing run instructions and the M08
record without duplicating it across documents. Clean-tree verification by the
repository's current audit practice.

**Acceptance:** all M08 checklist items pass, `npm run verify` passes, consistency
and generated-content audit checks pass, and the tree is clean after the final
record commit.

**Stop:** report the remaining genuine product decisions. Do not begin card
expansion, public feedback, matchmaking or automated rebalance work.

### Checklist

- [ ] Simulator work yields to live multiplayer work on a shared machine.
- [ ] Retention, archive and export bounded; deletion safe or absent.
- [ ] No secret or hidden artifact leaks into any public surface.
- [ ] End-to-end flows for every test style and every recovery path.
- [ ] Visual checks recorded honestly, including unavailable tooling.

---

## Final result-screen expectations

The default result screen answers, in order: what was tested; what happened; what
may deserve human review; how trustworthy and transferable the evidence is; and
which exact decks, cards, matches and replays produced it.

| Question                  | Presentation                                                              |
| ------------------------- | ------------------------------------------------------------------------- |
| Precon/Commander strength | Horizontal win-rate bars with intervals and counts                        |
| Ordered matchups          | Heatmap plus exact accessible table                                       |
| Meta evolution            | Commander population share by generation                                  |
| Card selection            | Eligibility-aware inclusion and performance view; never an undefined lift |
| Game length               | Distribution or histogram plus exact summary                              |
| Deck strength             | Distribution plus top and median deck tables                              |
| Adaptive series           | Cumulative and rolling result with a deck-revision timeline               |
| Patch comparison          | Paired deltas with the declared change and discordant counts              |
| Surrender                 | Turn and phase distribution plus an exposure-adjusted recent-event table  |
| Data quality              | Counts, exclusions, limitations, and links to affected matches            |

## Acceptance — not met

M08 is accepted when every tranche checklist above is complete, `npm run verify`
passes, the consistency and audit checks pass, and the tree is clean after the
final record commit.
