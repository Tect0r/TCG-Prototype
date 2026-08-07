# Card Game Prototype

A standalone, browser-based card-game prototype for testing mechanics, cards and
balance before the card game is integrated into a larger MMO.

**Current milestone: Phase 2 — complete.** The deck builder (Phase 1), the
deterministic headless rules engine (Phase 2A) and online 1v1 through private
invite-code lobbies (Phase 2B) all work. The free-for-all mode and the balance
simulator are not started.

Phase-by-phase progress is in
[docs/project-status.md](docs/project-status.md); everything still undecided is
in [docs/open-questions.md](docs/open-questions.md).

The full project specification is in [CLAUDE.md](CLAUDE.md).

## Requirements

- Node.js **20.11 or newer** (developed on 24)
- npm 10+ (ships with Node)

## Setup and run

```bash
npm install         # install all workspace dependencies
npm run dev         # deck builder + match client at http://localhost:5173
npm run dev:server  # match server at ws://127.0.0.1:8787 (only needed to play)
```

That is the whole setup. No database, no accounts, no environment variables.

### Playing a match locally

Run both commands above, then open <http://localhost:5173> in **two** browser
windows and switch each to the **Play** tab.

1. In the first window, choose a display name and create a lobby. It shows a
   six-character invite code.
2. In the second, enter that code and join.
3. Each seat picks a saved deck and submits it. The server validates it against
   its own card database and rejects it with reasons if it is illegal.
4. Both seats press Ready; the match starts.

Refreshing mid-match reclaims the same seat. Closing a window starts a
90-second reconnection window before the match is lost.

To watch the engine run a match with no browser and no server at all:

```bash
npm run demo:match          # prints a full structured event log
npm run demo:match -- seed  # same match every time, for a given seed
```

## Scripts

| Command                       | What it does                                 |
| ----------------------------- | -------------------------------------------- |
| `npm run dev`                 | Web client with hot reload on port 5173      |
| `npm run dev:server`          | Authoritative match server on port 8787      |
| `npm run demo:match`          | Play a scripted match, print its event log   |
| `npm run build`               | Production build into `apps/web-client/dist` |
| `npm run preview`             | Serve the production build locally           |
| `npm test`                    | Run every test once                          |
| `npm run test:watch`          | Watch mode                                   |
| `npm run typecheck`           | Strict TypeScript check across all packages  |
| `npm run lint`                | ESLint                                       |
| `npm run format`              | Prettier, writing changes                    |
| `npm run verify`              | typecheck + lint + test + build              |
| `npm run gen:placeholder-art` | Regenerate the placeholder PNGs in `assets/` |

## What the deck builder does

- Loads and **validates** the card database at startup; invalid data stops the
  app with actionable, structured errors instead of half-working.
- Browses cards in a responsive grid, with search over name and rules text and
  filters for colour, type, energy cost, keyword, tag, role, power class,
  uniqueness and Commander legality.
- Creates, renames, duplicates, deletes and switches between decks.
- Enforces one Commander per deck, colour-identity legality, deck size and copy
  limits, with errors and warnings updating live as you build.
- Saves to browser local storage; decks survive a refresh.
- Imports and exports readable, versioned JSON that references cards by
  permanent ID only.
- Handles removed cards gracefully — unresolved IDs are listed, counted and
  removable in one click.

## What the match client and server do

- The **rules engine** (`packages/rules-engine`) is a pure, headless state
  machine: `applyAction(state, action, context)` returns the next state plus
  structured events, with no React, network, database or clock anywhere in it.
- Randomness is seeded and lives inside the match state, so the same seed and
  the same actions reproduce a match exactly.
- The **server** is authoritative for every rule, cost, target and random
  result. Clients send intents and receive a redacted view of the match; they
  never see the opponent's hand, the deck order, or the generator state.
- Legality is computed by the engine and shipped to the client, so the UI
  highlights what is playable without knowing a single rule.
- Actions carry a client-generated ID, so retrying after a reconnect can never
  play a card twice.

## Repository layout

```text
apps/
  web-client/           Deck builder and match UI (React + Vite)
  multiplayer-server/    Authoritative 1v1 server (Node + ws)
packages/
  shared/               Result type, structured diagnostics, ID generation
  card-data/            Card schemas, structured effects, loader, query, artwork
  deck/                 Deck schema, migrations, legality, persistence, I/O
  rules-engine/         Deterministic match state, effects, combat, views
  protocol/             Versioned client/server message schemas
assets/
  card-art/             Optional card artwork, discovered by card ID
  defaults/             Fallback card image
docs/
  project-status.md     Phase and milestone progress
  open-questions.md     Undecided questions, and what they block
  rules/                Confirmed rules and open design decisions
  architecture/         Architecture decision records
scripts/                Development utilities
```

Dependencies flow one way:

```text
web-client ─┬─> protocol ─> rules-engine ─> card-data ─> shared
            └─> deck ──────────────────────^
multiplayer-server ─> protocol, deck, rules-engine, card-data, shared
```

`card-data` never imports the UI, the server or the engine, and an ESLint rule
fails the build if it tries.

### Not yet created

`packages/bot-interface` and `apps/simulator` belong to Phase 4. They are
deliberately absent rather than present as empty stubs.

## Adding card artwork

Drop a PNG named after the card's permanent ID into `assets/card-art/`:

```text
assets/card-art/goblin_scout.png
```

No data change and no code change. Standard size is 768 × 1024 px. If the file
is missing or fails to load, the card falls back to
`assets/defaults/default_card.png`, and if that fails too the card renders as a
readable text-only frame. See
[ADR 0004](docs/architecture/0004-artwork-resolution.md).

## Adding or editing cards

Cards live in `packages/card-data/src/data/prototype_core.json`. Every card
needs a permanent `lowercase_snake_case` ID that must never change once it has
shipped. Run `npm test` after editing — the card database is validated by the
test suite, and the bundled set is asserted to load with zero warnings.

The development set is generic on purpose: it exists to exercise every filter
and validation path, not to establish lore, factions or art direction.

## Design decisions in flux

Deck size, copy limits, colour names, keyword behaviour and every match rule
number are provisional and configurable — deck-building limits in
`DEFAULT_DECK_FORMAT`, match rules in `RulesConfig`. Nothing in the engine
inlines a rule number.

Two keywords (`guardian`, `resilient`) are authored on cards but deliberately do
nothing yet, because every candidate meaning would have been an invention rather
than a decision. Before changing any of this, read
[docs/rules/open-decisions.md](docs/rules/open-decisions.md) — and record the
change there rather than only in code.
