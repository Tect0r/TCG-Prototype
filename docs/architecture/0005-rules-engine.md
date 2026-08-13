# ADR 0005 — Deterministic rules engine (Phase 2A)

**Status:** accepted · **Date:** 2026-08-07 · **Superseded in part by:**
[ADR 0016](0016-precon-wave-1-ruleset.md) · **Extended by:**
[ADR 0017](0017-optional-instructions-and-interactive-costs.md),
[ADR 0018](0018-delayed-and-replacement-effects.md),
[ADR 0021](0021-choice-contract.md)

**Amended 2026-08-13 (M07.3).** The five structural decisions below — clone per
action, no closures in state, one FIFO queue, derived stats, redaction as a
projection — all stand and are still the shape of the engine. Three statements
that described the Phase 2A scope are superseded in place: that there is no
priority system, what it costs to add an effect type, and which effects the
bundled set leaves unused. `MATCH_SCHEMA_VERSION` is now **7**.

## Context

Phase 2A needs a headless engine that runs complete 1v1 matches with no React,
no network, no database and no wall clock, and that the server, the client, the
tests and a future simulator all share (CLAUDE.md §10).

The hard requirements shaping the design: identical seeds must reproduce
identical matches; invalid actions must never partially mutate state; a paused
match must survive a JSON round trip; and a runaway loop must terminate with a
diagnostic rather than hang.

## Decision

### One entry point, working on a clone

```ts
applyAction(state, action, { database, config }) => Result<{ state, events }, EngineError>
```

`applyAction` deep-clones the caller's state, validates the action, mutates the
clone, and returns it only on success. Every failure path abandons the clone
entirely.

This makes two acceptance criteria **structural** rather than a matter of
discipline: an invalid action cannot partially mutate state, and it cannot
advance the RNG, because the state it would have mutated is discarded. The
alternative — persistent data structures or an undo log — buys nothing here:
match states are small, and a clone per action is far cheaper than the network
round trip that produced it.

### Everything is data, including the pause

There are no closures anywhere in `MatchState`. A `PendingChoice` carries a
serialisable `Continuation` naming the resolution queue item and the instruction
index to resume at. Resuming is "look up the item, write the selection into
`item.selections[index]`, and pump the queue again".

That is what makes reconnection, replay and `deserializeMatchState` work without
a special case, and it is verified directly: scenario 15 serialises a match
mid-choice, parses it back, and finishes the effect.

### One FIFO queue, no stack

Effects resolve through a single ordered queue. A trigger created while an item
is mid-resolution is **appended**, so the rest of that card's authored
instructions still resolve first. Simultaneous triggers are ordered by active
player, then source instance creation ordinal, then trigger index in the card
definition — all three are needed, and all three are deterministic.

There is deliberately no priority system and no player-orderable trigger stack;
CLAUDE.md §4 rules both out for Phase 2.

> **Superseded 2026-08-13 (M07.3).** Half of that is now wrong and half is
> permanent. There is still **no player-orderable trigger stack**: simultaneous
> triggers order by active player, then clockwise seat, then instance creation,
> then trigger index, and nobody may re-arrange them. But the engine does have a
> bounded priority mechanism — Reaction windows
> ([ADR 0016](0016-precon-wave-1-ruleset.md) §5). It is not a general stack: a
> window opens only at four named moments, only when somebody holds a playable
> Reaction, priority runs active player first and then clockwise, and each
> eligible seat may play at most `reactionsPerPlayerPerWindow` (**1**) card in
> it. Pending Reactions resolve last in, first out.
>
> The queue also gained two things that resolve **without** a trigger and
> without a window: delayed effects, which wait for a boundary, and
> replacements, which rewrite an arrival or a readying as it happens
> ([ADR 0018](0018-delayed-and-replacement-effects.md)).

### Derived stats, stored modifiers

Current Attack/Health are never stored. They are computed from the printed
statline plus a list of `StatModifier`s. This is what makes "removing a Health
bonus can defeat an already-damaged unit at the next state-based check" fall out
for free instead of needing a special case at expiry time.

### Combat in two damage steps

`quick_strike` combatants deal damage in an earlier step, with a full
state-based check between steps, so a unit killed by first strike never strikes
back. Everything else is computed for the whole step before any of it is
applied, which is what "simultaneous" means mechanically.

Blocks are stored as a list of `(attacker, blocker)` pairs rather than one
blocker field per attacker, so raising `blockersPerAttacker` above 1 later is a
config change, not a rewrite (CLAUDE.md §4 asks for exactly this).

### Safeguards instead of hangs

Two independent guards, both configured, never inlined: a step budget
(`maxResolutionSteps`) and a repeated-state detector over a structural
fingerprint. Tripping either ends the match with `reason: 'engine_error'`, an
`engine_fault` event, and the complete log — a diagnosable failure rather than a
frozen match.

### Redaction is a projection, not a filter

`playerView(state, viewerId, database, config)` builds a fresh object containing
only what the seat may know. Hidden cards are **absent**, not blanked: there is
no field to accidentally leak. RNG state and deck order have no representation
in the view at all. Log events are redacted individually, so replaying the log
cannot reconstruct what was not shown live.

The view also carries `legalActions`, computed by the engine, so the client
never derives legality itself.

## Consequences

- Every provisional number lives in `RulesConfig`; tests that need different
  rules pass a different config object rather than editing the engine.
- Adding an effect type means adding a case to `executeEffect`; the
  exhaustiveness guard makes a forgotten one a compile error.
- Two v0.2 effects (`ready`, `move_card`) are implemented but unused by the
  bundled set, so their tests supply their own card definitions rather than
  inventing cards for the shipped set.
- `structuredClone` per action means the engine needs a modern runtime. Node 20+
  and every current browser have it.

> **Superseded 2026-08-13 (M07.3).** The second and third bullets have moved, in
> opposite directions.
>
> Adding an effect type is no longer one case. It is a compile error in **six**
> total tables across four packages until every one of them is filled in —
> `executeEffect`'s exhaustiveness guard, `EFFECT_SUPPORT` (does the engine
> execute it, is it described, can a pilot play it, does a record observe it),
> `EFFECT_INTENTS` (benefit / detriment / neutral), `EFFECT_REGISTRY` and the
> explanation renderer table in `@tcg/help-content`, and `EFFECT_PRICERS` in
> `@tcg/bot-interface` — plus the valuation test's own mapped type, so a
> mechanic added without a pricing test does not compile. That is deliberate:
> each table is a claim somebody would otherwise have made by silence
> ([ADR 0022](0022-evidence-claims.md)).
>
> `ready` and `move_card` are both used by shipped cards now, and `move_card`
> carries two zone transitions the catalogue prints: `toZone: "removed"` is
> terminal, and `toZone: "battlefield"` is a revival that arrives as a fresh
> permanent — Newly Deployed, reporting `entersBattlefield` and never
> `deployed`.

## Alternatives considered

**Mutating in place with a transaction log.** Rejected: it makes "no partial
mutation" a property you have to remember to maintain in every handler.

**Event sourcing (state derived from the log).** Attractive for replay, but
every read would need a fold, and the log is already sufficient for replay
because the action log plus the seed reproduces the match exactly.

**Storing continuations as closures.** Would have been simpler to write and
would have made serialisation impossible. CLAUDE.md §9 forbids it explicitly,
and reconnection is the reason.
