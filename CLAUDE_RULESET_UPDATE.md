# TCG Prototype — Rules and Precon Update

## Purpose

Update the existing TCG prototype so the first four authored 40-card singleton precons can be loaded, selected, played, tested, and simulated using the same deterministic rules engine.

This file supersedes conflicting older prototype assumptions. In particular, it replaces the old 30-card/two-copy format, five-Unit battlefield limit, three-Relic limit, inert Guardian keyword, and blanket ban on Reactions.

The accompanying files are:

- `cards.json`: authoritative design records for 155 unique cards, including four Commanders and three Token definitions.
- `precons.json`: four exact 40-card singleton precon lists.

`rulesText` in `cards.json` is presentation and design authority during migration. It must never be parsed or interpreted at runtime. Convert every behavior into validated structured data before a card is considered implemented.

## 1. Non-negotiable engineering rules

- The server remains authoritative for online play.
- All rules live in the deterministic, headless rules engine, not in UI components, networking code, or animations.
- The web client, server, tests, replay system, and simulator use the same card definitions and rules implementation.
- Runtime card behavior is structured and schema-validated. Human-readable text is presentation only.
- Randomness is seeded and reproducible.
- Saved data, card data, precon data, match state, actions, choices, replays, and protocol messages are versioned and validated at runtime.
- Permanent card IDs use lowercase English snake case and never change.
- Preserve hidden-information boundaries, deterministic trigger ordering, replay determinism, stale-revision rejection, and structured engine failures.
- Do not implement special cases by card ID. Add reusable rule primitives.
- Do not silently weaken, omit, or approximate a card because the present schema lacks a mechanic. Extend the schema and engine, or report the card as unsupported with a precise reason.
- Add migrations for every persisted schema change.

## 2. Format and deck construction

- A legal deck contains exactly 40 cards.
- The format is singleton: no card ID may appear more than once in a deck.
- Each deck has exactly one Commander outside the 40-card deck.
- Tokens are not deckable and do not count toward deck size.
- A card is legal only if every color in its color identity is contained in its Commander's color identity.
- Neutral cards have an empty color identity and are legal under every Commander.
- All cards are unlocked. No collection, pack, rarity-economy, account-progression, or monetization system is part of the prototype.
- `Power` (`low`, `medium`, `high`) is an expected playtest strength label, not rarity.
- `Identity` is design metadata describing faction and gameplay function.
- Initial faction/color mapping for these precons is provisional but explicit:
  - Goblin Swarm: red
  - Containment Control: blue
  - Grave Sacrifice: black
  - Bastion Guardians: white
  - Shared cards: neutral/colorless

Replace `DEFAULT_DECK_FORMAT` with a versioned format configuration representing 40-card singleton. Validation must reject duplicate IDs even if separate entries are used.

## 3. Built-in precons

Add a validated precon schema and repository rather than treating precons as hard-coded UI fixtures.

Minimum precon shape:

```ts
interface PreconDefinition {
  schemaVersion: number;
  id: string;
  name: string;
  strategy: string;
  commanderId: CardId;
  cardIds: CardId[];
}
```

Requirements:

- Load `precons.json` through a runtime validator.
- Validate exactly 40 distinct deckable cards, one resolvable Commander, color legality, and no Tokens in the list.
- Reject missing, duplicate, non-deckable, or illegal IDs with actionable errors.
- Show precons in the deck builder as named starting points.
- A user can inspect a precon, copy it into an editable saved deck, and start a match with it.
- Built-in precon definitions are immutable. Editing creates a new user deck and never mutates the source precon.
- The simulator can address a precon by permanent precon ID.
- Exported user decks continue to use permanent card IDs.
- Add loader, validation, UI, simulator-source, and round-trip tests.

## 4. Match setup and provisional numeric rules

Keep existing configurable prototype defaults unless this document overrides them:

- Initial supported match: 1v1. Existing two-to-four-player free-for-all support must not regress.
- Starting Health: 20, provisional.
- Opening hand: 5 cards, provisional.
- One free opening redraw, provisional. Both players commit before either result is revealed.
- Maximum hand size: 10, provisional. Discard down at turn end.
- The seeded RNG selects the starting player. Existing seeded seat-order behavior for multiplayer remains.
- The first player skips their first normal draw, provisional.
- Attempting to draw from an empty deck causes that player to lose, provisional. Resolve multi-card draws one card at a time.
- A player loses at 0 or less Health, on an empty-deck draw, concession, or authoritative timeout. Simultaneous loss in one state-based check is a draw.
- Disconnect grace remains 90 seconds, provisional, and server-controlled. The engine remains clock-free.

