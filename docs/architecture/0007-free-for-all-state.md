# ADR 0007 — Free-for-all state, choices and combat (Phase 3)

**Status:** accepted · **Date:** 2026-08-08

## Context

Phase 3 turns the authoritative 1v1 into a genuine two-to-four-player
free-for-all (CLAUDE.md §12). The Phase 2 engine was not written around two
players on purpose, but it did carry two-player habits: a single `opponentId`
was reachable from any player, combat assumed one defender, and "the other
player" was a concept rather than a lookup.

A free-for-all breaks all three. It also introduces problems 1v1 never had:
several defenders answering independently over a network, players leaving the
table mid-match, and effects that must name _which_ opponent they mean.

## Decision

### Seat order is state, not array position

`MatchState.seatOrder` holds the full original circle and is **never reordered
or renumbered**, including when players are eliminated. `playerOrder` is the
same circle rotated to start at the current starting player.

Every "who else is at this table" question goes through a helper in `derive.ts`
— `livingPlayers`, `livingOpponents`, `clockwiseFrom`, `nextLivingPlayer`,
`activeFirstOrder` — so no rule can quietly reintroduce a two-player assumption.
Eliminated seats are skipped by those helpers, not removed from the circle.

Card data, protocol messages, choices, events and views all use stable player
IDs. Nothing is addressed by index.

### Seat order is rolled from the match seed

At three or four seats, table position is a real advantage, and taking it from
join order would hand it to whoever created the lobby. `createMatch` shuffles
`seatOrder` from the seed before anything else consumes randomness
(`preserveSeatOrder: true` opts out, for tests that need a known table).

A 1v1 is left alone: with two seats there is no position to win, and shuffling
would have changed every existing Phase 2 seed.

### Attacks carry their defender

An attack declaration is `{ attackerInstanceId, defenderPlayerId }`. Combat
state keeps `attacks`, the set of defenders still owed a submission
(`awaitingDefenders`), the per-defender `submissions`, and the merged `blocks`.

A blocker is legal only for an attack aimed at its own controller — third-party
blocking is rejected by the engine, not hidden by the UI.

### Independent blocker submissions cannot race

Each attacked defender submits blockers for their own attacks only. Submissions
are held per defender and merged into the public `blocks` list in **seat order**
once the last defender has answered, so the order in which they arrive over the
network cannot change the result. Damage then resolves as one simultaneous
combat step across every defender.

This is the multiplayer analogue of the seeded-determinism rule: two runs of the
same match with the same actions produce the same state regardless of network
timing.

### Player targets are a first-class target kind

`TargetDefinition` is a discriminated union — `entity`, `source`, `player`,
`players` — rather than forcing a player into a zone-based selector or a
`targetsSource` boolean (Q23, Q29).

`opponent` with more than one living opponent raises a **choice** instead of
letting the engine pick a seat. `each_opponent` and `all_players` resolve
clockwise from the controller as one atomic multi-recipient instruction, so a
sweep that kills everyone at once is a draw rather than a race; presentation
events are still emitted per recipient in that same order.

### Elimination is one batched cleanup

The eight steps of CLAUDE.md §12 run as a single batch per player inside the
state-based check, in this order: cancel their queued effects and pending
choice, drop attacks aimed at them and blocks they committed, then remove their
cards. State-based checks and trigger discovery run once after the whole
cleanup, so a board wipe cannot fire death triggers one object at a time.

Ownership and control are separate explicit fields on every `CardInstance`.
"Remove the cards they own, wherever they are, and hand back the ones they only
controlled" is therefore a lookup, never an inference from which battlefield a
card is sitting on. Cards owned by an eliminated player go to a terminal
`removed` zone; tokens cease to exist.

Because a loss can now happen with the match continuing, conceding and timing
out run the **full** state-based check rather than just testing for a winner.
In 1v1 that distinction was invisible — a concession ended the match — which is
why the two-player code could get away with the shortcut.

### Elimination does not end the connection

An eliminated seat keeps receiving redacted views and is refused every gameplay
action with `engine/eliminated`. Spectating is a view-layer state, not a
separate mode: the same `playerView` serves it, so a spectator cannot be given
information a living player would not have.

## Consequences

- Every existing 1v1 behaviour is preserved; the Phase 2 suites pass unchanged.
- Adding a fifth seat would be a config change, not a redesign, though nothing
  above has been tested beyond four.
- Multiple blockers per attacker remains unimplemented but is no longer
  structurally blocked: `blocks` is already a list of pairs.
- There is still no priority system, no reactions and no player-controlled
  trigger ordering, all deliberately out of scope for this phase.
