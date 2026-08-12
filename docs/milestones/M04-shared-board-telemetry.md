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
  re-cut. (M04.3 has since added them.)
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
- **No board metrics in reports.** Still M04.3. (Added there.)
- **No configurable eligibility rule.** Adding a configurable threshold before
  Q43 chooses the series it applies to would ship the same mistake with a knob
  on it. (M04.3 added the knob _after_ Q43 chose the series, which is the order
  that makes it meaningful.)

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

## Decision checkpoint — Q43 — answered (2026-08-12)

Ask the owner to choose the eligibility rule and threshold after real raw traces
exist. Present examples from representative matches rather than an abstract
question. Then version the chosen derived metric in M04.3.

**Asked and answered.** Two four-seat precon matches are traced in
`docs/open-questions.md` Q43, with the four concrete choices the answer had to
make. The headline finding: the baseline's `longestStallRounds: 2` on one of them
is round 1 (nobody could attack — two empty boards and two freshly-deployed ones)
plus round 2 (two seats could and declined) added together, which are opposite
findings. Both matches then escalate to 53 and 64 attackers in their final rounds,
so the metric also has to be able to say "no".

The owner chose the **strict** reading: every living seat asked, every one able,
none attacking; **three** consecutive such rounds; no round-1 special case; any
declared attacker breaks the streak.

## M04.3 — Reports and reconciliation — done (2026-08-12)

After Q43:

- [x] implement the configured stall definition — `@tcg/board-telemetry/stall`,
      applied by the shared collector and recorded with every verdict;
- [x] surface board metrics in batch and matchup reports — a new
      "Unlimited board" report section, a per-cell board grid in the matrix
      section, seven new matrix CSV columns, and `summary.json` schema 3;
- [x] reconcile shared collector results against spectator results for the same
      seed — `reconcileBoardTelemetry`, asserted on a real match in
      `apps/simulator/src/board-telemetry.test.ts`;
- [x] preserve raw event evidence as primary — the streak the verdict is cut from
      and the per-round `stallEligible` flag are both stored, and the report
      re-derives its board section from `matches.jsonl` alone under test;
- [x] test multiplayer, token-heavy, no-legal-attacker, and anti-wide scenarios.

### What was built

**The rule is data, not presentation.** Q43's own framing was the constraint: the
answer had to be "one explicit, configurable, versioned number rather than a
judgement made in the reporting layer". So `stall.ts` owns it —
`roundIsStallEligible` decides a round, `classifyStall` applies the threshold, and
`DEFAULT_STALL_DEFINITION` is the shipped rule. The collector applies it in
`finish`, and every document carries the definition it was judged by as
`attackOpportunity.stallDefinition`. A verdict never travels without its rule, so
a batch run at a different threshold cannot be mistaken for one run at the shipped
one — and `aggregateBoard` refuses to count verdicts at all when a batch mixes
definitions, rather than summing answers to different questions.

**One new observation makes the strict rule possible.** `livingSeats` per round —
seats not yet eliminated when the round began. `seatsAsked` alone cannot judge
unanimity: three seats asked is the whole table after an elimination and a missing
seat before one. It is taken at the _start_ of the round, so a seat eliminated
after taking its turn still counts as one the round asked; taking survivors
instead would refuse a round that was in fact unanimous.

**Each clause can be seen refusing.** A round that fails any clause breaks the
streak rather than being skipped, because "three consecutive rounds" is a claim
about an uninterrupted run. The fixtures show all of it: three unanimous rounds
classified `stalled`; the same fixture with one Token attacking in round 3
classified `not_stalled`; a four-round quiet stretch broken in the middle by one
seat that could not attack, where the permissive streak reads 4 and the strict one
reads 2; and three rounds in which nobody could attack at all — the exact input
the baseline called a stall — classified `not_stalled`.

**Reconciliation is a function, not an assertion.** `reconcileBoardTelemetry`
returns the list of field paths on which two documents disagree.
`expect(a).toEqual(b)` over a forty-measure document makes a failure pass or fail
without making it legible. The simulator suite now runs the _spectator's own_
`collectTelemetry` over a simulator match and requires the two board blocks to
reconcile with an empty difference list once the two things a watched match adds —
the leaderboard and the provenance flag — are removed. That the removal list is
exactly two items is the M04.1 property being re-checked.

