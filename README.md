# Card Game Prototype

A standalone, browser-based card-game prototype for testing mechanics, cards and
balance before the card game is integrated into a larger MMO.

**Current milestone: Phase 1 — the deck builder, complete.** The rules engine,
multiplayer server and simulator are not implemented; the package boundaries
that will hold them are described in
[ADR 0001](docs/architecture/0001-monorepo-and-tooling.md).

Phase-by-phase progress is in
[docs/project-status.md](docs/project-status.md); everything still undecided is
in [docs/open-questions.md](docs/open-questions.md).

The full project specification is in [CLAUDE.md](CLAUDE.md).

## Requirements

- Node.js **20.11 or newer** (developed on 24)
- npm 10+ (ships with Node)

## Setup and run

```bash
npm install       # install all workspace dependencies
npm run dev       # start the deck builder at http://localhost:5173
```

That is the whole setup. No database, no services, no environment variables.

## Scripts

| Command                       | What it does                                 |
| ----------------------------- | -------------------------------------------- |
| `npm run dev`                 | Deck builder with hot reload on port 5173    |
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

## Repository layout

```text
apps/
  web-client/           Deck builder (React + Vite)
packages/
  shared/               Result type, structured diagnostics, ID generation
  card-data/            Card schemas, structured effects, loader, query, artwork
  deck/                 Deck schema, migrations, legality, persistence, I/O
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

Dependencies flow one way: `web-client → deck → card-data → shared`. An ESLint
rule fails the build if a data package reaches into the UI or engine.

### Not yet created

`packages/rules-engine`, `packages/bot-interface`, `apps/multiplayer-server` and
`apps/simulator` belong to later phases. They are deliberately absent rather
than present as empty stubs.

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

Deck size, copy limits, colour names and keyword behaviour are all provisional
and configurable. Before changing one, read
[docs/rules/open-decisions.md](docs/rules/open-decisions.md) — and record the
change there rather than only in code.
