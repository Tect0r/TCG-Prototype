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

## Work-slice execution from M08.16

M08.15 remains the final tranche implemented under the original one-session
shape. Every incomplete tranche after it is divided below into ordered work
slices. A slice is a checkpoint, not a smaller claim of tranche acceptance.

- Run exactly one named slice per Sonnet session and stop after its focused
  semantic checks and checkpoint commit.
- At the start of a slice, revalidate only its stated boundary against current
  code and accepted ADRs. Paths named by previous slices are evidence, not a
  permanent ownership map.
- Mark only the completed slice checkbox. Leave the tranche checklist and root
  status row unchanged until the close slice.
- A **tranche close** slice adds no next-tranche implementation. It revalidates
  the combined acceptance criteria, regenerates derived audit facts when needed,
  runs `npm run check:consistency`, `npm run audit:check` and `npm run verify`,
  updates the durable record, and requests one bounded Opus review over the exact
  tranche commit range. Only an approved tranche is marked complete.
- If a slice discovers that its result crosses another ownership boundary, split
  the work at that boundary and record the smallest correction here before
  implementing it. Do not silently absorb the next slice.

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

> **Correction, recorded by M08.3 (2026-08-22).** The sentence above predicted
> that **M08.4** would add the `@tcg/simulator` dependency. It arrived one
> tranche earlier: ADR 0023 §2 puts the match-count estimator behind
> `buildSchedule` and M08.3's presets behind `experimentConfigSchema`, so M08.3
> could not be built without it. What M08.2 measured is unchanged — this
> workspace still runs no experiment, opens no port, spawns no process and
> invokes no shell — and the boundary suite now holds the first of those against
> the simulator's own entry points rather than against the import. M08.4 remains
> the first tranche that **runs** anything.

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

  > **Half superseded by M08.4 (2026-08-23).** A job document now carries a
  > `spec` from the moment it is created, so `kinds` reads the configuration's
  > kind and matches a **queued** job — the limitation this paragraph recorded is
  > closed, in the tranche it named. `fullContentHash` is unchanged and is a
  > different limitation for a better reason: a content address is a reading
  > taken from the resolved environment a run _played in_, so it does not exist
  > until the run does. Both states are still tested; what M08.2 measured about
  > its own build stands.

- **Cross-process exclusion is not claimed.** Mutations are serialized per
  document within one process, which is what ADR 0023 §4 describes — one
  administrator, one orchestration process. A second _reader_ is always safe
  because of the `rename`; a second writer is out of scope, and there is no lock
  file to go stale.
- **`total` is reported exactly because every document is read anyway.** ADR 0023
  §3 accepted that cost, and the contract makes `total` nullable precisely so a
  successor that cannot count cheaply can decline to.

## M08.3 — Match-count estimator and honest presets — **done (2026-08-22)**

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

### What M08.3 built

**The estimator does not estimate. It builds the schedule and counts it.**
`estimateConfig` in `apps/admin-server/src/lab/estimate.ts` calls `buildSchedule`
with the same pairing mode, seat mirroring, sampling and mirror-inclusion the run
will use, and reports what comes back. There is no arithmetic about tuples,
rotations or pilot pairings anywhere in the admin layer, which is ADR 0023 §2 in
its strongest available form: _a second formula is a thing that can be right
today._

Ten representative batch configurations are asserted against the schedule
`experiment.ts` itself would build from really resolved precons — one and three
games per seat order, mirroring off, the ordered matchup matrix, three pilots as
mirrors, two pilots in `all_pairs` and in `rotate`, a four-seat table, and a
sampled schedule both narrower and wider than the pairings it has — plus a
robustness run counted once per profile. Each equality is the estimate against a
schedule length, never against a formula.

**Counting a schedule needs deck hashes, not decks.** `buildSchedule` reads
exactly one field of a deck, so `ScheduleDeck` is now that one field and `SimDeck`
satisfies it structurally. That is what lets the estimator count a configuration
without inventing forty card IDs per deck, and it moved no call site. The count is
the real count; only the seeds differ, and no seed is reported.

**The crossing filter has one implementation now, not three.** A replacement
experiment and a search generation both build a round robin over two sets of decks
and keep only the cells that cross between them. `matchesBetween` is that
predicate, extracted into `schedule.ts` and used by `experiment.ts`,
`deck-search/evolve.ts` and the estimator — so the estimator counts a search
generation through the function the search evaluates through.

**Games are reported per seat order because they are counted per seat order.**
The breakdown is the built schedule grouped by the `orientation` field
`buildSchedule` stamps on every match. A breakdown obtained by dividing a total by
the seat count would be wrong exactly where it matters: in the ordered matchup
matrix the four diagonal cells are mirrors, rotating a deck against a copy of
itself gives the same table back, and the real split of that 16-match schedule is
**10 and 6** rather than 8 and 8.

**A bound says it is one, and says why.** The basis has three values, not two:
`exact`, `upper_bound` and `at_least`. A precon benchmark is exact. A search is an
upper bound, because its opponent field is drawn from an archive that overlaps the
current population. A replacement is `at_least`, because how many variants exist
depends on which comparable cards the builder finds and every variant adds
matches. `combineBases` is the one place the combination rule lives, and
`at_least` beats `upper_bound`: a total containing one part that can grow without
limit is not an upper bound on anything. The schema refuses a bound with no
reason, a seat-order breakdown that does not add up, a total that is not the sum
of its stages, and a total whose basis is stronger than its stages support.

**Nothing generates a population to estimate one.** A `generated` deck source is
reported as an upper bound at its requested count with the reason attached — the
generator can yield fewer decks when the pool refuses a draw — because a UI
estimate that spent a minute building two thousand decks would not be an estimate.
Named precons _are_ resolved, for real, against the environment the run will use,
so a precon this build cannot play is refused now rather than an hour in.

**The forced-inclusion floor is read, never recomputed.** `poolReportFor` already
owns the arithmetic; `forcedInclusionFor` reads it per Commander and the contract
schema is its transport, asserted field for field against the function. The Wave 1
numbers are pinned in a test as an exact table:

| Commander                   | Legal pool | Capacity | Deck size | Slack | Forced floor |
| --------------------------- | ---------- | -------- | --------- | ----- | ------------ |
| `bastion_commander`         | 42         | 42       | 40        | 2     | 38           |
| `chief_containment_scholar` | 41         | 41       | 40        | 1     | 39           |
| `goblin_warboss`            | 41         | 41       | 40        | 1     | 39           |
| `grave_matriarch`           | 42         | 42       | 40        | 2     | 38           |

`FORCED_INCLUSION_CAVEAT` is a single exported sentence rather than prose each
screen writes for itself, and every estimate that fixes a Commander carries it. An
unconstrained search reports a floor for **every** legal Commander, because every
one of them is a Commander it may choose.

**Eight presets, and one reserved type that cannot be expanded.** The registry
carries a label, a summary, a status, a test style, the experiment kinds it is
made of, its source classification and its limitations. `adaptive_counter` is
present with status `reserved`, no kind and no member in the choice union at all,
so the exclusion is refused at the schema rather than in a branch somebody could
add to. Every available preset's expansion is re-parsed by
`experimentConfigSchema` in a test: _expands into an ordinary validated config_ is
settled by the simulator, not claimed by the admin layer.

The exact table each preset schedules, on all four shipped precons and the
selections the test names, is asserted rather than recorded automatically:

| Preset               | Kind         | Stages                                    | Matches | Basis         |
| -------------------- | ------------ | ----------------------------------------- | ------- | ------------- |
| Precon Smoke         | `batch`      | 1                                         | 12      | `exact`       |
| Precon Standard      | `batch`      | 1                                         | 48      | `exact`       |
| Precon Deep          | `batch`      | 1 (two pilots)                            | 288     | `exact`       |
| Open Meta Search     | `search`     | 1 (2 replicates × 5 generations)          | 2,560   | `upper_bound` |
| Commander Search     | `search`     | 2 (one per Commander) + 1 deferred        | 2,560   | `upper_bound` |
| Candidate Comparison | `comparison` | 2 (reference arms, then searches)         | 1,536   | `upper_bound` |
| Pilot Robustness     | `robustness` | 1 (3 profiles including `published`)      | 144     | `exact`       |
| Engine Soak          | `batch`      | 1 (random-legal, 25 games per seat order) | 300     | `exact`       |

**A preset records every value it chose, and who chose it.** A decision is a
dotted configuration path, a value and a source of `chosen` or `preset`, so a
reader can see that four games per seat order was Standard's decision and the
precon selection was theirs. Values the configuration schema defaults are
deliberately absent: a preset that listed every default would bury the six numbers
it decided under forty it merely did not override, and `config.json` in the run
directory already holds the complete resolved configuration.

**What the presets decide, and why those are not knobs.** Games per seat order is
what separates Smoke from Standard from Deep, so it is not a field on any of the
three — M08.8 owns the custom-workload control and will widen the shape visibly.
Engine Soak flies the random-legal pilot and cannot be told otherwise, because a
soak driven by a heuristic pilot would look like a benchmark and not be one, and
it runs without fail-fast, because stopping at the first abnormal match would
throw away every later finding. Pilot Robustness always includes `published` as
the reference arm and does not add it twice. Commander Search gives every
Commander the same population, generations and replicates, on its own seed family,
and locks each search to one Commander.

**A Commander Search names the stage it cannot schedule.** The frozen finalist
championship is real work this build cannot configure — the finalist field does
not exist until the searches finish, and the diversity rule that selects it is
M08.15 — so it is a deferred stage with a reason and a limitation on the estimate,
rather than an omission that would quietly turn "not yet" into "not part of the
test".

**The format's numbers come from the format.** `environmentConfigForFormat` was
added to the simulator and reads `content/formats` once, writing the construction
rules into the configuration exactly as a hand-authored file states them.
`deckFormatSchema` refuses to look a format up on purpose — a finished run must
not be silently redefined by a later content edit — which is right for a file
somebody froze and wrong for a caller that builds a configuration
programmatically. An admin layer that transcribed "40 cards, singleton, one copy"
would be a second copy of the format that keeps working, wrongly, the day the
format changes.

**A refusal names the field and never a path.** Every refusal is `admin/schema`
with the failing field's path — an unknown Commander names the ones the format
has, a candidate removal that is not in the pool says it would declare a change
that does not happen, a repeated selection says a selection is a set. Messages
reused from the simulator go through `scrubRefusal`, which replaces any token
`looksLikeFilesystemPath` flags with a marker: the simulator's messages are the
authoritative ones and it has no idea it is about to cross an admin boundary.

### The dependency M08.2 predicted for M08.4, corrected

M08.2's record says _M08.4 adds the `@tcg/simulator` dependency_. That was a
prediction and it was wrong by one tranche: ADR 0023 §2 puts the estimator behind
`buildSchedule` and this tranche's presets behind `experimentConfigSchema`, and an
admin layer that avoided the dependency could only reach either by writing the
second scheduler the ADR forbids. `@tcg/admin-server` therefore depends on
`@tcg/admin-contracts`, `@tcg/shared`, `@tcg/simulator` and `zod`.

What M08.2 was actually protecting is unchanged and is still structural. The
boundary suite now asserts the workspace imports **no simulator entry point that
would play a match** — the experiment runner, the batch runner, the match runner,
the search, the single-match helper, the worker pool and the telemetry collector —
and still reaches past the simulator into nothing: no `@tcg/rules-engine`,
`@tcg/deck-generator`, `@tcg/bot-interface`, `@tcg/protocol`, `@tcg/bot-config` or
`@tcg/card-data`, because each of those would be this workspace acquiring an
opinion about rules, deck legality or the wire. There is still no entry point, no
`start` script, no port, no child process and no shell.

One seam M08.1 deferred lands here for the same reason. `EXPERIMENT_KINDS` is
restated in `@tcg/admin-contracts` because a schema-only package cannot import the
simulator, and M08.1 said the check that needs both sides belongs to the first
layer able to import both — naming M08.4. M08.3 is that layer, so the test that
the five words match `experimentConfigSchema`'s five options is now a test rather
than a comment.

### Checklist

- [x] **Estimator derived from `buildSchedule`, not reimplemented.** It builds the
      real schedule with placeholder deck hashes and counts it, and applies
      `matchesBetween` — extracted so the replacement experiment, the search
      evaluation and the estimator share one predicate — wherever a run filters
      its schedule. Ten batch configurations and a robustness run are asserted
      equal to the schedule `experiment.ts` builds from resolved precons.
- [x] **Eight typed presets, each expanding into a validated config or stage
      plan.** The milestone's prose enumerates eight and this line previously
      counted seven; the enumeration is the authority, because each of the eight
      names a distinct expansion and the count named none of them. Every expansion
      is re-parsed by `experimentConfigSchema`, Commander Search is a two-stage
      plan plus a named deferred stage, and `adaptive_counter` is a reserved
      registry entry with no member in the choice union.
- [x] **Games per seat order; bounds labelled as bounds.** The breakdown is the
      built schedule grouped by orientation, which is why the matrix's mirrors
      land 10/6 rather than 8/8; the basis separates `exact`, `upper_bound` and
      `at_least`, the schema refuses a bound with no reason and a total whose
      basis its stages do not support, and `combineBases` is the only place the
      combination rule lives.
- [x] **Forced-inclusion floor per Commander.** Read from `poolReportFor` and
      asserted against it field for field, with the Wave 1 table above pinned in a
      test and `FORCED_INCLUSION_CAVEAT` carried by every estimate that fixes a
      Commander.
- [x] Verified: 216 focused tests in 8 files in `admin-server` (73 of them new),
      2,192 in 92 files in `packages` (52 new) and 437 in 23 files in `simulator`
      (4 new); `npm run check:consistency`, `npm run audit:check` and
      `npm run verify` all pass on Node v24.15.0.

### Versions

**None introduced, and none moved.** Four constants were considered and each was
deliberately left where it is.

