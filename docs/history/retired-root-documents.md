# Retired root documents

The repository root once held six specification and progress documents, and two
JSON catalogues. They were the handoff format the project ran on before
milestones existed: a specification arrived at the root, a progress log grew
beside it, and both were deleted when the work landed. All of them are gone from
the working tree and all of them are in git history at the commits below.

This page exists because they are still cited by name — an ADR's context
paragraph names the specification it was written against, and that citation is
worth keeping. It says where each document's content lives now, so a reader who
meets one of these names does not have to decide whether they are missing
something.

Nothing here needs to be read to work on the project. The root now holds
`README.md`, `CLAUDE.md` and `IMPLEMENTATION_PLAN.md`, and
`scripts/lib/status-audit.ts` fails the audit if a fourth Markdown file appears
there.

| Document                                      | Retired               | What it was                                                                                                                    | Where its content lives now                                                                                                                                                                                                                          | Still cited by     |
| --------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `PLAYER_HELP_AND_CONTENT_SYSTEM.md`           | `8165dab`, 2026-08-10 | Specification for the player help system and the data-driven content structure behind it.                                      | Built: `packages/help-content`. Recorded: [ADR 0015](../architecture/0015-player-help-and-content.md), `docs/project-status.md`.                                                                                                                     | —                  |
| `READINESS_PROGRESS.md`                       | `8165dab`, 2026-08-10 | Working progress log against the readiness specification; it said to delete it when done.                                      | Superseded by `docs/project-status.md` and the generated `docs/status-audit.md`.                                                                                                                                                                     | —                  |
| `CLAUDE_RULESET_UPDATE.md`                    | `b70abe2`, 2026-08-12 | The Wave 1 rules and precon update: 40-card singleton decks, the 155-card catalogue, and the rules it replaced.                | Built: `content/sets/precon_wave_1`, `packages/rules-engine`. Recorded: [ADR 0016](../architecture/0016-precon-wave-1-ruleset.md), [ADR 0017](../architecture/0017-optional-instructions-and-interactive-costs.md), `docs/rules/confirmed-rules.md`. | ADR 0016, ADR 0017 |
| `CLAUDE_AI_SPECTATOR_AND_RULE_ADJUSTMENTS.md` | `b70abe2`, 2026-08-12 | Rule adjustments (player versus deployed-Commander damage, Reactions, Newly Deployed, Token stacks) and the AI spectator mode. | Built: `apps/simulator` spectate mode, `apps/web-client`. Recorded: ADR 0016, `docs/rules/confirmed-rules.md`, [M06](../milestones/M06-token-presentation.md).                                                                                       | —                  |
| `PRE_CARD_AND_AGENT_TESTING_READINESS.md`     | `b70abe2`, 2026-08-12 | The readiness pass required before the first real card batch was authored and before pilots were used for balance.             | [M01](../milestones/M01-truthfulness-and-verification.md) and [`docs/testing/FIRST_CARD_BATCH_TEST_PLAN.md`](../testing/FIRST_CARD_BATCH_TEST_PLAN.md), which is the protocol Wave 1 actually followed.                                              | ADR 0016           |
| `REMAINING_WORK.md`                           | `b70abe2`, 2026-08-12 | The single backlog list, verified against the code on 2026-08-11.                                                              | Split into `IMPLEMENTATION_PLAN.md` (the queue) and `docs/milestones/` (the bounded specifications).                                                                                                                                                 | —                  |

Two details the git record settles. `REMAINING_WORK.md` says it replaced two
working documents, `RULESET_UPDATE_PROGRESS.md` and `READINESS_PROGRESS.md`; only
the second was ever tracked, so the first cannot be recovered and nothing cites
it. And the monolithic `CLAUDE.md` that M01 replaced is the target of the `§`
references in `docs/project-status.md`'s Phase 1–3 history, which says so at the
top of that section — those section numbers are not in the current `CLAUDE.md`
and are not meant to be.

One historical specification was **not** retired and is still in the tree,
because it is cited by code rather than only by prose:
[`docs/PHASE4_HARDENING.md`](../PHASE4_HARDENING.md), whose contract numbers
appear in comments in `apps/simulator`.

## The two root JSON catalogues

`cards.json` and `precons.json` were the authored Wave 1 design catalogue: 155
cards written flat — id, name, type, faction, colour identity, power label,
identity line, cost, statline, keywords and rules text — and the four precon
decklists with the format they were built to. They were the source the generated
content under `content/` was imported from, and after the import nothing in the
codebase opened either file.

| File           | Retired           | What it was                                                              | Where its content lives now                                                           |
| -------------- | ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `cards.json`   | M07.6, 2026-08-13 | The authored 155-card Wave 1 catalogue, one flat record per card.        | `content/sets/precon_wave_1/` — one validated file per card and per token.            |
| `precons.json` | M07.6, 2026-08-13 | The four Wave 1 decklists and the construction rules they were built to. | `content/precons/` for the decks, `content/formats/precon_wave_1.json` for the rules. |

### The parity measurement the deletion rests on

Deleting them was Q40, and the answer needed a measurement rather than a memory
of a faithful import. `scripts/lib/root-catalog-parity.ts`, added in `8af1d78`
and removed in the same change that deleted the files, read both catalogues,
read the shipped content through the loader the product uses, and compared them
field by field in both directions — mapping the two shapes onto each other
explicitly, since the authored catalogue is flat where a runtime card nests the
designer's labels under `design` and calls the printed text `displayText`.

What it found, at `8af1d78`:

- **155 cards on both sides, 4 precons on both sides.** Nothing existed on one
  side only.
- **Every structural field equal, for every card**: name, type, colour identity,
  cost, attack, health, keywords, collectibility, and all three design labels.
- **Every precon equal**: name, strategy, Commander, the 40 card IDs, and the
  format's deck size, singleton rule and commander-outside-deck rule.
- **Six cards differed in printed rules text, and the root copy was the stale one
  in every case.** `cruel_preacher`, `soul_furnace` and `retaliating_guard` said
  "deal 1 damage to the enemy Commander" where the game deals it to an opponent;
  `dismantle_the_device` said "Destroy the active Relic" where the vocabulary is
  Defeat; `containment_pulse` said "Token stack" where a stack is a drawing
  decision rather than a game object (M06.1); and `chief_containment_scholar`
  stated neither the zone nor the timing its Commander ability actually has.

So the root pair was not a harmless duplicate. It was a second, unread, unlinted
copy of every card's rules text that taught three rules this game does not have,
while `content/` — which every gate does check — said the right thing. That is
the drift the ruleset update warned about, caught in the act.

To reproduce the reading, restore the files and the checker from the commit
before the deletion and run it:

```
git checkout 8af1d78 -- cards.json precons.json scripts/check-root-parity.ts scripts/lib/root-catalog-parity.ts
npx vite-node scripts/check-root-parity.ts
```

The checker went with the files rather than staying as a command that can never
find its input again.
