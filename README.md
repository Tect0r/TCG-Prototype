# Card Game Prototype

A standalone, browser-based card-game prototype for testing mechanics, cards and
balance before the card game is integrated into a larger MMO.

**Current milestone: Phase 4 — hardening in progress.** The deck builder
(Phase 1), the deterministic headless rules engine (Phase 2A), online 1v1
(Phase 2B), the two-to-four-player free-for-all (Phase 3) and the local balance
laboratory (Phase 4) all work. Phase 4's analytical contracts are being audited
and corrected against
[docs/PHASE4_HARDENING.md](docs/PHASE4_HARDENING.md); see
[docs/project-status.md](docs/project-status.md) for what is done and what is
still open.

The laboratory produces reproducible evidence about cards. It does **not** prove
that anything is balanced, and it is not built to: it runs matches with
heuristic pilots, records what happened, and flags what a human should look at.

Phase-by-phase progress is in
[docs/project-status.md](docs/project-status.md); everything still undecided is
in [docs/open-questions.md](docs/open-questions.md).

The full project specification is in [CLAUDE.md](CLAUDE.md).

## Requirements

- Node.js **24.15.0** — pinned in [`.nvmrc`](.nvmrc) and [`.node-version`](.node-version),
  enforced by `package.json#engines`, and used by CI. The 24 line is the lowest
  version `jsdom@30` accepts, so an older Node installs but fails the tests.
  `nvm use` (or `fnm use`) in the repository root picks it up.
- npm 10+ (ships with Node)

## Setup and run

```bash
npm install         # install all workspace dependencies
npm run dev         # deck builder + match client at http://localhost:5173
npm run dev:server  # match server at ws://127.0.0.1:8787 (only needed to play)
```

That is the whole setup. No database, no accounts, no environment variables.

### Playing a match locally

Run both commands above, then open <http://localhost:5173> in **one browser
window per player** (two to four) and switch each to the **Play** tab.

1. In the first window, choose a display name, pick the table size (2–4) and
   create a lobby. It shows a six-character invite code.
2. In each other window, enter that code and join.
3. Each seat picks a saved deck and submits it. The server validates it against
   its own card database and rejects it with reasons if it is illegal.
4. Every seat presses Ready. A 1v1 then starts by itself; at a larger table the
   host presses Start, because "everyone seated is ready" is a legal state at
   two of four seats and only the host knows whether they are still waiting.

In a free-for-all every player takes a complete turn in a seat order rolled from
the match seed, each attacker picks which opponent it is attacking, and only the
attacked player assigns blockers. The last player standing wins; an eliminated
player keeps watching but cannot act.

Refreshing mid-match reclaims the same seat. Closing a window starts a
90-second reconnection window before that seat is eliminated — at three or four
seats the others carry on without it.

To watch the engine run a match with no browser and no server at all:

```bash
npm run demo:match          # prints a full structured event log
npm run demo:match -- seed  # same match every time, for a given seed
```

## Scripts

| Command                       | What it does                                  |
| ----------------------------- | --------------------------------------------- |
| `npm run dev`                 | Web client with hot reload on port 5173       |
| `npm run dev:server`          | Authoritative match server on port 8787       |
| `npm run demo:match`          | Play a scripted match, print its event log    |
| `npm run simulate`            | Run a simulator experiment from a config      |
| `npm run bench`               | Benchmark the simulator at 1, 2 and 4 workers |
| `npm run build`               | Production build into `apps/web-client/dist`  |
| `npm run preview`             | Serve the production build locally            |
| `npm test`                    | Run every test once                           |
| `npm run test:watch`          | Watch mode                                    |
| `npm run typecheck`           | Strict TypeScript check across all packages   |
| `npm run lint`                | ESLint                                        |
| `npm run format`              | Prettier, writing changes                     |
| `npm run validate:content`    | Check cards, registries, rulebook, templates  |
| `npm run verify`              | typecheck + lint + content + test + build     |
| `npm run gen:placeholder-art` | Regenerate the placeholder PNGs in `assets/`  |

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

## Player help

The game explains itself, from the same data it runs on.

- A **Rulebook** button in the lobby opens a searchable, keyboard-accessible
  overlay covering every rule the game actually implements — objective, setup,
  deck building, card anatomy, energy, turn phases, combat, damage, Commanders,
  free-for-all, targeting, keywords, glossary, a worked first turn and the
  common edge cases. It opens over the lobby, so nothing is lost while you read.
- Every number in it — starting health, hand size, unit slots, deck size — is a
  live reference to the shared configuration, not a copied number. Tune a
  provisional value and the rulebook follows.
- A **`? Help`** toggle in a match makes every visible card readable. Clicking a
  card in Help mode opens an inspector and cannot play, target, attack with or
  select it. Hands, decks and private choices belonging to other players are not
  in your view at all, so they cannot be inspected either.
- The inspector shows the card's printed text **and** a step-by-step explanation
  generated from its structured effects, clearly labelled as generated. Trigger
  timing, activation costs, usage limits, target filters and keyword definitions
  all come from shared registries.