Do not confuse the player's 20 Health with a battlefield Commander's printed Health. The exact relationship between player Health, Commander damage, Commander defeat, and Commander recovery is still an unresolved design item listed in §18.

## 5. Energy

- Energy is universal. There are no land cards or colored resources.
- Start at 1 maximum Energy on the player's first turn, provisional.
- At the start of that player's turn, maximum Energy increases by 1 up to 10, then current Energy refills to maximum.
- Unspent Energy remains available through opponents' turns so it can pay for Reactions, then is replaced by the normal refill on the player's next turn. It does not accumulate above maximum Energy.
- Costs are validated and paid atomically before a card or activated ability is placed into resolution.
- Cost reductions cannot reduce a cost below the minimum printed by the effect, normally 1 when specified.
- Additional costs such as sacrifice are paid even if the effect is later countered.
- If all required costs cannot be paid, the action is illegal.

## 6. Turn structure

Use explicit engine states and explicit passes:

```text
Turn Start / Ready
Draw
Main Phase
Declare Attackers
Reaction Window: After Attackers
Assign Blockers
Reaction Window: After Blockers
Resolve Combat
Reaction Window: After Combat
Second Main Phase
Turn End
```

- The engine, not the UI, enforces phase and window legality.
- Normal Units, Relics, Commanders, and normal Spells are playable only during the active player's Main Phases while the normal resolution queue is empty and no choice is pending.
- Activated abilities default to the controller's Main Phase unless their structured timing says otherwise.
- Reaction cards are playable only in their structured timing window or in response to the structured event printed on the card.
- Skip blocker assignment when no attackers remain eligible for combat.
- Players explicitly confirm attackers and blockers.

## 7. Battlefield and Unit count

- There is no Unit limit during the initial playtests.
- Remove the five-slot legality restriction from deck play, Token creation, state, UI, bot logic, and simulator assumptions.
- Do not replace it with another hidden cap.
- Energy is expected to constrain hand deployment. Token generation intentionally tests whether that soft constraint is sufficient.
- An unlimited battlefield is successful when large boards remain legible and tactically meaningful. Large boards are not automatically a failure.
- Keep Units as individual game objects with stable instance IDs.
- Identical Tokens may be visually stacked to reduce clutter, but a Token stack is presentation/grouping, not one Unit.
- Each Token in a visual stack can attack, block, Exhaust, Ready, be sacrificed, take damage, receive a buff, or be targeted individually.
- An effect affects one individual Unit unless it explicitly says every Unit in a Token stack or every matching Unit.
- Returning a Token to hand or moving it to any non-battlefield zone makes it cease to exist after relevant leave/defeat events have been emitted.

## 8. Unit state, deployment, and combat

- Units enter Ready unless an effect says they enter Exhausted.
- A deployed Unit is `Newly Deployed` for the relevant turn-cycle duration.
- Newly Deployed Units cannot attack or pay an `Exhaust this source` activation cost unless they have Rush.
- Rush permits a Newly Deployed Unit to attack and use its own Exhaust abilities immediately. Rush does not Ready an Exhausted Unit.
- Declaring a Unit as an attacker Exhausts it.
- A Ready Unit may attack once per turn.
- A Unit must be Ready to block. Declaring it as a blocker Exhausts it.
- One Unit blocks at most one attacker, and one attacker initially receives at most one blocker. Keep combat state extensible for possible multiple-blocker rules later.
- Attackers target an opposing player in 1v1 and an explicitly selected living opponent in multiplayer; Units are not attacked directly.
- The defender chooses legal blockers.
- Blocked attacker and blocker deal combat damage simultaneously unless Quick Strike or another explicit effect changes ordering.
- An unblocked attacker deals its ATK to the defending player.
- Negative ATK deals 0 damage.
- No excess combat damage reaches the defending player unless the attacker has Overwhelm.
- If a blocker leaves combat before damage, the attacker remains blocked and deals no player damage unless Overwhelm says otherwise.
- Damage remains marked on Units across turns until healed or the Unit leaves play.
- A Unit is defeated when marked damage is at least its current Health.
- After simultaneous damage, defeat all lethal Units simultaneously, then emit deterministic defeat events.
- Temporary stat changes expire at their specified boundary. Losing a temporary Health bonus can defeat a Unit during the next state-based check.

