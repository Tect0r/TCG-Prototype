# Wave 1 — the staged test protocol for the first card batch

**Status:** the protocol that was actually used · **Last updated:** 2026-08-13

This is the record of how the first real batch of cards — the 155-card
`precon_wave_1` set and the four precons built from it — was taken from authored
JSON to a set that four bots can play a full four-seat match with. It replaces
the pre-authoring test plan, which was written before any Wave 1 card existed
and described stages the batch never went through.

Every stage below is a gate that exists in the repository today, with the command
that runs it and the failure it produces. Nothing here is aspirational: if a
stage says a check fails by name, that check has a name and a test.

## What the batch is

| Reading    | Value                                                    |
| ---------- | -------------------------------------------------------- |
| Set        | `precon_wave_1`, status `playtest`, card schema v4       |
| Cards      | 155 — 152 playable (4 of them Commanders) and 3 Tokens   |
| Format     | `precon_wave_1` — 40-card singleton, Commander outside   |
| Precons    | 4, one per colour, each with an authored deck plan       |
| Second set | `prototype_core`, status `development`, the fixture pool |

The live figures are generated: see [`../status-audit.md`](../status-audit.md),
which is rebuilt by `npm run audit:status` and compared byte-for-byte on every
test run. The table above is orientation, not a source.

## The stages

Order matters, and it is the cheap-and-local-first order. A card that fails
stage 1 cannot produce a meaningful stage 6 reading, and a batch run is the most
expensive way to discover a typo.

| #   | Stage              | Question it answers                                     | Command                            |
| --- | ------------------ | ------------------------------------------------------- | ---------------------------------- |
| 0   | Authoring          | Is this card expressible as structured data?            | `npm run cards:new -- --help`      |
| 1   | Content build      | Is it well-formed, supported, and consistent?           | `npm run content:check`            |
| 2   | Behaviour contract | Does the engine do what the card claims?                | `npm test -- card-contracts`       |
| 3   | Player-facing text | Does the prose match the behaviour, both ways?          | `npm run validate:content`         |
| 4   | Deck legality      | Is a deck of these cards playable by the server's rule? | `npm test -- deck`                 |
| 5   | Whole match        | Do four seats finish a real game with them?             | `npm run simulate -- --spectate …` |
| 6   | Batch evidence     | Does the whole matchup matrix run clean?                | `npm run simulate -- --config …`   |
| 7   | Pilot calibration  | Can the pilots that flew it play these decks at all?    | `npm test -- calibration`          |
| 8   | Repository gate    | Does the whole thing still hold together?               | `npm run verify`                   |

---

### Stage 0 — Authoring

One card, one file, under `content/sets/<set>/cards/<id>.json`. Scaffold it with
`npm run cards:new` and start from the closest of the eighteen templates in
[`../templates/cards/`](../templates/cards/); read
[`../ADDING_CARDS.md`](../ADDING_CARDS.md) first.

The rule that shapes everything downstream: **structured data is the card, prose
is presentation**. Nothing parses `displayText` into behaviour, so a card whose
effect is only written in its rules text has no effect at all — and stage 3 is
what catches that rather than a player.

A card that cannot be expressed is not authored around. It is recorded as a
blocking question in `IMPLEMENTATION_PLAN.md` and the tranche stops. Wave 1's
thirteen unfinished cards produced five schema features that way — delayed
effects, revival arrivals, statline-derived values, replacement effects, and
shared/divided choices — rather than thirteen special cases.

### Stage 1 — Content build

`npm run content:check` builds every set, format, precon and deck plan into the
generated bundle and fails if the committed bundle differs. It is the first gate
because it is the only one that sees the whole batch at once.

What it enforces, and where the severity comes from:

- **Schema** — `CARD_SCHEMA_VERSION` v5, per set, via its manifest. A manifest may
  declare an older version and be migrated up; it may not declare a newer one,
  which is refused with the version this build understands and the instruction to
  update.
- **Cross-references** — a Token a card creates, a card a precon lists, a
  Commander a precon names, a card a deck plan claims: all resolved, none
  dangling.
- **`implemented: false`** — a warning in a `development` set, an
  `content/unimplemented_card` **error** in a `playtest` or `active` one. This is
  why Wave 1's thirteen unfinished cards had to be finished before the set could
  be promoted, rather than shipped as inventory.
