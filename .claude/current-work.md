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

Current unit: **M08.17A — Mirrored block scheduler and budget**
([scope](../docs/milestones/M08-ai-lab-and-player-meta.md#m0817--adaptive-evaluation-and-promotion-loop)).
Make the mirrored evaluation block the decision unit, define deterministic
tie/no-decision behavior, and schedule only whole work that fits the declared
learning budget, recording an explained shortfall instead of silently
overspending. Not started.
