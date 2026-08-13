# Implementation plan

Baseline audited: `Tect0r/TCG-Prototype` `d49529b` on 2026-08-11.

This is the only root work queue. Before using a status below, compare it with
the current branch. Code and passing tests outrank this baseline.

## Execution rule

Work on exactly one tranche named by the user. Read only this file, `CLAUDE.md`,
the active milestone file, and the code/docs that tranche directly references.
After verification, update the evidence and stop.

## Status

| Milestone                                                                                 | State at baseline                           | Next tranche    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------- | --------------- |
| [M01 Truthfulness and verification](docs/milestones/M01-truthfulness-and-verification.md) | M01.1–M01.5 done (2026-08-11)               | Complete        |
| [M02 Remaining card mechanics](docs/milestones/M02-remaining-card-mechanics.md)           | 155/155 executable (M02.1–M02.6 done)       | Complete        |
| [M03 Precon integration](docs/milestones/M03-precon-integration.md)                       | M03.1–M03.4 done (2026-08-12)               | Complete        |
| [M04 Shared board telemetry](docs/milestones/M04-shared-board-telemetry.md)               | M04.1–M04.3 done (2026-08-12)               | Complete        |
| [M05 AI reliability](docs/milestones/M05-ai-reliability.md)                               | M05.1–M05.6 done (2026-08-13)               | Complete        |
| [M06 Token presentation](docs/milestones/M06-token-presentation.md)                       | Q42 answered; M06.1–M06.3 done (2026-08-13) | Complete        |
| [M07 Documentation consolidation](docs/milestones/M07-documentation-consolidation.md)     | Stale/contradictory docs remain             | Final milestone |

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

Since M05.1, "is this mechanic supported" is a question with a machine-readable
answer instead of an author's sentence. `@tcg/card-data`'s **mechanic support
registry** classifies every member of seven executable vocabularies — instruction
effects, continuous effects, triggers, keywords, conditions, value expressions
and costs — along four independent dimensions: does the engine execute it, is it
described to a player, can a pilot play it, does a match record observe it. Each
table is a total `Record` over a vocabulary read off the schema, so adding a
mechanic without classifying it is a **compile error**, and every entry carries a
note naming the module its claim is about, so a downgrade is actionable.

Support is now **derived, not claimed**. `mechanicsUsedBy` walks a card's
structured data — keywords, additional costs, all four effect lists, trigger and
instruction gates, value expressions, continuous effects, and the keyword a
`grant_keyword` hands out — and the content build fails a `playtest` or `active`
set containing anything the engine does not execute, warning instead in a
`development` set. `KEYWORD_REGISTRY.implemented` is a view of the registry
rather than a second claim beside it. That is half of Q4: `resilient` is now
barred from playable content by a rule rather than by luck, and only the design
decision — implement it under which reading, or delete it — is still open.

Every simulator run states what its own evidence is worth. The manifest (schema
4 → 5) and `summary.json` (3 → 4) carry a `mechanicSupport` block: the weakest
engine/help/pilot/telemetry level each deck reaches, the mechanics responsible,
and the cards no pilot values or no record observes. The report (schema 4 → 5)
prints it as `## Mechanic support`, immediately after the review signals and
before any outcome, because it is the section that says which of those signals to
believe. A balance flag the run cannot carry is **downgraded to
`insufficient_data`, never dropped** — when every pilot is legality-only, when
its subject card carries an unvalued mechanic, or when its subject card does
nothing a record observes — with its evidence, interval and threshold intact and
the reason appended to its message. `run_quality` flags are untouched: "three
matches ended abnormally" stays true however blindly the pilots played.

Two real gaps fell out of doing this and are recorded rather than papered over,
because both are M05.2's work. **No pilot values `counter`** — the effect switch
has no case for it and returns zero — so every shipped precon, all of which carry
a Reaction, now honestly reports `pilot: legal_only`. And
`CardTelemetry.timesReturnedToHand` is in the schema and is never incremented, so
a bounce is invisible to a batch; `return_to_hand` is classified
`telemetry: 'none'` on that basis.

