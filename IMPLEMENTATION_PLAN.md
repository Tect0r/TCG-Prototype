# Implementation plan

Baseline audited: `Tect0r/TCG-Prototype` `d49529b` on 2026-08-11.

This is the only root work queue. Before using a status below, compare it with
the current branch. Code and passing tests outrank this baseline.

## Execution rule

Work on exactly one tranche named by the user. Read only this file, `CLAUDE.md`,
the active milestone file, and the code/docs that tranche directly references.
After verification, update the evidence and stop.

## Status

| Milestone                                                                                 | State at baseline                     | Next tranche            |
| ----------------------------------------------------------------------------------------- | ------------------------------------- | ----------------------- |
| [M01 Truthfulness and verification](docs/milestones/M01-truthfulness-and-verification.md) | M01.1–M01.5 done (2026-08-11)         | Complete                |
| [M02 Remaining card mechanics](docs/milestones/M02-remaining-card-mechanics.md)           | 155/155 executable (M02.1–M02.6 done) | Complete                |
| [M03 Precon integration](docs/milestones/M03-precon-integration.md)                       | M03.1–M03.4 done (2026-08-12)         | Complete                |
| [M04 Shared board telemetry](docs/milestones/M04-shared-board-telemetry.md)               | M04.1–M04.3 done (2026-08-12)         | Complete                |
| [M05 AI reliability](docs/milestones/M05-ai-reliability.md)                               | Legal but not balance-trustworthy     | M05.1                   |
| [M06 Token presentation](docs/milestones/M06-token-presentation.md)                       | Spectator grouping only               | Q42 decision checkpoint |
| [M07 Documentation consolidation](docs/milestones/M07-documentation-consolidation.md)     | Stale/contradictory docs remain       | Final milestone         |

Since M01.2, an unfinished card makes a deck illegal by name. The spectator
refuses such a precon and runs it only under a deliberately named developer
override that marks the replay and its telemetry `resultsValid: false`. **As of
M02.5 no shipped deck triggers it:** all four precons are legal, the four-seat
spectator table runs without the override and records a valid result, and the
multiplayer server accepts every precon. The refusal itself is unchanged and is
still under test — against a synthetic unfinished card in
`packages/deck/src/validate.test.ts` and a doctored pool in the spectator and
server suites — because it has to keep working for the next card somebody starts
and does not finish. Nothing downstream may route around it.

Since M01.3, every card-pool and environment hash has moved: they are taken over
one canonical mechanics projection (`@tcg/card-data#CARD_FIELD_KINDS`) that a new
card field cannot be added to without classifying it. Replays and frozen
environments recorded before it are refused on `cardDataHash` / `mechanicsHash`,
which is the point — the old hashes could not see `additionalCosts`.

Since M01.4, the in-app rulebook, glossary and contextual help describe the
implemented ruleset: deployable Commanders with a defeat return and cost tax,
singleton Wave 1 construction read from the active format, Reaction windows,
Energy carryover, Guardian, Newly Deployed / Rush, the unbounded battlefield,
the player-versus-deployed-Commander split, and the Overwhelm/Barrier order.
Doing it surfaced one contradiction that is **not** resolved: `CLAUDE.md` says no
Reaction may respond to another, and `reactions.ts` plus its tests say one may
(§5.5, via the priority round restarting on a play). The book describes the
engine. See Q47.

Since M02.1, delayed effects exist as a first-class, serialized part of match
state. A card sets one up with a `schedule_delayed` instruction naming one of its
own `delayedAbilities`; the entry is bound once — boundary, source, controller,
subject and provenance — and never re-targeted. Two rules decide the awkward
cases, and neither is keyed to a card: a subject that moves to a different zone
ends the entry, and an entry never survives the turn it was made on. `fading_wisp`
and `marked_for_death` are implemented, so `precon_wave_1` is 144/155. The
remaining 11 are M02.2–M02.5, and no precon is legal until M02.6.

