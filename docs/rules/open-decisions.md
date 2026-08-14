# Provisional rules

Rules the game **implements** but whose value or shape is still a playtest
decision. Nothing here is a gap in the engine: every entry works today, and every
entry could move without a rewrite because the implementation keeps it
configurable rather than inlining it.

Three files divide the whole rules record between them:
[confirmed-rules.md](./confirmed-rules.md) holds what is settled, this file holds
what is implemented but provisional, and
[../open-questions.md](../open-questions.md) holds what has no answer at all.
Each entry below names the question that would settle it.

A provisional value is not a placeholder for missing behaviour. Where an entry
says "open", what is open is the **number or the wording**, not whether the rule
runs.

---

## Deck construction

Deck construction is declared per format in `content/formats/*.json` and
flattened by `deckFormatOf`. It is data, not a constant, so an experiment or a
new format only needs a different config object.

| Format          | Size | Copies                | Commander colours | Pool             |
| --------------- | ---- | --------------------- | ----------------- | ---------------- |
| `precon_wave_1` | 40   | singleton (1 each ID) | 2                 | `precon_wave_1`  |
| `development`   | 30   | 2 (1 for unique)      | 2                 | `prototype_core` |

`DEFAULT_DECK_FORMAT` is `precon_wave_1`. `DEVELOPMENT_DECK_FORMAT` is what the
Phase 1–4 regression fixtures use, and callers that mean the old rules say so
explicitly rather than relying on a default. `validateDeck(deck, database,
format)` takes the format as an argument, and the multiplayer server validates
every submitted deck with the same function.

### 40 is a scope decision, not a leftover — owner, 2026-08-14

An earlier project-level decision named **50 singleton cards** as the deck size,
and the repository has shipped 40 everywhere since. That was never reconciled, so
40 was true by default rather than on purpose. It is now on purpose: **40 for the
first playtest, with a 50-card target kept for later.**

The reason is content, not code. `deck.size` is one number in
`content/formats/precon_wave_1.json` and changing it is a config edit — but a
deck must also be legal, and a singleton deck can only be as large as its
Commander's colour-legal pool. Measured against the shipped set:

| Precon                       | Commander                   | Colour | Colour-legal pool |
| ---------------------------- | --------------------------- | ------ | ----------------- |
| `precon_bastion_guardians`   | `bastion_commander`         | white  | 42                |
| `precon_containment_control` | `chief_containment_scholar` | blue   | 41                |
| `precon_goblin_swarm`        | `goblin_warboss`            | red    | 41                |
| `precon_grave_sacrifice`     | `grave_matriarch`           | black  | 42                |

Each pool already includes the six colourless cards, which every Commander can
play, so they cannot close the gap. A legal 50-card deck therefore needs
**8–9 further colour-legal cards per Commander** — or a shared neutral package
that solves the same deficit for all four, or a construction-rule change such as
lifting the singleton limit. Moving to 50 before any of those exist would make
every bundled precon illegal.

Reaching 50 is authoring work and a gameplay decision, deliberately not something
a consistency pass performs: inventing cards, duplicating singleton entries or
weakening colour identity would each be a design change made silently.

**Provisional:** whether 40-card singleton gives enough consistency, when the
content for 50 gets authored, and whether the two-colour Commander cap should
open to three once the colour pie exists. Playtest question — Q19.

---

## Match rules — provisional numbers

Every provisional numeric rule is a field on `RulesConfig`
(`packages/rules-engine/src/config.ts`). Nothing in the engine inlines any of
them, and `MatchState` records the `rulesVersion` it was created under.

| Value                          | Current | Field                                     |
| ------------------------------ | ------- | ----------------------------------------- |
| Starting health                | 20      | `startingHealth`                          |
| Opening hand                   | 5       | `openingHandSize`                         |
| Maximum hand size              | 10      | `maxHandSize`                             |
| Free opening redraws           | 1       | `openingRedraws`                          |
| First player skips a draw      | yes     | `firstPlayerSkipsFirstDraw`               |
| Starting / per-turn energy     | 1 / +1  | `startingMaxEnergy`, `energyGainPerTurn`  |
| Energy cap                     | 10      | `energyCap`                               |
| Active Relics                  | 1       | `relicSlots`                              |
| Exhausted units may block      | no      | `exhaustedUnitsMayBlock`                  |
| Blockers per attacker          | 1       | `blockersPerAttacker`                     |
| Armored reduction              | 1       | `armoredReduction`                        |
| Commander surcharge per defeat | +1      | `commanderCostPerDefeat`                  |
| Commander total cost cap       | 10      | `commanderCostCap`                        |
| Reactions enabled              | yes     | `reactionsEnabled`                        |
| Reactions per player, window   | 1       | `reactionsPerPlayerPerWindow`             |
| Printed cost-reduction floor   | 1       | `costReductionFloor`                      |
| Empty deck loses               | yes     | `emptyDeckDrawLoses`                      |
| Resolution safeguards          | 2000/20 | `maxResolutionSteps`, `maxRepeatedStates` |
| Disconnect grace               | 90s     | `disconnectGraceSeconds`                  |

