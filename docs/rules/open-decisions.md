# Open design decisions

Everything here is **unconfirmed**. Each entry records what the code does today,
why, and what has to happen before it can be called settled. Nothing in this
file may be treated as a confirmed rule.

Where a value is provisional, the implementation keeps it configurable rather
than inlining it, so playtesting can move it without a rewrite.

Phase 2A forced a decision on several things that are genuinely still open. In
every such case the engine ships the smallest, most reversible placeholder, and
this file records exactly what it does and where to change it. A placeholder is
not an answer — the questions stay open in
[open-questions.md](../open-questions.md).

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
  Phase 2 combat model: attackers target the opposing _player_ and never choose
  a unit to attack, so "must be blocked by a guardian" has nothing to attach to.
  Inventing a different meaning would be guessing at a design decision nobody
  has made. Cards keep the keyword, the deck builder keeps filtering on it, and
  a regression test asserts that a guardian blocker currently behaves exactly
  like any other blocker.
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
that subsystem in Phase 2"). Commanders do not enter the battlefield, are never
defeated, and the `recovery` zone exists in the schema with nothing that can
enter it.

One consequence worth knowing: Commander abilities triggered by `on_attack`,
`on_block`, `on_survive_combat`, `on_deploy`, `on_defeated` or `on_sacrifice`
can **never fire** in Phase 2, because a Commander never does any of those
things. Four of the eight bundled Commanders have such abilities and are
effectively vanilla for now. That follows from the deferral; it is not a bug.

Commander _passives_ that hang off `on_turn_start` / `on_turn_end` do work, from
the Commander zone, as CLAUDE.md §4 requires.

---

## Card-schema questions: what the engine does today

These remain open questions ([open-questions.md](../open-questions.md) Q1–Q3).
The engine could not run without picking something, so each has a placeholder
chosen to be the smallest and most reversible option.

### `effects` vs. `abilities` (Q1)

**Still open.** Today the engine treats a unit's or relic's top-level `effects`
as its deploy effects: they are enqueued when the card enters play, immediately
before any `on_deploy` triggered ability on the same card. For a spell,
`effects` are its resolution instructions.

Both authoring forms work and produce the same observable result for the bundled
set. Collapsing them to one form is still worth doing; the engine does not force
the answer either way. See
[ADR 0002](../architecture/0002-card-data-model.md).

### Static and continuous abilities (Q2)

**Still open, and still a real gap.** There is no continuous-effects layer.

Concretely:

- `modify_cost` is a turn-scoped modifier held on the player, so "your units
  cost 1 less this turn" works as written and expires at end of turn.
- `grant_keyword` and `modify_stats` apply **once, to whatever is on the board
  at that moment**. `radiant_bulwark` reads "your units gain Armored"; the
  engine grants Armored to units present when it is deployed and does _not_
  grant it to units that arrive later.

That divergence between text and behaviour is a consequence of Q2 being open,
not a bug to fix in isolation. Lord-style and aura cards should not be authored
until Q2 is answered.

### `sacrifice` as cost or effect (Q3)

**Still open.** Modelled as an effect: it resolves in authored order like any
other instruction. With no stack in v0.2, nothing currently distinguishes the
two readings observably.

### Trigger scope

Every v0.2 trigger is **self-referential**: a source reacts only to events about
itself. The exceptions are `on_turn_start` and `on_turn_end`, which fire for
everything a player controls on their own turn.

There is deliberately no "whenever _another_ unit is defeated". That would be a
card-design decision about what the trigger vocabulary means, and nothing in the
bundled set needs it.

Relatedly, `on_sacrifice` and `on_defeated` **both** fire when a unit is
sacrificed: sacrifice emits `unit_defeated` with `reason: 'sacrificed'`, and
`on_defeated` matches any defeat. Whether a sacrificed unit should also trigger
death effects is a genuine design question. The current rule is at least simple
and changeable in one place (`triggers.ts`).

---

## Phase 2 engine placeholders

Everything else the engine had to assume in order to run, with where to change
it. None of these are confirmed rules.

| Placeholder                                                                                                                                  | Where it lives                            |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| A search may legally find nothing (`minimum: 0`)                                                                                             | `effects.ts`, `search_zone`               |
| `while_source_present` duration behaves as `permanent`                                                                                       | `flow.ts`, `expireEndOfTurnEffects`       |
| Player healing has no upper bound                                                                                                            | `damage.ts`, `healPlayer`                 |
| A spell is unplayable when a **required** target has no legal option; a unit or relic still enters play and its deploy effect simply fizzles | `engine.ts`, `spellHasLegalTargets`       |
| Damage reduction order: `armored` first, then prevention shields                                                                             | `damage.ts`, `damageUnit`                 |
| Triggers created mid-card are appended, so the rest of that card's instructions resolve first                                                | `queue.ts`, `pumpQueue`                   |
| Leaving a live match concedes; losing the socket starts the grace window instead                                                             | `match-server.ts`, `leave` / `disconnect` |

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