Since M02.2, both zone transitions the catalog prints are the existing
`move_card` instruction: `toZone: "removed"` is terminal, and
`toZone: "battlefield"` is a revival that arrives as a fresh permanent, Newly
Deployed, reporting `entersBattlefield` and never `deployed`. One field is new —
`entersExhausted`, legal only on a battlefield arrival — and readiness on arrival
is now decided by the arrival itself rather than inherited from the zone the card
came from. `corpse_stitcher` and `grave_reassembly` are implemented, so
`precon_wave_1` is 146/155; the remaining 9 are M02.3–M02.5 and every precon
still contains at least one of them. Note for M02.4: `entersExhausted` is a
card-local flag on its own instruction and is **not** the replacement layer those
five cards need.

Since M02.3, a number on a card may be read off a statline as well as counted —
`{ kind: "stat", of, stat }`, evaluated per recipient at the moment the
instruction resolves — and a cost may be derived from the board through a
`cost_reduction` static ability rather than stamped on as a `modify_cost` delta.
`playCostOf` is now the single answer to "what does this card cost right now",
used by the play path, legal actions, Reactions, telemetry and the view; a card
in the viewer's own hand carries its current cost on `CardInstanceView`, so a
discount is visible before the card is affordable. `bastion_commander` and
`stitched_abomination` are implemented, so `precon_wave_1` is 148/155. One thing
worth knowing before balance work: Bastion's "for that combat" Health bonus keeps
a blocker alive through the damage step but not past `end_of_combat`, because
marked damage outlives the bonus. That is the existing duration rule, not a new
one, and M02 excludes balance changes — see the tranche's notes.

Since M02.4, exactly two moments in the ruleset can be rewritten as they happen:
an arrival on a battlefield and a permanent readying at its controller's Ready
Step. The standing half is two static-ability effects — `replace_arrival` and
`replace_ready`, both pinned by the schema to `zone: "battlefield"` — and the
fixed half is a `skip_next_ready` instruction that rides on the permanent rather
than on the card that applied it. A replacement is **not** a trigger and the
difference is observable: nothing sees the un-rewritten state, no Reaction window
opens between the two, and removing the source afterwards does not undo it. Where
several apply, they are visited in the engine's existing trigger order rather
than a new one, and nothing recurses, because a replacement can only set flags on
the object the event is about. The Ready Step now has three fixed stages — stored
skips, then standing replacements, then readying — and is the one part of turn
start that can pause for a choice, which it does only when there is something to
decide and a controller who can pay for it. All five cards are implemented, so
`precon_wave_1` is 153/155; the remaining 2 are M02.5.

Since M02.5, two decisions can be shared out across the table. A **plural
`chooser`** on an ordinary target selector is "each player chooses": the seats
are asked in the selector's own order — controller first, then clockwise — the
selector's `controller` is read relative to whoever is being asked, and **nothing
is applied until the last answer is in**, so a later seat decides against exactly
the board the first seat saw. A **`divided`** flag on `deal_damage` makes its
amount a total one player splits; the answer is a multiset with one entry per
point, and each target takes its whole share as a single hit. The amount those
cards use is a third `ValueExpression` member, `previous_targets`, which counts
what the instruction before it resolved with rather than what died this turn.
`equal_price` and `mass_offering` are implemented, so `precon_wave_1` is
**155/155** and M02.6 is the only tranche left in M02. One rules question was
settled by the owner and not by the code: the word "Unit" on both new cards
includes a Token, following the rulebook's own definition; the older
`["unit"]`-only sacrifice filters elsewhere in the catalog were left alone
because re-reading them is a balance change.

Since M02.6, the catalogue is closed and **`precon_wave_1` is a `playtest` set**,
which is the load-bearing part: the content build turns every card warning into a
hard error for a strict-status set, so the checks below are gates rather than
advice. Two of them are new. Every one of the 155 cards has an executable
happy-path **behaviour contract** in
`packages/rules-engine/src/card-contracts/`, and a coverage guard fails by name
when a card in the set has none — so a card can no longer arrive without a
behaviour test. And the display-text drift check now runs in **both**
directions: prose that promises behaviour the card lacks was already reported,
and behaviour the card performs that the prose never mentions now is too, with
no exemption for a card whose help text is hand-written. The entry-trigger
review is done and recorded in `docs/rules/entry-trigger-review.md`; sixteen of
its twenty-one uses are correct as they stand and five are Q48, below. M02 is
complete.