## 9. Keywords and named states

Implement and document these as engine behavior, not reminder-text parsing:

### Rush

A Newly Deployed Unit may attack and activate abilities requiring it to Exhaust. Rush does not Ready a Unit.

### Guardian

While the defending player controls a Ready Guardian able to block an attacker, that attacker may not remain unblocked. The defender chooses which legal Guardian blocks it. Guardian does not allow one Unit to block multiple attackers.

If there are more attackers than legal Ready Guardians, each Guardian can satisfy only one block; remaining attackers may be blocked normally or left unblocked.

### Barrier

Prevent the next damage event that would deal damage to that Unit, then remove Barrier. A zero-damage event does not consume Barrier. Multiple instances do not stack unless the future schema explicitly supports counters.

### Overwhelm

When a blocked attacker assigns combat damage, damage up to the blocker's remaining lethal requirement is assigned to the blocker and excess damage is dealt to the defending player. Account for marked damage and prevention consistently. Final ordering with Barrier is a testable rules case.

### Untargetable by opponents

The opposing player cannot choose that Unit as a target. It may still be affected by non-targeting effects such as “every Unit,” combat, and its controller's effects.

### Ready and Exhausted

- Ready Units may perform actions that require Exhausting.
- Exhausted Units cannot attack, block, or pay an Exhaust-source cost.
- Units normally Ready during their controller's Ready Step unless an effect prevents that Ready event.

### Newly Deployed

Track this as structured state because several cards query it. Tokens are Newly Deployed when created. A Unit returned from discard directly to the battlefield is Newly Deployed.

Keep existing Swift, Evasive, Armored, Siphon, Venom, Quick Strike, and Resilient data compatible, but do not silently substitute Swift for Rush if both names remain exposed. Either migrate Swift to Rush with a schema migration and ID compatibility, or define the distinction explicitly.

## 10. Commanders

- Each player begins with exactly one external Commander in the Commander zone.
- The four authored Commanders have costs and combat stats and are intended to be deployable battlefield permanents.
- Playing a Commander pays its printed cost, moves it from the Commander zone to the battlefield, and marks it Newly Deployed.
- A Commander is not part of the 40-card deck and is never drawn.
- A deployed Commander behaves as a Unit for Ready/Exhaust, combat, targeting, damage, and activated-ability costs unless a rule or effect explicitly excludes Commanders.
- “Non-Commander Unit” excludes Commanders; “Unit or Commander” includes both.
- Commander static/passive text functions only in its documented active zone. Do not assume every printed ability functions from the Commander zone.
- Commander lifecycle after defeat is not yet established. Model the zones and events cleanly, but do not invent a recovery duration, tax, or loss condition. See §18.

## 11. Spells, Reactions, and counters

- Normal Spells resolve their structured effects in authored order, then move to discard.
- A Spell with no legal required target cannot be played.
- If a target becomes illegal before resolution, ignore that target while resolving remaining legal targets/instructions unless the definition requires all targets.
- Reactions are a card type or an explicit spell-speed field that the deck builder can filter and the rules engine can validate.
- A Reaction has one or more structured timing conditions, such as:
  - when an opponent plays a Spell;
  - before blockers are declared;
  - after attackers are declared;
  - after blockers are declared;
  - after combat damage;
  - after combat.
- Countering a card means it has no effect and moves to its owner's discard pile.
- A countered permanent never enters the battlefield.
- `Calculated Response` creates a structured pay-or-counter choice for the Spell's controller.
- Reactions do not justify an unrestricted MTG priority system. Implement deterministic, bounded Reaction windows around the required events.
- The exact policy for Reaction chaining and multiple players responding is unresolved. Use a versioned, documented minimal policy and keep it replaceable; do not hide it in UI flow.

## 12. Relics

- A player may control only one active Relic.
- Relics use a separate persistent battlefield zone and do not count as Units.
- Playing a Relic while controlling one replaces the existing active Relic.
- Replacement moves the previous Relic to discard as a rules action. It is not destruction or sacrifice unless a future rule says otherwise.
- Relics remain active until destroyed, replaced, sacrificed, or moved by an effect.
- “The active Relic” means the single Relic controlled by the relevant player. If an effect can refer to either player's Relic, its structured target/controller must make that explicit.

## 13. Tokens

