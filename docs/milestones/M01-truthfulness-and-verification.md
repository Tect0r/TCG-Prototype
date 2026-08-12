# M01 — Truthfulness and verification

## Objective

Make every shipping entry point describe and validate the same implemented game
before adding more mechanics. Complete one tranche at a time.

## M01.1 — Format-scoped client and server pools — DONE (2026-08-11)

Problem at baseline:

- `apps/web-client/src/main.tsx` loads the entire bundled universe.
- the deck builder then exposes both `prototype_core` and `precon_wave_1`.
- `apps/multiplayer-server/src/main.ts` validates against the same unscoped
  universe.

Required:

- Resolve the active format explicitly and use `formatDatabase(formatId)` or
  the equivalent shared format-pool API in both client and server.
- Preserve the development-format test path explicitly.
- Add integration tests proving a development fixture cannot enter a Wave 1
  deck on either side and that client/server accept the same legal pool.

Stop after focused tests and `npm run verify` pass.

Delivered:

- `loadFormatCardData(formatId)` and `resolveFormatId(requested?)` in
  `@tcg/card-data` are the shared format-pool API. `loadFormatCardData` returns
  a `Result`: the format-scoped `database`/`sets` plus the resolved
  `formatId`/`format`, or structured `card_data/unknown_format` /
  `card_data/unknown_format_set` errors. `formatCardPool` and it now share one
  scoping rule, so the pool cannot be computed two ways.
- `apps/web-client/src/main.tsx` resolves the format explicitly and passes both
  the scoped database and `deckFormatOf(format)` to `AppProvider`, so the
  builder's pool and its construction limits come from the same format.
- `apps/multiplayer-server/src/main.ts` does the same for `MatchServer` and
  fails to start (with the issues printed) if the format does not resolve.
- `LobbyScreen` now previews legality with the active format instead of the
  library default, which is what made the client preview able to disagree with
  the server verdict.
- Development-format path preserved and explicit: `VITE_TCG_FORMAT` (client),
  `TCG_FORMAT` (server), `loadFormatCardData('development')` in tests. A blank
  request means the shipping format; an unknown ID is refused, never silently
  replaced with the default.

Evidence:

- `packages/card-data/src/default-set.test.ts` — resolution rules, Wave 1 pool
  excludes every fixture card and Commander, universe still resolves them,
  development pool still served, unknown format is a structured error.
- `apps/multiplayer-server/src/format-pool.test.ts` — a Wave 1 deck holding
  `goblin_scout` is rejected by name, cannot ready up, and a real precon deck
  starts a match from the scoped pool; the same two decks get the same verdict
  from the builder's `validateDeck` as from the server.
- `apps/web-client/src/format-pool.test.tsx` — no `prototype_*` Commander in
  the picker, no fixture card in the browser under a red Commander (with a
  Wave 1 red card as the positive control), a saved fixture card is flagged,
  and the deck panel shows 40-card Wave 1 limits.
- `npm run verify` passes (63 files, 972 tests, production build).
- `npx tsc -p tsconfig.json --noEmit` still fails only in `scripts/new-card.ts`
  and `scripts/report-triggers.ts`, unchanged by this tranche and owned by
  M01.5.

## M01.2 — Reject incomplete Commanders and spectator precons — DONE (2026-08-11)

Problem at baseline:

- `validateCommander()` does not reject `implemented: false`.
- spectator setup resolves precons without normal legality validation and can
  run incomplete cards as blank cards.

Required:

- Add a stable `deck/commander_not_implemented` validation error.
- Validate each selected spectator precon with the shared format database and
  deck validator before constructing seats.
- Normal spectator launch must refuse incomplete decks and name every blocking
  card. A deliberately named developer override may exist only if it displays a
  persistent "results invalid" warning and marks replay/telemetry provenance.
- Add Guardian-Commander and Sacrifice-precon regression tests.

Do not make incomplete effects execute as no-ops.

Delivered:

- `deck/commander_not_implemented` is a stable error in `validateDeck`, raised
  against `commanderId` with the card's own `unsupportedReason`. It mirrors the
  existing `deck/card_not_implemented` rule and applies everywhere the shared
  validator already runs: deck builder, lobby preview, and match server. The
  Commander is still returned to the rest of the validator, so colour identity
  and the deck list are still checked against it.