Since M03.1, the deck builder is where a player meets the four precons: a
"Precons" button opens a browser listing every bundled precon **for the active
format**, showing its Commander, its whole 40-card list, its permanent precon and
format IDs, and why it can or cannot be played. That last answer is one shared
function — `reviewPrecon` in `@tcg/deck` — layering a format check, the existing
`validatePrecon`, and `validateDeck` run against the copy, so the builder cannot
call a precon playable by a rule the server does not apply. "Copy" produces an
ordinary saved deck through `preconToDeck` with a fresh ID and a non-colliding
name; the bundled definition is never written to. What was deliberately _not_
done: no precon provenance was added to `SavedDeck`, because that is a persisted
schema change and no tranche in M03 needs it. See the tranche's note.

Since M03.2, a precon is something you can play rather than only copy, and it
reaches the match **as an ID**. The lobby's deck picker lists the built-in
precons for the active format beside the player's saved decks; choosing one
sends `submit_precon { preconId }` — a new protocol message, `PROTOCOL_VERSION`
now 4 — and nothing else. The server resolves that ID against its own bundled
content, reviews it with the same `reviewPrecon` the UI previewed with, and
builds the deck itself with `preconToDeck`, so what it validates is what the UI
presented and there is no list on the wire to tamper with. An edited precon is
an ordinary saved deck and still goes through `submit_deck`, judged on its
contents; the precon's name buys it nothing. All three surfaces — builder
browser, lobby picker, server — now read one format-scoped list,
`preconsForFormat` in `@tcg/card-data`. Two failure modes are deliberately
distinct: an ID that names nothing is `protocol/unknown_precon` and leaves the
seat's existing submission alone, while an ID naming a precon from another
format is resolved and then refused with `precon/format_mismatch`. One thing
deliberately not added: the precon ID is not in `LobbySeatView`. The seat's
public `deckName` already becomes the precon's name, which is the same thing a
copied precon has always shown, but putting the ID in the protocol would hand
opponents an exact 40-card list.

Since M03.3, a simulator experiment names a precon instead of copying it out:
`{ "kind": "precon", "preconIds": [...] }` is a fourth deck source, resolved
through the same `bundledPrecon` → `reviewPrecon` → `preconToDeck` path the
builder, the lobby and the server use, so the four surfaces cannot disagree about
what a precon is. It is the one deck source where every failure is fatal — an
unknown ID, another format's precon, a precon the environment bans a card out
of, or the same ID twice all stop the run — because a source that _names_ a
shipped deck cannot quietly play three of four. Manifests are now schema 3 and
carry each precon ID with its format, Commander and resolved deck hash beside
the environment hashes and frozen snapshot that pin what those IDs meant.
Two things worth knowing. `environment.format` and `environment.sets` finally
scope the card pool — they were documented as selecting content and did nothing,
so every environment resolved against the whole bundled universe; an environment
naming neither still does, because the Phase 1–4 fixture configs depend on it.
And the first precon smoke run found a real defect: the simulator's `seatToAct`
did not know about Reaction windows, so a window whose priority sat with a
non-active seat was offered to the active player, who had no legal action at all,
and the match died in the pilot fallback. Fixed, with the four-precon batch as
its regression. The generated fixture decks carry almost no Reactions, which is
why nothing had caught it.

