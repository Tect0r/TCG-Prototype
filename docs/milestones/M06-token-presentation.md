# M06 — Token presentation and match readability

## Objective

Reduce large-board clutter in ordinary matches without changing engine state or
individual Token identity.

## Decision checkpoint — Q42

Before coding, inspect real Wave 1 Token states and ask the owner to confirm the
visual grouping key. Recommend grouping only Tokens whose public, interaction-
relevant state is identical, for example:

- same controller and Token definition;
- same Ready/Exhausted and Newly Deployed state;
- same damage, keywords/Barrier state, counters, and derived stats;
- same visible modifiers and combat participation.

Do not group merely by card art/name if individual state differs.

## M06.1 — Pure presentation grouping

Build a view-model grouping layer in the normal match client. It must not mutate
match state, replace instance IDs, or create a stack object in the engine.

Show count, representative card, state summary, and clear expansion affordance.

## M06.2 — Individual interaction

From a group, players must still be able to select exact instances for attacks,
blocks, targets, sacrifice, activation, and inspection. When state diverges, the
instance moves to the appropriate visual group deterministically.

Keyboard and screen-reader interaction must expose count and selectable members.

## M06.3 — Cross-view consistency

Reuse the presentation grouping in spectator and normal match views where
practical. Normal spectator mode exposes only public information; Analysis mode
may show private zones but must not change grouping semantics.

Add visual/view-model tests for large groups, damaged members, exhaustion,
Barrier consumption, combat selection, and replay stepping.

## Acceptance

- Large Token boards remain readable.
- Every Token remains an independently addressable engine instance.
- Grouping on/off produces identical legal actions, engine events, replay hashes,
  and telemetry.

## Exclusions

- Engine-level Token stacks.
- Automatic Unit caps.
- Grouping non-Token Units.
