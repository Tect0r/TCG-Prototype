# ADR 0020 — Board telemetry: one collector, two feeds, and a versioned stall

**Status:** accepted · **Date:** 2026-08-13 · **Extends:**
[ADR 0011](0011-telemetry-and-provenance.md),
[ADR 0016](0016-precon-wave-1-ruleset.md)

Recorded in M07.3 for decisions taken and implemented in M04.1–M04.3, answering
Q43.

## Context

[ADR 0016](0016-precon-wave-1-ruleset.md) removed the Unit cap rather than
raising it, on the explicit condition that board size would be **measured** so
the decision could be judged on evidence rather than reverted on impression.

Two things stood between that promise and evidence. The measurements existed
only in the spectator, over a finished replay, and a simulator batch — the only
thing that plays thousands of matches — recorded nothing about board size at all
and cannot retain every match's log to compute it afterwards. And the one
verdict either side did produce, `boardStalled`, was a threshold over rounds
with no declared attacker, which adds "nobody could attack" to "nobody would"
and calls the sum a stall. Those are opposite findings.

## Decision

### 1. One schema, in a package below both readers

`@tcg/board-telemetry` owns the definitions: per-round Unit counts, peak
Units / non-Tokens / Tokens / visual stack / Tokens by definition, the longest
turn, the largest combat and the most **expensive** combat (routinely different
combats), the busiest turn's triggers and choices, and what answered each seat's
largest board.

It is driven by the event stream and by the turn each accepted action was taken
on, and by **nothing else**. That is what lets the simulator feed it live from
`runMatch` while the spectator feeds it a finished replay and both get an
identical answer for the same deterministic match — which is asserted on a real
match rather than assumed, and is a function rather than a promise:
`reconcileBoardTelemetry` names the fields two documents disagree on.
`SpectatorTelemetry` **extends** the shared schema instead of restating it, and
keeps only what is true of a watched match.

### 2. The engine says why a round was quiet

`attack_opportunity` is emitted at every attack declaration, immediately before
`attackers_declared` and **before declared attackers Exhaust**, so it describes
the board the seat decided against rather than the board its decision produced.
It carries Units held, Ready Units, legal attackers, Exhausted Units, Ready
Units held back by `Newly Deployed`, living opponents, and attackers actually
declared.

It comes from `attackCensus`, which is also where `legal-actions.ts` gets
`legalAttackers`. The evidence and the legality the engine enforces are one
function rather than two readings of the same rule, and the counts partition the
board exactly — that is asserted, not assumed.

It is an **observation**: no trigger reads it, nothing branches on it, and every
count is a tally of Units on a public battlefield, so no observation boundary
moves ([ADR 0009](0009-bot-information-boundary.md)).

Each census is filed under exactly one of five outcomes that sum to
`seatsAsked` — able, no Units, all Exhausted, held by Newly Deployed, no living
defender — with `seatsDeclining` a subset of "able". A seat that never reached
its attack step is not counted at all, because no decision was taken and there
is nothing to attribute.

### 3. The stall rule is data, and travels with its verdict

Q43 required "one explicit, configurable, versioned number rather than a
judgement made in the reporting layer". So the rule lives in
`@tcg/board-telemetry/stall`, the collector applies it, and a report renders the
answer without ever deciding it.

The answer is the **strict** reading: a round counts toward a stall only when
every living seat reached its attack step, every one of them could legally have
attacked, and none of them did. **Three consecutive** such rounds is a stall.
Four things follow, each chosen rather than inherited:

- **It is about ability, not silence.** `seatsAble === seatsAsked` is the
  opposite test to "no attackers were declared".
- **The opening excludes itself**, with no round-1 special case. An empty board
  is never able and a board that all arrived this turn is held by
  `Newly Deployed`, so round 1 fails eligibility by the ordinary rule.
- **A single declared attacker breaks the streak**, one Token included.
- **It almost never fires on a wide table**, which is the point. A metric that
  cannot say "no" is not evidence.

Every document carries the definition it was judged by as `stallDefinition`, so
a verdict never travels without its rule, and a batch that mixes definitions is
**refused a summary** rather than given a meaningless one.
`STALL_DEFINITION_VERSION` pins the eligibility rule separately from
`thresholdRounds`, because the threshold is configuration and the rule that
decides which rounds are counted at all is not.

### 4. Raw material is kept so the verdict can be re-cut

`stallEligible` is stored per round, the streak the verdict was cut from is
stored raw as `longestUnanimousDeclinedStreak`, and `livingSeats` is recorded at
each round's start — because `seatsAsked` alone cannot tell "the whole table"
from "a seat that was skipped" after an elimination. A finished document can
therefore be re-judged at a different threshold **without re-simulating**.

`attackOpportunity.classification` is the literal `'undetermined'` so nothing can
read a verdict out of it by accident, and a build that starts writing one has to
change the schema version.

## Consequences

- `boardStalled` was **removed, not retuned**. It was the only derived verdict in
  either document, and it was the wrong one.
- Version moves are refusals, never migrations, because the older artefacts
  never made the observations: board telemetry is at **3**, and spectator
  replays and simulator records each moved with it. A v3 spectator replay cannot
  answer what a seat could have attacked with and carries a `boardStalled` claim
  that no longer exists, so it is refused rather than partially read.
- Reports carry a `## Unlimited board` section that answers M04's four questions
  with distributions rather than averages, and it aggregates over **every**
  record, abnormal ones included. That is the one place a report departs from its
  usual sample, and it says so: a turn-limit match is the strongest stall
  candidate in a batch, and excluding it would be excluding the evidence.
- The measurement so far says the unbounded battlefield is fine. Both traced
  four-seat precon matches classify `not_stalled`, which is the right answer for
  matches that ended in 53- and 64-attacker combats, and the largest board Wave 1
  produces is 117 Tokens on one seat.

## Alternatives considered

**Compute board telemetry from the match log after the run.** Rejected for the
reason [ADR 0011](0011-telemetry-and-provenance.md) rejected it for card
telemetry: a batch must not retain every match's logs, and replaying to compute
doubles the cost of the expensive part of a large run.

**Leave the stall threshold in the reporting layer.** Rejected by Q43 itself. A
threshold that lives where the prose lives is a threshold nobody can compare two
runs against.

**The permissive reading** (a quiet round is a stall regardless of ability).
Rejected on the traces: the baseline's `longestStallRounds: 2` was round 1,
where nobody _could_ attack, plus round 2, where two seats could and declined.
Summing those two answers produces a number that means neither of them.
