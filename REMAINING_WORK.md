# Remaining work

The single list of what is still unbuilt, verified against the code on
**2026-08-10**.

This file replaces two working documents that were deleted when it was written,
`RULESET_UPDATE_PROGRESS.md` and `READINESS_PROGRESS.md`. Everything in them
that was still true is carried below.

Two specification files survive because they describe work that is genuinely
unbuilt and this file only summarises them:

- **`CLAUDE_RULESET_UPDATE.md`** — authoritative for the active milestone
  (Precon Wave 1). The data, format, keyword, battlefield, Relic, blocking and
  duration layers are built, plus the first three tranches of the effect
  vocabulary.
- **`PRE_CARD_AND_AGENT_TESTING_READINESS.md`** — the gate list for trusting
  automated balance findings. Gates A/B1/B4/C1/C2/C4/C5/G are done; B2, C3, E,
  F and H are not.

`CLAUDE.md` remains the project specification. `PHASE4_HARDENING.md` moved to
[`docs/PHASE4_HARDENING.md`](docs/PHASE4_HARDENING.md): every one of its
correctness corrections is implemented and tested (§1.3), so it is no longer an
active work list — but **54 code comments cite it by section number** as the
rationale for the statistical contracts, so deleting it would strand them.

Design questions that must be answered before some of this can be built are in
[`docs/open-questions.md`](docs/open-questions.md), not here. Items below marked
**⚠ blocked on a decision** name the question.

---

## 1. Verified repository state

### 1.1 Verification

`npm run verify` **passes** end to end: `content:check` → `typecheck` → `lint` →
`format:check` → `validate:content` → `test` → `build`.

**860 tests across 53 files.** Production build clean. Run and confirmed on
2026-08-10 after group A (A3, A4, A6, A9 and the first three tranches of A1), not
quoted from an older log. The pre-milestone baseline was 780 in 47.

### 1.2 Content

| Thing                        | Count | Note                                                      |
| ---------------------------- | ----: | --------------------------------------------------------- |
| `precon_wave_1` set cards    |   155 | status `draft`; includes 4 Commanders and 3 Tokens        |
| — fully structured, playable |   122 | executable effects                                        |
| — `implemented: false`       |    33 | each names the exact missing primitive                    |
| `prototype_core` set cards   |    56 | status `development`; Phase 1–4 regression fixtures only  |
| Precons                      |     4 | all 40 cards, all load and validate                       |
| Formats                      |     2 | `precon_wave_1` (40/singleton), `development` (30/2-copy) |

`cards.json` and `precons.json` at the repo root were checked card-by-card
against the generated bundle: **all 155 IDs present, zero `rulesText` drift, all
four precon lists and Commanders identical.** They are fully migrated into
`content/`. They were _not_ deleted — see §5.

### 1.3 What is built and working

Condensed; each line was checked in the code, not taken from a progress note.

**Phases 1–3** — deck builder, deterministic headless engine, authoritative
online 1v1, and 2–4 player free-for-all. Complete and unregressed.

**Phase 4 + hardening** — simulator, four pilots, batch runner, worker-count
equivalence, telemetry, deck generation, evolutionary search, replacement _and_
insertion experiments, baseline-vs-candidate comparison, reporting. Every
`PHASE4_HARDENING.md` correction is present in code:
`analysis/sensitivity.ts` (opponent-field), `analysis/counters.ts` (counter
breadth), `analysis/robustness.ts` (pilot robustness),
`analysis/displacement.ts`, `analysis/paired.ts`, `reference-population.ts`
(immutable reference populations), `reporting/match-store.ts` (resumable
`matches.jsonl`), `playsPerDraw` renamed from the misleading `playRatePerDrawn`.
54 dedicated tests in `hardening-analysis.test.ts` and
`hardening-experiment.test.ts`.

**Readiness gates done** — A1 (real insertion experiments, 18 tests), A3 (Node
pin `24.15.0`, CI workflow, `verify` chain), B4 (`formatCardPool` /
`formatDatabase` split fixtures from the real pool), C1 (per-card sources +
deterministic content build), C2 (`npm run cards:new` + 9 templates), C4
(per-set `status`, `STRICT_SET_STATUSES`), C5 (card patches — including the Zod-4
`.partial()` defaults bug), G1/G2/G3 (frozen environments, `--replay`/`--trace`,
hash separation by meaning).

