# ADR 0008 — Continuous effects and static abilities

**Status:** accepted · **Date:** 2026-08-08

## Context

Phase 2A had no continuous-effects layer. "Your other units get +1/+1" was
authored as a one-shot `modify_stats` that stamped a permanent modifier onto
whatever happened to be on the board when the source resolved. That is wrong in
three ordinary situations:

- a unit played **after** the lord never got the bonus;
- the bonus **survived** the lord leaving play;
- resolving the same effect twice stacked two permanent modifiers.

CLAUDE.md §17 Q2 confirmed the fix — a separate validated continuous layer that
is derived from current state and never stamps recipients — and told us not to
author more aura or lord cards until it existed.

## Decision

### Static abilities are a separate authoring field

`CardDefinition.staticAbilities` is validated separately from `effects` and
triggered `abilities`. A static ability declares:

- `activeZone` — where the source must be for the ability to apply at all;
- `affects` — a `ContinuousScope` of `{ controller, zone, filter?, excludeSource? }`;
- `effect` — `modify_stats` or a keyword grant.

This is deliberately narrower than the one-shot effect vocabulary. A static
ability cannot draw a card, deal damage or move anything: those are events, and
events belong in the resolution queue where they can be ordered and logged.

### The layer is recomputed, never accumulated

`recalculateContinuous` throws the entire layer away and rebuilds it from the
current board. Every instance carries a `continuous` layer that is _output_,
never input.

The three problems above disappear by construction rather than by bookkeeping: a
late arrival is picked up on the next recalculation, a departed lord contributes
nothing to the next one, and recalculating twice is identical to recalculating
once. Idempotence is the property that makes this safe to call as often as we
like.

It runs at the top of every state-based check, and `settle` runs those after
every atomic instruction, so no rule ever reads a value more than one
instruction stale. It returns whether anything changed, so the check can loop
again only when it might matter: removing a Health-granting lord can be lethal
to a damaged unit, and that has to be visible to the very next defeat check.

### Ordering is explicit

Sources are iterated in instance-creation order, so two lords granting
conflicting things resolve identically on every machine and in every replay.
Granted keywords are stored sorted for the same reason.

### Filters read printed state

A static filter matches against the printed definition plus the instance's own
non-continuous state. Letting filters read the layer being computed would be
circular ("gets +1/+1 if it has 2 attack" changing its own eligibility), and no
card in the prototype set needs it. This is a known limitation, not an
oversight.

### Deck and `removed` are not legal scopes

Deck order is hidden information and `removed` is terminal. A scope naming
either resolves to nothing rather than silently working, because a continuous
effect that reads the deck would leak the deck.

### An eliminated player's permanents stop contributing immediately

`activeSources` skips instances controlled by a player who has lost, before the
elimination cleanup has finished removing their cards. Otherwise a dead player's
lord would still be pumping units during the very state-based check that is
removing them (CLAUDE.md §12 step 3).

## Consequences

- Aura and lord cards are now safe to author.
- `currentAttack` / `currentHealth` / `effectiveKeywords` are the only correct
  way to read a unit's stats. Reading printed values directly is a bug.
- Keyword _removal_ is modelled in the layer (`removedKeywords`) but no bundled
  card uses it yet.
- The layer is recomputed more often than strictly necessary. It is O(sources ×
  scope) over a board of at most twenty units, and correctness at this stage is
  worth more than avoiding that.