Since M05.2, a pilot pays for what a card actually does. The two gaps M05.1
recorded are the shape of the repair. `EFFECT_PRICERS` replaces the effect
`switch` with a total `Record` over `EffectType`, so a new instruction is a
**compile error** until somebody prices it and a zero is a decision rather than
an oversight — which is how `counter` came to be priced as a blank card for the
whole life of the Reaction mechanic without a test noticing.
`effectPricingGaps()` is its runtime twin in both directions. A counter is now
worth `counterValue`, softened by `unlessPays` as an even split and **capped at
the counter's own value**, because which branch happens is the opponent's choice;
`scoreReaction` takes that abstract estimate back off and substitutes the value
of the card actually on the stack, so holding one is approximate and spending one
is board-aware. Every shipped precon therefore reports `pilot: approximate`
instead of `legal_only`, and the balance flags those runs were declining are made
again.

Three more things stop being priced by proxy. A keyword the engine does not
execute is worth **nothing** — `keywordIsValued` reads the support registry, so
`resilient` costs a pilot nothing on a statline, a grant, a removal, a continuous
layer or a `replace_arrival`, and implementing it will switch its valuation on in
the same change that switches its behaviour on. That is the bot half of Q4; only
the design decision is left. A continuous ability is priced by magnitude, scope
reach, source-bound duration and which side of the table it lands on, so one
large layer outranks two tiny ones and "**this card** costs 1 less" sits below a
discount on a whole hand — the old `staticAbilities.length × buffValue × 2` could
not tell any of those apart. And `costValue` is now shared by all three places a
cost is paid: an activation, a played card's `additionalCosts`, and an activated
ability priced inside `cardValue`. A Spell printing "as an additional cost,
sacrifice a Unit" used to read as free.

`scoring.test.ts` is new and is the acceptance criterion checked from the test
side: its instruction, cost and continuous tables are mapped types over the
schema's own vocabularies, so a mechanic added without a valuation test does not
compile. `SUPPORT_REGISTRY_VERSION` moves 1 → 2 — a classification change, not a
schema change, so nothing is refused; the version exists so a manifest's claims
can be read against the registry that made them. No artefact pins it.

Since M05.3, a pending choice says **why it exists**, and nothing downstream
reads the source card to find out. `PendingChoice.provenance` carries the
resolution item and effect index that asked, the asking instruction, the source's
controller, how the seat being asked relates to that controller, whose entities
the options are, and what selecting one does to the thing selected. The valence
comes from `@tcg/card-data`'s new `EFFECT_INTENTS` — `benefit` / `detriment` /
`neutral`, a total mapped type over `EffectType`, so an unclassified instruction
is a compile error and `effectIntentGaps()` says the same at runtime. Four
instructions read a printed parameter rather than a constant, because for those
four the number is the direction: a stat modifier's sign, a cost delta's sign, a
search's destination, and a zone move's **journey** — `move_card … toZone: hand`
is recursion out of a discard pile and a bounce off a battlefield, and those are
opposite.

The thing this deletes is `sourceIsHostile`, which read a card's whole effect
list and called the card hostile if anything on it was. A card that removed one
unit and buffed another was therefore hostile for **both** of its questions, and
the pilot handed the buff picked its worst unit — a defect no match result can
show you, because the action is legal and the match finishes. `scoreChoice` now
multiplies the instruction's valence by whether the option belongs to somebody
else, which also subsumes the hard-coded list of "always costly" choice reasons:
a cost is a detriment aimed at cards the chooser owns, and says so in its own
provenance. The ordered branch uses the same direction, so reordering an
opponent's deck comes out the right way round without a rule of its own.

Two readings are deliberate. `targetRelation` is read **from the seat being
asked** rather than from the ability's controller, which is what makes "a Unit
you control" mean each seat's own units in an `each_player_choice`; where that
cannot be pinned down — an `opponent` selector handed to one of those opponents —
it is `any` rather than a guess. And provenance carries **no card identity**:
`sourceInstanceId` beside it already attributes the question, and adding the
source's `definitionId` would hand the seat being asked the printed identity of a
card it may never have been shown. That is asserted by name.

