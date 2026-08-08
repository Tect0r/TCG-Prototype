# Open design decisions

Everything here is **unconfirmed**. Each entry records what the code does today,
why, and what has to happen before it can be called settled. Nothing in this
file may be treated as a confirmed rule.

Where a value is provisional, the implementation keeps it configurable rather
than inlining it, so playtesting can move it without a rewrite.

Phase 2A forced a decision on several things that were genuinely open. In every
such case the engine ships the smallest, most reversible placeholder, and this
file records exactly what it does and where to change it. A placeholder is not
an answer — the questions stay open in
[open-questions.md](../open-questions.md).

**As of 2026-08-07** some of those placeholders have been ruled on by CLAUDE.md
§17 without the code having caught up yet. Each entry below says which of three
states it is in: **open** (no answer), **confirmed — implemented** (the
placeholder was ratified, nothing to do), or **confirmed — not implemented**
(Phase 3 work item). Only "open" entries are still decisions to make.

---

## Deck construction

| Decision             | Current value | Where it lives                           |
| -------------------- | ------------- | ---------------------------------------- |
| Deck size            | 30            | `DEFAULT_DECK_FORMAT.deckSize`           |
| Copies of a card     | 2             | `DEFAULT_DECK_FORMAT.copyLimit`          |
| Copies of a unique   | 1             | `DEFAULT_DECK_FORMAT.uniqueCopyLimit`    |
| Commander colour cap | 2             | `DEFAULT_DECK_FORMAT.maxCommanderColors` |

`validateDeck(deck, database, format)` takes the format as an argument, so an
experiment only needs a different config object — no code change. The
multiplayer server validates every submitted deck with the same function.

**Needs playtesting:** whether 30 cards gives enough consistency without making
every deck the same, and whether the two-colour Commander cap should open up to
three once the colour pie exists.

---

## Match rules — provisional numbers

Every provisional value the engine uses is a field on `RulesConfig`
(`packages/rules-engine/src/config.ts`). Nothing in the engine inlines any of
them, and `MatchState` records the `rulesVersion` it was created under.

| Value                      | Current | Field                                    |
| -------------------------- | ------- | ---------------------------------------- |
| Starting health            | 20      | `startingHealth`                         |
| Opening hand               | 5       | `openingHandSize`                        |
| Maximum hand size          | 10      | `maxHandSize`                            |
| Free opening redraws       | 1       | `openingRedraws`                         |
| First player skips a draw  | yes     | `firstPlayerSkipsFirstDraw`              |
| Starting / per-turn energy | 1 / +1  | `startingMaxEnergy`, `energyGainPerTurn` |
| Energy cap                 | 10      | `energyCap`                              |
| Unit slots                 | 5       | `unitSlots`                              |
| Relic limit                | 3       | `relicSlots`                             |
| Exhausted units may block  | yes     | `exhaustedUnitsMayBlock`                 |
| Blockers per attacker      | 1       | `blockersPerAttacker`                    |
| Armored reduction          | 1       | `armoredReduction`                       |
| Empty deck loses           | yes     | `emptyDeckDrawLoses`                     |
| Disconnect grace           | 90s     | `disconnectGraceSeconds`                 |

Changing one is a config edit plus updating the tests that assert it. Several
tests already pass their own config object — that is the pattern to follow, not
editing the default.

---

## Colour identities

Five placeholder colours: `white`, `blue`, `black`, `red`, `green`. These are
plain colour words with **no lore, faction or mechanical pie attached yet**. The
spec's own examples use blue and red, so those names were kept.

Neutral/colourless is modelled as an **empty** `colorIdentity` array rather than
a sixth colour. That makes the legality rule fall out for free: every colour in
a card's identity must appear in the Commander's identity, and an empty array
satisfies that vacuously.

**Open:** the final colour names, count, and what each colour actually _does_.
Renaming is safe — colour IDs appear only in card data and `COLOR_INFO`; display
names are already separate.

---

## Keywords

Eight provisional keywords exist: `swift`, `guardian`, `evasive`, `armored`,
`siphon`, `venom`, `quick_strike`, `resilient`. Their exact wording and
interactions are **still undecided** ([open-questions.md](../open-questions.md)
Q4).

Phase 2A had to do _something_ with them to run a match. The single source of
truth is the `KEYWORD_BEHAVIOUR` table in
`packages/rules-engine/src/keywords.ts`, which states in one line what the
engine does today and carries an `implemented` flag. Changing a keyword means
changing that table and the handler it names — not hunting through combat code.

