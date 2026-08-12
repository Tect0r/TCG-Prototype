# M03 — Precon integration and deterministic matchups

## Preconditions

- M01 complete.
- M02 complete; all four precons validate with no incomplete cards.

## M03.1 — Deck-builder precon browser — DONE (2026-08-12)

Use the existing bundled precon loader and copy-to-deck logic.

Required:

- list named precons for the active format;
- inspect the complete Commander and 40-card list;
- show legality/incompatibility reasons;
- copy a precon into a new editable saved deck without mutating the built-in;
- preserve permanent precon IDs and format ID;
- do not mix development fixtures into Wave 1.

Delivered:

- `PreconBrowser` (`apps/web-client/src/components/PreconBrowser.tsx`) is a modal
  over the deck builder, opened from the "Precons" button in `DeckToolbar` and
  closed by Escape or the close button through the existing `useDialog` plumbing.
  It lists the precons for `useDeckFormat().formatId` — an inline filter over
  `BUNDLED_PRECONS` here, moved to the shared `preconsForFormat` in M03.2 — so
  the builder's precon list is scoped exactly like its card pool: a `development`
  fixture deck cannot appear beside Wave 1, and a format with no published
  precons says so rather than falling back to another format's.
- Inspection shows the strategy line, the Commander with its colour identity,
  all 40 cards with cost and type, and the precon's own permanent `id` and
  `formatId` on screen. A card ID the pool cannot resolve is listed as itself and
  marked, never dropped.
- Legality comes from a new shared `reviewPrecon(precon, database, format)` in
  `@tcg/deck`, which answers "can this be played here" in ordered layers:
  `precon/format_mismatch` first, then `validatePrecon` on the definition, then
  `validateDeck` on the copy the player would get. The panel renders whatever it
  returns through the existing `IssueList`. Nothing about legality is decided in
  the component, so the builder cannot present a precon as playable by a rule the
  match server does not share.
- Copying goes through `AppActions.copyPrecon`, which is the only path from the
  panel to saved state: it calls the existing `preconToDeck` with a fresh
  `generateId('deck')`, a `uniqueDeckName` so a second copy does not shadow the
  first, and the current timestamp. The new deck becomes active, the panel
  closes onto the builder, and a notice says the built-in precon is unchanged.
- `uniqueDeckName(name, existing, { suffix })` is new in `@tcg/deck`
  `operations.ts`; `prepareImportedDeck` now uses it with `suffix: 'imported'`
  instead of its own inline copy of the same loop. Behaviour is unchanged.

Interpretation recorded rather than assumed: "preserve permanent precon IDs and
format ID" is read as _addressing and displaying_ precons by their permanent ID
under their declared format — which is what the panel does — and **not** as
stamping provenance into `SavedDeck`. Adding a field to the saved-deck schema is
a persisted-shape change, and nothing in M03 needs it: a copy is an ordinary user
deck from the moment it is made, and M03.2 starts matches from either the
built-in precon (by ID) or a saved deck (by contents).

Evidence:

- `packages/deck/src/precon.test.ts` — all four precons are playable under
  `reviewPrecon` in their own format; a Wave 1 precon checked against the
  development format reports `precon/format_mismatch` **once** rather than forty
  missing cards; a broken definition stops before deck validation; an unfinished
  card in a doctored pool is named with its `unsupportedReason`; the precon is
  not mutated by being reviewed.
- `packages/deck/src/operations.test.ts` — `uniqueDeckName` leaves a free name
  alone, suffixes then numbers a taken one, compares case-insensitively, and
  honours a caller-chosen suffix.
- `apps/web-client/src/precon-browser.test.tsx` — the panel lists all four Wave 1
  precons, closes on Escape and restores focus, shows nothing but an explanation
  under the `development` format, renders the Commander plus all 40 cards and
  both permanent IDs, reports "Ready to play" for the shipped decks and names the
  blocking card against a doctored pool, copies into a saved 40-card legal deck
  while `BUNDLED_PRECONS` stays deep-equal to its snapshot, and gives a second
  copy its own name and ID so editing one leaves the other at 40 cards.
