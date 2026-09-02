# Current work

M08.16A is implemented: the strict adaptive config surface, policy enums and
bounds, raw/checkpoint/result envelopes, and readable current/future-version
refusal, in `apps/simulator/src/adaptive/{version,config,envelopes}.ts`, wired
into the simulator's barrel export.

M08.16B is implemented: immutable, content-addressed deck revision lineage —
revision identity, parent, exact swaps, generation/block/opponent references,
construction kind (`root`/`swap`/`rebuild`) and a deterministic seed-path
helper — in `apps/simulator/src/adaptive/revision.ts`, wired into the
simulator's barrel export. `assertAdaptiveLineage` proves a straight-chain
lineage's generation ordering and enforces Commander-locked versus open policy.
28 focused tests in `apps/simulator/src/adaptive/revision.test.ts` pass and
`apps/simulator` typechecks clean. Tranche-close gates (`check:consistency`,
`audit:check`, `verify`) and `tcg-reviewer` are deferred to M08.16D, per this
milestone's work-slice split.

M08.16C is implemented: deterministic legal candidate generation in
`apps/simulator/src/adaptive/generate.ts` (`generateAdaptiveCandidates()`).
Swap candidates reuse `mutateDeck()` and are accepted only within the
configured swap bound; rebuild candidates reuse `generateDeck()` and are
rejected if illegal or identical to the incumbent. Every rejection is recorded
with its reason; nothing here evaluates, promotes or retains a revision — that
stays M08.17. The raw envelope (`apps/simulator/src/adaptive/envelopes.ts`)
additively widened to `ADAPTIVE_RAW_SCHEMA_VERSION` 2 to carry a `generations`
array; a schemaVersion 1 raw record is now refused as an older build. Wired
into the simulator's barrel export. 6 focused tests in
`apps/simulator/src/adaptive/generate.test.ts` plus updated
`envelopes.test.ts` raw-envelope coverage pass, `apps/simulator` typechecks
clean, and the full `apps/simulator` suite (579 tests) passes. Tranche-close
gates (`check:consistency`, `audit:check`, `verify`) and `tcg-reviewer` are
deferred to M08.16D, per this milestone's work-slice split.

M08.16D is done pending review: revalidated the combined M08.16 tranche diff
(`config.ts`, `version.ts`, `envelopes.ts`, `revision.ts`, `generate.ts` and
their tests, plus the `apps/simulator` barrel export) against this milestone's
acceptance list — schema refusal, deterministic candidate generation,
legality, Commander lock/open, bounded swaps and rebuild, rejected-candidate,
lineage and observation-policy coverage all present. `npm run format:check`
flagged 8 adaptive files as unformatted (a real gate failure, not
pre-existing); ran `prettier --write` on exactly those 8 files, no behavior
change. `npm run check:consistency`, `npm run audit:check` and `npm run
verify` all pass clean (212 test files, 4425 tests, typecheck, lint, format,
build). Marked M08.16D and the M08.16 checklist complete in the milestone
file. Root status row's "Next tranche" column left at `M08.16D` rather than
advanced to `M08.17A`, per CLAUDE.md: the tranche is not marked complete and
its successor is not named until `tcg-reviewer` returns `VERDICT: APPROVE`.

`tcg-reviewer` returned **`VERDICT: APPROVE`** over the M08.16 commit range
(`d20c66b..HEAD`) plus the close-record diff, with two non-blocking LOW
findings to keep in mind for the tranches that spend this lineage:

- `apps/simulator/src/adaptive/generate.ts`'s candidate generators pin the
  incumbent's Commander under every `commanderPolicy` (`open`/`selected`
  included), so a non-locked run's lineage is indistinguishable from a locked
  one today — undocumented, not a defect against M08.16's own acceptance list.
  Worth a header note (no code change) whenever M08.17 first lets a policy
  other than `locked` matter, or sooner if it causes confusion.
- `diffSwaps` in the same file (`removed.map((cardOut, i) => ... added[i])`)
  throws a raw Zod error instead of recording a rejection if `mutateDeck` ever
  handed back a deck of a different size than the incumbent — currently
  unreachable because `mutateDeck` guarantees equal size, but the file's own
  contract is "dropped and recorded in `rejected`, never silently repaired."
  Harden with a size-mismatch rejection branch the next time this file is
  touched.