| Keyword        | Engine behaviour today                                                          |
| -------------- | ------------------------------------------------------------------------------- |
| `swift`        | Ignores summoning sickness.                                                     |
| `evasive`      | Cannot be assigned a blocker.                                                   |
| `armored`      | Reduces **each instance** of damage by `armoredReduction` (1), minimum zero.    |
| `quick_strike` | Deals combat damage in an earlier step; a unit killed there never strikes back. |
| `venom`        | Any damage it deals to a unit is lethal to that unit.                           |
| `siphon`       | Combat damage it deals heals its controller by the same amount.                 |
| `guardian`     | **Inert.** No mechanical effect.                                                |
| `resilient`    | **Inert.** No mechanical effect.                                                |

Two of them do nothing on purpose:

- **`guardian` is inert** because taunt-style semantics have no meaning in the
  combat model: attackers target a _player_ and never choose a unit to attack,
  so "must be attacked through a guardian" has nothing to attach to. Phase 3
  makes that permanent rather than temporary — CLAUDE.md §12 confirms that units
  cannot attack other units directly at any player count, so any eventual
  meaning has to live on the blocking or damage side. Inventing one would be
  guessing at a design decision nobody has made. Cards keep the keyword, the
  deck builder keeps filtering on it, and a regression test asserts that a
  guardian blocker currently behaves exactly like any other blocker.
- **`resilient` is inert** because the plausible readings (clear all damage at
  end of turn, versus survive lethal damage once per turn) differ enormously in
  power and interact directly with the "damage persists between turns" rule.

Both are waiting on Q4. Neither blocks anything else.

---

## Tokens and colour identity

A card that creates a coloured token arguably carries that colour. The loader
emits a **warning** (`card_data/token_color_leak`), not an error, when a card
creates a token whose colours are not in the creating card's identity.

**Open:** whether this should be a hard rule. If it becomes one, promote the
warning to an error in `loader.ts`. The bundled set already respects it.

---

## Commander recovery

