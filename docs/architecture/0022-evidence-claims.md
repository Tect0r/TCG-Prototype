# ADR 0022 — What a run may be cited for: support, pilots, decks, calibration

**Status:** accepted · **Date:** 2026-08-13 · **Extends:**
[ADR 0009](0009-bot-information-boundary.md),
[ADR 0011](0011-telemetry-and-provenance.md),
[ADR 0013](0013-statistical-contracts.md)

Recorded in M07.3 for decisions taken and implemented in M05.1–M05.6.

## Context

[ADR 0013](0013-statistical-contracts.md) fixed the estimators: a number the
laboratory prints is now computed the way its name says. That leaves the
question one level up, which no estimator can answer — **is this number about
anything?**

Three ways a perfectly-computed number can be meaningless, all of which were
live before M05:

- the cards in the deck use a mechanic the engine does not execute, no pilot
  values, or no record observes, so the run never exercised the thing being
  measured;
- the pilots that flew it cannot make the kind of decision the signal is about,
  so the flag describes the pilots;
- the decks were built by a process whose relationship to the signal is
  unstated, so the flag describes the generator.

Each was recorded in prose, in a limitations section, after the numbers. Prose
after the numbers is not a control.

## Decision

### 1. Mechanic support is a classification, not a sentence

`@tcg/card-data`'s support registry classifies every member of **seven**
executable vocabularies — instruction effects, continuous effects, triggers,
keywords, conditions, value expressions and costs — along four independent
dimensions: does the engine execute it, is it described to a player, can a pilot
play it, does a match record observe it. Each table is a total `Record` over a
vocabulary read off the schema, so adding a mechanic without classifying it is a
**compile error**, and each entry carries a note naming the module its claim is
about, so a downgrade is actionable rather than mysterious.

Support is then **derived, not claimed**. `mechanicsUsedBy` walks a card's
structured data — keywords, additional costs, all four effect lists, trigger and
instruction gates, value expressions, continuous effects, and the keyword a
`grant_keyword` hands out — and the content build **fails** a `playtest` or
`active` set containing anything the engine does not execute, warning instead in
a `development` set. `KEYWORD_REGISTRY.implemented` is a view of the registry
rather than a second claim beside it.

### 2. A pilot pays for what a card actually does

`EFFECT_PRICERS` is a total `Record` over `EffectType` rather than a `switch`,
so a new instruction is a compile error until somebody prices it and a **zero is
a decision rather than an oversight** — which is how `counter` came to be priced
as a blank card for the whole life of the Reaction mechanic without a test
noticing. `effectPricingGaps()` is its runtime twin in both directions.

Three further valuations stopped being proxies:

- **A keyword the engine does not execute is worth nothing.** `keywordIsValued`
  reads the support registry, so `resilient` costs a pilot nothing on a
  statline, a grant, a removal, a continuous layer or a `replace_arrival` — and
  implementing it will switch its valuation on in the same change that switches
  its behaviour on.
- **A continuous ability is priced by magnitude, scope reach, source-bound
  duration and which side of the table it lands on**, so one large layer
  outranks two tiny ones. The old `staticAbilities.length × buffValue × 2` could
  not tell any of those apart.
- **`costValue` is shared by all three places a cost is paid** — an activation, a
  played card's `additionalCosts`, and an activated ability priced inside
  `cardValue`. A Spell printing "as an additional cost, sacrifice a Unit" used to
  read as free.

### 3. A pilot is an instrument, not a skill level

`@tcg/bot-interface`'s agent class registry holds **four** classes —
random-legal, generic heuristic, archetype-aware, human playtest — against
**twelve** evidence claims, as a table total in both directions, so adding
either without deciding every pair is a compile error. Claims are phrased as
evidence rather than capability: `control` is not "the pilot plays counters", it
is "this run may be cited about reactive interaction".

`PILOT_AGENT_CLASSES` is total over `PILOT_IDS`, and `aggressive`, `defensive`
and `value` are **one class with three weight vectors**. Calling one of them the
better player would be exactly the pooled skill axis this decision exists to
refuse.

`FLAG_CLAIMS` maps every review signal to the claim it rests on — also total, so
a new signal is a compile error until somebody decides who may make it — and a
set of classes carries a claim only when **all** of them do, because the numbers
a flag is computed from pool every seat. Two consequences, both in the direction
of claiming less:

- a card-pair signal (`synergy`) and a counter-breadth signal (`control`) are
  declined by every run this build can produce, because no shipped pilot is
  archetype-aware;
- a run mixing `random_legal` with a heuristic declines its **pooled**
  play-quality signals. The properly flown arm is not discarded; it is reported
  in its own row.

`seat_sensitivity` deliberately survives a random-legal run: mirrored seats make
uniform play an unbiased probe of a turn-order advantage, and that claim is
named `structural_asymmetry` rather than folded into play quality.

Nothing is pooled across classes. `RunSummary` carries `agentClassWinRates`
beside the pilot rates, with an `unclassified` bucket for a pilot ID this build
does not know — an unrecognised pilot is not a weak agent, it is an
**unvouched-for** one, and it withdraws every claim rather than being read as
random-legal.

### 4. A deck says what it is made of, and a run says how its decks were built

The archetype registry names four strategies — `token_swarm`,
`defensive_attrition`, `sacrifice_value`, `reactive_control` — each with the
package roles a plan claiming it must supply, as a total `Record`. It names **no
card**, which is what keeps the vocabulary stable when the pool moves. Beside it,
authored **deck plans** in `content/deck-plans/` group a decklist into named
packages carrying a role, a rationale and a `core` flag.

