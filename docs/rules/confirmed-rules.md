# Confirmed game direction

The settled direction for the game, as of Phase 1. Values marked _provisional_
are configurable and tracked in [open-decisions.md](./open-decisions.md).

Rules are never changed silently. If something here turns out to be wrong,
change it here first, then in the code.

## Decks and Commanders

- Every deck has exactly **one** Commander, external to the deck list.
- A Commander has a colour identity of one or more colours.
- A card is legal in a deck only when **every** colour in its colour identity
  appears in the Commander's colour identity.
- Neutral/colourless cards (empty colour identity) are legal under any
  Commander.
- Deck size: **30** cards _(provisional)_.
- Copy limit: **2** of a regular card, **1** of a unique card _(provisional)_.
- Commanders start at one or two colours _(provisional cap)_.
- All cards are unlocked. There is no collection, progression or monetisation.

**Implemented in Phase 1:** all of the above, in `@tcg/deck`.

## Match direction

_Not implemented in Phase 1 — recorded so Phase 2 has a written target._

- Universal energy rises automatically each turn. There are no land cards and
  no colour-specific resources.
- First online target is 1v1 through private invite-code lobbies.
- No accounts and no public matchmaking initially.
- The attacker declares attackers; the defending player assigns blockers.
- Blocked units deal combat damage **simultaneously** unless an effect says
  otherwise.
- Damage stays on units between turns until healed or the unit is defeated.
- There are **no** opponent-turn spells, no priority system and no stack.
- Commander recovery after defeat is intended; the duration is unsettled.
- Multiplayer means a genuine 2–4 player free-for-all, not parallel 1v1s.

## Turn phases

Provisional, and to be built as an explicit state machine — never inferred from
UI flow:

```text
Turn Start
Draw
Main Phase
Declare Attackers
Assign Blockers
Resolve Combat
Second Main Phase
Turn End
```

## Card identity

- Every card has a permanent ID in `lowercase_english_snake_case`.
- IDs are lowercase ASCII letters, digits and underscores only, and never
  change after release.
- Display names are separate from IDs and may change or be localised.
- Decks, replays, logs and artwork all reference cards by ID.

**Implemented in Phase 1:** enforced by `cardIdSchema`, and covered by tests.

## Card behaviour

- Card behaviour is **structured data**. The game never reads human-readable
  text to decide what a card does.
- `displayText` is presentation only.
- The same card definitions and rules must serve the web client, the server,
  tests and the simulator.
- Randomness is seeded and reproducible.
- Saved formats are versioned and validated at runtime.