- `npm run verify` passes.

## M03.2 — Start matches from precons — DONE (2026-08-12)

Allow a selected built-in precon or its saved copy to enter the normal local and
server validation flow. The server must validate the same definition/pool the UI
presented. Add an end-to-end test for one valid and one tampered precon.

Delivered:

- A precon is now a thing you can play, not only copy. The lobby's deck picker
  (`apps/web-client/src/components/match/LobbyScreen.tsx`) lists the built-in
  precons for the active format in one group and the player's saved decks in
  another, and previews either with the same shared functions the server runs —
  `reviewPrecon` for a precon, `validateDeck` for a saved deck.
- **A precon travels as an ID, never as a list.** New protocol message
  `submit_precon { preconId }` (`PROTOCOL_VERSION` 3 → 4) carries nothing else;
  `MatchServer.submitPrecon` resolves the ID against its own bundled content,
  reviews it with `reviewPrecon(precon, database, deckFormat)`, and materialises
  the deck server-side with `preconToDeck`. So the definition the server
  validates is the definition the UI presented, and the wire has nothing on it
  to tamper with. A precon a player has edited is an ordinary saved deck and
  still goes through `submit_deck`, where it is judged on its contents — the
  precon's name buys it nothing.
- One format-scoped list behind all three surfaces: `preconsForFormat(formatId)`
  is new in `@tcg/card-data`, and the deck-builder browser, the lobby picker and
  the server's "published precons" answer all read it. It is the precon
  equivalent of `formatCardPool`: a `development` fixture deck cannot appear
  beside Wave 1, and a format with no precons gets an empty list rather than
  another format's.
- Error handling is layered rather than flattened. An ID that names nothing is
  `protocol/unknown_precon`, sent as a `deck_rejected` so it lands in the deck
  panel next to the picker, and the seat keeps whatever it had already submitted
  — a bad ID is not a submission. An ID that names a precon built for another
  format is _resolved_ and then refused by `reviewPrecon` with
  `precon/format_mismatch`, which says which format, rather than being reported
  as unknown. `submitDeck` and `submitPrecon` now share one `recordSubmission`,
  so a seat's deck and its legality verdict are still written in exactly one
  place.
- Player-facing text follows: the rulebook's match setup step says a deck may be
  a built-in precon picked by name or a saved deck, "Building a deck" gains a
  note that you do not have to build one, and the lobby's empty-deck hint no
  longer sends a player to the builder as their only option.

Interpretation recorded rather than assumed: the seat's public `deckName`
becomes the precon's name, which tells the table which stock list a seat is
playing. That is not a new information boundary — `deckName` is already public
and a copied precon keeps its name by default — so no precon ID is added to
`LobbySeatView`. Broadcasting the ID itself would hand opponents an exact
40-card list through the protocol rather than through a name the player chose.

Evidence:

- `apps/multiplayer-server/src/precon-match.test.ts` — every Wave 1 precon is
  accepted by ID and seated as the shipped list (commander, all 40 IDs in order,
  every quantity 1) on a server wired the way `main.ts` wires it; the preview's
  `reviewPrecon` verdict and the server's agree; two precons start a match and
  both seats are dealt an opener; the same precon may be played at both seats; a
  tampered copy submitted under the precon's own name is refused as
  `protocol/deck_illegal` and cannot ready up or start; choosing the untouched
  precon afterwards replaces the tampered submission; an unknown ID is
  `protocol/unknown_precon` and leaves the seat's legal deck alone; a server
  running `development` resolves a Wave 1 ID and refuses it by format.
- `apps/multiplayer-server/src/ws-integration.test.ts` — the same valid and
  tampered cases over a real socket, on a server now wired to the shipping
  format pool rather than the bundled universe.
