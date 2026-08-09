# Card Game Prototype — Project Specification

## 1. Purpose

Build a standalone, browser-based card-game prototype for testing mechanics, cards, and balance before integrating the card game into a larger MMO.

The application should grow in this order:

1. Deck builder
2. Online 1v1 matches
3. Online free-for-all matches for up to four players
4. Local, headless AI simulations and card-balance analysis
5. Optional analysis of pseudonymous real-player match data

Phases 1–3 are complete: the deck builder, deterministic headless rules engine, authoritative online matches, and two-to-four-player free-for-all all work. **Phase 4 — local headless simulation, automated deck search, and card-balance analysis — is implemented**: the simulator, the four pilots, batch execution, telemetry, deck generation, evolutionary search, replacement experiments, comparisons and reporting all run. The active milestone is the correctness and trustworthiness pass over that laboratory defined in `PHASE4_HARDENING.md`; §18 below describes how Phase 4 was built and remains the reference for its structure. Preserve all working behavior, protocol validation, replay determinism, hidden-information guarantees, and saved-data compatibility while extending the project.

## 2. Core design principles

- The server is authoritative for online matches. Clients request actions; the server validates and resolves them.
- All game rules must live in a shared, deterministic, headless rules-engine package—not in the UI, network layer, or animations.
- Card rules are structured data. The game must never interpret human-readable effect text to determine behavior.
- Human-readable card text is presentation only and should preferably be generated from structured effects where practical.
- The same card definitions and rules engine must be used by the web client, multiplayer server, automated tests, and local simulator.
- Randomness must be seeded and reproducible.
- Saved formats must be versioned and validated at runtime.
- Internal IDs are permanent and language-independent. Display names may change without breaking decks, artwork, logs, or replays.
- Prefer clear, testable systems over clever abstractions. Do not build a general scripting language in v0.1.

## 3. Recommended technology and repository structure

Use the existing npm-workspaces TypeScript monorepo with React and Vite for the client, Node.js for server-side applications, Zod for runtime schema validation, and Vitest for tests.

Suggested structure:

```text
apps/
  web-client/             # Deck builder and match UI
  multiplayer-server/     # Authoritative online matches
  simulator/              # Local headless simulations, experiments, reports
packages/
  card-data/              # Card definitions, schemas, loaders, validation
  rules-engine/           # Deterministic game state and rules
  bot-interface/          # Pilot policies and common bot contracts
  shared/                 # Small genuinely shared types/utilities only
assets/
  card-art/               # Optional card artwork
  defaults/               # Default artwork/templates
docs/
  rules/                  # Confirmed game rules and open decisions
  architecture/           # ADRs and technical design notes
```

Do not create circular dependencies. `rules-engine` may depend on `card-data`; `card-data` must not depend on the UI, server, simulator, or rules engine.

## 4. Confirmed game direction and provisional v0.2 rules

Structural rules below are confirmed. Numeric values marked **provisional** are playable defaults, not final balance decisions. Store them in one shared, validated rules configuration rather than scattering constants through the engine, server, tests, or UI.

### Decks and Commanders

- Each deck has exactly one external Commander.
- The Commander has a color identity containing one or more colors.
- A card is legal only when every color in its color identity is included in the Commander's color identity.
- Neutral/colorless cards may be used by any Commander.
- Initial prototype target: 30 cards per deck.
- Initial copy limit: two copies of a regular card and one copy of a unique card.
- Begin with single-color and two-color Commanders.
- All cards are unlocked; there is no collection, account progression, or monetization system.

### Match setup

- Initial mode: online 1v1.
- Each player brings one server-validated 30-card deck and its external Commander.
- Starting player is selected using the match's seeded random-number generator.
- Both players draw five cards (**provisional**).
- Use one free opening-hand redraw (**provisional**): a player may return any number of opening cards, draw the same number, then the returned cards are shuffled into the deck. Both players submit or keep before either result is revealed.
- Starting health: 20 (**provisional**).
- Maximum hand size: 10 (**provisional**). At turn end, the active player must choose and discard down to the limit.
- The first player skips their first normal draw (**provisional**) to reduce first-player advantage.
- Empty-deck rule: attempting to draw from an empty deck causes that player to lose (**provisional**). Drawing multiple cards resolves one draw at a time.

### Energy

- Universal energy increases automatically; there are no land or colored-resource cards.
- Each player starts with 1 maximum energy on their first turn (**provisional**).
- At the start of that player's turn, maximum energy increases by 1 up to a maximum of 10 (**provisional**), then current energy refills to maximum.
- Unspent energy does not carry over.
- Costs are paid before a card or activated ability enters the resolution queue.

### Battlefield and units

- Each player has five unit slots (**provisional**).
- A unit cannot be played if no friendly slot is available unless the play itself legally frees or replaces a slot.
- Units enter ready but have summoning sickness: they cannot attack on the turn they enter unless they have a keyword that permits it.
- A ready unit may attack once per turn and becomes exhausted when declared as an attacker.
- Exhausted units ready at the start of their controller's turn.
- Exhausted units cannot attack but may block (**provisional**).
- A unit can block at most one attacker; each attacker can initially receive at most one blocker (**provisional**). Model blocker assignment so multiple blockers can be added later without rewriting combat state.
- Units retain marked damage across turns. A unit is defeated when marked damage is greater than or equal to its current Health.
- Temporary Attack/Health changes expire at the documented duration boundary, normally turn end. Removing a Health bonus may defeat a damaged unit during the following state-based check.

### Turn and timing

- Initial target is online 1v1 through private invite-code lobbies.
- Accounts and public matchmaking are out of scope initially.
- The attacker declares attackers.
- The defending player assigns blockers.
- Blocked units deal combat damage simultaneously unless an effect says otherwise.
- No opponent-turn spells, priority system, or MTG-style stack in the initial ruleset.
- Units, relics, and normal spells may be played only during either Main Phase while the effect queue is empty and no choice is pending.
- Phase 2 has no reactions, interrupts, instants, or player-controlled trigger ordering.
- Activated abilities may only be used during the controller's Main Phase unless their definition explicitly uses an automatic trigger.
- Multiplayer later means a genuine Commander-style free-for-all for two to four players, not parallel 1v1 games.

### Current provisional turn phases

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

Treat these as explicit state-machine states. Do not rely on UI flow to enforce phase legality. Skip `Assign Blockers` when no legal attacker was declared. Players explicitly pass each Main Phase and confirm attackers/blockers.

### Combat

- An attacker chooses any ready, non-summoning-sick friendly unit and targets the opposing player in 1v1.
- Declared attackers exhaust immediately.
- The defender may assign legal blockers or decline to block.
- An unblocked attacker deals damage equal to its Attack to the defending player.
- A blocked attacker and its blocker deal damage to each other simultaneously.
- If the blocker leaves play before combat damage, the attacker remains blocked and deals no player damage unless it has a future piercing/overrun keyword (**provisional**).
- Negative Attack is treated as 0 when dealing damage.
- After simultaneous damage is marked, run state-based checks and defeat all lethally damaged units simultaneously. Then emit defeat events in deterministic order.
- No default excess damage reaches the defending player.

### Relics and spells

