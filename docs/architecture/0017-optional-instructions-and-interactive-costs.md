# 17. Optional instructions, "if you do", and costs a player chooses

Date: 2026-08-11
Status: Accepted
Extends: [0005](0005-rules-engine.md), [0016](0016-precon-wave-1-ruleset.md)

## Context

Five of the eighteen unimplemented Precon Wave 1 cards were blocked on "you may"
(`CLAUDE_RULESET_UPDATE.md` §15). Read together they are not one mechanic but
three, and the difference between them is timing:

| Card                                 | What it actually needs                     |
| ------------------------------------ | ------------------------------------------ |
| `formation_tactician`                | A yes/no on an instruction with no target  |
| `pit_executioner`                    | An optional target, plus "if you do"       |
| `carrion_feeder`                     | An activation cost whose victim you choose |
| `feed_the_pit`, `forbidden_offering` | The same, as an additional cost on a card  |

The last row is the hard one. A cost is paid **before** the thing it pays for is
queued — that is what makes an additional cost survive a counter (CLAUDE.md §4)
— and the resolution queue is the only part of the engine that can pause for a
choice. `planCosts` therefore picked discards and sacrifices deterministically,
which is defensible for a cost where the victim does not matter and materially
wrong for a card whose entire decision is which unit you feed it.

## Decision

### 1. `optional` is a field on the instruction gate, not a wrapper effect

`optional: true` sits beside `condition` on every effect variant. When the
instruction resolves, its controller is asked a `confirm` choice with the new
reason `optional_effect`; "no" skips that step alone and the rest of the card
resolves. Declining is recorded as its own `effect_fizzled` reason, `declined`,
so a log can tell a card that could not act apart from a player who would not.

A wrapper (`{ type: 'maybe', effect: … }`) was rejected for the reason
`condition` was: it would make the effect union recursive, and every reader of
an effect list — engine, help layer, pilots, display-text linter — would have to
learn to walk into it.

Two things follow from `optional` being a real decline:

- **Nobody is asked when there is nothing to act on.** An instruction whose
  target set is empty fizzles as `no_legal_target` without a pause. This is the
  same rule Reaction windows follow: an offer with one possible outcome is a
  pause, not a choice.
- **An optional instruction cannot make a spell unplayable.** `spellHasLegalTargets`
  skips it, exactly as it already skipped a selector marked `optional`.

`optional` on an _instruction_ and `optional` on a _target selector_ are both
kept, and they are not redundant. When the decision **is** which card, the
selector is the better encoding: declining by picking nothing is one interaction
where a confirm plus a target choice is two. `pit_executioner` uses the
selector; `formation_tactician`, whose `ready` points at the unit the trigger was
about, has nothing to decline that way and uses the instruction flag.

### 2. "If you do" reads whether the previous step changed anything

A new condition kind, `previous_step`, true when the instruction immediately
before it emitted at least one event. Recorded on the resolution item as
`previousStepActed`, set by `pumpQueue` from the event-log cursor it already
keeps.

Measuring _events_ rather than the outcome kind is the whole correctness of it.
A declined optional selector still resolves — the engine loops over zero targets
and reports success — so a gate reading `outcome.kind === 'resolved'` would fire
the follow-up on a card the player declined. A step that emitted nothing changed
nothing, and a player reads all three of "I said no", "there was nothing to hit"
and "it was already true" as _you did not_.

It refers to the **immediately preceding** instruction rather than an authored
index. Every "if you do" printed on a card means the sentence before it; an index
would have to be re-validated against four separate effect arrays, and a dangling
one would silently gate an instruction off forever. Authoring it at index 0 is a
schema error rather than a permanently false gate.

### 3. An interactive cost is a paused **action**, not a paused resolution

`planCosts` may now return a `CostSelectionRequest` instead of a plan. The caller
sets a pending choice whose continuation is `cost_selection`, carrying the intent
(`play_card` or `activate_ability`), the answers already given, and which cost
entry is being asked about. Nothing has been spent at that point: the card is
still in hand and the energy is still there.

Answering does not resume anything. It **re-runs the original action** with the
answer supplied. Every check runs again against current state, so an answer that
has stopped being legal is rejected as an ordinary illegal action — and because
`applyAction` abandons its working clone on any error, the pending choice is
still standing afterwards. Resuming halfway would have meant a second, parallel
commit path with its own atomicity argument to get right.

Two consequences worth stating:

- **Nobody is asked when there is one legal answer.** A cost with exactly as
  many candidates as it needs is settled without a pause, as `automatic` is.
- **`selection` defaults to `player_choice` on a sacrifice cost.** No shipped
  card had one before this, so nothing regresses; `automatic` remains available
  for a cost where the victim genuinely does not matter.

`additionalCosts` is a separate field on the card rather than a first
instruction, and the timing is the reason. A first instruction resolves _after_
the Reaction window has closed over the card, so countering a spell would refund
its whole additional cost. Only `unit`, `spell` and `relic` may carry one — the
three types the ordinary play-from-hand path handles. A printed cost the engine
skips would be a card that lies, so the schema rejects it on anything else.

### 4. Provenance

Cost payment is stamped with the card that demanded it (`underCause`), so
telemetry attributes a sacrifice to the card that ate the unit rather than to
nothing. Outright removal (`unit_defeated` with reason `destroyed`) now credits
the source's `unitsRemoved`, restricted to a unit its owner did not control — so
a card that eats one of your own units as a cost is not recorded as having
removed something.

## Consequences

`MATCH_SCHEMA_VERSION` → 6 for `previousStepActed` and the new continuation. No
migration, for the reason v3 gives: match state is never persisted between
processes, and a v5 document should fail validation loudly.

The card schema gains `additionalCosts`, `optional`, and `excludeSource` /
`selection` on the sacrifice cost. All are additive with defaults, so
`CARD_SCHEMA_VERSION` stays at 4 and every existing card parses unchanged.
`optional` is `.optional()` rather than `.default(false)`, matching `condition`
beside it: a rare opt-in on a shape fixtures write by hand, where a default makes
"absent" a type error in every one of them.

Two pre-existing bugs surfaced and are fixed here rather than filed:

- `ritual_butcher` printed "Sacrifice another Unit" and could sacrifice itself;
  it now carries `excludeSource`.
- Only five of the nineteen effect renderers appended their `condition` to the
  generated prose, so fourteen effect types were dropping the "if" from a card's
  explanation. Both gates are now applied once in `explainEffect`.

Still open, and deliberately not decided here: whether a Reaction may carry an
additional cost. Pausing to pick a sacrifice inside a window would interleave a
second choice with priority passing, and no authored card asks for it.