- `apps/web-client/src/match-flow.test.tsx` — the lobby lists all four precons
  beside the saved deck; choosing a precon sends exactly
  `{ type: 'submit_precon', preconId }` and no `submit_deck`; a saved deck still
  travels by contents; the precon preview reports no legality problem.
- `packages/card-data/src/default-set.test.ts` — `preconsForFormat` returns only
  that format's precons in file order, and is empty for a format with none
  rather than falling back.
- `npm run verify` passes.

## M03.3 — Precons in experiment configs — DONE (2026-08-12)

Allow simulator experiment configs to reference precons by stable ID rather than
duplicating card lists. Resolve IDs into a frozen environment at experiment
start and record the IDs plus all normal content/mechanics hashes in manifests.
Unknown/incompatible precons are errors, never substitutions.

Delivered:

- A fourth deck source, `{ "kind": "precon", "preconIds": [...] }`
  (`apps/simulator/src/config.ts`). The IDs are validated at parse time against
  the same `preconIdSchema` a precon definition uses — now exported from
  `@tcg/card-data` so addressing a precon and defining one agree on what an ID
  can look like — and nothing else about the deck is in the config. A precon
  travels as an ID here for the same reason it does over the match protocol in
  M03.2: forty duplicated card IDs would go stale the moment the shipped precon
  was re-authored, and the experiment would then measure a deck nobody plays
  while still carrying the precon's name.
- `resolveDeckSource` resolves each ID with `bundledPrecon`, reviews it with the
  shared `reviewPrecon(precon, database, deckFormat)`, and materialises it with
  `preconToDeck` — the same three steps the deck builder, the lobby and the
  match server take. The resulting `SimDeck` keeps the precon's ID and name and
  hashes identically to the same list written inline, so a precon experiment and
  an inline one that happen to describe the same deck share a deck identity.
- **Four ways to fail, all of them errors.** An unknown ID, a precon built for
  another format, a precon the environment's bans or pool would gut, and the
  same precon listed twice each throw and stop the experiment. This is
  deliberately stricter than the other sources, which report a rejected deck and
  carry on: those describe decks the experiment invented, so dropping one costs
  sample size, whereas a precon source _names_ a shipped deck and dropping one
  would leave a run reporting on "the four precons" having played three. The
  unknown-ID message lists the precons published for the environment's format.
- **`environment.format` and `environment.sets` now scope the pool.** They were
  documented as selecting content and did nothing: every environment resolved
  against the entire bundled universe, which is what CLAUDE.md's "a playable pool
  comes from a format-scoped database" invariant exists to forbid, and it would
  have made a Wave 1 precon experiment record a manifest whose pool included the
  development fixtures. A named format now resolves through `formatCardPool`,
  named sets replace the format's set selection while keeping its bans, and an
  unknown format or set is a hard error naming the environment. An environment
  that names neither still resolves to the whole universe, because the Phase 1–4
  fixture configs are written that way and their recorded hashes must not move.
- Manifests record the precons (`manifest.schemaVersion` 2 → 3): each ID with
  its format, Commander and the hash of the deck it resolved to, sorted by ID,
  beside the environment hashes and the frozen snapshot that pin what those IDs
  meant on the day of the run. The report's provenance table names them the same
  way. `referencePopulation.json` carries them too, as provenance only — the
  population hash still covers Commanders and quantities alone, so recording
  where a deck came from cannot change whether two populations are judged equal.
- `experiments/precon-smoke.json` is a worked example: the four Wave 1 precons by
  ID, in a `precon_wave_1` environment, round-robin, one game per seat order.

