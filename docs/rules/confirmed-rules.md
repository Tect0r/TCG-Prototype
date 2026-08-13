# Confirmed rules

The rules the game **actually implements**, with the module that enforces each
one. Everything here is settled: it is not a plan, and it is not a placeholder.

Three files divide the whole rules record between them, and nothing belongs to
more than one:

| File                                         | Holds                                                  |
| -------------------------------------------- | ------------------------------------------------------ |
| this file                                    | implemented, settled rules                             |
| [open-decisions.md](./open-decisions.md)     | implemented rules whose **value** is still provisional |
| [../open-questions.md](../open-questions.md) | questions with **no answer yet**                       |

The player's copy of these rules is the in-app rulebook
(`packages/help-content/src/data/rulebook.json`), which reads its numbers out of
the live `RulesConfig` and its keyword definitions out of `KEYWORD_REGISTRY`.
This file is the developer index to the same ruleset and deliberately does not
restate the rulebook's prose — two copies of player-facing wording is exactly
the drift M07 exists to remove.

Rules are never changed silently. If something here turns out to be wrong,
change it here first, then in the code.

## Decks and Commanders

- A format is **data**, not a constant: `content/formats/*.json`, flattened by
  `deckFormatOf`. `precon_wave_1` is 40 cards, singleton, one Commander outside
  the deck, Commander colour identity capped at two. `development` is the
  30-card / 2-copy fixture format the Phase 1–4 regression suites use and is not
  a playtest format.
- A card is legal in a deck only when **every** colour in its colour identity
  appears in the Commander's. An empty colour identity (neutral) satisfies that
  vacuously and is legal under any Commander.
- A deck containing a card the engine cannot fully execute is **illegal by
  name**. No surface routes around it; the spectator's developer override marks
  the replay and its telemetry `resultsValid: false`.
- Any playable pool is obtained through a format-scoped database, never the
  bundled card universe.
- All cards are unlocked. There is no collection, progression or monetisation.

**Enforced in:** `@tcg/deck` (`validateDeck`, `validatePrecon`, `reviewPrecon`,
`deckFormatOf`); the builder, the lobby, the match server and the simulator all
call the same functions.

## Commanders

- A Commander is deployed from the Command Zone onto the battlefield as a Unit
  and then attacks, blocks and is damaged under exactly the ordinary rules.
- On defeat it returns **immediately** to the Command Zone. Lethal damage,
  destruction and sacrifice are all the same route; there is no other
  destination.
- Each defeat adds `commanderCostPerDefeat` Energy to its future deployment
  cost, with the **total** cost capped at `commanderCostCap`.
- Losing a Commander is not losing the match, and a Commander's defeat is not a
  loss condition of its own.
- A Commander ability is active only in its structured `activeZone`.
- Damage or healing aimed at a **player** targets the player, never that
  player's deployed Commander Unit. The two are separate targets.

**Enforced in:** `rules-engine/src/commander.test.ts`, `engine.ts`,
`state-based.ts`, `config.ts` (`commanderCostPerDefeat`, `commanderCostCap`).

## The battlefield and Relics

- The battlefield has **no Unit limit**. There is no `unitSlots` dial and must
  not be one: the cap was removed rather than raised, and Energy is the intended
  constraint. Large boards are measured by `@tcg/board-telemetry`, not treated
  as proof that a cap is needed.
- Each player has **one active Relic**. Playing another replaces the current
  one; replacement is neither defeat nor sacrifice and triggers neither.

**Enforced in:** `rules-engine/src/engine.ts` and `legal-actions.ts` under
`config.ts#relicSlots`; `relics.test.ts`.

## Turn structure

Turns are taken one at a time in a fixed circle fixed at match creation. The
turn machine is explicit and is never inferred from UI flow:

```text
setup → mulligan → turn_start → draw → main_1 → declare_attackers
      → assign_blockers → resolve_combat → main_2 → turn_end
```

`reaction_window` is an eleventh phase that interrupts the sequence and records
the phase to return to; `complete` ends the match.

- `turn_start` is the **Ready Step**, and it runs three fixed stages in order:
  stored skips, then standing replacements, then readying. It is the one part of
  turn start that can pause for a choice, and only when there is something to
  decide and a controller who can pay for it.
- `Newly Deployed` clears at its controller's next Ready Step. It prevents
  attacking and Exhaust-cost abilities, and does **not** prevent blocking. Rush
  bypasses those two restrictions without removing the state.