- Goblin Token: 1 ATK / 1 Health Goblin Unit, no effect.
- Thrall Token: 1 ATK / 1 Health Thrall Unit, no effect.
- Guard Token: 0 ATK / 2 Health Unit with Guardian.
- Tokens are non-collectible and non-deckable.
- Tokens generate normal combat, sacrifice, defeat, and trigger events before ceasing to exist when moved away from the battlefield.
- Token multipliers use “one or more” batch semantics where printed.
- A multiplier must not trigger itself recursively when its own text excludes Tokens created by that effect.

## 14. Sacrifice and defeat

- Sacrifice chooses or identifies a permanent the player controls and defeats it with reason `sacrificed`.
- A sacrificed Unit triggers both sacrifice-specific and defeated triggers.
- Sacrifice can be an effect or an additional/activated cost.
- Costs are paid atomically before the resulting effect is queued.
- “Sacrifice another Unit” excludes the source.
- A Token can be sacrificed and triggers relevant abilities before ceasing to exist.
- A player cannot play a card or activate an ability requiring a sacrifice unless enough legal permanents are available.
- Multiple simultaneous sacrifices must preserve deterministic event order while counting all Units as sacrificed for aggregate conditions.

## 15. Trigger, condition, and continuous-effect requirements

Extend the structured vocabulary to express all authored designs, including:

- another friendly Unit or any other Unit being defeated;
- a Unit being sacrificed;
- a Unit or group being created;
- one or more Tokens being created as a batch;
- a Unit attacking, attacking alongside another subtype, or a threshold number attacking;
- a Unit blocking or surviving combat as a blocker;
- beginning/end of turn and beginning/end of each opponent's turn;
- the first event each turn/round;
- once-per-turn activations and optional payments;
- conditions based on Ready, Exhausted, Newly Deployed, controller, subtype/tag, cost, ATK, Health, number of Units, Units defeated this turn, or whether a Unit was deployed this turn;
- replacement effects such as entering Exhausted, preventing a Ready event, or replacing Token quantities;
- dynamic values such as “number of Goblins you control,” “other attackers,” and “one for every three”;
- capped and minimum values;
- delayed effects at end of turn;
- per-combat durations, until next turn, end-of-turn durations, and permanent modifiers;
- auras/lords that apply to current and future matching Units while the source remains active.

Continuous effects are derived from current state and never stamped permanently onto recipients. Recalculate after relevant state changes. Removing a continuous Health bonus immediately runs state-based checks.

## 16. Resolution and choices

- Keep one deterministic engine-controlled resolution queue. Do not derive behavior from animations or client timing.
- Instructions from one effect resolve in authored order.
- Complete the current atomic instruction, run state-based checks, emit events, discover triggers, and queue them deterministically.
- Finish all authored instructions of the current card/effect before resolving triggers created by those instructions.
- Simultaneous triggers are ordered by active player, then clockwise non-active players, then source-instance creation order, then trigger index.
- Mandatory choices pause resolution. Only the expected player's valid choice, concession, or server-authorized timeout is accepted.
- Hidden-zone searches may legally find nothing. Public-zone searches are mandatory when a legal result exists unless they say “may” or “up to.”
- Direct player and Commander targets must be first-class structured targets.
- Add structured selection for “up to N,” distribute N damage among legal targets, each player chooses, reveal one matching card, reorder inspected cards, and put remaining cards on the bottom.
- Add a configurable resolution-step limit and repeated-state safeguard. Fail with a structured error and diagnostic log rather than hanging.

## 17. Playtest telemetry for the unlimited battlefield

Record at least the following for every game and make them available to simulator reports:

- Unit count for each player at the end of every round;
- highest Unit count reached by each player;
- highest non-Token Unit count reached by each player;
- highest Token count and highest visual Token-stack size;
- longest turn and longest combat-resolution duration;
- number of declared attackers and blockers in the largest combat;
- number of triggers and choices in the busiest turn;
- whether the match reached a board stall;
- how the largest board was reduced or answered;
- winner, turn count, seat/starting-player information, deck/precon IDs, rules version, seed, and card-data version.

Do not automatically restore a Unit cap merely because boards become large. Treat these as failure signals:

- turns or combat regularly become excessively long;
- players frequently miss or cannot understand triggers;
- the UI cannot present legal choices clearly;
- neither player wants to attack for multiple rounds;
- wide boards universally dominate other strategies;
- state size or network payload becomes operationally unsafe.

