# ADR 0023 — The AI Lab admin boundary: app, service, catalog and access

**Status:** accepted · **Date:** 2026-08-14 · **Extends:**
[ADR 0001](0001-monorepo-and-tooling.md),
[ADR 0009](0009-bot-information-boundary.md),
[ADR 0011](0011-telemetry-and-provenance.md),
[ADR 0012](0012-experiment-storage-and-checkpointing.md),
[ADR 0022](0022-evidence-claims.md)

Recorded in M08.0, before any of the code it governs exists. Every other ADR in
this directory was written after the fact; this one is written first on purpose,
because M08 is the first milestone that adds new **processes** rather than new
behaviour inside existing ones, and the boundaries between those processes are
the part that cannot be repaired cheaply afterwards.

## Context

M08 builds an administrator-only **AI Lab and Player Meta** surface: a way to
configure, queue, run and read balance experiments without hand-authoring JSON,
and a durable place for evidence from real human matches to live beside the
evidence the simulator already produces.

What exists today, re-read from the code at `6727841` rather than from the brief
that proposed the work:

- **`@tcg/simulator` is already a library**, not only a CLI. Its `package.json`
  points `main` and `exports` at `src/index.ts`, and that barrel exports
  `runExperiment`, `buildSchedule`, `runJobsInPool`, the configuration schemas,
  every analysis function and every artifact version constant. A caller inside
  the repository can drive an experiment without going near `src/cli.ts`.
- **An experiment is a directory.** `experimentPaths` fixes every file and
  directory name under a run's root — `manifest.json`, `config.json`,
  `matches.jsonl`,
  `matches.header.json`, `decks.json`, `resolved-environment.json`,
  `summary.json`, `report.md`, `replays/`, `checkpoints/` and the CSV exports.
  `results/` is git-ignored: a run belongs to whoever ran it. Resume is defined
  by what is on disk, and `readJsonl` already tolerates a truncated final line by
  dropping and reporting it.
- **Every experiment configuration is already strict and versioned.**
  `experimentConfigSchema` is a discriminated union over five kinds — `batch`,
  `search`, `comparison`, `replacement`, `robustness` — built from
  `z.strictObject` throughout, so an unknown field is already a parse error.
- **The multiplayer server is in memory and has no analytics.** `main.ts` says
  so, and neither `apps/multiplayer-server/src` nor `@tcg/protocol` mentions
  analytics at all. Restarting the process ends every live match.
- **The web client is one Vite app with three screens** — deck builder, match,
  spectator — plus help. It has no admin surface and no second entry point.
- **Concession and timeout are already distinct engine actions.** `concede` and
  `server_timeout` are separate members of the action union, and the engine
  routes them to `handleTermination` with different reasons. What is _not_
  distinct is **why** a concession happened: `match-server.ts` turns a player
  leaving a live match into the same `concede` action an explicit button would
  produce, so the origin is lost at the engine boundary and has to be preserved
  above it.

The risk this ADR exists to bound is straightforward. An admin panel wants to
run CPU-saturating work, read and write files, and expose a network endpoint.
Each of those is safe here only because of where it sits, and "where it sits" is
exactly the kind of decision that gets made implicitly by the first commit that
needs it.

## Decision

### 1. Two new applications and one shared package, never a route

The admin surface is **`apps/admin-client`**: its own Vite application with its
own `index.html` and its own bundle. It is never a screen inside
`@tcg/web-client`, and no admin code is reachable from the player bundle. A
player build that has never heard of the admin client cannot ship an unprotected
admin control by accident, and bundle inspection is a sufficient test.

The orchestration process is **`apps/admin-server`**: a separate Node process
from `@tcg/multiplayer-server`. The two never share an event loop. Simulator
work runs in child workers owned by the admin server, using the existing
`runJobsInPool` discipline, and never inside a request handler.

The language they speak is **`packages/admin-contracts`**: strict, versioned zod
schemas for job and batch identity, lifecycle state, progress, result references,
pagination and structured errors. Both applications import it, so a contract
change is a compile error on both sides rather than a runtime surprise on one.

Three workspaces rather than one is the same shape ADR 0001 already chose for the
rest of the repository, and it is what makes the first two guarantees checkable
instead of merely intended.

### 2. The simulator is imported, never re-implemented and never shelled out to

`apps/admin-server` depends on `@tcg/simulator` and calls its exported functions.
Scheduling semantics, deck legality, aggregation and report meaning have exactly
one implementation, and the admin server is a caller of it.

Where a child process is genuinely required, it is spawned with a **fixed
executable and a fixed argument vector**. No admin input is ever concatenated
into a command string, and no shell is invoked. This is not a preference about
style: it is the property that makes "the admin service cannot execute arbitrary
commands" a structural fact rather than a review checklist item.

The match-count estimator M08.3 needs is derived from `buildSchedule` — the
function that produces the real schedule — rather than from a formula written a
second time next to it. A second formula is a thing that can be right today.

### 3. The catalog is files under a configured root, and it is an index