- Spells resolve their structured effects in order and then move to discard.
- A spell with no legal required target cannot be played.
- If a target becomes invalid before its effect resolves, that target is ignored; other valid targets and later instructions still resolve unless the effect definition says all targets are required.
- Relics occupy a separate persistent battlefield zone and do not consume unit slots.
- Each player may control up to three relics (**provisional**).
- A relic remains in play until destroyed, sacrificed, or moved by an effect.
- Phase 2 does not implement hidden traps, equipment attachment, or opponent-turn activations.

### Commander

- The Commander begins outside the 30-card deck in the Commander zone.
- A Commander has a structured passive ability and may have one activated ability. It is not automatically a unit.
- Commander passives function from the Commander zone unless the card explicitly states another zone.
- Phase 2 does not summon Commanders as combat units (**provisional simplification**).
- An activated Commander ability has structured timing, costs, targets, and either `once_per_match` or a documented reusable restriction.
- Commander defeat and three-turn recovery are deferred until Commanders can enter the battlefield. Do not invent that subsystem in Phase 2.

### Trigger ordering and resolution

- Do not implement an MTG-style stack or player priority.
- Effects resolve through one deterministic FIFO resolution queue. Instructions belonging to one effect are enqueued in authored array order.
- After an instruction resolves: run state-based checks, emit resulting events, discover triggered effects, then enqueue those triggers before continuing normal play.
- Simultaneous triggers are ordered by active player first, then non-active player, then source instance creation order, then trigger index in the card definition.
- A pending mandatory choice pauses the queue. Only the expected player's valid choice action, concession, or server-authorized timeout action is accepted.
- Newly created triggers do not interrupt the currently executing atomic instruction.
- Add a configurable resolution-step limit and repeated-state safeguard so accidental infinite loops terminate with a structured engine error and complete diagnostic log rather than hanging.

### Victory and match termination

- A player loses when their Health is 0 or lower, when required to draw from an empty deck, or when they concede.
- Check loss after every atomic effect instruction and state-based check, and after simultaneous combat damage.
- If both players lose in the same state-based check, the match is a draw.
- A disconnected player receives a 90-second reconnection window (**provisional server rule**). Expiry counts as a loss.
- Main-phase and choice timers are deferred unless needed during testing; server timeout handling must nevertheless be represented as explicit validated actions, not wall-clock logic inside the engine.

## 5. Phase 1 — Deck builder requirements

Implement this phase first.

### Required features

- Load all cards and Commanders from validated data files.
- Browse cards in a responsive card grid.
- Search by display name and rules text.
- Filter by color, card type, energy cost, keyword, tag, uniqueness, and power class/role where applicable.
- Create, rename, duplicate, edit, and delete decks.
- Select exactly one Commander per deck.
- Add and remove cards with visible copy counts.
- Show deck size, color identity, validation errors, and warnings live.
- Validate Commander color identity, deck size, copy limits, missing card IDs, and schema versions.
- Save decks locally in the browser.
- Import and export decks as readable, versioned JSON.
- Exported decks reference cards by permanent ID, never display name.
- Handle removed or renamed cards gracefully and identify unresolved IDs.
- Include a small generic development card set sufficient to test every filter and validation path. Do not invent final lore, factions, characters, or art direction.

### Out of scope for Phase 1

- Matches or rules resolution
- Multiplayer/networking
- Accounts or cloud saves
- AI or simulations
- Card acquisition, packs, rarity economy, or progression
- Final artwork or polished animations
- A free-form custom-card editor

### Minimum deck save format

```json
{
  "schemaVersion": 1,
  "id": "deck_01h_example",
  "name": "Prototype Deck",
  "commanderId": "prototype_commander_blue_red",
  "cards": [
    { "cardId": "prototype_scout", "quantity": 2 },
    { "cardId": "prototype_guard", "quantity": 2 }
  ],
  "createdAt": "2026-08-07T12:00:00.000Z",
  "updatedAt": "2026-08-07T12:00:00.000Z"
}
```

Dates and generated deck IDs may change without affecting card identity. Add migrations when the save schema changes.

## 6. Card identity and artwork

Every card has a permanent unique ID using this convention:

```text
lowercase_english_snake_case
```

Examples:

```text
goblin_scout
trench_guard
unstable_construct
```

Rules:

- Lowercase ASCII letters, numbers, and underscores only.
- No spaces, hyphens, punctuation, or localized words.
- IDs must be unique and never change after release.
- Display names are separate and may change or be localized later.

Optional artwork is discovered by ID:

```text
assets/card-art/<card_id>.png
```

Example:

```text
assets/card-art/goblin_scout.png
```

Use a documented standard aspect ratio and resolution, initially `768 × 1024 px` unless implementation testing exposes a better choice.

Rendering behavior:

1. Attempt to load `assets/card-art/<card_id>.png`.
2. If it exists, display it in the artwork area of the standard rendered card frame.
3. If it is absent or fails to load, use `assets/defaults/default_card.png`.
4. Always render name, cost, type, rules text, colors, Attack, Health, and other relevant data as live UI elements. The PNG must not be the entire functional card UI.

Dropping a correctly named PNG into the artwork folder should require no card-data or code change. Missing artwork is normal and must not produce a broken UI.

## 7. Card data model

Cards must be validated at application startup and in tests. Keep data definitions declarative and JSON-serializable.

Suggested conceptual shape:

```ts
type CardDefinition = {
  schemaVersion: number;
  id: CardId;
  name: string;
  type: "unit" | "spell" | "relic" | "commander" | "token";
  colorIdentity: ColorId[];
  cost: number | null;
  attack?: number;
  health?: number;
  unique?: boolean;
  collectible?: boolean;
  tags?: string[];
  keywords?: KeywordId[];
  role?: "token" | "attacker" | "blocker" | "support" | "enabler" | "payoff" | "removal" | "finisher" | "build_around";
  powerClass?: "minor" | "standard" | "major" | "centerpiece";
  effects: EffectDefinition[];
  displayText?: string;
};
```

`displayText` is presentation text, never executable logic. During early development it may be authored manually, but tests should make obvious mismatches between text and structured effects easier to detect. Later, common effects may generate standardized text automatically.

Tokens may be non-collectible and unavailable in the deck builder while still existing in the shared card database.

Do not equate `powerClass` with player progression or a card leveling system. It describes intended mechanical impact: a 1/1 token is minor; a Krenko-like build-around or Commander is a centerpiece.

## 8. Structured effect system

Do not parse card prose. Store behavior as validated instructions that the rules engine will execute in order.

Example:

```json
{
  "id": "desperate_insight",
  "name": "Desperate Insight",
  "type": "spell",
  "colorIdentity": ["blue"],
  "cost": 2,
  "displayText": "Discard a card, then draw a card.",
  "effects": [
    {
      "type": "discard",
      "player": "self",
      "amount": 1,
      "selection": "player_choice"
    },
    {
      "type": "draw",
      "player": "self",
      "amount": 1
    }
  ]
}
```

Use discriminated unions for effect definitions. Each effect type owns its required and optional fields. Avoid one giant object with dozens of loosely related optional properties.

### Initial trigger vocabulary

- `on_deploy`
- `on_attack`
- `on_block`
- `on_survive_combat`
- `on_defeated`
- `on_turn_start`
- `on_turn_end`
- `on_sacrifice`