If problems appear, first evaluate UI Token grouping, anti-wide interaction, sweepers, upkeep pressure, and engine/UI performance. Restore a hard Unit limit only after playtest evidence shows the soft Energy constraint is insufficient.

## 18. Explicit unresolved decisions — do not silently invent

These are not blockers for importing the design catalog or implementing unrelated mechanics, but they must remain visible:

- Exact Commander lifecycle after battlefield defeat: recovery zone duration, replay cost/tax, and whether Commander defeat can itself lose the game.
- Exact relationship between player Health, damage “to the enemy Commander,” and a deployed Commander's printed Health.
- Exact duration boundary for `Newly Deployed` across opponents' turns.
- Whether a Newly Deployed Unit without Rush may block before its controller's next turn.
- Whether multiple blockers may eventually block one attacker.
- Exact Reaction priority/chaining policy, including more than one Reaction to the same event and multiplayer ordering.
- Whether Barrier is consumed before or after other prevention/reduction effects.
- Exact Overwhelm interaction with Barrier and other damage prevention.
- Final starting Health, opening hand, mulligan, hand limit, Energy curve, and deck-out rule.
- Final multiplayer-specific rule values.
- Final faction/color names and mechanical color pie.
- Final behavior or migration fate of older keywords not used by these precons, especially Resilient.
- Alternate victory conditions and phase/choice timers.

When one of these becomes necessary for a playable test, surface the precise question and the smallest set of options. Do not bury a provisional answer as a permanent rule.

## 19. Required implementation sequence

1. Run the existing full verification suite and record the baseline.
2. Add an ADR/rules decision documenting the 40-card singleton format, unlimited Unit battlefield, one active Relic, deployable Commanders, Guardian definition, and bounded Reaction windows.
3. Version and migrate deck, card, match-state, replay, protocol, and rules configuration schemas as required.
4. Implement and test built-in precon loading/validation before adding UI selection.
5. Extend structured card types, keyword vocabulary, timing windows, triggers, conditions, dynamic values, replacements, costs, choices, and targets.
6. Migrate `cards.json` into runtime structured card definitions. Preserve the supplied IDs, stats, costs, labels, and rules meaning.
7. Add per-card validation that generated display text or authored display text matches structured behavior. Never execute display text.
8. Remove Unit-slot assumptions and implement scalable individual Unit state plus visual Token grouping.
9. Implement one-active-Relic replacement semantics.
10. Implement deployable Commanders without inventing the unresolved defeat/recovery rule; isolate that policy behind versioned configuration/state transitions.
11. Implement Reactions and their bounded timing windows with deterministic tests and hidden-information tests.
12. Add the four precons to the deck builder, match setup, and simulator.
13. Add scripted tests for every unique mechanic and at least one executable happy-path test for every card.
14. Add matchup smoke tests for all ordered pairs of the four precons across fixed seeds.
15. Add the unlimited-board telemetry in §17 and include it in human-readable and machine-readable reports.
16. Run the full monorepo verification suite, replay determinism tests, worker-count equivalence tests, and multiplayer regression tests.
17. Update `CLAUDE.md`, confirmed rules, open decisions/questions, ADRs, README, and project status so no superseded rule remains presented as current.

## 20. Acceptance criteria

- `cards.json` contains 155 unique permanent card IDs and loads without duplicate IDs.
- Every ID referenced by `precons.json` resolves.
- Each precon has exactly 40 distinct deck cards plus one external Commander.
- All four precons pass format and color-identity validation.
- All card behavior used by the precons is structured and executable; no runtime text parsing or card-ID special casing exists.
- The deck builder can create an editable copy of any built-in precon.
- The multiplayer server validates the same precon/deck definition the client shows.
- The simulator can run every ordered precon matchup deterministically from a seed.
- Units are unlimited in rules state; Token grouping does not merge Unit identity.
- Only one Relic per player is active, and playing another replaces it correctly.
- Guardian, Barrier, Overwhelm, Rush, Untargetable, sacrifice, conditional triggers, dynamic values, and authored Reactions have deterministic tests.
- Board-size telemetry is present in match and simulator output.
- Existing online, free-for-all, replay, hidden-information, deck save, and simulation behavior does not regress except where this document explicitly supersedes an old rule.
- `npm run verify` passes from a clean checkout.

Do not stop merely because balance values are provisional. Stop only when implementation requires choosing one of §18's unresolved rules in a way that materially changes gameplay; then ask the user the narrow question before proceeding.