- `resolveSpectatorSetup(setup, { database })` validates every seat by copying
  the precon through `preconToDeck` and running `validateDeck` against the
  format database the match will actually be played on, with the precon's own
  `preconFormat`. Seats are constructed only from precons that pass. Problems
  now carry a `kind` (`unknown_precon` / `illegal_deck` / `incomplete_cards`)
  and the blocking `cardIds`, and the message names each one.
- Developer override: `SpectatorSetup.developerAllowIncompleteCards`, exposed as
  `--allow-incomplete-cards` on `npm run simulate -- --spectate` and as a
  labelled checkbox on the spectator setup screen. It waives _only_ the two
  not-implemented codes. Any other illegality — size, singleton, colour
  identity, a card outside the pool — is still refused with the override on.
- Provenance: `spectatorReplaySchema` gained a required `provenance`
  (`resultsValid` plus per-seat `incompleteCards`), `spectatorTelemetrySchema`
  gained `resultsValid` so a telemetry row lifted out of its replay still says
  it does not count, and `runSpectatorMatch` writes a `results invalid:` line
  into the replay diagnostics naming every card. `setupProvenance(resolved)` is
  the only place the verdict is derived, so a caller cannot run an overridden
  setup and record it clean. `SPECTATOR_REPLAY_VERSION` is 2: version 1 replays
  are refused, because they were recorded before this gate existed and may
  contain cards that ran as something other than what they print.
- Persistent warning: the setup screen lists the blocking cards per seat, the
  playback screen carries a non-dismissible `role="alert"` banner above the
  board for the whole match, the result screen repeats it, and the CLI prints
  it before and after the telemetry.

Consequence, recorded rather than worked around: all 13 unimplemented cards sit
inside the four shipped precons and one of them is the Bastion Commander, so no
shipped precon is legal today. Multiplayer accepts a hand-built Wave 1 deck (the
red pool is exactly 40 implemented cards under Goblin Warboss) and the spectator
needs the override until M02 lands. Nothing was relaxed to avoid this.

Evidence:

- `packages/deck/src/validate.test.ts` — a Commander marked unimplemented on a
  synthetic database makes an otherwise legal deck illegal, is the _only_ error
  raised, reports against `commanderId`, and does not stop colour identity being
  checked. Synthetic on purpose, so the rule stays tested after M02.
- `packages/deck/src/precon.test.ts` — the Guardian precon is blocked by its
  Commander, the Sacrifice precon names every unfinished card, and every bundled
  precon is legal exactly when nothing in it is unfinished.
- `packages/spectator/src/spectator.test.ts` — normal setup refuses the
  Sacrifice precon and the Guardian Commander by name; the override runs them
  and records every blocking card; the override does not rescue a deck that is
  illegal for another reason (same precon against the development pool); a
  recorded match carries `resultsValid: false` in its replay, its telemetry and
  its diagnostics, and survives a JSON round trip.
- `apps/multiplayer-server/src/format-pool.test.ts` — the server refuses the
  Guardian precon over the wire naming the Commander, refuses the Sacrifice
  precon naming each unfinished card, and still starts a match from a legal
  hand-built Wave 1 deck.
- `apps/web-client/src/spectator-flow.test.tsx` — the default configuration
  cannot be started, the override enables it and shows "Results invalid", and
  the warning is still on screen during playback and on the result.
- `npm run verify` passes (63 files, 991 tests, production build).
- `npx tsc -p tsconfig.json --noEmit` still fails only in `scripts/new-card.ts`
  and `scripts/report-triggers.ts`, unchanged by this tranche and owned by
  M01.5.

## M01.3 — Mechanics-complete replay hashes — DONE (2026-08-11)

Problem: `packages/spectator/src/setup.ts#cardPoolHash` omits
`additionalCosts`, so a replay may remain "compatible" after cost behavior
changes.

Required:

- Hash every mechanics-bearing card field, including `additionalCosts` and
  structured zone/activity fields.
- Prefer one canonical mechanics snapshot/hash helper shared by environments and
  spectator replay code over another hand-maintained field list.
- Add a test where changing only an interactive sacrifice cost changes the hash.

Delivered:

- `packages/card-data/src/mechanics.ts` is the single canonical projection.
  `CARD_FIELD_KINDS` classifies **every** field of `CardDefinition` as
  `identity` / `mechanics` / `pilot` / `presentation`, typed as
  `{ [K in keyof CardDefinition]-?: CardFieldKind }` — so adding a field to the
  card schema without classifying it is a compile error rather than a silently
  unhashed mechanic. It lives beside the card schema, which is the only place
  that guarantee can be enforced. `cardMechanics`, `cardPilotMetadata` and
  `cardPresentation` are projections derived from that map;
  `cardPoolMechanicsJson` is the pool-level snapshot, sorted by card ID and
  canonically serialized.