A plan is content, so every claim it makes is checked by the content build —
required roles supplied, no overlapping packages, cards in the format pool, and
the Commander and every card actually in the precon it claims to describe — and
all of it is an **error in every set status**. An unimplemented card is
inventory; a plan that misdescribes a deck is a search input that steers a whole
population wrong.

A package is present **all or nothing**. That is what makes the two mutation
policies mean anything: `protect` never removes a card of an intact core
package, and `replace` removes one whole core package and refills the freed
slots **from the pool** rather than from the plan. A package that counted as
half-present would let a search dismantle an engine one card at a time and still
report it protected.

Two rules keep this from narrowing what a search can find:

- **Search explores outside plans structurally, not by configuration.**
  `MAX_PLAN_SHARE` caps a plan at 75% of the deck and the content build enforces
  it, so every plan-generated deck has free slots no generator setting can take
  away. `packagePolicy` defaults to `none`, byte-identical to the pre-plan
  operator.
- **`SimDeck.construction` is recorded, never inferred.** A random deck that
  happens to hold a whole package is still a random deck, and a shipped precon
  that contains its own plan whole is hand-authored **and** conforming — two
  separate facts. It sits outside the deck hash, because two identical lists are
  the same deck to the engine whoever built them.

### 5. Judgement is measured one hand-authored decision at a time

`packages/bot-interface/src/calibration/` holds sixteen tactical fixtures over
the four Wave 1 precons: a board a person who knows the deck would recognise,
the one question it exists to ask, and the characteristic answer. Each is driven
through the same `playerView` + `legalActions` pair a networked bot gets, so
nothing is calibrated against information no seat can see, and the boards are
built with the engine's own arrangement helpers — a fixture's board has to be a
board the engine could have produced.

Two structural rules make it an instrument rather than a wish. The facet
vocabulary is a total `Record`, so a facet without a question is a compile
error; and **whether a deck can pose a facet's question at all is derived from
its cards**, so the Goblin deck is never asked about sacrifice and the Grave deck
is never asked about Reactions without anybody claiming so in a table.

A fixture records what the pilot **actually does**. `knownGaps` names the pilots
that miss the characteristic decision and the part of the valuation that is
blind to it, and the suite asserts the record in **both directions**: a gap that
closes fails as loudly as a decision that regresses, because both mean the
written record has gone stale. Pilots are compared on identical positions by
construction — the seed is a function of the fixture ID alone, the board is
fixed, the opponent is scripted — so a disagreement is a difference in valuation
and cannot be luck. Nothing is ranked.

### 6. A signal that cannot be supported is downgraded, never dropped

A balance flag a run cannot carry becomes `insufficient_data` with its evidence,
interval and threshold **intact** and the reason appended to its message — when
every pilot is legality-only, when its subject card carries an unvalued
mechanic, or when its subject card does nothing a record observes. Dropping it
would hide the subject; printing it would overstate the run.

`run_quality` flags are untouched: "three matches ended abnormally" stays true
however blindly the pilots played.

Every batch opens with `## Calibration standing`, before the limitations and
before any number it could qualify. The standing is
`claimCarriedBy(classes, 'final_balance')` and nothing else — derived from the
agent classes that flew, **not a field in an experiment file** — so no
configuration promotes a run from an instrument reading to a balance conclusion.
"Until human sanity checks agree" is satisfied by a person flying the run, not
by editing JSON.

## Consequences

- Reports carry three independent sections between the review signals and the
  outcomes — `## Agent classes`, `## Deck construction`, `## Mechanic support` —
  which are the three halves of "is this evidence": the player, the deck's
  provenance, and the cards. They are counted apart and never averaged.
- The report states as a **fact about the software** that no pilot in this build
  implements archetype-aware or human playtest. It is not an omission to be
  fixed silently.
- Four registry versions pin what a citation was made against —
  `SUPPORT_REGISTRY_VERSION` **2**, `ARCHETYPE_REGISTRY_VERSION` **1**,
  `AGENT_CLASS_REGISTRY_VERSION` **1**, `CALIBRATION_SUITE_VERSION` **1**. A move
  here **re-judges** evidence rather than refusing it, which is why they are
  separate from the artefact schema versions that do refuse.
- A `knownGaps` entry changing does **not** bump the calibration version: that is
  a measurement moving, and the instrument is the same.
- Eight of the sixteen fixtures record a gap as of this date — seven missed by
  all three heuristic pilots, one missed by two of them — and they are the
  point: removal aimed by board value rather than by what the damage defeats,
  blocking that prefers a trade to a free block, one-play-at-a-time sequencing,
  an additional sacrifice cost outweighing what it buys, and nothing pricing
  Energy held for a window that has not opened. A match result cannot show you
  any of them. They are recorded, not fixed; `docs/status-audit.md` regenerates
  the counts, so this paragraph is the reasoning and that file is the number.

## Alternatives considered

**Rank the pilots and report a skill level.** Rejected. Three weight vectors of
one class are not three skill levels, and a pooled ranking would invite exactly
the citation ("the good bot preferred this card") the class table exists to
refuse.

**Suppress a flag a run cannot support.** Rejected for the same reason
[ADR 0013](0013-statistical-contracts.md) refuses to suppress on multiplicity: a
missing flag is a false negative nobody can see, while a downgraded one is a
finding with its own reason attached.

**A `finalBalance: true` field in the experiment configuration.** Rejected
outright — it makes the strongest claim in the system a thing anybody can grant
themselves with a text editor.
