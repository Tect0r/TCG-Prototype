# ADR 0002 — Card data model and structured effects

**Status:** accepted · **Date:** 2026-08-07 · **Superseded in part by:**
[ADR 0016](0016-precon-wave-1-ruleset.md) (formats, Commanders, Reactions) and
[ADR 0017](0017-optional-instructions-and-interactive-costs.md)
(`additionalCosts`, `optional`)

**Amended 2026-08-13 (M07.3).** Two statements below described the model as it
was on 2026-08-07 and are superseded in place: where the `effects` /
`on_deploy` overlap ended up, and what a display-text warning does.

## Context

Card behaviour must be executable by a deterministic engine that does not exist
yet. Phase 1 only browses and validates cards — but if the schema is wrong now,
every card has to be re-authored later.

## Decision

Cards are declarative JSON, validated by Zod at startup and in tests. Behaviour
is a **discriminated union of effect objects**, never prose.

### Effects and abilities

```ts
effects: EffectDefinition[];      // resolved when the card is played
abilities: AbilityDefinition[];   // { id, trigger, effects } while in play
```

The specification's `CardDefinition` sketch only has `effects`, and its example
is a spell — where "played" and "resolved" are the same moment. Units and
relics also need behaviour that fires _later_, which needs a trigger, so
`abilities` was added rather than overloading `effects` with an optional
trigger field.

The overlap between a unit's `effects` and an `on_deploy` ability is real and
recorded in [open-decisions](../rules/open-decisions.md); it can be collapsed
once the engine shows which form it actually wants.

> **Superseded 2026-08-13 (M07.3).** The engine showed which form it wanted and
> the overlap is gone (Q1, answered 2026-08-07). There is **no `on_deploy`
> trigger** in the vocabulary: top-level `effects` is both spell resolution and
> unit/relic deploy resolution, `abilities` carries non-deploy triggers only,
> and the v1 → v2 card migration folded existing `on_deploy` abilities into
> `effects`. What remains genuinely distinct is `deployed` versus
> `entersBattlefield` — a card that arrives by revival reports the second and
> never the first — and those are reviewed card by card in
> [entry-trigger-review.md](../rules/entry-trigger-review.md), never
> bulk-converted.

Cross-field rules are enforced in the schema, not by convention:
units/commanders/tokens must have a statline and others must not; commanders and
tokens have `cost: null`; tokens are never collectible; spells need at least one
effect and cannot have triggered abilities.

### Discriminated unions over one wide object

Each effect type owns its own required fields. `deal_damage` needs a target and
an amount; `draw` needs a player and an amount. A single object with thirty
optional properties would validate nothing useful and would make the engine's
switch statement unsafe.

### Targeting

`TargetSelector` is a structured filter — zone, controller, card filter, count,
selection mode, chooser — because the authoritative engine must compute the
legal set. The client renders choices; it never decides legality. The filter
shape is deliberately richer than Phase 1 needs so card data authored now stays
valid.

### Display text is checked, never parsed

`displayText` is presentation only and is never read to determine behaviour.
Drift between prose and effects is nevertheless a common authoring bug, so
`lintDisplayText` warns when text clearly names a mechanic (`"Draw a card"`,
`"+2/+2"`, a keyword name) with no matching structured effect. Warnings never
block loading, and a test asserts the bundled set produces none.

> **Superseded 2026-08-13 (M07.3).** The check still never parses prose into
> behaviour — that rule is permanent — but it is no longer advisory and no
> longer runs in one direction. Since M02.6 the content build turns every card
> warning into a **hard error** for a set whose status is `playtest` or
> `active`, and `precon_wave_1` is a `playtest` set; and the drift check reports
> **both** directions, prose promising behaviour the card lacks _and_ behaviour
> the card performs that the prose never mentions, with no exemption for a card
> whose help text is hand-written. Two further build gates joined it: every card
> in a strict-status set must have a behaviour contract
> (`@tcg/rules-engine/card-contracts`), and a card using a mechanic the engine
> does not execute fails the build outright, derived from the support registry
> rather than claimed ([ADR 0022](0022-evidence-claims.md)).

## Validation and loading

`loadCardSets(rawSets)` returns a `Result`, never throws, and reports structured
`Issue`s with stable codes and data paths. Beyond schema validation it checks
duplicate IDs across sets, that `create_token` references resolve to actual
tokens, and warns about orphan tokens and colour leaks. A migration seam exists
for schema bumps; a set from a future `schemaVersion` is rejected with an
upgrade hint rather than half-parsed.

## Consequences

- Adding an effect type means one union member plus the engine's handler. The
  compiler finds every place that must change.
- Invalid card data is a hard startup failure with actionable errors, not a
  half-working app.
- The schema is broader than Phase 1 exercises. That is deliberate: the cost of
  an unused field is far lower than re-authoring the card set.
