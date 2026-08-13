# Implementation plan

The only root work queue. It names the next bounded task, the decisions that may
not be reopened while doing it, and the conditions that stop it — and nothing
else. The record of finished work lives in the documents under
[Where the record lives](#where-the-record-lives). Code and passing tests outrank
anything written here.

Baseline audited: `Tect0r/TCG-Prototype` `d49529b` on 2026-08-11. Everything below
has moved since; compare a status with the current branch before relying on it.

## Execution rule

Work on exactly one tranche named by the user. Read only this file, `CLAUDE.md`,
the active milestone file, and the code and documents that tranche directly
references. After verification, update the status table and the tranche's
checklist in the milestone file, then stop.

## Status

| Milestone                                                                                 | Status                | Next tranche |
| ----------------------------------------------------------------------------------------- | --------------------- | ------------ |
| [M01 Truthfulness and verification](docs/milestones/M01-truthfulness-and-verification.md) | Complete (2026-08-11) | —            |
| [M02 Remaining card mechanics](docs/milestones/M02-remaining-card-mechanics.md)           | Complete (2026-08-12) | —            |
| [M03 Precon integration](docs/milestones/M03-precon-integration.md)                       | Complete (2026-08-12) | —            |
| [M04 Shared board telemetry](docs/milestones/M04-shared-board-telemetry.md)               | Complete (2026-08-12) | —            |
| [M05 AI reliability](docs/milestones/M05-ai-reliability.md)                               | Complete (2026-08-13) | —            |
| [M06 Token presentation](docs/milestones/M06-token-presentation.md)                       | Complete (2026-08-13) | —            |
| [M07 Documentation consolidation](docs/milestones/M07-documentation-consolidation.md)     | M07.1–M07.5 done      | **M07.6**    |

## Where the record lives

No finished work is described twice. Each question below has exactly one document
that answers it.

| Question                                       | Document                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| What rule is settled and implemented?          | [`docs/rules/confirmed-rules.md`](docs/rules/confirmed-rules.md)                                        |
| What is implemented but provisional?           | [`docs/rules/open-decisions.md`](docs/rules/open-decisions.md)                                          |
| What has no answer yet?                        | [`docs/open-questions.md`](docs/open-questions.md)                                                      |
| How many cards, which versions, what coverage? | [`docs/status-audit.md`](docs/status-audit.md) — generated, and stale means a failing test              |
| What did each milestone make true?             | [`docs/project-status.md`](docs/project-status.md)                                                      |
| What was a tranche's scope, and its checklist? | [`docs/milestones/`](docs/milestones/)                                                                  |
| Why is the architecture the way it is?         | [`docs/architecture/`](docs/architecture/)                                                              |
| What did a tranche say when it landed?         | [`docs/history/milestone-log.md`](docs/history/milestone-log.md) — frozen, superseded by the rows above |

## Locked decisions

Do not reopen these while implementing:

- 40-card singleton Wave 1 decks; Commander outside the deck.
- Unlimited Units; one active Relic.
- Commander defeat returns it immediately to the Command Zone and raises its
  total deployment cost by 1, capped at 10.
- Newly Deployed duration/blocking/Rush behavior in `CLAUDE.md`.
- Player versus deployed-Commander targeting distinction.
- Current-Health Overwhelm split before Barrier prevention.
- Bounded Reaction windows with one Reaction per eligible player.
- `deployed` and `entersBattlefield` remain separate and are reviewed per card.

## Owner decisions still open

Only stop on these when the active tranche genuinely needs the answer.
`docs/open-questions.md` holds the full write-up of each, and every other open
question the project has recorded.

- Q4: implement or remove `resilient`. M05.1 answered the content half — it is
  now a build error in a `playtest`/`active` set, derived from the mechanic
  support registry — and M05.2 answered the bot half: no pilot pays anything for
  it anywhere. Deleting it from `KEYWORD_IDS` or implementing one of the two
  readings is still yours, and is now the only part left.
- Q44: multiple blockers per attacker.
- Q45: Barrier ordering against future prevention/reduction effects.
- Q46: whether Reactions may carry interactive additional costs.
- Q48: whether five Goblin cards that print "enters the battlefield" should be
  reworded to "when deployed" or rewired to `on_entered_battlefield`. They are
  authored as implicit deploy effects, so a `goblin_recruiter` revived by
  `grave_reassembly` creates no Token. Rewording changes nothing about the game;
  rewiring hands the Goblin deck a revival payoff, which is a gameplay change.
  Raised by M02.6's entry-trigger review, deliberately not decided by it.
- Q47: whether a Reaction may answer another Reaction. The engine allows it —
  a play clears `passedPlayerIds`, so a player who has not yet acted in the
  window may counter the counter, and `reactions.test.ts` asserts exactly that.
  `CLAUDE.md`'s product rules say it may not. One of the two is wrong; the
  rulebook currently describes the engine. Raised by M01.4, not decided by it,
  and written up in full in `docs/open-questions.md` by M07.2 — both directions
  of the fix and what each one costs.

## Completion evidence for every tranche

- Exact behavior and data/schema changes.
- Focused regression tests.
- Help, pilot, telemetry, replay/hash, protocol, and authoring coverage when the
  mechanic touches them.
- `npm run verify` passing. It covers the root `tsconfig.json` since M01.5;
  nothing needs to be run separately.
- No newly stale player-facing text.
- `docs/status-audit.md` regenerated with `npm run audit:status` when the tranche
  changed anything it counts. Since M07.1 the suite fails until it is, so this is
  a reminder of the command rather than a duty to remember the numbers.
- Status table and milestone checklist updated in the same change.

## Global stop conditions

Stop rather than widen scope when:

- a rule choice changes gameplay rather than implementation detail;
- current code contradicts the milestone baseline;
- a schema migration could invalidate saved/replay data without a defined policy;
- hidden information would cross an existing observation/view boundary;
- unrelated local changes overlap the required files.
