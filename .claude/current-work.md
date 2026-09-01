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

Current unit: **M08.16D — Tranche close**
([scope](../docs/milestones/M08-ai-lab-and-player-meta.md#m0816--adaptive-counter-schema-and-deck-lineage));
revalidate the combined M08.16 tranche diff, run the tranche-close gates
(`check:consistency`, `audit:check`, `verify`), update the tranche checklist
and root status row only where the evidence supports it, then request
`tcg-reviewer`. Do not start M08.17 in the same session.