- Both hand-maintained field lists are gone. `cardPoolHash` is now
  `hashString(cardPoolMechanicsJson(database.all()))`, and
  `apps/simulator/src/content-hash.ts` re-exports the shared projections instead
  of defining its own. The digests stay separate on purpose: the simulator uses
  SHA-256 from `node:crypto`, and the spectator's FNV-1a also runs in the
  browser, so the _snapshot_ is shared and the digest deliberately is not.
- Fields the old lists could not see, now hashed. The spectator's omitted
  `additionalCosts`, `colorIdentity`, `tags`, `unique`, `collectible` and
  `implemented`; the simulator's omitted `additionalCosts`, `reaction` and
  `implemented`. Structured zone/activity fields (`activeZone`, `usageLimit`,
  `timing`, trigger scopes) were already inside the ability objects both lists
  hashed whole, and are now covered by a test that says so.
- Four classifications are argued rather than assumed, at the definition:
  `additionalCosts` is mechanical because it is paid before the card is queued
  and never refunded; `implemented` is mechanical because `validateDeck` refuses
  a deck containing an unimplemented card (M01.2), so flipping it changes which
  decks exist; `unique`/`collectible`/`tags` are mechanical because deck legality
  and `CardFilter` read them; `schemaVersion` is mechanical because it states
  which reading of the same JSON the data was written for, and a migration that
  stamps a default (v3 → v4 wrote `activeZone` onto every ability) changes
  behaviour without changing an authored field. `unsupportedReason` stays
  presentation — it is the sentence shown beside the card, and `implemented`
  next to it is what decides anything.
- Ordering is canonicalized only where order is not meaning: `colorIdentity`,
  `keywords` and `tags` are sorted, and `effects` / `additionalCosts` / the
  ability lists are left alone, because an effect list is a sequence of
  instructions and "if you do" refers to the one before it.
- Incidental correctness fix inside the shared helper, not a separate change:
  the simulator's pilot projection read `design.roles`, `design.archetypes` and
  `design.complexity` — names the card schema has never had — so every authored
  design label hashed as `null` whatever it said. The shared projection reads
  `design` itself.

Consequence, recorded rather than worked around: every environment hash and
every spectator `cardDataHash` moves. That is the tranche's purpose — the
replays this invalidates are exactly the ones recorded under a hash that could
not see the costs they were played with. `SPECTATOR_REPLAY_VERSION` stays at 2:
the replay _format_ is unchanged, and the existing `cardDataHash` check is what
refuses the old recordings, with the field named in the compatibility report.

Evidence:

- `packages/card-data/src/mechanics.test.ts` — changing only a sacrifice cost's
  `selection` from `player_choice` to `automatic` changes the snapshot; so does
  adding, resizing or removing an additional cost, moving an ability's
  `activeZone`, flipping `implemented`, and changing `unique` / `collectible` /
  `colorIdentity` / `tags`. Reordering two instructions changes it; renaming the
  card, rewording its text or relabelling its design does not; pool order and
  the order a set-valued field was written in do not. Plus a runtime complement
  to the compile-time guard: every key a parsed card carries is classified.
- The compile-time guard was verified by deleting `additionalCosts` from
  `CARD_FIELD_KINDS`: `tsc` fails with
  `TS2741: Property 'additionalCosts' is missing`.
- `packages/spectator/src/spectator.test.ts` — `cardPoolHash` over a real Wave 1
  pool moves when one Spell gains an interactive sacrifice cost, moves again
  when only that cost's `selection` changes, and `checkReplayCompatibility`
  reports `cardDataHash` for a replay recorded across that change.
- `apps/simulator/src/frozen-environment.test.ts` — `mechanicsHash` moves for an
  additional cost being added and for its `selection` changing, and for a card
  becoming unimplemented; `pilotInputHash` moves for a design label, which it
  previously could not.
- `npm run verify` passes (64 files, 1009 tests, production build).
- `npx tsc -p tsconfig.json --noEmit` still fails only in `scripts/new-card.ts`
  and `scripts/report-triggers.ts`, unchanged by this tranche and owned by
  M01.5.

## M01.4 — Correct in-app rules and glossary — DONE (2026-08-11)