**The board section's population is deliberately not the report's usual one.** It
aggregates over _every_ record, abnormal ones included, and says so in its own
first paragraph. A match that hit the turn limit is the strongest stall candidate
in a batch and usually holds its widest board; excluding it would bias the single
question the section exists to answer. Every other section keeps its existing
sample.

### Version policy

Three refusals, no migrations, on the same terms as M04.1 and M04.2.

- **Board telemetry: 2 → 3.** A v2 document holds `classification:
'undetermined'`, no `stallDefinition` and no `livingSeats`. The last of those is
  what makes it unmigratable rather than merely incomplete: without it, the seats a
  round _should_ have asked are unknown for any match that lost a player, so the
  rule cannot be applied retroactively without guessing.
- **Spectator replays: 4 → 5.** Same reason, one layer out.
- **Simulator records: 5 → 6.** Same reason; the `matches.header.json` drift check
  keeps a v5 stream from being resumed under v6 meanings.
- **Report schema: 3 → 4** and **`summary.json`: 2 → 3** — additive sections, but
  a reader keying off the version should see that the board numbers are new.
- **Matchup matrix: 1 → 2** — every game gains a compact `board` block.
- **Manifests stay at schema 4.** They record `telemetrySchemaVersion` and
  `matchupMatrix.schemaVersion` by reference.

Nothing in the repository is a stored replay, match record or matrix artifact —
`experiments/` holds configurations only — so all of these have nothing to refuse
yet.

### Deliberately not done

- **No stall flag in `analysis/flags.ts`.** A stalled match is an observation
  about the ruleset, not a review signal about a card, and routing it into the
  flag list would put it through multiplicity correction alongside card win rates
  it has nothing to do with.
- **No per-deck stall attribution.** The matrix shows stalls per cell, which is as
  far as the evidence goes: a stall is a property of a table, and splitting it
  between two decks would be an inference the data does not support.
- **No re-tuning of `thresholdRounds` from the traced matches.** Three is the
  owner's number. Two matches are not grounds to move it, and the raw streak is
  stored precisely so it can be moved later without re-simulating.

### Evidence

- `packages/board-telemetry/src/collector.test.ts` — the stall rule's positive
  case, each clause refusing, the living-seat count tracking an elimination and
  being taken at the start of the round, a configured threshold changing the
  verdict but not the streak, a no-legal-attacker table, a 40-Token board, a wide
  board answered by a sweeper, streamed-vs-replayed equality on the verdict, and
  `reconcileBoardTelemetry` naming the fields that moved.
- `apps/simulator/src/board-telemetry.test.ts` — a real match: the verdict in a
  batch record, per-round `stallEligible` agreeing with the counts behind it, and
  the spectator path reconciling field for field on the same seed.
- `apps/simulator/src/experiment.test.ts` — the batch board block re-derived from
  `matches.jsonl` alone and equal to what was written, and the report's printed
  stall verdict matching the records it came from.
- `apps/web-client/src/spectator-flow.test.tsx` — the summary screen shows a real
  verdict with its threshold, and says neither "Board stall" nor "undetermined".
- `npm run verify`.

## Acceptance — met (2026-08-12)

- [x] The same deterministic match produces identical board telemetry in
      spectator and simulator paths — reconciled field for field, on a real
      match, in `apps/simulator/src/board-telemetry.test.ts`.
- [x] Reports can answer whether unlimited boards create clutter, long turns,
      trigger overload, or meaningful stalls — the "Unlimited board" section
      answers each with a distribution, and the matrix answers them per cell.
- [x] A stall is never inferred merely from "no attackers this round." The rule
      requires every living seat to have been able to attack; a fixture of three
      rounds in which nobody could — the baseline's exact false positive —
      classifies `not_stalled`.

M04 is complete.

## Exclusions

- Reintroducing a Unit cap.
- Balance conclusions or card nerfs.
- UI Token grouping.
