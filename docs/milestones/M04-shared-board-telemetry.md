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

## M04.2 — Record attack opportunity, not silence

The baseline labels any three rounds without attackers as a stall. Replace that
with raw evidence that distinguishes:

- at least one player had a legal, Ready attacker and chose not to attack;
- nobody could attack;
- combat was prevented or altered by a rule/effect;
- the match was simply in early development.

Do not emit a final `boardStalled: true/false` policy yet. Store the raw streaks
and use `null`/`undetermined` for the derived classification until Q43 is answered.

## Decision checkpoint — Q43

Ask the owner to choose the eligibility rule and threshold after real raw traces
exist. Present examples from representative matches rather than an abstract
question. Then version the chosen derived metric in M04.3.

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
