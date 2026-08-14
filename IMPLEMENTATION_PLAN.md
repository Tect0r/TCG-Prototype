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

| Milestone                                                                                                                                               | Status                | Next tranche |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------ |
| [M01 Truthfulness and verification](docs/milestones/M01-truthfulness-and-verification.md)                                                               | Complete (2026-08-11) | —            |
| [M02 Remaining card mechanics](docs/milestones/M02-remaining-card-mechanics.md)                                                                         | Complete (2026-08-12) | —            |
| [M03 Precon integration](docs/milestones/M03-precon-integration.md)                                                                                     | Complete (2026-08-12) | —            |
| [M04 Shared board telemetry](docs/milestones/M04-shared-board-telemetry.md)                                                                             | Complete (2026-08-12) | —            |
| [M05 AI reliability](docs/milestones/M05-ai-reliability.md)                                                                                             | Complete (2026-08-13) | —            |
| [M06 Token presentation](docs/milestones/M06-token-presentation.md)                                                                                     | Complete (2026-08-13) | —            |
| [M07 Documentation consolidation](docs/milestones/M07-documentation-consolidation.md)                                                                   | Complete (2026-08-14) | —            |
| [M07.8 Final consistency pass](docs/milestones/M07-documentation-consolidation.md#m078--final-consistency-and-playtest-readiness-pass--done-2026-08-14) | Complete (2026-08-14) | —            |
| [M07.9 Card schema version correction](docs/milestones/M07-documentation-consolidation.md#m079--the-card-schema-version-correction--done-2026-08-14)    | Complete (2026-08-14) | —            |

**M07 consistency work is complete.** Every milestone this plan carries is
finished, and no M08 exists yet. M07.8 was a correction pass over M07's output;
M07.9 corrected M07.8 in turn, moving `CARD_SCHEMA_VERSION` to 5 because a new
member of a discriminated union is not something an older build can read.

## The next bounded task

**Run structured manual playtests using the four current 40-card precons.** This
is the next activity, and it is not code: nothing in the record now says what the
game is like to play, and every remaining implementation and content choice
depends on that.

It is deliberately not a framework. Play the decks, write down what happened, and
keep the notes somewhere durable — a large playtest harness is itself a milestone
someone would have to justify, and justifying it needs the evidence below.

What the playtests should capture, per session:

1. **Functional defects** — anything the engine does that the rules say it should
   not, with the cards and the board state that produced it.
2. **Confusing interactions** — a resolution that was legal and surprising. The
   card text, what the player expected, and what happened.
3. **Rules friction** — a rule that had to be looked up, argued about, or
   remembered rather than read off the table.
4. **Match duration** — wall-clock time and turn count per match, and where the
   long turns were.
5. **Obvious archetype problems** — a precon that cannot function, a matchup that
   is not a game, a deck whose plan never assembles.

**Then evaluate the results before selecting the next milestone.** The evidence
decides whether the next milestone is implementation (a defect class worth fixing
properly), rules (a friction point that needs an owner decision), or content.

The **50-card expansion remains the next intended content milestone**: 8–9 further
colour-legal cards per Commander, or an equivalent shared package, measured
against colour-legal pools of 42/41/41/42. It is **not started**, and it should
not start before the playtests, because authoring 32–36 cards against an untested
40-card baseline would be guessing at what the decks need.

The questions under [Owner decisions still open](#owner-decisions-still-open) are
the other thing the implementation is waiting on, and playing the decks is the
cheapest way to find out which of them actually matter. `docs/open-questions.md`
holds every other question the project has recorded. Adding a milestone file under
`docs/milestones/` and a row in the table above is what starts the next milestone.

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

- 40-card singleton Wave 1 decks; Commander outside the deck. Confirmed by the
  owner on 2026-08-14 as the **first-playtest scope**, with a 50-card target kept
  for later and blocked on content — each Commander's colour-legal pool is 41–42
  cards, so 50 needs 8–9 more per Commander. Do not move the format's `deck.size`
  without that content.
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

## Completion evidence for every tranche

- Exact behavior and data/schema changes.
- Focused regression tests.
- Help, pilot, telemetry, replay/hash, protocol, and authoring coverage when the
  mechanic touches them.
- `npm run verify` passing. It covers the root `tsconfig.json` since M01.5;
  nothing needs to be run separately.
- No newly stale player-facing text. Since M07.7 this is checked rather than
  remembered: `npm run check:consistency` reports retired rule vocabulary,
  broken links and anchors, path references to files that do not exist, and any
  documented value that no longer matches the constant or registry it copies.
  M07.8 added three more — an inert mechanic in a playable set, card prose that
  disagrees with its structured targets about who an effect reaches, and a
  question this plan calls open that `docs/open-questions.md` has answered or has
  no record of. It runs inside the suite, so `npm run verify` already covers it.
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
