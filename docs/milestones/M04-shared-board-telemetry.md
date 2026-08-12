# M04 — Shared unlimited-board telemetry

## Objective

Make the evidence used to judge unlimited Unit boards identical in spectator and
simulator paths. Do not restore a Unit cap based on impression alone.

## M04.1 — Extract one shared collector — done (2026-08-12)

Move/refactor the board metrics currently in
`packages/spectator/src/telemetry.ts` behind a shared event-stream collector used
by spectator matches and simulator experiments.

Required raw metrics:

- [x] Unit count per player at each round boundary — `unitsByRound`;
- [x] peak Units, non-Token Units, Tokens, visual stack size, and Tokens by
      definition — `peakUnits`, `peakNonTokenUnits`, `peakTokens`,
      `peakTokenStack`, `peakTokensByDefinition`;
- [x] longest turn and combat resolution — `longestTurn` (accepted actions) and
      `longestCombatResolution` (engine events from the attack declaration to the
      phase leaving combat);
- [x] attackers/blockers in the largest combat — `largestCombat`;
- [x] triggers and choices in the busiest turn — `busiestTurn`;
- [x] peak-board reduction and loss reasons after the peak — per seat as
      `unitsLostAfterPeak` / `lossReasonsAfterPeak`, summarised for the widest
      seat as `largestBoardAnswer`.

Keep one definition and one schema. Existing replays/manifests need an explicit
version policy.

### What was built

`packages/board-telemetry` (`@tcg/board-telemetry`) is the one definition.
`BoardTelemetryCollector` is driven by the event stream plus the turn each
accepted action was taken on, and by nothing else — no board inspection, no wall
clock, no knowledge of whether anybody is watching. `collectBoardTelemetry` is
the same collector over a finished log.

Both paths use it, and they use it differently on purpose:

- the **simulator** feeds it live from `runMatch`, including the match-creation
  events, because a large batch must not retain every match's log to answer a
  question about board size (`CLAUDE.md` §13.14). The result lands on every
  `MatchRecord` as `board`;
- the **spectator** feeds it the finished log in `collectTelemetry`, which is now
  a thin layer that adds the two things true only of a watched match: the
  leaderboard (`placement`, ranked from the shared `eliminatedAtSequence`) and
  the provenance flag.

`SpectatorTelemetry` **extends** the shared schema rather than restating it, so
there is no second definition of `peakUnits` to drift.

### Version policy

- **Spectator replays: 2 → 3, refused, not migrated.** A v2 replay's telemetry
  block predates whole measures, and re-deriving them from the log it carries
  would present numbers under the identity of a build that never asserted them.
  `replayFormatVersion` reads the version out before parsing so the refusal says
  "format version 2, this build records 3" instead of "not a spectator replay".
- **Simulator records: 3 → 4, refused, not migrated,** for the same reason: the
  observations were never made. `matches.header.json`'s existing drift check
  refuses to resume a v3 stream under v4 meanings.
- **Manifests stay at schema 4.** They record `telemetrySchemaVersion` by
  reference, so a manifest already states which record version is inside it
  without restating the shape.

### Deliberately not done

- **No stall verdict moved into the shared schema.** It carries
  `attackersByRound` and `longestStallRounds` — a series and a streak — and no
  flag. `boardStalled` stays a spectator-side presentation threshold until M04.2
  replaces it with attack-opportunity evidence and Q43 settles what it means.
  (M04.2 has since removed it.)
- **No board metrics in reports yet.** That is M04.3, and reporting numbers
  before the stall definition exists would print a column that has to be
  re-cut.
- **No summary-screen change.** It reads the same field names it always did. The
  only UI change anywhere is the replay-loading refusal message, which had to
  learn the difference between "not a replay" and "a replay from version 2".

### Evidence

- `packages/board-telemetry/src/collector.test.ts` — hand-written event streams
  where each definition's answer can be read off the fixture by hand: round
  boundaries, Token/non-Token/stack separation, a peak that forgets an earlier
  smaller peak, a bounce counted as a board reduction, the largest combat and the
  most expensive combat being different combats, and streamed-vs-replayed
  equality.
