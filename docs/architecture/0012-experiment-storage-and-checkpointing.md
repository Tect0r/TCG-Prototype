# ADR 0012 — Experiment storage, streaming and checkpointing (Phase 4)

**Status:** accepted · **Date:** 2026-08-08 · **Amended by:**
[ADR 0014](0014-unified-match-stream-and-reference-populations.md) — every
experiment kind now streams to one `matches.jsonl` rather than only batches, and
a record's resume identity is `arm + matchId` rather than the match ID alone.
The directory layout and the reasoning below stand; read 0014 for the corrected
storage contract.

**Amended 2026-08-13 (M07.3).** The layout and every decision below stand. Four
things a reader should know about what those files now contain, none of which
changes the contract:

- `manifest.json` is schema **8** and `summary.json` schema **7**. Both stamp an
  exported constant now (`MANIFEST_SCHEMA_VERSION`, `SUMMARY_SCHEMA_VERSION`)
  rather than an integer literal at the write site, so `docs/status-audit.md`
  can read the version instead of transcribing it.
- A manifest also carries what a run may be **cited** for: the mechanic-support
  floor its decks reach, the agent classes that flew it, and how its decks were
  constructed ([ADR 0022](0022-evidence-claims.md)). It was already meant to be
  sufficient on its own to say whether two result sets are comparable; these are
  the fields that make it sufficient to say whether one is worth reading.
- An experiment may name a precon as a deck source, and the manifest records
  each precon ID with its format, Commander and resolved deck hash
  ([ADR 0019](0019-precon-identity.md)).
- `SEARCH_CHECKPOINT_VERSION` moved 1 → **2** as a refusal: a v1 checkpoint
  never recorded where its decks came from, and a resumed search that could not
  tell a plan-generated population from an unconstrained one would report the
  wrong provenance for every deck it bred afterwards.

## Context

A Phase 4 experiment can be a twelve-match smoke run or a multi-generation deck
search playing tens of thousands of matches. It has to survive being interrupted,
must not need to fit in memory, and must produce something a human can read and
a machine can re-check (CLAUDE.md §13.7, §13.13).

## Decision

### One directory per experiment, with a fixed layout

```text
manifest.json     what was run: seeds, hashes, versions, deck hashes, pilots
config.json       the validated configuration, written back verbatim
matches.jsonl     one MatchRecord per line — the primary, lossless output
decks.json        every deck that played, with lineage
summary.json      aggregate, clusters, pairs, replacements, comparison, flags
card-usage.csv    per-card table, for eyeballing
card-pairs.csv    per-pair table
errors.csv        diagnostics and pilot failures, with replay paths
report.md         the written interpretation
replays/          abnormal matches, plus a sampled share of normal ones
checkpoints/      per-generation search state
```

`manifest.json` carries the seed, the seed-derivation version, the hash version,
the telemetry schema version, the rules version, the software commit and every
environment hash. It is meant to be sufficient on its own to say whether two
result sets are comparable.

### JSONL is the canonical format; CSV is an export

Records are appended one per line as matches finish. Each line is independently
parseable, so a run killed mid-write loses at most one record — and the reader
tolerates a damaged tail explicitly, dropping the broken line and _reporting_ it
rather than either failing outright or silently accepting a corrupt record.

CSV exists to be opened in a spreadsheet. It is lossy by construction and nothing
reads it back.

### The file on disk is the progress

Resume regenerates the schedule — which is a pure function of the configuration —
and skips the match IDs already present in `matches.jsonl`. Nothing is re-run,
nothing is duplicated, and an interrupted-then-resumed run produces byte-identical
output to an uninterrupted one, which is tested.

A run that is _not_ resuming truncates `matches.jsonl` first, so a fresh run can
never silently append to an old one.

### Workers exchange validated plain data

Worker threads receive a schema-validated setup message and a plain job
description, and return a plain record. No closures, no shared mutable state.
There is exactly one code path from "a scheduled match" to "a record" —
`runOne` — used verbatim by the sequential path and by every worker, so
worker-count equivalence is structural rather than something two implementations
have to agree on.

Workers load TypeScript through a small ESM resolve hook rather than a build
step, because Node's native type stripping does not rewrite `./x.js` to `./x.ts`.
The consequence is that any module reachable from a worker must use
erasable-only TypeScript syntax — no parameter properties, no enums. This is
noted at the one place it bit us (`SeatAccumulator`).

### Search checkpoints carry the _next_ population

A search checkpoint stores the generation that was just evaluated, its fitness,
the archive, the history, the population that was evaluated — and separately the
population the next generation will evaluate, already bred.

Resuming has to continue from the bred population rather than re-breeding, because
breeding consumes the generation's seed path; re-running it would produce a
different lineage than the uninterrupted run would have. Storing only the
evaluated population made a resumed search silently diverge, which is what
motivated splitting the two.

## Consequences

- A large experiment's peak memory is dominated by the records held for final
  sorting, not by logs. The default retention keeps no logs for normal matches.
- Deleting `summary.json` and `report.md` and re-deriving them from
  `matches.jsonl` reproduces them exactly. A test does this.
- The directory is portable: it contains its own configuration and every hash
  needed to say what it is.

## Alternatives considered

**SQLite or a columnar store.** Better for querying large result sets, and
CLAUDE.md §13.7 explicitly permits adding one behind an interface _when volume
justifies it_. Not yet: JSONL needs no dependency, no schema migration and no
tooling to inspect, and the current runs are far from the size where that stops
being true.

**Write records only at the end.** Simpler, and it would avoid the damaged-tail
case entirely. Rejected: it makes every interruption total, and it puts the whole
experiment in memory.