Audit `packages/help-content/src/data/rulebook.json`, registries, glossary, and
their tests against the engine and ADRs 0016/0017.

At minimum correct:

- deployable Commanders, printed Commander costs, defeat return, and cost tax;
- Wave 1 singleton construction and format-aware wording;
- Reaction windows and opponent-turn Energy use;
- Energy remains available through opponents' turns and refills on the owner's
  next turn;
- Guardian behavior;
- Rush/Newly Deployed terminology instead of Swift/summoning-sickness claims;
- unlimited Units and one active Relic;
- player damage versus deployed Commander Unit damage;
- Barrier/Overwhelm interaction.

Tests must assert the current rule, not merely stop asserting the old sentence.
Keep genuinely unresolved items visibly unresolved.

Delivered:

- **Commanders.** `commander` is rewritten around deployment: the printed cost
  is paid out of the Command Zone in a Main Phase, the permanent behaves as a
  Unit, and it arrives Newly Deployed. Defeat returns it to the Command Zone
  immediately — not the discard pile — and every route there says so
  (`edge_cases` names sacrifice, destruction and lethal damage together, which
  is what `effects.ts#restDefeated` actually does). The tax and its ceiling are
  quoted as `{matchConfig.commanderCostPerDefeat}` / `{matchConfig.commanderCostCap}`,
  never written out, and the cap is described as applying to the **total**. The
  old "Commanders do not fight yet" `unresolved` callout is gone; `objective`
  now states that losing a Commander is not losing the match.
- **A Commander with no printed cost is undeployable, not free.** The card
  explainer previously told a player that any Commander "pays its printed cost
  and puts it onto the battlefield" — a promise the engine refuses with
  `engine/commander_not_deployable` for every `cost: null` fixture Commander.
  `explain/card.ts` now branches, and drops the "on the turn it is deployed"
  note for a card that can never be deployed.
- **Format-aware construction.** `deck_building` reads `deckRules.singleton` as
  its own chip rather than implying singleton from a copy limit, and explains
  the rule a copy limit cannot express (a card split across two entries of one).
  It also states that the pool is the format's own and that an unfinished card
  or Commander is refused by name — the M01.1/M01.2 gates, told to the player.
- **Reactions.** A new `reactions` section (order 85), written from
  `reactions.ts` and the four `openReactionWindow` call sites: the exact moments
  a window opens, that it opens only if somebody could use it, active-player-first
  priority, `{matchConfig.reactionsPerPlayerPerWindow}` per player, last-in
  first-out resolution, and no refund on a counter. `turn_structure`'s "there is
  no acting on someone else's turn" callout is replaced with one that names the
  two things that do happen.
- **Energy.** The book said unspent Energy "is lost at the end of your turn; it
  never carries over". The engine has never done that, and since Reactions it is
  load-bearing. `energy` now says it survives the opponents' turns, pays for a
  Reaction, and is **replaced rather than topped up** by the next refill —
  matching `energy.test.ts`. The `energy` glossary entry agrees.
- **Guardian** is described as the compulsory-block rule
  `validateGuardianObligation` enforces, including the two parts that are easy
  to get wrong: the obligation is a count, any legal blocker may discharge it,
  and Evasive attackers are excluded.
- **Vocabulary.** Newly Deployed and Rush throughout; the `summoning_sickness`
  glossary entry became `newly_deployed` with the three-part rule (no attack, no
  `Exhaust this source`, blocking still allowed, Rush lifts the first two without
  clearing the state). The `unit__flag` chip in `MatchBoard.tsx` reads "newly
  deployed". The `PlayerView.summoningSick` **field** is deliberately unchanged:
  renaming a protocol field is a schema change and belongs to whoever versions
  the protocol, not to a content tranche. `PublicCardContext` — help-content's
  own type — is renamed to `newlyDeployed`.
- **Board and Relics.** `edge_cases` no longer claims a token can fail to be
  created for lack of room. One active Relic, and replacement as a rules action
  rather than a defeat, are stated where a player will meet them.
- **Player versus deployed Commander.** A new "Players and Commanders are
  separate" block: card text naming a Commander means that player's Health
  (ADR 0016 Q-A), a deployed Commander's printed Health is a separate pool
  reached through combat or a unit-targeting effect, and the two never touch.
- **Barrier and Overwhelm.** The flat "excess damage does not spill over" claim
  now carries the Overwhelm exception, stated in the implemented order: current
  Health to the blocker (explicitly _not_ reduced by damage already marked, which
  is the ADR 0016 Q-D divergence), remainder to the player, Barrier prevents only
  the blocker's share.
