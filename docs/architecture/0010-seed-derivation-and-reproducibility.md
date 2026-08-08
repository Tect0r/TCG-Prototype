# ADR 0010 — Seed derivation and reproducibility (Phase 4)

**Status:** accepted · **Date:** 2026-08-08

## Context

A balance laboratory that cannot reproduce its own results produces anecdotes.
CLAUDE.md §13.4 is explicit: reproducibility must be independent of worker
count, scheduling order, machine speed and the order results arrive in, and the
derivation must not touch a clock, a process ID, an array position or
`Math.random()`.

Phase 4 also needs _paired_ comparisons. Measuring a one-card change by playing
two independent random samples wastes most of the sample on shuffle variance;
the change has to be measured on the same games.

## Decision

### Seeds are hashes of a readable path

Every seed in an experiment is derived by joining immutable identifiers into a
path and hashing it with SHA-256, truncated to 32 hex characters:

```text
exp-2026-08                                   experiment
exp-2026-08|env:baseline                      environment
exp-2026-08|env:baseline|pair:a1b2c3d4        deck tuple
exp-2026-08|env:baseline|pair:a1b2c3d4|game:000003
  …|game:000003|match                         match RNG
  …|game:000003|seats                         seat assignment
  …|game:000003|pilot:0                       one per seat
```

The path itself is stored in every record next to the derived seed, so a reader
can see _why_ a match got the seed it got rather than trusting that it did.
`SEED_DERIVATION_VERSION` is recorded too, and is bumped whenever the scheme
changes, so an old result set is never silently re-interpreted under new rules.

Nothing in the derivation depends on how the work was distributed. A match run
by worker 7 of 8 gets the seed it would have got running alone.

### Identity is content-addressed

A deck's identity is the canonical hash of its Commander and its card quantities
with entries sorted and zero quantities dropped — entry order cannot change it,
and a changed quantity or Commander always does. An environment's identity is
the hash of its playable pool, its rules configuration and its deck format. A
match ID is the hash of the experiment, environment, deck tuple, pilot tuple and
game index.

Because names are derived from content, resume and deduplication are trivial:
regenerate the schedule and skip the IDs already on disk. Nothing needs a
counter, and two machines agree without talking to each other.

### The deck-tuple identity is order-independent

`deckPairId` hashes the _sorted_ deck hashes. Both seat orientations of the same
table therefore share one identity and one seed path, so a mirrored schedule
plays each orientation on the same shuffles. A seat advantage shows up as a
difference between two orientations of one game rather than as noise between
unrelated games.

### Two ways to force common random numbers

A paired comparison needs two runs that differ in exactly one thing to share
their shuffles. Both cases are handled by _removing_ the differing term from the
seed path, never by copying seeds around:

- **Baseline versus candidate** (`pairedSeeds`): the environment segment is
  dropped, so `pair:X|game:N` derives the same match, seat and pilot seeds in
  both environments. The records still carry their true `environmentId` and
  hash, so nothing downstream can confuse the arms.
- **Card replacement** (`seedIgnoreDeckHashes`): the arm decks are masked to `*`
  when deriving the deck-tuple identity, so "deck A" and "deck A with one card
  swapped" against the same opponent derive one seed. Again, only the seed is
  affected; the recorded `deckPairId` is the real one.

### Aggregation order is fixed separately

Determinism of the seed is not enough: floating-point sums depend on the order
they are added in. Every record carries an `orderKey`, and the batch runner sorts
by it before any aggregate is computed. `workers: 1` and `workers: 8` therefore
produce byte-identical aggregates, which is asserted by both the test suite and
the benchmark.

### Records carry no wall-clock

`MatchRecord` has no timestamp and no duration. Two runs of the same match must
compare byte-for-byte, and a duration field would have made that impossible.
Elapsed time lives in the batch manifest, which is explicitly not part of the
reproducible surface.

## Consequences

- An interrupted run resumes by regenerating the schedule; nothing is re-run and
  nothing is duplicated.
- A reported result can be re-derived from `manifest.json` alone: the root seed,
  derivation version, environment hash, deck hashes and pilot configs are all
  there.
- Adding a term to a seed path changes every seed below it. That is why the
  version is recorded, and why paired comparisons remove terms rather than
  adding them.

## Alternatives considered

**Seed each match from a counter.** Rejected: the counter depends on scheduling,
so resume and parallel execution both change results.

**Store an explicit seed per scheduled match.** Workable, but it makes the
schedule a piece of data that has to be persisted and kept in sync rather than a
pure function of the configuration, and it loses the ability to state _why_ a
match had the seed it did.
