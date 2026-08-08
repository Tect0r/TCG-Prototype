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

> **Status, 2026-08-07.** CLAUDE.md §12 and §17 answered fifteen questions:
> Q1–Q3, Q10–Q13 and Q23–Q30. They are in [Answered](#answered) with the
> confirmed rule and the work each one now implies.
>
> **Update, 2026-08-08.** Phase 3 shipped, so those answers are no longer
> "confirmed but not implemented" — the engine implements all of them. Phase 3
> also settled four of the six questions its own specification raised: **Q31**
> (seat order is seeded), **Q32** (`removed` is a real zone; elimination reveals
> nothing), **Q33** (`all_players` is controller-first, then clockwise) and
> **Q36** (host controls the lobby). **Q34** (disconnect fairness at four seats)
> and **Q35** (per-player-count rule values) shipped on their placeholders and
> are still genuinely open.

---

## Blocking further card design

These no longer block the engine — it runs — but they do block authoring more
cards, because a card written against the wrong answer has to be re-authored.

### Q4. What does each keyword actually do?

Still open, and the most consequential item on this list.

**Placeholder:** six of eight keywords have a documented behaviour in the engine;
`guardian` and `resilient` are deliberately **inert** because every candidate
meaning would have been an invention. The full table, with rationale, is in
[open-decisions.md](rules/open-decisions.md#keywords).

Specific things that need deciding:

- What should `guardian` do? Q10's answer narrowed this rather than settling it:
  Phase 3 confirms that units attack **players**, never other units, so
  "must be attacked first" has nothing to attach to in any player count. Any
  meaning for `guardian` therefore has to live on the blocking or damage side —
  for example, forcing an attack on its controller to be blockable only by it,
  or blocking without exhausting.
- Is `armored` per damage instance (current placeholder) or per turn?
- Does `resilient` clear damage at end of turn, or survive lethal damage once?

**Answered by:** game design, then playtesting. Listed in CLAUDE.md §17 as still
open.

### Q5. How long is Commander recovery, and what happens during it?

Unchanged and still cheap to leave open. CLAUDE.md §12 explicitly bars Commander
battlefield deployment and recovery from Phase 3, so this is deferred at least
one more phase: Commanders never enter the battlefield, are never defeated, and
nothing is baked in anywhere.

Worth knowing meanwhile: Commander abilities keyed to `on_attack`, `on_block`,
`on_survive_combat`, `on_deploy`, `on_defeated` or `on_sacrifice` can never fire
today, because a Commander never does those things. Four of the eight bundled
Commanders are affected.

### Q6. Is there an alternate victory condition?

The specified conditions are **implemented**: health at or below zero, drawing
from an empty deck, concession, or a server timeout; simultaneous loss is a
draw. Phase 3 extends this to "last living player wins" and "all remaining
players losing in the same state-based check is a draw" — see Q11.

Still open only as a design question: is there an alternate win condition
(Commander damage, or similar)? Nothing depends on the answer right now, and
CLAUDE.md §17 keeps it on the open list.

---

## Blocking Phase 2B polish

### Q8. What is the turn/action timeout policy?

Partly settled by CLAUDE.md itself: disconnect expiry is a loss, and phase
timers are explicitly deferred. Implemented accordingly — the engine never reads
a clock, and the server submits an explicit `server_timeout` action when the
grace window expires.

**Still open:** whether a Main Phase or choice timer is wanted at all once
playtesting starts, and if so whether it auto-passes or concedes. Phase 3 raises
the cost of getting this wrong, because three other players wait on one stalled
seat — see Q34.

### Q9. Should a match survive a server restart?

The disconnect half is settled. The window is **90 seconds** from
`RulesConfig.disconnectGraceSeconds`, per the spec's provisional value, and
CLAUDE.md §12 confirms that in a free-for-all each seat keeps an independent
token and window and that one disconnect does not stop the match.

**Still open:** whether a match should survive a _server restart_. It currently
does not — lobbies and matches are in memory only, which CLAUDE.md §11 and §12
both explicitly permit. Answering "yes" means persistence, which the same
sections say not to add prematurely. Listed in CLAUDE.md §17 as still open.

---

## Raised by the Phase 3 specification

New questions the free-for-all rules surfaced. None contradict CLAUDE.md §12;
each is a gap that has to be filled by the implementation and is cheaper to
decide before the schema migration than after.

### Q31. How is seat order determined?

CLAUDE.md §12 says seat order is "established at match creation" and is stable
and circular, and §4 says the starting player is chosen with the match's seeded
RNG. It does not say whether the **order itself** is lobby join order or a
seeded shuffle.

The two are meaningfully different with three or four players: in a fixed FFA
turn order the seat immediately after a player is not in the same position as
the seat before them, so join order would hand the host a permanent, choosable
positional advantage.

**Decided (2026-08-08, implemented):** the placeholder was adopted. `createMatch`
shuffles `seatOrder` from the match seed before anything else consumes
randomness, so seat order is reproducible from the seed but not from the join
sequence. A two-seat match is left unshuffled: there is no position to win, and
shuffling would have changed every existing Phase 2 seed.
`preserveSeatOrder: true` opts out, for tests that need a known table. See
[ADR 0007](architecture/0007-free-for-all-state.md).

### Q32. Is `removed` a real zone, and does elimination reveal hidden information?

Elimination step 2 says a non-token card of an eliminated player moves to "a
terminal `removed` zone or equivalent serializable state". Two things follow
that are not stated:

1. Is `removed` a real zone in the schema, alongside deck/hand/battlefield/
   discard/commander/recovery? If it is, no effect may ever look at it, or it
   stops being terminal. If it is not, the cards need somewhere else to be
   counted for replay and log purposes.
2. When a player is eliminated, does their hand and deck order become **public**
   to the survivors, or stay redacted forever? Elimination is the natural moment
   to reveal, and most tabletop games do, but redaction is currently absolute and
   revealing is a deliberate choice with hidden-information tests attached.

Note the reverse direction is already answered: an eliminated player spectates on
the public/redacted view and never sees a survivor's hand.

**Decided (2026-08-08, implemented):**

1. `removed` **is** a real zone — a list on `PlayerState`, alongside deck, hand
   and discard. Nothing reads it: no target selector, no continuous scope and no
   effect can name it, which is what keeps it terminal. It exists so eliminated
   cards have a definite serialisable home for replay and log purposes.
2. Elimination **does not** reveal anything. Redaction stays absolute: a
   defeated player's hand, deck order and `removed` pile are never added to any
   survivor's view. Revealing is the more common tabletop convention, but it is
   a one-way door with hidden-information tests attached, and nothing in Phase 3
   needs it. Revisit if a card ever wants to interact with a dead player's cards.

### Q33. What order does `all_players` resolve in?

The Phase 3 target schema adds `{ kind: "players"; relation: "each_opponent" |
"all_players" }`, but only `each_opponent` has a confirmed order — clockwise from
the seat after the effect's controller. `all_players` has none.

The obvious answer is controller first, then clockwise, which makes
`all_players` equal to "controller, then `each_opponent`" and keeps one ordering
rule. It matters whenever a symmetric effect can kill more than one player, since
ordering decides whether that is a draw or a win.

**Decided (2026-08-08, implemented):** the placeholder was adopted —
`resolvePlayerSelector` returns the controller first, then clockwise, so
`all_players` is exactly "controller, then `each_opponent`" and there is one
ordering rule for every multi-player effect. It resolves as one atomic
instruction, so a symmetric sweep that kills everyone at once is a draw rather
than a race; the engine test for that case uses a test-only `all_players` card,
because no bundled card uses the relation yet.

### Q34. Does the disconnect grace window run while it is not that player's turn?

`disconnectGraceSeconds` is 90 seconds of wall clock. In 1v1 that is nearly
always the disconnected player's own turn, so it is a fair deadline. In a
four-player match a player can be disconnected during three other players' full
turns and be eliminated without the match ever having waited for them.

Options: leave it as wall clock (simple, harsh); pause it while the match is not
waiting on that seat (fair, needs the server to track "waiting on"); or make the
window much longer for larger matches.

Whichever is chosen, the engine must stay clock-free — this is server behaviour
deciding _when_ to submit the explicit timeout action, not engine logic.

**Still open after Phase 3.** Shipped as-is: 90 seconds of wall clock regardless
of player count or whose turn it is. That is the harsh option, and it is
knowingly unfair at four seats. It was not worth guessing at before anyone has
played a four-player match — the fix is a server-side change with no engine or
protocol consequences, so it stays cheap to make later. Related to Q8.

### Q35. Do three- and four-player matches need different rule values?

Every provisional value in `RulesConfig` — 20 health, 5 cards, 1 energy rising to
10, the first player's skipped draw — was chosen for 1v1 and is now going to be
used at three and four seats without change.

The specific worries: 20 health is far less durable when three opponents attack
it; the last seat waits three turns for its first attack but draws three more
cards first; and "the first player skips their first draw" was a two-player
correction that may not be the right compensation shape at four.

**Placeholder:** the same config for every player count, since `RulesConfig` is a
single object and nothing player-count-dependent exists yet.

**Answered by:** playtesting, and later the simulator — CLAUDE.md §13 already
lists first-player advantage as a tracked metric. Worth knowing early whether
`RulesConfig` needs to become per-player-count, because that is a schema shape
decision, not a number.

**Still open after Phase 3.** Shipped with one `RulesConfig` for every player
count, as the placeholder said. Nothing in the engine branches on seat count, so
making the config per-player-count later is an additive schema change rather
than a refactor. Decide before balance work in Phase 4.

### Q36. Who controls the lobby, and can its size change after players join?

CLAUDE.md §12 says the host "chooses or configures the maximum before the match
starts", that a start needs at least two occupied ready seats, and that empty
seats cannot be filled after the start. It leaves three things unstated:

- Can the maximum be lowered after a player has already joined that seat?
- May any ready player start the match, or only the host?
- What happens to the lobby if the host leaves before the start?

All three are lobby-management decisions with no rules consequences, so they are
cheap — but the server needs one answer each, and the UI has to show it.

**Decided (2026-08-08, implemented):** the placeholder was adopted in full — the
host alone changes the maximum and starts the match, the maximum cannot be
lowered below the number of occupied seats, and the host leaving before the
start closes the lobby.

One thing the placeholder did not cover, added during implementation: a **1v1
still starts by itself** the moment both seats are ready, exactly as in Phase
2B, while a three- or four-seat table waits for an explicit `start_match`. The
reason is that "everyone seated is ready" is a legal state at two of four seats,
so auto-starting would rob the host of the choice to wait for the fourth player.

---

## Blocking Phase 4 (simulator)

### Q14. What counts as a balance verdict?

§13 lists ~15 metrics but no thresholds and no decision rule. Which metrics
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
also inspects `activatedAbilities`.

Q1–Q3 are answered, so the blocker has moved: generation now waits on the
vocabulary those answers introduce — static abilities and structured activation
costs — being authored and stable, rather than on the authoring form being
undecided.

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

Entries move here rather than being deleted, with the answer and the date, so a
decision is not silently re-opened months later. "Confirmed, not yet
implemented" means the rule is settled and the code has not caught up — those
are Phase 3 work items, not open questions.

### Q7. What is the client/server protocol contract? — 2026-08-07

Resolved as an engineering decision, not a game-design one. A new
`packages/protocol` holds Zod schemas for every message, imported by both ends;
versions are compared (not negotiated) in the handshake; actions carry a client
action ID for idempotency and the last observed sequence for staleness; the
server sends redacted `PlayerView`s and never authoritative state.

Rationale and alternatives: [ADR 0006](architecture/0006-network-protocol.md).

### Q1. Do `effects` and `abilities` collapse into one form? — 2026-08-07

**No, but deploy behaviour gets one authoring form** (CLAUDE.md §17). Top-level
`effects` stays as spell resolution and as unit/relic deploy resolution.
Triggered `abilities` are kept only for non-deploy event triggers, and every
existing `on_deploy` ability migrates into top-level `effects`.

**Not yet implemented.** Both forms still work today. Needs a card-data migration
plus a schema rule rejecting `on_deploy` in `abilities`.

### Q2. How are static / continuous abilities expressed? — 2026-08-07

**A separate validated `staticAbilities` layer** (CLAUDE.md §17). Continuous
effects are derived from current state, never permanently stamped onto
recipients, and recalculated after every relevant state change.

**Not yet implemented,** and still the largest gap in the engine:
`radiant_bulwark` grants Armored only to units present when it resolves. Do not
author aura or lord cards until the layer exists. ADR required by CLAUDE.md §18
step 2.

### Q3. Is `sacrifice` a cost or an effect? — 2026-08-07

**Either** (CLAUDE.md §17). Activated abilities get a structured, extensible
`costs` array, validated and paid atomically before the ability is queued; a
`sacrifice` instruction inside `effects` remains an effect. See also Q27.

**Not yet implemented:** activation cost is still the single `energyCost` field.

### Q10. Multiplayer combat and targeting — 2026-08-07

Confirmed in CLAUDE.md §12. Each attacking unit independently picks one living
opponent, so attacks may be split across several opponents in one combat; units
never attack other units; a unit may block only an attacker aimed at its own
controller, so third-party blocking is out; each targeted defender submits
blockers privately for its own attacks, and combat resolves as one simultaneous
damage step once every required defender has submitted or declined.
`each_opponent` resolves clockwise from the seat after the controller, atomically
where simultaneous loss matters.

Attacker declarations become `{ attackerId, defenderPlayerId }`. Ordering for
`all_players` was left unstated — tracked as Q33. The consequence for `guardian`
is folded into Q4.

### Q11. Priority order for simultaneous triggers — 2026-08-07

Confirmed and extended: active player first, then **clockwise seat order**, then
source-instance creation order, then trigger index. No player-controlled trigger
ordering and no priority system. The engine's existing rule was the same minus
the seat-order tier, which only exists at three or more players.

Victory follows the same shape: last living player wins, and all remaining
players losing in one state-based check is a draw.

### Q12. Elimination semantics — 2026-08-07

Confirmed as an eight-step cleanup in CLAUDE.md §12: mark eliminated and drop
from turns/choices/combat; remove every card and token they own from every zone
(tokens cease to exist, cards go to a terminal `removed` state); end static,
delayed and queued effects they control; return other players' cards they
controlled to their owners, defaulting to the owner's discard; remove their own
cards even from another player's board; cancel their unresolved choices with a
documented no-selection result or cancel the containing effect; drop attacks
aimed at them before damage, leaving those attackers exhausted and non-
retargeting; then run state-based checks and trigger discovery **once** for the
whole cleanup.

Ownership and control must be explicit in serializable state, never inferred from
which battlefield a card sits on. The zone question and the hidden-information
question this raises are tracked as Q32.

### Q13. Team play — in or out? — 2026-08-07

**Out.** No teams in Phase 3; every player competes independently, and CLAUDE.md
§12 lists teams among the things not to add. The state model stays flat.

### Q23. Should an effect be able to target a player directly? — 2026-08-07

**Yes**, via first-class discriminated target variants in Phase 3 (CLAUDE.md
§12): `entity`, `source`, `player` (`self` | `opponent`, automatic or chosen) and
`players` (`each_opponent` | `all_players`). An `opponent` target resolves to one
explicitly selected living opponent unless the definition says `each_opponent`.
Player references use stable player IDs everywhere — card data, protocol,
choices, legal actions, logs and views — never array positions.

**Not yet implemented.** Unblocks direct burn and drain once it is.

### Q24. Does a sacrificed unit also trigger `on_defeated`? — 2026-08-07

**Yes.** A sacrificed unit counts as defeated and fires both `on_sacrifice` and
`on_defeated`. The defeat event keeps `reason: "sacrificed"` so a future card can
filter on it. This confirms the existing behaviour; nothing changes in the
engine.

### Q25. Must a search find something if a legal card exists? — 2026-08-07

**It depends on the zone.** Searching a **hidden** zone may legally find nothing
even when a valid card exists. Searching a **public** zone is mandatory when a
legal result exists, unless the effect explicitly says `up_to` or `may`.

**Partly implemented:** `search_zone` uses `minimum: 0` for every zone, which is
correct for hidden zones and wrong for public ones.

### Q26. Is player healing capped? — 2026-08-07

**Uncapped**, unless an individual effect explicitly sets a maximum. Confirms the
existing behaviour; the per-effect maximum is a schema addition for later.

### Q27. Is the activated-ability shape right, and should the placeholder ability stay? — 2026-08-07

**Structured `costs`, and the placeholder stays.** Activated abilities take an
extensible `costs` array — energy first, then discard, sacrifice and exhaust —
rather than a lone `energyCost`. The placeholder ability on
`prototype_commander_blue` stays while the prototype set is test data. See Q3.

**Not yet implemented.** Needs a card-data migration from `energyCost` to
`costs`.

### Q28. Should a trigger created mid-card resolve before the rest of that card? — 2026-08-07

**No.** All authored instructions of the current card or effect finish before any
trigger they created resolves. State-based checks still run after every atomic
instruction. Confirms the engine's strict FIFO behaviour exactly; nothing
changes.

### Q29. Confirm the `targetsSource` addition to the target schema — 2026-08-07

**Confirmed, with a shape change.** A source/self target is required. The
`targetsSource: boolean` flag becomes the discriminated `{ kind: "source" }`
variant in the Phase 3 target migration.

**Not yet implemented:** the two affected cards still use the boolean.

### Q30. Is strict stale-revision rejection the behaviour you want? — 2026-08-07

**Yes.** Keep rejecting an action whose `lastSequence` does not match, and resend
the current authoritative player view. Confirms existing server behaviour; the
rule carries into Phase 3 unchanged.
