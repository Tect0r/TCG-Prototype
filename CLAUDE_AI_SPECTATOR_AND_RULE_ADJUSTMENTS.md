# Claude Update — Rule Adjustments and AI Spectator Mode

Apply this update after the current ruleset migration. It supersedes conflicting Commander, Reaction, Newly Deployed, and Token-stack behavior. Do not reinterpret the unresolved `deployed` versus `enters the battlefield` card wording globally.

## Part 1 — Confirmed Rules Adjustments

### 1. Player damage and Commander damage

Players have Health. A deployed Commander is a battlefield Unit with its own Health.

- Replace card text that says `deal damage to the enemy Commander` when it is intended to damage the opposing player with `deal damage to an opponent`.
- Damage dealt to an opponent reduces that player's Health.
- Damage dealt to a deployed Commander reduces the Commander's Health.
- Defeating a deployed Commander does not directly damage its controller.
- In multiplayer, `an opponent` requires the acting player to choose one legal opposing player unless the effect identifies the target another way.

Update affected card records and displayed rules text without changing their intended damage values.

### 2. Commander defeat, return, and escalating deployment cost

When a Commander is defeated:

1. It returns immediately to its owner's Command Zone instead of entering the discard pile or a Recovery Zone.
2. Increment that Commander's defeat count by 1.
3. Its future total deployment cost increases by 1 Energy for each defeat.

For the current test phase:

```text
commanderDeploymentCost = min(baseCommanderCost + commanderDefeatCount, 10)
```

- The cap applies to the Commander's total deployment cost, not merely to the surcharge.
- A Commander may be deployed again from the Command Zone whenever its controller can legally pay the current cost.
- The defeat count persists for the rest of the match.
- Moving the Commander between zones for any reason other than being defeated does not increase the defeat count unless a future card explicitly says otherwise.
- Display both the current deployment cost and defeat count in the Commander UI.
- Record Commander defeats and cost changes in the match event log and replay data.

Keep the cost cap configurable. The likely later experiment is a cap of 11, which would make a Commander unplayable under a 10-Energy maximum. Do not enable that experiment now.

### 3. Commander ability zones

Commander abilities work only in the zone explicitly stated by their structured effect definition and rules text.

Use explicit zone requirements rather than inferring behavior from the word `passive`:

- `When this Commander enters the battlefield ...` is an enter-trigger and works only when it enters the battlefield.
- `While this Commander is on the battlefield ...` is active only on the battlefield.
- `While this Commander is in the Command Zone ...` is active only in the Command Zone.
- An activated ability on a Commander is battlefield-only unless its text explicitly says it can be activated from the Command Zone.
- If existing Commander text does not state another zone, its ability is battlefield-only.

The runtime card/effect schema must encode the active zone explicitly. Rules text must not be parsed to determine it.

### 4. Newly Deployed

- A Unit becomes Newly Deployed when it is deployed unless an effect explicitly says otherwise.
- Newly Deployed lasts until the beginning of that Unit controller's next turn.
- A Newly Deployed Unit may block normally.
- It cannot attack or activate an ability whose cost includes Exhaust unless it has Rush or another effect explicitly permits it.
- Becoming Ready does not remove Newly Deployed.

### 5. Reaction windows and chaining

Use the following bounded MVP response system:

1. Open a Reaction window only for events that the rules or a card make reactable.
2. Each player may play at most one Reaction in that window.
3. Offer priority clockwise, beginning with the active player unless the triggering rule specifies another starting player.
4. A Reaction responds to the original triggering event, not to another Reaction.
5. Exception: a Reaction that explicitly counters a Spell may target a legal Spell already in the pending queue, including a Reaction Spell.
6. When all players pass consecutively, close the window and resolve the pending queue in last-in, first-out order, then continue resolving the original event if it was not prevented or countered.

Requirements:

- Validate the one-Reaction-per-player limit independently for every window.
- A player who has already played a Reaction in the current window may not play another even if priority returns to them.
- Record priority passes, Reaction plays, targets, counters, and resolution order in replay data.
- The spectator event log should collapse consecutive passes by default but allow them to be inspected.