- Also noted as residual risk, not defects: `describeAdaptiveVersionProblem`
  will refuse a schemaVersion-1 raw record even though the 1→2 widening was
  additive (moot until something persists a raw stream); `docs/status-audit.md`
  does not yet list the four `ADAPTIVE_*` versions (correct today — nothing
  writes those documents yet, must move once M08.18 does).

M08.16 tranche-close record committed and pushed. M08.16 is complete.

M08.17A is implemented: the mirrored evaluation block as the sole adaptation
decision unit, in `apps/simulator/src/adaptive/block.ts`, wired into the
simulator's barrel export. `decideAdaptiveBlock` reads only a completed
block's aggregate win tally (never a single game), returning a deterministic
`win`/`tie`/`no_decision` — a tie is equal decisive wins, `no_decision` is
zero decisive games (every scheduled game ended without a counted result).
`planAdaptiveBudget` computes how many whole blocks `totalLearningBudget`
affords and reports an explained shortfall when it does not divide evenly.
`scheduleAdaptiveBlock` builds one block's real `ScheduledMatch[]` (via the
existing `buildSchedule`) and refuses it outright — reporting a shortfall,
never a truncated partial block — when it needs more games than the caller's
`gamesRemaining`; the gate always measures the real built schedule rather
than trusting `adaptiveBlockGameCount`'s single-pilot formula, so extra pilot
specs cannot silently overspend the budget. No candidate evaluation, revision
attribution or promotion here — those stay M08.17B/M08.17C. 17 focused tests
in `apps/simulator/src/adaptive/block.test.ts` pass, the full
`apps/simulator/src/adaptive` suite (119 tests) passes, and `apps/simulator`
typechecks clean. Tranche-close gates (`check:consistency`, `audit:check`,
`verify`) and `tcg-reviewer` are deferred to M08.17D, per this milestone's
work-slice split.

M08.17B is implemented: candidate and reference-field evaluation, in
`apps/simulator/src/adaptive/evaluate.ts`, wired into the simulator's barrel
export. `adaptiveObjectiveOf` derives `meta_aware`/`pure_counter` from
`referenceFieldShare` rather than storing it — no `config.ts` or
`telemetry/schema.ts` change was needed, since M08.16's closed scope already
treats `referenceFieldShare` as a split of a block's existing game budget, not
a new deck-source field; the reference field's actual decks are supplied by
the caller. `scheduleAdaptiveCandidateScreening` schedules a candidate's own
games — always against the current opponent revision, and (only under
`meta_aware` with a non-empty field) against a deterministically selected
slice of the reference field, one game per selected deck — splitting the same
fixed per-orientation `blockSize` budget `./block.ts` uses rather than adding
to it; an empty reference field falls back to opponent-only scheduling.
`AdaptiveScreeningMatch` attributes every game to the candidate's
`revisionId` and a seed path extending the revision's own `seedPath`.
`tallyAdaptiveScreening` keeps `opponent`/`field` tallies structurally
separate, with `field` explicitly `null` (not zero) when no reference-field
games were scheduled. No match execution here — `runBatch` wiring stays for a
later, unnamed orchestrator; only scheduling and attribution are this slice's
job. 11 focused tests in `apps/simulator/src/adaptive/evaluate.test.ts` pass,
the full `apps/simulator/src/adaptive` suite (130 tests) passes, `eslint`
reports no issues on the changed files, and `apps/simulator` typechecks clean.
Tranche-close gates (`check:consistency`, `audit:check`, `verify`) and
`tcg-reviewer` are deferred to M08.17D, per this milestone's work-slice split.

