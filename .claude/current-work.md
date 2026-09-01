# Current work

M08.16A is implemented: the strict adaptive config surface, policy enums and
bounds, raw/checkpoint/result envelopes, and readable current/future-version
refusal, in `apps/simulator/src/adaptive/{version,config,envelopes}.ts`, wired
into the simulator's barrel export. 67 focused tests across three new test
files pass and `apps/simulator` typechecks clean. Tranche-close gates
(`check:consistency`, `audit:check`, `verify`) and `tcg-reviewer` are deferred
to M08.16D, per this milestone's work-slice split.

Current unit: **M08.16B — Immutable revision lineage**
([scope](../docs/milestones/M08-ai-lab-and-player-meta.md#m0816--adaptive-counter-schema-and-deck-lineage));
implement exactly this slice, run its focused checks, commit and stop. Do not
start M08.16C in the same session.