### 6. Per-turn Reaction discount wording

Use this wording for the relevant Control Commander ability:

> The first Reaction Spell you play after the beginning of each of your turns costs 1 less, to a minimum of 1.

Implementation meaning:

- Reset the discount availability at the beginning of the Commander's controller's turn.
- It remains available across all following opponents' turns until used or until that player's next turn begins.
- Only a Reaction Spell actually played consumes the discount.
- The ability functions only in the zone stated on that Commander card under the Commander-zone rules above.

### 7. `Deployed` versus `enters the battlefield`

Keep these as distinct engine events:

- `deployed`: the Unit was legally played from the player's hand or the Command Zone by paying its deployment cost.
- `entersBattlefield`: the Unit entered the battlefield by any method, including deployment, revival, or another effect.

A normal deployment emits `deployed` and then `entersBattlefield` in a deterministic documented order. A revival or direct placement emits only `entersBattlefield` unless the resolving effect explicitly says the Unit is deployed.

Important: do not globally convert existing `When deployed` effects into `When this enters the battlefield` effects. Their intended behavior must be tested and decided card by card. Preserve the current wording and encode the corresponding trigger literally. Add a validation/reporting mechanism that can list every card using either trigger so they can be reviewed later.

### 8. Token grouping and group-target effects

Token stacking is a presentation feature, not a battlefield slot or a generic rules object.

For effects such as Containment Pulse, use deterministic rules wording:

> Exhaust all Tokens with the same Token definition controlled by target player.

- The player targets a player and one Token definition that player controls.
- Every matching Token controlled by that player is affected, regardless of how the client visually groups them.
- Non-Token Units are not affected by this group-target rule.
- The effect must behave identically if Token grouping is disabled in the UI.

## Part 2 — AI Spectator Mode

### Goal

Add a mode in which the user can configure and watch a complete match played by 2–4 AI players, with four AI players as the primary use case. Bot decisions must not resolve visually all at once. The match should be understandable as a sequence of deliberate actions.

This is a spectator and replay feature. Do not slow the authoritative game engine or insert real-time delays into bot decision logic.

### Architecture

Use the existing simulator, legal-action system, event/action recording, deterministic seeds, replay support, and multiplayer board rendering.

Preferred flow:

1. Configure AI seats, decks/precons, and optional seed.
2. Run the authoritative AI match at normal simulation speed.
3. Produce the ordinary deterministic replay/action stream plus final result and telemetry.
4. Load the replay into a spectator controller.
5. Reveal actions through the UI according to spectator playback timing.

If the existing replay stream lacks sufficient information to reproduce a visible intermediate state, extend the replay/event contract. Do not create a second rules engine for spectator mode.

### Match setup

Provide an `AI Spectator` entry point with:

- Player count: 2, 3, or 4; default 4.
- One bot assigned to every seat.
- Precon/deck selection for every bot.
- Bot strategy/profile selection if multiple bot implementations exist; otherwise use the current bot.
- Optional deterministic seed with a randomize action.
- `Start Match` action.

Allow duplicate precons during initial testing unless the existing deck rules prohibit them.

### Playback controls

Required MVP controls:

- Play and pause.
- Step forward by one visible action/event group.
- Restart the replay from the beginning.
- Playback speed selector.
- Default delay that makes individual actions readable.
- `Instant` option for users who only want the result.

Suggested speed presets:

```text
0.25x, 0.5x, 1x, 2x, Instant
```

At 1x, target roughly 800–1200 ms between ordinary visible actions. Longer compound events may remain visible slightly longer. Keep timing configurable rather than embedding delays in rules or bot code.

### Information modes

Support two explicit viewing modes:

#### Normal Spectator

- Hide every bot's hand.
- Show public battlefield information and hand counts.
- Reveal a card when it becomes public through play, discard, reveal, or another rule.

#### Analysis Mode

- Show all bot hands.
- Show legal actions considered by a bot if that data already exists.
- Show the chosen action and available decision explanation when present.

Analysis Mode must be confined to AI spectator/replay sessions. Do not weaken hidden-information boundaries in human or online matches.