**Defect found and fixed while verifying this tranche.** The first precon smoke
run lost one match in twelve to
`random_legal was asked to decide with no legal action available`. The simulator's
`seatToAct` (`apps/simulator/src/run-match.ts`) knew about pending choices,
mulligans and outstanding blocker submissions but not about Reaction windows, so
whenever a window's priority sat with a non-active seat it asked the active
player instead — who correctly had no legal action at all, at which point the
pilot and its random-legal fallback both had nothing to return and the exception
took the match with it. It had never shown up because the generated fixture decks
these tests were written against carry almost no Reactions. `seatToAct` now
returns the window's priority holder, and deliberately does not invent a seat for
a _closed_ window, which the engine's resolution queue drains inside
`applyAction` without asking anybody.

Interpretation recorded rather than assumed: "incompatible" is judged against the
environment's declared `deckFormat`, not against a format looked up from the
precon. That follows the rule `environmentConfigSchema` already states — an
experiment writes its construction rules out in full so a later edit to
`content/formats` cannot redefine a finished run — and it means an environment
that scopes its pool to `precon_wave_1` but leaves `deckFormat.formatId` at the
default `custom` is told its precon belongs to another format rather than being
quietly run under the wrong construction rules.

Evidence:

- `apps/simulator/src/precon-source.test.ts` — all four Wave 1 precons resolve to
  their shipped 40-card singleton lists with the right Commander and are legal
  under `checkDeck`; a precon resolves to the same deck hash as the identical
  inline list; the provenance array ties each ID to a deck hash; an unknown ID,
  a Wave 1 precon in a `development` environment, an environment banning one of
  the precon's cards, and a repeated ID each throw; a malformed ID is refused by
  the config schema; a named format scopes the pool and excludes the fixtures,
  named sets do the same, no format still resolves the universe, and an unknown
  format or set throws; the shipped example config parses and resolves; and a
  four-precon batch runs every pairing to a normal victory with
  `failedMatches: 0`, writing `manifest.schemaVersion: 3`, the four IDs, their
  deck hashes, the format on the environment and the snapshot, and the precons
  in `report.md`.
- `apps/simulator/src/run-match.test.ts` — `seatToAct` returns the priority
  holder of an open Reaction window and the active player for a closed one.
- `npm run verify` passes.

## M03.4 — Ordered matchup matrix — DONE (2026-08-12)

Add a deterministic runner for every ordered pair of the four precons over fixed
seeds. Four decks produce 16 ordered matchups when mirrors are included. Keep
this a smoke/robustness artifact until M05 makes pilots balance-trustworthy.

Record:

- seed hierarchy and seat order;
- precon IDs, pilot IDs, format, and hashes;
- winner/termination and invariant failures;
- replay reference for failures or selected interesting matches.

Delivered:

- **A batch may now be asked for the whole ordered matrix**, with one setting:
  `orderedMatchupMatrix: true` (`apps/simulator/src/config.ts`). It is a
  configuration flag rather than a sixth experiment kind because the matrix is a
  particular _schedule_ of the batch that already exists — the same environment,
  the same deck sources, the same records, the same resumable stream — and a
  parallel kind would have duplicated all of that in order to change which deck
  tuples get seated.
- **Mirrors, without double-counting them.** `buildSchedule` gains
  `includeMirrorMatchups`, which enumerates deck tuples as combinations _with_
  repetition (`deckMultisets`) instead of without. A tuple's seat orientations
  are now its number of _distinct_ rotations (`distinctRotationCount`) rather
  than its length, so `[A, A]` contributes one ordered matchup and not two
  identical tables on different seeds, while every tuple of distinct decks keeps
  exactly the orientations it always had. Four decks therefore produce
  6 × 2 + 4 = 16 ordered matchups. A schedule that does not include mirrors is
  byte-identical to before, which is asserted rather than asserted-by-hand.
- **The artifact** is `matchup-matrix.json` (`apps/simulator/src/matchup-matrix.ts`),
  with a flat `matchup-matrix.csv` beside it and a report section between the
  outcome tables and the clusters. Per game it records the seat order with each
  seat's deck, deck hash, Commander, pilot ID, pilot version and pilot seed; the
  starting player; the complete seed bundle including the derivation path; the
  termination, outcome, winner, winning deck and turn count; every invariant
  failure; and the replay path. Per run it records the decks with the precon IDs
  they came from, the construction format, the environment hash, the pilots as
  they actually played, and the seed and configuration hash the whole hierarchy
  descends from.
