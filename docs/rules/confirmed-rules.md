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

**Implemented in Phase 2:** all of the above except Commander recovery, which is
deliberately deferred, and free-for-all, which is Phase 3. See
[ADR 0005](../architecture/0005-rules-engine.md).

## Turn phases

An explicit state machine in `packages/rules-engine/src/flow.ts` — never
inferred from UI flow. The phase list itself is still provisional:

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

`Assign Blockers` is skipped when no legal attacker was declared. Players
explicitly pass each Main Phase and confirm attackers and blockers.

**Implemented in Phase 2:** the machine, plus the mulligan and setup states that
precede turn 1.

## Effect resolution

- One deterministic FIFO resolution queue. No stack, no priority, no
  player-orderable triggers.
- A card's instructions resolve in authored array order.
- After each instruction: state-based checks, then trigger discovery, then the
  new triggers are appended to the queue.
- Simultaneous triggers are ordered by active player, then source instance
  creation order, then trigger index within the card definition.
- A mandatory choice pauses the queue. Only the expected player's valid choice,
  a concession, or a server timeout is accepted while it is pending.
- Runaway resolution terminates with a structured engine error and a complete
  log rather than hanging.

**Implemented in Phase 2:** all of the above, in `queue.ts` and `triggers.ts`.

## Victory and termination

- A player loses at zero or less Health, on being required to draw from an empty
  deck, or on conceding.
- Losses are checked after every atomic instruction and state-based check, and
  after simultaneous combat damage.
- Both players losing in the same check is a draw.
- A disconnected player has a configured reconnection window; expiry counts as a
  loss, submitted as an explicit server action rather than wall-clock logic
  inside the engine.

**Implemented in Phase 2:** all of the above.

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
