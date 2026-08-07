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

> **Phase 2A note.** The engine is built and runs complete matches, so several
> questions below now have a **placeholder** behaviour rather than nothing at
> all. A placeholder is not an answer: it was chosen to be the smallest,
> cheapest thing to reverse, and it is recorded in
> [open-decisions.md](rules/open-decisions.md) so nobody mistakes it for a
> confirmed rule.

---

## Blocking further card design

These no longer block the engine — it runs — but they do block authoring more
cards, because a card written against the wrong answer has to be re-authored.

### Q1. Do `effects` and `abilities` collapse into one form?

Still open. `effects` resolves when a card is played; `abilities` are
`{ trigger, effects }` pairs firing while in play. The `on_deploy` trigger
overlaps with a unit's `effects`, so the same behaviour can be authored two
ways, and the bundled set uses both.

**Placeholder:** the engine enqueues a unit's or relic's top-level `effects` on
deploy, immediately before any `on_deploy` ability on the same card. Both forms
work identically today.

**Answered by:** whoever owns card authoring — the engine no longer forces the
answer. **Needed by:** before the card set grows past 56 cards.

### Q2. How are static / continuous abilities expressed?

Still open, and now a visible gap rather than a theoretical one. There is no
continuous-effects layer, so a "your units gain X" card grants X only to units
present when it resolves — `radiant_bulwark` does not buff units that arrive
later, despite what its text implies.

Needs either a new trigger, a separate `staticAbilities` field, or a real
continuous-effects layer in the engine.

**Needed by:** any aura, lord or "while this is in play" card. Do not author one
until this is settled.

### Q3. Is `sacrifice` a cost or an effect?

Still open. Modelled as an effect. With no stack in v0.2 the two readings are
observably identical, so this is cheap to leave open — but it stops being cheap
if reaction-speed cards ever arrive.

### Q4. What does each keyword actually do?

Still open, and the most consequential item on this list.

