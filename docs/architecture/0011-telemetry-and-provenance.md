# ADR 0011 — Telemetry, provenance and dead-hand categories (Phase 4)

**Status:** accepted · **Date:** 2026-08-08

## Context

The laboratory's job is to produce evidence about cards (CLAUDE.md §13.6). The
naive approach — read the final board and the winner — cannot work: by the end
of a match most of the interesting cards are in the discard pile, and the ones
that mattered most are often the ones that died doing it.

CLAUDE.md is also specific that "dead card" must not be one vague number, and
that a card must not be credited with a win merely for having been drawn.

## Decision

### Telemetry is collected during the match, from the event stream

`TelemetryCollector` observes every decision, every accepted action and every
emitted event as the match runs. Attribution uses the causal
`cause.sourceInstanceId` the engine already stamps on each event, so damage,
healing, draws, tokens and triggers are credited to the card that caused them —
including after that card has left play.

The clearest case: `unstable_construct` creates its tokens from an
`on_defeated` trigger. By the time the tokens exist, the source is in the
discard pile. Post-hoc reconstruction would attribute those tokens to nothing;
the event stream attributes them correctly, and a test asserts it.

### Definition IDs leave, instance IDs do not

Match-local instance IDs are used inside the collector to trace causality, and
are never emitted. Every row that leaves is keyed by the permanent card
definition ID, because that is the only identifier that means the same thing
across matches, experiments and releases.

### Dead-hand has four causes, not one number

A copy that was never played falls into exactly one bucket:

| Category             | Meaning                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `unseen`             | Stayed in the deck. Not dead _in hand_, and never counted as such.       |
| `never_affordable`   | Reached a hand; the seat never had the energy for it after a draw.       |
| `no_legal_window`    | Affordable at some point; targets, slots or requirements never lined up. |
| `legal_but_unchosen` | The engine offered it and the pilot chose something else.                |
| `used`               | Not dead: played, activated, or spent as a cost.                         |

The distinctions carry the diagnosis. `never_affordable` is a statement about
the card's cost against the energy curve; `no_legal_window` is a statement about
its requirements; `legal_but_unchosen` is a statement about _the pilot_, not the
card, and must be readable as such. Collapsing them would make all three look
like "this card is bad".

Two consequences follow, and both are enforced:

- A discarded card is **not** marked used. Pitching a card to the hand-size limit
  is the textbook `legal_but_unchosen` case, and calling it "used" would hide
  precisely the signal the categories exist to expose.
- The Commander is excluded from dead-hand accounting entirely. It starts outside
  the deck and can never be drawn, so classifying it as `unseen` would put a
  permanent phantom dead card on every Commander row. It still gets a telemetry
  row for everything it _does_.

Every copy in a deck lands in exactly one category, which is asserted against the
decklist on real matches — no double counting, none lost.

### Raw records are the product; everything else is derived

`matches.jsonl` holds one validated `MatchRecord` per match and is the primary
output. `summary.json`, the CSVs and `report.md` are all recomputable from it,
and a test deletes nothing but re-derives the entire summary from the JSONL file
and asserts it is byte-identical to what was written.

That is what makes a reported number checkable rather than trusted. It is also
why the record schema contains no score, no flag and no opinion.

### Logs exist for the length of a match, and are kept only when they matter

Whether a match deserves a replay is only knowable _after_ it ends — an abnormal
termination is discovered at the last step. So the runner always collects the
action log, the event log and the per-decision diagnostics, and the caller
decides what survives: every abnormal match keeps its bundle, plus a configurable
sample of normal ones.

Gating collection on a flag decided up front produced exactly the useless
artefact the requirement exists to prevent — a replay bundle for a broken match
with nothing in it. The memory cost is one match's logs at a time, released
immediately; what §13.14 asks us not to retain is the logs of _every_ match
across a large run, and that is still not retained.

## Consequences

- Card telemetry is large: one row per card definition per seat per match, with a
  capped sample of before/after board snapshots. That is the cost of being able
  to verify a derived metric independently.
- Attribution is only as good as the engine's causal stamping. Where the engine
  does not define a source — state-based defeats, for instance — nothing is
  attributed, rather than something being guessed.
- Adding a counter is cheap; changing the meaning of one is not, because reports
  and comparisons read them. `TELEMETRY_SCHEMA_VERSION` is recorded in every
  record.

## Alternatives considered

**Reconstruct telemetry from the event log after the match.** Equivalent in
principle and it would keep the runner simpler. Rejected because it requires
replaying the whole match to compute anything, which doubles the cost of the
expensive part of a large run.

**One `deadCard` boolean.** Rejected outright by CLAUDE.md §13.6, and rightly:
it would conflate a card the format prices out with a card the pilot does not
understand.
