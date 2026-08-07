# Card Game Prototype — Project Specification

## 1. Purpose

Build a standalone, browser-based card-game prototype for testing mechanics, cards, and balance before integrating the card game into a larger MMO.

The application should grow in this order:

1. Deck builder
2. Online 1v1 matches
3. Online free-for-all matches for up to four players
4. Local, headless AI simulations and card-balance analysis
5. Optional analysis of pseudonymous real-player match data

The first implementation milestone is the **deck builder only**. However, its data model and repository structure must already support the later deterministic rules engine, multiplayer server, and simulator. Do not implement later phases prematurely.

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

## 4. Confirmed game direction

These rules are the current direction, but some values remain configurable until playtesting confirms them.

### Decks and Commanders

- Each deck has exactly one external Commander.
- The Commander has a color identity containing one or more colors.
- A card is legal only when every color in its color identity is included in the Commander's color identity.
- Neutral/colorless cards may be used by any Commander.
- Initial prototype target: 30 cards per deck.
- Initial copy limit: two copies of a regular card and one copy of a unique card.
- Begin with single-color and two-color Commanders.
- All cards are unlocked; there is no collection, account progression, or monetization system.

### Match direction

- Universal energy increases automatically; there are no land or colored-resource cards.
- Initial target is online 1v1 through private invite-code lobbies.
- Accounts and public matchmaking are out of scope initially.
- The attacker declares attackers.
- The defending player assigns blockers.
- Blocked units deal combat damage simultaneously unless an effect says otherwise.
- Units retain damage between turns until healed or defeated.
- No opponent-turn spells, priority system, or MTG-style stack in the initial ruleset.
- Commander recovery after defeat is intended, currently proposed as three turns, but is not final.
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

Treat these as explicit state-machine states. Do not rely on UI flow to enforce phase legality.

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

## 10. Rules-engine requirements for Phase 2

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

Every rule requires unit tests. Add deterministic scenario tests for full interactions and regression tests for every reported rules bug.

## 11. Online multiplayer roadmap

After the deck builder and rules engine are stable:

### Online 1v1

- Authoritative Node.js server
- WebSocket communication
- Private invite-code lobbies
- Temporary player names; no accounts initially
- Deck validation on the server before match start
- Hidden-information-safe state updates
- Reconnection token and reasonable match recovery
- Clear handling of disconnects, timeouts, invalid actions, and version mismatch
- Structured match logs

Developers must be able to run two browser clients against a local server for testing. Do not build a disposable hot-seat mode.

### Two-to-four-player free-for-all

- Choose which opponent each attacker attacks where applicable
- Only the attacked player assigns blockers for attacks directed at them
- Explicit turn order and priority for simultaneous triggers
- Player elimination rules
- Victory conditions for the last remaining player/team, once confirmed
- Spectating after elimination

Do not begin this phase until the exact multiplayer combat, targeting, elimination, and Commander rules are documented.

## 12. Local simulation and balance laboratory

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

## 13. Real-player data, later

If the project eventually has enough players, simulated evidence can be supplemented with pseudonymous real-player data:

- Decklists and revisions
- Match results and matchups
- Turn-by-turn actions and events
- Mulligans, concessions, and disconnects
- Card substitutions between matches
- A skill estimate where one becomes available

Telemetry must be transparent and privacy-conscious. Do not blindly treat popularity as power: popular decks may be easier, cheaper, fashionable, or copied from public lists.

## 14. Engineering standards

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

## 15. Phase 1 acceptance criteria

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

## 16. Implementation instruction

Begin with Phase 1 only. Before writing substantial code:

1. Inspect the repository and preserve any existing configuration or user work.
2. Propose a short implementation plan and identify any decision that truly blocks Phase 1.
3. Create the monorepo/package boundaries and minimal card/deck schemas.
4. Implement a thin vertical slice: load cards, render them, create one deck, validate it, save it, and reload it.
5. Expand to the full Phase 1 requirements.
6. Run tests, type-checking, linting, and a production build.
7. Summarize what is complete, commands to run it, remaining open decisions, and any deliberate deviations from this specification.

Do not replace unresolved game-design decisions with elaborate assumptions. Make uncertain values configurable, document them, and keep the implementation easy to revise after playtesting.
