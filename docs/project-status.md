# Project status — phases and milestones

Where the project actually is, phase by phase. This file is the single place to
check before starting work: it records what is done, what is deliberately not
started, and what "done" means for each remaining phase.

**Last updated:** 2026-08-08

| Phase | Scope                          | Status                  |
| ----- | ------------------------------ | ----------------------- |
| 1     | Deck builder                   | **Complete**            |
| 2A    | Deterministic rules engine     | **Complete**            |
| 2B    | Online 1v1                     | **Complete**            |
| 3     | 2–4 player free-for-all        | **Complete**            |
| 4     | Headless simulator and balance | **Complete**            |
| 5     | Pseudonymous real-player data  | Not started, contingent |

**Verification for the whole monorepo:** `npm run verify` (typecheck → lint →
test → build). Last run: **544 tests in 35 files, all passing**; typecheck,
ESLint, Prettier and the production build all clean.

---

## Phase 1 — Deck builder — complete

Delivered across commits `08e95be` → `66ae97f`. Every acceptance criterion from
CLAUDE.md §16 is met; the detailed table is preserved in the git history of this
file. Phase 2 did not change any Phase 1 behaviour, and the builder's tests
(`builder-flow`, `persistence`, `CardArt`, deck and card-data suites) all still
pass unmodified.

### What Phase 2 changed in Phase 1 packages

Three additive changes, all backward compatible with existing saved decks:

- `targetsSource: boolean` on `TargetSelector` — CLAUDE.md §10 requires a
  `source` target and a zone-and-filter selector cannot express "the card this is
  printed on". Two bundled cards now use it. Tracked as Q29.
- `activatedAbilities` on `CardDefinition` — the schema had no way to express an
  activated Commander ability, which §10 requires the engine to support. Tracked
  as Q27.
- `lintDisplayText` now also inspects `activatedAbilities`, so text/effect drift
  is still caught in the new field.

Saved deck format is untouched: no migration was needed.

---

## Phase 2A — Rules engine — complete

`packages/rules-engine`. Design rationale in
[ADR 0005](architecture/0005-rules-engine.md).

### Acceptance criteria (CLAUDE.md §10)

| Criterion                                                      | Evidence                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Runs complete 1v1 matches with no React/network/DB/wall clock  | `harness/scripted-match.test.ts` — full matches across four seeds |
| All state, actions, events, choices, results runtime-validated | Zod schemas in `src/schema/`; `serialize.ts` round trip           |
| All provisional values from one versioned rules configuration  | `config.ts`; nothing in the engine inlines a rule number          |
| Invalid actions never partially mutate state                   | `applyAction` works on a clone; asserted in `scenarios.test.ts`   |
| Seeded matches exactly reproducible                            | scenario 14 and the harness replay test                           |
| Pending choices survive JSON serialisation and resume          | scenario 15                                                       |
| Player views do not leak hidden information                    | scenario 16 and the server's hidden-information suite             |
| Required effects and triggers pass tests                       | `effects.test.ts`, `keywords.test.ts`, `scenarios.test.ts`        |
| A CLI harness plays a scripted match and prints its event log  | `npm run demo:match`                                              |

### The seventeen required scenarios

All present in `packages/rules-engine/src/scenarios.test.ts`, numbered to match
CLAUDE.md §10: setup and mulligan, energy and the skipped draw, unit play and
slots and summoning sickness, unblocked damage, blocked combat with zero/one/both
defeated, persistent damage and healing, an untargetable spell, a paused
discard-then-draw, trigger ordering, token creation with a full board,
simultaneous loss, empty-deck loss mid-draw, concession and timeout, seeded
reproducibility, serialisation during a choice, redaction, and the loop
safeguard.

### Tests

| Suite                            | Tests | Covers                                                |
| -------------------------------- | ----- | ----------------------------------------------------- |
| `scenarios.test.ts`              | 41    | the 17 required scenarios plus cross-cutting rules    |
| `effects.test.ts`                | 12    | one per v0.2 effect handler, plus activated abilities |
| `keywords.test.ts`               | 9     | one per implemented keyword; inertness of the others  |
| `rng.test.ts`                    | 7     | determinism, bounds, JSON round trip, shuffle         |
| `harness/scripted-match.test.ts` | 7     | complete matches, replay, dense event numbering       |

### Bugs found by the test suite, and fixed

- Events emitted directly by an action handler (`unit_deployed`,
  `attackers_declared`, `blockers_assigned`) never reached trigger discovery, so
  `on_deploy`, `on_attack` and `on_block` silently never fired. Found by the
  defeat-trigger scenario.