### Initial effect vocabulary

Plan schemas for a deliberately limited reusable set:

- Draw cards
- Discard cards
- Deal damage
- Heal
- Modify Attack and/or Health, temporarily or permanently
- Grant or remove a keyword
- Create a token
- Destroy a valid target
- Sacrifice a friendly unit as a cost
- Return a unit to its owner's hand
- Search or inspect a defined zone
- Reorder cards
- Reduce or increase energy cost
- Prevent the next amount or instance of damage
- Exhaust or ready a unit
- Move a card between defined zones

Only implement effect execution when Phase 2 begins. In Phase 1, define and validate enough of the schema to avoid rewriting card data later.

Do not attempt to support every conceivable future mechanic. A truly unique card may later receive a specially coded, named effect handler. Such handlers still belong in the shared rules engine and must remain deterministic and testable.

## 9. Targeting and player choices

Effects that require input must pause resolution through a serializable pending-choice state. The UI displays valid choices; the authoritative engine calculates and validates them.

Conceptual state:

```json
{
  "status": "waiting_for_choice",
  "pendingChoice": {
    "id": "choice_482",
    "playerId": "player_1",
    "type": "select_cards",
    "zone": "hand",
    "minimum": 1,
    "maximum": 1,
    "validEntityIds": ["instance_a", "instance_b"],
    "continuation": {
      "effectQueueId": "queue_12",
      "nextStep": 1
    }
  }
}
```

Resolution model:

1. Validate the initiating action, phase, player, targets, and cost.
2. Create events and enqueue effects.
3. Resolve effects in deterministic order.
4. If an effect requires a choice, create `pendingChoice` and stop resolution.
5. Reject unrelated actions while a mandatory choice is pending.
6. Accept and validate a choice from the correct player.
7. Resume the saved continuation.
8. Emit resulting events, enqueue matching triggers, and check victory/state-based rules.

Never store executable closures or functions in game state. Pending choices, continuations, match states, and logs must be serializable so reconnecting, replaying, debugging, and later persistence remain possible.

Target definitions should be structured filters, for example controller, zone, card type, tags, damaged state, cost range, and selection mode. The client must never determine legality independently.

## 10. Phase 2A — Headless rules engine

When match development begins, implement the rules engine as pure state transitions where practical:

```ts
applyAction(state, action, context) => result
```

The result should contain the next state plus structured events/errors. The engine must not depend on React, DOM APIs, WebSockets, databases, wall-clock time, or animations.

Required concepts:

- Explicit match phase/state machine
- Active player and turn order
- Zones: deck, hand, battlefield, discard, Commander zone, recovery, exile/reserve only if later required
- Card definition ID versus unique in-match card instance ID
- Legal-action generation and validation
- Ordered effect-resolution queue
- Events and triggers
- Pending player choices and resumable continuations
- Seeded random-number generator
- State-based checks and victory detection
- Redacted player views so hidden hands/decks are not leaked
- Structured action and event logs suitable for replay and simulation

### Required serializable state

At minimum, model and runtime-validate:

- `MatchState`: schema version, rules version, match ID, seed/RNG state, status, mode, players, turn number, active player, phase, effect queue, pending choice, result, and resolution counters.
- `PlayerState`: player ID, health, energy, zones, Commander state, mulligan state, and connection-independent match flags.
- `CardInstance`: permanent definition ID, unique match instance ID, owner, controller, zone, slot/order, current modifiers, marked damage, exhausted state, turn-entered marker, and counters.
- `Action`: discriminated union for mulligan, keep hand, play card, activate ability, pass phase, declare attackers, assign blockers, submit choice, concede, and server timeout.
- `GameEvent`: discriminated union for every observable state change, with sequence number and causal action/effect/source IDs.
- `PendingChoice`: expected player, choice kind, min/max selections, engine-generated legal entity IDs/options, and serializable continuation.
- `MatchResult`: winner/draw, reason, final turn, and final event sequence.

Do not expose raw authoritative `MatchState` directly to clients. Derive a `PlayerView` that redacts opponent hands, deck order, unrevealed choices, internal RNG state, and any future hidden information.

### Required legal actions

The engine—not the UI—must generate or validate all legal actions. Phase 2A must support:

- Opening-hand keep and partial redraw
- Playing a unit into a selected free slot
- Playing a spell and selecting all required legal targets/choices
- Playing a relic
- Activating a supported Commander ability
- Passing Main Phases
- Declaring zero or more legal attackers
- Assigning zero or more legal blockers
- Resolving mandatory discard/selection choices
- Conceding at any time
- A server-originated disconnect-timeout loss action

Invalid actions return structured errors without mutating state or advancing RNG.

### Required v0.2 effects

Implement and test this intentionally limited effect vocabulary before adding more:

- `draw`
- `discard`
- `damage`
- `heal`
- `modify_stats`
- `grant_keyword`
- `remove_keyword`
- `create_token`
- `destroy`
- `sacrifice`
- `return_to_hand`
- `exhaust`
- `ready`
- `prevent_damage`
- `move_card`

Support `self`, `opponent`, source, chosen card/unit, and filtered legal target sets. Support fixed numeric values first. Variable values, deck searches, reordering, copying, control changes, and arbitrary custom scripts are out of scope unless an existing Phase 1 card already requires them.

### Required v0.2 triggers

- `on_deploy`
- `on_attack`
- `on_block`
- `on_survive_combat`
- `on_defeated`
- `on_turn_start`
- `on_turn_end`
- `on_sacrifice`

Every trigger must identify its source instance and causal event. A source leaving play does not cancel an already-created triggered effect unless a future effect explicitly requires the source to remain present.

### Phase 2A test scenarios

In addition to unit tests, add deterministic scenario tests covering:

1. Full setup, seeded shuffle, simultaneous mulligan decisions, and first turn.
2. Energy growth/refill and first-player skipped draw.
3. Unit play, slot limit, summoning sickness, ready/exhaust behavior.
4. Unblocked combat damage.
5. Blocked simultaneous combat with zero, one, and both units defeated.
6. Persistent damage and healing across turns.
7. Spell requiring a target and rejection when no legal target exists.
8. Discard-then-draw pausing for a player choice and resuming correctly.
9. Deploy, defeat, turn-start, and turn-end triggers in deterministic order.
10. Token creation when slots are available and when the battlefield is full.
11. Simultaneous player loss resulting in a draw.
12. Empty-deck loss during a multi-card draw.
13. Concession and server timeout termination.
14. Identical seed plus identical actions producing identical states/events.
15. State serialization and restoration during an unresolved choice.
16. Hidden-information redaction for both player views.
17. Loop/step safeguard producing a diagnostic failure instead of hanging.

Every rule requires unit tests. Add deterministic scenario tests for full interactions and regression tests for every reported rules bug.

### Phase 2A acceptance criteria

Phase 2A is complete when:

- The rules engine runs complete 1v1 matches without React, networking, a database, or wall-clock dependencies.
- All state, actions, events, choices, and results are serializable and runtime-validated.
- All provisional rules values come from one shared versioned rules configuration.
- Invalid actions never partially mutate match state.
- Seeded matches are exactly reproducible.
- Pending choices survive JSON serialization and resume correctly.
- Player views do not leak hidden information.
- The required scenarios and effect/trigger handlers pass tests.
- A small CLI or test harness can play a scripted complete match and print its structured event log.