Changing one is a config edit plus updating the tests that assert it. Several
tests already pass their own config object — that is the pattern to follow, not
editing the default.

Two absences are deliberate and must stay absent. There is **no `unitSlots`**:
the battlefield cap was removed rather than raised, and it must not return as a
large number here or as a hidden limit anywhere else. And `exhaustedUnitsMayBlock`
covers only _who may be declared_ — declaring a blocker **exhausts** it
unconditionally in `flow.ts#finalizeBlockers`, because that half is a confirmed
rule rather than a number.

Whether three- and four-player matches need different values at all is Q35;
whether the disconnect window is fair at four seats is Q34.

---

## Colour identities

Five placeholder colours: `white`, `blue`, `black`, `red`, `green`. These are
plain colour words with **no lore, faction or mechanical pie attached yet**.

Neutral/colourless is modelled as an **empty** `colorIdentity` array rather than
a sixth colour, which makes the legality rule fall out for free: every colour in
a card's identity must appear in the Commander's, and an empty array satisfies
that vacuously.

**Provisional:** the final colour names, count, and what each colour actually
_does_ — Q17. Renaming is safe: colour IDs appear only in card data and
`COLOR_INFO`, and display names are already separate.

---

## Keywords

Eleven keywords exist. The single source of truth is `KEYWORD_REGISTRY` in
`packages/card-data/src/keywords.ts`: it carries the player-facing definition
every tooltip, glossary entry and card explanation reads, and its `implemented`
flag is now a **view of the mechanic support registry** rather than a second
claim beside it. `packages/rules-engine/src/keywords.ts` adds only the
developer-facing note naming the handler that owns each behaviour.

| Keyword                     | Engine behaviour today                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `rush`                      | Bypasses the two `Newly Deployed` restrictions without removing the state.                    |
| `guardian`                  | Blocking obligation: a defender must block at least as many aimed attacks as ready Guardians. |
| `barrier`                   | Prevents the first non-zero damage event, then is spent.                                      |
| `overwhelm`                 | Splits damage against the blocker's current Health; the remainder hits the player.            |
| `untargetable_by_opponents` | Dropped from any legal target set computed for an opposing chooser.                           |
| `evasive`                   | Cannot be assigned a blocker.                                                                 |
| `armored`                   | Reduces **each instance** of damage by `armoredReduction`, minimum zero.                      |
| `quick_strike`              | Deals combat damage in an earlier step; anything defeated there never strikes back.           |
| `venom`                     | Any damage it deals to a unit is lethal to that unit.                                         |
| `siphon`                    | Combat damage it deals heals its controller by the same amount.                               |
| `resilient`                 | **Inert.** No mechanical effect.                                                              |

**`resilient` is the only inert one,** and it is inert on purpose: the plausible
readings (clear all damage at end of turn, versus survive lethal damage once per
turn) differ enormously in power and interact directly with the "damage persists
between turns" rule. Its glossary entry says so in the words a player reads,
rather than describing a rule the game does not implement.

Two structural consequences, both already in force. A `playtest` or `active` set
containing a card built on an inert mechanic is a **build error**, so `resilient`
is barred from playable content by a rule rather than by luck; no
`precon_wave_1` card prints it. And `keywordIsValued` reads the same registry, so
an `engine: 'none'` keyword is worth **zero** to a pilot everywhere a keyword is
priced — implementing it switches its valuation on in the same change that
switches its behaviour on.

**Provisional:** what `resilient` should do, or whether to delete it — Q4.
Also whether `armored` is per damage instance (current) or per turn.

Changing a keyword means changing the registry entry, the engine note beside it,
and the handler it names — not hunting through combat code.

---

## Reaction chaining policy

Implemented, versioned and deliberately minimal (ADR 0016; `reactions.ts`):

- one window per triggering event, opened only if somebody could legally act;
- priority to the active player first, then clockwise, offered only to a player
  with something legal to play;
- each eligible player plays at most `reactionsPerPlayerPerWindow` (1) Reaction
  per window;
- priority goes round the table **once**: playing a Reaction moves priority on
  exactly as passing does and never re-offers a seat that has already answered;
- the window closes when there is nobody left to offer it to;
- pending cards resolve last in, first out, with the spell the window opened
  around at the bottom;
- nothing already resolving is interruptible, and countering refunds nothing.

