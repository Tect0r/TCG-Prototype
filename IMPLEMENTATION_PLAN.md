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
| [M08 AI Lab and Player Meta](docs/milestones/M08-ai-lab-and-player-meta.md)                                                                             | Deferred (2026-08-14) | M08.1        |
| [M09 Play Against AI](docs/milestones/M09-play-against-ai.md)                                                                                           | In progress           | M09.12       |

**M08 is deferred and M09 is open.** M08.0 opened the AI Lab milestone — its
record, its scope and [ADR 0023](docs/architecture/0023-admin-lab-boundary.md) —
and stopped there. The owner then chose **M09 Play Against AI** to run first,
because it turns the software into something a person can play against, which is
what the structured manual playtests below have been waiting for. M08 is planned,
not cancelled: its record and its ADR stay exactly as M08.0 left them, and no
part of it is scaffolded while M09 is open.

M09.0 opened M09 the same way: the milestone record, the scope and
[ADR 0024](docs/architecture/0024-live-bot-seats.md), with no runtime behaviour
changed. M09.1 added the contract those decisions describe — `@tcg/bot-config`,
a schema-only package holding controller metadata, the difficulty and style
registries, the four-member deck-source union, pacing, and the two privacy
projections — and nothing that acts on it. M09.2 put that contract on the wire:
four host-only messages, a seat view that is now a discriminated union on
`controller`, seven named refusals, and `PROTOCOL_VERSION` 6 → 7, with the server
still not acting on any of it. M09.3 made the authoritative lobby act: `Seat` is
now a union whose bot half has no connection identity **by type**, the four
messages are handled host-only and before start only, seats are allocated
deterministically without ever evicting a human, and a deck mode or difficulty
this build cannot honour is refused by name from `DECK_MODE_SUPPORT` and the
difficulty registry. A configured precon bot is ready and startable.

M09.4 made it play. `BotRunner` builds one pilot and one seat-derived RNG stream
per bot seat at match start, and an idempotent `wake()` after every accepted
action offers each bot the chance to act. Each turn of the loop rebuilds that
seat's redacted observation and the engine's legal actions **at decision time**,
asks `decideSafely`, discards the answer if the board moved while the pilot was
thinking, and submits through the same `applyAction` path and the same
`appliedActions` identity map a human uses. A bot is only asked when the engine
is actually offering it something — `canConcede` is not a decision — which is
what contains the M09.0 finding without ever letting a live bot concede.

**M09.5 reached the milestone's first playable checkpoint.** A person can create
a lobby, seat a bot on a shipped precon at a chosen style, submit their own deck,
ready up, and play a complete match against the software. The host's controls are
host-only, exactly as the wire is; the bot seat is labelled with its controller,
deck, Commander, difficulty, style and readiness, all read from the public
projection that has no card list to leak; and every option this build cannot
honour — the three other deck modes, Easy, Hard, pacing, reroll — is **absent
rather than disabled**, derived from the registries that own it rather than from
a list in the screen. The board and the result are untouched: a bot renders as an
ordinary opponent. What is usable is exactly the checkpoint table's promise —
one human, one bot, `exact_precon`, Normal, instant — and nothing after it was
started.

**M09.6 added the second deck mode.** A host can now put one of their **own
saved decks** on a bot: the contents are frozen at the moment they choose it,
sent privately as bot configuration, and validated by the same `validateDeck`
call a person's `submit_deck` gets, against the same pool — a test drives one
illegal deck down both routes and requires the same wording out of each. The
freeze is structural rather than promised: the server materialises its own deck
from the list it receives, so editing the source afterwards changes the builder's
deck and nothing else, and the panel says so and offers to re-freeze rather than
doing it quietly. The tranche also settled the privacy question M09.3 left open —
a saved deck's **name and fingerprint stay private**, because a precon's name
reveals nothing while a saved deck's is the only handle onto a list nobody else
may see. Every seat gets the Commander and the legality verdict; the host gets
the name, the card count and the fingerprint from their own configuration. No
message shape changed: `botDeckSnapshotSchema` has been on the wire since M09.2,
so `PROTOCOL_VERSION` stays 7 and turning the mode on refused no build.