Do not begin Phase 2B until Phase 2A passes these criteria.

## 11. Phase 2B — Online 1v1

- Authoritative Node.js server
- WebSocket communication
- Private invite-code lobbies
- Temporary player names; no accounts initially
- Deck validation on the server before match start
- Hidden-information-safe state updates
- Reconnection token and reasonable match recovery
- Clear handling of disconnects, timeouts, invalid actions, and version mismatch
- Structured match logs

### Network boundary

- Clients send versioned intent messages containing an action and the last event/state revision they observed.
- The server authenticates the connection to one lobby seat using an opaque reconnect token, validates the action through the shared engine, and broadcasts derived player views/events.
- The server is the only process allowed to mutate authoritative match state.
- Reject malformed messages, stale revisions, actions from the wrong player, and incompatible client/card/rules versions with structured errors.
- Never trust client-supplied costs, legal targets, card definitions, RNG results, hidden card IDs, or resulting state.
- Make action submission idempotent through unique client action IDs so reconnect/retry cannot play a card twice.

### Lobby and connection flow

1. A host creates a private lobby and receives a short invite code.
2. Each player joins with a temporary display name and receives an opaque reconnect token.
3. Each player submits a locally saved deck; the server validates it against its own card data.
4. Both players mark ready.
5. The server locks deck revisions, creates the seeded match, and sends each player their redacted view.
6. Refreshing or reconnecting with the token restores the correct seat and current view.
7. If a player fails to reconnect within the configured window, the server submits the explicit timeout action.

Initial match and lobby state may remain in memory. Process restarts may end matches in this phase; document that limitation clearly. Do not add accounts or a database merely to solve it yet.

### Match UI requirements

- Show both players, Health, energy, deck/discard counts, Commander, relics, unit slots, active player, current phase, and connection state.
- Show only the local player's hand and permitted private information.
- Highlight legal actions and legal targets using server-derived data.
- Provide explicit controls for pass phase, confirm attackers, confirm blockers, resolve choices, and concede.
- Render a readable chronological game log based on public events.
- Disable animation input while awaiting an authoritative revision; animations must never own or delay game rules.
- Recover cleanly from refresh, stale actions, rejected actions, and temporary connection loss.

### Phase 2B acceptance criteria

- Two browsers can create/join an invite lobby, submit decks, and finish a complete online 1v1 match.
- The server remains authoritative for every rule, target, cost, random result, and transition.
- Neither client receives the opponent's hand or deck order.
- Reconnect within the configured window restores the match without duplicate actions.
- Invalid, stale, duplicated, or out-of-turn actions are safely rejected.
- Disconnect expiry, concession, normal Health loss, empty-deck loss, and draw results work end to end.
- Server and client version mismatches produce a clear actionable message.
- Automated integration tests cover lobby creation/join, start, representative actions, reconnection, hidden information, and match termination.
- Existing Phase 1 deck creation, persistence, import, and export still work.

## 12. Phase 3 — Online free-for-all for two to four players

Extend the existing authoritative server and shared rules engine into a genuine free-for-all. This is not a set of parallel 1v1 matches and not a hot-seat mode. The same mode must support two, three, or four seated players; existing 1v1 behavior must remain compatible.

### Confirmed multiplayer rules

- No teams in Phase 3. Every player competes independently.
- Players take complete turns in a stable circular seat order established at match creation.
- A player who is eliminated is skipped without renumbering or reordering the remaining seats.
- During attacker declaration, each attacking unit independently targets one living opponent. Attackers may be split across multiple opponents in the same combat.
- Units cannot attack other units directly.
- A unit may block only an attacker targeting that unit's controller. Third-party blocking is not allowed.
- Each targeted defender submits blockers only for attacks directed at them. If several defenders are attacked, blocker choices are collected independently and hidden until all required defenders submit or explicitly decline.
- Combat then resolves as one deterministic combat event. Damage within the same combat-damage step is simultaneous across all defenders.
- Effects using `opponent` must resolve to one explicitly selected living opponent unless their definition says `each_opponent`.
- `each_opponent` resolves in clockwise seat order starting after the effect controller. It is one atomic multi-recipient instruction when simultaneous loss matters; presentation events may still be emitted per recipient in that deterministic order.
- Simultaneous triggers are ordered by active player first, then clockwise seat order, then source-instance creation order, then trigger index. No player-controlled trigger ordering or priority system is added.
- The last living player wins. If all remaining players lose in the same state-based check, the match is a draw.
- Spectating after elimination is allowed, but an eliminated player receives only the public/redacted view and cannot submit gameplay actions.

### Elimination semantics

When a player loses:

1. Mark the player eliminated and remove them from future turn, choice, and combat participation.
2. Remove all cards and tokens they own from every match zone. Tokens cease to exist; non-token cards move to a terminal `removed` zone or equivalent serializable state.
3. End all static, delayed, and queued effects controlled by that player unless an already-resolving atomic instruction must complete to preserve determinism.
4. Return cards owned by another player but controlled by the eliminated player to their owner's corresponding legal zone; default to the owner's discard pile when no originating zone is meaningful.
5. Remove cards owned by the eliminated player even when another player controls them.
6. Cancel unresolved choices assigned to the eliminated player and continue resolution with a documented no-selection result where legal; otherwise cancel the containing effect.
7. Remove attacks directed at that player before combat damage. Attackers remain exhausted and do not retarget or deal damage to another player.
8. Run state-based checks and trigger discovery once after the full elimination cleanup, not after every removed object.

Every ownership/control rule must be represented explicitly in serializable state. Do not infer ownership from the current battlefield container.

### Player targeting schema

Add player targets as a first-class discriminated target type rather than forcing players into zone-based `TargetSelector`:

```ts
type TargetDefinition =
  | { kind: "entity"; selector: TargetSelector }
  | { kind: "source" }
  | { kind: "player"; relation: "self" | "opponent"; selection: "automatic" | "player_choice" }
  | { kind: "players"; relation: "each_opponent" | "all_players" };
```

This confirms the existing `targetsSource` requirement conceptually, though a schema migration may replace the boolean with the `source` variant. Card data, protocol messages, pending choices, legal actions, logs, and player views must use stable player IDs—not array positions.

### Engine changes

- Replace assumptions of exactly two players or one `opponentId` with ordered living-player helpers.
- Preserve the full original seat order in match state.
- Extend attacker declarations to store `{ attackerId, defenderPlayerId }`.
- Group blocker requirements by defender and allow several pending defender submissions without allowing unrelated gameplay actions.
- Keep all pending multiplayer choices JSON-serializable and reconnect-safe.
- Redact every player's hand, deck order, private mulligan choice, and private search information independently for every viewer.
- Enumerate legal actions for the requesting player only, including legal defender targets.
- Preserve seeded determinism regardless of connection timing or the order in which independent blocker submissions reach the server.
- Do not add Commander battlefield deployment, Commander recovery, teams, table politics, chat, public matchmaking, reactions, or a priority stack in this phase.

### Server, lobby, and reconnection