- **Contextual help.** `context.ts` claimed "This Commander stays in the
  Commander zone for the whole match", and answered "Cards can only be played
  during your own Main Phase" while an open Reaction window was actively waiting
  on that seat. Both are fixed; the window branch reads the engine's own
  `legalActions.reaction`, so the price shown is the discounted one the engine
  computed rather than the printed cost.
- **Kept unresolved.** Resilient is still the one inert keyword and is still
  labelled as such; the Reaction chaining policy is described as the smallest
  workable rule and explicitly replaceable.

Recorded rather than worked around: the implemented Reaction policy is **not**
the one `CLAUDE.md` states. `handlePlayReaction` clears `passedPlayerIds` on a
play, and `reactions.test.ts` asserts it in as many words — "the one case in
which a Reaction may answer another Reaction (§5.5)". `CLAUDE.md` says "no
Reaction responds to another Reaction". The book describes the engine, per this
plan's "code and passing tests outrank this baseline"; the `CLAUDE.md` bullet
needs an owner decision. `reactions.ts` also notes that active-player-first
priority supersedes the "non-active player first" text still in
`docs/rules/open-decisions.md`, which is M07's to reconcile.

Evidence:

- `packages/help-content/src/rulebook/rulebook.test.ts` — a new
  `the rulebook teaches the implemented ruleset` block with one test per bullet
  above, each asserting the **new** sentence. The Commander tax, the Reaction
  limit and the deck size are proved to follow configuration by re-loading the
  book under changed dials (`commanderCostPerDefeat: 3`, `commanderCostCap: 17`,
  `reactionsPerPlayerPerWindow: 4`) and under `DEVELOPMENT_DECK_FORMAT`, where
  the singleton chip must read "No" and the deck size 30 — which is what proves
  the wording is format-aware rather than Wave 1 hard-coded. Plus one sweep
  asserting eleven retired claims appear in **no** section, which covers the
  keyword registry and glossary because both are rendered into sections.
- `packages/help-content/src/context.test.ts` — the Command Zone message names
  deployment and the return; a rival's Commander is never offered as deployable;
  the Newly Deployed message names the state and says blocking is still allowed;
  and two Reaction-window cases prove the window branch pre-empts the Main Phase
  answer. Those two vary the two new fields off a real engine-derived context:
  `prototype_core` contains no Reaction card and the engine's fixtures are not
  exported, so `reactions.test.ts` owns the real window.
- `apps/web-client/src/help-flow.test.tsx` — the inspector shows "Newly Deployed"
  in the glossary, and a `cost: null` Commander is described as undeployable
  rather than as a free deployment.
- `npm run verify` passes (64 files, 1028 tests, production build).
- `npx tsc -p tsconfig.json --noEmit` still fails only in `scripts/new-card.ts`
  and `scripts/report-triggers.ts`, unchanged by this tranche and owned by
  M01.5.

## M01.5 — Make verification cover root scripts — DONE (2026-08-11)

Problem: `npm run typecheck` covers workspaces but not the root `tsconfig.json`;
`scripts/new-card.ts` and `scripts/report-triggers.ts` contain unchecked errors.

Required:

- Fix root TypeScript errors without weakening strictness.
- Add root project checking to the ordinary typecheck/verify chain.
- Test `cards:new` for every supported card type, including Reaction.
- Keep `npm run verify` as the single final gate.

Delivered:

- **The gate.** `typecheck:root` (`tsc --noEmit -p tsconfig.json`) is a real
  script and `typecheck` now runs the workspaces **and then** it, so `verify`
  covers the root project through its existing `typecheck` step. Nothing was
  added to `verify` itself — it stays the single final gate, and there is no
  longer a second command to remember. `tsconfig.json` and `tsconfig.base.json`
  are untouched: the 16 errors were fixed, not configured away, and the root
  project still runs the full `strict` +
  `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` set.
- **`scripts/report-triggers.ts` was reading unvalidated data.** All eight of its
  errors trace to one cause: `BUNDLED_CARD_SETS` is `readonly unknown[]` by
  design — the raw, pre-validation bundle — and the report walked it as if it
  were `CardSet[]`, so `set`, `card` and every `ability` were `unknown`/`any`.
  It now reads `loadBundledCardData().sets`, the same validated projection every
  other consumer uses. This is a correctness fix, not a typing one: the old
  version would have silently reported nothing for a set whose data failed to
  parse, which is precisely when a trigger review matters.