**M09.7 opened the table, and reached the milestone's second checkpoint.** Every
two-to-four-seat mixture with at least one human now plays: one to three bots,
people in the rest. The ceiling is `MAX_BOT_SEATS`, one fewer than the table
holds, and it is a second lock rather than the only one — a bot is never offered
the seat the lobby takes its host from, and a lobby whose last _person_ leaves is
closed and its bots discarded. Several bots eligible at once are asked one after
another inside a single pump, which is what makes a duplicated decision
structurally impossible rather than merely absent; every committed action carries
a per-seat identity that cannot collide across seats. Elimination, Reaction
priority, disconnect, reconnect and the last living player are what they were,
and each is asserted by playing a real mixed match rather than against a fixture.
A bot never becomes host: there is no host migration in the human rules, and
M09.7 adds none. Order independence is proven at the boundary it is promised for
— the runner's own callbacks — by playing one match with seven extra microtask
turns per yield and getting an identical result. The host's screen gained one
seat-named form per bot and serialises its mutations, which bounds the
"sent, waiting" inference M09.5 and M09.6 both recorded. No shape changed:
`MAX_BOT_SEATS` is derived from `MAX_SEATS` on both sides and is on no wire, so
`PROTOCOL_VERSION` stays 7.

**M09.8 extracted the generator, and proved the extraction changed nothing.**
`@tcg/deck-generator` now owns the deterministic legal draw, the deck value and
its legality check, deck plan resolution, and the content address a deck is named
by; `apps/simulator/src/deck-search/` is now exactly the search — mutation,
crossover, fitness, populations, checkpoints — and imports the generator like any
other caller. The input shrank from the simulator's whole `Environment` to the
five fields the draw reads, which the simulator's `Environment` satisfies
structurally, so no call site had to be adapted; a caller with no simulator gets a
**format-scoped** pool from `generationEnvironmentForFormat`, which throws on an
unknown format rather than falling back to the bundled universe. Equivalence is a
check rather than a claim: ten results recorded from the pre-move code — seven
decks across the real Wave 1 pool, a stratified population, and two from the
simulator's own fixture environment — are replayed through both the package's
environment and a full simulator `Environment`, digested over the whole result so
a moved label or diagnostic fails alongside a moved card. The generator now also
reports what the format left it — 42/41/41/42 legal cards against a 40-card deck
is a forced-inclusion floor of 38/39/39/38 — and names its fifteen problem codes
as a closed set that a source scan keeps complete. The `node:crypto` question was
answered rather than deferred: the package declares itself **server-only**, in
constants a test checks against its own sources, because the portable alternative
would need a second hash implementation and that is how one seed comes to name two
decks. `DECK_GENERATOR_VERSION` is new and is `'1'`; nothing else moved, and no
lobby deck mode was added.

**M09.9 let the host choose the Commander, and the server build the deck.** A
host picks one of the **active format's** playable Commanders — the list
`playableCommanders` returns, which is the rule `validateDeck` already had,
extracted so that the option a screen offers and the refusal a server gives
cannot drift apart — and the server generates a legal deck under it from the
host's seed, freezes it, and records the generator version, construction mode,
seed, reroll count, Commander, content hash and pool report. Rerolling before the
match starts is one deterministic step along that seat's own stream: no seed
travels, the count is the server's, and the transition n → n+1 is reproducible
from the two values the provenance already carries. Privacy is split the way
ADR 0024 §3 requires — the Commander is public, the seed reaches the **host
alone**, and the whole list is broadcast to **every** seat once the match is over,
where the board renders it beside the result and offers it as a file. The
forced-inclusion warning is arithmetic rather than prose: 41 legal cards for a
40-card deck is a floor of 39, so a reroll changes at most two, and the screen
says so instead of implying variety the content cannot supply. Two new server
messages carry what a `LobbyView` cannot, so `PROTOCOL_VERSION` moves 7 → 8 —
and ADR 0024 §7, which had predicted the constant would move exactly once in M09,
now records the correction rather than the guess.

## The next bounded task

