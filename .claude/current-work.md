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

M08.19A closed 2026-09-02. The prior blocking question (how an adaptive run
becomes a queued, executable job) was answered by the owner across two
`AskUserQuestion` rounds: a dedicated mutating address/`JobOrigin` member
(mirroring `scheduleChampionship`), and a `jobSpecSchema` widened to a union
rather than a parallel store. With the architecture settled, this slice made
its own further, narrower scope call: implement contracts, restoration and
workload only, and defer everything execution-shaped (`enqueueAdaptive`,
`CatalogStore`/`Job` persistence, the `jobSpecSchema`/`experimentKindSchema`
union widening, job-runner dispatch) to a not-yet-named later slice — because
`ExperimentRunner.run()`/the job-runner are deeply coupled to
`ExperimentConfig`'s match-count/schedule model, and M08.19's own
**Acceptance** line never requires execution wiring for the builder slice.
This deferral is recorded as "the next action" (distinct from the literal
next work slice, M08.19B, which does not depend on it) in
`IMPLEMENTATION_PLAN.md`'s "The next bounded task" section.

Changed: `packages/admin-contracts/src/presets.ts` (9th `presetChoiceSchema`
member `adaptive_counter` — `ADAPTIVE_COMMANDER_POLICIES`,
`ADAPTIVE_INFORMATION_POLICIES`, `adaptiveSwapBoundSchema`,
`adaptiveRebuildTriggerSchema`, `startingDeckSelection`, and the full 12-field
control surface mapped onto `AdaptiveConfig`: starting decks, Commander/
information/adaptation policy, budget, block, candidate, swap, counter-focus,
reference-field and final-validation), `adaptiveExpansionSchema`; `estimate.ts`
(`adaptiveWorkloadEstimateSchema`, refined so `shortfallReason` is non-empty
exactly when `gamesUnspent !== 0`); `service.ts` (`choiceEstimateSchema`
widened to `z.union([presetExpansionSchema, adaptiveExpansionSchema])` /
`z.union([matchCountEstimateSchema, adaptiveWorkloadEstimateSchema])` —
`enqueuePresetResultSchema` deliberately left on the unwidened shape since
`enqueuePreset` still refuses adaptive); `index.ts` re-exports.
`apps/admin-server/src/lab/expand.ts` gained exactly one refusing
`case 'adaptive_counter':` in `expandPreset`'s exhaustive switch, quoting the
preset registry's own `limitations[0]`. New
`apps/admin-server/src/lab/adaptive-choice.ts` (`estimateAdaptiveChoice`,
`AdaptiveChoiceEstimate`) is the parallel door: safe-parses the choice,
requires distinct starting precons and distinct/known selected Commanders,
resolves the starting deck for real via `resolveDeckSource` (catches a bad
precon ID before it ever reaches `AdaptiveConfig`), builds and parses a real
`AdaptiveConfig` via `parseAdaptiveConfig`, then prices it with
`planAdaptiveBudget`; reuses `expand.ts`'s `PresetRefused`, `presetEnvironment`,
`presetEnvironmentConfig`, `scrubRefusal` rather than duplicating them.
`apps/admin-server/src/service/handlers.ts` branches `#estimateChoice` and
`#saveChoice` to a new `estimateAdaptiveOrRefuse` wrapper when
`choice.presetId === 'adaptive_counter'`; `#enqueuePreset` is deliberately
unbranched and keeps refusing. `apps/admin-client/src/components/
BuilderScreen.tsx` and `apps/admin-client/src/test/fake-service.ts` updated
only for the widened `ChoiceEstimate` union type (narrowing guards / a
precise non-union return-type annotation) — no new adaptive UI, since the
client's own preset picker never offers a `status: 'reserved'` preset.

Version decision: no `ADMIN_CONTRACT_VERSION` or `SAVED_CHOICE_VERSION` bump.
`version.ts`'s own version-4 doc comment treats additive `presetChoiceSchema`
widening as not requiring a bump by itself (only new endpoint addresses did),
and `git log -S` confirms `SAVED_CHOICE_VERSION` has never moved despite many
earlier additive preset-field widenings. This slice adds zero new endpoint
addresses (reuses `estimateChoice`/`saveChoice`; `enqueuePreset` still refuses
adaptive unconditionally, so no new capability is end-to-end reachable yet),
and no `Job`/catalog document persistence changed, so `CATALOG_DOCUMENT_VERSION`
does not apply either.

