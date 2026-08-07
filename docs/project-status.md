# Project status — phases and milestones

Where the project actually is, phase by phase. This file is the single place to
check before starting work: it records what is done, what is deliberately not
started, and what "done" means for each remaining phase.

**Last updated:** 2026-08-07 (commit `66ae97f`)

| Phase | Scope                          | Status                  |
| ----- | ------------------------------ | ----------------------- |
| 1     | Deck builder                   | **Complete**            |
| 2     | Rules engine + online 1v1      | Not started             |
| 3     | 2–4 player free-for-all        | Not started, blocked    |
| 4     | Headless simulator and balance | Not started             |
| 5     | Pseudonymous real-player data  | Not started, contingent |

Phases 2–5 have **no code**, by design. The package boundaries that will hold
them (`packages/rules-engine`, `packages/bot-interface`,
`apps/multiplayer-server`, `apps/simulator`) are documented in
[ADR 0001](architecture/0001-monorepo-and-tooling.md) but are deliberately
absent rather than present as empty stubs.

---

## Phase 1 — Deck builder — complete

Delivered across commits `08e95be` → `66ae97f`.

### Acceptance criteria

Every criterion from CLAUDE.md §15:

| Criterion                                                        | Status | Evidence                                                                        |
| ---------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- |
| Clean install + documented command starts the builder            | Done   | `npm install && npm run dev` — [README](../README.md)                           |
| Card database runtime-validated, actionable errors               | Done   | `card-data/src/loader.ts`, `loader.test.ts`                                     |
| Create/edit/duplicate/rename/delete/save decks                   | Done   | `deck/src/operations.ts`, `builder-flow.test.tsx`                               |
| Import and export decks                                          | Done   | `deck/src/serialize.ts`, `serialize.test.ts`                                    |
| Commander identity, size, copy limits, unknown IDs               | Done   | `deck/src/validate.ts` (23 tests)                                               |
| Search and all required filters                                  | Done   | `card-data/src/query.ts`, `web-client/src/state/filters.ts`                     |
| Artwork loads from the standardised ID filename                  | Done   | `card-data/src/artwork.ts`, [ADR 0004](architecture/0004-artwork-resolution.md) |
| Missing/broken artwork falls back to the default                 | Done   | `CardArt.test.tsx` (8 tests, incl. default-image failure)                       |
| Card text and stats render dynamically                           | Done   | `web-client/src/components/` card frame                                         |
| Refresh preserves locally saved decks                            | Done   | `deck/src/repository.ts`, `persistence.test.tsx`                                |
| Invalid imports cannot corrupt saved decks                       | Done   | `serialize.test.ts` — import is validate-then-commit                            |
| Tests cover schemas, validation, persistence, migration, artwork | Done   | 160 tests across 14 files, all passing                                          |
| Clean package boundaries for later phases                        | Done   | one-way dependency rule enforced by ESLint                                      |

### What exists

- **`packages/shared`** — `Result` type, structured diagnostics, ID generation.
- **`packages/card-data`** — card schema, effect/target schemas, loader, query,
  artwork resolution. 56 cards in the bundled development set: 26 units,
  12 spells, 8 commanders, 6 relics, 4 tokens.
- **`packages/deck`** — deck schema v1, migrations, legality, persistence,
  import/export.
- **`apps/web-client`** — the deck builder (React + Vite).
- **Schema breadth beyond Phase 1 needs:** all 8 triggers from CLAUDE.md §8 and
  18 effect types are defined and validated, so card data authored now will not
  need rewriting when Phase 2 starts. **None of them execute** — validation
  only.

### Verification

`npm run verify` (typecheck + lint + test + build). Last run: 160/160 tests
passing in 14 files.

### Known gaps carried forward

Not defects — scope decisions, listed so they are not rediscovered later:

- Card art exists for 3 cards; the rest use the fallback. That is the designed
  behaviour, not an omission.
- `displayText` is authored by hand and only loosely cross-checked against
  structured effects. Generating it is a Phase 2+ concern.
- No undo/redo in the builder.
- Deck storage is browser local storage only. No cloud saves, per §5 scope.

---

## Phase 2 — Rules engine and online 1v1 — not started

Two separable milestones. The engine must land first; the server is a transport
around it.

### Milestone 2a — `packages/rules-engine`

Definition of done, from CLAUDE.md §10:

- [ ] `applyAction(state, action, context) => result` as pure state transitions
- [ ] Explicit phase state machine (the 8 provisional phases in
      [confirmed-rules.md](rules/confirmed-rules.md))
- [ ] Zones: deck, hand, battlefield, discard, Commander zone, recovery
- [ ] Card definition ID vs. in-match instance ID
- [ ] Legal-action generation and validation
- [ ] Ordered effect-resolution queue
- [ ] Events and triggers
- [ ] Serializable pending choices and resumable continuations (§9)
- [ ] Seeded RNG
- [ ] State-based checks and victory detection
- [ ] Redacted per-player views
- [ ] Structured action/event logs suitable for replay
- [ ] Unit tests per rule; deterministic scenario tests; regression test per bug

**Blocked on:** the keyword definitions and the `effects`/`abilities` question
in [open-questions.md](open-questions.md). Writing the queue before those are
settled means rewriting it.

**Dependency rule:** `rules-engine` may depend on `card-data`. Never the
reverse.

### Milestone 2b — `apps/multiplayer-server`

- [ ] Authoritative Node.js server over WebSocket
- [ ] Private invite-code lobbies, temporary names, no accounts
- [ ] Server-side deck validation before match start
- [ ] Hidden-information-safe state updates
- [ ] Reconnection token and match recovery
- [ ] Handling for disconnects, timeouts, invalid actions, version mismatch
- [ ] Two browser clients against a local server (the developer test loop)
- [ ] Structured match logs

Explicitly **not** a hot-seat mode.

---

## Phase 3 — Two-to-four-player free-for-all — not started, blocked

CLAUDE.md §11 states this phase must not begin until multiplayer combat,
targeting, elimination and Commander rules are documented. They are not. The
open items are tracked in [open-questions.md](open-questions.md) as Q10–Q13.

Scope when unblocked: attack-target choice, blocker assignment by the attacked
player only, explicit priority for simultaneous triggers, elimination, victory
conditions, spectating after elimination.

---

## Phase 4 — Simulator and balance laboratory — not started

Three separate responsibilities (§12), to be built in this order:

1. **Pilot AI** — heuristic agents: random-legal, aggressive, defensive, value.
2. **Deck search** — evolutionary generation and selection.
3. **Balance analyzer** — baseline-vs-candidate experiments on shared seeds.

`apps/simulator` imports the rules engine directly: no browser, no rendering,
no WebSockets, no server. Requires Milestone 2a and stable match logs. The
metric list in §12 is the specification for the analyzer; nothing is chosen yet.

---

## Phase 5 — Real-player data — not started, contingent

Only meaningful with a real player base. Nothing to build or decide yet beyond
not painting ourselves into a corner: match logs must already be structured and
replayable, which Milestone 2a covers.

---

## Keeping this file honest

Update it when a milestone's status changes — not at the end of a phase. If a
checkbox above is ticked without a test or a document to point at, it is not
done.