| Constant                   | Value | Why it did not move                                                                                                                                                                                                                                                                                   |
| -------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_CONTRACT_VERSION`   | 1     | No request or response shape changed: the request payload registry is untouched, no error code was added, and neither envelope gained a member. The estimate and the expansion are computed values no payload yet carries; the tranche that puts them on the wire decides whether the language moved. |
| `CATALOG_DOCUMENT_VERSION` | 1     | Nothing here writes or reads a catalog document.                                                                                                                                                                                                                                                      |
| `JOB_EVENT_VERSION`        | 1     | Nothing here appends an event.                                                                                                                                                                                                                                                                        |
| `CONFIG_SCHEMA_VERSION`    | 1     | The presets _use_ `experimentConfigSchema` and add no field to it. A config a preset produces is identical in shape to one somebody typed.                                                                                                                                                            |

**No new preset-registry constant either, and that is the interesting one.**
`@tcg/bot-config`'s difficulty registry has its own version because a recorded
match cites a difficulty and a later reader has to know which registry produced
it — and M08.1 wrote the test a new constant must pass: _a third artifact with its
own lifetime is a reason to add a third constant; a second schema inside the same
family is not._ The preset registry does not pass it yet, because M08.3 persists
nothing: an expansion is computed, displayed and discarded, and the configuration
it becomes is versioned by `CONFIG_SCHEMA_VERSION` inside the canonical experiment
directory. The tranche that first **stores** a preset expansion beside a job —
M08.4 or M08.8 — is the one that earns the constant, and it will be a visible
widening of the expansion schema rather than a field that appeared.

**No play-contract or simulator artifact version moves.** `PROTOCOL_VERSION`,
`MATCH_SCHEMA_VERSION`, `RULES_VERSION`, `CARD_SCHEMA_VERSION`,
`MANIFEST_SCHEMA_VERSION`, `SUMMARY_SCHEMA_VERSION`, `HASH_VERSION` and
`SEED_DERIVATION_VERSION` are exactly where M08.2 left them. The simulator changes
are additive and behaviour-preserving: `ScheduleDeck` narrows a parameter type
that `SimDeck` already satisfied, `matchesBetween` is the predicate two call sites
already had, and `environmentConfigForFormat` builds a configuration the schema
already accepted. No schedule, seed, hash or artifact moved, which the simulator's
own 437 tests are the check on.

### Exclusions honoured

Adaptive Counter Search is a **reserved type only**: named in the registry,
carrying no experiment kind, absent from the choice union, and refused at the
schema. No adaptive algorithm, no deck lineage and no revision history — those are
M08.16 and later.

No UI. M08.3 adds no navigation entry, no page, no control and no chart: it makes
the answer available, and M08.7 builds the shell that shows it, M08.8 the Precon
Benchmark builder, M08.14 the Open Meta form and M08.20 the advanced templates. No
experiment is executed, no port is opened, no process is spawned and no shell is
invoked, each asserted by the boundary scan over the workspace's own sources. No
card was authored, no precon rebalanced, no deck size moved and no Unit cap added.

### Limitations recorded rather than worked around

- **A generated deck source is bounded, not counted.** The estimator does not
  build a population to find out how many decks it yields. A configuration whose
  decks are generated therefore reports its requested count as an upper bound,
  with the reason attached. A tranche that wants exactness there is buying it with
  the CPU the estimate exists to save.
- **A comparison's reference arms are an upper bound.** The shared reference
  population is the decks legal in _both_ environments, and the candidate's
  legality is not resolved here, so the baseline's count bounds the shared one
  from above. Resolving both environments would make it exact and would double the
  content work an estimate does.
- **A replacement is a floor.** Nothing counts variants, because the variant
  builder decides how many exist from the comparable cards it finds. What is
  reported is the arms against the opponent field with no variants at all, which
  is a real lower bound and labelled as one. No preset produces a `replacement`;
  M08.20 decides whether one is exposed.
- **A `files` deck source cannot be resolved from the admin surface.** ADR 0023 §5
  gives a request no path to name, so a configuration that arrived by another
  route is estimated as a bound on what its paths hold. No preset produces one.
- **The presets are `precon_wave_1` only.** Every preset builds its environment
  from the one playtest format this build ships. A second format is a knob the
  tranche that has a second format adds.

## M08.4 — Existing-experiment execution bridge — **done (2026-08-23)**

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

### What M08.4 built

`apps/admin-server/src/run/` — `ExperimentRunner`, and the two readers it is
built on. It is the first thing in this workspace that runs anything, and the
last one until M08.5 gives an operator control over it.

**A job holds what it will run, and the catalog says so before it runs.**
`catalogJobDocumentSchema` gained `spec` — the experiment's ID, kind, seed,
configuration hash and the `CONFIG_SCHEMA_VERSION` its stored configuration
declares — and the configuration itself is a fourth file under the catalog root,
`configs/job_<id>.json`, in the simulator's own schema. The contract holds the
**address**; `@tcg/simulator` holds the document, and re-validates it on the way
back out. Restating `experimentConfigSchema` in `@tcg/admin-contracts` would have
been the second copy of the experiment schema this milestone forbids, and it
would have drifted the first time the simulator added a field.

That closes the limitation M08.2 recorded against itself. A **queued** job now
has a kind, so `kinds` filters work that has not started; `fullContentHash` still
needs a result, because a content address is a reading taken from the environment
a run played in.

**One job, one directory, and the mapping is a name rather than a discipline.**
A run writes into `<result root>/<jobId>`. Two jobs cannot collide on a directory
because two jobs cannot share an ID, and one job cannot acquire a second because
the location is written to `execution` on the first start and reused by every
later attempt — a retry resumes into its own stream even if the runner has since
been pointed at a different result root, which a test drives by reconfiguring it
between attempts. M08.1 chose the ID alphabet for exactly this (`[a-z0-9]`, no
dot, no separator, no uppercase), and the location is re-resolved against its
configured root — real path and all, so a symlink is seen — before a single match
is played.

**The simulator is called, and there is no argument vector to get wrong.**
ADR 0023 §2 allows a child process with a fixed executable and a fixed argument
vector; none is required, so `runExperiment` is an ordinary function call. The one
process boundary underneath it is the simulator's own worker pool, which starts a
**fixed module** — a URL relative to its own source — with no `argv` at all and
hands it a schema-validated setup object over the worker channel. So "the admin
service cannot execute arbitrary commands" is not a property of how carefully a
string is built; it is a property of there being no string, and the boundary suite
holds both halves: this workspace still names no `child_process`, no `spawn`, no
`execFile` and no shell, and `pool.ts` is read to confirm it builds no command
line either.

`runExperiment` is reachable from **one** file. The boundary scan used to refuse
it everywhere; it now requires it in `run/job-runner.ts` and refuses it in every
other source, so the permission is as narrow as the tranche. Everything below it —
`runBatch`, `runMatch`, `runSearch`, `runOne`, `runJobsInPool`,
`TelemetryCollector` — stays refused: reaching past `runExperiment` to any of
those would be this workspace assembling a run rather than asking for one.

**Progress is read from the directory, never counted.** Nothing subscribes to
`onProgress`. A timer re-reads the canonical directory, and `progress.ts` gives
the three reasons the callback is the second counter the tranche rules out: it
counts what the process has _done_ rather than what is _committed_, it starts
from zero on a resumed run whose stream already holds hundreds of records, and it
fires every twenty-five matches, which is never for a twelve-match benchmark.
Counting newline-terminated records is the same measure resume uses — `runBatch`'s
own comment says _the file on disk is the progress_ — so the number a screen shows
and the number a restart would continue from are one number by construction, and a
half-written final line is not counted, exactly as `readJsonl` does not count it.

Two properties fell out of building it and are now asserted rather than assumed.
**A reading never moves backwards**: a poll that opened the directory before the
run settled can finish reading after it, and a stale sample is dropped rather than
written. **The directory outranks the estimate**: when a committed stream holds
more records than an _exact_ schedule says exist, the denominator is withheld —
`progressSchema`'s third honest state — rather than reported as a number the
evidence contradicts.

The stage comes from checkpoint state, and from the file names rather than their
contents: a checkpoint holds a whole population of decks, and opening one on a
timer to learn a stage name would cost megabytes per reading. `total` is `null`,
because `stageRefSchema` says why — _reporting a total it does not have would be
the second-formula mistake ADR 0023 §2 exists to prevent_ — and the directory
knows which stages have started, not how many were configured.

**A failure leaves everything it wrote.** There is no code in the runner that
removes anything: a failed job keeps its partial `matches.jsonl`, its header, its
checkpoints and its `execution` record, so `retry` resumes rather than restarts.
The diagnostics are a structured `admin/run_failed` whose message has been through
M08.3's `scrubRefusal`, because a failure that fell out of the simulator has no
idea it is about to cross an admin boundary and is quite likely to be an `ENOENT`
carrying a path; a test walks every token of every refusal and requires none of
them to look like one.

**Starting a job twice is refused by the lifecycle table, not by a flag.** The
`start` transition is taken through the store before anything else happens, and
the store serializes mutations of one job on that job's own key — so two
concurrent `run()` calls produce one `admin/illegal_transition` and exactly one
run, which is asserted by counting the calls rather than by inspecting a lock.

**A result is linked from what the run wrote.** The manifest is read _loosely_ —
unknown fields are stripped, because a manifest is the simulator's document and it
grows, and refusing to index a run for being newer than the index would be
refusing evidence — and recorded _exactly_, through `runIdentitySchema`. The
manifest version travels rather than being checked, which is M08.1's stated
policy. A run that wrote no manifest **fails** rather than completing: a catalog
entry pointing at a run that does not exist is worse than a job that says it fell
over.

### One finding, measured rather than worked around

**`parseExperimentConfig` is not idempotent, and the difference is how a pilot
flies.** `pilotSpecSchema` declares `weights: botWeightsSchema.partial()
.default({})`. An **absent** `weights` short-circuits to the literal `{}` and
`createAggressivePilot({})` merges nothing over the published
`AGGRESSIVE_WEIGHTS`. A **present** `weights: {}` — which is exactly what
serializing a parsed configuration produces — is run through `.partial()`, whose
per-field defaults all apply, and the resulting complete generic vector is merged
_over_ the published one and replaces every entry.

So a configuration written out in its parsed form and read back is a different
configuration, with a different `configHashOf` and a differently-weighted pilot.
M08.4 could not persist a job's configuration without meeting this, and it did not
fix it: the same defect means `perturbPilot` perturbs the generic vector rather
than the published one, so correcting it would move what a Pilot Robustness arm
measures — evidence somebody has already read, and not an execution bridge's to
move. [Q52](../open-questions.md) records the question, the blast radius and who
needs it answered.

What the bridge does instead is not be affected by it. `storableForm` writes the
configuration in the shape a hand-authored file states it — no property whose
value is an empty object, which in a parsed configuration is always the trace of a
default nobody supplied — and `prepareJobConfig` then **proves**, per job and
before the job is created, that reading the stored bytes back yields a
configuration with the same hash. A configuration that fails that check is refused
at creation rather than discovered an hour into a run.

### Checklist

- [x] **One job maps to one canonical experiment directory.** The directory is
      the job's own minted ID under a configured result root, so the mapping is
      bijective by naming; the location is written on the first start and reused
      by every later attempt, and is re-resolved against its root — real path, so
      a symlink escape is refused — before any match is played. Asserted by
      running two jobs, by reconfiguring the runner between two attempts of one
      job, and by refusing a root that is not configured.
- [x] **Progress derived from canonical state.** Newline-terminated records in
      `matches.jsonl` and the checkpoint files that exist, on a timer, with no
      subscription to the simulator's progress callback anywhere. A stale sample
      cannot move a reading backwards, and a stream that contradicts an exact
      schedule withholds the denominator rather than reporting a wrong one.
- [x] **Fixed argument vector; no shell, ever.** No child process is required, so
      no argument vector exists to build. The scan for `child_process`, `spawn`,
      `execFile`, `execSync` and `exec(` still finds nothing in this workspace,
      and the pool underneath `runExperiment` is read to confirm it starts a fixed
      module with no `argv` and no shell.
- [x] **Partial results and resume identity preserved on failure.** Nothing in the
      runner deletes anything; a failed job keeps its stream, its header, its
      checkpoints and its location, `resume` is always requested so a retry
      continues rather than restarts, and a stream opened by a _different_
      configuration is refused before anything is played rather than merged into.
      Driven by failing a run partway, retrying it, and asserting the second
      attempt resumes the same directory with the records the first left.
- [x] Verified: 284 focused tests in 12 files in `admin-server` (68 of them new,
      in four new files) and 343 in `@tcg/admin-contracts` (14 new); 3,613 tests
      in 168 files across the whole suite, up from 3,531 in 164;
      `npm run check:consistency`, `npm run audit:check` and `npm run verify` all
      pass on Node v24.15.0.

### Versions

Two moved, both deliberately, and no play-contract or simulator artifact version
moved with them.

| Constant                   | Was | Now | Why                                                                                                                                                                                                                                                               |
| -------------------------- | --- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_CONTRACT_VERSION`   | 1   | 2   | The closed error-code list gained `admin/run_failed`, and both job shapes gained `spec` and `execution`. M08.3 wrote the test this had to pass — _a policy refusal that is not a bad value … would move `ADMIN_CONTRACT_VERSION` deliberately_ — and this is one. |
| `CATALOG_DOCUMENT_VERSION` | 1   | 2   | A job document now records what it will run and where it ran. Both fields are required, because a job with no spec is a job nothing can start.                                                                                                                    |
| `JOB_EVENT_VERSION`        | 1   | 1   | No event kind was added and no line's shape changed. Recording where a job ran is not a decision, so it is a document field rather than a log line — the same rule that keeps progress off the log.                                                               |
| `CONFIG_SCHEMA_VERSION`    | 1   | 1   | The catalog stores an experiment configuration and adds no field to it. The number is read and recorded on the spec, which is reading a version rather than owning one.                                                                                           |

**`admin/run_failed` is a new kind of failure rather than a new spelling of an old
one.** Every other code in the list is about a request or a document being wrong;
this one is about a run that was accepted, started, and then did not finish. A
client cannot do about it what it would do about `admin/schema` — the
configuration was valid, and retrying is a lifecycle action rather than a
correction — so collapsing them would leave a queue screen unable to tell "fix
this form" from "this run fell over".

**There is no migration from `CATALOG_DOCUMENT_VERSION` 1, and that is a decision.**
A v1 job document never recorded which configuration it held, and inventing one
would be inventing the run. So a v1 document is refused with the counterpart of
the newer-build sentence — `refusePastVersion`, added here because M08.4 is the
first tranche to move the constant at all, and without it a v1 document would fail
its `z.literal` as _expected 2, received 1_, which tells a person nothing. The
blast radius is nothing: `@tcg/admin-server` has never had an entry point, a port
or a `start` script, so the only v1 documents that have ever existed were written
by these tests into temporary directories. The batch document's shape did not
change and its version moved anyway, because M08.1 chose one constant for the
family and gave the reason — _a build that can read a batch but not its jobs has
not read the batch._

**`refuseForeignVersion` is the third refusal, and it is not a fourth version.**
The stored configuration declares `CONFIG_SCHEMA_VERSION`, which is the
simulator's number; the admin surface reads it and must not adopt it. So the
treatment is shared — a newer build, an older build, or no readable version at
all, each with its own sentence — while the constant stays where it belongs.
ADR 0023 §7 asks for the treatment, not the module.

**One additive simulator export.** `configHashOf` is now on the barrel. The admin
layer needs the run's own configuration hash to record an address a resumed stream
can be checked against, and computing a second one would be exactly the drift
ADR 0023 §2 forbids. Nothing about it changed; it was already the function
`manifest.json` and `matches.header.json` are stamped from.

### Exclusions honoured

No network service: no `node:http`, no socket, no `createServer`, no `fetch`, and
still no `start` script — M08.6 owns the boundary and the loopback refusal. No UI,
no navigation entry, no chart. No shell and no child process of this workspace's
own. Nothing was deleted, moved or written inside a result root except by the
simulator writing its own run. No card was authored, no precon rebalanced, no deck
size moved and no Unit cap added. Pause, resume, cancel, retry-as-an-operator-
action, worker bounds and concurrency are **M08.5's** and are untouched: the
lifecycle table has always had the transitions, and this tranche uses exactly two
of them — `start`, and one of `complete` or `fail`.

### Limitations recorded rather than worked around

- **A single-worker sequential run gets one progress reading.** `runExperiment`
  with one worker plays matches in a loop that never yields to the event loop, so
  the poller cannot fire; the reading taken when the run settles is the only one.
  That is correct rather than merely acceptable — it is still read from the
  directory — and it is why ADR 0023 §1 puts real work in workers. A run with two
  or more workers polls normally, which is the case a person watching a queue is
  in.
- **The generation number inside a search is not carried.** `stageRefSchema`
  names stages, and reading a generation off a checkpoint's _contents_ would cost
  a population of decks per sample. M08.9 shows a generation on screen and is the
  tranche that decides how to carry one.
- **`elapsedMs` is wall-clock, summed across attempts, and includes time the job
  was not running.** An attempt that was interrupted contributes the time up to
  its last reading. Nothing here measures CPU, and M08.5 owns the resource bounds
  that would make a CPU figure meaningful.
- **Cross-process exclusion is still not claimed.** Two runners in two processes
  could both pass the `start` transition, because the refusal is a document
  mutation serialized _within_ one process. ADR 0023 §4 describes one
  administrator and one orchestration process; M08.5 owns the worker limits and
  is where a second one would have to be refused.
- **A `robustness` job's arms fly the generic weight vector.** Q52's second
  consequence, inherited rather than introduced: this tranche runs whatever
  configuration it is given, and the perturbation defect is upstream of it.

## M08.5 — Runner lifecycle, recovery and resource bounds — **done (2026-08-23)**

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

### What M08.5 built

`apps/admin-server/src/run/` gained `limits.ts`, `control.ts` and `queue.ts`, and
`@tcg/simulator` gained `stop.ts`. M08.4 used exactly two lifecycle transitions —
`start`, and one of `complete` or `fail` — and left the other eight alone. This
is the tranche that uses them.

**A stop had to be built where the matches are handed out, not around it.** The
milestone fixes the meaning of pause: _stops scheduling new match work and lets
in-flight matches reach their normal record boundary_. No admin-side mechanism
can supply that — killing a process at an arbitrary instant abandons a match
halfway and leaves a half-written final line — so `runBatch` and the worker pool
now take a `shouldStop` predicate, asked **between matches and never inside
one**. Every match already playing runs to its termination and its record is
committed; what a stop prevents is the _next_ dispatch. Nothing about a run that
is never stopped changes: with no signal supplied there is no check at all, and
the equivalence is asserted rather than assumed.

**A stopped run throws rather than returning, and that is the load-bearing
choice.** `ExperimentStopped` unwinds past `finish()`, so a partial run writes
**no manifest, no summary and no report** — ADR 0012 makes the directory the
deliverable, and a report over half a schedule is a deliverable that is wrong. It
also means every experiment kind gets the behaviour for free: a batch, a
replacement's variants, a search's generations, a comparison's two arms and a
robustness run's arms all play their matches through `runBatch`, and a returned
flag would have to be checked at each of those call sites, where the first one
that forgot would silently publish a partial run.

**One thing had to be added to the sink for the promise to be true on disk.**
`MatchSink` gained an optional `flush()`, called once when a stop unwinds. The
writer buffers sixteen records and `finish()` is what normally flushes it — so
without this, up to fifteen whole matches would have been played, counted in
memory, and then replayed on resume. They would never have been _duplicated_
(identity dedupe sees to that), but "in-flight matches reach their normal record
boundary" is a promise about the evidence on disk rather than about a process's
memory of it.

**The bound has two dimensions, because one number cannot express either.**
`maxConcurrentJobs` bounds experiments in flight — a job with one worker still
holds a document, a poller and an open stream. `maxWorkers` bounds simulator
worker threads across _every_ running job, and is the number that decides whether
the machine is oversubscribed. `maxWorkersPerJob` stops one wide experiment
taking the whole budget and stalling the queue behind it. A grant is the smallest
of what the configuration asked for, what one job may have, and what is left —
and when there is nothing left the answer is **not now** rather than zero, because
a queue that started a job with no workers would have quietly ignored its own
bound. The default is one job at a time on one thread fewer than the machine has:
concurrency is worth having when a job cannot use the whole budget, and it is not
a default.

**Every verb is the lifecycle table's, and every one leaves a line.** `pause`,
`resume`, `cancel` and `retry` go through `applyJobAction`, so each is refused by
the table a screen would grey a button from and recorded in the append-only log
with `cause: operator`. The settling action is read from the **document** rather
than from the reason the run was stopped for, which is what makes an escalation
work: a job asked to pause and then cancelled is in `cancelling`, and settling it
as `paused` would discard the second request. A cancel that arrives after the last
match still settles the job as cancelled — the document is the authority — but the
result it wrote is attached first, so the catalog does not pretend the evidence is
not there.

**Nothing retries or resumes by itself.** `retry` is a method because an operator
presses it; no code path calls it, and no failure schedules one. An interrupted
job is not re-queued either: a restart interrupts in-flight work while the store
is opened, and quietly re-queueing it would be the orchestrator deciding the crash
did not matter — the same class of claim as recovering `running` work as
`completed`. Both absences are tested rather than promised.

**`JobQueue` takes an `ExperimentRunner` rather than building one**, and that is a
boundary rather than a convenience. The runner is the only thing in the workspace
that may reach the simulator's experiment runner; a queue that restated its seams
could open a second door without ever naming the simulator, and `boundary.test.ts`
now reads `queue.ts` to keep the injection a fact.

### One defect corrected, first reachable in this tranche

**A retried job carried the previous attempt's diagnostics.** `withStatus` kept
`failure` on every transition that was not itself a `fail`, so a job that failed,
was retried and then succeeded ended up spelling `completed` beside the reason it
fell over — the one reading of that document which is certainly wrong. It had
never been reachable, because `retry` is the only route out of `failed` and
nothing before M08.5 had an operator behind it. The diagnostics are now cleared
when a job **leaves** `failed`, and nothing is lost: the `fail` line in the event
log still carries them, which is where "how did it get here" lives.

### Checklist

- [x] **Bounded concurrency and worker limits.** Two bounds and a per-job
      ceiling, validated by a strict schema that refuses zero, refuses a per-job
      ceiling above the whole budget and refuses an undeclared key. The grant is
      taken before a job starts and released only when its run settles, so the
      sum outstanding at any instant _is_ the bound; the document records the
      workers an attempt was actually granted rather than the number its
      configuration asked for. Driven by three jobs each asking for four workers
      against a budget of five.
- [x] **Pause, resume, cancel with the semantics above.** The stop reaches the
      simulator's own dispatch loop, so in-flight matches reach their record
      boundary and a stopped run writes no manifest; `resume` returns a job to
      the queue and the next attempt continues the stream on disk; `cancel` is
      the same graceful stop with a different settling state, and nothing in this
      workspace removes anything a run wrote. Proven twice — against a faithful
      stand-in that can stop at a chosen match, and once end to end with the real
      simulator across two worker threads, where the pause lands with one match
      per thread in flight and both are committed before the run unwinds.
- [x] **Restart recovery without duplicated matches or lineage.** A crash is
      driven through the real transitions: a run is started, leaves a committed
      record and is recovered as `interrupted`; the queue that comes up
      afterwards starts nothing. Resuming replays no match — the stream's own
      identities decide what is left — and the event log holds one line per move
      with no repeats.
- [x] **Retry is an explicit action with its own record.** `retry` is an
      operator's verb with `cause: operator` on its line, no code path calls it,
      and a failed job stays failed however many times the queue is pumped. The
      retried attempt resumes the stream the failed one left rather than starting
      a second.
- [x] Verified: 23 new tests in `run/queue.test.ts`, 15 in `run/limits.test.ts`,
      8 in `run/control.test.ts`, 11 in the simulator's new `stop.test.ts`, plus
      two boundary assertions and one store assertion — 333 tests in 15 files in
      `admin-server`, up from 284 in 12, and 448 in 24 files in `simulator`, up
      from 437 in 23. 3,673 tests in 172 files
      across the whole suite, up from 3,613 in 168. `npm run check:consistency`,
      `npm run audit:check` and `npm run verify` all pass on Node v24.15.0.

### Versions

**None moved, and that is the answer rather than an omission.**

| Constant                      | Was | Now | Why                                                                                                                                                                                                                           |
| ----------------------------- | --- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_CONTRACT_VERSION`      | 2   | 2   | No request or response shape changed and no error code was added: every refusal M08.5 produces is `admin/illegal_transition` from the table M08.1 wrote, or `admin/schema` on a bound. A build speaking 2 has lost nothing.   |
| `CATALOG_DOCUMENT_VERSION`    | 2   | 2   | Every field this tranche writes — `execution.workers`, `execution.attempts`, `execution.resumedMatches`, `progress`, `failure` — already existed. Clearing `failure` when a job leaves `failed` changes a value, not a shape. |
| `JOB_EVENT_VERSION`           | 1   | 1   | No event kind was added and no line's shape changed. The settling and resuming actions were already members of `jobActionSchema`, because M08.1 chose the vocabulary against this tranche.                                    |
| `CONFIG_SCHEMA_VERSION`       | 1   | 1   | `shouldStop` is a run **option**, not a configuration field. `configHashOf` cannot see it, which is exactly what lets a paused run resume as the same run.                                                                    |
| `MANIFEST_SCHEMA_VERSION`     | 8   | 8   | A stopped run writes no manifest, and nothing about the document a finished run writes changed.                                                                                                                               |
| `MATCH_STREAM_HEADER_VERSION` | 1   | 1   | `MatchSink.flush()` is an in-process interface method. No byte of the stream or its sidecar header moved, and the stream a stopped run leaves is what a crash would have left after a flush.                                  |

**No resource-limit schema went into `@tcg/admin-contracts`, deliberately.** That
package is the language the admin client and the admin server speak — identity,
lifecycle, progress, result references, pagination and errors. A resource limit is
a property of the machine the orchestrator runs on, it crosses no wire in this
tranche, and no client sends one; putting it in the shared vocabulary now would be
adding a schema before anything speaks it. **M08.6** owns the capabilities
endpoint and decides then whether a client is told these numbers, in a shape it
can also decide. It is still a strict schema rather than three loose numbers,
because an operator's configuration is input and an unvalidated `maxWorkers: 0`
would stall a queue that looked like it was working.

### Exclusions honoured

No network service: no `node:http`, no socket, no `createServer`, no `fetch`, and
still no `start` script and no entry point — M08.6 owns the boundary and the
loopback refusal. No UI, no navigation entry, no chart. No shell and no child
process of this workspace's own; the one process boundary is still the simulator's
worker pool starting a fixed module with no argument vector. Nothing was deleted,
moved or written inside a result root except by the simulator writing its own run.
No card was authored, no precon rebalanced, no deck size moved and no Unit cap
added. Batch-level ordering, duplication and reordering are **M08.9's** and are
untouched: the queue takes jobs in the `createdAt`-then-ID order `listJobs`
already returns, and nothing here sorts or prioritises.

### Limitations recorded rather than worked around

- **A single-worker sequential run cannot be paused while it is in flight.** The
  match loop never yields to the event loop between matches, so an operator's
  pause — which is a file write — cannot be recorded until the run ends. This is
  the same limitation M08.4 recorded against progress polling, with the same cause
  and the same answer: ADR 0023 §1 puts real work in workers, and a run with two
  or more workers pauses normally, which is the case an operator watching a queue
  is in.
- **Equivalence after a resume is the simulator's promise, and it is not the same
  promise for every kind.** A batch resumes to byte-identical aggregates, which is
  asserted directly. A **search** resumes its match _stream_ — no match is
  replayed and none is duplicated — but `runSearchExperiment` does not resume from
  its checkpoints, so the generation loop restarts and re-derives fitness from the
  records it plays in that attempt. Pausing a search is therefore safe and cheap,
  and is not equivalent to an uninterrupted search. Nothing here changes that;
  M08.15 is the tranche that runs a real search through the queue.
- **Cross-process exclusion is still not claimed.** Two orchestrators in two
  processes could both pass the `start` transition, and the worker budget is one
  process's own. ADR 0023 §4 describes one administrator and one orchestration
  process, and this workspace still has no entry point at all — so there is
  nothing yet for a lock to protect. **M08.6** creates the process, and is where a
  second one would have to be refused.
- **A job the queue could not start is skipped rather than reported.** Every
  refusal the runner can return leaves a job somewhere other than `queued`, so a
  job that is still queued after being refused should not exist; if one ever did,
  the fill loop would spin. The queue remembers the refusal and skips the job,
  which an operator would see as a job that never starts — but nothing surfaces
  _why_ until M08.6 has somewhere to report it.
- **Elapsed time is still wall-clock, summed across attempts.** A paused job's
  `elapsedMs` gains nothing while it is paused, because the clock is read per
  attempt, but it still measures wall-clock rather than CPU. Nothing here measures
  CPU.

## M08.6 — Admin service and access boundary — **done (2026-08-23)**

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

### What M08.6 built

`packages/admin-contracts` gained `service.ts` and `results.ts`;
`apps/admin-server` gained `src/service/` — `config.ts`, `lock.ts`,
`rate-limit.ts`, `results.ts`, `handlers.ts`, `http.ts` — and, for the first
time, an entry point: `src/main.ts`, with `start` and `dev` scripts.

**The refusal is at startup, and there is no way to spell "off".**
`parseServiceConfig` decides where the service binds and whether a token is
required, and it returns a refusal rather than a configuration when a
non-loopback bind has no token. A service that bound `0.0.0.0` and then rejected
unauthenticated requests would already be listening on every interface while
somebody read the log line. There is no `--insecure`, no
`TCG_ADMIN_ALLOW_ANONYMOUS`, and an **empty-string token is not a configured
token** — treating it as one would give a public bind a secret nobody can guess
and nobody can send. Loopback is a property of the address the operator typed
rather than of a DNS lookup, because a resolver is a moving part in a security
decision.

**A token must be long, and the reason is arithmetic rather than policy.** This
service has one administrator, no lockout, no second factor and no way to notice
a guess; a rate limit slows an attacker by a constant, and length is the only
defence whose cost to them is exponential. Thirty-two characters of URL-safe
text, refused rather than hashed into shape, and the rejected value never travels
— the refusal carries its **length** and not a prefix, because a prefix is a
fifth of a secret.

**One door, and the boundary test now says where it is.** M08.2 through M08.5
asserted _no HTTP anywhere_; that claim retired the moment a port was needed, and
what replaced it is the one that goes on mattering: `service/http.ts` is the only
source that may import `node:http`, `main.ts` is the only source that may read
`process.env`, and **no** source may open an outbound connection in any
direction. The transport imports exactly `createServer`, `IncomingMessage` and
`ServerResponse` — checked as an import list rather than a substring scan,
because `request` and `response` are the transport's central nouns and a scan for
either would have to be switched off.

**Every endpoint is a POST with a JSON envelope, and the version is in the path.**
One framing, so nothing an administrator sends can travel in a URL a proxy logs
(ADR 0023 §4) and there is no second, weaker parser for query text where
`z.strictObject` could not refuse an unknown field. Addresses are
`/admin/v{ADMIN_CONTRACT_VERSION}/{route}`, **computed from the constant** rather
than written beside it — and because the router recognises any `/admin/v{n}/`
shape, a client one version out gets the repository's readable newer-build or
older-build sentence instead of a bare 404. `admin/unknown_endpoint` is reserved
for an address that is not an endpoint under any version.

**Both boundaries are validated, and the outbound half is the one that is easy to
skip.** A request is parsed by `adminRequest(endpoint.request)`; the answer is
re-parsed by `endpoint.response` before a byte is written, and a handler that
built something its own contract does not describe is reported as a **defect in
the build** rather than sent. Nothing fails when an outbound check is missing,
which is exactly why it is a registry property rather than a habit:
`ADMIN_ENDPOINTS` gives every endpoint both schemas, and `service.test.ts` is
total over the thirteen.

**A job is created from a preset and from nothing else.** There is no endpoint
that accepts an experiment configuration — M08's exclusions forbid _unvalidated
JSON blobs_, and a request carrying `experimentConfigSchema` would also let a
client name pilots, seeds, environments and card bans no preset offers. One
choice becomes one job per stage, in the preset's own order, and the response
carries M08.3's estimate beside the jobs rather than from an endpoint of its own,
because a separate estimate call is one that can disagree with what was created.

> **Superseded in part by M08.8 (2026-08-31).** The rule that a job is created
> from a preset and from nothing else is unchanged and still enforced by a test.
> The refusal of a _read-only_ estimate endpoint was reversed: M08.8's
> requirement is the exact total shown **before** anything is enqueued, and an
> estimate that only exists after the jobs are created cannot be shown before
> them. The disagreement feared here is closed rather than accepted — `estimate`
> and `enqueue-preset` expand through one helper onto `estimatePreset`, so the
> two answers can differ only if the _content_ moved between the calls, which is
> the event the enqueue answer's own estimate reports. `estimate` is
> `mutates: false` and creates no batch, no job and no directory.

**`jobActionRequestSchema` was narrowed to the four verbs an operator has.**
`start`, `complete`, `fail`, `interrupt` and the two settling actions belong to a
runner reporting an attempt or a restart recording what it found. A request that
could spell `complete` would let a client mark a run finished without a match
having been played, and no transition check would catch it: `running → completed`
is a perfectly legal move.

**Result readings are transport, and provenance is not.** `results.ts` in the
contract package can express a column, a row and a labelled scalar; it cannot
express what a win rate _is_, and the projection from `summary.json` lives in
`apps/admin-server`, where `@tcg/simulator` is the authority. What it does name
exactly is the milestone's own result rules: `runIdentitySchema` for provenance,
`resultDenominatorsSchema` for the counts — which **refuses a summary whose
usable and abnormal records do not account for every record played** — and
`evidenceStandingSchema` for the calibration standing, which never travels
without the sentence saying what would change it. Seven tables exist because
seven are named by those rules, and `pilots` and `agent_classes` are separate
because M05.4 reports a class _beside_ a pilot and never averaged with it.

**A run with no calibration standing is refused rather than served.** The result
rules put evidence-claim and calibration standing among the things visible
_before_ a reader may treat a number as evidence; a response with the field
omitted would invite the reading that rule forbids. A run written before
`SUMMARY_SCHEMA_VERSION` 7 is therefore named as unreadable, pointing at an older
build the way M07.9 pointed at a newer one.

**Every number is read out of the run's directory at the moment it is asked
for**, and the location is re-resolved against the configured root on **every**
request. That is the case `attachJobResult`'s check cannot cover: a symlink
created after a run finished. A test creates one and requires the refusal.

### The single-orchestrator refusal M08.5 deferred

M08.5 recorded it in as many words — _M08.6 creates the process, and is where a
second one would have to be refused_ — and `service/lock.ts` is that refusal. The
damage a second process does is not two writers racing on a file, which the store
already handles: it is that **both would run the same queued job**, each taking
the `start` transition on its own read and each opening the same experiment
directory under an independent worker budget.

It is an advisory PID lock and says so. Same host with the process alive is
refused; same host with the process gone is **taken over and the takeover
reported**, because a crash is how the file is normally left behind and a lab
that needed a manual `rm` after every crash is a lab where people automate the
`rm` away; a **different host** is refused without guessing, since liveness
cannot be checked across a machine boundary; and an unreadable lock is taken over
rather than treated as authority. A process that was declared stale cannot delete
its successor's lock on the way out.

### One decision M08.5 left open, made here

**The resource bound is reported to a client, in a shape this tranche chose.**
M08.5 kept `resourceLimitsSchema` out of `@tcg/admin-contracts` deliberately and
named the tranche that would decide: _M08.6 owns the capabilities endpoint and
decides then whether a client is told these numbers, in a shape it can also
decide._ The answer is **yes**, and the shape is `capabilities.orchestrator` — a
**report** of three plain integers rather than a copy of the server's validator.
The validator refuses a per-job ceiling above the whole budget and caps the total
at the largest run the simulator accepts; both are facts about the machine and
about `@tcg/simulator`, and a second copy of them in a package that can import
neither would be a checker that goes wrong quietly. A queue screen showing three
jobs waiting behind one running job is showing a bound, and a client that had to
guess the bound would have to guess the explanation too.

### Checklist

- [x] **Loopback default; non-loopback refuses to start unauthenticated.**
      `127.0.0.1` unless told otherwise; a non-loopback bind with no token
      returns `admin/unauthorized` from `parseServiceConfig` and nothing binds.
      There is no insecure mode, no default token, no generated-and-printed
      token, and no environment variable that turns authentication off — the last
      asserted as a closed set of eight keys. Driven by starting the real process
      against `0.0.0.0`, which refused and exited non-zero.
- [x] **Versioned endpoints, both boundaries schema-validated.** Thirteen
      endpoints in one registry, each with a request schema drawn from the closed
      `ADMIN_REQUEST_PAYLOAD_SCHEMAS` set and a response schema the service
      re-parses before writing. The path's version segment is derived from
      `ADMIN_CONTRACT_VERSION`; a recognised route under another version gets the
      readable newer- or older-build refusal, checked in both directions over a
      real socket.
- [x] **Rate, body and pagination limits.** A fixed window per caller over a
      bounded map, where a refused request does not extend the window — otherwise
      a retrying client turns a limit into a lockout. A body limit checked
      against `content-length` _and_ measured as the stream arrives, because the
      header is a claim; the refusal is flushed before the socket is abandoned,
      so a caller learns why. Pagination is `pageRequestSchema`'s, refused above
      `PAGE_SIZE_MAX`, and a listing is walked cursor by cursor in a test.
- [x] **Traversal and symlink-escape tests.** No request shape has a field for a
      path — asserted over every endpoint's request schema — the router's route
      alphabet cannot spell one, a continuation token is base64url, and a run
      directory that becomes a link out of the configured root is refused at read
      time with `admin/unsafe_result_reference` and no path in the message.
- [x] Verified: 19 new tests in `service/config.test.ts`, 11 in
      `service/lock.test.ts`, 9 in `service/rate-limit.test.ts`, 20 in
      `service/results.test.ts` and 50 in `service/http.test.ts`, plus 8 new
      boundary assertions and 3 store assertions — 450 tests in 20 files in
      `admin-server`, up from 333 in 15. In `@tcg/admin-contracts`, 21 new tests
      in `service.test.ts`, 17 in `results.test.ts`, 6 in `requests.test.ts`, 5 in
      `catalog.test.ts` and 4 in `presets.test.ts` — 396 tests in 14 files, up
      from 343 in 12. 3,843 tests in 179 files across the whole suite, up from
      3,673 in 172. `npm run check:consistency`, `npm run audit:check` and
      `npm run verify` all pass on Node v24.15.0.

### Verified by running it, not only by testing it

The service was started against a temporary catalog and driven with `curl`: a
batch was created, the Precon Smoke preset was enqueued, the **real** simulator
played its twelve matches into `<result root>/<jobId>`, and the API then served
the run's summary — `summary.json` v7, twelve of twelve usable, calibration
standing, the preset's published limitation — and its `decks` and `cards` tables,
the second of which paged 2 rows of 148 with a continuation token. A `GET`
answered 405, `/admin/v2/capabilities` answered the older-build sentence, a
second process against the same catalog was refused with `admin/already_running`,
and a `0.0.0.0` bind with no token refused to start. No UI was involved and none
is claimed: M08.7 owns the shell.

### Versions

| Constant                      | Was | Now | Why                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_CONTRACT_VERSION`      | 2   | 3   | Six codes joined the closed list for failures that only exist once there is a boundary and a process to fail at; thirteen endpoints were named with a shape each way; and `jobActionRequestSchema` was **narrowed** to the operator's four verbs. A build speaking 2 would send an action this one refuses and receive codes it cannot branch on. |
| `CATALOG_DOCUMENT_VERSION`    | 2   | 3   | A job document records `origin` — the preset and stage it was expanded from, or `direct`. Required rather than optional, because the field exists to bind a preset's published limitations to the run it produced, and an optional one is a field a result view must handle missing, which is the same as not having it.                          |
| `JOB_EVENT_VERSION`           | 1   | 1   | No event kind was added and no line's shape changed. Creating a job, moving it and attaching a result all write the lines M08.2 defined.                                                                                                                                                                                                          |
| `CONFIG_SCHEMA_VERSION`       | 1   | 1   | The service assembles configurations through `expandPreset`, which produces exactly what M08.3 produced. Nothing about an experiment configuration moved.                                                                                                                                                                                         |
| `MANIFEST_SCHEMA_VERSION`     | 8   | 8   | Read, never written. The result reader parses a manifest leniently and records its declared version.                                                                                                                                                                                                                                              |
| `SUMMARY_SCHEMA_VERSION`      | 7   | 7   | Same: read leniently, reported as `source.schemaVersion`, and never written by this workspace.                                                                                                                                                                                                                                                    |
| `MATCH_STREAM_HEADER_VERSION` | 1   | 1   | Untouched. Progress is still read by counting committed newlines.                                                                                                                                                                                                                                                                                 |

**No play-contract version moved.** `PROTOCOL_VERSION`, `MATCH_SCHEMA_VERSION`,
`RULES_VERSION`, `CARD_SCHEMA_VERSION` and the `@tcg/bot-config` constants are
where M09 left them: nothing here is reachable from `@tcg/web-client` or
`@tcg/multiplayer-server`, and the boundary suite keeps it that way.

**`CATALOG_DOCUMENT_VERSION` has no migration from 2, and this is the last time
that is free.** M08.6 is the first tranche to give this workspace an entry point
and a `start` script, so at the moment the number moved no catalog had ever been
written outside a test's temporary directory — the same argument M08.4 made for
1 → 2. After this build ships, a catalog exists on somebody's disk and the next
change to that shape has to be migrated rather than refused.

**The orchestrator lock carries no version, deliberately**, by M08.1's own test
for adding one: _a third artifact with its own lifetime is a reason to add a
third constant._ The lock has no lifetime — it exists only while a process does,
and one it cannot parse it discards — so a number in it would be a number nothing
ever compares.

### Exclusions honoured

No visual UI: no `apps/admin-client`, no React, no `.tsx`, no chart, no
navigation entry, and the boundary suite still refuses a DOM member in every
source. No multiplayer telemetry: nothing here touches
`apps/multiplayer-server`, `@tcg/protocol` or a live match, and neither the
player bundle nor the match server may import either admin workspace. No shell
and no child process: `runExperiment` is still an ordinary function call from one
file, and the only process boundary is the simulator's worker pool starting a
fixed module with no `argv`. No arbitrary output root: no request payload has a
field for one, and the service resolves every directory from configuration. No
card authored, no precon rebalanced, no deck size moved, no Unit cap. Batch
ordering, duplication and reordering are still M08.9's and are untouched.

### Limitations recorded rather than worked around

- **No CORS headers are sent, and M08.7 has to decide the origin policy.** A
  browser page from another origin cannot read an answer today. M08.7 builds the
  admin client and will run a dev server on another port; choosing its origin
  policy here — before the client exists and with no way to test the choice —
  would be widening the boundary on a guess.
- **There is no unauthenticated health probe.** The live match server has one
  because a person needs to know whether matches are being served without a
  client; here the equivalent is `capabilities`, which is authenticated when a
  token is configured. An unauthenticated probe would be a second, quieter door
  reporting exactly the fact an unauthenticated caller most wants — that a lab is
  here. A tranche that needs one for a deployment can add it and say why.
- **Nothing is logged per request.** ADR 0023 §4 keeps the token out of every log
  line, and a logger added carelessly is the most likely way that stops being
  true. The entry point prints a bind, a bound and what the restart found, and
  the boundary suite reads the arguments of every `console` call to keep a token,
  a root or a resolved path off them.
- **The rate limit is keyed by remote address, which on a loopback bind is one
  bucket.** That is the intended deployment — one administrator, one process —
  and the limit's job there is to stop a looping client, not to separate callers.
  Off loopback the map is bounded and evicts the coldest window, so the key being
  caller-controlled is not a way to grow it.
- **A partly-created batch is left where it is.** If the third of four stages
  fails to be created, the first two exist, the batch is still `draft`, and an
  operator sees exactly what was made. Rolling back would mean inventing a
  removal path for the one case where it is least safe to have one — and
  `CatalogStore` deliberately has no delete (ADR 0023 §3).
- **The orchestrator lock is advisory, and a reused PID would refuse rather than
  admit.** Node has no portable advisory file locking, and a lock this layer
  could not explain would be worse than one it can. The failure mode is a
  spurious refusal, which an operator can see and act on, rather than a spurious
  start.
- **A `search` run's summary is served through the same reader as a batch's.**
  Every kind writes `summary.json` with the same `aggregate` block, so the seven
  tables are populated for all five — but nothing here surfaces a search's
  generation history or a replacement's variant impacts. M08.10 owns the generic
  run detail and M08.15 the search view.

## M08.7 — Admin client shell — **done (2026-08-24)**

A usable, protected, responsive admin surface that does not pretend unfinished
pages work: the separate client ADR 0023 chose, authenticated connection state,
top-level layout, an Overview holding only real capability and health data,
accessible navigation, and global loading, error and empty states. The project's
visual language, kept readable at analytical density.

**Acceptance:** typecheck and build, component flows, access failure, and
empty/error states; `npm run verify`.

**Exclusion:** no experiment form, no chart.

### What M08.7 built

`apps/admin-client` — the third workspace ADR 0023 §1 named and the first one
with a screen in it. Its own `index.html`, its own root element, its own Vite
application, its own `dist/`, and its own Vitest project. Nine shipped sources:
`main.tsx`, `App.tsx`, `sections.ts`, `styles.css`, `net/transport.ts`,
`net/session.ts`, `state/AdminContext.tsx`, `lib/layout.ts`,
`lib/vocabulary.ts`, and five components — `AdminShell`, `ConnectGate`,
`ConnectionBadge`, `OverviewScreen`, `FactTable` and `Feedback`.

**The origin policy M08.6 deferred is settled by making the question not
arise.** M08.6 recorded it as a limitation in as many words: _no CORS headers are
sent, and M08.7 has to decide the origin policy._ The decision is to **keep
sending none**. The client's dev and preview servers forward `/admin` to the
orchestration process, so the page and the API share an origin and there is
nothing to allow. The alternative — teaching `apps/admin-server` an allowed
origin list — was rejected because it turns a closed door into a configurable
one: a CORS allowance is a standing statement that _some_ other origin may read
a lab's answers, configured on the same machine that holds the token. A proxy
needs no such statement, and what crosses the boundary is a Node process the
operator started rather than a page somebody visited. The boundary suite reads
`apps/admin-server/src` and requires that no source writes an
`access-control-allow-*` header, and M08.6's own over-the-socket assertion that
none is sent is checked to still be there.

**The address is relative, so pointing this client at somebody else's lab is
unrepresentable.** `transport.ts` builds every address from `adminEndpointPath`,
which is derived from `ADMIN_CONTRACT_VERSION`, and holds no scheme, no host and
no port — asserted by reading the file. A browser can only send a relative
address to the origin the page came from, which is what makes the proxy decision
above a property rather than a convention.

**The token is asked for only because the service asked for it.** The first
request goes out with no token; a loopback lab with none configured answers it
and an operator never sees a form. One that requires a token refuses with
`admin/unauthorized`, and _that_ is what puts the field on the screen. The
client never predicts the access policy — `access.authenticationRequired` is a
report the service makes about itself, and asking is the only way to obtain it.

**Nothing the browser persists.** ADR 0023 §4 forbids the token from a query
string, a log line, a report and _anything the browser persists_. It is a
private field of `AdminSession`: the published snapshot has no field that could
hold one, so no screen, no error boundary and no serialized state can print it —
a test stringifies a connected snapshot and requires the token not to appear
anywhere in it. There is no "remember me", because offering one would be
offering to break the rule; the boundary suite reads every source for
`localStorage`, `sessionStorage`, `indexedDB` and `document.cookie`, and a flow
test watches the real APIs from the other side. Re-entering the token after a
reload is the cost, and it is the intended one: a lab that remembered its token
across reloads is a lab whose token outlives the person sitting at it. A token
the service **refused is dropped** rather than kept, so an operator correcting a
typo is not correcting a field that still has the old value behind it.

**A failure is classified, because an operator does something different about
each.** `refused` is the service's own answer with its own closed code;
`version` is a contract version this build cannot read, carrying the
repository's readable newer-build or older-build sentence rather than a schema
complaint; `unreadable` is something that answered and was not this contract — a
proxy error page, an empty body, a payload the endpoint's own response schema
refuses; `unreachable` is nothing answering at all. A client-side failure is
**never dressed up as an `AdminError`**: the code list is closed and it is the
service's, and inventing a member of it here would put a code into the wire's
vocabulary that no service ever sends.

**Both boundaries are still validated, from this side too.** Every answer is
re-parsed against `adminResponse(ADMIN_ENDPOINTS[name].response)` before a screen
sees it, so an unknown field in an answer is refused rather than rendered, and
the envelope's declared version is checked with `refuseFutureVersion` and
`refusePastVersion` before the schema is reached — a version mismatch is a
sentence, not "expected 3, received 4". A version failure is the one failure
where retrying cannot help, so the gate withholds the retry button and says why
instead of pretending it might.

**The Overview holds capability and health, and nothing this bundle knows on its
own.** Five panels, every value a field of the `capabilities` or `presets`
answer: how this page is talking to the lab (address, interface, authentication,
the three admin version numbers, when the process started and how long it has
been up, when this reading was taken), the orchestrator bound and what a wait
means, the request limits with the exact byte count beside the readable one, the
result roots **by identifier with the sentence saying that is what they are**,
the format, and what this build can run. The two things the screen computes are
an uptime and a KiB figure, and both are restatements of a value that is also
printed. Uptime is measured from the reading's own `checkedAt` rather than from
`Date.now()`, so it is a fact about the answer being shown.

**A restart is reported, because M08.6 put `startedAt` on the wire for exactly
that.** When the value changes between two readings the page says the process
restarted, that work which was running was recovered as interrupted, and that
nothing resumes on its own — which is M08.5's rule, printed where an operator
meets its consequence.

**The preset catalog is shown read-only, with its published limitations.**
_What this build can run_ is a capability, and the limitations `PRESET_REGISTRY`
authors are what a result may never be cited for — so they are on the row rather
than saved for a result screen that could forget them. The reserved
`adaptive_counter` entry is listed and says outright that this build cannot
schedule one, and its empty kinds and source classes print as an em dash rather
than as a blank cell a reader could mistake for "not loaded". Nothing on the
page starts anything: M08.8 owns the builder, and a test requires that no
control named Start, Run, Enqueue or New test batch exists.

**One navigation entry, because one page is finished.** `sections.ts` is a list
rather than a switch, so M08.8 adds a line and its screen appears in the
navigation — and until then the milestone's own rule holds: _a navigation entry
is added only by the tranche that makes its page honest and usable._ Before there
is a connection there is no navigation at all; the gate replaces the shell rather
than sitting inside it, because a rail beside an empty page is offering
destinations that cannot be reached.

**The two layouts change arrangement and never content.** `lib/layout.ts` reads
the same `(min-width: 60rem)` query the stylesheet uses and reports `wide` or
`narrow`, so a component test can drive both rather than assert that a class name
exists. The document order is identical in both — a layout that reorders the
document for one viewport reorders the tab order with it — and the test that
matters is the negative one: **every destination and every connection control is
present in both**, because a shell whose controls appear only when the window is
wide is a shell where an administrator's options depend on their window, and that
failure is invisible in a screenshot taken at the developer's own width.

**Keyboard order is the document's, and the first stop is the way out of it.** A
skip link is the first tabbable element and targets the `<main>`; the section
heading takes focus when a destination is chosen, at `tabIndex={-1}` so it is a
focus target without joining the tab order; `aria-current="page"` marks the
section in view. The navigation is ordinary buttons rather than a `tablist`,
because these are pages rather than panels and arrow-key navigation would be a
second, undiscoverable interaction model over the one every browser already
gives.

**Loading, empty and failed are three states, not two.** `Feedback.tsx` renders
each as a live region with a role, and the distinction it exists to keep is the
third one: an empty answer and a failed one are different facts, and a screen
that renders "none" for both quietly turns a broken connection into a
truthful-looking zero. That is the milestone's own result rule — _zero
observations are not a zero win rate_ — applied one layer up, where a table has
no rows. The two readings fail apart, too: a service that answered `capabilities`
and refused `presets` is connected with one section missing, not disconnected.

**Nothing polls.** The page says when it last asked and offers to ask again. A
poller would be choosing a cadence for state that does not change on its own yet,
and would keep a lab process answering requests all day for a tab somebody left
open. M08.9 owns the screens that watch running work, and the tranche that needs
a cadence is the tranche that can choose one.

### The dev proxy restates two constants, and a test holds them still

`apps/admin-client` must not import `apps/admin-server` — that is the boundary
this workspace exists to keep — so the service's default host and port are
written into `vite.config.ts` rather than imported. The boundary suite reads both
files, extracts `DEFAULT_HOST` and `DEFAULT_PORT` from the service's own source,
and requires the config to name the same two values; it also requires both to
read the **same** environment keys the service does, `TCG_ADMIN_HOST` and
`TCG_ADMIN_PORT`, so one setting moves both ends. A restated constant is only
honest when something fails on the day it drifts.

### One boundary test elsewhere was amended, and the claim it makes did not change

`apps/admin-server/src/boundary.test.ts` asserted that `'@tcg/admin-server'`
appears in no source outside that workspace. M08.7 created a workspace whose own
boundary suite has to **write that name down in order to forbid it**, and the
scan reads a mention rather than an import. The amendment excludes that one file
and adds a test immediately after it requiring the mention to be a refusal — the
`not.toContain` assertion — and not an import. The property is the same one
M08.2 wrote; what changed is that a file which refuses an import is no longer
counted as one.

### Verified by running it against the real process

The orchestration process was started against a temporary catalog and result
root, the client's dev server was started beside it, and the real client was
rendered against the running service through the proxy — not against a fixture.
The Overview showed this machine's own numbers: contract 3, catalog document 3,
job event 1, `startedAt` and an uptime, one experiment at a time on up to 31
simulator workers, a 128 KiB body limit, 240 requests per 60 seconds, page size
50 and 200, 16 filter values, 500 jobs per batch, the `default` result root by
identifier, `precon_wave_1`, and all nine presets with their authored summaries
and published limitations — including Adaptive Counter Search reading _Reserved —
this build cannot schedule one_ with an em dash where its kinds would be.

The process was then restarted with `TCG_ADMIN_TOKEN` set. Without the header the
service answered HTTP 401 and `admin/unauthorized`; the client showed the gate,
the token was typed into the field, and the connected banner read _Connected ·
loopback · token required_ beside _This tab is sending the token, and holds it in
memory only._ The restart also produced two of M08.6's own behaviours
incidentally: a second orchestrator against the same catalog was refused with
`admin/already_running`, and the lock a killed process left behind was **taken
over and the takeover reported**.

**No browser screenshot is claimed.** The rendering evidence is the real DOM
produced by the real components against the live service, read out in full; the
Chrome extension this environment offers was not connected, so nothing here rests
on a rendered browser window.

### Checklist

- [x] **Separate client bundle; nothing admin reachable from the player bundle.**
      `apps/admin-client` is its own Vite application with its own `index.html`,
      its own `#admin-root`, no public directory and its own output. Neither
      `@tcg/web-client` nor `@tcg/multiplayer-server` depends on any admin
      workspace, no source outside this one imports `@tcg/admin-client`, and the
      built player bundle contains **zero** occurrences of the string `admin`.
      The client imports no Node built-in, no simulator, no engine and not the
      orchestration process — checked by reading the sources and enforced by an
      ESLint `no-restricted-imports` rule while somebody is typing the import.
- [x] **Authenticated connection state and honest Overview.** The application
      asks before it prompts, shows the service's own refusal rather than a
      paraphrase, drops a refused token, holds the accepted one in memory alone,
      and offers to forget it. The Overview prints only fields of the
      `capabilities` and `presets` answers, names result roots by identifier, and
      shows no filesystem path anywhere on the page.
- [x] **Keyboard navigation and narrow/wide layouts tested at component level.**
      Skip link first, navigation before content, Enter and Space both activate a
      destination and move focus to its heading, `aria-current` marks the page,
      and the layout mode is a value both arrangements are driven through — with
      the controls and the document order required to be identical in each.
- [x] Verified: 120 new tests in 7 files in the new `admin-client` project — 15
      in `net/transport.test.ts`, 19 in `net/session.test.ts`, 15 in
      `connection-flow.test.tsx`, 19 in `overview-flow.test.tsx`, 15 in
      `shell-flow.test.tsx`, 12 in `lib/vocabulary.test.ts` and 25 in
      `boundary.test.ts` — plus 1 new assertion in `admin-server`, which is now
      451 tests in 20 files. 3,964 tests in 186 files across the whole suite, up
      from 3,843 in 179. `npm run check:consistency`, `npm run audit:check` and
      `npm run verify` all pass on Node v24.15.0.

### Versions — deliberately unchanged

| Constant                   | Was | Now | Why                                                                                                                                                                                                                                                    |
| -------------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ADMIN_CONTRACT_VERSION`   | 3   | 3   | This tranche adds no endpoint, no error code, no request field and no response field. It is the **first consumer** of the language M08.6 defined, and a consumer that moved the version would be telling every service that a client had been written. |
| `CATALOG_DOCUMENT_VERSION` | 3   | 3   | Nothing here reads or writes a catalog document. The client sees `capabilities` and `presets`, neither of which is a stored document.                                                                                                                  |
| `JOB_EVENT_VERSION`        | 1   | 1   | Same: no event line is read by this build. The screen that reads a job's history is M08.10's.                                                                                                                                                          |

**No play-contract version moved.** `PROTOCOL_VERSION`, `MATCH_SCHEMA_VERSION`,
`RULES_VERSION`, `CARD_SCHEMA_VERSION` and the `@tcg/bot-config` constants are
where M09 left them. Nothing in this workspace is reachable from
`@tcg/web-client` or `@tcg/multiplayer-server`, and three boundary suites now
keep it that way.

**No simulator artifact version moved either**, for the stronger reason that this
workspace cannot see one: it has no dependency on `@tcg/simulator`, and the only
numbers it prints are the three the service reports about itself.

### Exclusions honoured

No experiment form: no control on any screen creates, configures or enqueues
anything, and a test enumerates the button names that would mean otherwise. No
chart: no `<svg>`, no canvas, and no charting dependency — the boundary suite
reads the manifest and refuses one by name, because ADR 0023 §6 says the tranche
that adopts one records its bundle cost and accessibility behaviour at the point
of adoption. No multiplayer telemetry: nothing here touches
`apps/multiplayer-server`, `@tcg/protocol` or a live match. No shell, no child
process, no filesystem: this application is a browser bundle and imports no Node
built-in. No arbitrary output root: no request this client can send has a field
for one, because the request schemas are the service's. No card authored, no
precon rebalanced, no deck size moved, no Unit cap. No accounts, roles, sessions
or password reset — one administrator and one token, as ADR 0023 §4 says.

### Limitations recorded rather than worked around

- **The client is only reachable through its own dev or preview server.** The
  origin policy is a proxy, and nothing serves the built `dist/` in production —
  opening `index.html` from a filesystem would give a page with no lab behind it.
  That is the same shape the player client is in, and the tranche that needs a
  deployment story can add one; inventing a static host here would be inventing a
  second place the boundary has to hold.
- **The proxy target is loopback by default and is not discovered.** An operator
  who binds the service elsewhere sets `TCG_ADMIN_HOST` and `TCG_ADMIN_PORT` for
  both processes. There is no way for the page to ask where the lab is, and there
  should not be: an address a page could name is an address a page could be
  pointed at.
- **The token is entered again after every reload.** The intended cost of ADR
  0023 §4, stated on the gate so it is not a surprise.
- **Nothing on the page refreshes by itself.** The reading carries the time it
  was taken and there is a button; a queue that changes while nobody is looking
  is M08.9's problem to solve with a cadence it can justify.
- **The layout mode is read from `matchMedia`, so a browser without it gets the
  narrow arrangement.** Narrow rather than wide on purpose: it is the one that
  fits everywhere, and an unknown viewport is served the layout that cannot be
  too small for it.
- **The bundle is 314 KB (95 KB gzipped), most of it zod and React.** The
  contract package is imported whole for its schemas, and no code splitting was
  attempted: this is a local administrator surface on the same machine as the
  process it talks to, and the first tranche to have a real reason — a chart
  library, a large table view — is the one that should measure it.
- **The Overview shows no queue state.** How many jobs are waiting and what is
  running are real facts the service can answer, and they belong to the screen
  that can act on them. An Overview that counted jobs would be the first half of
  M08.9 built without the half that lets an operator do anything about it.

## M08.8 — Precon Benchmark builder — **done (2026-08-31)**

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

### What M08.8 built

**A form that is told what exists rather than holding a copy of it.** A builder
that offers precons has to get the list from somewhere, and there were exactly two
candidates: a list in the bundle — stale the day a precon is renamed and silently
wrong the day one becomes unplayable — or the process that resolves them. The
`content` endpoint is the second. `preconsForEnvironment` and `pilotCatalog` are
**`@tcg/simulator`'s**, because that is the layer `runExperiment` already asks, and
`apps/admin-server` is structurally forbidden from importing `@tcg/card-data` or
`@tcg/bot-interface` to answer it itself. `lab/content.ts` is a projection over
them and nothing more.

**Playability is asked, never asserted.** Each published precon is resolved
through `resolveDeckSource` — the _same call_ a run makes — one at a time, because
`resolvePrecons` throws on the first bad ID and a single call would report one
refusal and leave every later precon unexamined. A refused precon is **listed,
disabled and given the environment's own reason**, not filtered out: a chooser
that dropped it silently would leave an administrator unable to tell _this format
publishes three precons_ from _this format publishes four and one of them is
broken_, and only the second is a content finding. Nothing on the answer is a
card, a decklist or a pool, so it is small enough to be re-fetched every time a
form opens — which is what makes "validated against current content" mean the
content as it is now.

**Every pilot carries what a run flying it may be cited for.**
`playQualityEvidence` is `agentClassSupports(class, 'play_quality')` — the same
predicate `LEGAL_ONLY_PILOT_IDS` is a view of — so the chooser and the report
cannot disagree. A selection made only of pilots for which it is `false` puts
`NO_PLAY_QUALITY_CAVEAT` on screen at the moment the selection is made, rather
than leaving a result page to say it afterwards to somebody who has already drawn
a conclusion.

**The exact total is shown before anything is enqueued, and that is structural.**
The screen holds the **fingerprint** of the form the estimate was obtained for,
and the enqueue control exists only while that fingerprint still matches what is
on screen. Change a precon, the depth, the seat orders, the replicates or the seed
and the enqueue is withdrawn with the sentence saying the number is no longer
about this configuration. The batch label is deliberately **excluded** from the
fingerprint: it names the batch in the catalog and changes nothing about the
schedule, so renaming it should not throw away a number that is still correct.

**M08.6's objection to an estimate endpoint is closed rather than accepted.** It
declined one because _nothing would tie the two calls together_, and M08.8's
requirement — the exact total shown **before** anything is enqueued — is what
changes the balance. Both `estimate` and `enqueue-preset` go through one
`expandOrRefuse` helper onto `estimatePreset`, so the two can differ only if the
_content_ moved between the calls, which is a real event and is what the enqueue
answer's own estimate reports. The preview is a reading; the enqueue result stays
the record. `mutates: false` says on the endpoint, where a rate limiter and an
audit line can read it, that expanding a preset creates no batch, no job and no
directory.

**Five settings, and each one is a decision the expansion records.** The workload
becomes `gamesPerPairing` and is marked `chosen` rather than `preset` when it
overrode the depth, so a run cannot carry a preset's name while claiming that
preset's support. `mirrorSeats` becomes the configuration's own flag.
`retention.replaySampleRate` is the one retention dial exposed — `keepLogs` and
`keepDecisions` are _debug only_ in the simulator's own words, each holding every
action and every per-decision diagnostic of every match in memory for the length
of the run, so a form offering them would be a form offering to exhaust the lab
machine in one click; they are settled at `false` and recorded as `preset`
decisions rather than silently omitted. `workers` is a request and never a grant,
because `grantWorkers` still takes the smallest of what was asked for, what one
job may have and what is free.

**Replicates are separate runs, and the schema could not have made them anything
else.** A replicate exists to answer _how much does this move between independent
runs_, and pooling two seed families into one experiment directory would answer
the question `gamesPerPairing` already answers. So `n` replicates expand into `n`
stages, `n` jobs and `n` canonical experiment directories, each deriving its own
seed from the root one the way `commanderSearch` derives one per Commander — so
the whole set is reproducible from the single seed an administrator typed, and the
derived identity is recorded as `preset` rather than `chosen` because nobody typed
`lab-check-r2`. With one replicate the stage keeps its original identity, so an
unreplicated benchmark is exactly the run M08.6 produced.

**Four limitations are attached by the _choice_, not by the preset.** A custom
depth, a one-way seat schedule, more than one replicate and a zero replay rate
each add a sentence to the expansion's limitations — and therefore to the estimate
the screen renders and to the run's own record. `PRESET_REGISTRY.limitations` is
authored at all because _a limitation authored at the point of display is one that
can be forgotten at the point of display_, and none of these four is knowable from
the preset ID alone.

**A kept form is stored by the lab, and that is a boundary decision rather than a
convenience.** ADR 0023 §4 forbids the token from anything the browser persists,
and `apps/admin-client`'s boundary suite enforces it by refusing `localStorage`,
`sessionStorage`, `indexedDB` and `document.cookie` in any source. A saved form put
in one of those would either weaken that scan into a reviewer's judgement about
which key is allowed, or live in a second storage mechanism nobody scans. It is
also the wrong place on its own merits: a configuration kept in one browser profile
is invisible from the machine's other browser, gone when site data is cleared, and
impossible for the process that would run it to validate.

**Save always creates, and duplicating is the same call with a different label.**
There is no ID in the request and no update path: what an administrator actually
does with a kept form is open it, change two numbers and keep that too, which is a
new one. The choice is **expanded before it is written**, so a configuration that
could never be enqueued cannot be saved — the refusal arrives while the screen
still has the values that caused it rather than in a month. What is _not_ promised
is that reopening will work: a precon can be withdrawn between saving and
reopening, which is why the builder re-validates on load rather than trusting what
it stored. A saved choice is deliberately **not** called a preset:
`PRESET_REGISTRY` owns that word, its presets are the _build's_ and carry authored
limitations, and calling both "preset" would make `presetId` ambiguous in every
signature that takes one.

**Neither estimated runtime nor estimated storage is shown, and the page says
why.** The milestone asks for both _where available_. Nothing in this build has
ever measured how long a match takes or how large a run directory grows, so any
figure would be one the screen made up. Saying so where the figures would have gone
is the honest reading of "where available", and a test requires the sentence to be
there and requires no `estimated runtime of` to appear.

### One defect corrected while finishing the tranche

**Three number fields had their explanatory paragraph inside their `<label>`.** A
label wrapping both the input and the note gives the input an accessible name that
is the label's _whole_ text content — so a screen reader announced the sentence
about seed families as the field's name, and a query for the control by its name
could not find it. The note is now a sibling paragraph, which is the arrangement
the "Games per seat order" field already had. The same correction was applied to
the experiment name and seed fields, which no test queried by name.

### Verified by running it against the real process

The orchestration process was started against a temporary catalog and result root,
and the four new addresses were driven over real HTTP before any screen was
involved. `content` answered `precon_wave_1` with all four shipped precons at 40
cards each and **no refusal on any of them**, and four pilots with `random_legal`
marked as carrying no play-quality evidence. `estimate` on the default form
answered **48 matches, basis `exact`** — four precons is six pairings, both seat
orders, four games, one pilot tuple — with the real forced-inclusion floors
42/41/41/42 against a 40-card deck giving 38/39/39/38. Moving every setting at once
— two games, three replicates, no mirroring, no replays, two workers — answered
**36 matches in three stages** named `matches-r1..r3` on seeds `lab-seed|r1..r3`,
with all four choice limitations attached and the decisions reading
`gamesPerPairing 2 chosen`, `mirrorSeats false chosen`, `retention.keepLogs false
preset`, `workers 2 chosen`.

A form was saved, duplicated under a second name, and listed back newest first with
`startedAt` and `completedAt` both `null` and every setting unchanged through the
round trip. A choice naming `precon_withdrawn_yesterday` was refused with
`admin/schema` in the simulator's own words — _Precons published for
"precon_wave_1": …_ — and the listing still held two, so nothing was written. A body
carrying `outputRoot` was refused with `Unrecognized key: "outputRoot"` rather than
ignored, and `/admin/v3/content` answered HTTP 400 with the repository's readable
older-build sentence rather than a bare 404.

**A form-built configuration then became a real experiment directory.** A smoke
benchmark previewed at one match was enqueued through `create-batch` and
`enqueue-preset`, and `list-jobs` reported it `completed` with 1 of 1 matches and a
run identity carrying `manifestSchemaVersion 8` and this repository's own commit —
so the path from a form to a canonical directory is exercised end to end and not
only asserted.

Finally the **real components were rendered against the live service** through the
client's own `/admin` proxy — the same shape M08.7 used, with a real `fetch`
transport rather than a fixture. The page showed this machine's own numbers: the
four precons with their authored strategies and Commanders, the four pilots with
their agent classes, _at most 31 per job_ read from the running orchestrator's
bound, _exactly 48 matches_ with the stage row reading `48 / 4 / 4 / 1 / 0: 24, 1:
24`, the four real forced-inclusion floors, and the two configurations saved earlier
**over HTTP** — proving the saved list is the lab's and not the browser's.

**No browser screenshot is claimed.** The Chrome extension this environment offers
was not connected; the rendering evidence is the real DOM produced by the real
components against the live service, read out in full.

### Checklist

- [x] **Precon, pilot, workload, replicate, retention and worker controls.** All
      six, on one screen, every option derived from an answer the service gave: the
      precons and pilots from `content`, the depths from the preset catalog
      filtered by `testStyle`, and the worker ceiling from
      `capabilities.orchestrator.maxWorkersPerJob`. The two debug-only retention
      flags are settled at `false` rather than offered, and the reason is recorded
      as a `preset` decision on every run.
- [x] **Mirrored seat orders by default; disabling is advanced and labelled.** On
      by default because a matchup played one way round cannot separate deck
      strength from seat advantage, behind an `Advanced` disclosure, and turning it
      off puts a warning on screen _and_ attaches a limitation to the expansion, so
      the saving is visible wherever the number it produced is read.
- [x] **Exact total matches shown before enqueue.** Counted by `estimatePreset`,
      which builds the real schedule; the enqueue control exists only while the
      form's fingerprint still matches the one the total was taken for, so an
      edited form withdraws it. Estimated runtime and storage are absent and the
      page says why.
- [x] **Submission-time validation against current content.** `estimate`, `save`
      and `enqueue` all expand through one helper, so a precon this content no
      longer publishes is refused in the same words by the same layer at all three;
      a saved configuration is expanded _before_ it is written, and reopening one
      re-validates rather than trusting what was stored.
- [x] Verified: 107 new tests in 6 new files — 30 in
      `admin-client/src/builder-flow.test.tsx`, 19 in
      `admin-client/src/lib/builder-form.test.ts`, 26 in
      `admin-server/src/lab/builder.test.ts`, 16 in
      `admin-server/src/service/builder-endpoints.test.ts`, 6 in
      `admin-server/src/catalog/saved-choices.test.ts` and 9 in
      `simulator/src/content-catalog.test.ts` — plus 1 in
      `admin-contracts/src/service.test.ts`. 4,071 tests in 192 files across the
      whole suite, up from 3,964 in 186. `npm run check:consistency`,
      `npm run audit:check` and `npm run verify` all pass on Node v24.15.0.

### Versions

Two moved. No other constant in the repository did.

| Constant                   | Was | Now | Why                                                                                                                                                                                                                                                               |
| -------------------------- | --- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_CONTRACT_VERSION`   | 3   | 4   | Four endpoints — `content`, `estimate`, `save-choice`, `saved-choices` — one new code `admin/catalog_limit`, a fourth member on `capabilities.versions`, and a **widened** `presetChoiceSchema`: the three precon-benchmark presets now carry a `settings` block. |
| `SAVED_CHOICE_VERSION`     | —   | 1   | Introduced. A saved builder form is a fourth artifact with its own lifetime: written by a person filling in a form, read months later by whichever build is running then, holding a `presetChoice` and nothing about a run.                                       |
| `CATALOG_DOCUMENT_VERSION` | 3   | 3   | No batch and no job document changed shape. A saved configuration is not in that family, which is exactly why it did not borrow this number.                                                                                                                      |
| `JOB_EVENT_VERSION`        | 1   | 1   | No event line is read or written differently. The verbs that write one are M08.5's and unchanged.                                                                                                                                                                 |

**Why `SAVED_CHOICE_VERSION` is a fourth constant rather than a fourth use of an
existing one**, under the test M08.1 set and M08.2 already passed: _a third
artifact with its own lifetime is a reason to add a third constant; a second schema
inside the same family is not._ A saved form's shape moves whenever a _builder_
gains a control. Stamping it with `CATALOG_DOCUMENT_VERSION` would mean that adding
a knob to a form makes every stored batch and job unreadable — and that reading a
job document proves a saved form is readable, which it does not.

**A build speaking contract 3** would send a precon choice with no `settings` —
accepted, because the block prefaults whole — but would receive a `capabilities`
answer carrying a version field it does not know and would be unable to reach any
of the four new addresses. That is what a contract version is for saying, and the
version segment in every path is derived from the constant, so such a build gets
the repository's readable older-build sentence rather than a bare 404.

**`CATALOG_DOCUMENT_VERSION` did not move, and M08.6 said the next change to a
catalog document has to be migrated.** That obligation is intact and untouched:
M08.8 adds a _new_ document kind in its own directory with its own constant, and
`saved-choices/` has never been written by an earlier build, so there is again no
older file anywhere and no migration to write. The first change to the batch or job
document is still the one that owes a migration.

**No play-contract and no simulator artifact version moved.** `PROTOCOL_VERSION`,
`MATCH_SCHEMA_VERSION`, `RULES_VERSION`, `CARD_SCHEMA_VERSION`,
`MANIFEST_SCHEMA_VERSION`, `SUMMARY_SCHEMA_VERSION`, `DECK_GENERATOR_VERSION` and
the `@tcg/bot-config` constants are where M09 and M08.7 left them. The one change
outside the admin workspaces is `apps/simulator/src/content-catalog.ts`, which adds
two read-only projections over registries that already existed and changes no
schedule, no seed, no hash and no report.

### Exclusions honoured

**No result charts**: no `<svg>`, no canvas and no charting dependency — the
client's boundary suite still reads the manifest and refuses one by name, and the
builder's own suite asserts the rendered estimate contains neither element. The
estimate is an exact table, which is what the milestone's result rules ask for
anyway. **No other builder**: the `settings` block is on the three precon-benchmark
presets and on no other, because a knob on a preset with no screen behind it would
be a shape nothing sends and nothing validates; the screen offers no radio for Open
Meta Search, Engine Soak or Adaptive Counter Search, and a test names each of them.
**No queue**: what happens after the enqueue is M08.9's, and this screen reports
exactly the batch and jobs it created and stops. **No arbitrary output root, path
or JSON blob**: the two new request shapes are `{ choice }` and `{ label, choice }`,
a test scans both for `output`, `path`, `root`, `directory` and `file`, and an
unknown key is refused rather than ignored. **No simulator CPU work in the live
event loop**: nothing here touches `apps/multiplayer-server`, `@tcg/protocol` or a
live match. **No admin control in the player bundle**: `apps/admin-client` is still
its own application, and the built player bundle still contains zero occurrences of
the string `admin`. **No card authored, no precon rebalanced, no deck size moved,
no Unit cap, no accounts and no MMR.**

### Limitations recorded rather than worked around

- **Replicates are not pooled.** `n` replicates are `n` directories and `n`
  summaries, and nothing in this build reads them as one measurement. That is
  stated on the expansion's own limitations rather than left to a reader, and the
  tranche that aggregates them is the one that can also say what the pooled
  interval means.
- **No estimated runtime and no estimated storage.** Nothing has ever measured
  either. A first honest version needs a measured rate from real runs, which is a
  result-side fact and belongs to the tranche that reads finished directories.
- **The content answer is resolved per request and not cached.** That is deliberate
  — "current content" has to mean now — and it costs a content load every time a
  builder opens. On this machine it is unnoticeable; a lab with a far larger format
  is where it would need a cache with an invalidation story, and inventing one here
  would be inventing the story too.
- **A saved configuration cannot be renamed, edited in place or deleted.** Save
  always creates. Removing one is a filesystem action on the catalog, and
  `MAX_SAVED_CHOICES` (200) is the bound that makes an unpaginated listing an
  answer whose size is known. A delete verb is a destructive endpoint and the
  tranche that adds one should also decide what it means for a batch that names the
  same choice.
- **A saved choice for a preset this builder does not configure is listed and not
  openable.** There is one builder, so today nothing can produce such a document;
  the screen declines to open it rather than guessing, which is what makes adding a
  second builder a change to `asBenchmarkChoice` rather than a change to the
  listing.
- **The client's precon-depth labels restate three numbers the server settles.**
  `PRESET_DEPTHS` is a client-side copy of Smoke/Standard/Deep, held still by a test
  that reads each preset's own registry summary. It is a restatement and is admitted
  as one; the estimate the same form produces would contradict a stale value.
- **`apps/admin-server/src/run/queue.test.ts` has one timing-sensitive assertion
  that flakes under a loaded full-suite run.** _runs several at once when the bound
  allows_ observes a peak of concurrent jobs across real 10 ms delays, and a machine
  busy enough for one job to finish before the next starts sees a peak of 1. It
  passed three times in isolation and in the final full gate, and failed once
  mid-tranche. It is M08.5's test, untouched here, and it is recorded rather than
  repaired because making it deterministic is a change to a tranche this one did not
  open.

## M08.9 — Queue UI and batch ordering — **done (2026-08-31)**

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

### What M08.9 built

**The editing window did not exist, and opening it is the tranche.** Everything
this tranche owes happens _before start_ — add, duplicate, remove, reorder — and
until now there was no instant at which that could happen. `enqueuePreset`
created the jobs and took the batch's `enqueue` transition in the next statement,
so `draft` was a state with **zero width**: by the time an administrator could
have looked at a batch, its ordering was settled and its first job was already
being handed a worker. The two statements moved to a new `start-batch` address,
and `enqueue-preset` now fills a batch and leaves it a draft. That is a change to
what an existing address _does_ rather than to its shape, which is exactly the
kind of change a payload schema cannot express and a contract version has to —
`ADMIN_CONTRACT_VERSION` moved 4 → 5.

**The hold is the orchestrator's, not the screen's.** A job is created `queued`
— there is no job `draft` state, because a job is validated the moment it is
created — so a screen that merely declined to show a start button would be
decorating a queue that was already running. `JobQueue.#nextStartable` now reads
each candidate's batch and skips it while that batch is `draft`, memoised once
per fill pass so a draft somebody is editing does not become a directory poll. A
batch that cannot be read is treated as **not released**, which is the safe
direction: the alternative starts a run on the strength of a document this
process could not open.

**A batch now says what its members did.** Nothing had ever moved a batch after
`enqueue`, so one would have spelled `queued` while its jobs ran and after they
all finished. `JobQueue.reconcileBatch` derives the two moves from the members
rather than remembering them — `start` once any member has a start instant _or_
once every member is terminal, `complete` once every member is terminal — and
ignores the refusals, because `applyBatchAction` is the authority and an
`admin/illegal_transition` there means the batch is already past that point. The
_or_ half is not redundant: a batch whose every job was withdrawn before release
has finished without anything starting, and without it that batch could never
leave `queued`.

**Reordering sends the whole order, and that is the concurrent-update answer.** A
request that said _move this job up one_ would be a request whose meaning depends
on what the batch looked like when the button was drawn, and two screens open on
the same draft would each apply their move to an order the other had already
changed. `reorderBatchJobs` requires a **permutation** of the membership the
store currently holds: a set that has gained or lost a job is refused with a
sentence naming both directions of the disagreement and ending _the batch changed
after this order was read, so nothing was written_. There is no revision counter
and none is needed — the membership _is_ the version, because the only two things
that change it are a job being created and this method.

**Duplicating is composed out of calls that already had the authority.** There is
no `duplicateJob` in the store. The handler reads the job, reads its
configuration, derives a copy, calls `createJob` — which refuses a batch that is
not `draft`, so _duplicate before start_ needs no separate check and cannot drift
from the rule membership already obeys — and then calls `reorderBatchJobs` to
move the new member from the end of the ordering to the position after its
source. If the reorder fails the copy is still made and sits at the end: visible,
harmless, reported, and a far better outcome than a handler that deleted a job to
keep an ordering tidy.

**A copy is a replicate, because the naive reading is the dangerous one.**
Writing the same configuration twice would put two identical run directories in
the catalog — an experiment's seed is what every shuffle, mulligan and pilot
decision derives from — and a later reader would have two records that look like
independent evidence and are one measurement counted twice. So `duplicateConfig`
derives a suffixed experiment ID and a suffixed seed exactly the way M08.8
derives a replicate, spelled `-c{n}` / `|c{n}` rather than `-r{n}` / `|r{n}`
because the two are not the same claim: a replicate was _scheduled_ as one of n
and the estimate that priced the batch counted it, while a copy was added
afterwards by somebody looking at a queue. The ordinal is chosen from the
experiment IDs the batch already holds, so it is stable under withdrawal, and a
copy of a copy re-derives from the base rather than nesting.

**Removing a job before start added no address at all.** ADR 0023 §3 gives this
workspace no delete, and M08.28 is the tranche that decides whether a deletion
feature exists, with the standing preference that _omission is preferable to an
unsafe delete button_. Cancelling a job that has never started already means
exactly _remove it from this batch before start_ — it will not run, and the
lifecycle table has permitted `queued → cancelled` since M08.1 — so a withdrawal
is the existing `job-action` with `cancel`. The job stays listed in its batch
spelling `Cancelled`, dimmed, with the sentence _withdrawn before this batch was
started … it stays listed here because nothing in this lab deletes a record_. The
alternative — dropping it from `jobIds` — would have needed a removal method, a
`withdrawn` projection on the batch detail, and a careful argument about the
window in which a job could be orphaned into a state the queue would start.

**Reordering is buttons, and drag is deliberately absent.** The milestone asks
for accessible controls _where drag is an enhancement and never the only
control_. Move-up and move-down are in the tab order, are ordinary buttons so
Enter and Space both work, are announced, and need no pointer; the move that
would go off either end is **disabled rather than hidden**, so the control does
not move under a keyboard user between rows. Drag would have been the
enhancement and is not here — the acceptance asks for keyboard reordering, and an
interaction no test can prove reachable is a liability.

**Confirmations are proportional, and the proportion is one question: can the
operator undo it from this screen?** `pause`, `resume` and `retry` all can — the
lifecycle table has a route back from every state they lead to, and nothing they
do is lost — so none of them asks. `cancel` cannot: `cancelled` is terminal with
no outgoing transition at all. Starting a batch cannot either: it settles the
order for good. Those two ask, and the dialog states the consequence rather than
asking whether the operator is sure, because a dialog on the reversible verbs
would train somebody to dismiss the one that matters.

**Remaining time is shown, and the conditions for showing it are the tranche's
most load-bearing piece of arithmetic.** It appears only when the job is
`running`, its schedule is **exact** rather than a bound, at least ten matches
have been committed, and the runner has measured how long that took. Then it is
extrapolated from _this run's own pace on this machine_ — not from a table of
expected match lengths, which this build has never produced and which M08.8
declined to invent. Every other case prints a sentence naming the condition that
failed, because "no estimate" and "no estimate _because the total for this kind
of run is a bound_" are different facts and an operator can act on the second.

**Order does not imply shared state, and the page says so before anything else.**
A list of rows in a chosen order looks like a pipeline, and a reader who assumed
one would expect the second job to inherit a population, a deck or a calibration
from the first. It inherits nothing: the first paragraph on the screen says that
order decides which job a worker is offered first and nothing else, that each job
is a whole experiment with its own configuration, seed family and canonical
directory, and that running them in one batch **pools no evidence between them**.

**`operatorActionsFor` moved into the contract.** M08.6 put it in
`apps/admin-server` with a reason — _computing it on the server is what keeps a
stale bundle from showing a button the server does not have_ — and that reason
argues for one implementation rather than one location. A queue screen shows tens
of jobs at once and cannot ask `jobDetail` for each, so the choice was between
the client deriving the intersection with a **second** copy of the expression or
with **this** one. The server's refusal is still authoritative, and
`admin/illegal_transition` still names what was available instead.

### Verified by running it

`npm run verify` passes on Node v24.15.0, with `npm run check:consistency` and
`npm run audit:check` beside it. The full suite is **4,159 tests in 196 files**,
up from 4,071 in 192.

**77 new tests in 4 new files** — 29 in `admin-client/src/queue-flow.test.tsx`,
23 in `admin-client/src/lib/queue-view.test.ts`, 18 in
`admin-server/src/service/queue-endpoints.test.ts` and 7 in
`admin-server/src/lab/duplicate.test.ts` — plus 11 added to existing suites: 6 in
`file-catalog-store.test.ts` for the reorder refusals, 2 in `restart.test.ts` for
a draft that survives a restart still editable, 1 in `http.test.ts` for a second
preset into a draft, 1 in `builder-flow.test.tsx` for the report that now says
nothing has started, and 1 in `service.test.ts` for the three new endpoints all
answering with the whole batch detail.

The acceptance's five kinds are each named: **state transition** (`releases the
batch when it is started, and refuses a second start`, `moves to completed once
every member has finished`, and the client's pause/resume/interrupt/retry rows),
**keyboard reordering** (`moves a job down…` driven with Enter and `…with the
space bar` driven with Space, on focused buttons, with no pointer event),
**restart recovery** (`leaves a draft a draft, so nothing an administrator was
still ordering has started` and `keeps a reordered draft editable after the
restart`, both over a second store opened on the same directory), **concurrent
update** (`refuses the stale order a second screen would send after a job was
added`), and **action failure in the UI** (`reports a refused reorder in the
lab's own words and re-reads the batch` and `reports a refused action without
pretending it worked`).

**Verified by running it against the real process.** The orchestration process
was started against a temporary catalog and result root, and the four addresses
were driven over real HTTP before any screen was involved. `capabilities`
answered `contract 5`, `catalogDocument 3`, `jobEvent 1`, `savedChoice 1`. A
three-replicate smoke priced at **18 matches, basis `exact`** was enqueued and
the batch came back **`draft` with three `queued` jobs**; a second later, with
nothing released, it was still `draft` with **zero matches committed on every
job** — the hold, observed rather than asserted. `reorder-batch` reversed the
order to `live-check-r3, r2, r1`; the same call with a two-job order was refused
`400 admin/schema` with _A new order must name each of this batch's 3 jobs
exactly once, and it leaves out job_01m1bg1008ds8mpbzg. The batch changed after
this order was read, so nothing was written._ `duplicate-job` on `live-check-r1`
produced `live-check-r1-c2` on seed `m089|r1|c2`, and `job-action` with `cancel`
withdrew `live-check-r2`, which stayed a member of the batch spelling
`cancelled`.

`start-batch` released it; a second `start-batch` was refused `409
admin/illegal_transition` — _A batch in `queued` has no `enqueue` transition_ —
and a reorder afterwards was refused with the same code. The batch then **ran
real matches and settled `completed`**, with the three released jobs each
committing **6 of 6** matches into their own canonical directories
(`live-check-r3`, `live-check-r1`, `live-check-r1-c2`, all `manifestSchemaVersion
8`) and the **withdrawn job holding 0 matches, no elapsed time and no result** —
so the copy is a real independent run and the withdrawal really never ran.

**Rendered surface inspected through the real components.** The queue flow suite
renders the whole application against a fake lab that holds a real catalog and
moves documents through the contract's own transition table, and the assertions
read the produced DOM: the draft's three rows in order, the order after a
keyboard move, the copy's own seed family `bench-r1-c2` / `seed|r1|c2`, the
confirmation dialog's focused button and its two consequence sentences, the nine
state meanings in the legend, `20 of 60 matches committed.`, `40s of measured run
time`, `1m 20s` remaining with the basis `2s per match`, and the sentence
explaining why a remaining time is absent when only four matches have been
committed.

The real components were then rendered **against that live service** with a real
`fetch` over its socket, and the DOM read out in full. A completed batch showed
`Completed · Every member reached a terminal state. This says nothing about
whether they succeeded`, four rows in the order the operator set, `6 of 6 matches
committed.`, `1s of measured run time`, `Not available. Remaining time is only
extrapolated while a job is running.`, and the withdrawn row spelling `Cancelled`
with `0 matches committed`. Switching to a live **draft** showed `Start this
batch`, the sentence `Nothing in this batch has run`, and per row `Move up | Move
down | Duplicate | Withdraw` — with `Move up` **disabled** on the first row and
`Move down` disabled on the last, rather than missing.

**No browser screenshot is claimed.** The Chrome extension this environment
offers was not connected. The rendering evidence is the real DOM produced by the
real components against the live service, read out in full, exactly as M08.7 and
M08.8 recorded.

### Checklist

- [x] **Ordered batch editing before start, keyboard-reachable.** A batch stays a
      `draft` until `start-batch` releases it; the orchestrator's fill loop reads
      that state before starting anything, so the window is a property of the
      process. In it a job can be added (a second preset into the same batch is
      now legal), duplicated, withdrawn and reordered. Reordering is move-up and
      move-down buttons — in the tab order, Enter and Space both work, disabled
      rather than hidden at either end — and the whole order travels on every
      move, so a stale screen is refused rather than silently overwriting.
- [x] **Every lifecycle state visible and named.** All nine job states carry a
      label and a sentence in `queue-view.ts`, built from `JOB_STATUSES` itself,
      and the page renders the whole legend whether or not a job is in each
      state. `queue-view.test.ts` walks the enumeration and requires both for
      every member and that no label is the raw token, so a state added to the
      table later cannot reach a screen as an identifier. The eight batch states
      are covered the same way, including the sentence that `completed` _says
      nothing about whether they succeeded_.
- [x] **Remaining time shown only when it is honestly available.** Four
      conditions, each with its own refusal sentence, and the one case that
      passes is extrapolated from the run's own measured pace with the basis
      printed beside the figure. Exact committed and scheduled counts are shown
      in whichever of `progressSchema`'s three honest forms they are in — an
      exact fraction, a figure against a stated **bound**, or no denominator at
      all — the current stage where a job declares one, and elapsed time summed
      across attempts.
- [x] **Queue order does not imply shared state.** Said on the page, in the first
      paragraph, before any row: order decides which job a worker is offered
      first and nothing else, each job is a whole experiment with its own seed
      family and canonical directory, and one batch pools no evidence between
      them. A test asserts the sentence is rendered.

### Versions

One moved. No other constant in the repository did.

| Constant                   | Was | Now | Why                                                                                                                                                                                                                                                                                          |
| -------------------------- | --- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_CONTRACT_VERSION`   | 4   | 5   | Three endpoints — `reorder-batch`, `duplicate-job`, `start-batch` — one new request payload, and a **behavioural** change to an existing address: `enqueue-preset` no longer starts anything. A build speaking 4 would enqueue a preset and wait forever for work this build will not start. |
| `CATALOG_DOCUMENT_VERSION` | 3   | 3   | No document changed shape. `jobIds` was already an ordered array and reordering rewrites it; a withdrawal is an ordinary `cancel` on a job. M08.6's obligation — _the next change to this shape has to be migrated_ — is intact and untouched.                                               |
| `JOB_EVENT_VERSION`        | 1   | 1   | No line is read or written differently. A withdrawal writes the `transition` line `cancel` already wrote; a duplicate writes the `created` line `createJob` already wrote.                                                                                                                   |
| `SAVED_CHOICE_VERSION`     | 1   | 1   | A saved builder form holds a `presetChoice` and nothing about a queue. No builder control moved.                                                                                                                                                                                             |

**No new error code, and that is a deliberate reading of the test M08.3 set.** A
stale reorder is a **bad value for a named field** — the `jobIds` a caller sent
are not this batch's — so it is `admin/schema` with `path: 'jobIds'` and a
message that says what the disagreement was. Reordering or duplicating in a
settled batch is `admin/illegal_transition`, which is the code `createJob`
already answers a settled batch with. Adding a code for "your copy of the order
is old" would be adding a fourth spelling of _the value you sent is wrong_.

**No play-contract and no simulator artifact version moved.**
`PROTOCOL_VERSION`, `MATCH_SCHEMA_VERSION`, `RULES_VERSION`,
`CARD_SCHEMA_VERSION`, `MANIFEST_SCHEMA_VERSION`, `SUMMARY_SCHEMA_VERSION`,
`CONFIG_SCHEMA_VERSION`, `SEED_DERIVATION_VERSION`, `HASH_VERSION` and the
`@tcg/bot-config` constants are where M09 and M08.8 left them. Nothing in this
tranche is reachable from `apps/web-client` or `apps/multiplayer-server`, and
nothing here writes a manifest, a summary or a match record.

### Exclusions honoured

**No result charts and no charting dependency**: the client's boundary suite
still reads the manifest and refuses one by name, and the queue renders no `<svg>`
and no canvas — progress is a sentence and a table, which is what the milestone's
result rules ask for anyway. **No other builder**: the queue configures nothing;
every job it shows was created by M08.8's form or by a duplicate of one.
**No arbitrary output root, path or JSON blob**: the one new request shape is
`{ batchId, jobIds }` and the other two are the existing `{ jobId }` and
`{ batchId }`; the boundary suite's scan over `ADMIN_REQUEST_PAYLOAD_SCHEMAS`
covers the new member because `service.test.ts` requires every endpoint's request
schema to be one of them. **No simulator CPU work in the live event loop**:
nothing here touches `apps/multiplayer-server`, `@tcg/protocol` or a live match,
and the queue's own draft check is a document read rather than a schedule
computation. **No admin control in the player bundle**: `apps/admin-client` is
still its own application and the built player bundle still contains zero
occurrences of the string `admin`. **No deletion**: the store still offers no
`delete`, `remove`, `withdrawJob` or `removeBatchMember`, and the suite names all
four to keep it that way. **No card authored, no precon rebalanced, no deck size
moved, no Unit cap, no accounts and no MMR.**

### Corrections to what M08.8 recorded

Appended rather than rewritten, because M08.8's record is what M08.8 measured.

- **M08.8 wrote that a form-built configuration _became a real experiment
  directory_ through `create-batch` and `enqueue-preset`, and that `list-jobs`
  reported it `completed`.** That was true of the build M08.8 shipped. It is no
  longer the path: `enqueue-preset` leaves the batch a draft, and `start-batch`
  is what releases it. The end-to-end route from a form to a canonical directory
  is unchanged in every other respect and is exercised by
  `queue-endpoints.test.ts`'s `moves to completed once every member has
finished`.
- **M08.8's builder reported `Enqueued n jobs into batch … Work starts under this
lab's own bound`.** It now reports `Added n jobs to draft batch … Nothing has
started`, and names Queue as where the batch is ordered and started. The
  sentence changed because the behaviour did.
- **M08.8's recorded flake in `apps/admin-server/src/run/queue.test.ts` is still
  open.** _runs several at once when the bound allows_ observes a peak of
  concurrent jobs across real 10 ms delays. It passed in every run of this
  tranche, including the final gate; it is M08.5's test, untouched here, and
  making it deterministic remains a change to a tranche this one did not open.

### Limitations recorded rather than worked around

- **There is no batch event log, so a reorder leaves no audit line.** A
  withdrawal and a duplicate each write to a _job's_ append-only log — `cancel`
  and `created` respectively — but changing an ordering touches no job document,
  and the only trace it leaves is the batch's `updatedAt`. A batch-level log is a
  fifth artifact with its own lifetime and its own version constant, and the
  tranche that needs one — most likely M08.27, which has to say _why_ a
  comparison was set up the way it was — is the one that can decide its shape.
- **A withdrawn job keeps its slot in `MAX_JOBS_PER_BATCH`.** Nothing is deleted,
  so a batch assembled by withdrawing and re-adding repeatedly can reach the
  500-member bound with few runnable jobs in it. The refusal is
  `admin/schema` from the document's own array cap, which is truthful but says
  nothing about withdrawals; a batch that could report _how many of my members
  will actually run_ is a result-side reading and belongs with the tranche that
  lists batches by what they produced.
- **The poll is per job and unconditional within a watched batch.** Every member
  of a batch with any un-terminal job is re-read every two seconds, including the
  ones that have already finished. `jobProgress` is the cheap endpoint and a
  batch is capped at 500 members, so on this machine it is unnoticeable; a
  narrower poll would need the screen to track which rows have settled, which is
  a second copy of a fact the answer already carries.
- **A batch cannot be paused, resumed or cancelled as a whole.** The four verbs
  are per job, which is what `OPERATOR_JOB_ACTIONS` has always been, and the
  batch transitions `pause`, `pause_settled`, `resume`, `cancel` and
  `cancel_settled` in `BATCH_LIFECYCLE` are still unreached by any caller.
  Wiring them means deciding what a batch-level pause does to a member that is
  already `pausing` and to one that has already failed, and that decision is
  worth making beside a screen that can show the outcome.
- **The batch listing is one page and is not filtered.** `listBatches` is called
  with the default page size and the screen renders what comes back; a catalog
  with more than 50 batches would show the first page with no control to reach
  the rest. Filtering and pagination over the catalog is M08.10's, named there,
  and building half of it here would be the decorative scaffolding the milestone
  forbids.
- **A draft batch is never automatically discarded.** An administrator who
  configures a benchmark and changes their mind leaves a draft in the catalog
  forever. Cancelling a `draft` batch is a legal batch transition and no caller
  takes it, because `BATCH_STATUSES.cancelled` on an empty draft and on a batch
  somebody stopped mid-run read identically, and deciding what that word means is
  part of the deletion question M08.28 holds.

## M08.10 — Result catalog and generic run detail — **done (2026-08-31)**

Browse completed and partial evidence before specialized charts exist: list and
filter by date, type, status, source, content hash, Commander or precon, and
exploration versus validation. Render provenance, configuration, completion
quality, evidence standing, exclusions, limitations and exact downloadable JSON,
CSV and Markdown artifacts. Notes, tags and a deliberate **mark as baseline**
action that never mutates canonical experiment output. Partial, old or refused,
corrupt and unsupported result schemas handled honestly.

**Acceptance:** pagination and filter, partial and corrupt result, download
authorization, baseline, and schema-refusal tests.

### What M08.10 built

**A precon and a Commander became filterable, and M08.1's deferral of them was
answered rather than overruled.** M08.1 declined to add them with a reason —
_a filter for a field the contract does not model could not be honoured_ — and
the reason no longer holds: `contentCatalogSchema` models a precon's
`commanderId`, so `catalogFilterSchema` widened by `preconIds` and
`commanderIds`. Both are read off the **run's own configuration**, not off a
finished result — `apps/admin-server/src/catalog/run-content.ts` walks a
configuration's deck sources (`precon`, `inline`; `generated` and `files` name
neither, truthfully) and the store runs that pass only when one of the two
fields is actually asked for, so an ordinary listing opens no configuration at
all. A withdrawn precon resolves to no Commander rather than a guessed one.

**Every field `catalogFilterSchema` names has a control on the Results
screen** — status, purpose, source, type, baseline, precon, Commander, a
created-date range and a pasted content hash — and applying one is a
deliberate act, the same habit `BuilderScreen` already has: a person ticks
boxes, then asks, rather than the catalog being re-read on every keystroke.
The listing is `listJobs` under a cursor, walked forward with "Show more" — the
contract's own ordering is `createdAt` then ID, and this tranche did not add a
second one.

**A detail view is three independent readings, because they fail
independently.** Selecting a row opens the job itself (already in hand from the
listing), `resultSummary` (refused rather than served when a run has no
calibration standing, a corrupt summary, or nothing written yet — the
`Failure` component prints the service's own sentence for each, so "old build"
and "no result yet" read as the two different facts they are), and the new
`resultArtifacts` listing, which survives a refused summary because it never
opens one: `apps/admin-server/src/service/artifacts.ts` opens the manifest for
identity and nothing else, precisely so a run whose numbers cannot be shown
still has downloadable evidence.

**Downloads are the run's own bytes, never a rendering of them.** Two
endpoints, `result-artifacts` and `result-artifact`, answer out of thirteen
named documents — `manifest.json`, `config.json`, `summary.json`, `report.md`,
`decks.json`, the resolved environment, the reference population, both
matchup-matrix files and the three CSV exports — each mapped to the field
`experimentPaths` already fixes, with a test that is total over the join. No
document is parsed, re-serialized or generated: a Markdown report assembled
here would be a second report ADR 0023 §2 forbids, and a CSV built from
`resultTableSchema` would be a derivative a reader could quote as the run's own
output. `matches.jsonl`, replays, checkpoints and per-environment snapshots are
deliberately absent — the first is an unbounded stream no browser should be
handed through a JSON envelope, and the rest are directories a listing
endpoint would have to open, which is M08.26's Match Explorer to build. A
document larger than `MAX_ARTIFACT_BYTES` (4 MiB) is refused with its exact
size rather than truncated, because a partial CSV is an artifact somebody can
quote and nothing marks a spreadsheet as incomplete once it is saved.

**Notes, tags and baseline are the one mutation this screen makes, and the
request shape is what makes "never mutates canonical output" a fact rather
than a promise.** `setJobAnnotationsRequestSchema` — on the wire since M08.1 —
has no field that reaches an experiment directory; a saved form's baseline
checkbox can express nothing else. The whole block is replaced rather than
patched, the same rule `annotations.ts` already stated.

**Unsupported and corrupt results are reported, not hidden.** A run written
before `SUMMARY_SCHEMA_VERSION` 7 (no calibration standing), a summary that is
not valid JSON, and a directory that no longer resolves all answer through the
same `resultSummary` refusal `M08.6`'s `ResultReader` already gave, and this
tranche's contribution is putting a screen in front of it that prints the
sentence rather than a blank card.

### Checklist

- [x] **Filterable list over the catalog, bounded and paginated.** Every field
      `catalogFilterSchema` names has a control; `listJobs` pages by the
      contract's own cursor, and the screen's "Show more" walks it forward
      rather than re-fetching from the start.
- [x] **Provenance, completion quality and evidence standing on every detail
      view.** `SummaryFacts` renders `identity`, `denominators` and
      `evidence` exactly — including the calibration standing and the
      sentence saying what would promote it — whenever `resultSummary`
      answers with a value, and prints the service's own refusal, unchanged,
      whenever it does not.
- [x] **Baseline, notes and tags stored beside the run, never inside it.**
      `setJobAnnotationsRequestSchema` carries no field that can reach an
      experiment directory, so the promise is structural.
- [x] **Unsupported and corrupt results reported, not hidden.** A refused
      `resultSummary` — old build, corrupt JSON, or a directory that no
      longer resolves — is printed with the service's own sentence rather
      than an empty state, and `resultArtifacts` stays reachable regardless,
      so raw evidence survives a summary this build cannot interpret.

### Versions

| Constant                 | Was | Now | Why                                                                                                                                                                                                                                            |
| ------------------------ | --- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_CONTRACT_VERSION` | 5   | 6   | Two endpoints — `result-artifacts`, `result-artifact` — and `catalogFilterSchema` widened by `preconIds` and `commanderIds`. One new code, `admin/artifact_too_large`. A build speaking 5 could show a run's numbers but offer no file for it. |

`CATALOG_DOCUMENT_VERSION`, `JOB_EVENT_VERSION` and `SAVED_CHOICE_VERSION` are
untouched: no persisted document changed shape. The precon/Commander filter
reads a job's existing `spec`-adjacent configuration file rather than adding a
field to the catalog document, and an artifact answer is assembled from a run
directory at the moment it is asked for, exactly as `resultSummary` already
was.

### Exclusions honoured

**No result chart and no charting dependency**: every reading is a
`FactTable` or a list of exact facts, and the screen renders no `<svg>` and no
canvas. **No second scheduler and no second report**: `resultArtifact` serves
what `experimentPaths` already wrote; nothing here calls `buildSchedule`,
`runExperiment` or assembles a document the simulator did not. **No arbitrary
filesystem path, output root or JSON blob**: `resultArtifactRequestSchema` is
`{ jobId, artifact }`, where `artifact` is a closed enum: `boundary.test.ts`
scans the same closed request-schema registry M08.1 established. **No card
authored, no precon rebalanced, no deck size moved, no Unit cap, no accounts
and no MMR.** **No admin control in the player bundle**: the built player
bundle still contains zero occurrences of the string `admin`, checked against
the actual `dist/` output rather than only against source.

### Limitations recorded rather than worked around

- **The precon and Commander filters see only what a configuration's deck
  source states outright.** A `generated` or `files` deck source names
  neither, which is truthful — a searched population's Commander is a result
  of the draw, not a selection — but it means these two filters currently
  answer nothing for search and adaptive evidence. The tranche that models a
  searched deck's identity (M08.16 and the Deck Explorer) is the one that can
  extend them.
- **A content-hash filter matches only a run that has already produced a
  result.** `fullContentHash` is a reading taken from the resolved
  environment a run played in (M08.1's own limitation, restated); a queued or
  running job has none yet, which the filter already handled correctly before
  this tranche and continues to.
- **No result table (`decks`, `matchups`, `cards`, `seats`, `pilots`,
  `agent_classes`, `terminations`) is browsable from this screen.** The
  contract's `result-table` endpoint has existed since M08.6 and this tranche
  does not open a UI for it: click-through from a chart to its contributing
  rows is M08.11's _ordered heatmap plus exact table_ requirement, and
  building half of that browsing surface here — with no chart to click
  through from — would be the decorative scaffolding the milestone forbids.
- **A batch-level view of its member jobs' results does not exist.** The
  Results screen lists every job in the catalog flat; grouping by the batch
  that created them is a convenience the Queue screen already gives while a
  batch is running, and duplicating it here was not this tranche's to build.
- **The precon and Commander lists on the filter panel come from the active
  connection's content catalog, which is per-session and per-format.** A
  historical run played under a format this build no longer serves would
  still be listed by its stored spec, but could not be _filtered to_ by
  precon name, because the content catalog has nothing to offer for it. The
  run remains reachable by every other field.

## M08.11 — Precon result dashboard — **done (2026-08-31)**

Answer whether the current precons look uneven **under the selected instrument**:
overall win-rate bars with intervals and sample counts, an ordered matchup
heatmap with an exact-value table fallback, seat-order, pilot, match-length,
termination and replicate views, and click-through from a cell or bar to the
exact contributing matches, decks and replays. Calibration standing appears
before any "review" language. **No automatic balanced/unbalanced verdict.**

**Acceptance:** known fixture matrices, missing cells, ties, insufficient
samples, accessibility, filtering and drill-down tests.

### Checklist

- [x] Win-rate bars with intervals and counts.
- [x] Ordered heatmap plus exact table; no red/green-only meaning.
- [x] Seat, pilot, length, termination and replicate views.
- [x] Drill-down to exact matches, decks and replays.
- [x] Calibration standing shown before any recommendation language.

### Limitations recorded rather than worked around

- **Drill-down reaches the exact deck or matchup row a bar or cell was drawn
  from, and stops there — it does not reach an individual match or its
  replay.** `packages/admin-contracts/src/artifacts.ts` already declares
  `matches.jsonl` and `replays/` deliberately absent: the first is an
  unbounded stream and the second is a directory, and both need a listing
  endpoint this build does not have. Opening one is M08.26's Match Explorer to
  build; this screen states the limitation on every drill-down panel rather
  than pretending the link exists.
- **A dashboard table is read one page at a time, up to `PAGE_SIZE_MAX` (200)
  rows.** For a precon benchmark this is every row; for a search or soak run
  whose `decks` or `matchups` table exceeds it, the screen says so — "Showing
  the first N of M rows" — and a matchup pair sitting past that page reads
  back as _not confirmed_, never as a fabricated "no games played".

## M08.12 — Card-inclusion integrity — **done (2026-08-31)**

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

- [x] Undefined contrast returns `insufficient_data`.
- [x] Eligibility-aware denominators, global and per Commander.
- [x] Forced-inclusion floor reported wherever inclusion is shown.
- [x] Partitions preserved; contract versions moved deliberately.

### Limitations recorded rather than worked around

- **No source, construction, pilot-class, replicate or exploration/validation
  partition existed in a card aggregate before this tranche, so none had to be
  preserved beyond the one that already did: `seat.commanderId`.** Eligibility
  is computed _within_ each Commander's own legal pool
  (`apps/simulator/src/analysis/aggregate.ts`'s `summarizeCards`) rather than
  pooling every deck in the run together, which is what keeps a mixed-Commander
  population from corrupting one Commander's denominator with another's. Adding
  a source, construction or pilot-class breakdown _to_ card aggregates is a new
  reading this tranche does not add — the exclusion is no new Commander
  aggregate, and a card-level breakdown by every one of those axes would be one
  in substance.
- **Eligibility is `null` and `perCommander` is empty whenever the aggregated
  population spans more than one environment.** `compareEnvironments`'
  baseline/candidate aggregates (`apps/simulator/src/analysis/compare.ts`) have
  no single environment to hand `aggregate()`, and neither does a full
  comparison _experiment_'s top-level summary — `finish()`
  (`apps/simulator/src/experiment.ts`) aggregates records from **both** arms
  together, so it now supplies `environment` only when
  `inputs.environments.length === 1` rather than always reading eligibility
  from the baseline pool. An earlier draft of this tranche got that call wrong
  — it always passed the baseline environment, which for an added or removed
  card would have reported the wrong side's eligibility under a v8 label that
  claims correctness — caught in review before this tranche closed, and tested
  by `hardening-experiment.test.ts`'s "never reads card eligibility from one
  arm's environment for the other". Neither the zero-observation fix (an
  arithmetic correction, independent of eligibility) nor `compareCards`' own
  reading of `winRateWhenIncluded.point` (unaffected by
  `inclusionWinRateLift`'s new nullability) needed eligibility, so extending it
  into the comparison path — reading each arm against its own environment — is
  future work rather than a defect of this one.
- **The forced-inclusion floor lives in `summary.json`'s `perCommander`
  reading, not in `card-usage.csv` or the admin `cards` result table.** Both of
  those stay one row per card; a floor is a property of a Commander's pool, and
  a run with more than one Commander has more than one floor to show for a
  single card's row. `report.md` prints the caveat and points at
  `summary.json` rather than flattening a per-Commander number into a
  single-Commander-shaped column.
- **The cross-cluster inclusion view (`report.md`'s "Cross-cluster inclusion
  _(review signal)_" strategy-coverage table and `cluster-inclusion.csv`, from
  `apps/simulator/src/analysis/inclusion.ts`) is a different, pre-existing
  reading and stays eligibility-blind.** Its `deckInclusionShare` and
  `cluster_inclusion` are shares of _all_ decks in a cluster, by design (PHASE4
  HARDENING §5's cross-strategy coverage question), not the included/excluded
  win-rate contrast this tranche fixes. Making it Commander-eligibility-aware
  too is a real improvement and a real scope change to a different analysis
  module; it is not this tranche's to make, and the checklist item above
  refers to `CardSummary`'s own fields in `aggregate.ts`, not every view that
  mentions a card's deck share.
- **A card no deck in the run ever included cannot produce a `CardSummary` row
  at all**, because `everSeen`/`tallies` in `summarizeCards` are built only
  from decks that actually ran a card — there is no deck-level signal to
  attach a row to for one that was chosen nowhere. The "card present in none"
  half of the milestone's result rule is therefore asserted structurally
  (`card-inclusion.test.ts`'s "absent-card" test confirms no row, no
  fabricated 0%, for a card legal everywhere and run nowhere) rather than as a
  property of a row, which is the honest shape of that guarantee rather than a
  gap in it.

## M08.13 — Commander aggregates — **done (2026-08-31)**

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

- [x] Commander counts, win rates and opponent matrix.
- [x] Turn and end-reason distributions; deck fitness and diversity.
- [x] Partitions preserved; contract versions moved deliberately.

### Limitations recorded rather than worked around

- **`source`, `construction` and `exploration`/`validation` are not broken out in
  `CommanderSummary`, on the same terms M08.12 already recorded for card
  aggregates.** Neither is a field `MatchRecord` or `SeatTelemetry` carries:
  `SimDeck.construction.kind` and `SimDeck.origin.kind` exist only on the deck
  object a search or a deck source produces, never on the record a match leaves
  behind, and an exploration/validation split does not exist anywhere in this
  codebase to preserve. `pilot class` is preserved (`CommanderSummary.
byAgentClass`, read from `seat.pilotId` exactly as `RunSummary.
agentClassWinRates` already does) because it _is_ reachable from `MatchRecord`
  alone, and `commanderId` — the whole axis this tranche adds — was reachable
  from the start. **`replicate` is also reachable and is not an exception to
  the four above**: `MatchRecord.arm`'s `search:<label>:g<n>` and
  `experimentId`'s `:r<n>` both carry it (`experiment.ts`'s `runSearchExperiment`
  writes `armPrefix: search:${label}` with `label = r${replicate}`), and
  `MatchStore.arm()` already partitions on the same field elsewhere in this
  codebase. This tranche deliberately pools every replicate and every search
  generation into one Commander figure rather than breaking either out — a
  reader wanting one replicate's or one generation's own numbers filters
  `MatchRecord[]` by `arm` before calling `aggregate`, and the
  `commanderSummarySchema` doc comment says so.
- **`topDeckFitness`/`medianDeckFitness` read `null` from every run today,
  including a search run, and `populationSurvivalShare`/`archiveSurvivalShare`
  inherit the same caveat rather than being exempt from it.** Wiring live
  `search.fitness` data during implementation surfaced why: `runSearchExperiment`
  does not resume a search from its checkpoints — an already-recorded, accepted
  limitation of resuming a search at all (this milestone's own "Equivalence
  after a resume" note, above) — so a resumed attempt's generation loop
  restarts and calls `evaluate()` again for every generation. `runBatch` returns
  records only for matches it actually ran, so a generation whose matches are
  all already in the match store returns no records at all; `scoreOne` then has
  `total = 0` for every deck in it, collapsing `rate.low`, `opponentBreadth` and
  `seatRobustness` to `0` and leaving the score as `novelty * 0.15` — confirmed
  by hand (a fresh run and a resumed run of the same search config scored the
  same archive deck 1.0976 versus 0.0406), even though the population, the
  archive and every recorded match were byte-identical between the two. That is
  a consequence of search resume's existing, accepted non-equivalence, not a new
  defect, and closing it is M08.15's territory, not an aggregates tranche's.
  `aggregate()`'s `search` option and `CommanderSummary`'s fitness fields are
  implemented and tested against hand-supplied fitness data (see
  `commander-aggregates.test.ts`'s "population and archive" case); only the live
  wire from `experiment.ts`'s `runSearchExperiment` into
  `FinishInputs.deckFitnessByHash` is deliberately left empty, with the
  reproduction evidence recorded on that field's own comment. `updateArchive`
  and `breed` both rank on the same fitness a resumed attempt degrades, so a
  resumed search's final population/archive membership can in principle differ
  from an uninterrupted run's the same way its fitness numbers do —
  `populationSurvivalShare`/`archiveSurvivalShare` were only confirmed identical
  between a fresh and a resumed run on this tranche's own small hardening
  fixture (population 4, 2 generations), which is evidence about that fixture,
  not a structural guarantee, and they are wired live on that basis.
- **Within-Commander deck diversity is Shannon entropy over match share across
  distinct deck hashes (`analysis/stats.ts`'s existing `normalizedEntropy`), not
  the strategic clustering `analysis/clusters.ts` already performs at the run
  level.** Reusing `clusterDecks` per Commander would need the full deck list and
  card database threaded into `aggregate()`, which currently takes only
  `MatchRecord[]` plus optional confidence/environment/search evidence — a
  materially larger dependency change than a Commander-level entropy reading
  needs, and "within-Commander deck diversity **where supported**" is read as
  the hedge for exactly this lighter measure.

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

- [x] Progressive-disclosure search form over existing search config.
- [x] Commander share by generation; diversity and convergence.
- [x] Forced-inclusion warning beside every selection statistic.

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

- [x] Equal-budget independent searches; lock never changes Commander.
- [x] Finalist selection records its diversity rule and any shortfall.
- [x] Frozen finalists, fresh seeds, mirrored championship.

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

### Work slices

- [ ] **M08.16A — Adaptive configuration and compatibility.** Add the strict
      config surface, policy enums, bounds, raw/checkpoint/result envelopes and
      readable current/future-version refusal. Prove unknown-field refusal and every
      policy bound without generating candidates or running adaptation.
- [ ] **M08.16B — Immutable revision lineage.** Define revision identity,
      parents, exact swaps, generation/block/opponent references, construction and
      seed paths. Prove immutability, round trip and Commander-locked versus open
      lineage without evaluating a candidate.
- [ ] **M08.16C — Deterministic legal candidate generation.** Generate bounded
      legal swap/rebuild candidates, retain the previous successful revision and
      record every rejected candidate with its reason. Prove deterministic replay,
      legality, swap bounds and the public-observation versus analysis-only boundary.
- [ ] **M08.16D — Tranche close.** Revalidate all schema, lineage, generation,
      provenance and compatibility acceptance cases; record every moved or retained
      version and run the standard tranche-close gate. Do not start evaluation.

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

### Work slices

- [ ] **M08.17A — Mirrored block scheduler and budget.** Make the mirrored block
      the decision unit, define deterministic tie/no-decision behavior and schedule
      only whole work that fits the declared learning budget. Record an explained
      final shortfall instead of silently overspending.
- [ ] **M08.17B — Candidate and reference-field evaluation.** Evaluate exact
      active revisions against the current opponent and configured reference field;
      keep meta-aware and explicitly labelled pure-counter objectives separate and
      attribute every screening match to its revision and seed path.
- [ ] **M08.17C — Promotion, rollback and moving opponents.** Select and promote
      deterministically, retain or roll back on recorded evidence, re-evaluate after
      an opponent revision moves, and keep cumulative series wins separate from
      candidate-screening evidence.
- [ ] **M08.17D — Tranche close.** Prove block boundaries, ties, promotion,
      rollback, moving opponents, exact budget and deterministic replay through the
      standard tranche-close gate. Do not add checkpointing, final validation or UI.

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

### Work slices

- [ ] **M08.18A — Checkpoint state and persistence.** Persist active revisions,
      candidate state, spent budget, reference field, lineage and next seed path in
      the strict checkpoint contract, including a valid partial-block state.
- [ ] **M08.18B — Resume equivalence.** Resume without replaying a recorded
      match, changing lineage or spending a seed twice. Prove uninterrupted and
      resumed equivalence, including interruption inside a block.
- [ ] **M08.18C — Frozen fresh-seed validation.** Freeze final deck lists and run
      a separate mirrored validation stage on fresh seed families, with no learned
      series result leaking into the validation standing.
- [ ] **M08.18D — Canonical adaptive reports.** Produce machine-readable and
      Markdown evidence for series, screenings, revisions, final diff, reference
      field and validation. Detect repeated states and cycles descriptively and
      regenerate schemas intentionally.
- [ ] **M08.18E — Tranche close.** Revalidate checkpoint/resume, fresh seeds,
      frozen lists, report separation, cycle fixtures and compatibility through the
      standard tranche-close gate. Do not add admin UI.

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

### Work slices

- [ ] **M08.19A — Builder contracts and restoration.** Expose starting decks,
      Commander/information/adaptation policy, budget, block, candidate, swap,
      counter-focus, reference-field and final-validation controls. Restore every
      value and show workload before enqueueing.
- [ ] **M08.19B — Adaptive result read model.** Serve the bounded tables and
      provenance the dashboard needs from canonical M08.18 output, including
      incomplete-run and unsupported-version states, without recomputing simulator
      meaning in the admin layer.
- [ ] **M08.19C — Series and revision dashboard.** Render cumulative and rolling
      results, revision timeline, add/remove history, promotion evidence, start/final
      diff and reference-field performance with exact tables beside charts.
- [ ] **M08.19D — Validation, cycles and drill-down.** Present frozen validation
      separately, label public versus full information unmistakably, show recurring
      cycles descriptively and link each revision/segment to exact retained evidence.
- [ ] **M08.19E — Tranche close.** Revalidate restoration, workload, labels,
      incomplete states and drill-down through the standard tranche-close gate. Do
      not begin advanced templates.

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

### Work slices

- [ ] **M08.20A — Candidate Patch Comparison.** Map controls exactly onto the
      existing comparison contract, require the declared change, preserve identical
      reference populations and seed families, and prevent a temporary candidate
      environment from publishing live content.
- [ ] **M08.20B — Pilot Robustness.** Map controls onto the existing robustness
      contract, preserve profile partitions and denominators, and refuse any pooled
      rate whose pilot meaning is unexplained.
- [ ] **M08.20C — Engine Soak and advanced card analysis.** Map Engine Soak to a
      bounded batch/random-legal termination configuration that retains failures and
      reports engine health rather than balance. Expose replacement and insertion
      only if their current contracts still pass revalidation.
- [ ] **M08.20D — Template UI and restoration.** Integrate the three templates
      through progressive controls, exact workload, configuration restoration and
      truthful result labels without adding a new execution engine.
- [ ] **M08.20E — Tranche close.** Prove UI-to-config equivalence, shared seeds,
      profile separation, retained soak failures and candidate containment through
      the standard tranche-close gate.

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

### Work slices

- [ ] **M08.21A — Versioned live-match envelope.** Define the strict envelope,
      shared telemetry reuse, software/content/rules provenance, source, format,
      immutable deck snapshots and hashes, Commander, seat, counts and outcome.
      Prove round trip, unknown-field and future-version refusal.
- [ ] **M08.21B — Termination and interruption semantics.** Model explicit
      concede, leave concession, disconnect timeout, rules victory, server failure
      and abandoned/unrecordable outcomes as analytics provenance without changing
      the engine action meaning.
- [ ] **M08.21C — Retention and artifact contracts.** Define configurable summary,
      raw-event and replay retention plus exact compatibility behavior; do not add a
      multiplayer sink or storage implementation.
- [ ] **M08.21D — Privacy and participant identity.** Make forbidden personal and
      secret fields absent by schema, use match-local pseudonymous participant IDs
      only, and prove no cross-session identity claim or hidden-data projection.
- [ ] **M08.21E — Tranche close.** Revalidate all six origins, exact decks,
      source classification, privacy absence and version behavior through the
      standard tranche-close gate. Do not add the write path.

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

### Work slices

- [ ] **M08.22A — Injectable failure-contained sink.** Add the authoritative
      server boundary and failure policy so analytics errors cannot block, change or
      corrupt gameplay. Keep simulator-grade work out of the live event loop.
- [ ] **M08.22B — Canonical idempotent persistence.** Write one canonical record
      and configured retained artifacts per match, with stable duplicate/retry keys
      and no second source of truth.
- [ ] **M08.22C — Lifecycle integration.** Cover normal victory, reconnect,
      disconnect timeout, interruption and server restart, preserving the gameplay
      outcome even when persistence fails or completion is delivered twice.
- [ ] **M08.22D — Tranche close.** Revalidate retention, idempotence, restart and
      failure containment through the standard tranche-close gate. Do not add
      surrender snapshots or dashboard behavior.

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

### Work slices

- [ ] **M08.23A — Pre-action capture contract.** Define and capture the state
      immediately before explicit or leave concession, including pending choice,
      combat and Reaction context, without changing the engine concession.
- [ ] **M08.23B — Event and turn windows.** Retain the last meaningful event
      chain, current/previous turn windows, event distances, content identity and
      deck provenance needed by later exposure-aware analysis.
- [ ] **M08.23C — Termination integration and idempotence.** Distinguish the two
      voluntary origins in analytics, exclude timeout/disconnect from voluntary
      snapshots, and make duplicate completion/retry capture idempotent.
- [ ] **M08.23D — Hidden-artifact retention and authorization.** Store full-state
      snapshots only under configured retention as admin-only artifacts and prove
      public/client/unauthorized paths cannot obtain them.
- [ ] **M08.23E — Tranche close.** Revalidate pending contexts, windows, timeout
      exclusion, retention, idempotence and authorization through the standard
      tranche-close gate. Do not add cause labels, UI or AI continuation.

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

### Work slices

- [ ] **M08.24A — Source-separated match and deck aggregates.** Aggregate
      Commander selection, exact decks, clusters, matchups, duration and termination
      by content/version/source while keeping human, mixed and AI evidence distinct.
- [ ] **M08.24B — Eligibility-aware card evidence.** Aggregate inclusion, pairs,
      played, held and unusable cards with Commander legality and explicit support;
      never treat structural ineligibility as non-selection.
- [ ] **M08.24C — Honest weighting and denominators.** Provide match-weighted and
      unique-deck-weighted views only, with no player-weighted claim, and preserve
      sparse, missing and corrupt evidence classifications.
- [ ] **M08.24D — Surrender state and exposure windows.** Aggregate voluntary
      surrender by Commander/deck/turn/phase and state, plus exposure-adjusted action
      chain/turn/round proximity carrying exposure and event-distance counts. Exclude
      timeout and make correlation semantics structural.
- [ ] **M08.24E — Tranche close.** Revalidate source separation, eligibility,
      denominators, version filters, sparse data and surrender proximity through the
      standard tranche-close gate. Do not create the Player Meta page.

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

### Work slices

- [ ] **M08.25A — Player Meta query and filter surface.** Add bounded service and
      client contracts for content version, date, source, Commander, deck cluster,
      termination and private test label, retaining evidence class and denominator.
- [ ] **M08.25B — Choice and outcome views.** Render Commander, deck/cluster,
      eligible card, pair, matchup, duration and termination views with exact tables,
      source labels and match/unique-deck weighting controls only.
- [ ] **M08.25C — Surrender evidence views.** Render turn/phase distributions,
      state summaries and exposure-adjusted recent-card/event tables using enforced
      correlation language and visible support.
- [ ] **M08.25D — States, accessibility and drill-down.** Design empty, sparse,
      corrupt and unauthorized states; verify keyboard/screen-reader access and link
      aggregate rows to the exact bounded evidence available at this stage.
- [ ] **M08.25E — Tranche close.** Revalidate every filter, denominator, source
      label, state and correlation phrase through the standard tranche-close gate.
      Do not start the explorers.

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

### Work slices

- [ ] **M08.26A — Shared explorer boundary.** Define bounded pagination,
      authorization, stable identifiers, source/provenance fields and cross-navigation
      contracts without loading unlimited raw rows into the browser.
- [ ] **M08.26B — Deck Explorer.** Present immutable list, Commander, provenance,
      construction, known revisions, matches, matchup split, cluster and separated AI
      and human evidence with bounded navigation.
- [ ] **M08.26C — Card Explorer.** Present eligible inclusion by source and
      Commander, draw/play/dead-hand evidence, partners/replacements, contributing
      decks/matches and explicit insufficient-data states.
- [ ] **M08.26D — Match Explorer.** Add the filterable match table, termination
      context, event timeline, deck snapshots, selected diagnostics and authorized
      replay/surrender links, including unsupported-artifact states.
- [ ] **M08.26E — Representative selection and cross-navigation.** Select closest,
      upset, shortest, longest, one-sided, pre-adaptation, deterministic ordinary and
      every abnormal match reproducibly; prove all three explorers cross-navigate
      without leaking hidden information.
- [ ] **M08.26F — Tranche close.** Revalidate pagination, authorization, hidden
      data, deterministic representatives, unsupported replays and large fixtures
      through the standard tranche-close gate.

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

### Work slices

- [ ] **M08.27A — Comparison compatibility gate.** Define compatible versus
      refused result pairs and the explicit deliberately-different path carrying
      both hashes, versions and declared change before computing any delta.
- [ ] **M08.27B — Version deltas.** Compute precon/Commander matchup, inclusion,
      duration, termination, deck-family and surrender-pattern deltas with exact
      support and missing-metric behavior.
- [ ] **M08.27C — Coverage model and page.** Measure the whole card/mechanic
      vocabulary across eligibility, inclusion, draw, play, activation, trigger,
      target and observation, preserving reasons for unavailable coverage.
- [ ] **M08.27D — Data Health model and page.** Surface corrupt/skipped records,
      failures, abnormal/stalled matches, exclusions, replicate disagreement, seat
      bias, pilot sensitivity, unsupported mechanics and replay status from recorded
      evidence.
- [ ] **M08.27E — Additive annotations.** Record why a candidate change was tested
      without mutating historical raw output, and link annotations to the compatible
      or deliberately different comparison they qualify.
- [ ] **M08.27F — Tranche close.** Revalidate refusal, delta math, missing data,
      coverage, real defects and annotation immutability through the standard
      tranche-close gate.

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

### Work slices

- [ ] **M08.28A — Resource priority and process separation.** Enforce and document
      simulator priority below live multiplayer work on shared machines, without
      moving simulator CPU into the live event loop.
- [ ] **M08.28B — Retention, archive and export boundaries.** Bound every retained
      artifact and export path. Add deletion only if separately confirmed, exactly
      targeted, recoverable where practical and path-boundary tested; otherwise keep
      deletion absent.
- [ ] **M08.28C — Secret and hidden-artifact leak audit.** Prove private snapshots,
      tokens and secrets stay out of logs, player bundles, unauthenticated endpoints
      and aggregate-only exports; correct only findings inside M08 ownership.
- [ ] **M08.28D — End-to-end recovery matrix.** Exercise every primary and
      advanced test style, partial/resumed work, human ingestion, surrender capture,
      explorer drill-down and before/after comparison across real boundaries.
- [ ] **M08.28E — Visual and operator documentation pass.** Inspect representative
      wide and narrow rendered surfaces, record unavailable visual tooling honestly,
      and update user-facing run/deployment instructions without duplicating the
      canonical milestone record.
- [ ] **M08.28F — Milestone close.** Revalidate every remaining M08 checklist,
      version decision, exclusion and open decision; regenerate the final audit,
      run all close gates, obtain final Opus approval, commit the record and confirm
      a clean tree. Report the next genuine milestone without starting it.

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