### Spectator UI

The spectator view must show:

- All 2–4 player boards using the existing multiplayer layout.
- Bot/player identity and selected precon.
- Player Health, Energy, deck count, discard count, and hand count.
- Commander zone or battlefield state, current Commander deployment cost, and Commander defeat count.
- Active player, turn number, round if the engine uses one, current phase, and priority holder during Reaction windows.
- The card, attacker, blocker, target, or effect involved in the current action.
- A readable event log synchronized with playback.
- Final placement/winner and match-end reason.

Visually highlight only the objects relevant to the current event. Do not require full animation polish for the MVP; clear state transitions and highlights are sufficient.

### Event grouping

Raw engine events may be too granular for watchable playback. Add a presentation-only grouping layer that can combine events such as:

- Pay cost + move card + deploy Unit.
- Declare attackers as one action, followed by individual forced or chosen blocks where useful.
- Damage assignment plus resulting defeats.
- A Spell resolving plus its immediate atomic consequences.
- Consecutive Reaction priority passes.
- Commander defeat + return to Command Zone + cost increase.

Grouping must never change authoritative resolution order or replay determinism.

### Match telemetry

Continue recording the previously required board-size telemetry and expose a summary at the end of a spectator match:

- Unit count for every player at the end of each round.
- Peak total Unit count for every player.
- Peak non-Token Unit count for every player.
- Peak Token count and Token count by definition.
- Longest turn by action count and, if useful, playback duration.
- Commander defeat count and maximum deployment cost reached.
- Number of Reaction windows and Reactions played.
- Match length, winner/placement, and end reason.

Playback delay must not contaminate simulation-duration or AI-performance telemetry. Track UI playback time separately if needed.

### Save and replay

- Allow the completed AI match replay to be downloaded or saved using the project's existing replay format.
- Allow the same seed and deck configuration to be rerun.
- Preserve ruleset/data version identifiers in the replay so incompatible replays fail clearly rather than silently diverging.
- If replay import already exists, AI spectator replays should use it rather than inventing a parallel file type.

## Testing Requirements

Add or update tests for at least the following:

1. A defeated Commander returns to the Command Zone immediately.
2. Commander total deployment cost rises by exactly 1 per defeat and caps at 10.
3. Commander defeat count survives repeated deploy/defeat cycles.
4. Commander abilities are active only in their encoded zones.
5. Newly Deployed Units can block but cannot attack or pay Exhaust costs without Rush.
6. Every player can play at most one Reaction per window.
7. Counter-Reactions can target legal pending Spells while ordinary Reactions cannot react to Reactions.
8. The Reaction discount resets at the controller's turn start and remains available across opponents' turns.
9. Deployment emits both deployment and battlefield-entry events; revival emits only battlefield entry.
10. Token-definition group effects are independent of UI grouping.
11. A deterministic four-bot match produces the same action stream and final result for the same seed and data versions.
12. Spectator playback delay does not alter game state, bot decisions, replay contents, or simulation telemetry.
13. Normal Spectator hides all private hands; Analysis Mode reveals them only in AI spectator sessions.
14. Pause, step, restart, speed change, and Instant playback preserve event order.

## Acceptance Criteria

The update is complete when:

- The confirmed rules above are represented in authoritative rules documentation, structured card/effect data, validation, engine behavior, UI, replay serialization, and tests where applicable.
- Existing cards retain their literal `deployed` or `entersBattlefield` trigger until reviewed card by card.
- A user can start a four-bot match from the client and watch it at a readable pace.
- The user can pause, step, restart, change speed, and switch between Normal Spectator and Analysis Mode.
- Commander returns and escalating costs are visible and correctly replayed.
- The final screen includes the match result and board-size telemetry.
- The same seed, decks, rules version, and card-data version reproduce the same match.

## Scope Control

Do not block the MVP on elaborate combat animations, generated natural-language bot reasoning, rewind/scrubbing to arbitrary earlier events, live human spectators, or network broadcasting. Preserve clean extension points for those features, but implement understandable deterministic AI-match playback first.
