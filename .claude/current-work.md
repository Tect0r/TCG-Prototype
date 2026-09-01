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

Current unit: **M08.16C — Deterministic legal candidate generation**
([scope](../docs/milestones/M08-ai-lab-and-player-meta.md#m0816--adaptive-counter-schema-and-deck-lineage));
implement exactly this slice, run its focused checks, commit and stop. Do not
start M08.16D in the same session.