- **`scripts/new-card.ts` lost its card body's type.** Spreading a
  `Record<string, unknown>` into an object literal narrows the result to the
  explicitly written keys, so `card` was `{ id: string; name: string }` and the
  three lines that strip `text` and set `displayText` were unchecked. `card` and
  `ordered` are now declared `Record<string, unknown>`. The `argv[i]` accesses
  are guarded for `noUncheckedIndexedAccess`, and the `args.type as CardType`
  cast is replaced by an `isCardType` type guard, so an unknown `--type` is
  narrowed away rather than asserted past.
- **Both scripts split into a CLI shell plus an importable module.** The logic is
  `scripts/lib/card-scaffold.ts` and `scripts/lib/entry-trigger-report.ts`; the
  two entry points keep their names, their npm scripts, their messages and their
  exit codes. This is what makes them testable at all — the old files ran their
  `main` at import time, so a test could not load one without scaffolding into
  the repository's own `content/` tree. `scaffoldCard` takes a `root` option for
  exactly that reason; templates are still always read from the repository,
  because the thing worth proving is that the _shipped_ template for each type
  still produces legal content.
- Two small behaviour changes, both deliberate. `fail()`'s `process.exit(1)` is
  now a thrown `ScaffoldError` the shell converts to `process.exitCode = 1`, so
  stdout is flushed rather than truncated mid-write. And the scaffolder rejects
  a template file that is not a JSON object instead of spreading whatever it
  found. Argument parsing, defaults, refusals and output are otherwise identical.
- **The `scripts` vitest project.** `scripts/` sits outside every workspace, so
  `vitest.config.ts` gained a fourth Node project for `scripts/**/*.test.ts`.
  Root `tsconfig.json` already includes `scripts/**/*`, so the new tests are
  type-checked by the same gate they were written for.

Evidence:

- `scripts/lib/card-scaffold.test.ts` — one parameterized case per entry in
  `CARD_TYPES` (unit, spell, reaction, relic, commander, token) scaffolds from
  that type's shipped default template into a temp root and pushes the written
  file through the real `loadCardSets`, asserting zero errors and the right
  resolved type; plus that `schemaVersion` and template flavour `text` are
  stripped, `displayText` is the placeholder, and `id`/`name`/`type` lead the
  key order. Reaction gets its own case asserting the template's
  `reaction.windows` survive intact and non-empty, because a Reaction with no
  windows parses fine and can never be played. Then: tokens land in `tokens/`
  and everything else in `cards/`; `--key=value` form and ID title-casing;
  and six refusals — an occupied ID in _either_ directory, an unknown type, a
  non-snake_case ID, a missing set, a `--template` whose type disagrees with
  `--type`, and each of the three required flags.
- `scripts/lib/entry-trigger-report.test.ts` — the three groups are cross-checked
  against the validated card data rather than a fixture, so the report cannot
  drift from the content it describes; no Spell or Reaction is ever reported as
  arriving on the battlefield; `--set` narrows without changing what it says
  about that set; the text report prints all three group headings and the
  no-bulk-conversion warning; `--json` is versioned and round-trips.
- Both CLIs were run end to end: `cards:new` with no arguments, with a bad type
  (exit 1), and scaffolding a real Reaction into `prototype_core` (removed
  again); `report:triggers --set prototype_core` and an unknown set (exit 1).
- The gate was verified to bite: appending `const broken: number = 'x';` to
  `scripts/report-triggers.ts` makes `npm run typecheck:root` fail with
  `TS2322`. Reverted.
- `npm run verify` passes (66 files, 1050 tests, production build), and its
  `typecheck` step now ends with `tcg-prototype@0.1.0 typecheck:root`.
- `CLAUDE.md`'s "until M01.5 is complete, also run `npx tsc -p tsconfig.json`"
  instruction and the matching README wording are replaced with the single-gate
  statement, since keeping them would be the newly stale text.

## Acceptance

- Shipping UI/server use the same Wave 1 pool.
- No legal or spectator match silently contains an incomplete card/Commander.
- Replay hashes change for every mechanics-relevant edit.
- Player help teaches the implemented rules.
- One `npm run verify` includes root scripts and passes.

## Exclusions

- Implementing the 13 remaining cards.
- Adding the deck-builder precon browser.
- Balancing cards or pilots.
- Broad documentation cleanup; that is M07.