Batches and jobs persist as **JSON documents plus an append-only JSONL event log
per job**, under a configured catalog root, written by temporary file and
`rename`. Every document is validated by its schema on read as well as on write.

Chosen over an embedded database because it adds no dependency, because it is
inspectable with the same tools the rest of `results/` already needs, because
`JsonlWriter` and `readJsonl` already define this repository's append-and-recover
discipline including the damaged-tail case, and because the volume is bounded by
how many experiments a person starts, not by how many matches they play.

The escape hatch is deliberate and is why M08.2 requires the store to sit behind
an interface: if list-and-filter at real sizes ever stops being answerable this
way, the implementation changes behind that interface and nothing above it moves.

**Experiment directories remain canonical.** A catalog entry records the resolved
experiment directory and the manifest, config and content hashes that identify
the run; every number a result view shows is read back out of those files. The
catalog carries lifecycle — queued, running, interrupted, cancelled — and
administrator annotations such as tags and a baseline mark. It never becomes a
second copy of a run's evidence, because a second copy is a thing that can
disagree with the first, and ADR 0012 already made the directory the deliverable.

A consequence worth stating plainly: deleting a catalog entry must not delete an
experiment directory, and an experiment directory that exists without a catalog
entry is still valid evidence.

### 4. Loopback by default; a non-loopback bind refuses to start unauthenticated

`apps/admin-server` binds `127.0.0.1` unless told otherwise. A non-loopback bind
**refuses to start** unless an administrator token is configured out of band, in
the environment. There is no default token, no generated-and-printed token, and
no "insecure mode" flag.

The token travels in a request header. Never a query string, never a log line,
never a generated report, never anything the browser persists. One administrator,
one token: no accounts, no roles, no sessions, no password reset. Anything more
is the "generic operations console" M08 explicitly excludes.

### 5. Every path is resolved against a configured root before it is used

Result roots and the catalog root are configuration. A request never names a
filesystem path; it names an identifier that the server resolves. The resolved
real path is checked to be inside its configured root, and symlink escape is
rejected rather than followed.

Hidden information is treated as hidden. Replays and the surrender-state
snapshots M08.23 introduces contain information no player may see; they are
admin-only artifacts served through the authenticated boundary, and ADR 0009's
observation boundary is unaffected by any of this — analysis-mode information
still never reaches a bot in a normal match.

### 6. No charting dependency is adopted here

The default is hand-authored SVG plus the exact table every chart must be
accompanied by anyway. If M08.11 or a later tranche finds a genuine reason to
add a charting library, that tranche records the choice, its bundle cost and its
accessibility behaviour at the point of adoption. Adopting one now, before a
single chart exists, would be choosing without the information that decides it.

### 7. Versioning follows the existing policy, and refuses rather than guesses

`packages/admin-contracts` carries its own version constant, introduced in M08.1
and independent of the play-contract versions, because an admin client and an
admin server can disagree without any card, match or protocol meaning having
changed. Catalog documents carry a document version of their own, for the same
reason.

A future version is **refused with a readable message**, not migrated
speculatively — the treatment M07.9 applied to `CARD_SCHEMA_VERSION`. Where a
migration is genuinely available it is implemented deliberately and tested in
both directions. Any tranche that changes a summary, report or API contract
states why the adjacent versions did or did not move.

## Consequences

- Three new workspaces to build, typecheck, lint and test, and a new Vitest
  project for each of the two that hold tests. This is real cost, paid to keep a
  player bundle that cannot contain admin controls.
- The admin server can saturate a machine. Where it shares one with the live
  match server, M08.28 has to make simulator work yield: process separation is
  what makes that possible, but it is not by itself the same thing.
- A file-backed catalog will not answer arbitrary analytical queries across every
  run ever recorded. That is accepted; the run directories answer those, and the
  catalog's job is to say which runs exist and what happened to them.
- Nothing here decides what the panel measures. Aggregate definitions, the
  eligibility-aware card denominator, Commander aggregates, the adaptive-search
  schema and the live-match analytics envelope are all decided in their own
  tranches, and several of them will need their own ADR.

## Alternatives considered

**An admin route inside `@tcg/web-client`, guarded at runtime.** Cheaper by a
whole workspace, and rejected: the guard is code, code can be wrong, and a wrong
guard ships admin controls to every player. A separate bundle makes the failure
impossible rather than unlikely.

**Running experiments inside `@tcg/multiplayer-server`.** One process to deploy,
and rejected outright — a search generation would stall live matches, and the
brief's own exclusion says so. Nothing about the admin panel is worth a stutter
in a real game.

**SQLite for the catalog.** Genuinely attractive for the list-and-filter screens
in M08.10 and M08.26, and rejected for now on dependency cost and on the fact
that the interface in M08.2 keeps the option open at the moment there is
evidence for it, rather than closing it now on a guess about volume.

**Copying run results into the catalog for fast reads.** Rejected: it creates a
second copy of evidence that can disagree with the canonical one, which is the
exact failure mode ADR 0012 and ADR 0011 were written to prevent.
