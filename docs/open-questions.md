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
>
> **Update, 2026-08-08 (Phase 4).** The simulator answered **Q16** (seed
> derivation and worker-independent reproducibility — see ADR 0010). **Q14**
> (balance thresholds) and **Q15** (a healthy plural meta) shipped on explicit,
> configurable, clearly-labelled placeholders rather than being answered, which
> is what CLAUDE.md §18 asks for; the values remain playtest decisions. Two new
> questions: **Q37** (how good do the pilots need to be?) and **Q38** (when is a
> multiplayer balance run worth its cost?).
>
> **⚠ Staleness warning, 2026-08-10.** Several entries below describe a
> codebase that no longer exists, because the Precon Wave 1 ruleset update and
> the readiness gates landed without this file being swept. Specifically: **Q4**
> (`guardian` is now real engine behaviour — only `resilient` is inert), **Q5**
> (Commanders are now deployable; only the post-defeat lifecycle is open),
> **Q19** (30 cards / 2 copies is superseded by 40-card singleton, and the
> format is data rather than a constant), and **Q1, Q2, Q3, Q23, Q25, Q27, Q29**
> in [Answered](#answered), all of which say "not yet implemented" and are now
> implemented. Rewriting them is tracked as item G2 in
> [`REMAINING_WORK.md`](../REMAINING_WORK.md); the new questions the update
> raised are in [its own section](#raised-by-the-precon-wave-1-ruleset-update)
> below — **Q39–Q45, plus sharpened restatements of Q4 and Q5, are waiting on
> your answers.**
>
> **Update, 2026-08-11.** The "you may" tranche of A1 landed (ADR 0017) and
> raised one new question, **Q46** — whether a Reaction may carry an additional
> cost. It blocks nothing: the schema rejects it today rather than accepting it
> and silently not charging it, so the restriction is visible rather than
> latent.

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

Players are now told this directly. Both keywords' entries in `KEYWORD_REGISTRY`
say, in the definition shown in the glossary and the card inspector, that they
currently do nothing and why — rather than describing a plausible rule the game
does not implement. `npm run validate:content` warns on every card printing one;
six bundled cards do. Deciding Q4 means editing the registry entry, the engine
note beside it and the handler, together.

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

## Raised by Phase 4, still open

Phase 4 shipped without answers to these, deliberately: CLAUDE.md §18 says not
to pause on unknown thresholds, but to make them explicit, configurable and
labelled as review guidance. That is what happened. What remains open is the
_values_, and they are playtest decisions rather than engineering ones.

### Q14. What thresholds should actually gate a card change?

**Shipped on a placeholder.** Every threshold lives in one validated
`analysisSettings` block with documented provisional defaults — 30 matches
minimum per card, 20 co-occurrences per pair, 8 win-rate points of inclusion
lift, 6 points of replacement impact, 85% for a polarised matchup, 50% dead in
hand, 2% abnormal terminations. All are overridable per experiment.

The analyser never converts them into a verdict: a flag says
`review_recommended`, `possible_interaction`, `insufficient_data` or
`run_quality`, and carries its reason code, evidence, sample size and interval so
a human can disagree with it on the numbers.

**Still open:** which of these values are right, and whether any of them should
gate a change automatically. Answering it needs runs at real scale against a real
card pool, not a decision now.

**Needed by:** the first time a card is actually changed on simulated evidence.

### Q15. How is "a healthy plural meta" measured?

**Shipped on a placeholder.** Decks are grouped into strategic clusters by a
named, inspectable feature vector — colours, curve bands, type and role mix,
keyword density — using deterministic average-linkage clustering, and the
matchup matrix is reported per cluster. The analyser flags a cluster with no
unfavourable matchup, a cluster with exactly one narrow counter, a polarised
pairing, and a population that has collapsed into one cluster.

**Still open:** how many viable clusters is "plural", and how soft a counter has
to be to count. The tooling reports the shape; nobody has decided what shape is
healthy.

**Narrowed 2026-08-09.** Two of the measurements behind this question were
wrong and have been corrected, which does not answer it but does mean the shape
being reported is now the shape that was asked for. `broad_cross_cluster_inclusion`
counts _clusters_ a card covers rather than the share of decks running it, and
card-level counter breadth requires controlled replacement evidence instead of
being inferred from the cluster matchup matrix — where that evidence is absent
it reports `unavailable`, and the cluster count is kept under its own name
(PHASE4_HARDENING §5 and §10.2).

### Q16. Simulator determinism boundary — **answered 2026-08-08**

Answered by [ADR 0010](architecture/0010-seed-derivation-and-reproducibility.md).
Seeds are hashes of a readable derivation path built only from immutable
identifiers, so a match's seed does not depend on worker count, scheduling or
completion order. Aggregation sorts by a stable `orderKey` before summing, so
floating-point results are identical too. Both are asserted by the test suite and
by the benchmark, which fails if worker counts disagree.

### Q37. Should the pilots be better players than they are?

New. The pilots are transparent heuristics with named weights, and they are not
good: they misvalue large units, and a statline buff at a constant cost can make
a deck measurably _worse_ because the value pilot grows reluctant to trade the
unit it now rates highly.

Every report says results describe what these bots did. But it caps what the
laboratory can conclude — a card that only rewards play the pilots cannot find
will look weak, and a card that punishes their specific mistakes will look
strong. CLAUDE.md §13.1 rules out machine learning for Phase 4, and the telemetry
is deliberately raw enough to support it later.

**Needed by:** the first finding that hinges on a card the pilots plausibly
misplay.

**Partially addressed 2026-08-09.** The cheap partial answer is now executable
rather than manual: `experiments/pilot-robustness.json` and the `robustness`
experiment kind run a bounded common-seed schedule once per named, versioned
perturbation profile and report whether each conclusion is `stable`,
`pilot_sensitive` or `insufficient_evidence`
([ADR 0013](architecture/0013-statistical-contracts.md), PHASE4_HARDENING §10.3).
Profiles are never pooled. The underlying question — whether better pilots would
reach different conclusions — is unchanged: a `stable` label means a finding
survived a specific set of bounded re-weightings, not that it would survive a
competent human.

### Q38. When is a multiplayer balance run worth it?

New. Phase 4 experiments run 1v1. `playerCount` is carried through every
schedule, record, bot observation and analysis path, and the match runner already
seats four, so this is a configuration change rather than a redesign — but
nothing has validated that three- and four-player results say anything useful,
and they cost 2–4× as much per data point.

Related to **Q35** (whether the rule values should differ per player count),
which is still open for the same reason.

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

## Raised by the Precon Wave 1 ruleset update

Found on 2026-08-10 while auditing the code against every root specification
(see [`REMAINING_WORK.md`](../REMAINING_WORK.md)). Each one blocks a specific
item there, and each is genuinely yours to decide — I did not want to bury a
provisional answer as a permanent rule.

Answer them inline underneath each question; nothing is waiting on all of them
at once, so partial answers are useful.

### Q39. What is the final Reaction chaining and ordering policy?

**Blocks:** REMAINING_WORK A2 (Reactions), and 10 cards — `calculated_response`,
`emergency_interposition`, `hold_the_line`, `mass_displacement`, `narrow_denial`,
`orderly_withdrawal`, `phase_withdrawal`, `punish_the_assault`, `scatter`,
`unbreakable_formation`.

Ruleset update §11 confirms Reactions exist in bounded windows and explicitly
leaves the chaining policy open. A minimal versioned policy is already written
down (CLAUDE.md §4): **one window per triggering event, in seat order starting
from the non-active player; each eligible player plays at most one Reaction per
window; a Reaction cannot be responded to; the window closes when everyone has
acted or declined.**

The decision is whether to build that, or something with more depth. The three
options, cheapest first:

1. **The minimal policy above.** No responding to a Reaction at all. Simple,
   bounded, deterministic, and it makes `calculated_response` — which creates a
   pay-or-counter choice for the _spell's_ controller — the only thing resembling
   interaction. Risk: Reactions feel like they cannot be played around.
2. **One counter-response.** The same, plus the original card's controller gets
   exactly one chance to respond to a Reaction aimed at them. Bounded depth of
   two. Costs a nested window and a second choice surface.
3. **Repeat until all pass**, MTG-style but still without a general priority
   system. Genuinely unbounded in principle; needs a loop safeguard and makes the
   UI, the protocol and every pilot substantially harder.

I would build (1) first and treat (2) as an additive change, because the window
machinery is the same and only the closing condition differs. But that shapes how
the cards feel, so it is your call.

**Related, and cheaper to answer at the same time:** in a 3–4 player free-for-all,
does the window run through _every_ living player in clockwise order from the
non-active seat, or only players actually affected by the event?

---

### Q40. Should `cards.json` and `precons.json` be deleted from the repo root?

**Blocks:** nothing. Purely cleanup.

They are verifiably fully migrated into `content/`: all 155 card IDs present, all
four precon lists and Commanders identical, and **zero** drift between
`rulesText` and the migrated `displayText`. Keeping them means two sources of
truth for card text, which is the drift risk `CLAUDE_RULESET_UPDATE.md` §1 warns
about — and the 78 unimplemented cards will be edited in `content/` as they get
built, so the root files will start lying.

Against deleting: they are **untracked in git**, so this is irreversible, and
`CLAUDE_RULESET_UPDATE.md` names them as its accompanying input files.

Options: delete them; move them to `docs/design/` as a dated historical record;
or keep them as-is. I left them alone rather than make an irreversible call.

---

### Q41. Are unimplemented cards visible in the deck builder, and is there a format picker?

**Blocks:** REMAINING_WORK C1 and C2 (the builder shows the wrong pool and has no
precon UI).

78 of the 155 catalog cards are `implemented: false` and `validateDeck` already
refuses a deck containing one. Three things follow that nobody has decided:

1. **Are they shown at all?** Hidden entirely (the builder looks small and
   coherent, but a player wonders where a card from the precon list went), or
   shown and clearly marked "not yet playable" (honest about the prototype's
   state, and useful for you as the designer, but frustrating to a playtester).
2. **Can the player choose a format?** `development` (the 56 fixture cards, 30
   cards, 2 copies) is not a real format — it exists so Phase 1–4 regression
   tests keep working. Should it be visible in the UI at all, or should
   `precon_wave_1` be the only pool a human ever sees?
3. Right now neither is decided _and_ the client is wrong anyway: it loads the
   entire card universe (both sets, 211 cards) rather than a format-scoped pool.
   That gets fixed either way; the question is what it gets fixed _to_.

My recommendation: show unimplemented cards greyed with the reason on hover, and
hide `development` from the UI entirely (tests address it directly).

---

### Q42. What makes two Tokens "identical" for visual stacking?

**Blocks:** REMAINING_WORK C3 (token grouping), and 2 cards —
`containment_pulse`, `total_recall`.

Ruleset update §7 says identical Tokens may be visually stacked while each keeps
individual identity, and §7 also says an effect affects one individual Unit
"unless it explicitly says every Unit in a Token stack". So a stack is
presentation _and_ an addressable group, which means "identical" needs a rule:

- **Same definition only** — three Goblin Tokens stack even if one is damaged,
  one is exhausted and one has +2/+0. Simplest, cleanest board, but the stack
  badge hides real tactical differences.
- **Same definition and same state** — damage, exhaustion, keywords and
  modifiers must all match. Honest, but a stack splits and re-forms constantly
  during combat, which is visually noisy and is the opposite of what grouping is
  for.
- **Same definition, with state shown as sub-badges** — one stack, annotated.
  More UI work.

Whichever you pick also decides what a card that targets "a Token stack" actually
hits.

---

### Q43. What counts as a board stall?

**Blocks:** REMAINING_WORK D2 (unlimited-board telemetry).

Ruleset update §17 requires every match to record "whether the match reached a
board stall" and lists "neither player wants to attack for multiple rounds" as a
failure signal for the unlimited battlefield. It does not define either.

This needs a number, because it is a recorded metric rather than a rule: how many
consecutive rounds with **zero declared attackers** while both players control at
least one ready unit constitutes a stall? Three? Five? And does a round where
someone attacks with a single token break the streak?

Any threshold is defensible; the point is that it must be one explicit,
configurable, versioned number rather than a judgement made in the reporting
layer. Suggest 3 rounds, configurable, unless you have an intuition.

---

### Q44. Do you want multiple blockers per attacker, and if so, when?

**Blocks:** nothing today, but it shapes REMAINING_WORK A3/A6 (the battlefield
and blocking rework), and reworking combat state twice is the expensive outcome.

`blockersPerAttacker` is already a config value defaulting to `1`, and CLAUDE.md
§4 explicitly says to model blocker assignment so multiple blockers can be added
later without rewriting combat state. Ruleset update §18 keeps it open.

The reason it comes up now: A6 flips `exhaustedUnitsMayBlock` to `false` and A3
removes the unit cap, and both touch the same blocker-assignment code. If
multi-blocking is wanted eventually, doing it in the same pass is much cheaper
than a third rewrite. If it is a definite no, the combat state can stay simple.

Not asking you to design it — only "eventually yes", "probably never", or "keep
it open and I will pay for the rewrite later".

---

### Q45. Is Barrier consumed before or after other prevention and reduction?

**Blocks:** part of REMAINING_WORK A1 — specifically the `prevent_damage` work
and `shield_formation`, and it interacts with the existing `armored` reduction.

ADR 0016 Q-D settled Barrier **against Overwhelm** (Overwhelm splits first,
Barrier saves only the blocker's share). It did not settle Barrier against the
other reducers, and the engine currently has `armored` (flat reduction) plus
`prevent_damage` shields.

For a 5-damage hit on a unit with Barrier and Armored 1:

- **Barrier first** — Barrier eats the whole 5, Armored does nothing, unit takes
  0 and has spent its Barrier.
- **Reduction first** — Armored makes it 4, Barrier eats the 4, same visible
  outcome here but different when a shield has a fixed capacity.
- The cases genuinely diverge once a `prevent_damage` shield with a **capped
  amount** exists, which A1 will add.

Ruleset update §9 says a zero-damage event does not consume Barrier, which is the
one piece already fixed: if reduction takes a hit to 0, Barrier must survive.
That leans toward reduction-first. Confirm or overrule.

---

### Q46. May a Reaction carry an additional cost?

**Blocks:** nothing today. Raised by, and deliberately left open in,
[ADR 0017](architecture/0017-optional-instructions-and-interactive-costs.md).

"As an additional cost, sacrifice a Unit" now works on a `unit`, `spell` or
`relic` — the three types the ordinary play-from-hand path handles. The schema
**rejects** it on a `reaction`, rather than accepting it and quietly not
charging it.

The reason is mechanical, not a rules judgement. An additional cost with a real
decision pauses for a selection before the card commits, and a Reaction is
played inside a bounded window where priority is passing clockwise. Two
interleaved pauses — "who has priority" and "which unit do you feed it" — is a
timing interaction nothing in the current window machinery has been designed
against, and no authored Reaction asks for one.

Three ways this could go, in increasing cost:

- **Leave it rejected.** Reaction costs stay pure energy. Costs nothing now.
- **Allow it, non-interactive only.** A Reaction could print a sacrifice cost as
  long as `selection` is `automatic`, so there is never a second pause inside a
  window. Cheap, and honest about why it is restricted.
- **Allow it fully**, which means deciding what happens when a window's priority
  holder is mid-selection and settling whether that selection can be timed out
  independently of the window. Only worth doing if a card wants it.

Answer it when a Reaction is authored that needs one, not before.

---

### Q48. Five Goblin cards say "enters the battlefield" and behave as "when deployed"

**Blocks:** nothing today; the cards work, and every precon is legal. Raised by
the M02.6 entry-trigger review — see
[rules/entry-trigger-review.md](rules/entry-trigger-review.md) for the full
card-by-card record.

`goblin_bomb_thrower`, `goblin_lookout`, `goblin_mob_caller`,
`goblin_recruiter` and `goblin_siege_leader` all print "When this Unit **enters
the battlefield**, …" and are authored as top-level `effects` — the implicit
_deploy_ form. That form runs when the card is played and when a Token is
created, and **not** when a permanent is put onto the battlefield by an effect.
So a `goblin_recruiter` returned by `grave_reassembly` creates no Goblin Token,
which is not what the card says. Confirmed against the engine, not inferred.

Two answers, and they are not equivalent:

- **Fix the prose** to "When deployed". No behaviour changes anywhere; five
  cards stop over-promising. This is what the "structured data is authoritative"
  invariant implies on its own.
- **Fix the structure** to `on_entered_battlefield`. The cards then do what they
  print — and the Goblin deck gains a revival payoff it does not have today,
  which is a gameplay change and therefore outside M02.

The fifteen cards that print "When deployed" and use the same implicit form are
correct as they stand and are **not** part of this question. Nothing was
converted in bulk; whichever answer you give, the structural route still needs a
per-card judgement about whether revival should re-fire each one.

---

### Q4 and Q5 — sharpened, still yours

Both entries above are stale in their wording but still open in substance:

- **Q4** is now only about **`resilient`**: every other keyword is implemented.
  Does it clear marked damage at end of turn, survive lethal damage once, or get
  dropped from the vocabulary entirely? No authored precon card uses it, so
  dropping it is genuinely on the table — ruleset update §18 lists exactly that.
- **Q5** is now specifically the **post-battlefield-defeat** lifecycle, because
  Commanders became deployable. Does a defeated Commander return to the Commander
  zone, and after how long? Is there a replay tax? Can Commander defeat itself
  lose the game? REMAINING_WORK A5 builds the zones and events without answering
  this and isolates the policy behind versioned config, so A5 is not blocked —
  but it cannot be finished without you.

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
