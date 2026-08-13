# Retired root documents

The repository root once held six specification and progress documents. They
were the handoff format the project ran on before milestones existed: a
specification arrived at the root, a progress log grew beside it, and both were
deleted when the work landed. All six are gone from the working tree and all six
are in git history at the commits below.

This page exists because they are still cited by name — an ADR's context
paragraph names the specification it was written against, and that citation is
worth keeping. It says where each document's content lives now, so a reader who
meets one of these names does not have to decide whether they are missing
something.

Nothing here needs to be read to work on the project. The root now holds
`README.md`, `CLAUDE.md` and `IMPLEMENTATION_PLAN.md`, and
`scripts/lib/status-audit.ts` fails the audit if a fourth Markdown file appears
there.

| Document                                      | Retired               | What it was                                                                                                                    | Where its content lives now                                                                                                                                                                                                                          | Still cited by                        |
| --------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `PLAYER_HELP_AND_CONTENT_SYSTEM.md`           | `8165dab`, 2026-08-10 | Specification for the player help system and the data-driven content structure behind it.                                      | Built: `packages/help-content`. Recorded: [ADR 0015](../architecture/0015-player-help-and-content.md), `docs/project-status.md`.                                                                                                                     | —                                     |
| `READINESS_PROGRESS.md`                       | `8165dab`, 2026-08-10 | Working progress log against the readiness specification; it said to delete it when done.                                      | Superseded by `docs/project-status.md` and the generated `docs/status-audit.md`.                                                                                                                                                                     | —                                     |
| `CLAUDE_RULESET_UPDATE.md`                    | `b70abe2`, 2026-08-12 | The Wave 1 rules and precon update: 40-card singleton decks, the 155-card catalogue, and the rules it replaced.                | Built: `content/sets/precon_wave_1`, `packages/rules-engine`. Recorded: [ADR 0016](../architecture/0016-precon-wave-1-ruleset.md), [ADR 0017](../architecture/0017-optional-instructions-and-interactive-costs.md), `docs/rules/confirmed-rules.md`. | ADR 0016, ADR 0017, root `cards.json` |
| `CLAUDE_AI_SPECTATOR_AND_RULE_ADJUSTMENTS.md` | `b70abe2`, 2026-08-12 | Rule adjustments (player versus deployed-Commander damage, Reactions, Newly Deployed, Token stacks) and the AI spectator mode. | Built: `apps/simulator` spectate mode, `apps/web-client`. Recorded: ADR 0016, `docs/rules/confirmed-rules.md`, [M06](../milestones/M06-token-presentation.md).                                                                                       | —                                     |
| `PRE_CARD_AND_AGENT_TESTING_READINESS.md`     | `b70abe2`, 2026-08-12 | The readiness pass required before the first real card batch was authored and before pilots were used for balance.             | [M01](../milestones/M01-truthfulness-and-verification.md) and [`docs/testing/FIRST_CARD_BATCH_TEST_PLAN.md`](../testing/FIRST_CARD_BATCH_TEST_PLAN.md), which is the protocol Wave 1 actually followed.                                              | ADR 0016                              |
| `REMAINING_WORK.md`                           | `b70abe2`, 2026-08-12 | The single backlog list, verified against the code on 2026-08-11.                                                              | Split into `IMPLEMENTATION_PLAN.md` (the queue) and `docs/milestones/` (the bounded specifications).                                                                                                                                                 | —                                     |

Two details the git record settles. `REMAINING_WORK.md` says it replaced two
working documents, `RULESET_UPDATE_PROGRESS.md` and `READINESS_PROGRESS.md`; only
the second was ever tracked, so the first cannot be recovered and nothing cites
it. And the monolithic `CLAUDE.md` that M01 replaced is the target of the `§`
references in `docs/project-status.md`'s Phase 1–3 history, which says so at the
top of that section — those section numbers are not in the current `CLAUDE.md`
and are not meant to be.

Two historical specifications were **not** retired and are still in the tree,
because they are cited by code rather than only by prose:
[`docs/PHASE4_HARDENING.md`](../PHASE4_HARDENING.md), whose contract numbers
appear in comments in `apps/simulator`, and the tracked root `cards.json` /
`precons.json` design records, whose future is M07.6.