Still **not implemented and not modelled**, per CLAUDE.md §4 ("do not invent
that subsystem in Phase 2") and now §12, which also bars Commander battlefield
deployment and recovery from Phase 3. Commanders do not enter the battlefield,
are never defeated, and the `recovery` zone exists in the schema with nothing
that can enter it.

One consequence worth knowing: Commander abilities triggered by `on_attack`,
`on_block`, `on_survive_combat`, `on_deploy`, `on_defeated` or `on_sacrifice`
can **never fire** in Phase 2, because a Commander never does any of those
things. Four of the eight bundled Commanders have such abilities and are
effectively vanilla for now. That follows from the deferral; it is not a bug.

Commander _passives_ that hang off `on_turn_start` / `on_turn_end` do work, from
the Commander zone, as CLAUDE.md §4 requires.

---

## Card-schema questions: what the engine does today

Q1–Q3 were **answered on 2026-08-07** (CLAUDE.md §17). The engine still runs the
Phase 2A placeholder for all three; each is now a Phase 3 work item rather than a
decision.

### `effects` vs. `abilities` (Q1)

**Confirmed — not implemented.** The ruling: keep top-level `effects` for spell
resolution _and_ for unit/relic deploy resolution, keep triggered `abilities`
only for non-deploy triggers, and migrate every `on_deploy` ability into
top-level `effects` so deploy behaviour has one authoring form.

Today the engine still accepts both: it enqueues a unit's or relic's top-level
`effects` when the card enters play, immediately before any `on_deploy` ability
on the same card, and the bundled set uses both forms. Closing this needs a card
migration plus a schema rule rejecting `on_deploy` inside `abilities`. See
[ADR 0002](../architecture/0002-card-data-model.md).

### Static and continuous abilities (Q2)

**Confirmed — not implemented,** and still the real gap. The ruling: a separate
validated `staticAbilities` layer whose effects are derived from current state,
never permanently stamped onto recipients, and recalculated after every relevant
state change. Until it exists there is no continuous-effects layer at all.

Concretely:

- `modify_cost` is a turn-scoped modifier held on the player, so "your units
  cost 1 less this turn" works as written and expires at end of turn.
- `grant_keyword` and `modify_stats` apply **once, to whatever is on the board
  at that moment**. `radiant_bulwark` reads "your units gain Armored"; the
  engine grants Armored to units present when it is deployed and does _not_
  grant it to units that arrive later.

That divergence between text and behaviour is a consequence of the layer not
existing yet, not a bug to fix in isolation. Lord-style and aura cards still
should not be authored until it does.

### `sacrifice` as cost or effect (Q3)

**Confirmed — not implemented.** The ruling: it may be **either**. A `sacrifice`
instruction inside `effects` stays an effect, and activated abilities gain a
structured, extensible `costs` array — energy first, then discard, sacrifice and
exhaust — validated and paid atomically before the ability is queued.

Today it is only ever an effect, resolving in authored order, and an activation
cost is the single `energyCost` field on `activatedAbilities`. Closing this needs
a card migration from `energyCost` to `costs`.

### Trigger scope

Every v0.2 trigger is **self-referential**: a source reacts only to events about
itself. The exceptions are `on_turn_start` and `on_turn_end`, which fire for
everything a player controls on their own turn.

There is deliberately no "whenever _another_ unit is defeated". That would be a
card-design decision about what the trigger vocabulary means, and nothing in the
bundled set needs it.

Relatedly, `on_sacrifice` and `on_defeated` **both** fire when a unit is
sacrificed: sacrifice emits `unit_defeated` with `reason: 'sacrificed'`, and
`on_defeated` matches any defeat. That is now **confirmed — implemented** (Q24):
a sacrificed unit counts as defeated, and the `reason` is retained so a future
card can filter on it.

---

## Phase 2 engine placeholders

Everything else the engine had to assume in order to run, with where to change
it and whether CLAUDE.md §17 has since ruled on it.

| Placeholder                                                                                                                                  | Status                                                                                                                               | Where it lives                            |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| A search may legally find nothing (`minimum: 0`)                                                                                             | Confirmed for **hidden** zones only; public zones must be mandatory unless the effect says `up_to`/`may` — **not implemented** (Q25) | `effects.ts`, `search_zone`               |
| Player healing has no upper bound                                                                                                            | Confirmed — implemented (Q26); a per-effect maximum is a later schema addition                                                       | `damage.ts`, `healPlayer`                 |
| Triggers created mid-card are appended, so the rest of that card's instructions resolve first                                                | Confirmed — implemented (Q28)                                                                                                        | `queue.ts`, `pumpQueue`                   |
| `while_source_present` duration behaves as `permanent`                                                                                       | Open; subsumed by the `staticAbilities` layer (Q2)                                                                                   | `flow.ts`, `expireEndOfTurnEffects`       |
| A spell is unplayable when a **required** target has no legal option; a unit or relic still enters play and its deploy effect simply fizzles | Open                                                                                                                                 | `engine.ts`, `spellHasLegalTargets`       |
| Damage reduction order: `armored` first, then prevention shields                                                                             | Open; depends on Q4                                                                                                                  | `damage.ts`, `damageUnit`                 |
| Leaving a live match concedes; losing the socket starts the grace window instead                                                             | Open; free-for-all raises the stakes (Q34)                                                                                           | `match-server.ts`, `leave` / `disconnect` |

---

## Turn phases

Implemented in Phase 2A as an explicit state machine
(`packages/rules-engine/src/flow.ts`), exactly as recorded in
[confirmed-rules.md](./confirmed-rules.md). Phase legality is enforced by the
engine; the UI only renders what `legalActions` reports.

Still provisional: the phase list itself. Nothing so far suggests it is wrong.

---

## Artwork

`768 × 1024 px` PNG, per the spec, is what the placeholder generator emits and
what the card frame reserves space for. Marked "unless implementation testing
exposes a better choice" — nothing so far suggests it should change.

---

## Simulator analysis thresholds

**Not game rules.** Nothing in this section changes how a match plays. These are
the numbers the Phase 4 balance analyser uses to decide when to ask a human to
look at something, and they are listed here so they are not mistaken for
confirmed values of anything.

All of them live in one validated block (`analysisSettings` in
`apps/simulator/src/config.ts`), are written into every experiment's
`config.json`, and are overridable per experiment.

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

These are guesses. They were chosen to be legible rather than tuned, and nobody
has run enough matches against a real card pool to say whether any of them is
right — that is **Q14** in [open-questions.md](../open-questions.md). The
analyser never converts a threshold into a verdict: it produces
`review_recommended`, `possible_interaction`, `insufficient_data` or
`run_quality`, always with the evidence, the sample size and the interval
attached, so the number can be argued with.
