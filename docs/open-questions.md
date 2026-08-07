# Open questions

Things that are **not decided yet** and will block or reshape work if they are
still open when the relevant phase starts. Each entry says what the question is,
what the code assumes today, who or what can answer it, and when it has to be
answered by.

This is the umbrella list. Provisional **game-rule values** — deck size, copy
limits, colour names, keyword behaviour — live in
[rules/open-decisions.md](rules/open-decisions.md) with their current values and
config locations, and are only summarised here.

**Legend for "Needed by":** the phase or milestone that cannot proceed without
an answer. See [project-status.md](project-status.md) for phase definitions.

---

## Blocking Phase 2 (rules engine)

These have to be answered before the effect-resolution queue is written.
Guessing means rewriting it.

### Q1. Do `effects` and `abilities` collapse into one form?

Today both validate. `effects` resolves when a card is played; `abilities` are
`{ trigger, effects }` pairs firing while in play. The `on_deploy` trigger
overlaps with a unit's `effects`, so the same behaviour can be authored two
ways, and the bundled card set uses both.

**Answered by:** whoever builds the resolution queue — this is an engine design
call, not a game-design one. **Needed by:** Milestone 2a, before card data grows
past 56 cards. Detail in
[open-decisions.md](rules/open-decisions.md#card-schema-questions-deferred-to-phase-2)
and [ADR 0002](architecture/0002-card-data-model.md).

### Q2. How are static / continuous abilities expressed?

There is no "while this is in play" trigger. Cost-reduction auras and static
buffs are currently approximated with `on_turn_start`, which is wrong — it will
not recalculate when the board changes mid-turn. Needs either a new trigger, a
separate `staticAbilities` field, or a continuous-effects layer in the engine.

**Needed by:** Milestone 2a. Blocks any aura or lord-style card.

### Q3. Is `sacrifice` a cost or an effect?

Modelled as an effect today. A cost is paid before resolution and cannot be
undone; an effect happens during it. Changes interaction with countering and
targeting. Deferrable while there is no stack, but the engine has to pick one.

**Needed by:** Milestone 2a.

### Q4. What does each keyword actually do?

Eight keywords exist so cards can be authored and filtered; their reminder text
is a statement of intent, not a rules definition. The specific unresolved
interactions (`guardian` and forced blocks, `armored` per-instance vs. per-turn,
`resilient` vs. persistent damage) are listed in
[open-decisions.md](rules/open-decisions.md#keywords).

**Answered by:** game design, then playtesting. **Needed by:** Milestone 2a.

### Q5. How long is Commander recovery, and what happens during it?

CLAUDE.md proposes three turns and explicitly marks it unconfirmed. Beyond the
number: does the Commander return with damage cleared, can the recovery zone be
interacted with, does repeated defeat extend the timer?

**Answered by:** playtesting. **Needed by:** Milestone 2a. Nothing is baked in
anywhere today, so this is cheap to leave open — keep it that way, and make the
number config, not a literal.

### Q6. What are the victory conditions?

"Reduce the opponent to zero" is assumed but never stated in the spec. Is there
a Commander-damage-style alternate win? Deck-out? Draws?

**Needed by:** Milestone 2a (state-based checks and victory detection).

---

## Blocking Phase 2b (multiplayer server)

### Q7. What is the client/server protocol contract?

No message schema exists. Needs: action envelope, state-update envelope,
redaction rules, error shape, and a version-mismatch handshake. CLAUDE.md §14
requires every external boundary validated, so this is a Zod schema in a shared
package — probably a new `packages/protocol`, since putting it in `shared` would
make `shared` non-trivial and it must not go in `card-data`.

**Needed by:** Milestone 2b. Also decides whether `packages/protocol` exists.

### Q8. What is the turn/action timeout policy?

Disconnects, timeouts and version mismatch are listed as things to handle, with
no values. Does a timed-out player auto-pass, auto-concede, or stall?

**Needed by:** Milestone 2b.

### Q9. How long does a match survive a disconnect?

Reconnection tokens are required; the retention window is not specified. Server
memory only, or does this force persistence — which §14 says to avoid
prematurely?

**Needed by:** Milestone 2b.

---

## Blocking Phase 3 (free-for-all)

CLAUDE.md §11 forbids starting Phase 3 until these are documented. None are.

### Q10. Multiplayer combat and targeting

Can attackers from one player be split across multiple opponents in a turn? Can
a third player's units block for someone else (presumably not — needs stating)?
How do "each opponent" effects order their resolution?

### Q11. Priority order for simultaneous triggers

Turn order is stated as explicit, but the rule for whose triggers resolve first
when several fire at once is not. Active-player-first is the conventional
answer; it needs confirming and testing.

### Q12. Elimination semantics

What happens to an eliminated player's board, tokens they created, effects they
control, and cards they took control of? What happens to attacks already
declared against them?

### Q13. Team play — in or out?

§11 says "last remaining player/team, once confirmed". Whether teams exist at
all changes the state model. Answering "no teams in v0.1" is a valid and cheap
answer; leaving it open is not.

---

## Blocking Phase 4 (simulator)

### Q14. What counts as a balance verdict?

§12 lists ~15 metrics but no thresholds and no decision rule. Which metrics
gate a card change, and at what values? Without this the analyzer produces
numbers nobody acts on.

**Needed by:** the balance analyzer, not the pilots — Phase 4 can start without
it.

### Q15. How is "a healthy plural meta" measured?

The stated goal is multiple viable strategies with soft counters and no
dominant deck. Needs an operational definition before it can be reported on.

### Q16. Simulator determinism boundary

Seeded RNG is required, but parallel workers plus a shared seed need a defined
seeding scheme so a run is reproducible regardless of worker count. Decide when
the worker pool is designed, not after.

---

## Not blocking anything yet

Worth recording so they are decided deliberately rather than by accident.

### Q17. Colour identity — names, count, and what each colour does

Five placeholder colours with no pie, no lore, no faction. Renaming is safe and
cheap today. It stops being cheap once card art and player-visible decks exist.
See [open-decisions.md](rules/open-decisions.md#colour-identities).

### Q18. Does creating a coloured token leak colour identity into the creator?

Currently a warning (`card_data/token_color_leak`), not an error. Promote to an
error in `loader.ts` if it becomes a hard rule; the bundled set already
complies.

### Q19. Is 30 cards / 2 copies / 2 colours right?

All configurable via `DEFAULT_DECK_FORMAT`, all unconfirmed, all answerable only
by playtesting. See
[open-decisions.md](rules/open-decisions.md#deck-construction).

### Q20. Should `displayText` be generated from structured effects?

CLAUDE.md §7 says "preferably", and "may be authored manually" during early
development. It is manual today. Generation needs the effect vocabulary frozen
first, so this trails Q1–Q3.

### Q21. Localisation

IDs are already language-independent and display names are already separate, so
the hard part is done. Nothing else is planned. Confirm it is genuinely out of
scope rather than assumed-later.

### Q22. Is 768 × 1024 px the right art size?

The spec's value, marked revisable. Nothing so far suggests changing it. Revisit
only if real art shows a problem.

---

## Answered

Move entries here rather than deleting them, with the answer and the date, so a
decision is not silently re-opened months later.

_(None yet.)_