- **Completeness and cleanliness are recorded, not assumed.** `expectedCells` is
  `n²`, `missing` names any ordered pair that produced no record, and `complete`
  is the two compared; `cleanGames` counts games with no invariant failure at
  all. `manifest.json` (schema 3 → 4) carries the same six numbers, so "every
  ordered pair ran and terminated cleanly" is a claim the manifest either makes
  or visibly declines to make. An abnormal match stays in the cell it belongs
  to — hiding it would turn a broken pairing into a missing one.
- **The framing is enforced by the artifact itself.** The report section is
  titled as an observation, states in bold that it is a robustness artifact and
  not a balance measurement, says why the winner column is present (auditability)
  and what may not be read from it, and the run adds a matching entry to
  "Limitations, first". Report schema 2 → 3.
- `experiments/precon-matrix.json` is the shipped runner: the four Wave 1
  precons by ID, in a `precon_wave_1` environment, round-robin, one game per
  ordered pair, every replay retained.

Interpretation recorded rather than assumed: the settings that would make a
complete matrix impossible are **refused at parse time**, not adjusted.
`orderedMatchupMatrix` with `playerCount` other than 2, with a `sampled`
schedule, or with `mirrorSeats: false` is a configuration error naming which of
the three is wrong. An artifact called "the ordered matchup matrix" that quietly
omitted cells would be worse than one that will not run, and silently rewriting
a player's configuration to make its own name true is the other thing this
project does not do.

A mirror's `firstSeatWins` / `secondSeatWins` is deliberately a statement about
the _seat_, not the deck — the only thing a deck playing a copy of itself can be
evidence about — and the report says so in the line that explains the grid.

Evidence:

- `apps/simulator/src/schedule.test.ts` — `deckMultisets` adds exactly one mirror
  per deck to the combinations; `distinctRotationCount` collapses `[0, 0]` to one
  seating and leaves `[0, 1, 2]` at three; a mirror-inclusive four-deck schedule
  is all 16 ordered pairs with 16 distinct match IDs; a mirror is scheduled once,
  at orientation 0; and the non-mirror half of a mirror-inclusive schedule is
  deep-equal to the schedule without the option.
- `apps/simulator/src/matchup-matrix.test.ts` — the builder gives every ordered
  pair its own cell and flags the diagonal; a missing pair is named rather than
  dropped; seat order, winning deck and the seed path survive into the artifact;
  a deck's precon ID is carried; an abnormal termination and a diagnostic both
  surface as invariant failures with their replay while the cell stays present;
  the result is order-independent and validates against its own schema; a
  four-seat record in the same stream is left out; the three refused
  configurations each throw with their own reason; and the shipped config names
  the four precons published for `precon_wave_1`.
- The same file runs `experiments/precon-matrix.json` end to end: **16 records,
  16 of 16 cells played, 16 of 16 games clean, no invariant failure, every match
  a normal victory**, with the artifact on disk equal to the returned one, 16
  distinct seed paths, a 17-line CSV, the manifest at schema 4 with the matrix
  block, and the report carrying both the grid and its no-balance-claim wording.
- Cross-checked outside the suite: the shipped config run at `--workers 4` and at
  `--workers 1` produces byte-identical `matchup-matrix.json`.
- `npm run verify` passes.

## Acceptance

- A player can discover, inspect, copy, edit, save, and launch every precon.
- Client, server, spectator, and simulator resolve the same precon definitions.
- All ordered matchups terminate deterministically with no illegal action, loop,
  or crash.
- Reports explicitly avoid balance claims at this stage.

## Exclusions

- Archetype-aware pilot strategy.
- Final win-rate/balance conclusions.
- Token grouping.