The fourth bullet is Q47, **answered on 2026-08-14**: the engine used to clear
`passedPlayerIds` on a play, restarting the round, and `CLAUDE.md`'s product
rules said no Reaction answers another Reaction. The engine was changed to match
the product rules. Two different seats can still each spend their one Reaction in
the same window and the later one still resolves first; what is gone is coming
back after passing. The write-up is under
[Answered](../open-questions.md#answered), and `reactions.test.ts` holds the
three tests that enforce it.

**Provisional:** whether one round of priority is enough interaction once more
Reactions exist. Nothing about it is a gap — every layer describes the same rule
today. Whether a Reaction may carry an additional cost is Q46; the schema rejects
one today rather than accepting it and quietly not charging it.

---

## Barrier against other reduction

Barrier's order **against Overwhelm** is confirmed (ADR 0016 Q-D, and
[confirmed-rules.md](./confirmed-rules.md#combat)). Its order against the other
reducers is not: the engine has `armored` (flat reduction) and `prevent_damage`
shields, and `damage.ts` currently applies `armored` first. Ruleset update §9's
"a zero-damage event does not consume Barrier" is already in force, which leans
toward reduction-first.

**Provisional:** the general ordering, which only genuinely diverges once a
`prevent_damage` shield with a capped amount exists — Q45.

---

## Blockers per attacker

`blockersPerAttacker` defaults to `1`, and blocker assignment is modelled so more
than one can be added without rewriting combat state.

**Provisional:** whether multi-blocking is ever wanted — Q44. It is recorded here
because doing it in the same pass as another combat change is far cheaper than a
second rewrite.

---

## Turn phase list

The machine itself is confirmed and enforced in `flow.ts`
([confirmed-rules.md](./confirmed-rules.md#turn-structure)); phase legality is
never inferred from the UI, which only renders what `legalActions` reports.

**Provisional:** the phase list itself. Nothing so far suggests it is wrong.

---

## Leaving a live match

Leaving a live match concedes; losing the socket starts the grace window
instead (`match-server.ts`, `leave` / `disconnect`).

**Provisional:** whether that split is right at four seats, where one stalled
seat holds up three others — Q34, and related to the timeout policy in Q8.

---

## Tokens and colour identity

A card that creates a coloured Token arguably carries that colour. The loader
emits a **warning** (`card_data/token_color_leak`), not an error, when a card
creates a Token whose colours are not in the creating card's identity.

**Provisional:** whether this should be a hard rule — Q18. If it becomes one,
promote the warning to an error in `loader.ts`. The bundled sets already comply.

---

## Artwork

`768 × 1024 px` PNG is what the placeholder generator emits and what the card
frame reserves space for.

**Provisional:** the size — Q22. Nothing so far suggests changing it; revisit
only if real art shows a problem.

---

## Simulator analysis thresholds

**Not game rules.** Nothing in this section changes how a match plays. These are
the numbers the balance analyser uses to decide when to ask a human to look at
something, and they are listed here so they are not mistaken for confirmed values
of anything.

All of them live in one validated block (`analysisSettings` in
`apps/simulator/src/config.ts`), are written into every experiment's
`config.json`, and are overridable per experiment.

The table below is the subset that gets asked about, not the whole block —
`analysisSettingsSchema` is the complete list, and it carries each setting's
default beside the comment explaining it. Every row here is compared against
that schema by `npm run check:consistency`, so a default that moves fails the
suite; a setting with no row does not, because this was never a full index.

| Setting                  | Provisional default | What it gates                                                |
| ------------------------ | ------------------- | ------------------------------------------------------------ |
| `minMatchesPerCard`      | 30                  | Below this, a card is reported `insufficient_data`           |
| `minPairSupport`         | 20                  | Below this, a card pair is not reported at all               |
| `minMatchesPerDeck`      | 20                  | Below this, a deck or cluster win rate is indicative only    |
| `confidence`             | 0.95                | Every interval the analyser prints                           |
| `autoIncludeWinRateLift` | 0.08                | Inclusion lift that suggests a broad auto-include            |
| `crossClusterShare`      | 0.75                | Share of clusters a card must beat to count as cross-cluster |
| `replacementImpact`      | 0.06                | Controlled substitution impact worth reviewing               |
| `polarizationThreshold`  | 0.85                | Matchup win rate called polarised                            |
| `deadHandShare`          | 0.5                 | Share of drawn copies dead before an inclusion looks wrong   |
| `abnormalShare`          | 0.02                | Abnormal terminations above which the run is suspect         |

These were chosen to be legible rather than tuned — Q14. The analyser never
converts a threshold into a verdict: it produces `review_recommended`,
`possible_interaction`, `insufficient_data` or `run_quality`, always with the
evidence, the sample size and the interval attached, so the number can be argued
with.

The board-stall threshold is **not** here. It was a judgement in the reporting
layer and is now one explicit, configurable, versioned number that travels inside
every document carrying a verdict (`@tcg/board-telemetry/stall`,
`STALL_DEFINITION_VERSION`), which is what Q43's answer required.