Since M03.4, a batch can be asked for the **whole ordered matchup matrix** with
one setting, `orderedMatchupMatrix: true`, and `experiments/precon-matrix.json`
is that run for the four Wave 1 precons. The schedule gained the one thing it
could not express: `includeMirrorMatchups` enumerates deck tuples as combinations
_with_ repetition, and a tuple's seat orientations are now its number of distinct
rotations rather than its length, so a deck against a copy of itself is one
ordered matchup and not two identical tables on different seeds. Four decks are
therefore 6 × 2 + 4 = **16 ordered matchups**, and a schedule without mirrors is
byte-identical to before. `matchup-matrix.json`, its CSV and a report section
record, per game, the seat order with each seat's deck, hash, Commander, pilot
and pilot seed, the starting player, the full seed derivation path, the winner
and termination, every invariant failure, and the replay path; and per run the
precon IDs, the construction format, the environment hash and the pilots as they
played. Completeness is recorded rather than assumed — `expectedCells` is `n²`,
`missing` names any unplayed pair, `cleanGames` counts the games with no
invariant failure — and the manifest (schema 3 → 4) carries the same numbers, so
the claim is either made or visibly declined. The shipped run is 16/16 cells and
16/16 clean, byte-identical at one worker and at four. Two things are deliberate:
a configuration that could not produce a complete matrix — not two seats, a
sampled schedule, unmirrored seats — is **refused at parse time** rather than
quietly adjusted, and the report section says in bold that it is a robustness
artifact and not a balance measurement, with the winner column present for
auditability only. M03 is complete.

Since M04.1, board size is measured by **one collector in one schema**, and a
simulator batch measures it at all. `@tcg/board-telemetry` owns the definitions —
per-round Unit counts, peak Units/non-Tokens/Tokens/visual stack/Tokens by
definition, the longest turn, the largest combat and the most _expensive_ combat
(which are routinely different combats), the busiest turn's triggers and choices,
and what answered each seat's largest board. It is driven by the event stream and
by the turn each accepted action was taken on, and by nothing else, which is what
lets the simulator feed it live from `runMatch` — a batch must not retain every
match's log — while the spectator feeds it a finished replay, and get an
identical answer for the same deterministic match. That equality is asserted on a
real match rather than assumed. `SpectatorTelemetry` now _extends_ the shared
schema instead of restating it and keeps only what is true of a watched match:
the placement leaderboard and the provenance flag. Two version bumps, both
refusals rather than migrations, because the older artefacts never made the
observations: spectator replays 2 → 3 (with `replayFormatVersion` so the refusal
says which version it is rather than "not a replay"), and simulator records 3 → 4
(the existing `matches.header.json` drift check refuses to resume across it).
Manifests stay at schema 4 — they already record `telemetrySchemaVersion` by
reference. One thing deliberately withheld: the shared schema carries
`attackersByRound` and `longestStallRounds` and **no stall verdict**.
`boardStalled` remains a spectator-side presentation threshold, because
distinguishing "nobody wanted to attack" from "nobody could" is M04.2 and the
threshold that would make either evidence is Q43.

Since M04.2, a quiet round says **why** it was quiet, and the engine is what says
so. A new event, `attack_opportunity`, is emitted at every attack declaration —
immediately before `attackers_declared` and **before declared attackers Exhaust**,
so it describes the board the seat decided against rather than the board its
decision produced — carrying Units held, Ready Units, legal attackers, Exhausted
Units, Ready Units held back by `Newly Deployed`, living opponents, and attackers
actually declared. It comes from `attackCensus`, which is also where
`legal-actions.ts` now gets `legalAttackers`, so the evidence and the legality the
engine enforces are one function rather than two readings of the same rule; the
counts partition the board exactly and that is asserted, not assumed. It is an
observation — no trigger reads it, nothing branches on it, and every count is a
tally of Units on a public battlefield, so no observation boundary moves.

The collector files each census under exactly one of five outcomes that sum to
`seatsAsked` — able, no Units, all Exhausted, held by Newly Deployed, no living
defender — with `seatsDeclining` a subset of "able" and `readyPreventions`
counted from `ready_prevented` and buffered onto the round it affects, because a
Ready Step runs before the `turn_started` that names its turn. The same steps are
counted per seat, since a round series cannot say who declined. Two raw streaks
replace the old single one: `longestDeclinedStreak` over quiet rounds somebody
could have attacked in, `longestUnableStreak` over quiet rounds nobody could.
`longestStallRounds` is kept and is **not** their sum — a quiet round no seat was
asked in counts there and belongs to neither.

