# M06 — Token presentation and match readability

## Objective

Reduce large-board clutter in ordinary matches without changing engine state or
individual Token identity.

## Decision checkpoint — Q42 — **answered by the owner (2026-08-13)**

Before coding, inspect real Wave 1 Token states and ask the owner to confirm the
visual grouping key. Recommend grouping only Tokens whose public, interaction-
relevant state is identical, for example:

- same controller and Token definition;
- same Ready/Exhausted and Newly Deployed state;
- same damage, keywords/Barrier state, counters, and derived stats;
- same visible modifiers and combat participation.

Do not group merely by card art/name if individual state differs.

### The answer

**Controller + definition + the whole public interaction-relevant state.** The
recommended reading, chosen over definition-only grouping and over
definition-with-sub-badges, and over the fear recorded in Q42 that a strict key
would split and re-form so constantly as to be worse than no grouping.

The evidence it was chosen against is three complete four-seat Wave 1 precon
matches (all four precons; seeds `q42-a`, `q42-b`, `q42-c`; 275 sampled board
states holding at least one Token), measured through `playerView` so nothing
outside a seat's own boundary was counted:

| Measure                                      | Result                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Largest one-seat Token group observed        | **117** `goblin_token`                                                                          |
| …split by the strict key                     | **2** tiles — 64 Newly Deployed, 53 Ready, all 2/1, undamaged                                   |
| Tiles across all samples, definition-only    | 441                                                                                             |
| Tiles across all samples, strict key         | 631 (**1.43×**)                                                                                 |
| Samples where state split a definition group | 139 / 275                                                                                       |
| Fields that ever split a group               | `summoningSick` 157, `exhausted` 69, `markedDamage` 58, attacking 15, `keywords` 5, blocking 1  |
| Fields that never split a group              | `attack`, `health`, `willNotReady` — Wave 1 buffs are board-wide and move a whole group at once |

So the strict key costs 1.43× the tiles and the permissive one would have hidden,
on the worst board Wave 1 produces, the fact that 64 of those 117 Tokens could
not attack.

Two consequences are recorded rather than left implicit:

- **A tile is not a targeting unit.** `groupByTokenDefinition` (the shipped
  `containment_pulse`) expands a chosen Token into every Token of the same
  **definition** controlled by the same player, whatever state it is in, and
  that is unchanged — so a card that hits "a Token stack" deliberately reaches
  across several tiles. The glossary entry says so in the player's own words.
- **`barrierSpent` is now public** on `CardInstanceView`. "Has Barrier" and "has
  Barrier left" are different questions and only the first reached a client, so
  two Tokens that answer combat completely differently were indistinguishable.
  Not a new disclosure: `barrier_consumed` is already an unredacted log event.

## M06.1 — Pure presentation grouping — **done (2026-08-13)**

Build a view-model grouping layer in the normal match client. It must not mutate
match state, replace instance IDs, or create a stack object in the engine.

Show count, representative card, state summary, and clear expansion affordance.

### Checklist

- [x] `apps/web-client/src/lib/token-grouping.ts` is the layer: pure functions
      over a `PlayerView`, returning new arrays. No engine change, no stack
      object in `MatchState`, and a group's React key is the **grouping key**
      rather than any member's instance ID — a group has no identity of its own.
- [x] `TOKEN_GROUP_KEY_FIELDS` names the twelve fields the key is cut from, and
      the test suite drives its own cases off that list, so a field added to the
      key without a test fails rather than passes quietly.
- [x] Combat participation is read from `view.combat` — declared attacks, public
      blocks, and the viewer's **own** outstanding blocker submission, which is
      theirs to see and already on their screen. No other seat's submission is
      in a `PlayerView` to read.
- [x] Only Tokens group. A non-Token Unit is always its own tile however many
      copies are out (M06 exclusion), and so is a unit the view does not
      describe: a card cannot be grouped by state it was never told.
- [x] A group of one is demoted to an ordinary card rather than drawn as a tile
      saying ×1 with an expand button that reveals itself
      (`DEFAULT_MINIMUM_GROUP_SIZE`).
- [x] `TokenGroupTile` shows the count, the representative's card, the state the
      whole group shares — built by `tokenGroupSummary` from the same fields
      that decided the group — and an `aria-expanded` disclosure affordance.
      Expanding renders the members through the _same_ `UnitCard` path a lone
      unit uses, so there is one interaction path rather than two.
- [x] A **Stack tokens** toggle turns the layer off, returning the seat's units
      one tile each in their own order — the pre-M06 board exactly. It sends
      nothing and changes no match state, which is what makes M06's "grouping
      on/off is identical" acceptance criterion checkable by playing.
- [x] `barrierSpent` added to `CardInstanceView` and `PROTOCOL_VERSION` 5 → 6, a
      refusal at the handshake rather than a strict-object parse failure
      mid-match. `MATCH_SCHEMA_VERSION` deliberately does **not** move: the
      field has been on `CardInstance` since Barrier shipped and it is the
      projection that changed, not the state. No replay or telemetry version
      moves, because no artefact carries a view.
- [x] Glossary entry `token_stack` describes the stack as presentation, says
      every member keeps its own damage, and warns that a card affecting every
      Token of a kind may cross several stacks.
- [x] Tests: 21 in `token-grouping.test.ts` (one per key field, plus combat
      splitting, keyword-order insensitivity, the grouping-off path, and a
      multiset invariant asserted on **every** board the suite builds — grouping
      loses no Token and invents none) and 3 in `match-flow.test.tsx` driving
      the real board through the fake transport.

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
