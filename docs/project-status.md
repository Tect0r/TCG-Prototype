# Project status — phases and milestones

Where the project actually is, phase by phase. This file is the single place to
check before starting work: it records what is done, what is deliberately not
started, and what "done" means for each remaining phase.

**Last updated:** 2026-08-09

| Phase | Scope                          | Status                    |
| ----- | ------------------------------ | ------------------------- |
| 1     | Deck builder                   | **Complete**              |
| 2A    | Deterministic rules engine     | **Complete**              |
| 2B    | Online 1v1                     | **Complete**              |
| 3     | 2–4 player free-for-all        | **Complete**              |
| 4     | Headless simulator and balance | **Hardening in progress** |
| 5     | Pseudonymous real-player data  | Not started, contingent   |

Phase 4's machinery is built and runs; its analytical contracts are being
audited and corrected against [PHASE4_HARDENING.md](../PHASE4_HARDENING.md). It
is deliberately **not** marked complete until that document's definition of done
holds — a laboratory that runs is not the same as one whose numbers mean what
they say.

**Verification for the whole monorepo:** `npm run verify` (typecheck → lint →
test → build). Last run: **610 tests in 37 files, all passing**; typecheck,
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

## Phase 4 — Simulator and balance laboratory — hardening in progress

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

Five experiment kinds run end to end: `batch`, `replacement`, `search`,
`comparison` and `robustness`.

**Status.** The machinery is built and passes its suite. The analytical
_contracts_ are being audited against
[PHASE4_HARDENING.md](../PHASE4_HARDENING.md), because a laboratory that runs is
not the same as a laboratory whose numbers mean what they say. The corrections
delivered so far are listed below; the phase is not marked complete until every
item in that document's definition of done holds.

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
- [ADR 0013](architecture/0013-statistical-contracts.md) — paired designs are
  analysed as paired; synergy is a four-cell difference-in-differences with a
  bootstrap that propagates every cell; multiplicity is reported and never used
  to suppress; metric names state their bounds.
- [ADR 0014](architecture/0014-unified-match-stream-and-reference-populations.md)
  — every experiment kind streams to one `matches.jsonl` with identity
  `arm + matchId`; a comparison's reference population is resolved once,
  content-hashed and replayed unchanged in both environments.

### Hardening — what has been corrected

Each item below is a defect in what the laboratory _claimed_ to measure, not a
crash. Each has regression tests; the section numbers are
[PHASE4_HARDENING.md](../PHASE4_HARDENING.md).

| §    | Defect                                                                                                                                            | Correction                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4    | The flagship comparison claimed Scorch 2 → 3 damage while the baseline already dealt 3, and silently dropped its targeting filter.                | The candidate now deals 4, keeps every other field identical, and a `declaredChanges` block is checked against both resolved pools **before any match runs**. Identical or undeclared differences are rejected.                                |
| 5    | `broad_cross_cluster_inclusion` was raised from the share of individual _decks_ running a card.                                                   | `analysis/inclusion.ts` measures coverage of eligible strategic clusters. Tiny and rarely-observed clusters leave the denominator. Deck share survives as `deckInclusionShare`.                                                                |
| 6    | Baseline and candidate each generated their _own_ reference population, so deck-level deltas mixed the rules change with two different decklists. | `reference-population.ts` resolves once against the baseline, content-hashes the set, validates against both pools, keeps only decks legal in both, and refuses the comparison if the arms' hashes diverge.                                    |
| 7    | Batches streamed to `matches.jsonl`; searches and comparisons accumulated in memory and wrote a final array.                                      | `reporting/match-store.ts` is the one raw store. All five kinds stream to it, dedupe by `arm + matchId`, resume behind a drift-checked header, and truncate a damaged tail exactly once.                                                       |
| 8.1  | `timesPlayed / timesDrawn` was named `playRatePerDrawn` and printed as a percentage, so "112%" was reachable.                                     | `playsPerDraw` (unbounded, printed as a multiplier) plus bounded `drawnCopyPlayConversion` and `gamesDrawnAndPlayedShare`, backed by new per-copy counters.                                                                                    |
| 8.2  | Dead-hand collapsed strategic non-use into mechanical unusability.                                                                                | Seven categories, split into mechanical and strategic groups, with board capacity and missing targets attributed separately.                                                                                                                   |
| 9.1  | Paired experiments were analysed with independent-sample intervals.                                                                               | `analysis/paired.ts`: paired binary and paired continuous estimators, discordant counts, exclusions with reasons, stratified bootstrap intervals.                                                                                              |
| 9.2  | Synergy uncertainty came from the "both" cell alone.                                                                                              | A 2×2 difference-in-differences with a stratified bootstrap over all four cells. Any sparse cell returns insufficient evidence rather than a number.                                                                                           |
| 9.3  | Long flag lists carried no sense of scan width.                                                                                                   | `describeMultiplicity` reports hypotheses examined and expected false positives; Benjamini–Hochberg is available and never hides unadjusted values.                                                                                            |
| 10.1 | `opponent_field_sensitivity` was a public reason code nothing could raise.                                                                        | `analysis/sensitivity.ts` implements it, guarded by per-field minimums and non-overlapping intervals, and describes context sensitivity rather than a defect.                                                                                  |
| 10.2 | Card-level counter availability was inferred from cluster matchup counts.                                                                         | `analysis/counters.ts` requires controlled replacement evidence against a declared target, and reports `unavailable` — not zero — when it has none.                                                                                            |
| 10.3 | Pilot robustness needed hand-edited weights.                                                                                                      | Versioned perturbation profiles (`bot-interface/src/perturbation.ts`) and a `robustness` experiment kind that runs each profile on common seeds and never pools them.                                                                          |
| 11   | Displacement was warned from raw archive counts such as `6 → 3`.                                                                                  | `analysis/displacement.ts` compares normalized shares across independent replicates, requires the drop to exceed between-replicate variation, and separates pool illegality from selection.                                                    |
| 12   | Reports lacked the provenance to audit them.                                                                                                      | `report.md` now leads with limitations, then a provenance table with configuration hash, card-pool hashes, reference-population hash, schema/seed versions, pilot versions, thresholds, and completed/failed/abnormal/excluded/resumed counts. |