Provenance rides on the `choice_requested` event as well as on the choice,
because the choice is gone the moment it is answered. Four version moves, all
refusals: `MATCH_SCHEMA_VERSION` 6 → 7, `PROTOCOL_VERSION` 4 → 5 (the view shape
a client validates changed), `SPECTATOR_REPLAY_VERSION` 5 → 6, and the three
heuristic pilots 1.0.0 → 1.1.0 — their decision procedure changed, and a record
has to be traceable to the pilot that produced it. `SUPPORT_REGISTRY_VERSION`
stays at 2: no mechanic's support level moved. One player-facing wording bug fell
out of it and is fixed: `keep_exhausted` said "one **enemy** unit" and was wrong
whenever the offer was made at its own controller's Ready Step.

Since M05.4, a pilot is an **instrument rather than a skill level**, and a run
states which instrument flew it and what that entitles it to claim.
`@tcg/bot-interface`'s agent class registry holds four classes — random-legal,
generic heuristic, archetype-aware, human playtest — against twelve evidence
claims, as a table total in both directions, so adding either without deciding
every pair is a compile error. `PILOT_AGENT_CLASSES` is total over `PILOT_IDS`:
`aggressive`, `defensive` and `value` are one class with three weight vectors,
and calling one of them the better player would be the pooled skill axis this
tranche exists to refuse. `LEGAL_ONLY_PILOT_IDS` is now a view of that table
rather than a second list beside it.

The claims are load-bearing rather than descriptive. `FLAG_CLAIMS` maps every
review signal to the claim it rests on — also total, so a new signal is a compile
error until somebody decides who may make it — and a set of classes carries a
claim only when **all** of them do, because the numbers a flag is computed from
pool every seat. Two consequences, both in the direction of claiming less. A
card-pair signal (`synergy`) and a counter-breadth signal (`control`) are now
declined by every run this build can produce, because no shipped pilot is
archetype-aware; that is M05.4's own rule encoded, and M05.5 turns them back on.
And a run mixing `random_legal` with a heuristic declines its play-quality
signals, superseding M05.1's "every, not any" reading for the pooled columns
only — the properly flown arm is not discarded, it is reported in its own row,
which is what M05.1 had no place to put. `seat_sensitivity` deliberately survives
a random-legal run: mirrored seats make uniform play an unbiased probe of a
turn-order advantage, and that claim is named `structural_asymmetry` rather than
folded into play quality.

Nothing is pooled. `RunSummary` gains `agentClassWinRates` beside the pilot
rates, with an `unclassified` bucket for a pilot ID this build does not know —
an unrecognised pilot is not a weak agent, it is an unvouched-for one, and it
withdraws every claim rather than being read as random-legal. The report gains
`## Agent classes` between the review signals and mechanic support, printing the
class of each pilot, a row per class in the outcome table, and a claim-by-claim
table of what the run may and may not be cited for; it also states that **no
pilot in this build implements archetype-aware or human playtest**, as a fact
about the software rather than an omission. Three version moves, all refusals:
report 5 → 6, manifest 5 → 6, `summary.json` 4 → 5.
`AGENT_CLASS_REGISTRY_VERSION` starts at 1 and pins the taxonomy a citation was
made against.

Since M05.5, a deck can say **what it is made of**, and a run can say **whose
decks it played**. `@tcg/card-data`'s archetype registry names four strategies —
`token_swarm`, `defensive_attrition`, `sacrifice_value`, `reactive_control` —
each with the package roles a plan claiming it must supply, as a total `Record`
over the vocabulary, so adding an archetype without deciding what it requires is
a compile error. It names no card, which is what keeps the vocabulary stable when
the pool moves. Beside it, a **deck-plan schema** and four authored plans in
`content/deck-plans/`, one per Wave 1 precon, group a decklist into named
packages carrying a role, a rationale and a `core` flag; membership was derived
from the cards' own `role` and `design.identity` rather than assigned. A plan is
content, so every claim it makes is checked by the content build (bundle schema
1 → 2) — required roles supplied, no overlapping packages, cards in the format
pool, and the Commander and every card actually in the precon it claims to
describe — and all of it is an error in every set status, because an
unimplemented card is inventory but a plan that misdescribes a deck is a search
input that steers a whole population wrong.

