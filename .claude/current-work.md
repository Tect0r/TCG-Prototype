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

Current unit: **M08.17D — Tranche close**
([scope](../docs/milestones/M08-ai-lab-and-player-meta.md#m0817--adaptive-evaluation-and-promotion-loop)).
Not started.