**Ruleset update done** — the data, format and keyword layer. 40-card singleton
as versioned data; `singleton` as a distinct flag that rejects a duplicate split
across separate deck entries; the content pipeline; all 155 cards imported; all
four precons loading and copying into editable decks (19 tests); `validateDeck`
refusing a deck containing an unimplemented card. Keywords in the engine with 15
deterministic tests: **Rush** (migrated from `swift`, widened to
`Exhaust this source` costs), **Guardian** (real must-block, `mustBlockCount` and
`guardianInstanceIds` published in `LegalActions` and enforced), **Barrier**
(`barrierSpent` on the instance so re-granting works), **Overwhelm** (ADR 0016
Q-D split), **Untargetable by opponents** (in `targeting.ts` only, so
non-targeting effects still reach it), **Newly Deployed** (a stored instance
flag cleared at the controller's Ready Step, never a turn-number comparison).

**Decisions already taken — do not re-litigate.** ADR 0016 records four answers
from the project owner: "the enemy Commander" as a target means the opposing
**player's** Health; `Newly Deployed` lasts until its controller's next Ready
Step; a Newly Deployed Unit **may** block; Overwhelm splits first and Barrier
saves only the blocker. Two further calls were made without asking because they
preserve behaviour rather than invent a rule: a Commander's `cost` is nullable
(`null` = the old zone-only Commander, which the eight `prototype_core`
Commanders still are), and `prototype_core`'s `field_medic` was renamed
`prototype_field_medic` because the authored catalog also defines `field_medic`
and card IDs are globally unique.

> **Known divergence, deliberate.** ADR 0016 Q-D says Overwhelm assigns damage
> equal to the blocker's **current Health**; ruleset update §9 says "remaining
> lethal requirement … account for marked damage". These differ when the blocker
> is already damaged. The owner's answer is what is implemented; the divergence
> is flagged in ADR 0016 and in `combat.ts`.

---

## 2. Work remaining

Ordered by dependency. Items 1–6 are the critical path: nothing downstream is
worth doing first.

### A. Rules engine — the Precon Wave 1 ruleset

#### A1. Effect and trigger vocabulary — **in progress: 45 of 78 cards done**

`CLAUDE_RULESET_UPDATE.md` §15/§16 and readiness gates E1/E2. The foundation
layer is built and the cards it unlocks are authored; the 33 that remain each
name a primitive that is still missing.

**Built (2026-08-10, first tranche).**

- **Event-scoped triggers.** A trigger now names an _event_; an ability's
  `scope` says which occurrences it listens to. That separation is the whole
  point: one `on_defeated` means "when this dies", "when **another** friendly
  Unit dies" and "when any Unit dies" without three trigger IDs. An ability with
  no `scope` keeps exactly the old self-referential meaning, so every card
  authored before this behaves identically. Discovery scans every permanent in
  play **plus the card the event was about** — the second group is what keeps a
  unit's own `on_defeated` firing after it has died.
- **New triggers**: `on_deployed`, `on_tokens_created` (batched — five tokens
  fire it once), `on_survive_combat_as_blocker`, `on_opponent_turn_start`,
  `on_opponent_turn_end`. `combat_survived` gained `asBlocker`, read from the
  combat before it is cleared.
- **Conditions**, on an ability (gating the trigger) and on any individual
  instruction (gating that step). Re-checked when the thing they guard would
  happen, never cached. Three kinds: a count comparison, `source_state` ("if
  this Unit is Ready"), and `active_turn` ("during your turn").
- **Computed values.** `amount`, `attack` and `health` accept a count of the
  board as well as a printed number. `per` divides and rounds **down**, so "for
  every three other Goblins" is worth one at four Goblins.
- **One `CountQuery` for all three**, because conditions, values and counts are
  the same question asked three ways. Subjects: units, attacking units, blocking
  units, cards in hand, and four `*_this_turn` histories.
- **Turn history.** `state.turnEvents` records defeats, sacrifices, deployments
  and token creations, derived from the emitted event stream in `context.ts#emit`
  rather than written at each call site — there are four ways a unit can be
  defeated and one of them is a state-based check, so a hand-maintained tally
  would drift from the log a replay produces. Cleared at every turn start.
- **Throttling.** `limit: 'each_turn'`, recorded in the instance's counters so it
  is per-copy and survives serialisation. Deliberately **no `each_round`**: the
  engine has no round bookkeeping, and the only card that wants one is blocked on
  Reactions anyway.
- **`trigger_subject` target** — "the first Guardian you deploy each turn gains
  Barrier" points at the unit that arrived, which is neither the source nor
  anything a player chooses.
- **Filter predicates**: `newlyDeployed`, `attacking`, `blocking`. The combat
  ones fail closed when the caller cannot supply combat state, so an
  out-of-combat query never silently matches everything.
- **`excludeSelfCaused`** on a scope, so a token multiplier cannot feed itself
  until the resolution-step safeguard kills the match.

Shipped across the E3 contract, not just the engine: prose for counts,
conditions and values (`help-content/src/explain/values.ts`) used by every effect
renderer; registry entries for the five new triggers; pilot valuation that
estimates a board-derived amount rather than reading it as zero, and discounts a
gated instruction; a display-text linter that no longer reports a sacrifice
_trigger_ as a missing sacrifice _effect_; 15 engine tests, 2 explanation tests,
3 pilot-valuation tests.

**Built (2026-08-10, second tranche).**

- **Zone inspection** — "look at the top N cards", as `fromTop` and `remainder`
  on the existing `search_zone` rather than a second effect type: the decision a
  player makes is identical, and only the size of the set they were shown
  differs. `remainder: 'bottom'` suppresses the post-search shuffle, because a
  full-zone search shuffles to hide a zone it rummaged through and a
  look-at-the-top effect **told** the player what is on the bottom. The engine
  also treats `fromTop` as making the search public, so a card without "may"
  cannot be declined — and the help layer now says the same thing, which it did
  not at first.
- **Two duration boundaries** — `end_of_combat` and `until_your_next_turn`.
  `expireModifiers` became one function over a set of durations rather than
  three near-identical ones, because each of them must be followed by a
  state-based check: losing a Health bonus can be lethal, and both boundaries
  have a test for exactly that. `until_your_next_turn` is cleared **only for the
  player whose turn is starting**, which is what makes it outlast the opponents'
  turns in between; the end-of-combat boundary sits after the survive-combat
  triggers, so a trick that is the reason a unit survived is still visible to
  them.
- **`anyOf` card filters** — one level of alternation, deliberately not
  recursive. An alternative is an AND, the list is the OR, and predicates
  alongside `anyOf` still apply; all three are pinned, because reading `anyOf`
  as an escape hatch from its siblings would make "a Goblin unit or a Relic
  unit" silently mean "anything".

Also fixed on the way, both cases of the help layer quietly understating a card:
`filterPhrases` dropped the `newlyDeployed`, `attacking` and `blocking`
predicates entirely — `sound_the_warhorn` had shipped with a generated sentence
that promised more units than it buffs — and the look-at-the-top sentence read
"You … takes". 11 new tests: 5 in `durations.test.ts`, 3 for `anyOf` in
`vocabulary.test.ts`, 3 in `explain.test.ts`.

**14 further cards authored**: the nine zone-inspection cards (`blood_scribe`,
`book_of_the_dead`, `field_analyst`, `goblin_lookout`, `laboratory_familiar`,
`observation_lens`, `patrol_scout`, `probe_the_future`, `quick_study`), plus
`search_the_scrapheap` and `tactical_assessment` (`anyOf`), `shield_formation`
(`until_your_next_turn`), and `spear_guard` and `vigilant_squire`
(`on_block` + `end_of_combat`).

**Built (2026-08-10, third tranche).**

- **"Survived combat as a blocker"**, in the two windows the catalog asks for,
  both written from the same `combat_survived` event so they cannot disagree
  about what happened — only about the window they describe. The per-turn list
  `turnEvents.survivedAsBlocker` answers "…that turn"; the `survivedAsBlocker`
  flag on the instance answers "…since your previous turn" and is cleared at the
  end of its controller's **own** turn, not at their Ready Step, so the
  `on_turn_start` cards that read it still have something to see. Nothing can be
  added during your own turn either way: blocking only happens on the turn of
  whoever declared the attack. Reaching for one record instead of two would make
  `watchtower` fire on a turn nothing happened, which is the three-seat test.
  Shipped as a `survivedAsBlocker` card-filter predicate, a
  `units_survived_as_blocker_this_turn` count subject, and
  `MATCH_SCHEMA_VERSION` → 4 (no migration, for the reason v3 gives).
- `freshTurnEvents()` replaced three hand-written copies of the same literal —
  adding one list to the shape broke each of them separately.

**Also fixed: the generated explanation was materially wrong for every scoped or
throttled ability.** The triggered-ability title was the trigger registry's bare
`clause`, which hard-codes "this unit", so `cruel_preacher` — "whenever
**another friendly** Unit is defeated **during your turn**" — rendered as "When
this unit is defeated", a different and much worse card. Scope, `limit` and the
ability-level `condition` are all in the title now, and `limit` is exposed
structurally as well so a UI need not parse prose. In the same pass, the count
describer's two hand-written `if` chains became one total
`Record<keyof CardFilter, …>`: between them they had been dropping `cardTypes`,
`unique`, `newlyDeployed`, `attacking`, `blocking`, `anyOf` and half of every
numeric range, so `stand_united` read as counting _every_ unit you control.

**5 further cards authored**: `living_bulwark` and `retaliating_guard` (the
existing `on_survive_combat_as_blocker` trigger, which nothing had used),
`counteroffensive_captain` and `stand_united` (the durable flag), and
`watchtower` (the per-turn list). 10 new tests in `survived-as-blocker.test.ts`
and `explain.test.ts`. `formation_tactician` is the sixth card of that group and
is **not** done: it needs an optional "you may" instruction, so it has moved to
that row of the table.

**26 cards authored** in the first tranche: `bone_harvest`, `cruel_preacher`, `fortress_gate`,
`goblin_banner_thief`, `goblin_breeder`, `goblin_drummer`,
`goblin_raid_standard`, `grave_prophet`, `rebuild_the_mob`, `soul_collector`,
`banner_keeper`, `bastion_armory`, `bone_altar`, `death_witness`, `field_medic`,
`goblin_scrapmaster`, `goblin_war_drum`, `mourning_keeper`, `soul_furnace`,
`goblin_horde_breaker`, `goblin_piledriver`, `goblin_warboss`, `mob_justice`,
`sound_the_warhorn`, `goblin_tallykeeper`, plus `dismantle_the_device` from A4.

`rebuild_the_mob` is worth recording as a pattern: "create five, or seven if you
controlled no Goblins" is authored as two mutually exclusive gated instructions
rather than a "replace the amount" primitive. Exactly one ever resolves, because
the first either creates five Goblins or creates nothing, and that decides the
second's condition.

**Still missing, 33 cards.** Regenerated from the content bundle so it cannot
drift:

| Cards | Missing primitive                                                   | Card IDs                                                                                                                                                                                                    |
| ----: | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    10 | Reaction timing windows + the **counter** primitive (§11) — see A2  | `calculated_response`, `emergency_interposition`, `hold_the_line`, `mass_displacement`, `narrow_denial`, `orderly_withdrawal`, `phase_withdrawal`, `punish_the_assault`, `scatter`, `unbreakable_formation` |
|     5 | **replacement effects** (enters Exhausted / prevent a Ready) (§15)  | `containment_array`, `goblin_warhorn_captain`, `stasis_keeper`, `stasis_seal`, `temporal_anchor`                                                                                                            |
|     5 | optional "you may" instructions, with and without a cost (§15)      | `carrion_feeder`, `feed_the_pit`, `forbidden_offering`, `formation_tactician`, `pit_executioner`                                                                                                            |
|     2 | Reaction cards plus the cost-reduction floor (§5, §11) — see A2/A8  | `chief_containment_scholar`, `nullmage_apprentice`                                                                                                                                                          |
|     2 | Token-stack **group targeting** (§7) — ⚠ blocked on Q42             | `containment_pulse`, `total_recall`                                                                                                                                                                         |
|     2 | delayed end-of-turn effects (§15)                                   | `fading_wisp`, `marked_for_death`                                                                                                                                                                           |
|     1 | a value derived from the target's own statline (§15)                | `bastion_commander` — the "for that combat" half it also needed now exists                                                                                                                                  |
|     1 | remove-from-game zone transition (§15)                              | `corpse_stitcher`                                                                                                                                                                                           |
|     1 | "each player chooses" simultaneous selection (§16)                  | `equal_price`                                                                                                                                                                                               |
|     1 | a target spanning Units and players in one selection (§16)          | `goblin_powder_runner` — "the enemy Commander" resolves to the opposing player per ADR 0016 Q-A                                                                                                             |
|     1 | returning a card from discard **directly to the battlefield** (§15) | `grave_reassembly`                                                                                                                                                                                          |
|     1 | "divide N damage among targets" selection (§16)                     | `mass_offering`                                                                                                                                                                                             |
|     1 | a cost reduction computed from board state, applied in hand (§15)   | `stitched_abomination`                                                                                                                                                                                      |

Every new mechanic must ship the full readiness gate E3 contract, not just the
engine half: schema + migration, engine resolution, legal-action/choice
representation, protocol and redacted-view safety, UI interaction, player-facing
registry and generated explanation, pilot valuation, telemetry attribution,
simulator provenance/hash support, rules tests, explanation tests, pilot
decision tests, telemetry reconciliation tests, glossary update, authoring
template.

#### A2. Reactions and bounded timing windows

Ruleset update §11. The card type and the window vocabulary **exist in the
schema** — `CARD_TYPES` includes `reaction` and `REACTION_WINDOWS` lists
`after_attackers_declared`, `before_blockers_declared`,
`after_blockers_declared`, `after_combat_damage`, `after_combat`,
`when_opponent_plays_spell`
(`packages/card-data/src/schema/primitives.ts:57,65`).

The engine has none of it. `MATCH_PHASES`
(`packages/rules-engine/src/schema/primitives.ts:34`) is still
`setup, mulligan, turn_start, draw, main_1, declare_attackers, assign_blockers,
resolve_combat, main_2, turn_end, complete` — no Reaction windows. No Reaction is
playable, and the counter primitive does not exist. Countering must mean the card
has no effect and moves to its owner's discard; a countered permanent never
enters the battlefield.

The chaining policy is deliberately minimal, versioned and replaceable: one
window per triggering event, in seat order starting from the non-active player;
each eligible player plays at most one Reaction per window; a Reaction cannot be
responded to; the window closes when everyone has acted or declined. **⚠ The
final policy is an open decision — see Q39.**

#### A3. Unlimited battlefield — **done (2026-08-10)**

Ruleset update §7, ADR 0016 §2. The cap was removed, not raised, and nothing
replaced it.

What changed:

- **Config** — `unitSlots` is gone from `RulesConfig` entirely, with a comment
  at the empty spot saying why it must not come back. `RULES_VERSION` → `0.3.0`.
- **State** — `PlayerState.units` is a dense `InstanceId[]` in arrival order;
  `CardInstance.slot` is deleted. "Is this a unit or a relic on the
  battlefield?" is answered by `derive.ts#isUnitInPlay`, which reads the
  controller's `units` list, so there is no second source of truth to drift.
  `MATCH_SCHEMA_VERSION` → 3, deliberately with no v2→v3 migration function:
  match state is never persisted between processes, so a v2 document should
  fail validation loudly rather than be reinterpreted.
- **Zones** — `moveToZone` takes `row: 'units' | 'relics'`, defaulted from the
  card type, instead of inferring the row from whether a slot was passed.
  `detach` splices rather than nulling, so the list stays dense.
- **Tokens** — every requested token is created. The `token_creation_failed`
  event and the `no_free_slot` / `slot_occupied` engine error codes are removed
  from their unions, so a cap cannot creep back without a schema change.
- **Protocol** — `play_card` no longer carries `slot`, and `LegalActions`
  no longer carries `freeSlots`. `PROTOCOL_VERSION` → 3.
- **Choice vocabulary** — the `unit_slot` choice reason is gone.
- **Bots** — `candidates.ts`, `random-legal.ts`, `validate.ts` no longer choose
  or check a slot. Removing the `pick(freeSlots)` draw shifted every pilot RNG
  stream, which is why one seeded telemetry probe had to be rebuilt (below).
- **Help content** — the `unit_slot` glossary term is deleted; the battlefield,
  relic-zone, card-type and playing-cards text no longer promises a limit;
  `PublicCardContext.viewerFreeUnitSlots` became `viewerUnitCount` and the
  "your battlefield is full" message is gone.
- **Web client** — the unit row is `repeat(auto-fill, minmax(5.5rem, 1fr))`
  rather than a fixed five columns, and rows are keyed by instance ID.
- **Simulator** — `#capacityBlocked` answers for relics only; a unit can no
  longer be reported as blocked by a full board.

Retargeted rather than deleted, per CLAUDE.md §10: scenario 3's "refuses a unit
when every slot is occupied" is now "never refuses a unit for want of room"
(40-wide board) plus a new "the unit list stays dense after a defeat";
scenario 10's "silently fails to create a token when the battlefield is full" is
now "still creates a token on a board that would once have been full".

One simulator test was rebuilt, not re-tuned. `telemetry.test.ts`'s "credits a
triggered ability to its source even after the source dies" searched seeds until
a `powder_keg_runner` happened to die; the pilot RNG shift moved that past its
bound. It now constructs the situation with a 0/1 Guardian fixture — Guardian's
must-block is an engine rule, not a pilot preference — and fires on the first
seed.

Still open and tracked elsewhere: **C3** (token visual grouping) and **D2**
(unlimited-board telemetry) are the two things that make a wide board legible
and judgeable. Neither is engine work.

#### A4. One active Relic — **done (2026-08-10)**

Ruleset update §12, ADR 0016 §3.

- `relicSlots` is `1`. It stays a dial rather than becoming a constant, because
  "how many relics" is a playtest question; `0` still means relics cannot be
  played at all, which is the only case `engine/relic_limit` now covers.
- `engine.ts#replaceActiveRelics` moves the surplus relic(s) to the owner's
  discard **silently** and emits `relic_replaced` naming both the relic that
  left and the one arriving. Because the move is silent, no `unit_defeated` is
  emitted, so `on_defeated` and `on_sacrifice` cannot fire — pinned by a fixture
  relic carrying _both_ triggers.
- Written as a loop over "however many are one too many", so raising
  `relicSlots` stays a config change. Oldest goes first.
- `legalActions` offers a relic while one is out: it is a trade, not a refusal.

**No `active_relic` target primitive was added, deliberately.** "The active
Relic" is a well-defined phrase only because a player controls at most one, and
a battlefield selector filtered to `cardTypes: ['relic']` _is_ that relic —
relics were already targetable and `destroy` already worked on them. A second
way to say the same thing would give the one-relic rule two places to drift.
§12's real requirement, that an effect reaching either player's relic states the
controller, is met by stating `controller` explicitly on the selector.
`dismantle_the_device` is authored that way (`controller: "any"`, so the caster
chooses) and is no longer `implemented: false` — 77 → 78 playable cards.

Also shipped: `timesReplaced` on card telemetry and `relicsReplaced` on seat
telemetry (`TELEMETRY_SCHEMA_VERSION` → 3), kept separate from `timesDefeated`
and `timesDiscarded` so a replaced relic never reads as one an opponent
answered; the pilot prices the trade (`heuristic.ts#replacedRelicCost`), so it
will not overwrite a strong relic with a weak one; glossary, rulebook and
generated card notes say the replaced relic is not destroyed; the match log
renders `relic_replaced`; and `#capacityBlocked` no longer reports a relic at
the limit as blocked, because it is not.

#### A5. Deployable Commanders

Ruleset update §10. The schema accepts a Commander `cost`; the engine cannot play
one onto the battlefield. Playing a Commander pays its printed cost, moves it
from the Commander zone to the battlefield, and marks it Newly Deployed. A
deployed Commander behaves as a Unit for ready/exhaust, combat, targeting,
damage and activated-ability costs unless a rule explicitly excludes Commanders.

**Do not invent the defeat/recovery policy.** Model the zones and events cleanly
and isolate the policy behind versioned configuration. ⚠ Still open — Q5.

#### A6. Exhausted Units must not block — **done (2026-08-10)**

Ruleset update §8/§9, both halves.

- `exhaustedUnitsMayBlock` now defaults to `false`. It stays a dial, because the
  blocking economy is a loud playtest lever worth being able to measure; the
  dial governs only _who may be declared_.
- **Declaring a blocker exhausts it** was not implemented at all and now is, in
  `flow.ts#finalizeBlockers`. Unconditional, because it is a confirmed rule
  rather than a number.
- It happens when the merged block list becomes **public**, not when each
  defender submits. `exhausted` is visible in every seat's view, so exhausting
  on submission would have told the attacker and the other defenders exactly who
  had been committed while submissions are still meant to be hidden. There is a
  three-seat test for precisely that leak.
- The defensive pilot now charges `readyBlockerValue` for each blocker that
  survives, so blocking is no longer free tempo (a dying blocker was already
  priced by `blockTradeLoss`).

Worth recording: flipping the default broke **nothing**. The prediction that it
would move every combat fixture was wrong — not because the change is small, but
because nothing was pinning either half of the rule. `blocking.test.ts` (7 tests)
exists as much to stop the old behaviour drifting back as to prove the new one.

#### A7. Energy carryover needs a test

Ruleset update §5. Unspent Energy must survive opponents' turns so it can pay for
Reactions, then be _replaced_ — not topped up — by the normal refill. The engine
already behaves this way by omission: `flow.ts` only refills at the controller's
own turn start and nothing zeroes Energy at turn end. **No test pins it.** Add
the test alongside A2, when it first becomes observable.

#### A8. Cost-reduction floor, and costs paid on counter

Ruleset update §5. Reductions must not take a cost below its printed minimum
(normally 1 where one is specified), and additional costs such as sacrifice are
paid even when the effect is later countered. Both become reachable only once
cost reduction and countering exist — i.e. after A1 and A2.

#### A9. `while_source_present` — readiness gate B1 — **done (2026-08-10)**

The duration was in `DURATIONS`, and `explain/effects.ts` promised players it
lasted "for as long as the source remains in play", but nothing expired it — so
it meant `permanent`. It does what it says now.

- `damageShieldSchema` gained `sourceInstanceId`, so all four instance-level
  modifier lists plus the per-player cost modifiers can answer "who granted
  me?". `prevent_damage` passes the resolving item's source through.
- `state-based.ts#expireSourceBoundModifiers` runs at the **top of the
  state-based check loop**, before `recalculateContinuous`, and returns whether
  it removed anything so the loop keeps going. That is what makes losing a
  Health bonus lethal in the _same_ stabilisation rather than a step later —
  pinned by a test where a damaged 3/4 becomes a dead 1/1 the instant its relic
  is discarded.
- "Present" means the source instance exists and is on the battlefield or in
  the Commander zone. A modifier with `sourceInstanceId: null` was applied by
  the engine, not a card, and is left alone.
- The duration is now **rejected at authoring time** on a spell's or reaction's
  own top-level effects (`card.ts` `superRefine`), because such a card leaves
  play as it resolves — the modifier would expire in the same breath it was
  applied. Rejected rather than silently reinterpreted as `permanent`: guessing
  is the "silently approximate a card" failure §1 forbids.
- Pilots discount it: `scoring.ts#durationScale` prices `permanent` 1,
  `while_source_present` 0.8, `end_of_turn` 0.5, applied to every duration-
  carrying effect type. Valuing it as permanent would overrate every aura-style
  card in the pool now that it can genuinely be answered.
- A `duration` glossary entry was added, and it says the lethal case out loud.

### B. Content and cards

#### B1. Inert keyword policy — readiness gate B2, partly done

`guardian` is no longer inert, and cards carry `implemented` /
`unsupportedReason` so nonfunctional data cannot pass silently in a strict set.
`resilient` is the last keyword with `implemented: false`
(`packages/card-data/src/keywords.ts`). Missing: the written policy and the
sweep. ⚠ Blocked on Q4 — what `resilient` should do, or whether it is dropped.

#### B2. Archetype registry — readiness gate C3, partly done

The `design.faction/identity/power` block exists and is validated. The archetype
registry does not. Needed by F5 (deck plans) and by cluster naming.

#### B3. Promote `precon_wave_1` from `draft`

`content/sets/precon_wave_1/set.json` is `status: "draft"`, so
`STRICT_SET_STATUSES` (`playtest`, `active`) validation does not apply to it.
Promotion is the honest end state of the milestone and will surface whatever
strict validation currently forgives — do it after A1, not before.

### C. Client and server

#### C1. The deck builder shows the wrong card pool

`apps/web-client/src/main.tsx:26` loads `loadBundledCardData()` and
`App.tsx:67` calls `database.deckable()` — **the whole card universe**, both
sets, 211 cards. The `formatCardPool` / `formatDatabase` split built for gate B4
exists precisely to prevent this, and the client does not use it. Today the
builder mixes `prototype_core` fixtures into a `precon_wave_1` deck.

`apps/multiplayer-server/src/main.ts:18` has the same problem: the server
validates against the universe rather than a format-scoped pool.

`AppContext.tsx:73` does default the _format_ correctly
(`deckFormat ?? DEFAULT_DECK_FORMAT` = `precon_wave_1`), while
`builder-flow.test.tsx` pins `DEVELOPMENT_DECK_FORMAT` — so the tests do not
exercise the shipping configuration.

#### C2. Precons are not surfaced anywhere in the UI

Ruleset update §3 requires the deck builder to show precons as named starting
points, let a user inspect one, copy it into an editable saved deck, and start a
match with it. `grep -ri precon apps/web-client/src` returns **nothing**. The
loader, validator and copy-to-deck logic all exist in `packages/deck/src/precon.ts`
with 19 tests; only the UI is missing. There is also no format picker.

#### C3. Token visual grouping

Ruleset update §7. Identical Tokens should stack visually to reduce clutter while
every Token keeps individual identity for attacking, blocking, exhausting,
readying, sacrifice, damage, buffs and targeting. Nothing in
`apps/web-client/src/components` groups anything. **Purely presentational — it
must not touch engine state.** Becomes urgent with A3.

### D. Simulator and telemetry

#### D1. The simulator cannot address a precon

Ruleset update §3 and §20. `grep -r precon apps/simulator/src` returns **zero
matches**. §3 requires addressing a precon by permanent precon ID and adding
simulator-source tests; §20 requires running every ordered precon matchup
deterministically from a seed. D2 and F3 both depend on this.

#### D2. Unlimited-board telemetry

Ruleset update §17 and `CLAUDE.md` §13.6. None of it exists — the collector only
computes `ownUnitsBefore` / `ownUnitsAfter`
(`apps/simulator/src/telemetry/collector.ts:599-630`). Every match must record,
and every report must surface:

- Unit count per player at the end of every round;
- highest Unit count, highest non-Token Unit count, highest Token count, and
  largest visual Token-stack size, per player;
- longest turn and longest combat resolution;
- declared attackers and blockers in the largest combat;
- triggers and choices in the busiest turn;
- whether the match reached a board stall;
- how the largest board was reduced or answered.

Removing the unit cap is a decision to be judged on evidence, and this is the
evidence. **Do not restore a unit cap merely because boards get large** — evaluate
token grouping, anti-wide interaction, sweepers, upkeep pressure and engine/UI
performance first.

#### D3. Telemetry support and attribution — readiness gate H

- **H1** — every Batch-1 mechanic needs its causal evidence decided and
  recorded: trigger count and source, cards/units/tokens produced, damage
  prevented/redirected/amplified, counters, cost reduction _used_ rather than
  merely available, tutored vs naturally drawn, sacrifice paid as cost vs
  resolved as effect, continuous bonuses over card-turns, failed effects due to
  no target. Do not infer these from final state — extend the events.
- **H2** — attribution tests: source keeps credit after leaving play if its
  queued effect resolves; tokens and copied effects keep the correct source
  definition; sacrifice costs are not double-counted as voluntary plays;
  prevention records the _prevented_ amount, not the printed shield; multiplayer
  effects attribute each opponent separately; totals reconcile with event logs;
  unsupported telemetry downgrades analysis rather than fabricating zero.
- **H3** — already satisfied by the hardening work; keep it that way.

### E. Pilot honesty — readiness gate F

#### E1. F1 — pilot valuation defects

All three are still present in `packages/bot-interface/src/scoring.ts`:

- `keywordCount()` (line 167) counts every keyword including unimplemented ones.
  It must filter by `IMPLEMENTED_KEYWORDS`, already exported from
  `@tcg/card-data`. Today a pilot pays for `resilient`, which does nothing.
- `effectValue()` ends in `default: return 0` (line 271). It must become an
  exhaustive registry keyed by `EffectType` so a **new effect type fails
  type-check until its scoring exists** — otherwise every A1 primitive lands
  silently valued at zero.
- `cardValue` / `unitBoardValue` price static abilities as
  `staticAbilities.length * weights.buffValue * 2` (lines 310, 337). Value them
  by magnitude, scope and affected board count instead.

#### E2. F2 — choice provenance

`packages/bot-interface/src/heuristic.ts:307` `sourceIsHostile()` decides whether
a pending choice is good or bad for the chooser by scanning **every** effect on
the source card — top-level, triggered and activated. A card with one helpful and
one hostile effect is misread, and the pilot then inverts its own preference
(line 351-359).

Replace with structured provenance on `PendingChoice`
(`packages/rules-engine/src/schema/choice.ts`): resolution item ID, effect index,
effect type, source, chooser, target relation, semantic intent. Add mixed
helpful/hostile regression cards.

#### E3. F3 — mechanic-support matrix

A machine-readable capability registry for every effect, trigger, keyword, value
expression and condition — `{ engine, help, pilot: 'full' | 'approximate' |
'legal_only', telemetry: 'full' | 'partial' | 'none' }`. Content validation
derives support from registries rather than trusting card authors; every playtest
card reports its weakest support level; simulator manifests aggregate it; reports
state prominently when a conclusion depends on approximate pilots; balance flags
are suppressed or downgraded when mechanics are `legal_only` or telemetry is
incomplete. Random-legal crash testing stays allowed regardless.

#### E4. F4 — separate rule agents from balance agents

Explicit language in code and reports. Random-legal: legality, termination, loop
and crash discovery **only**. Heuristic pilots: approximate play-quality for
supported linear mechanics. Archetype-aware pilots: required for synergy, combo,
sacrifice and control decks whose cards are individually weak. Human playtests:
required before any final balance conclusion. **Do not pool all pilot results as
one skill distribution.**

#### E5. F5 — archetype-aware deck plans

A versioned deck-plan schema used by both generation and pilot evaluation, so
generation seeds coherent _packages_ rather than independent card weights;
mutation can protect engine pieces or swap a whole package; crossover does not
claim coherence merely from a shared Commander; search still explores outside the
plans. Every first-batch archetype needs one hand-authored legal seed deck and
one deck plan, and reports must distinguish hand-authored, plan-generated and
unconstrained discovery decks. Depends on B2.

### F. Tests

#### F1. Per-card happy-path tests

Ruleset update §19.13: "at least one executable happy-path test for every card."
155 cards, **currently zero**. Cheapest as a generated table-driven suite over the
content bundle, which also makes it self-updating as cards move from inventoried
to implemented.

#### F2. Server-side precon validation test

Ruleset update §20: "the multiplayer server validates the same precon/deck
definition the client shows." Deck validation genuinely is shared code, so this is
a test gap rather than a behaviour gap — but it is the criterion as written, and
C1 shows the two ends really can diverge on which _pool_ they validate against.

#### F3. Precon matchup smoke tests

Ruleset update §19.14: all ordered pairs of the four precons across fixed seeds.
Blocked on A1–A5 and D1.

#### F4. Text-vs-behaviour validation — §19.7, partly done

The display-text linter was extended to read activated-ability costs and keywords
named in target filters. There is still no per-card assertion that authored text
matches structured behaviour, and unimplemented cards are skipped entirely.

### G. Documentation

#### G1. `README.md` and `docs/project-status.md`

Neither has been updated for the ruleset update. `project-status.md` still says
**"Phase 4 — Hardening in progress"** and quotes **679 tests in 42 files**; the
real numbers are 780 in 47, and every hardening correction is implemented
(§1.3). Readiness gate A2 is exactly this. `README.md` does not mention precons,
the 40-card singleton format, or the two-format split.

#### G2. `docs/open-questions.md` is stale

Ten entries describe a codebase that no longer exists. Details and the exact
corrections are in §3 below.

#### G3. Missing documents named by the specs

- `docs/testing/FIRST_CARD_BATCH_TEST_PLAN.md` — the seven-stage protocol in
  readiness spec §11. The whole `docs/testing/` directory is absent.
- ADRs for any new persisted-data or statistical-contract decision made by A1–A5.

#### G4. `PHASE4_HARDENING.md` §19 final report

Never written. The spec asks for files changed, defects fixed, schema versions and
compatibility, tests added, smoke experiments run, before/after examples for
corrected warnings, remaining analytical limitations, and unresolved designer
decisions. Fold it into `project-status.md` as part of G1 rather than reviving the
deleted file.

---

## 3. Documentation that is currently wrong

Separated from §2 because these are corrections to existing text, not new
features, and each one actively misleads a reader today.

| File                                                    | Says                                                   | Reality                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/project-status.md`                                | Phase 4 "Hardening in progress"; 679 tests in 42 files | Hardening complete in code; 780 tests in 47 files                                                                                                        |
| `docs/project-status.md:445`                            | Links `../PLAYER_HELP_AND_CONTENT_SYSTEM.md`           | **Broken link** — that file was deleted when the Help milestone shipped                                                                                  |
| `docs/project-status.md:186,483`                        | Refers to `prototype_core.json` as the card file       | Replaced by per-card sources under `content/sets/`                                                                                                       |
| `docs/open-questions.md` Q4                             | `guardian` and `resilient` are "deliberately inert"    | `guardian` is real engine behaviour with tests; only `resilient` is inert                                                                                |
| `docs/open-questions.md` Q5                             | "Commanders never enter the battlefield"               | Ruleset update §10 makes them deployable; the question is now only the post-defeat lifecycle                                                             |
| `docs/open-questions.md` Q19                            | "Is 30 cards / 2 copies right?"                        | Superseded — 40-card singleton, and format is data, not a constant                                                                                       |
| `docs/open-questions.md` Q1, Q2, Q3, Q23, Q25, Q27, Q29 | all marked "not yet implemented"                       | All implemented — `continuous.ts`, `abilityCostSchema`, the discriminated `{kind:'source'}` / `player` / `players` targets, mandatory public-zone search |
| `packages/help-content` glossary                        | ~~`unit_slot` is a real concept~~                      | ✅ Corrected by A3: the term is deleted and the token sentence now says every token is created                                                           |
| `PRE_CARD_AND_AGENT_TESTING_READINESS.md` B3            | Commanders stay non-combat, hide their combat stats    | ⛔ **Superseded** by ruleset update §10. Implement §10, not B3.                                                                                          |
| `PRE_CARD_AND_AGENT_TESTING_READINESS.md` Gate D        | The stop point: decide the first card batch            | ⛔ **Superseded** — the batch was authored directly as `cards.json`. Not a stop point.                                                                   |

---

## 4. Things learned the hard way

Carried from the deleted progress logs. Each one cost real debugging time.

- `loadBundledCardData()` is the whole card **universe**, not a legal pool.
  Anything meaning "the cards you may actually play" must go through
  `formatCardPool(formatId)`. Several test failures were only this — and §C1
  shows the web client and server still get it wrong.
- Making Guardian real breaks every agent that blocks, because "block nothing"
  stops being legal. The fix belongs in three places — `enumerateActions`, the
  pilot candidate generator, and `random-legal` — not in the engine.
- `DEVELOPMENT_DECK_FORMAT` must be exported from `@tcg/deck`'s barrel or it
  silently arrives as `undefined`, and the `?? DEFAULT_DECK_FORMAT` fallback
  quietly puts the caller back on the 40-card format.
- The simulator's `deckFormat` must default `singleton: false` rather than
  inherit the active format. Inheriting silently changed the meaning of every
  existing experiment config.
- **Zod 4's `.partial()` does not strip `.default()`.** The field becomes
  optional but the default still fires on an absent key, so any "subset of a
  schema" built that way silently materializes every default. This was a real
  bug in `cardPatchBodySchema`: `{"cost": 4}` parsed to a card with
  `effects: []` — a one-number balance edit that **deleted the card's rules
  text**. Unwrap `ZodDefault` explicitly.
- `cardDefinitionSchema` is wrapped by `superRefine`, so `.pick()` / `.partial()`
  must be taken from `baseCardSchema`.
- A cross-field `superRefine` rule is the only thing a patch's own schema cannot
  catch, so a test that a patch "produces an invalid card" has to pick a
  violation that is legal field-by-field (e.g. a spell patched to `effects: []`).
- Adding a card to `FIXTURE_CARDS` changes the pool every `tinyEnvironment()`
  draws from, which changes every seeded generated population, which breaks
  `search.test.ts` and `telemetry.test.ts`. Scope one-test fixtures to that test.
- The tiny test environment's 12-card decks make matches decide on deck-out as
  often as on damage, so a "clearly stronger card" fixture needs its opponent
  field chosen deliberately, not assumed.
- `content-hash.ts` is a deliberate **leaf**: both a live `Environment` and a
  frozen snapshot must be hashed by the same code, and putting that code in
  either creates a cycle. `snapshotCards()` decides one card set so a frozen
  snapshot's hashes _equal_ the live environment's rather than merely resemble
  them.
- Experiment labels are capped at 80 characters and the validator's error is a
  raw Zod dump, easy to misread as a config-loading failure.

---

## 5. Files: deleted, kept, and pending your call

### Deleted when this file was written

| File                         | Why                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `RULESET_UPDATE_PROGRESS.md` | Working notes, self-marked "delete when the milestone is done". Fully folded into §1–§4. |
| `READINESS_PROGRESS.md`      | Same. Fully folded into §1–§4.                                                           |

### Moved out of the root

`PHASE4_HARDENING.md` → **`docs/PHASE4_HARDENING.md`**. It is a satisfied
specification, not a work list — but 54 code comments across
`apps/simulator/src/analysis/` cite it by section number as the reason the
statistical contracts are shaped the way they are, so it stays as a rationale
reference. Its only unfinished parts are §17 (doc cleanup) and §19 (final
report), carried here as G1/G4. Links in `README.md`, `docs/project-status.md`
and ADRs 0013/0014 were repointed.

`PLAYER_HELP_AND_CONTENT_SYSTEM.md` was already deleted in a previous session;
the Help milestone is complete and `packages/help-content` is its implementation.
Only the broken link in `project-status.md:445` remains (§3).

### Kept

- `CLAUDE.md` — project specification.
- `CLAUDE_RULESET_UPDATE.md` — authoritative for the active milestone; ~⅔ unbuilt.
- `PRE_CARD_AND_AGENT_TESTING_READINESS.md` — gates B1/B2/C3/E/F/H unbuilt, and it
  holds detail this summary deliberately does not duplicate. Two of its sections
  are dead (§3).
- `README.md` — needs updating (G1), not deleting.

### Pending your call — see Q40

`cards.json` and `precons.json` at the repo root are **verifiably 100% migrated**
into `content/` with zero text drift (§1.2), which makes them a redundant second
source of truth for card text — exactly the drift risk `CLAUDE_RULESET_UPDATE.md`
§1 warns about. They are also **untracked in git**, so deleting them is
irreversible, and the spec names them as its accompanying input files. I left
them in place rather than make that call for you.
