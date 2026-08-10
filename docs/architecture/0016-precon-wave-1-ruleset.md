# 16. Precon Wave 1 ruleset — format, battlefield, Relics, Commanders, Reactions

Date: 2026-08-10
Status: Accepted
Supersedes parts of: [0002](0002-card-data-model.md), [0003](0003-deck-save-format.md),
[0005](0005-rules-engine.md), [0008](0008-continuous-effects.md)

## Context

`CLAUDE_RULESET_UPDATE.md` introduces the first authored card catalog — 155 cards
across four factions, plus four 40-card singleton precons — and in doing so
replaces five rules the prototype had implemented and tested:

| Old rule                            | New rule                                        |
| ----------------------------------- | ----------------------------------------------- |
| 30-card decks, 2 copies of a card   | 40-card decks, singleton (one copy of each ID)  |
| Five Unit slots per player          | No Unit limit at all                            |
| Three Relics per player             | Exactly one active Relic per player             |
| `guardian` printed but inert        | Guardian is real must-block engine behavior     |
| No opponent-turn actions whatsoever | Bounded Reaction windows around combat + Spells |

It also promotes Commanders from zone-only passive leaders to deployable
battlefield permanents, which reverses decision **B3** taken during the
pre-card-authoring readiness milestone
(`PRE_CARD_AND_AGENT_TESTING_READINESS.md` B3), and revives
`guardian`, which **B2** had frozen as prototype-only.

The update's §18 lists thirteen decisions as deliberately unresolved and
forbids inventing answers to them. Four of those blocked the catalog, and were
put to the project owner as narrow questions rather than assumed.

## Decision

### 1. Format is data, not a constant

`DEFAULT_DECK_FORMAT` is replaced by a versioned `PlayFormat` loaded from
`content/formats/*.json`. A format names the sets it draws from and carries a
`DeckConstruction` block (`size`, `singleton`, `copyLimit`, `uniqueCopyLimit`,
`maxCommanderColors`, `commanderOutsideDeck`).

`singleton` is its own flag rather than `copyLimit: 1`. The two produce
different validator behavior: a singleton format rejects a repeated card **by
identity**, and must do so even when an import splits the same card ID across
several deck entries. Collapsing it to a copy limit would let
`[{scout, 1}, {scout, 1}]` pass.

Two formats ship:

- `development` — the `prototype_core` fixture set, 30 cards, 2 copies. It
  exists so every Phase 1–4 regression test keeps exercising the construction
  rules it was written against.
- `precon_wave_1` — the authored set, 40 cards, singleton.

### 2. The battlefield is unbounded

`unitSlots` is removed from the rules configuration rather than raised. There is
no hidden replacement cap: Energy is the intended constraint, and the update's
§17 telemetry exists precisely to find out whether that is sufficient.

Units keep individual instance identity. Identical Tokens may be **grouped for
presentation**, but a stack is never one object: each Token in it attacks,
blocks, exhausts, takes damage, and is targeted on its own.

### 3. One active Relic, replaced rather than destroyed

`relicSlots` becomes 1. Playing a second Relic moves the first to its owner's
discard pile as a **rules action** — not destruction and not a sacrifice, so it
triggers neither `on_defeated` nor `on_sacrifice`. This is a distinct event
(`relic_replaced`) so a future card can key off it without reinterpreting
discard events.

### 4. Commanders are deployable

A Commander starts in the Commander zone, is never in the 40-card deck, and is
never drawn. Playing it pays its printed cost and moves it to the battlefield as
a Newly Deployed permanent that behaves as a Unit for readying, combat,
targeting, damage and activation costs.

Commander **defeat lifecycle is not implemented**, because §18 leaves it open.
The zones and events are modeled so the policy can be dropped in later:
a defeated Commander moves to `commander_zone` and the match continues. No
recovery timer, replay tax, or Commander-defeat loss condition is invented.

### 5. Reactions are a card type with bounded windows

`reaction` joins the card type union. A Reaction declares one or more structured
timing conditions and is legal only inside the matching window:

```text
after_attackers_declared │ before_blockers_declared │ after_blockers_declared
after_combat_damage      │ after_combat             │ when_opponent_plays_spell
```

The turn state machine gains three explicit reaction windows (after attackers,
after blockers, after combat) plus a spell-response window. **Reactions do not
introduce a priority stack.** The provisional chaining policy — versioned and
documented in `docs/rules/open-decisions.md`, deliberately replaceable — is:

- one window opens per triggering event, in seat order starting from the
  non-active player;
- each eligible player may play **at most one** Reaction per window;
- a Reaction cannot be responded to by another Reaction;
- the window closes when every eligible player has acted or declined.

This is the smallest policy that makes every authored Reaction playable while
staying deterministic and bounded. It is not proposed as the final rule.

## Resolved §18 questions

These four were answered by the project owner on 2026-08-10. Each remains a
provisional playtest rule, not a permanent one.

### Q-A. "The enemy Commander" as a damage/heal target means **the player**

`deal damage to the enemy Commander` resolves to the opposing player's Health,
and `restore Health to your Commander` to the controller's own Health. The six
cards that use the phrasing are therefore always live, whether or not any
Commander has been deployed.

_Consequence:_ a deployed Commander's printed Health and its controller's 20
Health stay entirely separate pools. Combat damage to a deployed Commander is
marked on the permanent; card text naming "the Commander" hits the player.

### Q-B. `Newly Deployed` lasts until its controller's next turn begins

It survives opponents' turns and clears at the controller's Ready Step. This is
classic summoning sickness, and it is what makes `mass_displacement` able to
bounce attackers that were deployed during the previous turn cycle.

### Q-C. A Newly Deployed Unit without Rush **may block**

§8's restriction list — cannot attack, cannot pay an `Exhaust this source` cost
— is read as exhaustive. This matches the pre-existing engine behavior, so no
Phase 1–3 test changes.

### Q-D. Overwhelm is calculated **before** Barrier prevents

For a blocked attacker with Overwhelm, in order:

1. Assign damage equal to the blocker's **current Health** to the blocker.
2. Deal any remaining damage to the defending player.
3. Barrier prevents the damage assigned to the blocker, then is removed.
4. Barrier does **not** prevent the Overwhelm damage dealt to the player.

> **Flagged divergence.** The update's §9 describes the split as "damage up to
> the blocker's **remaining lethal requirement**… account for marked damage and
> prevention consistently", which subtracts damage already marked on the
> blocker. The answer above says "current Health", which does not. The two
> differ whenever the blocker is already damaged: against a 10-ATK Overwhelm
> attacker, a 3/5 blocker with 4 marked damage sends 5 to the blocker and 5 to
> the player under the implemented rule, versus 1 and 9 under §9's wording.
> The implemented behavior is the explicit answer; this note exists so the
> divergence is visible and cheap to reverse. See
> `docs/rules/open-decisions.md`.

## Consequences

- `rules-engine` gains Newly-Deployed state, five real keywords, a Reaction
  window state machine, Relic replacement, and Commander deployment. Every one
  of them is engine behavior; none is reminder-text parsing, and none is keyed
  to a card ID.
- The match-state, deck, replay and protocol schemas are versioned and migrated;
  saved decks built under the 30-card format keep loading and are reported as
  illegal in `precon_wave_1` rather than silently rewritten.
- Removing the Unit cap makes board size unbounded in state and in network
  payloads. §17 telemetry records per-round and peak Unit counts, largest
  combat, and stall detection so the decision can be judged on evidence rather
  than reverted on impression.
- Nine §18 items remain open and are tracked in `docs/rules/open-decisions.md`.