A package is present **all or nothing**. That reading is what makes the two
mutation policies mean anything: `protect` never removes a card of an intact core
package, `replace` removes one whole core package and refills the freed slots
**from the pool** rather than from the plan, and a package that counted as
half-present would let a search dismantle an engine one card at a time and still
report it protected. Generation with `planId` seeds packages whole, in declared
order, and fills only the rest by the weighted draw; a package that cannot go in
whole is skipped and reported rather than applied partially.

Two things are deliberate. **Search remains able to explore outside plans
structurally, not by configuration**: `MAX_PLAN_SHARE` caps a plan at 75% of the
deck and the content build enforces it, so every plan-generated deck has free
slots no generator setting can take away — and `packagePolicy` defaults to
`none`, byte-identical to the pre-M05.5 operator, so adding plans did not narrow
what a search can find. And `SimDeck.construction` — `hand_authored` /
`plan_generated` / `unconstrained`, plus the plan and which packages survive — is
**recorded, never inferred**: a random deck holding a whole package is still a
random deck, and a shipped precon that contains its own plan whole is
hand-authored and _also_ conforms, which are two separate facts. It sits outside
the deck hash, because two identical lists are the same deck to the engine
whoever built them.

The report gains `## Deck construction` between the agent classes and the
mechanic support — the third independent half of "is this evidence": the cards,
the player, and now the deck's provenance, counted apart and never averaged.
Four version moves: report 6 → 7, manifest 6 → 7, `summary.json` 5 → 6, and
`SEARCH_CHECKPOINT_VERSION` 1 → 2 as a refusal, since a v1 checkpoint never
recorded where its decks came from. `ARCHETYPE_REGISTRY_VERSION` starts at 1.

One limit of the shipped content is recorded rather than worked around.
`goblin_warboss` is mono-red, so its colour-legal Wave 1 pool is 41 cards against
a 40-card singleton deck: one spare. Every package-scale move has nowhere to put
what it frees, so `replace` declines on a full-size Wave 1 deck with an accurate
reason instead of returning something smaller. That is the same constraint that
already made crossover between two full-size Wave 1 decks report "no legal
change" before this tranche, and it is the pool's property, not the operator's.

Since M05.6, a pilot's judgement is measured **one hand-authored decision at a
time**, and every batch says what it is for. `packages/bot-interface/src/calibration/`
holds sixteen tactical fixtures over the four Wave 1 precons — a board a person
reading the deck would recognise, the one question it exists to ask, and the
characteristic answer — driven through the same `playerView` + `legalActions`
pair a networked bot gets, so nothing is calibrated against information no seat
can see. The boards are built with the engine's own arrangement helpers, now
published as `@tcg/rules-engine/test-fixtures`, because a fixture's board has to
be a board the engine could have produced and there is one definition of that.

Two structural rules make the suite an instrument rather than a wish. The facet
vocabulary — sequencing, targeting, sacrifice, blocking, reaction — is a total
`Record`, so a facet added without a question is a compile error; and **whether a
deck can pose a facet's question at all is derived from its cards**, so
`precon_goblin_swarm` is never asked about sacrifice and `precon_grave_sacrifice`
is never asked about Reactions, without anybody claiming so in a table. Precon
IDs are content rather than a union, so `calibrationGaps()` makes the coverage
guarantee the type system cannot. And a fixture records what the pilot **actually
does**: `knownGaps` names the pilots that miss the characteristic decision and
the part of the valuation that is blind to it, and the suite asserts the record
in **both directions** — a gap that closes fails as loudly as a decision that
regresses, because both mean the written record has gone stale.

