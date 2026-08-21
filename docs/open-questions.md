# Open questions

Decisions that have **no answer yet**. Each entry says what the question is, what
the code does in the meantime, who or what can answer it, and what it blocks.

Nothing here is a gap in the engine. Where a question has a placeholder, the
placeholder runs and is explicit, configurable and versioned; what is undecided
is the value or the wording, not whether the rule works. Implemented rules whose
value is provisional are in [rules/open-decisions.md](rules/open-decisions.md)
with their config locations; settled rules are in
[rules/confirmed-rules.md](rules/confirmed-rules.md).

The short list `IMPLEMENTATION_PLAN.md` keeps under "Owner decisions still open"
is the subset a tranche may have to **stop** on. Everything else here is open but
not blocking. `npm run audit:status` compares the two lists in both directions
and fails the suite on a disagreement, so this file cannot quietly drift from the
plan.

Answered questions are not deleted. They are compressed into
[Answered](#answered) with the ruling and the date, so a decision is not silently
re-opened months later.

---

## Owner decisions a tranche may stop on

These five are the plan's short list. Each is genuinely a design call rather than
an engineering one. Q47 and Q48 were on it until 2026-08-14, and Q49 and Q50 were
each on it for the length of one tranche on 2026-08-20; all four are now under
[Answered](#answered). Q51 joined it on 2026-08-21, when M09.20 measured a trade
Q50 had assumed was not there.

### Q4. What should `resilient` do, or should it be deleted?

**Open. Everything except the design call is done.**

`resilient` is the only keyword the engine does not execute. The other ten all
work — the full table is in
[open-decisions.md](rules/open-decisions.md#keywords).

Two structural halves are already closed, in both directions:

- **Content.** The mechanic support registry records `resilient` as
  `engine: 'none'`, and the content build derives a card's support by walking its
  structured data against that registry rather than trusting the card's own
  `implemented` flag. A `playtest` or `active` set containing a card built on an
  inert mechanic — printed, or granted by one of its instructions — is a **build
  error**. `dread_sovereign`, in the `prototype_core` development fixture set, is
  the one card that prints it, and the build warns about it there by name.
- **Bots.** `keywordIsValued` reads the same registry, so an `engine: 'none'`
  keyword is worth zero everywhere a keyword is priced: a printed statline, a
  `grant_keyword`, a `remove_keyword`, a continuous grant layer and a
  `replace_arrival`. Before that, a pilot mulliganed toward a card carrying an
  inert keyword and a balance run would have reported the difference as a
  property of the card.

**What is left is yours:** implement it under one of the two readings — clear
marked damage at end of turn, or survive lethal damage once per turn — or delete
it from `KEYWORD_IDS`. The readings differ enormously in power and both interact
directly with "damage persists between turns". No `precon_wave_1` card prints it,
so deleting it is genuinely on the table.

A second, smaller keyword question rides along: is `armored` per damage instance
(the current behaviour) or per turn?

**Answered by:** game design, then playtesting.

---

### Q44. Do you want multiple blockers per attacker, and if so, when?

**Open. Blocks nothing today.**

`blockersPerAttacker` is a config value defaulting to `1`, and blocker assignment
is deliberately modelled so more than one can be added without rewriting combat
state.

It is recorded because reworking combat state twice is the expensive outcome. If
multi-blocking is eventually wanted, doing it in the same pass as another combat
change is much cheaper than a third rewrite. If it is a definite no, combat state
can stay simple.

Not asking for a design — only "eventually yes", "probably never", or "keep it
open and I will pay for the rewrite later".

---

### Q45. Is Barrier consumed before or after other prevention and reduction?

**Open. Blocks the capped `prevent_damage` shield work.**

ADR 0016 Q-D settled Barrier **against Overwhelm**: Overwhelm splits first and
Barrier saves only the blocker's share. It did not settle Barrier against the
other reducers, and the engine has `armored` (flat reduction) plus
`prevent_damage` shields.

For a 5-damage hit on a unit with Barrier and Armored 1:

- **Barrier first** — Barrier eats the whole 5, Armored does nothing, the unit
  takes 0 and has spent its Barrier.
- **Reduction first** — Armored makes it 4, Barrier eats the 4. Same visible
  outcome here, different once a shield has a fixed capacity.

The cases genuinely diverge only when a `prevent_damage` shield with a **capped
amount** exists. One piece is already fixed: a zero-damage event does not consume
Barrier, so if reduction takes a hit to 0 then Barrier must survive. That leans
toward reduction-first, which is also what `damage.ts` does today. Confirm or
overrule.

---

### Q46. May a Reaction carry an additional cost?

**Open. Blocks nothing today.** Raised by, and deliberately left open in,
[ADR 0017](architecture/0017-optional-instructions-and-interactive-costs.md).

"As an additional cost, sacrifice a Unit" works on a `unit`, `spell` or `relic` —
the three types the ordinary play-from-hand path handles. The schema **rejects**
it on a `reaction`, rather than accepting it and quietly not charging it.

The reason is mechanical rather than a rules judgement. An additional cost with a
real decision pauses for a selection before the card commits, and a Reaction is
played inside a bounded window where priority is passing clockwise. Two
interleaved pauses — "who has priority" and "which unit do you feed it" — is a
timing interaction the window machinery was never designed against, and no
authored Reaction asks for one.

Three ways this could go, in increasing cost:

- **Leave it rejected.** Reaction costs stay pure Energy. Costs nothing now.
- **Allow it, non-interactive only.** A Reaction may print a sacrifice cost as
  long as `selection` is `automatic`, so there is never a second pause inside a
  window. Cheap, and honest about why it is restricted.
- **Allow it fully**, which means deciding what happens when a window's priority
  holder is mid-selection, and whether that selection can time out independently
  of the window.

Answer it when a Reaction is authored that needs one, not before.

---

## Design questions, nothing blocked

### Q51. Keep the card-in-hand price, or keep Hard's win rate? — open

**Raised by M09.20, which measured a trade Q50 assumed was not there.** Q50 set
one standard for publishing Hard — close
`containment_control/hold_energy_for_the_counter` — and named no rate, on the
reasoning that a named gap is a thing that can be finished while a threshold
would have to be argued about. M09.20 closed the gap and published Hard, and
found that closing it **costs the profile its measured advantage over Normal**.

Over 384 seeded matches on identical games, Hard seated first and second:

| Profile                                         | Head to head vs Normal |
| ----------------------------------------------- | ---------------------- |
| `hard_tactical` `1.1.0` — no card-in-hand price | 53.9%                  |
| `hard_tactical` `1.2.0` — as shipped            | 50.1%                  |

Three shapes of the charge were built and measured, and every one that closes the
gap gives ground: a precise one that charges only a card's per-turn half reads
42.0%, a flat share of the play score reads 47.9%, and the uniform share that
shipped reads 50.1%. Normal against Normal on the same games is 46.9%/53.1%, so a
profile equal to Normal reads about 50%.

**The question is which the owner wants Hard to be**, and it is a product call
rather than an engineering one:

- **Keep it on** (what M09.20 shipped): every one of the twenty-four calibration
  boards is answered, `hold_energy_for_the_counter` is genuinely closed, and Hard
  is a bot that plays patiently and wins about as often as Normal.
- **Turn it off**: `pricesCardsInHand` becomes `false` in `HARD_TACTICAL_TACTICS`,
  the profile returns to `1.1.0`'s behaviour at a new version, Hard beats Normal
  by about four points, and the calibration board goes back to being a recorded
  open gap.
- **Something else**: a fourth shape of the charge, or a smaller retention that
  narrows the gap without closing it. M09.20 did not go looking for one, because
  tuning a pilot until a fixture and a scoreboard agree is fitting the pilot to
  the scoreboard — the thing that tranche's Stop clause exists to prevent.

Nothing is blocked on the answer: Hard is selectable either way, the reversal is
one boolean and a version, and no schema, message or rule depends on it. It is
recorded here so that the trade is a decision rather than an accident.

### Q6. Is there an alternate victory condition?

The specified conditions are implemented — Health at or below zero, drawing from
an empty deck, concession, server timeout, last living player wins, simultaneous
loss is a draw.

Open only as a design question: should there be an alternate win condition
(Commander damage, or similar)? Nothing depends on the answer.

### Q17. Colour identity — names, count, and what each colour does

Five placeholder colours with no pie, no lore, no faction. Renaming is safe and
cheap today; it stops being cheap once card art and player-visible decks exist.
See [open-decisions.md](rules/open-decisions.md#colour-identities).

### Q18. Does creating a coloured Token leak colour identity into the creator?

A warning (`card_data/token_color_leak`), not an error. Promote it in `loader.ts`
if it becomes a hard rule; the bundled sets already comply.

### Q19. Is 40-card singleton with a two-colour Commander cap right?

**Scoped, not closed.** The owner confirmed on 2026-08-14 that **40 is the
deliberate size for the first playtest and a 50-card target remains for later**,
replacing an earlier project-level decision the repository had never reflected.
What is still open is when 50 arrives and whether the Commander colour cap should
open to three.

Fifty is blocked on content rather than on code. `deck.size` is one field in
`content/formats/precon_wave_1.json`, but each Commander's colour-legal singleton
pool is only 41–42 cards, so 50 needs 8–9 more legal cards per Commander — or a
shared neutral package, or a construction-rule change. The measurement, per
precon, is in
[open-decisions.md](rules/open-decisions.md#40-is-a-scope-decision-not-a-leftover--owner-2026-08-14).

### Q20. Should `displayText` be generated from structured effects?

It is authored manually today and cross-checked by `lintDisplayText` in **both**
directions: prose promising behaviour the card lacks, and behaviour the card
performs that the prose never mentions, with no exemption for hand-written help
text.

The blocker has moved rather than gone. Generation now waits on the vocabulary
being stable enough that generated prose would read better than authored prose —
not on the authoring form being undecided, which it no longer is.

### Q21. Localisation

IDs are language-independent, display names are separate, and the engine keeps
prose out of match state entirely: a pending choice carries a `reason` code and
the client turns it into a sentence. The hard part is done and nothing else is
planned. Confirm it is genuinely out of scope rather than assumed-later.

### Q22. Is 768 × 1024 px the right art size?

The spec's value, marked revisable. Revisit only if real art shows a problem.

---

## Server and operations

### Q8. What is the turn/action timeout policy?

Partly settled: disconnect expiry is a loss, phase timers are deferred, and the
engine never reads a clock — the server submits an explicit `server_timeout`
action when the grace window expires.

**Still open:** whether a Main Phase or choice timer is wanted at all once
playtesting starts, and if so whether it auto-passes or concedes. A larger table
raises the cost of getting this wrong, because three other players wait on one
stalled seat. Related to Q34.

### Q9. Should a match survive a server restart?

It currently does not: lobbies and matches are in memory only, which is
deliberate. Answering "yes" means persistence.

### Q34. Does the disconnect grace window run while it is not that player's turn?

`disconnectGraceSeconds` is 90 seconds of wall clock. In 1v1 that is nearly always
the disconnected player's own turn, so it is a fair deadline. At four seats a
player can be disconnected through three other players' full turns and be
eliminated without the match ever having waited for them.

Shipped as the harsh option — wall clock regardless of player count or whose turn
it is — because guessing before anyone has played a four-player match was not
worth it. The options are to leave it, to pause it while the match is not waiting
on that seat, or to scale it with player count. Whichever is chosen, the engine
stays clock-free: this is the server deciding _when_ to submit the timeout action.

### Q35. Do three- and four-player matches need different rule values?

Every value in `RulesConfig` was chosen for 1v1 and is used unchanged at three and
four seats. The specific worries: 20 Health is far less durable against three
attackers; the last seat waits three turns for its first attack but draws three
more cards first; and "the first player skips their first draw" was a two-player
correction.

Nothing in the engine branches on seat count, so making the config
per-player-count later is an additive schema change rather than a refactor.
Worth deciding before balance work leans on four-seat numbers.

---

## The balance laboratory

Phase 4 shipped these on explicit, configurable, clearly-labelled placeholders
rather than answers, which is what was asked for. What remains open is the
values, and they are playtest decisions rather than engineering ones.

### Q14. What thresholds should actually gate a card change?

Every threshold lives in one validated `analysisSettings` block with documented
provisional defaults, all overridable per experiment — the table is in
[open-decisions.md](rules/open-decisions.md#simulator-analysis-thresholds).

The analyser never converts one into a verdict: a flag says `review_recommended`,
`possible_interaction`, `insufficient_data` or `run_quality`, and carries its
reason code, evidence, sample size and interval so a human can disagree on the
numbers.

**Still open:** which values are right, and whether any of them should gate a
change automatically. Needs runs at real scale against a real card pool.

**Needed by:** the first time a card is actually changed on simulated evidence.

### Q15. How is "a healthy plural meta" measured?

Decks are grouped into strategic clusters by a named, inspectable feature vector
using deterministic average-linkage clustering, and the matchup matrix is reported
per cluster. The analyser flags a cluster with no unfavourable matchup, a cluster
with exactly one narrow counter, a polarised pairing, and a population collapsed
into one cluster.

**Still open:** how many viable clusters is "plural", and how soft a counter has
to be to count. The tooling reports the shape; nobody has decided what shape is
healthy.

Two of the measurements behind it were wrong and were corrected in Phase 4
hardening — `broad_cross_cluster_inclusion` counts _clusters_ a card covers rather
than the share of decks running it, and card-level counter breadth requires
controlled replacement evidence instead of being inferred from the cluster matrix.
That does not answer the question, but the shape being reported is now the shape
that was asked for.

### Q37. Should the pilots be better players than they are?

The pilots are transparent heuristics with named weights, and they are not good.
Every report says so, and since M05.4 it says so structurally: a pilot's **agent
class** decides which evidence claims a run may make, and no pilot in this build
is archetype-aware or human, so archetype-dependent signals are declined by every
run this build can produce rather than reported weakly.

Since M05.6 the question is also **measured** rather than argued. Sixteen
hand-authored calibration fixtures ask one tactical question each; nine are
answered characteristically by all three heuristic pilots, one splits, and six are
answered by none — and the six are recorded as `knownGaps`, in both directions, so
a closed gap fails as loudly as a regression. The clearest is that nothing prices
holding Energy for a window that has not opened, which is why a Reaction deck
cannot be judged by these pilots.

**Still open:** whether to make them better, and how much. `pilot-robustness`
experiments say whether a conclusion survives bounded re-weightings — `stable`,
`pilot_sensitive` or `insufficient_evidence` — but a `stable` label means a
finding survived a specific set of perturbations, not that it would survive a
competent human.

**Needed by:** the first finding that hinges on a card the pilots plausibly
misplay.

### Q38. When is a multiplayer balance run worth it?

Experiments run 1v1. `playerCount` is carried through every schedule, record, bot
observation and analysis path, and the match runner already seats four, so this is
configuration rather than redesign — but nothing has validated that three- and
four-player results say anything useful, and they cost 2–4× as much per data
point. Related to Q35.

---

## Answered

Compressed to the ruling and the date. The reasoning lives in the ADR, the
milestone record or the rules docs each entry names.

### Q1. Do `effects` and `abilities` collapse into one form? — answered 2026-08-07

**No, but deploy behaviour has one authoring form.** Top-level `effects` is spell
resolution _and_ unit/relic deploy resolution; triggered `abilities` are for
non-deploy triggers only. **Implemented:** `on_deploy` is not in the trigger
vocabulary at all, and the v1 → v2 card migration folds old `on_deploy` abilities
into `effects`. ADR 0002.

### Q2. How are static / continuous abilities expressed? — answered 2026-08-07

**A separate validated `staticAbilities` layer**, derived from current state,
never stamped onto recipients, recalculated after every relevant change.
**Implemented** — ADR 0008. Lord-style and aura cards are authorable.

### Q3. Is `sacrifice` a cost or an effect? — answered 2026-08-07

**Either.** A `sacrifice` instruction inside `effects` is an effect; a cost lives
in a structured `costs` array — energy, exhaust-source, discard, sacrifice —
validated and paid atomically before the ability is queued. `energyCost` is gone.
ADR 0017 added the refinements: a sacrifice cost is the payer's choice by default
and pauses **before** anything is spent, `excludeSource` means "another Unit", and
a card may carry its own `additionalCosts` paid before an opponent's Reaction
window opens. **Implemented.**

### Q5. What happens to a Commander after battlefield defeat? — answered 2026-08-13

**It returns immediately to the Command Zone**, by every route — lethal damage,
destruction or sacrifice — and each defeat adds 1 Energy to its future deployment
cost, with the total capped at 10. Losing a Commander is not losing the match.
**Implemented**, and a locked decision in `CLAUDE.md`; the dials are
`commanderCostPerDefeat` and `commanderCostCap`. Recorded here in M07.2 — the
question predated deployable Commanders and had gone stale in place.

### Q7. What is the client/server protocol contract? — answered 2026-08-07

An engineering decision: `packages/protocol` holds Zod schemas for every message,
imported by both ends; versions are compared, not negotiated, in the handshake;
actions carry a client action ID for idempotency and the last observed sequence
for staleness; the server sends redacted `PlayerView`s and never authoritative
state. ADR 0006.

### Q10. Multiplayer combat and targeting — answered 2026-08-07

Each attacker independently picks one living opponent; units never attack units;
a unit blocks only an attacker aimed at its own controller; each targeted defender
submits blockers privately; combat resolves as one simultaneous damage step.
**Implemented.**

### Q11. Priority order for simultaneous triggers — answered 2026-08-07

Active player, then clockwise seat order, then source instance creation order,
then trigger index. No player-controlled ordering and no priority system.
**Implemented.**

### Q12. Elimination semantics — answered 2026-08-07

The eight-step cleanup, run as one unit with state-based checks and trigger
discovery once at the end. Ownership and control are explicit in serialised state,
never inferred from which battlefield a card sits on. **Implemented** — the steps
are listed in [confirmed-rules.md](rules/confirmed-rules.md#damage-defeat-and-elimination).

### Q13. Team play — in or out? — answered 2026-08-07

**Out.** Every player competes independently; the state model stays flat.

### Q16. Simulator determinism boundary — answered 2026-08-08

Seeds are hashes of a readable derivation path built only from immutable
identifiers, so a match's seed does not depend on worker count, scheduling or
completion order; aggregation sorts by a stable `orderKey` before summing.
Asserted by the suite and by a benchmark that fails if worker counts disagree.
ADR 0010.

### Q23. Should an effect be able to target a player directly? — answered 2026-08-07

**Yes**, via discriminated target variants: `entity`, `source`, `player` and
`players`. Player references use stable player IDs everywhere. **Implemented.**

### Q24. Does a sacrificed unit also trigger `on_defeated`? — answered 2026-08-07

**Yes.** Both fire, and the defeat event keeps `reason: "sacrificed"` so a card
can filter on it. **Implemented.**

### Q25. Must a search find something if a legal card exists? — answered 2026-08-07

**It depends on the zone.** A hidden zone may legally find nothing; a public zone
is mandatory when a legal result exists, unless the effect says `up_to` or `may`.
**Implemented** — a look-at-the-top effect counts as public, because the cards were
shown to the chooser.

### Q26. Is player healing capped? — answered 2026-08-07

**Uncapped**, unless an individual effect sets a maximum. **Implemented.**

### Q27. Is the activated-ability shape right? — answered 2026-08-07

**Structured `costs`**, extensible, rather than a lone `energyCost`.
**Implemented**, and shared by all three places a cost is paid: an activation, a
played card's `additionalCosts`, and an activated ability priced inside a pilot's
`cardValue`.

### Q28. Should a trigger created mid-card resolve before the rest of that card? — answered 2026-08-07

**No.** All authored instructions of the current card finish first; state-based
checks still run after every atomic instruction. **Implemented.**

### Q29. Confirm the `targetsSource` addition to the target schema — answered 2026-08-07

**Confirmed, with a shape change:** the boolean became the `{ kind: "source" }`
variant. **Implemented**; the migration converts old data.

### Q30. Is strict stale-revision rejection the behaviour you want? — answered 2026-08-07

**Yes.** An action whose `lastSequence` does not match is rejected and the current
authoritative view is resent. **Implemented.**

### Q31. How is seat order determined? — answered 2026-08-08

**A seeded shuffle**, taken from the match seed before anything else consumes
randomness, so it is reproducible from the seed but not from the join sequence. A
two-seat match is left unshuffled. `preserveSeatOrder: true` opts out for tests.
ADR 0007.

### Q32. Is `removed` a real zone, and does elimination reveal hidden information? — answered 2026-08-08

**Yes, and no.** `removed` is a real zone that nothing can name, target or count,
which is what keeps it terminal. Elimination reveals nothing: redaction stays
absolute. Revisit only if a card wants to interact with a dead player's cards.

### Q33. What order does `all_players` resolve in? — answered 2026-08-08

**Controller first, then clockwise**, so `all_players` is exactly "controller,
then `each_opponent`" and there is one ordering rule. It resolves as one atomic
instruction, so a symmetric sweep that kills everyone at once is a draw rather
than a race.

### Q36. Who controls the lobby, and can its size change after players join? — answered 2026-08-08

The host alone changes the maximum and starts the match; the maximum cannot be
lowered below the number of occupied seats; the host leaving before the start
closes the lobby. A 1v1 still starts by itself once both seats are ready, while a
three- or four-seat table waits for an explicit `start_match` — "everyone seated
is ready" is a legal state at two of four seats, and auto-starting would rob the
host of the choice to wait.

### Q39. What is the Reaction chaining and ordering policy? — answered 2026-08-13

**The minimal bounded policy was built**, and it is versioned rather than
hard-coded: one window per triggering event, opened only if somebody could
legally act; priority to the active player first, then clockwise, offered only to
a player with something legal to play; at most
`reactionsPerPlayerPerWindow` Reaction each; the window closes when everybody
declines in a row; pending cards resolve last in, first out with the spell the
window opened around at the bottom. Recorded in full in
[open-decisions.md](rules/open-decisions.md#reaction-chaining-policy).

One part of the original question was **not** settled by the implementation and
was tracked separately as **Q47**, which is now answered below. The summary above
is the policy as it stood before that: the window now closes when there is nobody
left to offer it to, rather than when everybody declines in a row.

### Q40. Should root `cards.json` and `precons.json` be deleted? — answered 2026-08-13

**Deleted.** M07.6 re-ran the parity check first, and it is what settled it: 155
cards and 4 precons on both sides, every structural field equal — name, type,
colour identity, cost, statline, keywords, collectibility, all three design
labels, every decklist and the format's construction rules — and six cards whose
printed text differed, with the **root copy stale in every one**. It still said
"the enemy Commander" where damage goes to a player, "Destroy the active Relic"
where the vocabulary is Defeat, and "Token stack" where a stack is a drawing
decision. Generated `content/` is the single source of truth and nothing in the
codebase ever opened either file. Both are recoverable from git history, and the
full reading with its reproduction recipe is in
[history/retired-root-documents.md](history/retired-root-documents.md#the-two-root-json-catalogues).

### Q41. Are unimplemented cards visible in the deck builder, and is there a format picker? — answered 2026-08-13

**Shown with the reason, and no picker.** The builder loads exactly one format's
pool — never the bundled universe — and a card that cannot be added says why:
outside the Commander's colour identity, over the copy limit, deck already full,
or `Not playable yet: <reason>` for an unfinished card. `development` is reachable
only through the `VITE_TCG_FORMAT` environment variable, so a human never sees the
fixture format. Since M02.6 every `precon_wave_1` card is implemented, so the
unfinished-card path does not fire in the shipping format — but it is the path
that keeps the next unfinished card honest. Recorded here in M07.2.

### Q42. What makes two Tokens "identical" for visual stacking? — answered 2026-08-13

**Same definition and same state** — chosen against measurement, not intuition.
Two Tokens share a tile only when their controller, definition and entire public
interaction-relevant state match. Across 275 sampled boards from three four-seat
precon matches the strict key drew 631 tiles where definition-only drew 441
(1.43×), and the worst board Wave 1 produces — 117 `goblin_token` on one seat —
came out as two tiles, 64 Newly Deployed and 53 Ready. The permissive key would
have hidden that 64 of them could not attack.

A tile is **not** a targeting unit: `groupByTokenDefinition` still expands a chosen
Token across every Token of the same definition, whatever state it is in.
Implemented in M06.1–M06.3, on both surfaces that draw a battlefield.

### Q47. May a Reaction answer another Reaction? — answered 2026-08-14

**No — the engine was changed to match the product rules.** Raised by M01.4,
written up in M07.2, settled in M07.8.

The engine used to clear `window.passedPlayerIds` when a Reaction was played, so
the round of priority restarted and a player who had already declined was asked
again. `CLAUDE.md` said "no Reaction responds to another Reaction unless a future
explicit counter rule says otherwise". The engine lost.

`handlePlayReaction` no longer clears `passedPlayerIds`. Priority goes round the
table **once**: a play moves priority on exactly as a pass does, a seat that has
answered is never re-offered, and the window closes when there is nobody left to
offer it to. Termination is now bounded by the number of seats rather than by
seats × plays.

This removes the unbounded exchange, not the interaction. Two different seats may
still each spend their one Reaction in the same window, and the pending queue
still drains last in, first out, so an explicit counter played after another
Reaction does answer it — which is exactly the "explicit counter effect" the
product rules carve out. What is gone is passing and then coming back.

**Enforced by** three tests in `packages/rules-engine/src/reactions.test.ts`:
"does not re-offer a seat that already passed, and closes instead (Q47)",
"refuses a second Reaction from the same player in one window", and "resolves the
window last in, first out". The rulebook's Reactions section, the
`reaction_window` glossary entry, `PHASE_DESCRIPTIONS`,
[ADR 0016](architecture/0016-precon-wave-1-ruleset.md) and
[open-decisions.md](rules/open-decisions.md#reaction-chaining-policy) all describe
this one rule.

### Q48. Five Goblin cards say "enters the battlefield" and behave as "when deployed" — answered 2026-08-14

**The prose was corrected; the structure was not.** Raised by the M02.6
entry-trigger review, settled in M07.8. The full card-by-card record is in
[rules/entry-trigger-review.md](rules/entry-trigger-review.md).

`goblin_bomb_thrower`, `goblin_lookout`, `goblin_mob_caller`, `goblin_recruiter`
and `goblin_siege_leader` printed "When this Unit **enters the battlefield**, …"
while being authored as top-level `effects` — the implicit _deploy_ form, which
does not run when a permanent is put onto the battlefield by an effect. All five
now print "When deployed, …", which is what they have always done.

The rationale is deliberately **non-gameplay**: rewording makes five cards honest
and changes nothing a player can observe, where rewiring them to
`on_entered_battlefield` would hand the Goblin deck a revival payoff it does not
have. Returning one with `grave_reassembly` still fires no deploy effect. If the
structural route is ever wanted it remains available, and each card still needs
its own judgement about whether revival should re-fire it.

**Enforced by** `display_text/entry_timing` in `lintDisplayText`: a card whose
prose says it acts when it enters the battlefield while carrying no
`on_entered_battlefield` ability is a warning, and a warning on a `playtest` or
`active` card is a content-build error. The five behaviour contracts in
`contracts-goblin.ts` claim "when it is deployed" and are unchanged otherwise.

### Q50. Is Hard good enough to publish? — answered 2026-08-20, discharged 2026-08-21

**Not yet: close the third strategic gap first.** Raised by M09.15 and put to the
owner by M09.16 with the measurements in front of them — `hard_tactical` at
`1.1.0` closing six of the twenty-four calibration boards Normal misses while
regressing none, 768 seeded matches with no illegal action and no unfinished
match, and Hard beating Normal **52.6%** head to head with the advantage holding
on both sides of the table.

The ruling is that the numbers are not the thing that is missing.
`containment_control/hold_energy_for_the_counter` is still open, and it is open
because the scorer prices a card played at its whole value and a card kept in
hand at nothing — a valuation defect in every decision the pilot makes rather
than a resource rule. Hard is published once that closes, not before, and no
rate was named: the standard is the named gap, which is a thing that can be
finished rather than a threshold that would have to be argued about.

**Implemented** in M09.16 as the smaller of the two moves the question could
have caused. `DIFFICULTY_REGISTRY.hard.plannedIn` moved `M09.16` → `M09.20`,
`difficultySelection('hard')` still threw by name, and `DifficultyDefinition`
still had **no field for a tactical profile** — which is what kept publishing
Hard a decision rather than a status flip a later tranche could make by accident.
`DIFFICULTY_REGISTRY_VERSION` stayed 2, because nothing was added, removed, or
changed status.

**Discharged** in
[M09.20](milestones/M09-play-against-ai.md#m0920--card-in-hand-valuation-and-hards-publication--done-2026-08-21),
on exactly the condition the ruling set. `pricesCardsInHand` closed
`containment_control/hold_energy_for_the_counter` at every style — a play is now
charged what the card would still have been worth in hand, so a body is one turn
of tempo rather than a permanent gain — and Hard was published in the same
change: `status` `planned` → `available`, `behaviorVersion` `1.0.0`, `selection`
`{ kind: 'best' }`, and a new `tactics` field naming `hard_tactical`.
`DIFFICULTY_REGISTRY_VERSION` moves 2 → 3 for the status change and the new
field together. Nothing was rebalanced and no fixture was added to make the gap
close, which was the ruling's other half.

**What the discharge found**, and the reason this ruling has a successor: closing
the gap **costs** the profile its head-to-head advantage over Normal — 53.9%
before the change, 50.1% after, over the same 384 seeded matches. Q50 named no
rate deliberately, so the ruling is satisfied as written; whether the owner wants
that trade is [Q51](#q51-keep-the-card-in-hand-price-or-keep-hards-win-rate--open).

### Q49. Does a Token count as a Unit? — answered 2026-08-20

**Yes, while it is on the battlefield.** Raised by M09.15 and settled the same
day, in the owner's words: _"Tokens count as Units while they are on the
battlefield. Any rule, target, or additional cost that says 'Unit' includes Unit
Tokens unless it explicitly says 'nontoken Unit' or 'Unit card.' A token-only
filter remains token-only."_

The question was blocking because it was not a question about one card. Every
`cardTypes: ['unit']` filter in the catalog — forty-one of them — was reading
`definition.type === 'unit'` and nothing else, so a Thrall could not pay
`forbidden_offering`, a Guard could not be fed to `carrion_feeder`, and
`radiant_bulwark` did not buff the Tokens standing next to it. The
`grave_sacrifice/make_fodder_before_spending_it` calibration fixture asked a
pilot to convert its last body into two Thralls and then spend one, which was a
line no player could take either.

**Implemented** in M09.15 as one correction to `matchesCardFilter`:
`satisfiesCardTypes` widens a `unit` request to cover a battlefield Token, one
way, battlefield-only, and adds nothing else. No card ID appears in the engine,
no card was edited, and the fourteen `['unit', 'token']` filters already in the
catalog go on meaning what they meant. The rule is written up in
[rules/confirmed-rules.md](rules/confirmed-rules.md#tokens), stated to players in
the rulebook's card-types section and in the new `token` glossary entry, and
enforced by `packages/rules-engine/src/token-is-a-unit.test.ts`.

### Q43. What counts as a board stall? — answered 2026-08-12

**The strict reading, threshold three.** A round counts toward a stall only when
every living seat reached its attack step, every one of them could legally have
attacked, and none of them did; three consecutive such rounds is a stall. No
round-1 special case, and any declared attacker — one Token included — breaks the
streak. Implemented in M04.3 as `@tcg/board-telemetry/stall`, versioned by
`STALL_DEFINITION_VERSION` and carried inside every document that states a
verdict, so a verdict never travels without the rule it was judged by.