- Energy refills to the player's maximum at the start of their turn. Whatever is
  unspent stays with them until then — that is what pays for a Reaction on
  another player's turn.
- `assign_blockers` is skipped when no legal attacker was declared. Players pass
  each Main Phase explicitly and confirm attackers and blockers explicitly.

**Enforced in:** `rules-engine/src/flow.ts`, `schema/primitives.ts#MATCH_PHASES`,
`replacement.ts`.

## Playing cards, and Reactions

- Outside your own Main Phases you may do exactly two things: assign blockers
  when you are attacked, and play a Reaction inside an open window. There is no
  free-floating priority and no general stack.
- A window opens after attackers are declared, after blockers are assigned,
  after combat damage has settled, and when a player plays a spell — and only if
  somebody holds a Reaction whose timing fits and whose cost they can pay.
- Priority is offered to the active player first, then clockwise, and only to a
  player with something legal to play. Each eligible player may play at most
  `reactionsPerPlayerPerWindow` Reaction per window. Playing one restarts the
  round of priority. The window closes when everybody declines in a row.
- Pending cards resolve **last in, first out**; the spell a window opened around
  sits at the bottom and resolves last.
- Costs are **atomic**. An interactive cost pauses before anything is committed
  and is revalidated when it is answered. A card's own `additionalCosts` are
  paid before an opponent's Reaction window opens, so **countering never refunds
  a paid cost**.
- A countered card goes to its owner's discard pile having done nothing.

**Enforced in:** `rules-engine/src/reactions.ts`, `costs.ts`, `engine.ts`.

## Combat

- Each attacker independently picks one **living opponent**. Units attack
  players and never other units, at any player count. Every declared attacker
  exhausts immediately, blocked or not.
- Only the attacked player may block, and only attacks aimed at them. There is
  no third-party blocking.
- A blocker must be Ready, and blocking exhausts it. One blocker per attacker
  (`blockersPerAttacker`), each blocker blocking at most one attacker.
- Evasive attackers cannot be blocked. Guardian makes blocking compulsory: a
  defender must block at least as many aimed attacks as they control ready
  Guardians, though not necessarily with the Guardians themselves, and attacks
  they could not legally block do not count toward the obligation.
- Blocked units deal damage **simultaneously**, except that Quick Strike deals
  its damage in an earlier step and anything defeated there never strikes back.
- **Overwhelm splits against the blocker's current Health** — marked damage does
  not increase the overflow — and it splits **before** Barrier prevents the
  blocker's share. Barrier does not prevent the excess dealt to the player. This
  is a deliberate divergence, recorded in ADR 0016 Q-D.
- If a blocker leaves play before damage, the attacker stays blocked and deals
  nothing to the player.
- When several players are attacked at once, each answers separately and nobody
  sees another defender's blocks until every defender has submitted.

**Enforced in:** `rules-engine/src/combat.ts` (`buildHits`), `damage.ts`,
`legal-actions.ts` (`attackCensus`, Guardian obligation), `blocking.test.ts`.

## Damage, defeat and elimination

- Damage stays marked on a unit between turns until healed or the unit is
  defeated.
- A player loses at zero or less Health, on being required to draw from an empty
  deck, on conceding, or on an explicit server timeout action. Losses are checked
  after every atomic instruction and state-based check, and after simultaneous
  combat damage.
- The last living player wins. All remaining players losing in the same
  state-based check is a draw.
- Elimination is a fixed cleanup: the seat drops out of turns, choices and
  combat; their cards leave every zone (their Tokens cease to exist, their cards
  go to the terminal `removed` zone); their static, delayed and queued effects
  end; other players' cards they controlled return to their owners; their
  unresolved choices are cancelled; attacks aimed at them are dropped before
  damage, leaving those attackers exhausted and non-retargeting — and then
  state-based checks and trigger discovery run **once** for the whole cleanup.
- `removed` is a real zone that nothing may target, read or count into an
  effect, which is what keeps it terminal.
- Elimination **reveals nothing**. Redaction is absolute: a defeated player's
  hand, deck order and `removed` pile never enter a survivor's view.
- Ownership and control are explicit in serialised state, never inferred from
  which battlefield a card sits on.

**Enforced in:** `rules-engine/src/state-based.ts`, `zones.ts`, `view.ts`.

## Effect resolution