Verified: 10 new tests in `adaptive-choice.test.ts` (validates into a real
`AdaptiveConfig` and prices it; shortfall reporting; every control carried
through unchanged; refusals for an unknown precon, a duplicated precon, an
unknown Commander, min>max swap bound, a Commander named under a policy that
never reads one, a mismatched `presetId`, and that no refusal message names a
filesystem path). 4 new tests in `builder-endpoints.test.ts` (20 total in that
file): the workload/expansion shape returned before enqueueing, full
restoration of every control through save-and-reopen, refusal on an invalid
choice, and that `enqueuePreset` still refuses adaptive. `presets.test.ts`'s
field-name drift guard updated to include the 12 new fields (417
admin-contracts tests pass). `admin-server` focused suite (172) and
`admin-client` suite (285) pass. `typecheck` clean across all four touched
workspaces (`admin-contracts`, `admin-server`, `admin-client`, `simulator`).
ESLint clean on every touched file.

M08.19B is implemented: the directory-keyed adaptive result read model,
serving M08.18's canonical `adaptive-result.json`/`adaptive-checkpoint.json`
straight through to bounded tables and a summary, without recomputing any
simulator meaning. Scope chosen by the owner via `AskUserQuestion`
("Directory-keyed reader, no Job (Recommended)"): `EXPERIMENT_KINDS` has no
`'adaptive'` member yet (M08.19A deferred all execution wiring), so there is
no `JobId` to key a `results.ts`-style reader by; this reader takes a resolved
run directory directly and serves no HTTP endpoint yet — wiring a directory to
a job address is still the same deferred, unscoped "next action" M08.19A
named, not this slice's job.

New `packages/admin-contracts/src/adaptive-results.ts` (re-exported from
`index.ts`): `adaptiveExperimentIdSchema` restates `@tcg/simulator`'s own
bound and regex (40 chars, `^[a-z][a-z0-9_-]*$`) rather than importing it
(ADR 0001, mirroring `EXPERIMENT_KINDS`'s existing precedent) — caught and
fixed a self-introduced drift where an earlier draft of this restatement had
only the length bound (200, wrongly documented as matching the simulator)
with no regex at all, which would have let a malformed ID pass the outgoing
"publish exactly" validation this file exists to enforce.
`ADAPTIVE_RESULT_TABLE_NAMES` names the 7 tables this build serves (`series`,
`revisions`, `screening_candidates`, `deck_diff`, `cycles`, `reference_field`,
`validation`) — one per evidence stream `AdaptiveResultPayload`
(`apps/simulator/src/adaptive/report.ts`) keeps separate; `revisions` and
`deck_diff` fold both lineages into one table each via a `side` column rather
than two identically-shaped tables. `adaptiveResultTableSchema` and
`adaptiveRunSummarySchema` mirror `results.ts`'s sibling shapes (bounded
columns/rows/page, the same two refinements) but are deliberately thinner: no
`jobId` (nothing to key one by yet) and no `evidenceStanding`/`calibration`
(an adaptive run writes no calibration standing, so the field would have
nowhere honest to read from) — a summary asserts it carries neither via a
drift-guard test.

New `apps/admin-server/src/service/adaptive-results.ts`
(`readAdaptiveSummary`, `readAdaptiveTable`): reads `adaptive-result.json`
loosely (unknown-field-stripping `adaptiveResultSchema`), checks
`refuseForeignVersion` before `.safeParse()` exactly as
`catalog/job-config.ts`'s `readJobConfig` does, and re-validates every
outgoing summary/table against the admin-contracts strict schema before it
leaves. Checkpoint-is-state-not-evidence (per `checkpoint.ts`'s own doc
comment): a completed run's summary and tables are built only from
`AdaptiveResultPayload`, never from `adaptive-checkpoint.json`; the checkpoint
is opened only as best-effort diagnostic context
(`gamesSpent`/`pendingGeneration`/lineage lengths) on an `admin/no_result`
refusal, and any failure reading it (missing, unreadable, foreign version,
schema-invalid) collapses to `null` context rather than misleading context. A
candidate's `null` `fieldTally` (not-measured) maps to `null` cells, never a
fabricated zero; `reference_field`/`validation` are 0-or-1-row tables — row
_absence_, never a null-filled row, when that evidence was not produced.