Pilots are compared on identical positions by construction: the seed is a
function of the fixture ID alone, the board is fixed and the opponent is
scripted, so a disagreement is a difference in valuation and cannot be luck.
Nothing is ranked — `CALIBRATED_PILOT_IDS` is a view of the agent class registry
(the pilots whose class carries `play_quality`), and `aggressive` beating
`defensive` on a fixture is a fact about that fixture.

Nine of the sixteen are answered characteristically by all three pilots, one
splits, and six are answered by none — and the six are the point, because a match
result cannot show you any of them. Removal is aimed by board value rather than
by what the damage defeats; blocking prefers a trade to a block that loses
nothing; sequencing is scored one play at a time, so the Bastion Armory lands
after the Guardian it was meant to arm; an additional sacrifice cost outweighs
what it buys, so the Grave deck never casts its own draw engine; and nothing
prices holding Energy for a window that has not opened, which is the clearest
single reason a Reaction deck cannot be judged by these pilots. All six are
recorded, not fixed: this tranche is the instrument that says which are worth
fixing.

Every batch now opens with `## Calibration standing`, before the limitations and
before any number it could qualify. The standing is
`claimCarriedBy(classes, 'final_balance')` and nothing else — derived from the
agent classes that flew, **not a field in an experiment file** — so no
configuration promotes a run from an instrument reading to a balance conclusion,
and the milestone's "until human sanity checks agree" is satisfied by a person
flying the run rather than by editing JSON. The shipped four-precon ordered
matrix was re-run under it: 16/16 ordered pairs, 16/16 clean, standing
`calibration`. Three version moves, all refusals: report 7 → 8, manifest 7 → 8,
`summary.json` 6 → 7. `CALIBRATION_SUITE_VERSION` starts at 1 and pins the
fixtures a calibration citation was made against; a `knownGaps` entry moving does
not bump it, because that is a measurement changing and the instrument is the
same. M05 is complete.

Since M06.1, a board of a hundred Tokens is readable, and **Q42 is answered by
measurement rather than by intuition**: two Tokens share a tile only when their
controller, definition and _entire_ public interaction-relevant state match —
attack, health, marked damage, Ready/Exhausted, Newly Deployed, effective
keywords, a pending "will not Ready", whether Barrier is spent, and what they are
doing in this combat. The question feared that a strict key would split and
re-form constantly; three complete four-seat precon matches say otherwise. Across
275 sampled boards the strict key drew 631 tiles where definition-only drew 441
(1.43×), and the worst board Wave 1 produces — **117 `goblin_token` on one seat**
— came out as **two** tiles, 64 Newly Deployed and 53 Ready. Grouping by
definition alone would have hidden, on exactly that board, that 64 of them could
not attack. `attack`, `health` and `willNotReady` never split a group at all,
because Wave 1's buffs are board-wide and move a whole group at once.

A tile is **not** a targeting unit, and that is deliberate.
`groupByTokenDefinition` still expands a chosen Token into every Token of the
same _definition_ controlled by the same player, whatever state it is in, so
`containment_pulse` sweeps across several tiles on purpose. The `token_stack`
glossary entry tells the player both halves.

The layer is `apps/web-client/src/lib/token-grouping.ts` — pure functions over a
`PlayerView`, returning new arrays, with a group keyed by its **shared state**
rather than by any member's instance ID, because a group has no identity in the
engine and must not borrow one. Only Tokens group; a non-Token Unit is always its
own tile, and so is a unit the view does not describe. Expanding a tile renders
its members through the same `UnitCard` path a lone unit uses, so there is one
interaction path rather than two, and a **Stack tokens** toggle returns the
pre-M06 board exactly — which is what makes "grouping on/off is the same match"
checkable by playing rather than only by test. The multiset invariant (grouping
loses no Token and invents none) is asserted on every board the suite builds.