- The server marked a lobby `finished` before broadcasting, so the "match over"
  lobby update was suppressed and clients never learned the lobby had ended.

### Known gaps, carried deliberately

- `guardian` and `resilient` are inert. See
  [open-decisions.md](rules/open-decisions.md#keywords) and Q4.
- Commanders never enter the battlefield, so six of the eight triggers can never
  fire on a Commander. Deferred by CLAUDE.md §4.

Two gaps recorded here at the end of Phase 2A were **closed by Phase 3**: there
is now a continuous-effects layer, so "your units gain X" tracks the board
(Q2, [ADR 0008](architecture/0008-continuous-effects.md)), and effects can
target players directly through first-class `player`/`players` targets (Q23).

---

## Phase 2B — Online 1v1 — complete

`packages/protocol` and `apps/multiplayer-server`, plus the match screen in
`apps/web-client`. Design rationale in
[ADR 0006](architecture/0006-network-protocol.md).

### Acceptance criteria (CLAUDE.md §11)

| Criterion                                                       | Evidence                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| Create/join an invite lobby, submit decks, finish a full match  | `match-server.test.ts` — a full match driven only by `legalActions` |
| Server authoritative for every rule, target, cost and random    | only the server calls `applyAction`; clients receive views          |
| Neither client receives the opponent's hand or deck order       | hidden-information suite; `playerView` omits rather than blanks     |
| Reconnect restores the match without duplicate actions          | reconnection suite, including an action replayed after a drop       |
| Invalid, stale, duplicated, out-of-turn actions safely rejected | actions suite — one test per rejection path                         |
| Disconnect expiry, concession, health loss, empty deck, draw    | covered in the server and engine suites                             |
| Version mismatch produces a clear actionable message            | server suite and `match-flow.test.tsx`                              |
| Integration tests cover the required surface                    | 20 protocol tests + 3 real-socket tests + 9 UI tests                |
| Phase 1 deck creation, persistence, import, export still work   | Phase 1 suites unchanged and passing                                |

### Running two clients against a local server

```bash
npm run dev:server      # ws://127.0.0.1:8787, plus GET /health
npm run dev             # http://localhost:5173
```

Open the client twice, switch to the **Play** tab in both, create a lobby in one
and join with its code in the other. Each seat submits a saved deck and readies
up; the match starts when both are ready.

### Known limitations, deliberate for this phase

- **Lobbies and matches are in memory only.** Restarting the server ends every
  live match. CLAUDE.md §11 explicitly allows this and warns against adding a
  database to solve it yet. The server says so in its startup banner.
- Reconnect tokens live in `sessionStorage` and expire with the lobby. They are
  not a security boundary — there are no accounts.
- No public matchmaking, no spectating, no chat. All out of scope.
- The match UI is deliberately plain. Animations are not implemented at all,
  which trivially satisfies "animations must never own or delay game rules".

---

## Phase 3 — Two-to-four-player free-for-all — complete

Unblocked on 2026-08-07 and delivered on 2026-08-08. Design rationale in
[ADR 0007](architecture/0007-free-for-all-state.md) (seat order, multi-defender
combat, player targets, elimination) and
[ADR 0008](architecture/0008-continuous-effects.md) (static abilities).

### Schema and authoring work done first (CLAUDE.md §18 steps 2–3)

The confirmed answers from §17 landed before any multiplayer engine work:

| Item                                                        | Where                                           |
| ----------------------------------------------------------- | ----------------------------------------------- |
| One authoring form for deploy effects (Q1)                  | `card-data/src/migrate.ts` folds `on_deploy` in |
| `staticAbilities` continuous layer (Q2)                     | `rules-engine/src/continuous.ts`                |
| Structured activation `costs` (Q3, Q27)                     | `card-data/src/schema/card.ts`                  |
| First-class player/source targets (Q23, Q29)                | `card-data/src/schema/target.ts`                |
| Stable seat order, ownership/control, multi-defender combat | `rules-engine/src/schema/state.ts`              |

Card data is migrated on load, so no hand-editing of `prototype_core.json` was
needed and older card JSON still validates.

### Acceptance criteria (CLAUDE.md §12)

| Criterion                                                         | Evidence                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Two to four browsers create/join one lobby and finish a match     | `match-server.test.ts` — 2/3/4-seat tables end to end      |
| Multi-defender combat, triggers, elimination, victory determinism | `free-for-all.test.ts` §§3–9, 11                           |
| Server authoritative; no player sees another's hidden information | redaction suites at both engine and server layers          |
| Arrival order of independent choices cannot change the result     | `free-for-all.test.ts` §5 submits blocks in both orders    |
| Eliminated players spectate but cannot act                        | engine §14 plus the server's `engine/eliminated` rejection |
| Phase 1 and Phase 2 tests and behaviour intact                    | every earlier suite passes unmodified                      |
| New engine, protocol, server and client tests                     | 36 engine + 14 server + 5 UI tests added                   |
| `npm run verify` passes for the whole monorepo                    | 325 tests in 23 files                                      |

### The fifteen required tests

`packages/rules-engine/src/free-for-all.test.ts` is numbered to match CLAUDE.md
§12 so a missing case is obvious: two/three/four-player starts, circular turns
skipping eliminated seats, split attacks, illegal blockers, independent blocker
submissions, simultaneous multi-defender combat, `opponent` and `each_opponent`
targeting, trigger ordering, elimination cleanup, timeout elimination, victory
and draw, four-player redaction, determinism and replay, and spectating.

Items 13 (per-seat reconnection and idempotent replay) and 15 (1v1 unchanged)
are server-level and live in `apps/multiplayer-server/src/match-server.test.ts`.

### Bugs found by the new tests, and fixed

- **Concession never cleaned up in a multiplayer game.** `handleTermination`
  called `concludeIfOver` rather than the full state-based check. In 1v1 that
  was invisible because a concession ended the match; with three seats the
  loser's board, cards and pending attacks stayed on the table.
- **`card_drawn` leaked another player's instance IDs.** The event redacted
  `definitionId` but not `instanceId`, so a viewer could track which physical
  cards a rival kept through a mulligan. `instanceId` is now nullable and
  nulled for everyone but the drawer.
- **A token-type card only ceased to exist if the `isToken` flag was set.**
  `moveToZone` now also treats a `token`-type definition as a token, so
  tokenness cannot be lost by whatever route the card reached play.

### Running a three- or four-player table

```bash
npm run dev:server      # ws://127.0.0.1:8787
npm run dev             # http://localhost:5173
```

Open the client once per player and switch each to the **Play** tab. The host
creates a lobby and picks the seat count; everyone else joins with the invite
code. Each seat submits a deck and readies up. A 1v1 starts by itself, exactly
as in Phase 2B; a larger table waits for the host to start it, because
"everyone seated is ready" is a legal state at two of four seats.

### Known limitations, deliberate for this phase

- Seat order is rolled from the match seed, so joining first cannot buy a better
  table position. Players cannot choose seats.
- No teams, table politics, chat, public matchmaking, reactions or priority
  stack. All explicitly out of scope.
- Commanders still never enter the battlefield, so Commander defeat and recovery
  remain deferred.
- Lobbies and matches are still in memory only; a server restart ends them.
- Multiple blockers per attacker is still unimplemented, but `blocks` is already
  a list of pairs, so it is no longer structurally blocked.

---

## Phase 4 — Simulator and balance laboratory — complete

`packages/bot-interface` and `apps/simulator`. Everything here runs locally with
no browser, no server, no database and no wall clock, against the same rules
engine, card database, deck format and migrations that human matches use.

### What was delivered

| Area                   | Where                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Pilot contract         | `bot-interface/src/types.ts`, `validate.ts`, `run-pilot.ts`                                                           |
| Four pilots            | `random-legal.ts`, `aggressive.ts`, `defensive.ts`, `value.ts` + shared `scoring.ts`, `candidates.ts`, `heuristic.ts` |
| Hierarchical seeds     | `simulator/src/seed.ts`, `hash.ts`                                                                                    |
| Environments and diffs | `simulator/src/environment.ts`                                                                                        |
| Single-match runner    | `simulator/src/run-match.ts`, `run-one.ts`                                                                            |
| Telemetry              | `simulator/src/telemetry/`                                                                                            |
| Schedules and batches  | `simulator/src/schedule.ts`, `run-batch.ts`, `workers/`                                                               |
| Deck generation/search | `simulator/src/deck-search/`                                                                                          |
| Analysis               | `simulator/src/analysis/`                                                                                             |
| Reporting and CLI      | `simulator/src/reporting/`, `experiment.ts`, `cli.ts`, `benchmark.ts`                                                 |
| Example configs        | `experiments/*.json`                                                                                                  |

Four experiment kinds run end to end: `batch`, `replacement`, `search` and
`comparison`.

### Decisions recorded

- [ADR 0009](architecture/0009-bot-information-boundary.md) — a pilot receives a
  six-field observation containing the redacted `PlayerView` and the engine's
  `LegalActions`, and nothing else. The boundary is a type, not a convention.
- [ADR 0010](architecture/0010-seed-derivation-and-reproducibility.md) — seeds
  are hashes of a readable derivation path; identity is content-addressed; paired
  comparisons force common random numbers by _removing_ the differing term from
  the path.
- [ADR 0011](architecture/0011-telemetry-and-provenance.md) — telemetry is
  collected from the event stream during the match and attributed through causal
  source IDs; dead-hand has four distinct causes; raw records are the product.
- [ADR 0012](architecture/0012-experiment-storage-and-checkpointing.md) — one
  directory per experiment, JSONL streaming, resume by content-addressed match
  ID, search checkpoints carrying the already-bred next population.

### Verification

`npm run verify` passes for the whole monorepo: **544 tests in 35 files**
(baseline before Phase 4 was 325 in 23), typecheck, ESLint, Prettier and the
production build all clean. Phase 1–3 tests are unmodified except for three
added regression tests (below).

New suites: `bot-interface/src/contract.test.ts` (23) and eleven simulator
suites totalling 193 — `hash`, `seed`, `schedule`, `deck-generation`,
`run-match`, `telemetry`, `run-batch`, `search`, `analysis`, `compare`,
`experiment`.

Benchmark (`npm run bench`, 120 matches over 6 generated decks):

| Workers | Matches/s | Actions/s | Peak heap | Wall clock |
| ------- | --------- | --------- | --------- | ---------- |
| 1       | 3.33      | 419       | 123 MB    | 36.0 s     |
| 2       | 4.30      | 541       | 51 MB     | 27.9 s     |
| 4       | 8.16      | 1028      | 51 MB     | 14.7 s     |

2.45× at four workers; results identical across all three worker counts, which
the benchmark asserts rather than reports.

### An engine bug Phase 4 found

The new pilots play far more matches than the Phase 3 suites did, and they
deadlocked the free-for-all: when the **active** seat was eliminated during its
own turn — an empty-deck draw, a concession, a timeout, or an effect that killed
its controller — `advance()` stalled on a turn nobody was left to take. Fixed in
`flow.ts` by handing the turn to the next living seat, with `handleTermination`
now advancing after its state-based checks. Three regression tests were added to
`free-for-all.test.ts`. This only ever fired at three or four seats; a 1v1 is
already over by that point.

### Deliberate limitations, stated in every report

- Heuristic pilots are not good players. A result describes what these bots did
  with these decks under these rules, and nothing more.
- No machine learning. Transparent heuristics and evolutionary deck search only,
  per CLAUDE.md §13.1 — the telemetry is deliberately raw enough to support
  learning later.
- Experiments run 1v1. `playerCount` is carried through every schedule, record
  and bot contract, and the runner already seats four, so 3–4-player analysis is
  a configuration change rather than a redesign.
- The analyser recommends investigation. It never edits card data, never picks a
  "best" patch, and its flags are `review_recommended`, `possible_interaction`,
  `insufficient_data` or `run_quality` — never "overpowered" or "balanced".
- Card-pair analysis reports pairs only. Triples explode combinatorially and
  cannot clear a support threshold worth having at these sample sizes, so they
  are not attempted rather than reported badly.

### Things worth knowing before extending it

- **The bundled prototype set is not a balanced format.** `trench_guard` (1/5
  guardian + armored) is close to unbreakable in a small pool, and matches in a
  12-card test format are decided by decking out rather than by combat. Both
  distorted early test fixtures before being understood.
- **Statline buffs are pilot-fragile; cost reductions are not.** A bigger body at
  the same price makes the value pilot _less_ willing to trade it, so a stat buff
  can move a win rate in either direction. Fixtures that need a reliably strong
  card change the cost.
- Any module reachable from a worker thread must use erasable-only TypeScript
  syntax — no parameter properties, no enums — because workers load TS through a
  resolve hook rather than a build step.

---

## Phase 5 — Real-player data — not started, contingent

Only meaningful with a real player base. Nothing to build or decide yet beyond
not painting ourselves into a corner: match logs are structured, redacted and
replayable, and every accepted action is recorded in `MatchState.actionLog`
alongside the seed, so a match can be re-derived exactly.

---

## Keeping this file honest

Update it when a milestone's status changes — not at the end of a phase. If a
row above claims something is done without a test or a document to point at, it
is not done.