Verified: 19 new tests in `adaptive-results.test.ts` (admin-server) — summary
projection and readings read straight off the payload, per-table row counts,
fixed limitations; refusals for no documents, a checkpoint-only incomplete
run (asserting the four context keys), unreadable JSON, an unsupported
schema version, a schema-invalid document, and a bad checkpoint never
standing in as context for a bad result; table column/cell-membership
invariant, two-lineage `side` splitting, null-`fieldTally` cells, the
0-row/1-row `reference_field` and `validation` cases, no-decision block
rendering, and pagination. 11 new tests in `adaptive-results.test.ts`
(admin-contracts) — experiment-ID bound/regex, table round-trip and its two
refinements, the closed table-name and document-name lists, and the summary's
missing-`jobId`/missing-calibration drift guards. `npm run typecheck` clean
on both `@tcg/admin-contracts` and `@tcg/admin-server`; `eslint` reports no
issues on the four new files.

M08.19C is implemented: the series and revision dashboard. Since M08.19B
deliberately shipped no HTTP endpoint, this slice's first job was wiring
`adaptiveRunSummary`/`adaptiveResultTable` through the admin contract and
server the same way every other endpoint reaches `AdminSession` — new
addresses in `ADMIN_ENDPOINTS` (`packages/admin-contracts/src/service.ts`),
`adaptiveRunSummaryRequestSchema`/`adaptiveResultTableRequestSchema`
(`requests.ts`, carrying only `experimentId` — no filesystem path travels in
the request, per ADR 0023 §5), a `version.ts` bump for the new addresses, and
two handlers in `apps/admin-server/src/service/handlers.ts` that route
straight to M08.19B's existing `readAdaptiveSummary`/`readAdaptiveTable`.
`AdminSession` (`apps/admin-client/src/net/session.ts`) gained the matching
`adaptiveRunSummary`/`adaptiveResultTable` methods.