One protocol move, no schema moves: `barrierSpent` is now on
`CardInstanceView` and `PROTOCOL_VERSION` is 5 → 6. "Has Barrier" and "has
Barrier left" are different questions and only the first reached a client, so two
Tokens that answer combat completely differently were indistinguishable. It is
not a new disclosure — `barrier_consumed` is already an unredacted log event.
`MATCH_SCHEMA_VERSION` deliberately stays at 7: the field has been on
`CardInstance` since Barrier shipped, and it is the projection that changed
rather than the state. No replay, telemetry or manifest version moves, because no
artefact carries a view.

Since M06.2, a stack is something you can pick **out of**, and the layer that
draws one draws every list a Token can appear in. `groupBattlefield` is now
`groupEntities`, and the same call lays out a seat's units, a pending choice's
`validEntityIds` and the sources offering an activated ability — so sacrificing
one of sixty identical Tokens is one tile with an expansion rather than sixty
identical buttons, and a player ID or a `yes`/`no` option passes through as its
own tile because the view never described it as a Token. A tile is still not a
targeting unit: clicking one only expands it, and every action leaves through a
member drawn by the **same** function that draws a lone entity, so there is one
interaction path and one exact instance ID on the wire.

The key gains a thirteenth field, `selection`: the viewer's own uncommitted pick
— an attacker aimed at a seat, a blocker assigned to an attacker, an option
ticked in a choice. It is local and already on that player's screen, so no
observation boundary moves, and it earns its place twice. It makes a half-built
declaration readable on a board of a hundred Tokens, and it puts the aimed
Tokens in the same tile the engine's own `attacking` will put them in a moment
later, so confirming does not rearrange the board underneath the player. The
marker is also the words the tile prints, so a tile still cannot summarise a
group by anything that did not decide it. Divergence is deterministic in both
directions: a Token whose state changes joins the **existing** tile for its new
state rather than starting one, an open tile stays open across the move because
a tile is keyed by the state it stands for, and expansion is keyed by list plus
grouping key so two lists showing the same Tokens never share a tile or a DOM
id.

Two smaller repairs fell out of it. An activated ability is now one row per
ability with its sources laid out underneath, and each button **names its
source** — two identical Tokens offering the same ability were previously two
identical buttons with no way to tell which was about to fire. And the stack is
operable without a mouse: the tile's accessible name carries the count and the
shared state in words rather than "×11", the members are a labelled `group`
region whose entries are named "… 3 of 11", and Escape inside an open stack
closes it and hands focus back rather than making a player tab out past a
hundred Tokens. No version moves anywhere — nothing here leaves the client.

Since M06.3, the two surfaces that draw a battlefield draw it the **same way**,
and that is a property of the code rather than a pair of readings somebody keeps
in step. The spectator used to stack Tokens by definition alone — the reading
Q42 measured and rejected — so the worst board Wave 1 makes was one chip saying
×117 with no hint that 64 of them could not attack. It now calls the same
`groupEntities`, over the same projection: `instanceView`, the function that
builds every `PlayerView`'s instances, is exported and the spectator runs each
seat's battlefield through it, so a field added to the grouping key reaches both
surfaces at once. `groupEntities` takes a structural `GroupingSource` — instances
plus a combat state — rather than a `PlayerView`, which is what lets a spectator
frame satisfy it without redacting anything twice. `components/TokenStack.tsx` is
the shared tile: one summary, one expansion affordance, one set of accessible
names, with a class-name variant and a `renderEntity` function as the only two
things a surface may differ in.

Analysis Mode cannot change grouping semantics structurally rather than by
promise: only battlefield units are ever projected into the source, and the mode
decides whether a **hand** is shown. A hand is not part of a tile, and the tiles
are asserted identical in both modes on the same frame. Replay stepping reuses
M06.2's `selection` field — the Tokens the current step is about are marked and
leave their stack, because a highlight painted on a tile standing for a hundred
Tokens says the step was about all hundred. The spectator gains the same **Stack
tokens** toggle, and M06's last acceptance criterion is checked rather than
argued on the surface where it is easiest to doubt: the result panel's text is
byte-identical with stacking on and off, because the replay was recorded before
the screen rendered anything. No schema, protocol, replay or telemetry version
moves. M06 is complete.

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
