# Card Game Prototype — Project Specification

## 1. Purpose

Build a standalone, browser-based card-game prototype for testing mechanics, cards, and balance before integrating the card game into a larger MMO.

The application should grow in this order:

1. Deck builder
2. Online 1v1 matches
3. Online free-for-all matches for up to four players
4. Local, headless AI simulations and card-balance analysis
5. Optional analysis of pseudonymous real-player match data

Phase 1, the deck builder, is complete. The active implementation milestone is now **Phase 2: a deterministic headless rules engine followed by online 1v1**. Preserve the working deck builder and its saved-data compatibility while extending the project.

## 2. Core design principles

- The server will eventually be authoritative. Clients request actions; the server validates and resolves them.
- All game rules must live in a shared, deterministic, headless rules-engine package—not in the UI, network layer, or animations.
- Card rules are structured data. The game must never interpret human-readable effect text to determine behavior.
- Human-readable card text is presentation only and should preferably be generated from structured effects where practical.
- The same card definitions and rules engine must be used by the web client, multiplayer server, automated tests, and local simulator.
- Randomness must be seeded and reproducible.
- Saved formats must be versioned and validated at runtime.
- Internal IDs are permanent and language-independent. Display names may change without breaking decks, artwork, logs, or replays.
- Prefer clear, testable systems over clever abstractions. Do not build a general scripting language in v0.1.

## 3. Recommended technology and repository structure

Use a TypeScript monorepo. Prefer a stable, mainstream toolchain such as pnpm workspaces with React and Vite for the client, Node.js for server-side applications, Zod for runtime schema validation, and Vitest for tests.

Suggested structure:

```text
apps/
  web-client/             # Deck builder now; match UI later
  multiplayer-server/     # Later: authoritative online matches
  simulator/              # Later: local headless simulations
packages/
  card-data/              # Card definitions, schemas, loaders, validation
  rules-engine/           # Later: deterministic game state and rules
  bot-interface/          # Later: common interface for AI agents
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

## 12. Later online free-for-all roadmap

Developers must be able to run two browser clients against a local server for testing. Do not build a disposable hot-seat mode.

- Choose which opponent each attacker attacks where applicable
- Only the attacked player assigns blockers for attacks directed at them
- Explicit turn order and priority for simultaneous triggers
- Player elimination rules
- Victory conditions for the last remaining player/team, once confirmed
- Spectating after elimination

Do not begin this phase until the exact multiplayer combat, targeting, elimination, and Commander rules are documented.

## 13. Local simulation and balance laboratory

The simulator must import the shared rules engine directly. It must not use browsers, rendering, WebSockets, or the multiplayer server. It should run many matches in memory, use seeded randomness, and parallelize safely across CPU workers.

Separate three responsibilities:

1. **Pilot AI:** selects legal actions while playing a supplied deck.
2. **Deck search:** generates, mutates, and selects decks to discover strong combinations and counters.
3. **Balance analyzer:** compares environments and diagnoses suspicious cards/interactions.

Start later with heuristic pilots such as random-legal, aggressive, defensive, and value-oriented agents. Evolutionary deck search is likely more useful than machine learning initially. Learning through self-play can be added only after stable rules and reliable logs exist.

The goal is a healthy plural meta: multiple viable strategies with soft counter relationships, no single deck that dominates almost everything, and no mandatory narrow silver-bullet counter.

Analysis must focus primarily on cards and interactions, not fixed deck win rates, because players create their own decks.

Track and compare cards within relevant cost, role, power-class, strategy, and dependency groups. Useful metrics include:

- Inclusion rate in generated deck populations
- Draw and play rate
- Dead-hand rate
- Energy efficiency
- Marginal performance when replacing the closest alternative in otherwise similar decks
- Archetype/strategy spread
- Matchup impact and polarization
- Synergy dependence
- Counter availability and counter breadth
- Power spikes after drawing or playing the card
- Displacement of older or comparable cards
- Infinite loops, soft locks, abnormal board states, and excessive match length
- First-player advantage

For a new card or rules change, support reproducible baseline-versus-candidate experiments using the same seeds, pilot populations, and deck-search settings where possible.

High-impact cards are not inherently unbalanced. Evaluate impact relative to energy cost, role, setup requirements, strategic dependency, vulnerability, and counterplay. A centerpiece card should not be compared directly with a minor token.

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

## 17. Open decisions after Phase 2

Do not block Phase 2 on these unless implementation reveals a structural dependency:

- Final starting Health, hand size, battlefield slots, relic limit, and energy curve
- Whether exhausted units may block
- Whether multiple units may block one attacker
- Final mulligan system
- Final empty-deck/fatigue rule
- Commander summoning, combat stats, defeat, additional cost, and recovery
- Reaction-speed cards, opponent-turn actions, and any future priority system
- Piercing/overrun and other expanded keywords
- Phase timers beyond disconnect recovery
- Multiplayer politics, targeting, elimination, and simultaneous-trigger ownership

When playtesting changes a provisional value, update the versioned rules configuration and affected tests. When a structural rule changes, update this document and add an architecture/rules decision record before implementation.

## 18. Phase 2 implementation instruction

Implement Phase 2 in two strict subphases. Before writing substantial code:

1. Inspect the repository and preserve any existing configuration or user work.
2. Verify Phase 1 tests/build and document the actual package boundaries before modifying them.
3. Propose a short Phase 2A plan and flag only decisions that truly block the deterministic engine.
4. Implement the versioned rules configuration and runtime schemas.
5. Build one thin headless vertical slice: seeded setup, draw, play a basic unit, pass phases, attack, block, resolve damage, and finish a match.
6. Expand to the required effects, triggers, choices, redacted views, logs, and complete Phase 2A test suite.
7. Stop and report Phase 2A results. Do not start networking until its acceptance criteria pass.
8. Implement Phase 2B lobby/server protocol, then the smallest match UI consuming authoritative player views.
9. Add reconnection, idempotency, error handling, integration tests, and the remaining UI requirements.
10. Run tests, type-checking, linting, and production builds for the entire monorepo.
11. Summarize completed work, exact run commands, rules/configuration assumptions, test results, open decisions, and deliberate deviations.

Do not replace unresolved game-design decisions with elaborate assumptions. Make uncertain values configurable, document them, and keep the implementation easy to revise after playtesting.