- One deterministic FIFO resolution queue for effects and triggers. A card's
  instructions resolve in authored array order.
- After each instruction: state-based checks, then trigger discovery, then the
  new triggers are **appended** — so all of the current card's instructions
  finish before any trigger it created resolves.
- Simultaneous triggers order by active player, then clockwise seat order, then
  source instance creation order, then trigger index within the definition.
  There is no player-orderable trigger ordering.
- A mandatory choice pauses the queue. Only the expected player's valid choice, a
  concession or a server timeout is accepted while it is pending. Every pending
  choice carries `provenance` saying why it exists, and carries no card identity.
- A **replacement is not a trigger**: an arrival or a readying is rewritten as it
  happens, nothing observes the un-rewritten state, no Reaction window opens
  between the two, and removing the source afterwards does not undo it.
- A delayed effect is bound once — boundary, source, controller, subject and
  provenance — and never re-targeted. A subject that changes zone ends the
  entry, and no entry survives the turn it was made on.
- Runaway resolution terminates with a structured engine error and a complete log
  rather than hanging (`maxResolutionSteps`, `maxRepeatedStates`).

**Enforced in:** `rules-engine/src/queue.ts`, `triggers.ts`, `replacement.ts`,
`delayed.ts`, `effects.ts`.

## Tokens

- A Token that leaves the battlefield ceases to exist rather than moving zone.
- Tokens retain **individual engine identity** even when grouped visually. A
  visual stack is a presentation tile, not a targeting unit, and it has no
  identity in the engine.
- A card that names a Token group (`groupByTokenDefinition`) expands the chosen
  Token into every Token of the same **definition** controlled by the same
  player, whatever state each is in — so one such effect deliberately reaches
  across several visual tiles.

**Enforced in:** `rules-engine/src/zones.ts`, `targeting.ts#expandTokenGroup`;
presented by `apps/web-client/src/lib/token-grouping.ts`.

## Multiplayer

- 2–4 player free-for-all, run through the same engine paths as 1v1. The mode is
  recorded for logs and presentation and is never branched on for a rule.
- Seat order is a seeded shuffle taken from the match seed before anything else
  consumes randomness, so it is reproducible from the seed and not from the join
  sequence. Two seats are left unshuffled: there is no position to win.
- `each_opponent` resolves clockwise from the seat after the controller;
  `all_players` is the controller first, then clockwise, as one atomic
  instruction.
- No teams. Every player competes independently and the state model is flat.
- The host alone changes the lobby maximum and starts the match; the maximum
  cannot be lowered below the number of occupied seats; the host leaving before
  the start closes the lobby. A 1v1 starts by itself once both seats are ready,
  while a three- or four-seat table waits for an explicit `start_match`.
- Each seat has an independent disconnect token and grace window, and one
  disconnect does not stop the match. Expiry is submitted as an explicit server
  action; the engine never reads a clock.

**Enforced in:** `rules-engine/src/setup.ts`, `targeting.ts`,
`apps/multiplayer-server/src/match-server.ts`, `@tcg/protocol`.

## Card identity and data

- Every card has a permanent ID in `lowercase_english_snake_case` — lowercase
  ASCII letters, digits and underscores only — that never changes after release.
  Decks, replays, logs and artwork all reference cards by ID.
- Display names are separate from IDs and may change or be localised. The engine
  keeps prose out of match state entirely: a pending choice carries a `reason`
  code and the client turns it into a sentence.
- Card behaviour is **structured data**. Display text is never parsed into
  behaviour, and `displayText` is presentation only — cross-checked in both
  directions by the content build, which reports prose promising behaviour the
  card lacks _and_ behaviour the card performs that the prose never mentions.
- `deployed` and `entersBattlefield` are different triggers and are reviewed card
  by card, never bulk-converted. The standing review is
  [entry-trigger-review.md](./entry-trigger-review.md).
- The same card definitions and rules serve the web client, the server, the tests
  and the simulator. Randomness is seeded and reproducible; saved formats are
  versioned and validated at runtime.
- The engine is deterministic, serialisable, authoritative and independent of UI
  timing. Bots receive only their observation boundary, and analysis-mode
  information never leaks into a normal match.

**Enforced in:** `@tcg/card-data` (`cardIdSchema`, `loader.ts`,
`display-text.ts`, `support.ts`), `@tcg/rules-engine`, `@tcg/bot-interface`.
