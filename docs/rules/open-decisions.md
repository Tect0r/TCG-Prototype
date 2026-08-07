# Open design decisions

Everything here is **unconfirmed**. Each entry records what the code does today,
why, and what has to happen before it can be called settled. Nothing in this
file may be treated as a confirmed rule.

Where a value is provisional, the implementation keeps it configurable rather
than inlining it, so playtesting can move it without a rewrite.

---

## Deck construction

| Decision             | Current value | Where it lives                           |
| -------------------- | ------------- | ---------------------------------------- |
| Deck size            | 30            | `DEFAULT_DECK_FORMAT.deckSize`           |
| Copies of a card     | 2             | `DEFAULT_DECK_FORMAT.copyLimit`          |
| Copies of a unique   | 1             | `DEFAULT_DECK_FORMAT.uniqueCopyLimit`    |
| Commander colour cap | 2             | `DEFAULT_DECK_FORMAT.maxCommanderColors` |

`validateDeck(deck, database, format)` takes the format as an argument, so an
experiment only needs a different config object — no code change.

**Needs playtesting:** whether 30 cards gives enough consistency without making
every deck the same, and whether the two-colour Commander cap should open up to
three once the colour pie exists.

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

Eight provisional keywords exist so cards can be authored and filtered:
`swift`, `guardian`, `evasive`, `armored`, `siphon`, `venom`, `quick_strike`,
`resilient`. Their reminder text in `vocabulary.ts` is a **first draft of intent,
not a rules definition** — none of them execute yet.

**Open:** exact wording and interaction of every keyword. In particular:

- Does `guardian` force blocks, or only restrict which attacks may be ignored?
- Does `armored` reduce each instance of damage, or total damage per turn?
- Does `resilient` interact with the "damage persists between turns" rule in a
  way that makes it strictly better than healing?

---

## Tokens and colour identity

A card that creates a coloured token arguably carries that colour. The loader
emits a **warning** (`card_data/token_color_leak`), not an error, when a card
creates a token whose colours are not in the creating card's identity.

**Open:** whether this should be a hard rule. If it becomes one, promote the
warning to an error in `loader.ts`. The bundled set already respects it.

---

## Commander recovery

The spec proposes three turns after a Commander is defeated. **Not implemented
and not modelled** — there is no rules engine yet. No number is baked in
anywhere, so nothing has to be undone when this is settled.

---

## Card-schema questions deferred to Phase 2

- **`effects` vs. `abilities`.** `effects` resolves when the card is played
  (spell resolution, unit deploy); `abilities` are `{ trigger, effects }` pairs
  that fire while the card is in play. The `on_deploy` trigger therefore
  overlaps with a unit's `effects`. Both validate; the bundled set uses
  `effects` for play-time behaviour and `on_deploy` only where the ability
  reads more naturally as a triggered one. Worth collapsing to one form once
  the engine exists — see [ADR 0002](../architecture/0002-card-data-model.md).
- **Static abilities.** The trigger vocabulary has no "while this is in play"
  trigger, so continuous effects (cost reduction auras, static buffs) are
  currently expressed as `on_turn_start` approximations. This needs a real
  answer before those cards can be implemented.
- **Costs vs. effects.** `sacrifice` is modelled as an effect. Whether
  sacrificing is a _cost_ (paid before resolution, cannot be undone) or an
  _effect_ (part of resolution) changes how it interacts with countering and
  targeting. No stack exists in v0.1, so this is deferrable.

---

## Turn phases

The provisional phase list from the spec is recorded in
[confirmed-rules.md](./confirmed-rules.md) but is **not yet implemented**;
there is no state machine in Phase 1. When it is built, phases must be explicit
states, not implied by UI flow.

---

## Artwork

`768 × 1024 px` PNG, per the spec, is what the placeholder generator emits and
what the card frame reserves space for. Marked "unless implementation testing
exposes a better choice" — nothing so far suggests it should change.