- Contextual status ("You can play this now for 2 energy", "This unit arrived
  this turn") comes from the server's own legal-action data. Where the client
  cannot know why something is illegal, it says so rather than guessing.

Keywords, effect types, triggers and the glossary each have exactly one
definition in the repository, and keyword definitions describe what the engine
does today — including saying plainly that `Guardian` and `Resilient` currently
do nothing.

To add or change a card, see **[docs/ADDING_CARDS.md](docs/ADDING_CARDS.md)**.
An ordinary card is a data edit plus an optional PNG; no UI code is involved.
`npm run validate:content` proves the pool is coherent and that every effect on
every card can actually be explained to a player.

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

## The balance laboratory

Everything below runs locally, with no browser and no server. It imports the
same rules engine, card database and deck format that human matches use.

```bash
npm run simulate -- --config experiments/smoke.json                # ~12 matches
npm run simulate -- --config experiments/batch.json --workers 8    # a real batch
npm run simulate -- --config experiments/abuse-search.json         # evolutionary search, 2 replicates
npm run simulate -- --config experiments/replacement.json          # controlled substitution
npm run simulate -- --config experiments/candidate-vs-baseline.json
npm run simulate -- --config experiments/pilot-robustness.json     # do conclusions survive re-tuning?
```

Other flags: `--output <dir>` to place the experiment directory, `--resume` to
continue an interrupted run, `--quiet` to suppress progress, `--help`.

### Replaying one match

```bash
npm run simulate -- --replay results/<experiment>/replays/<match>.json
npm run simulate -- --replay results/<experiment>/replays/<match>.json --trace
```

This re-derives the recorded match and compares the events and the result against
the bundle. It prints the first divergence — sequence number, the action being
applied, expected and actual — and exits nonzero, so a change in engine behaviour
is a build failure rather than a second plausible-looking artefact.

It takes no configuration and never reads the card database. Every bundle embeds
the **fully resolved** environment it was played under — each card definition in
full, the rules configuration, and the deck format — so a bundle reproduces even
after the cards in this repository are renamed, recosted, rewritten, or deleted.
A bundle whose stored hashes disagree with its own content is a hard error.

Every experiment also writes that snapshot beside its results, as
`resolved-environment.json` and as a content-addressed copy under
`environments/`.

### Four hashes, not one

An environment carries four hashes because they answer different questions, and
a single hash answered none of them precisely:

| Hash               | Answers                                      |
| ------------------ | -------------------------------------------- |
| `mechanicsHash`    | Will the engine replay this identically?     |
| `pilotInputHash`   | Will the same pilot make the same decisions? |
| `presentationHash` | Has any player-facing text changed?          |
| `fullContentHash`  | Is this byte-for-byte the same content?      |

So correcting a typo in a card's display text no longer invalidates an
experiment, while changing its cost, tags or effects does. All four appear in
`report.md` and `manifest.json`.

For an ordinary balance edit, prefer a card **patch** over duplicating a whole
definition into `cardOverrides`:

```json
{ "cardId": "scorch", "note": "one cheaper", "patch": { "cost": 2 } }
```

A patch changes only the fields it names, is re-validated as a complete card, and
the environment diff — including the full before and after definitions printed in
the report — is derived from what actually resolved rather than from the prose.

Each run writes a directory described in
[ADR 0012](docs/architecture/0012-experiment-storage-and-checkpointing.md) and
[ADR 0014](docs/architecture/0014-unified-match-stream-and-reference-populations.md).
**Every** experiment kind — batch, search, replacement, comparison and
robustness — streams its raw records to one `matches.jsonl`, one
runtime-validated line per match, and every number in `summary.json` and
`report.md` is recomputable from it. `--resume` therefore means the same thing
for a search or a comparison as for a batch: skip what is already committed,
re-run nothing, and refuse to merge records written under a different
configuration hash. A run killed mid-write leaves a partial final line, which is
dropped once, reported in the manifest, and re-run.

A record's identity is `arm + matchId`, so a comparison's two arms, a search's
generations and a robustness run's profiles share one stream without colliding.

**Four pilots** — `random_legal`, `aggressive`, `defensive`, `value` — play using
only the redacted view and the legal actions a human client would receive
([ADR 0009](docs/architecture/0009-bot-information-boundary.md)). Their weights
are named, serializable and overridable per experiment.

**Reproducibility** is structural, not aspirational: seeds are hashes of a
readable derivation path, so the same config produces byte-identical records
whatever the worker count
([ADR 0010](docs/architecture/0010-seed-derivation-and-reproducibility.md)).
Paired comparisons — baseline versus candidate, and card replacement — play the
_same_ games in both arms.

**What it reports** is review guidance with evidence attached: every flag is
`review_recommended`, `possible_interaction`, `insufficient_data` or
`run_quality`, and carries a reason code, the numbers it was computed from, a
sample size and an uncertainty interval. There is deliberately no "overpowered"
and no "balanced". A finding below the configured minimum sample is downgraded to
`insufficient_data` rather than dropped, so "we do not know" stays visible.

`report.md` is self-auditing: it opens with limitations, then a provenance table
carrying the configuration hash, card-pool hashes, frozen reference-population
hash, schema and seed-derivation versions, pilot versions, every threshold used,
and the completed / failed / abnormal / excluded / resumed match counts. Worker
count is printed and explicitly marked non-semantic. The JSON is authoritative;
Markdown and CSV are views of it, and a regression test checks they agree.

### What the numbers mean

Several metrics say what they measure rather than what is convenient:

- **`playsPerDraw`** is play events over draw events and is **unbounded** — a
  card returned to hand and replayed exceeds 1. It is printed as a multiplier,
  never a percentage. The bounded questions have their own names:
  `drawnCopyPlayConversion` (drawn copies ever played, 0–1) and
  `gamesDrawnAndPlayedShare` (0–1).
- **Dead-in-hand** splits into a mechanical half — never affordable, no board
  capacity, no legal target, no legal window — and a strategic half — legal but
  unchosen, held at the end. A card the pilots simply did not want is a fact
  about the pilots, and is never reported as an unplayable card.
- **`broad_cross_cluster_inclusion`** measures coverage of _strategic clusters_,
  not the share of decks running a card. Thirty near-identical decks are one
  strategy counted thirty times. Deck share is kept, separately, as
  `deckInclusionShare`.
- **Card-pair synergy** is the 2×2 difference-in-differences over all four cells
  (both, A only, B only, neither), with a stratified bootstrap interval that
  propagates every cell. A sparse cell returns _insufficient evidence_, because
  the contrast is then undefined rather than merely imprecise.
- **Replacement and baseline/candidate deltas** are analysed as **paired**
  outcomes, since both arms play the same games on the same seeds. Incomplete
  pairs are excluded, counted and reported, never quietly pooled.
- **Displacement** compares normalized inclusion shares across independent
  search replicates and must clear the between-replicate variation of the same
  environment. A single run's `6 → 3` is search noise and is reported as such.
- **Counter breadth** is card-level only when controlled replacement evidence
  supports it; otherwise it reports `unavailable`, and the cluster matchup count
  is kept under its own honest name.

The estimators and their guarantees are recorded in
[ADR 0013](docs/architecture/0013-statistical-contracts.md).

### Reference versus discovery populations

A baseline-versus-candidate comparison answers two different questions and keeps
them apart:

- **Reference impact** — one population, resolved once against the baseline,
  content-hashed, and replayed _unchanged_ in both environments on common random
  numbers. Decks illegal in either environment are excluded from both arms with
  their reasons, never repaired for one side. The two arms' population hashes
  must match or the comparison refuses to run.
- **Discovery impact** — an independent deck search in _each_ environment, which
  is the only way to see abuse a new card enables, since a reference population
  by construction cannot contain a card that did not exist when it was built.

A comparison also declares what it changes, and the declaration is checked
against the two resolved card pools **before any match runs**. A candidate that
is structurally identical to its baseline, or that differs in a field the
experiment did not declare, is rejected rather than measured.

Measured on this machine (`npm run bench`, 120 matches, 6 generated decks):

| Workers | Matches/s | Actions/s | Peak heap | Wall clock |
| ------- | --------- | --------- | --------- | ---------- |
| 1       | 3.52      | 443       | 110 MB    | 34.1 s     |
| 2       | 4.36      | 549       | 54 MB     | 27.5 s     |
| 4       | 7.95      | 1001      | 52 MB     | 15.1 s     |

2.26× at four workers, with results identical across all three — the benchmark
asserts that rather than reporting it.

## Repository layout

```text
apps/
  web-client/           Deck builder and match UI (React + Vite)
  multiplayer-server/    Authoritative 1v1 server (Node + ws)
  simulator/            Headless experiments, deck search, balance analysis
packages/
  shared/               Result type, structured diagnostics, ID generation
  card-data/            Card schemas, structured effects, loader, query, artwork
  deck/                 Deck schema, migrations, legality, persistence, I/O
  rules-engine/         Deterministic match state, effects, combat, views
  protocol/             Versioned client/server message schemas
  bot-interface/        Pilot contract, heuristics, the four built-in pilots
experiments/            Example experiment configurations
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
simulator ─> bot-interface ─> rules-engine, card-data
          └─> deck, rules-engine, card-data, shared
```

`card-data` never imports the UI, the server or the engine, and an ESLint rule
fails the build if it tries. `rules-engine` does not import `bot-interface`, and
the simulator imports neither the web client nor the multiplayer server.

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

Cards live one-per-file under `content/sets/<setId>/`, and are compiled into
`packages/card-data/src/data/generated/content-bundle.json` by
`npm run content:build` (`npm run content:check` fails the build when the bundle
is stale). Scaffold a new one with
`npm run cards:new -- --set <setId> --type <type> --id <card_id>`. Every card
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