- `apps/simulator/src/board-telemetry.test.ts` — a real match: the record's
  `board` block is schema-valid and non-empty, it is byte-identical
  (`JSON.stringify`) to the same collector run over the finished log, and the
  same seed reproduces it.
- `packages/spectator/src/spectator.test.ts` — an earlier-version replay is
  refused and identified as one.
- `npm run verify`.

## M04.2 — Record attack opportunity, not silence — done (2026-08-12)

The baseline labels any three rounds without attackers as a stall. Replace that
with raw evidence that distinguishes:

- [x] at least one player had a legal, Ready attacker and chose not to attack —
      `seatsDeclining` per round, `attackStepsDeclined` per seat;
- [x] nobody could attack — `seatsWithoutUnits` / `seatsAllExhausted` /
      `seatsWithoutDefender`, and `attackStepsUnable` per seat;
- [x] combat was prevented or altered by a rule/effect — `seatsNewlyDeployed`
      for the rule, `readyPreventions` for the effect;
- [x] the match was simply in early development — `seatsWithoutUnits`, read
      against the round index and the existing `unitsByRound`.

Do not emit a final `boardStalled: true/false` policy yet. Store the raw streaks
and use `null`/`undetermined` for the derived classification until Q43 is answered.

- [x] `longestDeclinedStreak` and `longestUnableStreak` are stored raw;
- [x] `attackOpportunity.classification` is the literal `'undetermined'`, and
      `boardStalled` is gone from every schema and surface.

### What was built

**The engine records the census; nothing derives it.** A new event,
`attack_opportunity`, is emitted at every attack declaration, immediately before
`attackers_declared`, carrying the declaring seat's board as it decided against
it: Units controlled, how many were Ready, how many the engine would have
accepted as attackers, how many were Exhausted, how many Ready Units `Newly
Deployed` held back, living opponents available, and attackers actually declared.

Three things about it are load-bearing:

- It is taken **before declared attackers Exhaust**. A census a moment later
  reports no Ready Unit at all, so the turn a seat attacked with everything would
  read as the turn nobody could attack.
- It comes from `attackCensus` in `derive.ts`, which is also where
  `legal-actions.ts` now gets `legalAttackers`. The telemetry and the legality the
  engine enforces are **one function**, so the evidence cannot describe a game the
  engine is not playing. The counts partition the board exactly —
  `legalAttackers + exhaustedUnits + newlyDeployedUnits === units` — and that is
  asserted rather than assumed, because a future attack restriction landing in one
  branch only would silently unbalance it.
- It is an **observation and not a rule**. No trigger keys off it, nothing
  branches on it, and it is emitted even for a full attack so the series has no
  gaps. Every count is a tally of Units on a public battlefield, so `redactEvent`
  has no work to do and no observation boundary moves.

