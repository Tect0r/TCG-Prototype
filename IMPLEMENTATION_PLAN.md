# Implementation plan

This is the small durable queue, not a session log. Finished implementation
detail belongs in Git and the canonical milestone record. Claude must use
`npm run work:current` to locate ordinary work; it must not read this whole file
at session start.

## Execution rule

Complete exactly one unit returned by `npm run work:current`, then stop. The
command validates `.claude/current-task.json` and prints only the matching
section of its milestone file. Code and passing tests outrank documentation.

A normal implementation unit ends with focused semantic checks and a coherent
checkpoint commit. It may update only its own checklist/evidence and replace the
current-task cursor. Tranche acceptance, full gates, the root status and Opus
review belong only to a named tranche-close unit.

Never append session narratives here or to the cursor. Git commits, tests and
the milestone checklist are the history.

## Status

| Milestone                                                                   | Status                | Active work |
| --------------------------------------------------------------------------- | --------------------- | ----------- |
| [M08 AI Lab and Player Meta](docs/milestones/M08-ai-lab-and-player-meta.md) | Complete (2026-09-16) | —           |
| [M09 Play Against AI](docs/milestones/M09-play-against-ai.md)               | Complete (2026-08-21) | —           |

Earlier milestone status and completed-scope summaries live in
[`docs/project-status.md`](docs/project-status.md) and
[`docs/history/milestone-log.md`](docs/history/milestone-log.md).

## Active correction queue

The full acceptance text is in
[`docs/milestones/M08.5_FINAL_CORRECTION_PASS.md`](docs/milestones/M08.5_FINAL_CORRECTION_PASS.md).
Rows carry state only; do not add implementation narratives.

| Unit                          | State    |
| ----------------------------- | -------- |
| M08.R1–R2 + Tranche A review  | Complete |
| M08.R3                        | Complete |
| M08.R4                        | Complete |
| M08.R5                        | Complete |
| M08.R6–R7 + Tranche B review  | Complete |
| M08.R8–R10 + Tranche C review | Complete |
| M08.R11–R14 + Tranche D close | Complete |

### Current blocking decision

