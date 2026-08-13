# ADR 0021 — The choice contract: who is asked, what the answer is, and why

**Status:** accepted · **Date:** 2026-08-13 · **Extends:**
[ADR 0005](0005-rules-engine.md), [ADR 0007](0007-free-for-all-state.md),
[ADR 0009](0009-bot-information-boundary.md),
[ADR 0017](0017-optional-instructions-and-interactive-costs.md)

Recorded in M07.3 for decisions taken and implemented in M02.5 and M05.3.

## Context

A `PendingChoice` was, until M02.5, a question put to exactly one seat with an
answer shaped like a list of entity IDs, and it carried no statement of what it
was for. Two separate problems came out of that.

**Two shipped cards could not be expressed.** `equal_price` asks _each_ player to
choose one of their own Units; `mass_offering` splits a fixed amount of damage
among targets the caster picks. Neither is a single seat picking a set.

**Nothing downstream could tell a gift from a punishment.** A pilot handed a
choice read the **whole source card** and called it hostile if anything on it
was hostile — so a card that removed one Unit and buffed another was hostile for
both of its questions, and the pilot handed the buff picked its own worst Unit.
No match result can show you that defect: the action is legal, the match
finishes, and the number at the end is simply a little wrong.

## Decision

### 1. A plural `chooser` means "each player chooses"

A plural `chooser` on an ordinary target selector asks every seat rather than
one. Three rules make it deterministic and fair:

- seats are asked in the **selector's own order** — controller first, then
  clockwise;
- the selector's `controller` field is read **relative to whoever is being
  asked**, so "a Unit you control" means each seat's own Units;
- **nothing is applied until the last answer is in**, so a later seat decides
  against exactly the board the first seat saw.

That last rule is the multi-seat analogue of ADR 0007's independent blocker
submissions: the order answers arrive over a network must not be able to change
the result.

### 2. A divided amount is answered as a multiset

A `divided` flag on `deal_damage` makes its amount a **total** that one player
splits. The answer is a multiset with one entry per point, and each target takes
its whole share as a **single hit** — so Barrier, Armored and prevention see one
damage event of the right size rather than a stream of ones.

The amount those cards use is a `ValueExpression` member, `previous_targets`,
which counts what the instruction **before it resolved with** rather than what
died this turn. It is a fact about the card's own resolution, so it cannot be
inflated by anything happening elsewhere on the table.

### 3. A choice says why it exists, in structured form

`PendingChoice.provenance` carries the resolution item and effect index that
asked, the asking instruction, the source's controller, how the seat being asked
relates to that controller, whose entities the options are, and — the load-bearing
field — **what selecting one does to the thing selected**.

That valence comes from `EFFECT_INTENTS` in `@tcg/card-data`: `benefit` /
`detriment` / `neutral`, a total mapped type over `EffectType`, so an
unclassified instruction is a compile error and `effectIntentGaps()` says the
same at runtime. Four instructions read a **printed parameter** rather than a
constant, because for those four the number _is_ the direction: a stat
modifier's sign, a cost delta's sign, a search's destination, and a zone move's
**journey** — `move_card … toZone: hand` is recursion out of a discard pile and
a bounce off a battlefield, and those are opposite.

`scoreChoice` now multiplies the instruction's valence by whether the option
belongs to somebody else. That subsumes the hard-coded list of "always costly"
choice reasons: a cost is a detriment aimed at cards the chooser owns, and says
so in its own provenance. The ordered branch uses the same direction, so
reordering an opponent's deck comes out the right way round without a rule of
its own.

Two readings are deliberate:

- **`targetRelation` is read from the seat being asked**, not from the ability's
  controller. That is what makes "a Unit you control" mean each seat's own Units
  inside an `each_player_choice`. Where it cannot be pinned down — an `opponent`
  selector handed to one of those opponents, naming a set that mixes the asked
  seat's cards with a third seat's — it is `any` rather than a guess.
- **Provenance carries no card identity.** `sourceInstanceId` beside it already
  attributes the question, and adding the source's `definitionId` would hand the
  seat being asked the printed identity of a card it may never have been shown.
  A question you are asked is not a card you have seen. This is asserted by name
  in the test suite.

Provenance rides on the `choice_requested` **event** as well as on the choice,
because the choice is gone the moment it is answered and a replay would
otherwise have no record of what was asked.

## Consequences

- `sourceIsHostile` is deleted, not deprecated. It is the function that produced
  the defect in the Context, and leaving it available would invite the next
  reader to use it.
- Four version moves, all refusals: `MATCH_SCHEMA_VERSION` 6 → **7**,
  `PROTOCOL_VERSION` 4 → 5 (the view shape a client validates changed),
  `SPECTATOR_REPLAY_VERSION` 5 → 6, and the three heuristic pilots
  1.0.0 → **1.1.0** — their decision procedure changed, and a record has to be
  traceable to the pilot that produced it.
- `SUPPORT_REGISTRY_VERSION` deliberately did **not** move: no mechanic's support
  level changed, only the reason a question is asked.
- A UI showing a choice can now say what accepting it does without reading the
  source card, which is what lets the same component serve a benefit and a
  detriment without a per-card branch.
- One player-facing wording bug fell out of it and is fixed: `keep_exhausted`
  said "one **enemy** unit", and was wrong whenever the offer was made at its own
  controller's Ready Step.

## Alternatives considered

**Ask each seat in turn and apply as you go.** Simpler, and wrong: the second
seat would be choosing against a board the first seat's choice had already
changed, which makes the same card mean different things depending on seat
order.

**Answer a divided amount as a list of targets with repeats.** Equivalent in
information and worse in execution — it invites dealing the damage one point at
a time, which Barrier and Armored would each see several times.

**Let the pilot infer intent from the card's effect list.** That is exactly what
was there before, and it is wrong for every card that does two things.
