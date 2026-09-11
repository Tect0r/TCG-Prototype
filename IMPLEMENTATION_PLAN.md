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

| Milestone                                                                   | Status                                        | Active work    |
| --------------------------------------------------------------------------- | --------------------------------------------- | -------------- |
| [M08 AI Lab and Player Meta](docs/milestones/M08-ai-lab-and-player-meta.md) | Complete (2026-09-10); correction pass active | M08.R4 blocked |
| [M09 Play Against AI](docs/milestones/M09-play-against-ai.md)               | Complete (2026-08-21)                         | —              |

Earlier milestone status and completed-scope summaries live in
[`docs/project-status.md`](docs/project-status.md) and
[`docs/history/milestone-log.md`](docs/history/milestone-log.md).

## Active correction queue

The full acceptance text is in
[`docs/milestones/M08.5_FINAL_CORRECTION_PASS.md`](docs/milestones/M08.5_FINAL_CORRECTION_PASS.md).
Rows carry state only; do not add implementation narratives.

| Unit                          | State                           |
| ----------------------------- | ------------------------------- |
| M08.R1–R2 + Tranche A review  | Complete                        |
| M08.R3                        | Complete                        |
| M08.R4                        | Blocked after tested groundwork |
| M08.R5–R7 + Tranche B review  | Pending                         |
| M08.R8–R10 + Tranche C review | Pending                         |
| M08.R11–R14                   | Pending                         |

### Current blocking decision

M08.R4 is blocked on Q53 — see
[`docs/open-questions.md`](docs/open-questions.md#q53-how-do-adaptive-jobs-receive-pilot-selection-and-per-match-turn-limits)
and "Owner decisions still open" below for the full write-up.

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
Q50 is discharged: Hard is published. Several rulings still need follow-up code
or content work — see below.

- Q53: how adaptive jobs receive pilot selection and per-match turn limits.
  `runAdaptiveExperiment` requires both and `AdaptiveConfig` carries neither;
  M08.R4 cannot dispatch to it without this decision. Full write-up in
  [`docs/open-questions.md`](docs/open-questions.md#q53-how-do-adaptive-jobs-receive-pilot-selection-and-per-match-turn-limits).

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