None. M08, including the M08.5 correction pass (M08.R1–R14), is complete.
`tcg-reviewer`'s first review of the M08.R11–R14 commit range plus the
close-record diff returned `VERDICT: CHANGES REQUIRED`: one BLOCKER
(M08.R11's stale-lock takeover used an unconditional `rm` that could destroy
a different, already-live lock a faster contender had just published) and two
LOW findings (`artifacts.ts`'s `sizeOf()` collapsing every read-refusal
reason into the same `null` an absent artifact produces; a silent-skip branch
in `job-runner-adaptive.test.ts`). The BLOCKER was fixed (`lock.ts`'s
stale-lock clear is now a verified `rename`-based claim with
restore-on-mismatch, backed by a new deterministic regression test); the two
LOWs were deferred as follow-up work (see below) since the `artifacts.ts` fix
reaches a shared, `z.strictObject` public contract schema
(`resultArtifactListingSchema`) also consumed by `admin-client`, and the
test-robustness finding is independent of the BLOCKER. `tcg-reviewer`
rechecked the fix and returned `VERDICT: APPROVE`, with one MEDIUM (this
record must not cite a final SHA the close commit itself would make stale —
resolved by deferring that citation to a follow-up audit-record-only commit)
and one LOW (a doc comment on `claimStaleRecord` understated a narrow
three-contender residual window — fixed, comment-only). The tranche-close
commit (SHA `2c4ca59a6fa69dfb227666db5890cc482a0fc4b4`) is pushed and its
GitHub Actions run is green
(<https://github.com/Tect0r/TCG-Prototype/actions/runs/35120617309>). This
audit-record-only commit names that SHA and marks Tranche D and M08 complete.
See the milestone's
[Correction Tranche D](docs/milestones/M08-ai-lab-and-player-meta.md) section
for the full review record.

## Where the record lives

| Question                                       | Document                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| What is Claude doing now?                      | `.claude/current-task.json` via `npm run work:current`           |
| What is the active unit's acceptance boundary? | [`docs/milestones/`](docs/milestones/)                           |
| What code changed and why?                     | Git commits and focused tests                                    |
| What rule is settled and implemented?          | [`docs/rules/confirmed-rules.md`](docs/rules/confirmed-rules.md) |
| What is implemented but provisional?           | [`docs/rules/open-decisions.md`](docs/rules/open-decisions.md)   |
| What has no answer yet?                        | [`docs/open-questions.md`](docs/open-questions.md)               |
| What are the generated facts?                  | [`docs/status-audit.md`](docs/status-audit.md)                   |
| Why is the architecture this way?              | [`docs/architecture/`](docs/architecture/)                       |

## Locked decisions

Do not reopen these while implementing:

- The player-facing format and gameplay rules in `CLAUDE.md`.
- M08's interpretation and exclusions in
  [the M08 milestone](docs/milestones/M08-ai-lab-and-player-meta.md#locked-interpretation)
  and [ADR 0023](docs/architecture/0023-admin-lab-boundary.md).
- M09's bot-seat, information, deck-source and pacing boundaries in
  [the M09 milestone](docs/milestones/M09-play-against-ai.md#locked-interpretation)
  and [ADR 0024](docs/architecture/0024-live-bot-seats.md).
- Simulator rules, scheduling, legality, aggregation and report meaning stay
  authoritative. The admin layer must not duplicate them.
- Canonical experiment directories remain the source of truth. The catalog may
  index and annotate them but may not replace them.

## Owner decisions still open

Q4, Q44, Q45, Q46 and Q51 were the standing short list; the owner ruled on all
five, and on every other open question the project had recorded, on 2026-09-11.
Full rulings are in [`docs/open-questions.md`](docs/open-questions.md#answered).
Q50 is discharged: Hard is published. Q53 (pilot selection and per-match turn
limits) was answered and implemented in M08.R4. Several rulings still need
follow-up code or content work — see below.

### Follow-up work unblocked by the 2026-09-11 rulings

Recorded so it is not lost; none of it is scoped as a slice yet. Pick these up
as their own isolated changes or fold one into the milestone that next touches
its area — do not treat this list itself as a tranche.

- **Q4 — delete `resilient`.** Remove it from `KEYWORD_IDS` and the mechanic
  support registry, and fix up the `dread_sovereign` `prototype_core` fixture
  that prints it (the only card that does). Touches the keyword registry,
  glossary, `lintDisplayText` coverage and its tests.
- **Q18 — promote `card_data/token_color_leak` from warning to error** in
  `loader.ts`. The bundled sets already comply; expected to be a small,
  low-risk change.
- **Q8 — add configurable Main/choice and Reaction timers** (~30s / ~5s):
  server + engine work, needs a design pass on exactly where the timeout
  action is submitted from.
- **Q34 — pause the disconnect grace window** while the match is not waiting on
  the disconnected seat, instead of running it on wall clock regardless of
  turn. Related to Q8 and likely shares implementation.
- **Q35 — give three/four-player matches their own `RulesConfig` profile**,
  distinct from the 1v1 defaults, labelled explicitly unbalanced until measured.
- **Q52 — fix `pilotSpecSchema`'s override-map defaults** so absent `weights`
  and present-but-empty `weights` agree, then invalidate and rerun the
  `robustness` experiment arms the defect touched.
- **Q19 — author more colour-legal cards per Commander** (target ~65, not the
  8–9 that only closed raw legality) before `deck.size` can move to 50.
- **Q17 — write the colour-pie flavour/lore text** (White/Blue/Black/Red/Green
  identities the owner named) into player-facing docs; no engine change.
- **Q22 — restate the art-size doc as a 3:4 ratio contract** (prefer
  1536×2048+, 768×1024 is the floor) rather than one fixed resolution.
- **M08.R14 review LOW — distinguish artifact-read refusal reasons.**
  `artifacts.ts`'s `sizeOf()` collapses every `openArtifactFile` refusal
  (absent, unsafe, unreadable) into the same `null` an absent artifact
  produces, so `ArtifactReader.list()`'s `present`/`byteLength` fields cannot
  tell a reader "something suspicious is here" apart from "the run never
  wrote this." Fixing it changes `resultArtifactListingSchema`
  (`packages/admin-contracts/src/artifacts.ts`), a shared
  `z.strictObject` also consumed by `admin-client`'s `fake-service.ts` —
  needs a coordinated cross-package change, not a same-tranche patch.
- **M08.R14 review LOW — assert instead of silently skip in
  `job-runner-adaptive.test.ts`.** Its "paused exactly before final result
  publication" test can silently skip exercising the resume/durability
  property it names if the terminal checkpoint state is never observed, with
  no assertion failure signaling the skip. Test-robustness fix, independent
  of any product behavior.

## Completion evidence for every tranche

- Exact behavior, contract and version changes are recorded in the milestone.
- Focused semantic regression tests cover introduced or corrected behavior.
- Privacy, provenance, determinism, path, restart and compatibility boundaries
  are verified whenever touched.
- `npm run check:consistency`, `npm run audit:check` and `npm run verify` pass in
  the tranche-close run.
- `docs/status-audit.md` is regenerated with `npm run audit:status` only when
  counted facts changed.
- Opus approves the bounded tranche diff before the tranche is marked complete.

## Global stop conditions

Stop rather than widen scope when:

- a rule choice changes gameplay or product policy;
- current code contradicts the active acceptance boundary;
- a migration lacks a defined compatibility policy;
- hidden information would cross an observation or bundle boundary;
- unrelated local changes overlap required files;
- the current unit is blocked. Never jump to a later unit.