New `apps/admin-client/src/lib/adaptive-view.ts`: `readAdaptiveRate`/
`displayColumns`/`formatAdaptiveCell` fold an interval column's low/high/count
fields into one rendered cell by the server's own `column`/`interval` key
naming convention (`adaptive-results.ts`'s `buildAdaptiveTable`);
`cumulativeSeriesTally`/`rollingSeriesTally` (window size 10) are pure
prefix/window sums over the `series` table's own already-reported
`decisionKind`/`decisionLoser` cells — never a fabricated statistical
confidence interval, per this repository's design principle for client-derived
series views. New `apps/admin-client/src/components/AdaptiveDashboard.tsx`
(`AdaptiveRunPanel`): entered by typing the `experimentId` a directory-keyed
run has no `JobId` to be selected by (mirroring `AdaptiveResultReader`'s own
job-free resolution); renders the run summary via `FactTable`, then a tab per
`series`/`revisions`/`screening_candidates`/`deck_diff`/`reference_field` —
`series` shows both tallies plus its exact rows, `screening_candidates`/
`reference_field` show a promotion-score/standing rate summary plus exact
rows, `revisions`/`deck_diff` are exact-table-only since every cell in them is
categorical. `cycles`/`validation` render "Shown in a later slice." —
M08.19D's job. Reuses `Busy`/`Empty`/`Failure`, `FactTable`, and the existing
`dashboard__*`/`builder__field` CSS classes verbatim; no new CSS. Wired into
`ResultsScreen.tsx` behind a "Catalog job" / "Adaptive Counter run" mode
toggle that leaves the pre-existing catalog flow structurally unchanged.

Verified: 7 new unit tests in `adaptive-view.test.ts` (interval-cell reading,
column folding, cell formatting including the null-vs-"Not measured" case, and
both tallies including the trailing-window-only case). 3 new integration tests
in `adaptive-flow.test.tsx` — an invalid experiment ID is refused locally with
no request ever reaching the transport, an unseeded experiment ID reports
honestly that it produced no adaptive result yet, and a seeded run renders its
summary, its series cumulative tally's exact final-row counts, and a second
table after switching tabs. All 10 pre-existing `results-flow.test.tsx` tests
still pass unmodified (no regression to the catalog path), and the full
`admin-client` suite (295 tests) passes. Server-side: 22
`adaptive-results.test.ts` and 23 `admin-contracts/service.test.ts` tests
pass. `npm run typecheck` and `eslint` clean on every changed/new file across
`admin-client`, `admin-server` and `admin-contracts`; `prettier --write`
applied to the same files with no behavior change.

M08.19D is implemented: validation, cycles and drill-down, closing the two
placeholders M08.19C's `TableView` left ("Shown in a later slice.") and adding
the public-versus-full-information label CLAUDE.md's bot-observation-boundary
invariant requires once analysis-mode evidence becomes human-readable.

`informationPolicy: AdaptiveInformationPolicy` now travels the whole pipeline
rather than stopping at the config: `apps/simulator/src/adaptive/report.ts`'s
`adaptiveResultPayloadSchema`/`BuildAdaptiveResultInput`/`buildAdaptiveResult`
carry it, and a new exported `informationPolicyLabel()` renders it into
`renderAdaptiveReport()`'s Markdown right after `configHash` — the
`analysis_full_deck` wording states plainly that the run is not evidence of
hidden-information play. `ADAPTIVE_RESULT_SCHEMA_VERSION` bumped 2→3
(`version.ts`) for this additive field, the same precedent every earlier
`ADAPTIVE_*` widening in this milestone set.
`packages/admin-contracts/src/adaptive-results.ts`'s `adaptiveRunSummarySchema`
gained the field, reusing `presets.ts`'s already-restated
`adaptiveInformationPolicySchema` (ADR 0001 — ADR 0001 pattern was already in
place from an earlier milestone, no new restatement needed).
`apps/admin-server/src/service/adaptive-results.ts`'s `readAdaptiveSummary()`
forwards `result.informationPolicy` straight through, no server computation.
`AdaptiveDashboard.tsx` renders it as a new always-visible
`.dashboard__policy` banner (`informationPolicyBanner()`, `styles.css`) —
deliberately not `.dashboard__truncation`'s warning styling, since this banner
is informational at every policy value, not only a degraded one.

`ValidationView` and `CyclesView` replace the two placeholders.
`ValidationView` states explicitly that the frozen fresh-seed standing is a
separate controlled comparison, kept apart from `seriesTally` rather than
folded into it — the "series wins versus screening evidence" split
`promote.ts`/`report.ts` already enforce in data, now stated in the view too.
`CyclesView` reports `detectAdaptiveCycles`' repeats descriptively only, with
an explicit note that this is never a verdict that the meta is healthy, stuck
or converged (CLAUDE.md: automated signals are evidence for review, not an
automatic verdict) — mirroring `report.ts`'s own doc comment for the same
function.

Drill-down: new `AdaptiveDrillTarget`/`adaptiveRowDrillTarget()`
(`apps/admin-client/src/lib/adaptive-view.ts`) mirrors `ResultDashboard.tsx`'s
existing `rowDrillTarget` pattern for this sibling table shape — an interval
column folds into one rendered rate fact via `formatRate`, a null cell reads
as "Not measured," never the literal word "null." Every adaptive table
(`SeriesView`/`ScreeningView`/`ReferenceFieldView`/`PlainTableView`/
`CyclesView`/`ValidationView`) now renders a trailing "Exact row" button
(`ExactTable`'s new `onDrill` prop) that opens a `FactTable` panel reusing
`ResultDashboard.tsx`'s exact `dashboard__drill`/`dashboard__drill-head` CSS
and its M08.26 Match Explorer disclaimer — drill-down reaches the exact row a
revision or a segment was drawn from, never a match or a replay, the same
boundary the M08.11 precon dashboard already draws. `ADAPTIVE_DASHBOARD_TABLES`
now lists all seven tables (`cycles`/`validation` added).

Verified: simulator 25 tests (`report.test.ts` 14 + `envelopes.test.ts` 11,
including the new `informationPolicy` round-trip and future/older-version
refusal at schemaVersion 4/2) pass, `apps/simulator` typechecks clean.
admin-contracts 12 tests (`adaptive-results.test.ts`, including a new refusal
for an unrecognized information policy) pass, typechecks clean. admin-server
22 tests (`adaptive-results.test.ts`) pass, typechecks clean. admin-client:
fixed a fixture gap this slice's schema widening exposed
(`fake-service.ts`'s `adaptiveRunSummaryFixture()` was missing the now-required
`informationPolicy` field, since `adaptiveRunSummarySchema` is a
`z.strictObject` with no default for it — the only other caller of that
fixture is `adaptive-flow.test.tsx`, already covered by the same fix); full
`admin-client` suite passes at 298/298 tests across 16 files (10 new in
`adaptive-view.test.ts` — `ADAPTIVE_DASHBOARD_TABLES` naming and
`adaptiveRowDrillTarget` interval-folding/null-cell coverage — plus 3 existing
`adaptive-flow.test.tsx` integration tests, unchanged in count but exercising
the new banner/drill-down/validation/cycles rendering). `npm run typecheck`
clean across `apps/simulator`, `packages/admin-contracts`, `apps/admin-server`,
`apps/admin-client`.

Tranche-close gates (`check:consistency`, `audit:check`, `verify`) and
`tcg-reviewer` are deferred to M08.19E, per this milestone's work-slice split.
Root status row's "Next tranche" column and the M08.19 acceptance checklist
are left untouched — both move only at tranche close.

M08.19E is done pending review: revalidated the combined M08.19 tranche diff
(`e96e0f5^..071fae1` — `presets.ts`/`estimate.ts`/`service.ts`/`requests.ts`/
`version.ts`/`adaptive-results.ts` in `admin-contracts`; `adaptive-choice.ts`,
`expand.ts`, `adaptive-results.ts`, `handlers.ts`, `results.ts` in
`admin-server`; `adaptive-view.ts`, `AdaptiveDashboard.tsx`, `BuilderScreen.tsx`,
`ResultsScreen.tsx`, `session.ts`, `fake-service.ts` in `admin-client`;
`report.ts`/`envelopes.ts`/`version.ts` in `simulator`; plus their tests)
against this milestone's acceptance list — configuration restoration, workload,
public/full-information labelling, revision drill-down and incomplete-run
refusal all present with existing focused tests.

Found and closed one real gap during revalidation: no test anywhere in the
tranche exercised the `cycles` table with an actual repeated deck-hash row —
every seeded fixture in `admin-client`, `admin-server` and `admin-contracts`
used `cycles: rows: 0`, so the milestone's own **Acceptance** line ("cycle
fixture ... tests") was unmet at the layers M08.19 actually added. The pure
`detectAdaptiveCycles` computation already had a real repeat fixture from
M08.18D (`report.test.ts`), but nothing proved the M08.19D `CyclesView`
rendering/drill-down path against non-empty data. Added one integration test
in `apps/admin-client/src/adaptive-flow.test.tsx` that seeds a one-row
`cycles` table (`block: 3`, `repeatsBlock: 1`) and asserts `CyclesView` renders
it descriptively (matches "never an automatic verdict") rather than as a
health verdict, and that its "Exact row" button opens the drill panel titled
"Block 3 repeats block 1 — exact row". `admin-client` suite now 299/299 (was
298).

`npm run format:check` flagged 10 pre-existing unformatted files spanning the
whole tranche (`AdaptiveDashboard.tsx`, `BuilderScreen.tsx`,
`adaptive-choice.ts`/`.test.ts`, `admin-server`'s and `admin-contracts`'
`adaptive-results.ts`/`.test.ts`, `apps/simulator/src/adaptive/report.ts`,
`.claude/current-work.md`) — a real gate failure, not introduced by this run.
Ran `prettier --write` on exactly those 10 files; inspected every diff and
confirmed reflow/quote-normalization only, no behavior change. `npm run
check:consistency`, `npm run audit:check` (after regenerating
`docs/status-audit.md`, which had drifted to describe an older commit) and
`npm run verify` all pass clean (224 test files, 4573 tests, typecheck, lint,
format, content validation, build). Marked M08.19E and the M08.19 acceptance
checklist complete in the milestone file. Root status row's "Next tranche"
column left at `M08.19A` rather than advanced to a not-yet-named M08.20/next
slice, per CLAUDE.md: the tranche is not marked complete and its successor is
not named until `tcg-reviewer` returns `VERDICT: APPROVE`. (M08.19's own
"next action" — the deferred `enqueueAdaptive`/job-runner wiring gap recorded
in `IMPLEMENTATION_PLAN.md` — remains open and unscoped; this close does not
touch it.)

`tcg-reviewer` reviewed the full tranche commit range (`e96e0f5^..071fae1`)
plus the uncommitted close-record diff, independently re-verified the
"formatting-only" claim on all 10 prettier-reformatted files by reading every
hunk, and confirmed the new cycles-fixture test actually closes the gap it
claims to close. Returned **`VERDICT: APPROVE`**, with two non-blocking LOW
findings to keep in mind next time these files are touched, not required for
this close:
- `apps/admin-client/src/components/AdaptiveDashboard.tsx:405` (`SeriesView`):
  the "Cumulative — every decided block so far" heading can mislead when the
  series table is truncated to one page (a small `blockSize` against a large
  budget can decide more blocks than `PAGE_SIZE_MAX`); the truncation note
  above it mitigates but doesn't fully cover this.
- `apps/admin-server/src/service/adaptive-results.ts:454,522,549`
  (`buildAdaptiveTable`): three call sites use `spreadRate` rather than the
  null-vs-zero-safe `spreadRateOrInsufficient` `results.ts` documents for
  exactly this reason; no reachable zero-game score exists today, but the
  safe helper should be used at the source next time this file changes.

Root status row's "Next tranche" column advanced to `M08.20A`; `IMPLEMENTATION_PLAN.md`'s "next bounded task" now names **M08.20A — Candidate
Patch Comparison**. M08.19 tranche-close record committed and pushed. M08.19
is complete.

## M08.20A — Candidate Patch Comparison

Widened the `candidate_comparison` admin-lab preset from remove-only candidate
changes to remove-and-patch: a candidate can now also declare per-card balance
edits (`cost`/`attack`/`health`) alongside, or instead of, removals.

`packages/admin-contracts/src/presets.ts`: added `candidateCardPatchSchema`
(`cardId` + optional `cost`/`attack`/`health`, `.refine`d to require at least
one field); relaxed `candidate_comparison`'s `removeCardIds` from `.min(1)` to
`.default([])` and added `cardPatches: z.array(candidateCardPatchSchema).max(40).default([])`,
moving the "must declare *some* change" rule to `expand.ts` (same
schema-shape-vs-cross-field-refusal split already used for
`adaptiveSwapBoundSchema`). Updated the registry's `summary`/`limitations` text
to state the patch surface is exactly three numeric dials, not a structural
editor. Exported `candidateCardPatchSchema`/`CandidateCardPatch` from
`packages/admin-contracts/src/index.ts`.

`apps/admin-server/src/lab/expand.ts`: generalized `requirePoolCards` (now
takes a verb/path so both removals and patches share it) and added
`requireCandidatePatches`, which in one pool-map pass refuses (a) a patch
target absent from the pool, (b) a card both removed and patched, and (c) an
`attack`/`health` edit on a card with no combat stats. That third check exists
because `resolveEnvironment()` re-validates the patched card against
`cardDefinitionSchema` and throws a raw non-Zod `Error` on a statted/non-statted
mismatch (e.g. patching a spell's `attack`) — not part of the original scoped
plan, found while re-reading `resolveEnvironment()`, and closed the same way
`requirePoolCards` already turns an analogous raw-Error failure mode into an
ordinary admin refusal. Since admin-server cannot import `@tcg/card-data`
(`boundary.test.ts`), the check reads the already-resolved pool card's own
`attack === undefined` as a structural-boundary-compliant proxy for
`STATTED_TYPES`. Rewrote `candidateComparison()` to build a `CardPatch[]` for
the simulator's `EnvironmentConfig.cardPatches`, compute exact declared
`cardsChanged[].fields` via a new `candidatePatchFields()` helper (so
`checkDeclaredChanges`'s exact bidirectional field-name match is satisfied),
and record patch decisions as `"cardId(field+field)"` strings (`PresetValue`
cannot hold arrays of objects). `expandPreset`'s switch arm now calls
`requireCandidatePatches` and refuses when both `removeCardIds` and
`cardPatches` are empty.

Confirmed no new test was needed for "a candidate comparison cannot publish
live content": read `boundary.test.ts` in full — this invariant already holds
structurally, by construction, because nothing in `apps/simulator/src/environment.ts`
writes `cardPatches`/`cardOverrides` into `content/`; this widening adds no new
write path, so nothing changed for that guarantee.

Focused verification: added patch-target/combat-stat/overlap/duplicate/empty-
declared-change tests plus a "patch alongside a removal" and "removal and
patch on different cards" test to `apps/admin-server/src/lab/expand.test.ts`
(53 tests, all passing); split `packages/admin-contracts/src/presets.test.ts`'s
empty-candidate-change test to match the relaxed schema and added the new
`cardPatches` field to its exhaustive-field-list test (34 tests, all passing).
`npx vitest run packages/admin-contracts apps/admin-server`: 48 files, 1069
tests, all passing. `npx eslint` on all five changed source/test files: clean.
`npm run --workspace @tcg/admin-contracts typecheck` and
`npm run --workspace @tcg/admin-server typecheck`: both clean. Marked M08.20A
complete in the milestone file with a full evidence note; the M08.20 tranche
checklist and root status row are untouched, per CLAUDE.md — both move only at
tranche close.

Next slice: **M08.20B — Pilot Robustness**, per `IMPLEMENTATION_PLAN.md` and
the M08.20 tranche in `docs/milestones/M08-ai-lab-and-player-meta.md`.

M08.20B is verified complete, with no source change. Re-checked the slice's
scope ("map controls onto the existing robustness contract, preserve profile
partitions and denominators, refuse any pooled rate whose pilot meaning is
unexplained") against current code before implementing anything, per CLAUDE.md
step 3. Found the `pilot_robustness` preset — its `presetChoiceSchema` member,
`PRESET_REGISTRY` entry (`status: 'available'`), `expand.ts`'s
`pilotRobustness()` mapping (always includes `published` as the reference arm,
deduplicates it when already chosen), and `estimate.ts`'s `robustness` case
(prices every profile as its own schedule repeat, `repeats: profiles.length`,
never a pooled total) — already fully built, at M08.3 (`c6bcadf`), long before
M08.20 was numbered; confirmed with `git log -S`. The underlying
`analyzeRobustness` (`apps/simulator/src/analysis/robustness.ts`,
PHASE4_HARDENING §10.3) already reports every profile as its own arm by
construction and never pools them. Unlike M08.20A (which found and closed a
real gap — card patches), no gap exists here to close.

Focused re-verification: `apps/admin-server/src/lab/expand.test.ts` (53/53,
includes the `published`-reference-arm and no-duplicate tests),
`apps/admin-server/src/lab/estimate.test.ts` (34/34, includes "agrees on a
robustness run, once per profile including the reference arm"),
`packages/admin-contracts/src/presets.test.ts` (34/34),
`apps/simulator/src/hardening-analysis.test.ts` (33/33),
`apps/simulator/src/hardening-experiment.test.ts` (26/26, includes "runs every
profile on the same seeds and reports them separately" and "is reproducible")
— 180 tests total, all passing. `npm run --workspace @tcg/admin-contracts
typecheck`, `--workspace @tcg/admin-server typecheck` and `--workspace
@tcg/simulator typecheck` all clean. Marked M08.20B complete in the milestone
file with this evidence note; the M08.20 tranche checklist and root status row
are untouched, per CLAUDE.md — both move only at tranche close.

Next slice: **M08.20C — Engine Soak and advanced card analysis**, per
`IMPLEMENTATION_PLAN.md` and the M08.20 tranche in
`docs/milestones/M08-ai-lab-and-player-meta.md`.

M08.20C had two parts. Engine Soak is verified complete, with no source
change — same pattern as M08.20B. Re-checked the slice's scope ("bounded
batch/random-legal termination configuration that retains failures and
reports engine health rather than balance") against current code first. Found
the `engine_soak` preset already pinned to `SOAK_PILOT_ID = 'random_legal'`
with `SOAK_TURN_LIMIT = 150` and `failFast: false`
(`apps/admin-server/src/lab/expand.ts`'s `engineSoak()`, built at M08.3,
`c6bcadf`, the same commit as Pilot Robustness); abnormal-match replay
retention (`ABNORMAL_TERMINATIONS`/`isAbnormal()` in
`apps/simulator/src/telemetry/schema.ts`) is structural and unconditional;
`applySupportLimits` (`apps/simulator/src/analysis/flags.ts`) downgrades
every balance-level flag to `insufficient_data` whenever a run used only
legality-only pilots, which every soak run does by construction; and the
reporter's existing "Abnormal matches (observation)" section
(`apps/simulator/src/reporting/report.ts`) already surfaces crashes, stalls,
illegal choices and limit trips for any batch-kind run. No gap to close.

Card Replacement was a genuine gap: `EXPERIMENT_KINDS` already includes
`'replacement'` and the simulator already runs it end-to-end
(`replacementConfigSchema`, `runReplacementExperiment`, and
`estimate.ts`'s existing `case 'replacement':` at `basis: 'at_least'`), but no
admin-lab preset mapped any choice onto it. Revalidated the underlying
contract first, per the slice's own wording ("expose ... only if their
current contracts still pass revalidation"): `npx vitest run
apps/simulator/src/insertion.test.ts apps/simulator/src/experiment.test.ts`
passed 39/39 unchanged before any new code was written.

Added a ninth preset, `card_replacement`
(`packages/admin-contracts/src/presets.ts`): `EXPERIMENT_PRESET_IDS`,
`PRESET_TEST_STYLES`, a `PRESET_REGISTRY` entry (`kinds: ['replacement']`,
limitations covering the controlled-substitution scope, the unavailable
counter-target breadth (PHASE4_HARDENING §10.2, deliberately out of this
bounded slice), and the variant-count floor), and a choice-schema member
mirroring `replacementConfigSchema`'s own fields/defaults
(`baseDeckPreconIds` at `min(1)` — a substitution needs a substrate, not a
comparison pair — `opponentPreconIds` reusing `preconSelection`'s `min(2)`,
`subjectCardId`, `candidateCardIds`, `copies`, `includeInsertion`,
`insertionCopies`, `insertionRemoveCardIds`). Added
`apps/admin-server/src/lab/expand.ts`'s `cardReplacement()` builder — one
stage, since `runReplacementExperiment` already builds every removal and
insertion variant inside one `kind: 'replacement'` configuration — a singular
`requirePoolCard` helper (kept separate from the existing plural
`requirePoolCards` so a scalar field refuses at `subjectCardId`, not a
misleading `subjectCardId.0`), and wired `case 'card_replacement':` into
`expandPreset` with distinct-list checks, pool-membership checks and a
self-comparison refusal. Confirmed `job-runner.ts` calls `runExperiment`
generically with no kind switch, so the new stage needed no runner change.

Focused verification: `packages/admin-contracts/src/presets.test.ts` (34/34
— widened `CHOICES`, the exhaustive knob-name list, the available-preset-
count assertion, and a defaults spot-check), `apps/admin-server/src/lab/
expand.test.ts` (62/62, was 53 — widened `CHOICES`/`SNAPSHOT`, probing the
real estimate once via a throwaway test file (128 matches at `at_least`)
then deleting it, plus 8 new tests: the built config's fields,
`includeInsertion: false`, an explicit candidate/insertion budget, and five
refusal cases) — 96 tests total, all passing.
`insertion.test.ts`/`experiment.test.ts` re-run clean (39/39). `npm run
--workspace @tcg/admin-contracts typecheck` and `--workspace @tcg/admin-server
typecheck`: both clean. `npx eslint` on all four changed files: clean. Marked
M08.20C complete in the milestone file with this evidence note; the M08.20
tranche checklist and root status row are untouched, per CLAUDE.md — both
move only at tranche close.

M08.20D is implemented: a `BuilderScreen.tsx` family for each of the four
templates M08.20A–C exposed a contract for but no UI —
`candidate_comparison`, `pilot_robustness`, `engine_soak`, `card_replacement`
— reusing the existing `Family` radio pattern (`FamilySection`) and the
`family === '<id>'` panel-gating `open_meta` already established, no new
execution engine. New pure form logic in `apps/admin-client/src/lib/
builder-form.ts` (`*Form`/`initial*Form`/`*ChoiceOf`/`*FormFingerprint`/
`*FormOf`, one quartet per template) mirrors `openMetaFormOf`'s existing
two-stage validation: shape checks report field-scoped problems first, then
`presetChoiceSchema.safeParse` catches whatever the shape check missed and a
per-template `*FieldOf` helper maps each Zod issue path back onto the form
field that caused it. `parseIdList`/`idListRaw` give every free-text
card/profile/identifier field (there is no card or profile catalog to build
a checklist from) a comma/newline-splitting, trimming, de-duplicating round
trip. New shared UI (`PreconChecklist`, `PilotChecklist`, `IdListField`,
`CopiesField`, `LimitationsNotice`) factors out what all four templates need
in common, rendering each preset's own `PRESET_REGISTRY[...].summary`/
`.limitations` text verbatim — Engine Soak's limitations notice is exactly
"Engine health, never balance," carried from the registry, and its precon
checklist states there is no pilot control because the preset pins
`random_legal`. `SavedSection` and the reopen path (`openSaved`) widened to
all six families; `openSaved` tries every family's `*FormOf` in sequence and
switches to whichever one accepts the saved choice. `vocabulary.ts` gained
the `card_replacement` label `TEST_STYLE_LABELS` was missing since M08.20C
added the preset without it — a real, if minor, gap closed incidentally
while wiring the family list. No engine, schema, or server change: every
template's `choiceOf` sends the same `presetChoiceSchema` shape M08.20A–C's
server-side `expand.ts` already accepts and refuses exactly as before.

Verified: 22 new tests in `builder-form.test.ts` (52 total, was 30) covering
shape-to-request equivalence, each template's own cardinality refusal beside
its control, fingerprint stability under a label-only change, exact
save-and-reopen round trip (including Candidate Patch Comparison's per-row
patch fields and Card Replacement's insertion controls), and every
`*FormOf` declining a choice for a preset it does not configure.
`builder-flow.test.tsx`'s pre-existing "offers no builder for any other test
style" label list updated (`Engine Soak` is now a real top-level family
rather than an absent one) — full file re-run 37/37, no regression to the
Open Meta or benchmark integration flows. Full `apps/admin-client` suite:
321/321 across 16 files. `npm run --workspace @tcg/admin-client typecheck`
clean; `eslint` clean on all five changed files. Tranche-close gates
(`check:consistency`, `audit:check`, `verify`) and `tcg-reviewer` are
deferred to M08.20E, per this milestone's work-slice split.

Next slice: **M08.20E — Tranche close**, per `IMPLEMENTATION_PLAN.md` and the
M08.20 tranche in `docs/milestones/M08-ai-lab-and-player-meta.md`.