- **Derived mechanic support** — `content/unsupported_mechanic`. Support is not
  read off the card's own `implemented` flag; `describeCardSupport` walks the
  structured data and asks the M05.1 mechanic-support registry about every piece
  of it. A card built on a mechanic the engine does not execute is an error in a
  strict-status set even if its author marked it implemented.
- **Deck plans** — an error in **every** set status: required archetype roles
  supplied, no overlapping packages, every card in the format pool and in the
  precon the plan claims to describe, and the plan covering at most 75% of the
  deck. A misdescribed plan is a search input, not inventory.
- **Loader warnings promoted** — token resolution, colour leak and display-text
  lint run here, and any warning belonging to a strict-status set becomes an
  error.

Enforced in `packages/card-data/src/content/build.ts`; tested in
`build.test.ts`.

### Stage 2 — Behaviour contract

Every card in the set has one executable happy-path contract in
`packages/rules-engine/src/card-contracts/`: a board, the play, and an assertion
about what the engine did. The claim string is the test name, so a failure reads
as a sentence about the card.

Two things are checked separately, on purpose:

- **Coverage** — `registry.test.ts` fails by name when a card in
  `CONTRACT_SET_ID` has no contract, when a contract names a card the set does
  not contain, and when the count is not 155. A card can no longer arrive
  without a behaviour test.
- **The contracts themselves** — one case per card, driven through the real
  engine via `ContractTable`.

This is the stage that decides whether a card _works_. Stages 5–7 decide whether
it is _playable_, which is a different question and cannot substitute for this
one: a card that never gets drawn in a batch run is untested by that run.

### Stage 3 — Player-facing text

`npm run validate:content` checks the help layer, and `lintDisplayText` runs
inside the content build in **both** directions:

- `display_text/effect_mismatch` and `display_text/keyword_mismatch` — the prose
  promises something the card does not do.
- `display_text/unstated_effect` and `display_text/unstated_keyword` — the card
  does something the prose never mentions. Since M02.6 there is no exemption for
  hand-written help text.

Both directions matter for a first batch. The first catches a card that was
edited down; the second catches a card whose effect list grew during
implementation and whose text was never revisited.

Also checked here: every keyword a Wave 1 card prints has a glossary entry, and
the in-app rulebook reads its numbers from the live `RulesConfig` rather than
restating them. Nothing in `docs/rules/` is a second copy of player-facing
wording — that is the drift M07 exists to remove.

### Stage 4 — Deck legality

A batch of good cards is not a legal deck. `reviewPrecon` in `@tcg/deck` is the
single answer to "can this precon be played", layering a format check,
`validatePrecon` and `validateDeck` over the resolved copy — and the deck
builder, the lobby, the match server and the simulator all call it, so no
surface can call a precon playable by a rule another surface does not apply.

The refusal that matters for a card batch is
`deck/card_not_implemented` (and `deck/commander_not_implemented`): **an
unfinished card makes a deck illegal by name**. Nothing routes around it. The
spectator will run such a precon only under `--allow-incomplete-cards`, which
marks the replay and its telemetry `resultsValid: false` and warns on every
screen that shows the match.

The refusal is still under test against a synthetic unfinished card and a
doctored pool even though no shipped deck triggers it any more, because it has to
keep working for the next card somebody starts and does not finish.

### Stage 5 — One whole match

```bash
npm run simulate -- --spectate --seed wave1-check --players 4
```

Four bots, four precons, one deterministic match, printed telemetry. This is the
first stage where the cards meet each other: triggers stack, the board gets wide,
Reaction windows open, and a card that is individually correct can still deadlock
a turn.

Run it at 2, 3 and 4 seats. Some defects only ever appear above two seats: the
free-for-all once deadlocked when the **active** seat was eliminated during its
own turn, which a 1v1 is already over by the time it could happen.

The same match can be watched in the web client's spectator, which replays the
recorded log rather than re-deriving it.

### Stage 6 — Batch evidence

```bash
npm run simulate -- --config experiments/precon-smoke.json     # one game per seat order
npm run simulate -- --config experiments/precon-matrix.json    # the ordered matchup matrix
```