- Lobbies accept two to four seats and the host chooses or configures the maximum before the match starts.
- Start requires at least two occupied, ready seats with valid submitted decks.
- Once the match starts, empty seats cannot be filled.
- Each seat keeps an independent reconnection token and configured grace window.
- Disconnect does not stop the entire match. If the grace window expires, the server submits an explicit timeout/elimination action through the engine.
- Lobby and match state may remain in memory; server-restart recovery remains out of scope.
- Protocol changes must be versioned and runtime-validated on both client and server.
- Strict stale-revision rejection remains confirmed: reject the action and resend the current player view.

### Match UI

- Display all players in seat/turn order with health, energy, Commander, board, relics, deck count, hand count, connection state, and eliminated state.
- Clearly identify the active player and local player.
- Attacker declaration must make the target opponent for each attacker explicit and editable before confirmation.
- Each defender sees and assigns only their relevant blockers.
- Waiting states must identify which defenders have not submitted without leaking their tentative assignments.
- After elimination, switch the local client to spectator mode automatically.
- Keep the UI functional and readable before adding animations. Animations never own, delay, or determine rules resolution.

### Required Phase 3 tests

At minimum, add deterministic engine, protocol, server, and UI coverage for:

1. Starting legal matches with two, three, and four players.
2. Stable circular turns and skipping eliminated seats.
3. Splitting attackers across two or three opponents.
4. Rejecting third-party and otherwise illegal blockers.
5. Independent blocker submissions arriving in different network orders but producing identical final state.
6. Simultaneous combat across several defenders.
7. `opponent` choice and clockwise `each_opponent` resolution.
8. Active-player-then-clockwise simultaneous trigger ordering.
9. Elimination cleanup for owned cards, controlled cards, tokens, queued effects, choices, and pending attacks.
10. Timeout elimination while other players continue.
11. Last-player victory and simultaneous-loss draw.
12. Per-viewer hidden-information redaction with four players.
13. Reconnection for every seat and idempotent replay of an action.
14. Eliminated-player spectating and action rejection.
15. Existing complete online 1v1 flows remaining unchanged.

### Phase 3 acceptance criteria

Phase 3 is complete when:

- Two to four browsers can create/join one lobby, submit decks, reconnect, and finish a free-for-all match.
- Attack and block ownership, multi-defender combat, triggers, elimination, and victory follow the rules above deterministically.
- The server remains authoritative and no player receives another player's hidden information.
- Different arrival orders for independent network choices cannot change a seeded match result.
- Eliminated players can spectate but cannot act.
- Existing Phase 1 and Phase 2 tests and behavior remain intact.
- New engine, protocol, server, and client tests cover every required scenario.
- `npm run verify` passes for the entire monorepo.

## 13. Local simulation and balance laboratory

Phase 4 builds a local balance laboratory on the completed engine. It is not a fun tester and must not claim to prove that a game or card is balanced. Its job is to produce reproducible evidence, discover abusive combinations, compare candidate card pools or rules, and show why a card or interaction deserves human review.

### 13.1 Scope and boundaries

- Import `@tcg/rules-engine` directly and call `legalActions`/`applyAction` in memory.
- Never simulate through React, WebSockets, the multiplayer server, animation, wall-clock timers, or a duplicated rules implementation.
- Phase 4 experiments run 1v1 first. All formats and records must carry `playerCount`, and bot contracts must not hard-code one opponent, so 3–4-player analysis can be added later without a redesign.
- Use legal, server-validatable decks and the same card database, deck format, rules configuration, and migrations as human matches.
- Do not add machine learning in Phase 4. Use transparent heuristic pilots and evolutionary deck search. Preserve data that could support later learning.
- Raw observations and configuration are primary outputs. Scores, flags, and written interpretations are derived outputs and must link back to their evidence.
- Do not silently rebalance cards, edit card data, or select a “best” patch. The analyzer recommends investigation; a human changes the game.

Keep these responsibilities separate:

1. **Pilot AI:** plays a supplied legal deck.
2. **Match runner:** executes one deterministic headless match and records telemetry.
3. **Batch runner:** schedules many independent matches and aggregates results.
4. **Deck search:** generates and mutates legal decks to hunt for strong combinations and counters.
5. **Balance analyzer:** compares environments and diagnoses suspicious cards/interactions.
6. **Report layer:** writes machine-readable results and a concise human-readable summary.

### 13.2 Required package structure

```text
packages/
  bot-interface/
    src/types.ts             # BotPolicy, observation, decision and metadata
    src/random-legal.ts
    src/aggressive.ts
    src/defensive.ts
    src/value.ts
    src/scoring.ts           # Shared transparent action/board scoring helpers
apps/
  simulator/
    src/config.ts            # Runtime-validated experiment schemas
    src/seed.ts              # Stable hierarchical seed derivation
    src/run-match.ts
    src/run-batch.ts
    src/workers/             # Optional worker-thread execution
    src/telemetry/
    src/deck-search/
    src/analysis/
    src/reporting/
    src/cli.ts
```

`bot-interface` may depend on public rules-engine/card/deck types. It must not receive private state it would not have in a real match. `rules-engine` must not depend on bots or the simulator. `simulator` may depend on bots, rules, decks, and card data, but never on the web client or multiplayer server.

### 13.3 Bot contract and observations

Each pilot receives only:

- Its authoritative `PlayerView`
- Its structured `LegalActions`
- Public match history/events as visible to that seat
- Its own immutable bot configuration
- A bot-specific seeded RNG stream

It returns one valid engine `Action` plus optional structured decision diagnostics. It must never inspect another hand, deck order, hidden choice, full `MatchState`, or engine RNG state. The match runner validates every returned action against the current legal-action description and then submits it through `applyAction`; a bot has no mutation access.

The contract must support asynchronous implementations later but the built-in bots should remain synchronous and fast. Given the same observation, bot version, config, and seed, a pilot must return the same decision.

Required pilots:

- **Random legal:** uniformly or explicitly weighted selection among legal action families; deterministic tie-breaking and RNG. This is a baseline, not a competent player.
- **Aggressive:** values immediate player damage, efficient attackers, tempo, low-cost deployment, and closing the match; deprioritizes long-term defense.
- **Defensive:** values survival, blockers, removal, healing, board stability, and preventing lethal damage.
- **Value:** values energy use, favorable trades, card advantage, persistent board/relic value, and avoiding dead resources.

All heuristic weights must be named, serializable, runtime-validated, exported in result metadata, and overridable by experiment config. Avoid card-ID-specific rules. A generic tag/role/keyword-aware heuristic is allowed when its behavior is documented. Decisions with equal scores use stable ordering plus the bot RNG, never JavaScript iteration accident.

Bots must handle every current legal decision surface:

- Mulligan/keep
- Playing units, spells, and relics with slot selection
- Activated abilities
- Passing Main Phases
- Declaring zero or more attackers and selecting defenders
- Assigning blockers
- Every pending choice type and ordering choice
- Concession only when explicitly enabled by experiment policy

Add a maximum decision budget and a deterministic fallback to random-legal if a pilot throws, times out in a future async implementation, or produces an illegal action. Record the failure; never hide it as an ordinary decision.

### 13.4 Deterministic seed hierarchy

Reproducibility must be independent of worker count, scheduling order, machine speed, and result arrival order. Derive named child seeds with a stable documented hash/PRNG algorithm:

```text
experiment seed
  -> environment seed
  -> matchup/deck-pair seed
  -> game index seed
       -> match RNG seed
       -> seat assignment seed
       -> pilot seed per seat
```

At minimum, the game seed must derive from immutable values equivalent to:

```text
experimentId + environmentId + deckPairId + gameIndex
```

Do not use worker IDs, timestamps, array completion order, `Math.random()`, or process IDs. Store the root seed, derivation version, derived match seed, pilot seeds, seat assignment, deck hashes, rules version, card-pool hash, and software commit when available in every result.

Paired comparisons must use common random numbers: baseline and candidate runs share the same derived game/seat/pilot seeds wherever the changed environment still permits the same experimental unit. This reduces noise and makes regressions reproducible.

### 13.5 Single-match runner

The runner accepts validated decks, pilots, card database/environment, rules config, and seed bundle. It creates a match, repeatedly requests decisions from the correct pilot, and stops on a normal result or a structured safety termination.

Required safeguards:

- Existing engine resolution-step and repeated-state safeguards remain authoritative.
- Configurable maximum turns, accepted actions, and decisions per match.
- Detect no-progress patterns using a documented public-state/action signature; never declare a loop solely because two full states match when hidden RNG/deck state differs.
- Classify termination as `victory`, `draw`, `engine_error`, `pilot_error`, `illegal_bot_action`, `turn_limit`, `action_limit`, or `no_progress`.
- Preserve a replay bundle for every abnormal match and for a configurable sample of normal matches.
- A single broken match must not crash or invalidate an entire batch unless fail-fast is configured.

The same seed, inputs, bot versions, and software version must reproduce the same final result, action log, event log, and telemetry.

### 13.6 Telemetry model

Record events during simulation rather than reconstructing them only from the final board. Use permanent card definition IDs for analysis and match-local instance IDs only for causal tracing.

Every match summary must include:

- Experiment/environment/match identifiers and schema versions
- Deck IDs/hashes and complete decklists
- Pilot IDs, versions, configs, seats, and colors/Commanders
- Seeds and derivation version
- Winner/result/termination reason
- Starting player and seat order
- Turns, actions, decisions, and resolution steps
- Starting and ending health, damage dealt/taken, healing, cards drawn/played/discarded, energy spent/unspent, units/relics deployed, defeats, and choice counts per player
- Any safeguard, error, fallback, or diagnostic

Per card definition and per copy, track where applicable:

- Included copies and opening-hand presence
- Mulliganed away/kept
- Draw turn and time spent in hand
- Play opportunities while affordable/legal
- Times played, activated, discarded, sacrificed, defeated, removed, or still in hand at termination
- Energy spent and immediate/turn-later measurable output
- Player/unit damage, healing, cards drawn/discarded, units/tokens created or removed, and triggered-effect counts attributable through source/effect provenance
- Board survival duration and attacks/blocks participated in
- State immediately before and after play using compact derived features, so swing measures are inspectable

“Dead-hand” must have explicit components instead of one vague number:

- **Never affordable:** never had enough energy after draw.
- **No legal window:** requirements/targets/slots never made it legal.
- **Legal but unchosen:** at least one legal opportunity existed but the pilot chose another action until match end/discard.
- **Unseen:** remained in deck and must not count as dead in hand.

Do not attribute victory to a card merely because it was drawn or present. Clearly label simple correlations as correlations.

### 13.7 Batch runner and parallel execution

Provide a CLI and programmatic API capable of:

- Round-robin or sampled deck-pair schedules
- Mirrored seat assignments for each deck/pilot pairing
- Multiple pilots or pilot mixtures
- Configurable games per pairing
- Sequential and worker-thread execution
- Progress, elapsed time, throughput, error counts, and estimated completion
- Resuming an interrupted experiment without rerunning completed deterministic match IDs
- Streaming results to disk so large experiments do not remain entirely in memory

Results must be identical between `workers: 1` and `workers: N` after sorting by stable match ID. Aggregate floating-point statistics in deterministic match-ID order. Worker messages must contain plain validated data, not closures or mutable shared state.

Start with JSON/JSONL as the canonical lossless format. Export flat CSV tables for common inspection (`matches`, `decks`, `card_usage`, `card_pairs`, `errors`). A future SQLite/columnar sink may be added behind an interface only when volume justifies it.

### 13.8 Legal deck generation

Deck generation uses `validateDeck` as the final authority and must respect Commander identity, deck size, unique/copy limits, and card availability. Never repair an illegal deck silently; return structured generation diagnostics.

Support:

- Seed decks supplied by the user
- Random legal decks with configurable Commander and role/cost/tag weighting
- Stratified initial populations so generation does not collapse immediately into one obvious card cluster
- A stable canonical deck hash independent of card entry order
- Deduplication by canonical hash

Tokens and Commanders outside the main deck are never inserted as ordinary deck cards unless the deck format explicitly permits it.

### 13.9 Evolutionary abuse search

The search system exists to discover combinations, not to declare a permanent best deck. It should:

1. Create or accept a diverse legal population.
2. Evaluate decks against a rotating, archived opponent field and multiple pilots/seats.
3. Select a mixture of strong, novel, and counter-performing candidates.
4. Mutate them through legal card replacement and quantity changes.
5. Optionally cross over compatible decks only if legality and useful diversity can be maintained.
6. Re-evaluate elites on fresh deterministic seeds to reduce overfitting.
7. Preserve discovered champions, counters, exploit candidates, and lineage.

Fitness must be multi-objective. It may include performance evidence, opponent breadth, robustness across pilots/seats, novelty, and uncertainty. Do not optimize a single raw win percentage against a fixed weak field. Penalize or separately flag abnormal termination exploitation, extreme match stalling, and dependence on pilot failures.

Maintain a hall of fame/opponent archive across generations so the population cannot forget older strategies. Track card-frequency entropy, deck-distance diversity, Commander diversity, and strategic feature clusters. If diversity collapses, report it; do not mask it by injecting unexplained randomness.

Every mutation records parent hash, changed card counts, generation, mutation seed, legality result, and evaluation IDs. Search can be paused and resumed from a versioned checkpoint.

### 13.10 Replacement and contribution experiments

Card-level diagnosis must rely heavily on controlled substitutions:

- Identify comparison candidates by shared cost, type, role, tags, color legality, power class, and optionally effect features.
- Create otherwise identical legal deck variants replacing one or more copies of card A with candidate B.
- Run paired mirrored matches against the same opponent population with common seeds and pilots.
- Report the change with sample size, uncertainty interval, effect size, and contextual breakdowns.
- Never claim a causal effect when replacement changes legality, strategy identity, curve, or required synergy without explicitly reporting that confound.

For build-around and centerpiece cards, compare both removal/replacement from decks designed to support them and insertion into decks without support. High inclusion inside one coherent synergy cluster is not inherently suspicious; broad improvement across unrelated clusters is.

### 13.11 Balance analysis

The target is a healthy plural meta: several viable strategic clusters connected by soft counter relationships, no single strategy that performs strongly across almost everything, and no mandatory narrow silver-bullet counter. Individual exact deck win rates are experimental samples, not the product’s balance model.