### Schema versions changed

| Schema                        | From | To  | Compatibility                                                                                                                                                                             |
| ----------------------------- | ---- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEMETRY_SCHEMA_VERSION`    | 1    | 2   | No migration. v1 records never observed the per-copy counters or the new dead-hand categories, so a v1 file is rejected with a clear message rather than reinterpreted under v2 meanings. |
| Report / summary / manifest   | 1    | 2   | Renamed metrics and new provenance fields; old readers should not reinterpret them.                                                                                                       |
| `MATCH_STREAM_HEADER_VERSION` | —    | 1   | New sidecar. A stream without one cannot be resumed.                                                                                                                                      |
| `ANALYSIS_STATS_VERSION`      | —    | 1   | Pins the resampling procedure, so published intervals reproduce exactly.                                                                                                                  |

### Verification

`npm run verify` passes for the whole monorepo: **610 tests in 37 files**
(544 in 35 before hardening; 325 in 23 before Phase 4), typecheck, ESLint,
Prettier and the production build all clean. Phase 1–3 tests are unmodified
except for the three regression tests noted below.

New hardening suites: `hardening-analysis.test.ts` (33) and
`hardening-experiment.test.ts` (25).

Smoke experiments run end to end against the bundled set, not only fixtures:
batch across all four pilots (720 matches), the corrected comparison (864),
controlled replacement (144), evolutionary search with two replicates (1340),
pilot-perturbation robustness across five profiles (600), an interrupted batch
resumed from a truncated tail, and the same experiment at one and two workers.
The resumed run's records and summary were byte-identical to the uninterrupted
run's, with 7 records resumed and 1 damaged line recovered; the one- and
two-worker runs were identical.

Benchmark (`npm run bench`, 120 matches over 6 generated decks):

| Workers | Matches/s | Actions/s | Peak heap | Wall clock |
| ------- | --------- | --------- | --------- | ---------- |
| 1       | 3.52      | 443       | 110 MB    | 34.1 s     |
| 2       | 4.36      | 549       | 54 MB     | 27.5 s     |
| 4       | 7.95      | 1001      | 52 MB     | 15.1 s     |

2.26× at four workers; results identical across all three worker counts, which
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

### Analytical limitations that remain after hardening

- **Sample sizes are small.** At the scale these experiments run, most card
  pairs have an empty cell somewhere in the four-cell contrast and correctly
  come back as `insufficient_evidence`. That is the honest answer, not a bug,
  but it means the synergy view says little until runs get much larger.
- **Card-level counter breadth needs a declared target.** Without
  `counterTargetDeckIds` and a replacement experiment behind it, the analyser
  reports `unavailable`. Cluster matchup breadth is always available and is
  never presented as a card-level answer.
- **Displacement needs replicates.** With one search replicate the analyser
  reports `insufficient_evidence` for every card, by design. Meaningful
  displacement evidence costs several full searches per environment.
- **Opponent-field sensitivity is 1v1 only.** In a free-for-all the field a card
  faced is a mixture, and attributing the result to whichever opponent sorted
  first would be worse than saying nothing, so multi-opponent matches are
  skipped in that view.
- **Pilot robustness measures the profiles it ships with.** A conclusion labelled
  `stable` survived a specific, versioned set of bounded re-weightings — not
  every reasonable pilot, and certainly not a human.
- **`drawnCopyPlayConversion` can be `unavailable`.** It is `null` for records
  written before per-copy tracking existed, rather than a fabricated value.
- **Insertion controls are not built.** `includeInsertion` records a note when a
  base deck does not run the subject card; it does not yet construct the
  insertion variant CLAUDE.md §13.10 describes for build-around cards.

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