M08.17C is implemented: candidate promotion, incumbent retention/rollback and
moving-opponent staleness refusal, in `apps/simulator/src/adaptive/promote.ts`,
wired into the simulator's barrel export. `decideAdaptivePromotion` selects and
promotes the highest-scoring candidate that decisively beat the opponent
(strictly more decisive wins than losses across the groups its objective
counts — the same "tie is not a win" rule `decideAdaptiveBlock` applies to a
whole block, restated for one candidate's screening), ranked on the Wilson
lower bound and tie-broken deterministically by `revisionId`; zero qualifying
candidates — including zero candidates at all — retains the incumbent with an
explained reason rather than an arbitrary promotion. Before any of that, every
candidate's recorded `opponentDeckHash` (M08.17B) is checked against the
opponent revision handed in now: if even one candidate was screened against a
different deck, the opponent has moved since, and the whole decision is
refused as `stale` — naming every affected `revisionId` for re-screening —
rather than promoting on evidence that no longer describes the opponent it
would be promoted over. `adaptivePromotionScore` reads only the opponent group
under `pure_counter` (and any `meta_aware` screening that fell back to
opponent-only play because its reference field was empty); a `meta_aware`
screening with field games combines both groups into one pool, matching how
`scheduleAdaptiveCandidateScreening` already spent one shared game budget
across them. `tallyAdaptiveSeries` sums a run's cumulative `./block.ts` block
decisions order-independently and never reads an `AdaptiveCandidateScreening`;
`decideAdaptivePromotion` never reads a series entry — the two evidence
streams stay on separate types so a promotion decision can never be justified
by cumulative series wins. 13 focused tests in
`apps/simulator/src/adaptive/promote.test.ts` pass, the full
`apps/simulator/src/adaptive` suite (143 tests) passes, `eslint` and
`prettier --check` report no issues on the changed files, and `apps/simulator`
typechecks clean. Tranche-close gates (`check:consistency`, `audit:check`,
`verify`) and `tcg-reviewer` are deferred to M08.17D, per this milestone's
work-slice split.

M08.17D is done pending review: revalidated the combined M08.17 tranche diff
(`block.ts`, `evaluate.ts`, `promote.ts` and their tests, plus the
`apps/simulator` barrel export) against this milestone's acceptance list —
block boundary, deterministic promotion/rollback/tie-breaking, moving-opponent
staleness, exact-budget shortfall reporting, and series-versus-screening
evidence separation all present. `npm run verify` first failed at
`format:check` on 2 unformatted files (`evaluate.ts`, `evaluate.test.ts`); ran
`prettier --write` on exactly those 2 files, no behavior change. `npm run
check:consistency`, `npm run audit:check` and `npm run verify` all pass clean
(215 test files, 4466 tests, typecheck, lint, format, content validation,
build). Marked M08.17D and the M08.17 checklist complete in the milestone
file. Root status row's "Next tranche" column left at `M08.17A` rather than
advanced to `M08.18A`, per CLAUDE.md: the tranche is not marked complete and
its successor is not named until `tcg-reviewer` returns `VERDICT: APPROVE`.

`tcg-reviewer` returned **`VERDICT: CHANGES REQUIRED`** over the M08.17 commit
range (`a1af30d..HEAD`) plus the close-record diff, with one HIGH blocking
finding: `decideAdaptivePromotion`'s moving-opponent staleness filter
(`apps/simulator/src/adaptive/promote.ts`) used
`opponentMatches.some((match) => match.opponentDeckHash !== ...)`, which is
`false` — not stale — for a candidate with **zero** `opponentMatches`. That
shape is schema-legal and reachable (`blockSize: 1` with `referenceFieldShare`
≥ 0.5, or `referenceFieldShare: 1`, spends the whole round's budget on the
reference field, per `./evaluate.ts`'s `fieldPerOrientation` split), so a
`meta_aware` candidate that was never screened against the current opponent
at all could be promoted purely on reference-field wins — exactly the
"promoted from evidence that no longer describes the opponent" failure this
guard exists to prevent.

Fixed: the staleness filter now also treats an empty `opponentMatches` as
stale (`evaluate.screening.opponentMatches.length === 0 || ...`), with the
`stale` decision's reason text updated to name both causes ("screened against
a different opponent revision, or scheduled zero opponent games this round").
Updated the file's top-of-file doc comment to state this explicitly. Added a
focused regression test in `promote.test.ts` (`blockSize: 1`,
`referenceFieldShare: 1`, one reference-field deck) asserting zero
`opponentMatches` are produced and the candidate is refused as `stale`. The
full `apps/simulator/src/adaptive` suite (144 tests, was 143) and
`apps/simulator` typecheck pass.

The review's three LOW findings and two residual-risk notes are non-blocking
and recorded here for the tranches that touch this code next, unfixed in this
close per CLAUDE.md's two-cycle/no-scope-widening rule:

- `block.ts`'s header comment overstates "never adapt from one isolated loss"
  as type-level when `blockSize: 1` + `mirrorSeats: false` makes one block one
  game; qualify the comment (or add a schema refinement) next time this file
  is touched.
- `selectReferenceField` (`evaluate.ts`) can silently return fewer decks than
  the field share asks for if its bounded rotation (`deduped.length * 4`
  draws) runs out before finding `wanted` distinct decks from a pool large
  enough to supply them; add a deterministic fallback scan next time this file
  is touched.
- `tallyGroup` (`evaluate.ts`) attributes every decisive game to the candidate
  when the candidate and opponent decks share a hash (e.g. a generation-0
  mirror); document the precondition or refuse same-hash screening next time
  this file is touched.
- Residual, not defects: `scheduleAdaptiveCandidateScreening`'s games are not
  gated against `totalLearningBudget` (only `scheduleAdaptiveBlock` checks
  `gamesRemaining`) — legitimately an orchestrator concern with no orchestrator
  slice yet; must close when M08.18 wires the loop or "budget honoured
  exactly" becomes untrue at run level. `adaptivePromotionScore` pools
  opponent and field games into one Wilson interval under `meta_aware`
  (deliberate, documented), an unvalidated balance assumption to revisit once
  real adaptive runs exist.

Re-ran `npm run check:consistency`, `npm run audit:check` and `npm run
verify` after the fix: all pass clean (215 test files, 4467 tests, typecheck,
lint, format, content validation, build).

`tcg-reviewer`'s bounded recheck confirmed the fix closes the vacuous-`some`
scenario without breaking the fresh-candidate path (4467 tests, +1) and
returned **`VERDICT: APPROVE`**.

M08.17 tranche-close record committed and pushed. M08.17 is complete.

M08.18A is implemented: the strict checkpoint contract, in
`apps/simulator/src/adaptive/checkpoint.ts`, wired into the simulator's
barrel export. `adaptiveCheckpointSchema` holds the run's two co-evolving
lineages (`incumbent`/`opponent`, keyed the same way `./block.ts` names a
block's two sides) as straight-chain, root-first revision histories
(`adaptiveCheckpointLineageSchema`, reusing `./revision.ts`'s
`adaptiveRevisionSchema`), each side's `activeRevisionId` required to name one
of its own checkpointed revisions; `gamesSpent`; a verbatim `referenceField`
(defaults `[]`); `pendingGeneration` (nullable — `null` at a clean block
boundary, or a valid partial-block state: the current block's generated but
not-yet-decided candidates, cross-checked to belong to `nextGeneration`/
`nextBlock` and to have been generated between the two currently-active
revisions, order-agnostic since either side can be the one that lost and
generated); `nextGeneration`/`nextBlock`/`nextSeedPath` so a resumed run never
re-derives a seed path from a stale pair. Deliberately stores state, not
evidence — no `ScheduledMatch` or screening result is checkpointed, following
`../schedule.ts`'s own "resume by regenerating the schedule" precedent;
reading this back into a running loop is M08.18B's job. `envelopes.ts` now
imports and re-exports the checkpoint schema/type/parse function rather than
defining them inline. `ADAPTIVE_CHECKPOINT_SCHEMA_VERSION` bumped 1→2 (the
same additive-widening precedent `ADAPTIVE_RAW_SCHEMA_VERSION` set at
M08.16C); a schemaVersion-1 checkpoint is now refused as an older build. 26
focused tests in `apps/simulator/src/adaptive/checkpoint.test.ts` plus updated
`envelopes.test.ts` (checkpoint coverage moved out of its old shared
`describe.each`) pass, the full `apps/simulator/src/adaptive` suite (155
tests) passes, and `apps/simulator` typechecks clean. Tranche-close gates
(`check:consistency`, `audit:check`, `verify`) and `tcg-reviewer` are deferred
to M08.18E, per this milestone's work-slice split.

M08.18B is implemented: resumable orchestration, in
`apps/simulator/src/adaptive/run.ts` (`runAdaptiveExperiment`), wired into the
simulator's barrel export. It drives the earlier adaptive files
(`./block.ts`'s `scheduleAdaptiveBlock`/`decideAdaptiveBlock`,
`./generate.ts`'s `generateAdaptiveCandidates`, `./evaluate.ts`'s
`scheduleAdaptiveCandidateScreening`/`tallyAdaptiveScreening`, `./promote.ts`'s
`decideAdaptivePromotion`) through real matches via `../run-batch.ts`'s
`runBatch`, against a checkpoint (M08.18A) and a `MatchStore` sink. The
checkpoint only advances once a whole phase is completely settled — one
block's decision, or one generation's full screening-and-promotion — so a
phase interrupted mid-way by `../stop.ts`'s `ExperimentStopped` leaves the
checkpoint exactly as handed in; retrying with that same checkpoint object
against the same persistent `MatchStore` reproduces the identical schedule
(via `../schedule.ts`'s deterministic `matchId` derivation) and never spends a
seed twice, replays a committed match, or mutates lineage out of order. 4
focused tests in the new `apps/simulator/src/adaptive/run.test.ts` prove this
with real (non-mocked) matches — no mocked engine calls — using a
deterministic power-differential deck pairing
(`fixture_dominant_unit`, a 1-cost 9/9 rush, versus a plain deck) to force a
fully reproducible decisive block outcome rather than relying on statistical
win-rate thresholds: one test drives a full block-generate-screen-promote
cycle to a clean budget-exhausted stop; two prove uninterrupted and resumed
runs reach the exact same final checkpoint (`toEqual`) with no duplicate or
missing match records, for interruption both mid-block and
mid-generation-screening (via a `shouldStop` signal that trips after a fixed
job count); one proves a run stops without spending a game once the budget no
longer affords the next block. Full `apps/simulator/src/adaptive` suite (159
tests, up from 155) passes, and `apps/simulator` typechecks clean.
Tranche-close gates (`check:consistency`, `audit:check`, `verify`) and
`tcg-reviewer` are deferred to M08.18E, per this milestone's work-slice split.

M08.18C is implemented: frozen fresh-seed final validation, in
`apps/simulator/src/adaptive/validate.ts` (`freezeAdaptiveFinalDecks`,
`adaptiveValidationSeedPath`, `scheduleAdaptiveValidation`,
`tallyAdaptiveValidation`, `adaptiveValidationStanding`) plus
`runAdaptiveFinalValidation` in `apps/simulator/src/adaptive/run.ts`, wired
into the simulator's barrel export. `freezeAdaptiveFinalDecks` reads only
`checkpoint.lineages` — never `gamesSpent`, block or screening evidence — and
refuses a checkpoint with an undecided `pendingGeneration`, since a deck that
could still be replaced next block is not yet final.
`adaptiveValidationSeedPath` derives one more branch
(`|adaptive:<id>|validation`) of the same deterministic seed tree
`./revision.ts`'s `adaptiveRevisionSeedPath` derives every block/generation
seed from, so the validation stage's shuffles never repeat one either lineage
already played on its way here. `scheduleAdaptiveValidation` schedules
`finalValidationGames` per seat orientation between the two frozen decks
(mirrored under the run's own `mirrorSeats`), reusing `../schedule.ts`'s
`buildSchedule` the same way `./block.ts`/`./evaluate.ts` do — schedule and
tally only, no `runBatch` call, consistent with those files' role split.
`runAdaptiveFinalValidation` (`run.ts`) is the one file that actually plays
the frozen matches, as a deliberately separate entry point from
`runAdaptiveExperiment`'s loop (whose contract stays "spend
`totalLearningBudget` on the learning series" only); it reuses `run.ts`'s
existing `runBatch`/sink-reconciliation helpers, never mutates the
checkpoint, and is resume-safe through `runBatch`'s own match-identity skip.
The previously duplicated `activeRevisionOf` helper was promoted out of
`run.ts` into a shared, exported `activeAdaptiveRevisionOf` in
`checkpoint.ts` — the natural owner of the invariant it relies on, which the
lineage schema's own refinement already guarantees. `envelopes.ts`'s
`adaptiveResultSchema` is untouched, per its own doc comment reserving that
widening for a later slice (M08.18D, reporting). 14 focused tests in the new
`apps/simulator/src/adaptive/validate.test.ts` (freeze happy-path and
`pendingGeneration` refusal, seed-path determinism and non-collision against
representative block/generation paths, mirrored/unmirrored/pilot-scaled
schedule sizing and determinism, seed-path-prefix isolation, tally and
Wilson-interval standing) plus 2 new tests in
`apps/simulator/src/adaptive/run.test.ts` (an end-to-end real-match run
against a deterministic dominant-deck pairing, tallied only from the
validation stage's own records under a `:validation`-suffixed
`experimentId`; and a same-checkpoint-and-store rerun proving no game is
replayed) all pass. The full `apps/simulator/src/adaptive` suite (175 tests,
up from 159) passes, `apps/simulator` typechecks clean, and `eslint` reports
no issues on the changed files. Tranche-close gates (`check:consistency`,
`audit:check`, `verify`) and `tcg-reviewer` are deferred to M08.18E, per this
milestone's work-slice split.

M08.18D is implemented: canonical adaptive reports, in the new
`apps/simulator/src/adaptive/report.ts`, wired into `run.ts`'s raw stream,
`envelopes.ts`'s result envelope, and the simulator's barrel export.
`report.ts` is a leaf: it imports from `checkpoint.ts`, `block.ts`,
`evaluate.ts`, `promote.ts`, `revision.ts`, `generate.ts` and `../analysis/*`,
never from `envelopes.ts` or `run.ts` — those two import from it instead,
avoiding a cycle. `makeAdaptiveSeriesRecord` and `buildAdaptiveScreeningRound`
flatten one decided block and one decided generation's screening into durable
records; `run.ts` gained an `onRawEvent` callback (`AdaptiveRawEvent`, kinds
`series`/`generation`/`screeningRound`) fired only for phases a call actually
decides, never replayed for phases a prior checkpoint already advanced past.
`detectAdaptiveCycles` names blocks whose active `(incumbentDeckHash,
opponentDeckHash)` pair repeats an earlier block's, in series order — a flat,
ordered observation list, never a "healthy/stuck/converged" verdict, per
CLAUDE.md's "automated ... signals are evidence for review, never an automatic
balance verdict." `summarizeAdaptiveReferenceField` pools every screening
round's `fieldTally` into one Wilson-interval standing, returning `null` (not
zero) when no round ever scheduled a reference-field game.
`finalAdaptiveDeckDiff` diffs a lineage's root revision against its
`activeAdaptiveRevisionOf` using `generate.ts`'s own `diffSwaps`.
`buildAdaptiveResult` composes `AdaptiveResultPayload` — `lineages`,
`seriesTally`, `series`, `screeningRounds`, `referenceField`, `finalDeckDiff`,
`cycles`, `validation` — keeping series score and frozen-validation standing on
separate fields exactly as `promote.ts`'s "series wins versus screening
evidence" split requires; `validation` stays `null` until
`runAdaptiveFinalValidation` has run. `renderAdaptiveReport` is a pure Markdown
view of an already-built payload, computing nothing itself.
`ADAPTIVE_RAW_SCHEMA_VERSION` bumped 2→3 (`series`/`screeningRounds` added,
both defaulting to empty) and `ADAPTIVE_RESULT_SCHEMA_VERSION` bumped 1→2 (the
result envelope widened from an empty identity stub to the full report
payload); a schemaVersion-2 raw record or schemaVersion-1 result is now
refused as an older build, per the same additive-widening precedent
`ADAPTIVE_CHECKPOINT_SCHEMA_VERSION` set at M08.18A. 32 focused tests in the
new `apps/simulator/src/adaptive/report.test.ts` (series-record construction,
cycle detection with and without repeats, screening-round flattening for both
promoted and retained decisions, reference-field pooling and its null case,
final deck diff with and without a commander change, and full result
composition/rendering with and without a frozen validation outcome) pass,
alongside updated coverage in `envelopes.test.ts` for the new raw/result
schema versions and the now non-empty result payload. The full
`apps/simulator/src/adaptive` suite (187 tests, up from 175) passes, and
`apps/simulator` typechecks clean. Tranche-close gates (`check:consistency`,
`audit:check`, `verify`) and `tcg-reviewer` are deferred to M08.18E, per this
milestone's work-slice split.

M08.18E is done pending review: revalidated the combined M08.18 tranche diff
(`checkpoint.ts`, `run.ts`, `validate.ts`, `report.ts`, `envelopes.ts` and
their tests, plus the `apps/simulator` barrel export) against this milestone's
acceptance list — checkpoint/resume equivalence, partial-block state, lineage,
fresh-seed frozen validation, series-versus-validation separation and
descriptive (non-verdict) cycle detection all present. `npm run format:check`
flagged 6 adaptive files as unformatted (`checkpoint.ts`/`.test.ts`,
`envelopes.test.ts`, `report.ts`/`.test.ts`, `validate.test.ts`) — a real gate
failure, not pre-existing; ran `prettier --write` on exactly those 6 files, no
behavior change. `npm run check:consistency`, `npm run audit:check` and
`npm run verify` all pass clean (219 test files, 4510 tests, typecheck, lint,
format, content validation, build). Marked M08.18E and the M08.18 checklist
complete in the milestone file. Root status row's "Next tranche" column left
at `M08.18A` rather than advanced to `M08.19A`, per CLAUDE.md: the tranche is
not marked complete and its successor is not named until `tcg-reviewer`
returns `VERDICT: APPROVE`.

`tcg-reviewer` returned **`VERDICT: CHANGES REQUIRED`** over the M08.18 commit
range (`80a4622..HEAD`) plus the close-record diff, with one HIGH blocking
finding: `runAdaptiveExperiment` (`apps/simulator/src/adaptive/run.ts`) fired
`onRawEvent` unconditionally in `playBlock`/`processGeneration`, but the file's
own resume contract requires a caller to retry an interrupted attempt with the
_same, unadvanced_ checkpoint — so a block or generation already fully decided
and emitted by an earlier, interrupted attempt gets recomputed and re-emitted
a second time on resume whenever the interruption actually fell in a _later_
phase. That duplicates `series`/`generation`/`screeningRound` raw records,
double-counting `tallyAdaptiveSeries`, `summarizeAdaptiveReferenceField` and
fabricating a spurious `detectAdaptiveCycles` repeat purely from an
interruption — the exact "replay" the checklist item "Checkpoint and resume
without replaying" forbids, just in the raw-evidence stream rather than the
checkpoint or the match store.

Fixed: `playBlock` and `processGeneration` now gate every `onRawEvent` call on
whether this call actually ran a fresh match for that phase
(`outcome.records.length > 0`, i.e. `runBatch`'s own per-call fresh-match
count — nonzero exactly when at least one of the phase's matches was not
already committed to the sink before this call). A phase whose entire
schedule was already committed by an earlier attempt is still recomputed
deterministically (so the loop can advance past it to reach a later
interrupted phase) but never re-emits its event; `runCandidateScreening` was
widened to return its own per-call fresh count so `processGeneration` can OR
across every candidate's screening groups before deciding whether the whole
round's `screeningRound` event is new. Tightened the `onRawEvent` docstring to
state this precisely instead of the reviewer-disproven "never replayed at
all" claim. Added a regression test in `run.test.ts` ("never re-emits
onRawEvent for a phase an earlier, interrupted attempt already decided")
attaching `onRawEvent` across an interrupted-then-resumed run and asserting
the first attempt emits exactly `series`+`generation` while the resumed
attempt emits only the not-yet-decided `screeningRound` — no duplicate kinds
in the combined stream. The full `apps/simulator/src/adaptive` suite (188
tests, was 187) and `apps/simulator` typecheck pass; `eslint` reports no
issues on `run.ts`/`run.test.ts`.

The review's two MEDIUM and one LOW findings are non-blocking and recorded
here for the tranches that touch this code next, unfixed in this close per
CLAUDE.md's two-cycle/no-scope-widening rule:

- `checkpoint.nextGeneration`/`nextSeedPath` go stale after a tie/no-decision
  block and after a decided generation (both leave them at their pre-phase
  values). Investigated why: `generateAdaptiveCandidates` always derives its
  own `generation` as `loserRevision.generation + 1` — a per-lineage-side
  counter, never read from `checkpoint.nextGeneration` — so the two lineages'
  generation counts can diverge once one side loses more often than the
  other, and "the generation the next call should produce" has no single
  well-defined value at a clean block boundary until the next block's loser
  is known. No production code reads either field today (confirmed by
  search), so this is a misleading durable record, not a live corruption or
  seed collision. Needs an owner decision next time this file is touched:
  either accept the fields can only be exact while `pendingGeneration` is
  set and document that, or drop them from the schema (a version bump) since
  nothing consumes them.
- `runAdaptiveExperiment`/`runAdaptiveFinalValidation` never check that the
  handed-in checkpoint's `experimentId` matches `options.config.id`, nor call
  the tranche's own `assertValidAdaptiveCheckpoint` against
  `config.commanderPolicy` — an operator resuming one run's checkpoint against
  a mismatched or edited config proceeds silently. Add both checks the next
  time this file is touched.
- `deriveBlockOutcome`/`tallyAdaptiveValidation` silently misattribute every
  decisive game to the incumbent if the two active decks ever share a
  `deckHash` (e.g. a generation-0 mirror under `commanderPolicy: 'locked'`);
  add a same-hash refusal the next time this file is touched.

Re-ran `npm run check:consistency`, `npm run audit:check` and `npm run
verify` after the fix: all pass clean (219 test files, 4511 tests, typecheck,
lint, format, content validation, build).

`tcg-reviewer`'s bounded recheck confirmed the `freshlyPlayed`/`freshCount`
gate closes the HIGH finding — verified by inspection that `runBatch` only
ever populates `records` with matches not already committed to the sink, that
a `runBatch` committing every scheduled match cannot itself throw
`ExperimentStopped` (the sequential-mode stop check runs before dispatch, and
the worker-pool's `noMoreWork()` short-circuits ahead of `shouldStop` once
`nextJob >= jobs.length`), and that `processGeneration`'s OR-across-candidates
has no partial-freshness hazard since the flag is only read after every
candidate has screened. Confirmed the regression test exercises the
previously-vacuous path (fails under the pre-fix code) and that the six
formatting-only files are byte-identical aside from prettier reflow/quote
normalization. Returned **`VERDICT: APPROVE`**, with three non-blocking LOW
findings for the next tranche that touches `run.ts`/`run-batch.ts`:

- `freshlyPlayed`/`freshCount` conflate "every match already committed" with
  "every fresh match failed outright" — under `failFast: false`, a resumed
  attempt whose remaining pending matches all throw yields
  `outcome.records.length === 0` and silently skips emitting a decided
  phase's raw record (an undercount, not a duplicate). Narrow: requires
  runner exceptions, and `gamesSpent` accounting is already degraded in that
  case from M08.18B. Fix by gating on `outcome.skippedByResume <
scheduled.matches.length` instead, next time this file is touched.
- `apps/simulator/src/run-batch.ts`'s `BatchOutcome.records` docstring says
  "Every record produced _or resumed_ for this batch," which the
  implementation contradicts (resumed matches go to `skippedByResume`, not
  `records`) — harmless when only `recordsForSchedule` relied on it, now
  load-bearing for the `onRawEvent` gate's correctness. Fix the one-line
  comment next time this file is touched.
- (Already corrected in this close, not deferred:) the M08.18E milestone note
  had recorded the pre-fix gate's stale test count and a broken line-wrap;
  updated to the post-fix count and reflowed.

M08.18 tranche-close record committed and pushed. M08.18 is complete.