Group decks by interpretable features such as Commander, color identity, cost curve, card/tag/role frequencies, token/removal/healing density, and play-pattern telemetry. Start with deterministic feature-based clustering or similarity grouping; do not introduce opaque ML solely to name archetypes.

Required analysis views:

- Card inclusion, draw, keep, play, activation, dead-hand, survival, and removal rates
- Contextual efficiency relative to cost, type, role, power class, dependency, and vulnerability
- Replacement impact with uncertainty
- Card-pair and small-combination lift, with minimum sample/support requirements
- Strategic-cluster prevalence, performance range, and matchup matrix
- Counter breadth: number and diversity of practical answers/strategies
- Matchup polarization and non-games
- Starting-seat/player advantage and pilot-style sensitivity
- Match length distribution and stall/loop/error rates
- Displacement: whether a candidate consistently removes comparable old cards from successful populations
- Robustness across seeds, opponent archives, pilot mixtures, and reasonable heuristic-weight perturbations

Do not compare a 1/1 token directly with a centerpiece or Commander. Evaluate impact relative to cost, role, setup, dependency, vulnerability, available response windows, and intended power class. A powerful build-around is suspicious when it is strong without its setup, makes most alternatives irrelevant, or has no broad practical counter—not merely because it produces large numbers.

All flags require a reason code, evidence references, sample size, and uncertainty. Initial thresholds are configurable provisional analysis settings, not game rules. Prefer labels such as `review_recommended`, `insufficient_data`, and `possible_interaction` over `overpowered` or `balanced`.

At minimum, flag:

- Broad cross-cluster auto-inclusion
- Large positive controlled replacement impact
- Strong low-support card pairs/combinations
- Lack of meaningful unfavorable contexts
- Only one narrow counter family
- Severe matchup polarization
- Candidate-driven displacement of comparable cards or whole clusters
- High legal-but-unchosen/dead-hand rates in intended contexts
- Excessive sensitivity to seat, pilot, or one opponent field
- Loops, soft locks, abnormal terminations, and excessive match duration

### 13.12 Baseline-versus-candidate experiments

An environment is a versioned bundle of card pool, card definitions, deck format, rules config, and optional ban/allow list. A comparison contains one immutable baseline and one candidate.

The comparison workflow must:

1. Validate and hash both environments.
2. State exactly which cards/rules differ.
3. Evaluate unchanged reference decks where legal.
4. Re-run deck search in both environments so the candidate may create new strategies.
5. Use paired seeds/pilots/seats for directly comparable runs.
6. Separate “existing decks changed” from “new decks discovered.”
7. Report cards/strategies gained, lost, displaced, or made newly viable.
8. Preserve both raw datasets and the comparison configuration.

Do not test a new card only by inserting it into existing decks; that misses novel abuse. Do not test only freshly optimized candidate decks against stale baseline decks; that biases the result in the other direction. Run both reference-population and independently searched-population comparisons.

### 13.13 Reports and CLI

Provide documented commands conceptually equivalent to:

```bash
npm run simulate -- --config experiments/smoke.json
npm run simulate -- --config experiments/batch.json --workers 8
npm run search:decks -- --config experiments/abuse-search.json
npm run analyze:balance -- --baseline results/base --candidate results/candidate
```

Exact command names may follow repository conventions. Configuration files and every output must have runtime schemas and `schemaVersion` fields.

Each experiment directory should contain:

```text
manifest.json
config.json
matches.jsonl
decks.json
card-usage.csv
card-pairs.csv
summary.json
report.md
replays/                 # abnormal plus sampled normal matches
checkpoints/             # when deck search is used
```

`report.md` should lead with limitations, experiment scale, environment diff, and strongest evidence. It must distinguish observation, inference, and recommendation. Include compact tables; do not generate prose by pretending certainty.

### 13.14 Performance targets

First optimize correctness and useful telemetry, then measure. Establish a checked-in benchmark scenario and report matches/second, actions/second, peak memory, output size, and scaling at 1/2/4 workers. Do not impose a speculative hard speed threshold before profiling.

The default large-run mode should avoid retaining full action/event logs for every normal match. Keep aggregates plus configurable sampling, while always preserving abnormal replays. A debug mode may retain everything.

### 13.15 Required Phase 4 tests

At minimum add automated coverage for:

1. Every built-in pilot can finish complete matches across many fixed seeds without illegal actions.
2. Every current action and pending-choice family is handled by each pilot or its explicit fallback.
3. Bots cannot observe another player's hidden hand/deck/order or private choice.
4. Identical match inputs reproduce byte-equivalent normalized results and replay logs.
5. Changing worker count and scheduling order does not change sorted results or aggregates.
6. Seat-mirrored schedules are generated correctly and expose a deliberately biased fixture.
7. Match/action/turn/no-progress limits end pathological fixtures with the correct classification and replay.
8. Pilot errors and illegal decisions are isolated, recorded, and deterministically recovered or terminated according to config.
9. Telemetry correctly distinguishes unseen, never-affordable, never-legal, and legal-but-unchosen cards.
10. Source/effect attribution survives tokens, triggers, sacrifice, removal, and continuous effects where attribution is defined.
11. JSONL streaming, resume, deduplication, and corrupted/incomplete-tail recovery do not duplicate matches.
12. Generated and mutated decks always pass normal deck validation; impossible configs fail with actionable diagnostics.
13. Canonical deck hashes are stable across entry order and change when quantities/Commander change.
14. Evolutionary search rediscovers a deliberately strong synthetic synergy and preserves a viable counter in its archive.
15. Hall-of-fame evaluation prevents a synthetic population from forgetting an older counter strategy.
16. Controlled replacement analysis detects a deliberately stronger fixture card and does not flag an equivalent fixture.
17. Minimum-support and uncertainty rules suppress conclusions from tiny samples.
18. Baseline-versus-candidate common-seed pairing is correct and environment diffs are complete.
19. Report numbers reconcile exactly with raw records on a small fixture batch.
20. Existing Phase 1–3 tests remain unchanged and pass.

### 13.16 Phase 4 acceptance criteria

Phase 4 is complete when:

- A clean install can run a documented local smoke experiment with no browser or server.
- Random, aggressive, defensive, and value pilots complete games using only redacted views and authoritative legal actions.
- Identical configs reproduce identical normalized results across repeated runs and worker counts.
- The batch runner streams, resumes, mirrors seats, parallelizes, and exports validated JSON/JSONL/CSV.
- Card telemetry and attribution are tested and raw enough to independently verify derived metrics.
- Legal deck generation and evolutionary search discover strong combinations without collapsing evaluation onto a fixed opponent or single pilot.
- Controlled card-replacement tests and baseline-versus-candidate experiments work with common seeds and uncertainty reporting.
- The analyzer reports card-, interaction-, and strategy-cluster evidence, not only fixed deck win rates.
- Every automated warning carries evidence, context, sample size, uncertainty, and a non-definitive reason code.
- Abnormal matches always produce reproducible diagnostics/replays and never silently contaminate ordinary statistics.
- Performance has a repeatable benchmark and large runs do not retain unnecessary full logs.
- `npm run verify` passes and Phase 1–3 behavior remains intact.
- README, project status, experiment examples, schemas, and relevant ADRs document exactly how to reproduce the delivered results.

## 14. Real-player data, later

If the project eventually has enough players, simulated evidence can be supplemented with pseudonymous real-player data:

- Decklists and revisions
- Match results and matchups
- Turn-by-turn actions and events
- Mulligans, concessions, and disconnects
- Card substitutions between matches
- A skill estimate where one becomes available

Telemetry must be transparent and privacy-conscious. Do not blindly treat popularity as power: popular decks may be easier, cheaper, fashionable, or copied from public lists.

## 15. Engineering standards

- Enable strict TypeScript settings.
- Validate every external boundary: card JSON, deck imports, network messages, saved data, and simulator configuration.
- Keep domain errors structured and user-facing messages understandable.
- Add tests for schemas, deck legality, save migrations, artwork fallback, and all later rules.
- Use stable formatting and linting.
- Provide scripts for install, development, build, tests, type-check, and lint.
- Add a concise `README.md` with exact setup and run commands.
- Record meaningful architectural decisions in `docs/architecture/`.
- Avoid premature microservices, databases, authentication, container orchestration, or cloud-specific infrastructure.
- Keep dependencies minimal and justified.
- Never silently change confirmed game rules. Document ambiguity in `docs/rules/open-decisions.md` and implement configuration or the simplest reversible placeholder where necessary.

## 16. Phase 1 acceptance criteria — completed baseline

Phase 1 is complete when:

- A clean install and documented command start the deck builder locally.
- The card database is runtime-validated and invalid data produces actionable errors.
- Users can create, edit, duplicate, rename, delete, save, import, and export decks.
- Commander/color identity, deck size, copy limits, and unknown IDs are validated correctly.
- Search and all required filters work.
- Card artwork loads automatically from the standardized ID filename.
- Missing or broken artwork reliably falls back to the default image.
- Card text and stats are rendered dynamically and remain readable with or without artwork.
- Refreshing the browser preserves locally saved decks.
- Imported invalid or incompatible files cannot corrupt existing saved decks.
- Automated tests cover core schemas, validation, persistence, migration behavior, and artwork resolution.
- The codebase contains clean package boundaries for future rules-engine, server, and simulator work without pretending those later systems are already implemented.

## 17. Decisions confirmed after Phase 2 and remaining open decisions

The following implementation questions raised in `docs/open-questions.md` are now confirmed:

- **Q1:** Keep top-level `effects` for spell resolution and unit/relic deploy resolution. Keep triggered `abilities` only for non-deploy event triggers; migrate `on_deploy` abilities into top-level `effects` so deploy behavior has one authoring form.
- **Q2:** Add a separate validated `staticAbilities`/continuous-effects layer. Continuous effects are derived from current state and never permanently stamp recipients. Recalculate after relevant state changes. Do not author more aura/lord cards until this exists.
- **Q3:** Sacrifice may be either a cost or an effect. Activated abilities need a structured, extensible `costs` array; costs are validated and paid atomically before queueing the ability. A sacrifice instruction inside `effects` remains an effect.
- **Q23:** Effects may target players directly using the first-class player target variants in Phase 3.
- **Q24:** A sacrificed unit counts as defeated: it triggers both `on_sacrifice` and `on_defeated`. The defeat event retains `reason: "sacrificed"` so future cards can filter it.
- **Q25:** Searching a hidden zone may legally find nothing even when a valid card exists. Searching a public zone is mandatory when a legal result exists unless the effect explicitly says `up_to` or `may`.
- **Q26:** Player healing is uncapped unless an effect explicitly sets a maximum.
- **Q27:** Activated abilities use structured `costs`, supporting energy first and later discard/sacrifice/exhaust costs. Keep the placeholder Commander ability while the prototype set remains test data.
- **Q28:** Finish all authored instructions of the current card/effect before resolving triggers they create. State-based checks still occur after every atomic instruction.
- **Q29:** A source/self target is required and confirmed; prefer a discriminated `source` target over a boolean during the next schema migration.
- **Q30:** Keep strict stale-revision rejection and resend the latest authoritative player view.

Update `docs/open-questions.md`, `docs/rules/open-decisions.md`, schemas, migrations, and tests alongside implementation so confirmed items do not remain labelled open.

The following remain genuine game-design or playtest decisions:

Do not block Phase 4 on these unless implementation reveals a structural dependency:

- Final starting Health, hand size, battlefield slots, relic limit, and energy curve
- Whether exhausted units may block
- Whether multiple units may block one attacker
- Final mulligan system
- Final empty-deck/fatigue rule
- Commander summoning, combat stats, defeat, additional cost, and recovery
- Reaction-speed cards, opponent-turn actions, and any future priority system
- Piercing/overrun and other expanded keywords
- Phase timers beyond disconnect recovery
- Exact keyword behavior, especially `guardian`, `armored`, and `resilient`
- Alternate victory conditions
- Whether server-restart match persistence is ever needed
- Main-phase and pending-choice timers beyond disconnect recovery

When playtesting changes a provisional value, update the versioned rules configuration and affected tests. When a structural rule changes, update this document and add an architecture/rules decision record before implementation.

## 18. Phase 4 implementation instruction

Implement the complete Phase 4 scope in staged acceptance gates. Claude may continue through all gates automatically while the current gate's tests pass and no genuinely blocking design decision appears.

1. Inspect the completed Phase 3 implementation and run `npm run verify` as the immutable baseline.
2. Update `README.md` and `docs/project-status.md` to mark Phase 4 active. Write ADRs for bot information boundaries, seed derivation/reproducibility, telemetry provenance, and experiment storage/checkpointing.
3. Create `packages/bot-interface` with the validated deterministic bot contract, random-legal pilot, decision diagnostics, and hidden-information tests.
4. Create `apps/simulator` with validated config/result schemas, hierarchical seeds, a single-match runner, safeguards, replay bundles, and a smoke CLI.
5. Add aggressive, defensive, and value pilots with documented serializable weights. Cover all current legal actions and choices; validate them across many fixed seeds.
6. Add the streaming/resumable batch runner, mirrored schedules, deterministic worker-thread parallelism, progress reporting, JSONL/CSV sinks, and worker-count equivalence tests.
7. Add card-instance/source telemetry, explicit dead-hand categories, aggregate reconciliation tests, and sampled/abnormal replay retention.
8. Add legal random/stratified deck generation, canonical hashes, mutations, population diversity, checkpoints, and the evolutionary opponent archive.
9. Add controlled replacement experiments, strategic feature grouping, card-pair/interaction analysis, uncertainty/support handling, and evidence-backed flags.
10. Add complete baseline-versus-candidate comparison using both reference decks and independently searched populations with common seeds.
11. Produce a human-readable `report.md`, raw machine-readable outputs, example smoke/batch/search/comparison configs, and reproducible CLI documentation.
12. Run the synthetic acceptance fixtures, benchmark 1/2/4 workers, then run `npm run verify` for the whole monorepo.
13. Update `docs/project-status.md`, open questions, README, and ADRs with delivered behavior, exact commands, test counts, benchmark results, assumptions, and deliberate deferrals.

Do not pause merely because balance thresholds are not yet known: make provisional analyzer thresholds explicit and configurable, retain the raw evidence, and label the output as review guidance. Stop only when continuing would require choosing an unresolved game rule, compromising determinism/information boundaries, or changing confirmed Phase 1–3 behavior.
