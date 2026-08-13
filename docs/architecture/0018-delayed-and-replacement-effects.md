# ADR 0018 — Delayed effects, replacements, and the Ready Step

**Status:** accepted · **Date:** 2026-08-13 · **Extends:**
[ADR 0005](0005-rules-engine.md), [ADR 0008](0008-continuous-effects.md),
[ADR 0016](0016-precon-wave-1-ruleset.md)

Recorded in M07.3 for decisions taken and implemented in M02.1, M02.2 and M02.4.

## Context

Nine of the Precon Wave 1 cards could not be executed by anything the engine
had. Read together they asked for two things the resolution queue could not
express, and both of them are about **time** rather than about a new effect:

- "Return it to your hand **at the end of the turn**", and "**when it is
  defeated this turn**, create two Thrall Tokens" — a promise made now that
  something will happen later in the same turn (`fading_wisp`,
  `marked_for_death`);
- "Units your opponents deploy **enter Exhausted**", and "this Unit **does not
  Ready** during its controller's next Ready Step" — a rule that changes an
  event as it happens rather than responding to it.

The second group is the dangerous one. Written as triggered abilities they would
be visibly different cards: "when a Unit is deployed, exhaust it" is a trigger
somebody can answer, it opens a Reaction window, and there is a moment in
between where the Unit is Ready and a `deployed` trigger has already fired
against a board that is about to change. None of that is what the card says.

## Decision

### 1. A delayed effect is state, not a closure

`MatchState.delayedEffects` holds one entry per outstanding promise. A card sets
one up with a `schedule_delayed` instruction naming one of its own
`delayedAbilities` — the ability is authored on the card, so nothing is
constructed at runtime and nothing has to be serialised as a function
(ADR 0005 forbids closures in state, and reconnection is the reason).

An entry is **bound once** — boundary, source instance and definition,
controller, subject and the sequence number of the event that created it — and
is never re-targeted. Four rules decide the awkward cases and **none of them is
keyed to a card ID**:

1. **The boundary is always the turn the entry was made on.** `DELAYED_BOUNDARIES`
   is the single member `end_of_turn`. Nothing survives into a turn belonging to
   somebody else, which is what stops a four-seat table accumulating promises
   from three seats ago.
2. **The subject is bound once.** Whatever "it" meant when the instruction
   resolved is stored as a concrete instance, never re-chosen.
3. **A subject that changes zone ends the entry.** The engine already treats a
   card leaving a zone as shedding what it was — `moveToZone` clears its damage,
   its modifiers and its counters — so a card that has moved is not the object
   the delayed text was about. A revived copy is a different object.
4. **A watch fires from the event, not from the board afterwards.** The defeat a
   `marked_for_death` waits for _is_ a zone change, and rule 3 would otherwise
   cancel the entry on exactly the event that should fire it. The events of a
   settle pass are matched before the pass prunes anything: firing beats
   pruning, always.

Scheduling happens inside ordinary instruction resolution and firing happens at
boundaries the phase machine already drives, so a replay re-derives every entry
from the same action log. Nothing reads a clock.

### 2. A replacement is not a trigger, and the difference is observable

Exactly **two** moments in the ruleset can be rewritten as they happen: an
arrival on a battlefield, and a permanent readying at its controller's Ready
Step. There is no general replacement layer and no third moment.

The standing half is two static-ability effects, `replace_arrival` and
`replace_ready`, both pinned by the schema to `zone: "battlefield"` so a card
cannot rewrite the world from a discard pile. The fixed half is a
`skip_next_ready` instruction that stores its effect **on the permanent**
(`CardInstance.readySkip`) rather than on the card that applied it, because the
applying Spell is usually in a discard pile and the applying blocker is usually
dead before the Ready Step it named.

Four properties make this a replacement rather than a fast trigger, and each is
asserted:

- **Nothing observes the un-rewritten state.** A Unit that arrives Exhausted is
  put onto the battlefield Exhausted; no state-based check, trigger or Reaction
  window sits between the two.
- **No Reaction window opens between them**, because there is no "between".
- **Removing the source afterwards does not undo it.** A rewrite is an event
  that happened, not a modifier that is being maintained.
- **Every rewrite is attributed.** An event names the source instance, its
  definition and the ability ID, so a player and a replay both see which
  permanent did it.

Where several replacements apply they are visited in the engine's **existing**
trigger order — active seat first, then clockwise, then instance creation order,
then ability index — rather than in a new order invented for this layer. Nothing
recurses, because a replacement may only set flags on the object the event is
about: it cannot emit a replaceable event, so there is no loop to bound.

`entersExhausted` on a `move_card` arrival (M02.2) is the card-local relative of
this and is deliberately **not** part of it: it is one instruction's own flag,
legal only on a battlefield arrival, and it is not the replacement layer. What
both share is the rule that readiness on arrival is decided by the **arrival**,
never inherited from the zone the card came from.

### 3. The Ready Step is three fixed stages, and may pause

`turn_start` runs, in this order:

1. **Stored preventions** — a `skip_next_ready` already on a permanent is
   consumed. Free, and already paid for by the card that applied it.
2. **Standing replacements** — each active `replace_ready` is offered in
   replacement order, and one that costs Energy pauses for its controller's
   answer.
3. **Readying** — everything not kept Exhausted becomes Ready.

Stage 1 running before stage 2 is a gameplay decision, not an implementation
detail: a permanent already held down for free is not offered to a replacement
that would charge for the same outcome, so nobody is ever asked to pay for a
no-op.

This makes the Ready Step the one part of turn start that can pause for a
choice, and it pauses only when there is something to decide and a controller
who can pay for it. The resumable state is exactly `keptExhausted` and
`askedSourceIds`, carried through the pending choice rather than recomputed,
because stage 1 is destructive: a consumed `skip_next_ready` is gone, and
re-running stage 1 after a pause would find nothing and ready a permanent that
is meant to stay down.

## Consequences

- Both persisted fields are **defaulted** (`delayedEffects: []`,
  `readySkip: null`), so a match state serialised before either existed still
  parses. `MATCH_SCHEMA_VERSION` did not move for them; it is **7** today and
  moved for other reasons ([ADR 0017](0017-optional-instructions-and-interactive-costs.md),
  [ADR 0021](0021-choice-contract.md)).
- A "will not Ready" is public: `CardInstanceView.willNotReady` is part of every
  seat's view, like `exhausted` beside it, and it is part of the Token grouping
  key — two otherwise identical Tokens that answer the next turn differently do
  not share a tile.
- The layer is bounded by construction rather than by a step budget. A
  replacement pass either asks a source that is then recorded and never
  revisited, or ends.
- Adding a third replaceable moment is a schema change and a decision, not an
  extension point. That is deliberate: the argument above holds because the list
  is two long and every member of it was checked against a card.

## Alternatives considered

**Author the replacements as triggered abilities.** Rejected: it changes the
game. A trigger is answerable, opens a window, and exposes a state the card says
never exists.

**Give a delayed entry a duration and let the continuous layer expire it.**
Rejected. Every `Duration` this engine has expires at a boundary, and the
closest one — `until_your_next_turn` — is cleared _immediately before_ the Ready
Step a `skip_next_ready` has to act on, so the modifier would always be gone one
step too early.

**Let a delayed entry re-resolve its target when it fires.** Rejected: it makes
"return **it** to your hand" mean whatever the board looks like at end of turn,
which is a different card and an unbounded one.