**Placeholder:** six of eight keywords have a documented behaviour in the engine;
`guardian` and `resilient` are deliberately **inert** because every candidate
meaning would have been an invention. The full table, with rationale, is in
[open-decisions.md](rules/open-decisions.md#keywords).

Specific things that need deciding:

- What should `guardian` do, given that attackers in the current combat model
  target the opposing player and never choose a unit? (See also Q23.)
- Is `armored` per damage instance (current placeholder) or per turn?
- Does `resilient` clear damage at end of turn, or survive lethal damage once?

**Answered by:** game design, then playtesting.

### Q5. How long is Commander recovery, and what happens during it?

Unchanged and still cheap to leave open: Commanders never enter the battlefield
in Phase 2, are never defeated, and nothing is baked in anywhere.

Worth knowing meanwhile: Commander abilities keyed to `on_attack`, `on_block`,
`on_survive_combat`, `on_deploy`, `on_defeated` or `on_sacrifice` can never fire
today, because a Commander never does those things. Four of the eight bundled
Commanders are affected.

### Q6. What are the victory conditions?

**Implemented as specified** in CLAUDE.md §4: health at or below zero, drawing
from an empty deck, concession, or a server timeout; simultaneous loss is a
draw. All are covered by scenario tests.

Still open only as a design question: is there an alternate win condition
(Commander damage, or similar)? Nothing depends on the answer right now.

---

## Raised by the Phase 2 implementation

New questions the build surfaced. None of them block anything today; each one
has a placeholder recorded in
[open-decisions.md](rules/open-decisions.md).

### Q23. Should an effect be able to target a player directly?

It currently **cannot**. A `TargetSelector` always names a zone, so
"deal 3 damage to your opponent" is not expressible in card data at all. No
bundled card needs it, which is why it went unnoticed in Phase 1.

This blocks an entire archetype (direct burn, drain, "each opponent loses N"),
and the fix is a schema change plus a migration of nothing — so it is cheap
now and gets more expensive with every card authored.

**Needed by:** the first card that damages or heals a player directly.

### Q24. Does a sacrificed unit also trigger `on_defeated`?

**Placeholder: yes.** Sacrifice emits `unit_defeated` with
`reason: 'sacrificed'`, and `on_defeated` matches any defeat, so a sacrificed
`unstable_construct` still makes its Scrap tokens.

The other reading — sacrifice is not defeat, so only `on_sacrifice` fires — is
equally defensible and meaningfully different for sacrifice-payoff decks.

### Q25. Must a search find something if a legal card exists?

**Placeholder: no.** `search_zone` presents a choice with a minimum of zero, so
a player may decline to take anything (and may therefore decline to reveal).

Making it mandatory is one line; making it optional-with-a-reveal-penalty is
not. Worth deciding before search cards multiply.

### Q26. Is player healing capped?

**Placeholder: uncapped.** A player can exceed their starting Health. Nothing in
the bundled set can do this yet except `siphon`, which needs damage to have been
dealt first.

### Q27. Is the activated-ability shape right, and should the placeholder ability stay?

CLAUDE.md §10 requires the engine to support "activating a supported Commander
ability", but the Phase 1 card schema had no way to express one — every ability
required a trigger. Phase 2 added `activatedAbilities` with
`{ energyCost, exhaustsSource, usageLimit, timing }`.

Two things need confirming:

1. Is that the right shape? In particular, should an activation cost be able to
   be something other than energy (sacrifice a unit, discard a card)?
2. To exercise the code path against real data, one placeholder ability was
   added to `prototype_commander_blue` ("2 energy, once per turn: draw a card,
   then discard a card"). That is **card design done for testing**, not a
   balance proposal. Keep it, change it, or move it to a test-only card.

### Q28. Should a trigger created mid-card resolve before the rest of that card?

**Placeholder: no.** Strict FIFO — if a card's instructions are `[A, B]` and A
creates a trigger, B resolves before the trigger.

CLAUDE.md §4 says triggers are enqueued "before continuing normal play", which
is ambiguous about whether the rest of the current card counts as normal play.
The current reading is the one that keeps a single queue honest, but it is worth
confirming.

### Q29. Confirm the `targetsSource` addition to the target schema

`bone_harvester` reads "whenever this unit survives combat, **it** gets +1/+0",
but a zone-and-filter selector cannot express "the card this is printed on" —
the existing data would have buffed an arbitrary friendly unit.

`targetsSource: boolean` was added to `TargetSelector`, and the two affected
cards now use it. CLAUDE.md §10 requires a `source` target, so this seems
clearly right, but it is a card-data schema change and should be acknowledged.

### Q30. Is strict stale-revision rejection the behaviour you want?

The server rejects an action whose `lastSequence` does not match the current
match sequence, and resends the current view. In a turn-based game with no
timers this should never fire in normal play, and it closes the window where a
fast click resolves against a board the player never saw.

The alternative is to accept the action anyway and let the engine decide. Say so
if that is preferred.

---

## Blocking Phase 2b polish

### Q7. What is the client/server protocol contract?

**Resolved by implementation** — see the Answered section.

### Q8. What is the turn/action timeout policy?

Partly settled by CLAUDE.md itself: disconnect expiry is a loss, and phase
timers are explicitly deferred. Implemented accordingly — the engine never reads
a clock, and the server submits an explicit `server_timeout` action when the
grace window expires.

**Still open:** whether a Main Phase or choice timer is wanted at all once
playtesting starts, and if so whether it auto-passes or concedes.

### Q9. How long does a match survive a disconnect?

**Placeholder: 90 seconds**, from `RulesConfig.disconnectGraceSeconds`, per the
spec's provisional value.

**Still open:** whether a match should survive a _server restart_. It currently
does not — lobbies and matches are in memory only, which CLAUDE.md §11
explicitly permits for this phase. Answering "yes" means persistence, which the
same section says not to add prematurely.

---

## Blocking Phase 3 (free-for-all)

CLAUDE.md §11 forbids starting Phase 3 until these are documented. None are.

### Q10. Multiplayer combat and targeting

Can attackers from one player be split across multiple opponents in a turn? Can
a third player's units block for someone else (presumably not — needs stating)?
How do "each opponent" effects order their resolution?

Note the engine models blocks as `(attacker, blocker)` pairs and resolves player
selectors through one function, so both are extension points rather than
rewrites. But the rules still have to be written first.

Also relevant to Q4: if attackers gain the ability to target a _unit_, `guardian`
suddenly has an obvious meaning.

### Q11. Priority order for simultaneous triggers

Turn order is stated as explicit, but the rule for whose triggers resolve first
when several fire at once is not. The engine currently orders by active player,
then source creation ordinal, then trigger index — the conventional answer,
implemented and tested, but confirm it is what you want before it becomes load
bearing across four players.

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

The engine side of this is settled: `createMatch` takes a seed string and the
generator state travels inside `MatchState`, so a worker needs nothing but a
seed.

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
development. It is manual today, cross-checked by `lintDisplayText`, which now
also inspects `activatedAbilities`. Generation needs the effect vocabulary
frozen first, so this still trails Q1–Q3.

### Q21. Localisation

IDs are already language-independent and display names are already separate, so
the hard part is done. Nothing else is planned. Confirm it is genuinely out of
scope rather than assumed-later.

Note that the engine keeps prose out of match state entirely: pending choices
carry a `reason` code, and the client turns it into a sentence.

### Q22. Is 768 × 1024 px the right art size?

The spec's value, marked revisable. Nothing so far suggests changing it. Revisit
only if real art shows a problem.

---

## Answered

Move entries here rather than deleting them, with the answer and the date, so a
decision is not silently re-opened months later.

### Q7. What is the client/server protocol contract? — 2026-08-07

Resolved as an engineering decision, not a game-design one. A new
`packages/protocol` holds Zod schemas for every message, imported by both ends;
versions are compared (not negotiated) in the handshake; actions carry a client
action ID for idempotency and the last observed sequence for staleness; the
server sends redacted `PlayerView`s and never authoritative state.

Rationale and alternatives: [ADR 0006](architecture/0006-network-protocol.md).
The remaining behavioural question about staleness is tracked as Q30.
