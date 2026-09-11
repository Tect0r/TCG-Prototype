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

Q4, Q44, Q45 and Q46 were this short list, and Q51 had joined it on 2026-08-21;
the owner ruled on all five on 2026-09-11. Full rulings are compressed into
[Answered](#answered) below, in the same numeric spots as every other answered
question. Q53 joined the list the same day, when M08.R4's tested groundwork hit
a design gap `AdaptiveConfig` does not close.

### Q53. How do adaptive jobs receive pilot selection and per-match turn limits?

**Open. Blocks M08.R4.**

`runAdaptiveExperiment` (`apps/simulator/src/adaptive/run.ts`) requires
`pilots: readonly PilotSpec[]` and `limits: MatchLimits` — both mandatory. M08.R3
shipped `AdaptiveConfig` (`apps/simulator/src/adaptive/config.ts`) with no field
for either: it carries the search budget, swap policy and Commander policy, but
nothing that names which pilots contest a lineage's matches or how long one
match may run.

M08.R4 needs the real job runner to dispatch an adaptive job to
`runAdaptiveExperiment`, and cannot construct that call without inventing a
policy the owner has not stated. `engine_soak`'s random-pilot defaults are not a
substitute — they answer a smoke-test question, not a balance-search one, and
borrowing them here would silently fix the answer to a product question instead
of asking it.

**What is left is yours:** decide whether pilot selection and the per-match turn
limit are explicit administrator inputs on the adaptive job request, fixed
competent defaults baked into `AdaptiveConfig` or the runner, or another
documented policy — and, if `AdaptiveConfig` grows a field, its schema version
bump belongs to the same decision.

**Answered by:** game design / balance-lab ownership.

---

## Design questions, nothing blocked

**Nothing open in this category as of 2026-09-11.** Q6, Q17, Q18, Q19, Q20, Q21
and Q22 were it; the owner ruled on all seven the same day as the short list
above. See [Answered](#answered).

---

## Server and operations

**Nothing open in this category as of 2026-09-11.** Q8, Q9, Q34 and Q35 were it;
the owner ruled on all four the same day. See [Answered](#answered).

---

## The balance laboratory

Phase 4 shipped these on explicit, configurable, clearly-labelled placeholders
rather than answers, which is what was asked for.

**Nothing open in this category as of 2026-09-11.** Q14, Q15, Q37, Q38 and Q52
were it; the owner ruled on all five the same day. See [Answered](#answered).

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

### Q4. What should `resilient` do, or should it be deleted? — answered 2026-09-11

**Delete it.** No playable card uses `resilient`, and both candidate readings —
clear marked damage at end of turn, or survive lethal damage once per turn — add
complexity that overlaps Barrier rather than filling a gap the game needs. A
precisely named regeneration mechanic can be added later if a real card requires
one. Rides along: keep `armored` **per damage instance**, matching current
behaviour.

**Not yet implemented.** Removing `resilient` from `KEYWORD_IDS` and the mechanic
support registry, and fixing up the `dread_sovereign` `prototype_core` fixture
that prints it, is follow-up work tracked in `IMPLEMENTATION_PLAN.md`.

### Q44. Do you want multiple blockers per attacker, and if so, when? — answered 2026-09-11

**No general multi-blocking.** One blocker per attacker stays the default rule. A
future explicit keyword may permit an exception without changing that default.
`blockersPerAttacker` stays `1`; no code change.

### Q45. Is Barrier consumed before or after other prevention and reduction? — answered 2026-09-11

**Reduction and prevention first, Barrier last.** Barrier is consumed only if
positive damage remains afterward. This matches `damage.ts`'s current behaviour
and is why a hit already reduced to zero leaves Barrier unspent. No code change;
the capped `prevent_damage` shield work this was blocking may proceed under this
ordering.

### Q46. May a Reaction carry an additional cost? — answered 2026-09-11

**No — keep it prohibited.** Reactions use Energy and M10's prepared-payment
model only. An interactive sacrifice or discard cost inside a Reaction window
would create nested timing complexity the owner does not want. The schema's
rejection stands; no code change.

### Q51. Keep the card-in-hand price, or keep Hard's win rate? — answered 2026-09-11

**Keep card-in-hand pricing.** Correct play matters more than preserving Hard's
artificially higher win rate — 53.9% before the fix, 50.1% against Normal after
it, both over the same 384 seeded matches. Improve Hard independently, with new
heuristics, rather than restoring the valuation defect Q50 closed.

### Q6. Is there an alternate victory condition? — answered 2026-09-11

**No**, not for the core format. Health at or below zero, decking, concession and
last-player-standing are sufficient. Add one only for a deliberately designed
future archetype (Commander damage or similar).

### Q17. Colour identity — names, count, and what each colour does — answered 2026-09-11

**Keep five colours plus colourless, with a pie:** White — protection and
coordination; Blue — control and knowledge; Black — sacrifice and recursion; Red
— aggression, swarm and direct damage; Green — growth, large Units, Energy and
Overwhelm. Neutral gets broadly usable but weaker, simpler Spells, Reactions and
Relics.

**Not yet implemented** beyond the ruling itself. Writing this pie into
player-facing lore/flavour text is follow-up content work; colour IDs still
appear only in card data and `COLOR_INFO`, with display names kept separate, so
nothing engine-side changes.

### Q18. Does creating a coloured Token leak colour identity into the creator? — answered 2026-09-11

**Yes — promote it to a hard content error.** An off-identity coloured Token
otherwise bypasses deck identity; a future exception must be explicit. The
bundled sets already comply, so promoting `card_data/token_color_leak` from
warning to error in `loader.ts` is follow-up work expected to have no content
fallout.

### Q19. Is 40-card singleton with a two-colour Commander cap right? — answered 2026-09-11

**Yes, for the first playtest.** Keep 40-card singleton and the two-colour
Commander cap. Move to 50 only once each supported Commander's colour-legal pool
reaches **roughly 65 cards** — not the 41–42 already measured plus the 8–9 that
merely closes raw legality, which the owner judged would leave almost no
meaningful deckbuilding choice at exactly 50. Three-colour decks wait for a
future explicit format/Commander rather than opening the existing cap. Refines
the 2026-08-14 scoping recorded in
[open-decisions.md](rules/open-decisions.md#40-is-a-scope-decision-not-a-leftover--owner-2026-08-14),
and supersedes the "8–9 more cards" figure that had been repeated in
`IMPLEMENTATION_PLAN.md` and `CLAUDE.md`.

### Q20. Should `displayText` be generated from structured effects? — answered 2026-09-11

**No — authored text remains canonical.** Generation may become an
admin-authoring suggestion or preview, but must never silently become the source
of truth. No change from current behaviour.

### Q21. Localisation — answered 2026-09-11

**Out of scope**, explicitly, until the English rules and UI stabilise.
Language-independent IDs stay as they are; revisit before public localisation
work begins.

### Q22. Is 768 × 1024 px the right art size? — answered 2026-09-11

**The contract is the 3:4 aspect ratio, not one fixed resolution.** Keep
768×1024 as the prototype minimum/fallback; prefer 1536×2048 or higher source
art and downscale in the client. Follow-up: restate the asset-pipeline docs as a
ratio contract rather than a fixed size.

### Q8. What is the turn/action timeout policy? — answered 2026-09-11

**Add configurable timers:** approximately 30 seconds for Main Phase and ordinary
choices, 5 seconds for Reactions. A Reaction timeout passes; a Main Phase timeout
ends the phase/turn; an optional-choice timeout declines. One ordinary timeout
must never concede the match.

**Not yet implemented.** Server/engine timer work, tracked alongside Q34 below —
the engine stays clock-free either way; the server decides when to submit the
timeout action.

### Q9. Should a match survive a server restart? — answered 2026-09-11

**Required before public online release; unnecessary for current private
testing.** Recorded as a production gate rather than an unresolved design
question. No action now.

### Q34. Does the disconnect grace window run while it is not that player's turn? — answered 2026-09-11

**No — count grace only while the match is actually waiting on the disconnected
seat.** Pause it during other players' turns; an automatically-skipped Reaction
priority offer does not consume it. The engine stays clock-free: this is server
policy, not an engine rule. Not yet implemented — follow-up server work,
alongside Q8's timers.

### Q35. Do three- and four-player matches need different rule values? — answered 2026-09-11

**Yes — multiplayer needs its own `RulesConfig` profile.** Keep the current 1v1
values for functional tests in the meantime, but label them explicitly unbalanced
at three/four seats and draw no multiplayer balance conclusions until real
3/4-player values are measured. Not yet implemented — additive schema/config
follow-up.

### Q14. What thresholds should actually gate a card change? — answered 2026-09-11

**None automatically.** Thresholds only trigger human review; keep the current
documented defaults as exploratory flags. An actual card change still requires
controlled replacement evidence or repeated simulation plus playtesting. Confirms
existing design; no code change.

### Q15. How is "a healthy plural meta" measured? — answered 2026-09-11

**Initial 1v1 target:** at least three viable clusters, ideally all four intended
archetypes; no cluster above roughly 50% representation; overall cluster win
rates around 45–55%; investigate any matchup outside 35–65%. These remain review
thresholds the analyser reports against, never automatic verdicts.

### Q37. Should the pilots be better players than they are? — answered 2026-09-11

**Improve them iteratively**, driven by failed calibration boards and
disagreement with real-play data. AI results must not claim human-meta validity
until the pilots gain archetype awareness and their known strategic gaps close.

### Q52. Should `pilotSpecSchema`'s overrides stop carrying the generic vector? — answered 2026-09-11

**Fix it before another robustness run.** Override maps must carry no defaults of
their own; ordinary absent-`weights` behaviour must stay byte-identical; bump the
affected provenance/versioning; invalidate and rerun exactly the `robustness`
experiment arms this defect touched — not unrelated experiments. Not yet
implemented — follow-up tracked for the next tranche that runs, reads or cites a
`robustness` experiment.

### Q38. When is a multiplayer balance run worth it? — answered 2026-09-11

**After** a multiplayer rules profile exists (Q35), four-player functional tests
pass, and bots have multiplayer calibration. Keep any multiplayer evidence
completely separate from 1v1 results once it starts.