**The collector files each census under exactly one reason.** Per round:
`seatsAsked`, and then `seatsAble` / `seatsWithoutUnits` / `seatsAllExhausted` /
`seatsNewlyDeployed` / `seatsWithoutDefender`, which sum to `seatsAsked`, plus
`seatsDeclining` as a subset of `seatsAble` and `readyPreventions`. The reasons
overlap on a real board — a seat with one Exhausted Unit and one that just arrived
has two — so the order is fixed and documented: no living defender outranks
everything (it is not about this seat's board), then the rule that held a Ready
Unit back, then exhaustion. Per seat the same steps are counted again, because the
round series cannot say _who_ declined, and one seat sandbagging behind a wide
board is the opposite finding from three seats with nothing to attack with.

`readyPreventions` is counted from `ready_prevented` and **buffered** to the round
it affects: a Ready Step runs before the `turn_started` that names its turn, so
filing it immediately would blame the round that had just ended.

**Two streaks, both raw.** `longestDeclinedStreak` is the longest run of quiet
rounds in which at least one asked seat could have attacked;
`longestUnableStreak` is the longest run in which none could. A quiet round nobody
was asked in belongs to neither and breaks both, because there is no decision to
attribute — so `longestStallRounds` is **not** their sum, and is kept beside them
because it is the number every earlier measurement was expressed in.

**`boardStalled` is gone rather than retuned.** It was the only derived verdict in
either document, a spectator-side threshold over silence, and the traces below
show it counted the wrong thing. The spectator now adds exactly two things to the
shared schema — the placement leaderboard and the provenance flag — and reads the
same `'undetermined'` classification a batch does. The summary screen and the
`spectate` CLI report attack steps, the two streaks and `stall verdict:
undetermined (pending Q43)`.

### Version policy

Three refusals, no migrations, on the same terms as M04.1: the observations were
never made, and re-deriving them would mean re-simulating the match, which is a
different match.

- **Board telemetry: 1 → 2.** Carried inside the document, because the block is
  routinely lifted out of its replay and aggregated elsewhere.
- **Spectator replays: 3 → 4.** A v3 match was played by an engine that emitted no
  `attack_opportunity`, so its log cannot answer what any seat could have attacked
  with. It also carries a `boardStalled` claim that no longer exists, so reading
  one under v4 would silently drop a claim as well as invent counts.
- **Simulator records: 4 → 5.** Same reason; the `matches.header.json` drift check
  keeps a v4 stream from being resumed under v5 meanings. **Manifests stay at
  schema 4** — they record `telemetrySchemaVersion` by reference.

Nothing in the repository is a stored replay or match record, so all three
refusals have nothing to refuse yet.

### Deliberately not done

- **No stall verdict, and no threshold anywhere.** `classification` is a
  `z.literal('undetermined')` rather than a nullable string, so a consumer cannot
  read a verdict out of it by accident and a build that starts writing one has to
  change the schema version to do it.
- **No board metrics in reports.** Still M04.3.
- **No configurable eligibility rule.** Adding a configurable threshold before
  Q43 chooses the series it applies to would ship the same mistake with a knob
  on it.

### Evidence

- `packages/rules-engine/src/attack-opportunity.test.ts` — the census equals the
  legality the engine offers the seat, partitions every Unit into exactly one
  reason (Rush is not a fourth category), describes the pre-declaration board when
  a seat attacks with everything, is recorded for an empty board too, counts
  living opponents on a four-seat table, and sits immediately before
  `attackers_declared` while queuing no trigger.
- `packages/board-telemetry/src/collector.test.ts` — hand-written streams whose
  answers can be read off the fixture: a quiet round somebody could have attacked
  in, a quiet round nobody could, an empty board and a fresh board told apart, a
  seat with no living defender not counted as able, a buffered Ready-Step
  prevention landing on the correct round, every round summing to `seatsAsked` in
  both fixtures, and streamed-vs-replayed equality on the fixture that exercises
  the buffer.
- `apps/simulator/src/board-telemetry.test.ts` — a real match: every attack step
  accounted for under one reason, per-round and per-seat views agreeing, and the
  classification still `'undetermined'` in a batch record.
- `apps/web-client/src/spectator-flow.test.tsx` — the summary screen shows attack
  opportunity and `Stall verdict: undetermined`, and no longer says "Board stall".
- `npm run verify`.

## Decision checkpoint — Q43

Ask the owner to choose the eligibility rule and threshold after real raw traces
exist. Present examples from representative matches rather than an abstract
question. Then version the chosen derived metric in M04.3.

**Ready to ask.** Two four-seat precon matches are traced in
`docs/open-questions.md` Q43 under "Raw traces now exist", with the four concrete
choices the answer has to make. The headline finding: the baseline's
`longestStallRounds: 2` on one of them is round 1 (nobody could attack — two empty
boards and two freshly-deployed ones) plus round 2 (two seats could and declined)
added together, which are opposite findings. Both matches then escalate to 53 and
64 attackers in their final rounds, so the metric also has to be able to say
"no".

## M04.3 — Reports and reconciliation

After Q43:

- implement the configured stall definition;
- surface board metrics in batch and matchup reports;
- reconcile shared collector results against spectator results for the same seed;
- preserve raw event evidence as primary;
- test multiplayer, token-heavy, no-legal-attacker, and anti-wide scenarios.

## Acceptance

- The same deterministic match produces identical board telemetry in spectator
  and simulator paths.
- Reports can answer whether unlimited boards create clutter, long turns,
  trigger overload, or meaningful stalls.
- A stall is never inferred merely from "no attackers this round."

## Exclusions

- Reintroducing a Unit cap.
- Balance conclusions or card nerfs.
- UI Token grouping.
