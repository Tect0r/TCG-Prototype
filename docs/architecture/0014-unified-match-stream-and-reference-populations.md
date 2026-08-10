# ADR 0014 — One match stream, and immutable reference populations (Phase 4 hardening)

**Status:** accepted · **Date:** 2026-08-09 · **Amends:**
[ADR 0012](0012-experiment-storage-and-checkpointing.md)

## Context

Two persisted-data defects were found in the Phase 4 audit
([PHASE4_HARDENING.md](../PHASE4_HARDENING.md) §6 and §7). Both are the kind
that produce a plausible report rather than an error.

**Only batches streamed.** ADR 0012 chose `matches.jsonl` as the primary raw
output, and `runBatch` honoured it. Searches and comparisons did not: they
accumulated every record in memory and wrote a final `matches.json` array. So
the two largest experiment kinds were the two that could not be resumed and the
two most likely to exhaust memory — precisely backwards. Documentation and
reports also referred to whichever file the author had in mind.

**Reference populations were regenerated per environment.** A comparison called
`resolveDeckSource` once for the baseline and once for the candidate. With a
`generated` source that means the two arms each built their _own_ population,
from different card pools, so different decks. The report's "the same decks,
unchanged, in both environments" section was not that at all: every deck-level
delta mixed the rules change together with two different decklists, and nothing
recorded afterwards could separate them.

## Decision

### One `MatchStore`, one stream, one identity

`apps/simulator/src/reporting/match-store.ts` is the only raw record store.
Every experiment kind — batch, search, replacement, comparison, robustness —
opens exactly one and streams into it. `runBatch` takes a `MatchSink` rather
than a directory, so an in-memory test, a plain batch, one arm of a comparison
and one generation of a search all use the same code path.

A record's identity is **`arm + matchId`**, not `matchId` alone. This amends ADR
0012, which deduplicated on the content-addressed match ID. That was sufficient
while only batches streamed; it is not sufficient once a comparison's two arms
and a search's generations share one file. Every record therefore carries:

- `experimentKind` — which kind produced it;
- `configHash` — the normalized configuration's identity;
- `arm` — `baseline` / `candidate`, `search:<label>:g<n>`, `profile:<id>`, or
  `null` for a plain batch.

`matches.json` may still be _read_ for backward compatibility. New runs never
create it, and every report and document names `matches.jsonl`.

### Resume is the file on disk

A record is resumable once its newline is committed. On resume the store:

1. reads a sidecar `matches.header.json` and **refuses** if the experiment ID,
   kind, configuration hash, telemetry schema, seed-derivation version or hash
   version differ — merging those would produce a result set that is neither
   experiment;
2. drops an unparseable or invalid line, reporting it in the manifest, and keeps
   every valid record before it;
3. rewrites the file from the surviving records, so a damaged tail is truncated
   exactly once rather than re-read on every future resume;
4. skips scheduled matches whose identity is already committed.

An uninterrupted run and a resumed run produce byte-identical records and an
identical summary. That is asserted, not assumed.

### The reference population is resolved once and frozen

`apps/simulator/src/reference-population.ts` implements the default policy
`shared_legal_reference_population`:

1. resolve or load the population **exactly once**, against the baseline;
2. content-hash it from the decks' own canonical hashes, sorted — so the hash
   changes when a Commander or a quantity changes and never when an entry order
   does;
3. validate every deck against **both** pools;
4. keep only decks legal in both, and record the rest with the exact legality
   reason and which environment rejected them;
5. never repair, mutate or regenerate a deck for one side;
6. record the hash in both result sets and **throw** if they ever differ.

Resolving against the baseline is a deliberate asymmetry, not a neutral choice:
resolving against the candidate would move the same bias to the other side.
There is intentionally no configuration option that regenerates per environment,
because that is the defect.

### Reference impact and discovery impact stay apart

A frozen reference population cannot contain a card the candidate added — no
deck built before the change could have run it. That is not a gap in the design,
it is why the comparison also runs an independent deck search in _each_
environment, and why the report keeps two separate answers:

- **reference impact** — what the change did to the decks people already play;
- **discovery impact** — what the change made newly possible.

Reporting only the first understates a new card. Reporting only the second,
against a stale baseline, overstates it. Mixing them makes both uninterpretable.

## Consequences

- Searches and comparisons are now resumable and no longer hold a whole run in
  memory. A long search can be interrupted and continued.
- A comparison whose reference decks are `generated` now plays _fewer_ decks
  than before when the candidate changes legality, because decks illegal in
  either environment are dropped from both arms. The exclusions and their
  reasons are in `reference-population.json` and in the report.
- Resuming into a directory written by a different configuration now fails
  loudly. Previously it would have merged.
- `matches.header.json` and `reference-population.json` are new files in the
  experiment directory. A stream without a header cannot be resumed.