`precon-smoke.json` is the cheap version: the four precons named **by ID**, one
game per pairing, mirrored seats. Naming them by ID is deliberate — every failure
is fatal there (unknown ID, wrong format, a banned card, a duplicate), because a
run that names a shipped deck must not quietly play three of four.

`precon-matrix.json` is the complete ordered matrix: 6 × 2 ordered pairs plus 4
mirrors = **16 cells**. Completeness is recorded rather than assumed —
`expectedCells`, `missing` and `cleanGames` are in the artifacts — and the run is
required to be byte-identical at one worker and at four.

A batch is also the stage that finds defects in the _harness_ rather than in the
cards. The first precon smoke run found one: the simulator's `seatToAct` did not
know about Reaction windows, so a window whose priority sat with a non-active
seat was offered to the active player, who had no legal action at all, and the
match died in the pilot fallback. The generated fixture decks carry almost no
Reactions, which is why nothing before a real precon had caught it.

What to read from it: **termination, invariant failures and board telemetry**,
not win rates. The report says so itself, in bold, and the winner column is there
for auditability. A four-precon matrix at one game per cell is a robustness
artifact.

### Stage 7 — Pilot calibration

`packages/bot-interface/src/calibration/` holds sixteen hand-authored tactical
fixtures over the four precons: a board a person who knows the deck would
recognise, the single question it exists to ask, and the characteristic answer.
Each is driven through the same `playerView` + `legalActions` pair a networked
bot gets.

For a card batch this answers the question stage 6 cannot: **was the deck flown
at all?** A `knownGaps` entry records, by name, a pilot that misses the
characteristic decision and the part of its valuation that is blind to it — and
the suite asserts the record in both directions, so a gap that closes fails as
loudly as a decision that regresses.

Whether a deck can even pose a facet's question is derived from its cards, so
`precon_goblin_swarm` is never asked about sacrifice and `precon_grave_sacrifice`
is never asked about Reactions. `calibrationGaps()` is the coverage guard.

### Stage 8 — Repository gate

```bash
npm run verify        # content:check → typecheck → lint → format:check → validate:content → test → build
npm run audit:status  # regenerate docs/status-audit.md
```

`npm run verify` is the single completion gate; `npm test` alone is never enough.
The audit's derived half is compared byte-for-byte by the suite, so a new card, a
schema bump or an answered question **fails the tests until the audit is
regenerated**. That is the mechanism that keeps the counts in this document's
sibling files from going stale.

---

## What the protocol deliberately does not establish

- **Balance.** No stage above produces a balance conclusion, and the reports say
  so before they say anything else. A run's standing is derived from the agent
  classes that flew it, not from a field in a config file, and no pilot in this
  build implements the archetype-aware or human-playtest class.
- **That every card is good.** Stage 2 proves a card does what it claims once.
  Nothing here says the claim was worth making.
- **That the pilots are good players.** Stage 7 measures them and records where
  they are blind; it does not fix them.
- **Multiplayer balance.** Stages 5–6 run 2–4 seats for robustness. The
  analytical layer is 1v1 for the views that need a single opponent.

## Re-running this for the next batch

1. Author into `content/sets/<set>/` and keep the set's status honest —
   `development` while it is inventory, `playtest` when people will play it.
   The status is what turns stage 1's warnings into errors.
2. Write the behaviour contract in the same change as the card. The coverage
   guard will fail the suite otherwise, which is the intent.
3. Only promote the set to `playtest` when stage 1 is clean **without**
   `implemented: false`, because that is the gate the deck validator mirrors.
4. Run stages 5 and 6 at more than two seats before believing either.
5. Regenerate the audit and run `npm run verify`.

## Related

- [`../ADDING_CARDS.md`](../ADDING_CARDS.md) — the authoring reference.
- [`../rules/confirmed-rules.md`](../rules/confirmed-rules.md) — the rules a card
  is written against.
- [`../rules/entry-trigger-review.md`](../rules/entry-trigger-review.md) — the
  card-by-card `deployed` versus `entersBattlefield` record produced during this
  batch, regenerated with `npm run report:triggers`.
- [`../status-audit.md`](../status-audit.md) — the generated counts.
- [`../project-status.md`](../project-status.md) — where the project is.