**M09.12 — Server bot-delay scheduler.** Make live bots wait for the fraction
M09.11 configured, safely: classify each opportunity as ordinary, pending choice
or Reaction from structured state and view data; schedule from the applicable
budget and percentage using an injectable monotonic clock; at expiry rebuild the
current observation and legal actions and decide **then**, never storing a chosen
action during the wait; cancel obsolete work on sequence or eligibility change,
reconfiguration, bot removal, a human action where applicable, elimination and
match end; run independent bot delays concurrently where the engine permits
independent choices; record intended and actual delay without feeding clock
values into pilot RNG or engine state. The simulator and Spectator stay
delay-free. The scope and the checklist are in
[the M09 milestone file](docs/milestones/M09-play-against-ai.md#m0912--server-bot-delay-scheduler).

**M09.11 configured the timing without spending it.** A table now has two bot
pacing budgets — 30 seconds for a decision or a choice, 5 for a Reaction window —
and every bot has an integer percentage of them with an advanced Reaction
override, where `null` means inherit and `0` means answer instantly, because
those are different configurations and one number could not hold both. The
budgets are the **table's** and the percentage is the **bot's**: they travel in
two places on the wire, so moving one cannot silently move the other, and a
percentage is printed with the seconds it implies from the same `botDelayMs` the
scheduler will call rather than from arithmetic in a screen. The seconds are
exact — 100% of 30 seconds is 29.75, because a quarter-second of every budget is
kept for deciding and submitting — and they are public, because a bot's timing is
observable with a stopwatch and a percentage without its budget is unreadable.
The settings lock at match start into a frozen record the lobby view publishes
from then on, which is what lets the board quote them beside the result; a test
mutates the live record by hand afterwards and requires the published one not to
move. **Nothing waits yet**, and both the panel and the summary say so — a bot at
100% still acts inside the same wake and schedules no timer, which a test asserts
rather than the exclusion merely promising. Two shapes moved, so
`PROTOCOL_VERSION` is 8 → 9; `PACING_CONFIG_VERSION` deliberately stays 1,
because M09.1 wrote the shape and the calculation and this tranche only put them
on a wire; and `RULES_VERSION` stays `0.4.0` because a bot waiting is not a rules
change, with Q8 asserted still open against `docs/open-questions.md`.

**M09.10 reached the milestone's third checkpoint: all four deck modes.** A bot
can now choose its **own** Commander and build its own deck. The choice is drawn
from a stream of its own — the generation seed with a `:commander` suffix, so the
Commander and the cards are two streams rather than two reads of one cursor — over
exactly the `playableCommanders` list a host is offered, so a bot cannot bring
something a host could not. "No secret counterpicking" is a property of the
signature rather than a promise about the body: `selectBotCommander(candidates,
seed)` has no third parameter, so a lobby, a seat, an opponent's hand and an
opponent's saved deck are unreachable from the function that chooses; and the test
seats one seed against two deliberately different opponents, after the server has
already validated and stored both of their decks, and requires an identical
**deck hash** rather than only an identical Commander. Everything after the choice
is the path M09.9 built — same generator, same pool, same refusals, same frozen
`SavedDeck`, same provenance — so a seed and a Commander name one deck whichever
mode produced it, which a test checks by building the pair both ways. The
Commander is public, the seed reaches the host alone, and the list is broadcast to
every seat once the match ends, carrying the mode so a reader can say the bot
chose rather than infer it. A Commander whose pool cannot fill a deck is refused
by name rather than swapped for the next candidate, because retrying down the list
would be a repair policy invisible in the provenance. Nothing moved:
`PROTOCOL_VERSION` stays 8, `DECK_GENERATOR_VERSION` stays `'1'`, and
`SEED_DERIVATION_VERSION` stays 2 because the selection stream is a new derivation
beside the existing two rather than a change to either.

## The parallel non-code activity

**Run structured manual playtests using the four current 40-card precons.** M09
does not replace this and is not blocked on it: nothing in the record still says
what the game is like to play, and every remaining _content_ choice depends on
that. What M09 changes is who the other seat can be — **as of M09.5 a solo tester has
an opponent**, and the playtest notes below are exactly what that opponent exists
to produce.

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

**Then evaluate the results before selecting the milestone after M09.** The
evidence decides whether that one is implementation (a defect class worth fixing
properly), rules (a friction point that needs an owner decision), content, or the
deferred M08.

The **50-card expansion remains the next intended content milestone**: 8–9 further
colour-legal cards per Commander, or an equivalent shared package, measured
against colour-legal pools of 42/41/41/42. It is **not started**, and it should
not start before the playtests, because authoring 32–36 cards against an untested
40-card baseline would be guessing at what the decks need.

The questions under [Owner decisions still open](#owner-decisions-still-open) are
the other thing the implementation is waiting on, and playing the decks is the
cheapest way to find out which of them actually matter. `docs/open-questions.md`
holds every other question the project has recorded. A milestone file under
`docs/milestones/` and a row in the table above is what starts a milestone; M08.0
added both for M08, and M09.0 added both for M09.

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
- M08's own locked interpretation — AI results stay calibration evidence, human
  telemetry is an observation source, surrender is not a cause, the panel
  configures the simulator rather than forking it, and experiment directories
  stay canonical — is in
  [the M08 milestone file](docs/milestones/M08-ai-lab-and-player-meta.md#locked-interpretation),
  with the boundaries in [ADR 0023](docs/architecture/0023-admin-lab-boundary.md).
  It stays locked while M08 is deferred.
- M09's own locked interpretation — a bot is a server-owned seat controller with
  no connection identity, it sees exactly what a human in that seat sees and acts
  through the same `applyAction` path, a deck source is public at the Commander
  and private at the list, difficulty and style and deck source and timing are
  four independent axes, and bot pacing is server configuration that deliberately
  does not answer Q8 — is in
  [the M09 milestone file](docs/milestones/M09-play-against-ai.md#locked-interpretation),
  with the boundaries in [ADR 0024](docs/architecture/0024-live-bot-seats.md).

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