`boardStalled` is **removed, not retuned**, and it was the only derived verdict in
either document. `attackOpportunity.classification` is the literal
`'undetermined'` so nothing can read a verdict out of it by accident, and a build
that starts writing one has to change the schema version. Three refusals, no
migrations: board telemetry 1 → 2, spectator replays 3 → 4 (a v3 log cannot answer
what a seat could have attacked with, and carries a `boardStalled` claim that no
longer exists), simulator records 4 → 5; manifests stay at schema 4. Q43 is now
answerable rather than abstract — two four-seat precon traces are in
`docs/open-questions.md`, and they show the baseline's `longestStallRounds: 2`
adding round 1 (nobody _could_: two empty boards, two freshly deployed) to round 2
(two seats could and declined), which are opposite findings.

Since M04.3, a quiet round has a **verdict**, and Q43 is answered: a round counts
toward a stall only when every living seat reached its attack step, every one of
them could legally have attacked, and none of them did; **three consecutive** such
rounds is a stall. The strict reading was chosen over the permissive one, with no
round-1 special case — an empty board is never able and a fresh board is held by
`Newly Deployed`, so the opening excludes itself through the ordinary rule — and
any declared attacker, one Token included, breaks the streak. On a four-seat table
it almost never fires, which is the point: both traced precon matches classify
`not_stalled`, which is the right answer for matches that ended in 53- and
64-attacker combats.

The rule is data rather than presentation, because Q43 required "one explicit,
configurable, versioned number rather than a judgement made in the reporting
layer". `@tcg/board-telemetry/stall` owns it; the collector applies it; and every
document carries the definition it was judged by as `stallDefinition`, so a
verdict never travels without its rule and a batch that mixes definitions is
refused a summary rather than given a meaningless one. The streak it was cut from
is stored raw as `longestUnanimousDeclinedStreak`, and each round carries
`stallEligible`, so a finished document can be re-judged at a different threshold
without re-simulating. One new observation makes the strict rule possible:
`livingSeats` per round, taken at the round's start, because `seatsAsked` alone
cannot tell "the whole table" from "a seat that was skipped" after an elimination.

Board metrics are now in the reports. A `## Unlimited board` section answers M04's
four questions with distributions rather than averages — and aggregates over
_every_ record, abnormal ones included, which is the one place the report departs
from its usual sample and says so, because a turn-limit match is the strongest
stall candidate in a batch. The matchup matrix carries the same figures per cell,
plus seven new CSV columns. Reconciliation is a function rather than an assertion:
`reconcileBoardTelemetry` names the fields two documents disagree on, and the
spectator's own `collectTelemetry` is run over a simulator match and required to
agree on everything except the two things a watched match adds. Five version
moves, all refusals: board telemetry 2 → 3, spectator replays 4 → 5, simulator
records 5 → 6, report 3 → 4 with `summary.json` 2 → 3, and the matchup matrix
1 → 2. Manifests stay at schema 4. M04 is complete.

Since M01.5, `npm run verify` is the whole gate: its `typecheck` step covers the
workspaces and then the root project, so `scripts/`, `vitest.config.ts` and
`eslint.config.js` are held to the same strictness as shipped code. The separate
`npx tsc -p tsconfig.json --noEmit` step is retired. `scripts/` also has a vitest
project now; the two root scripts are CLI shells over tested modules in
`scripts/lib/`. M01 is complete.

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

Only stop on these when the active tranche genuinely needs the answer:

- Q4: implement or remove `resilient`.
- Q42: exact visual equivalence key for Token grouping.
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
  rulebook currently describes the engine. Raised by M01.4, not decided by it.

## Completion evidence for every tranche

- Exact behavior and data/schema changes.
- Focused regression tests.
- Help, pilot, telemetry, replay/hash, protocol, and authoring coverage when the
  mechanic touches them.
- `npm run verify` passing. It covers the root `tsconfig.json` since M01.5;
  nothing needs to be run separately.
- No newly stale player-facing text.
- Status table and milestone checklist updated in the same change.

## Global stop conditions

Stop rather than widen scope when:

- a rule choice changes gameplay rather than implementation detail;
- current code contradicts the milestone baseline;
- a schema migration could invalidate saved/replay data without a defined policy;
- hidden information would cross an existing observation/view boundary;
- unrelated local changes overlap the required files.
