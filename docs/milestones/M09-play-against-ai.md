# M09 — Play Against AI

A live, server-authoritative bot opponent in an ordinary online lobby: one to
three bot seats at a two-to-four-seat table with at least one human, each with its
own deck source, difficulty, style and decision pacing. Owner-approved on
2026-08-14 as the milestone to run **before** the deferred M08, because it
produces a directly playable testing tool sooner.

This file is the only detailed scope document for M09.
[`IMPLEMENTATION_PLAN.md`](../../IMPLEMENTATION_PLAN.md) carries one status row
and names the next tranche; nothing else describes this milestone.

## Preconditions

Run after M08.0. M09 depends on the redacted `PlayerView` and engine-computed
`LegalActions` a pilot already receives (M05, ADR 0009), on the safe pilot
contract `decideSafely` defines, on the authoritative lobby and match server the
online milestones built, and on `validateDeck` being the single authority on deck
legality. All of those exist.

M09 does **not** depend on M08. Nothing in it needs the admin panel, the durable
catalog, or AI Lab finalists, and no tranche below may acquire that dependency.

## Objective

Make a human able to sit down and play a real match against the software, in the
lobby they already use, and be able to say honestly afterwards what they played
against.

1. A lobby holds two to four seats, at least one human, and up to three bots.
2. The host adds, configures, rerolls and removes bot seats before the match, and
   the configuration locks when it starts.
3. Every bot offers three deck modes: an exact list (a shipped precon or one of
   the host's saved decks), a deck the bot builds under a Commander the host
   chose, or a Commander and deck the bot chooses itself.
4. Difficulty, style, deck source and timing are configured independently.
5. Bots are server-authoritative seats inside the existing match, acting through
   the same `applyAction` path a human uses, seeing exactly what a human in that
   seat sees.
6. Bot decision pacing is configurable in percent of a bot-only budget, so the
   owner can experience 30 seconds of waiting before deciding whether humans
   should ever be timed.
7. A match ends with a pacing and provenance summary a manual playtest note can
   quote.

## Revalidated baseline — read from code at `1bcf615`, 2026-08-14

Every line below was re-checked against the branch during M09.0 rather than
copied from the brief. The brief was written against `6727841`; the two commits
since are M08.0's record and its audit measurement, and neither changed runtime
behaviour.

### Versions

| Constant                       | Value   | Expected to move in M09                              |
| ------------------------------ | ------- | ---------------------------------------------------- |
| `PROTOCOL_VERSION`             | 6       | **Yes**, once, in M09.2                              |
| `MATCH_SCHEMA_VERSION`         | 7       | No — a bot seat is a controller above the engine     |
| `RULES_VERSION`                | `0.4.0` | No — pacing and difficulty are not rules             |
| `CARD_SCHEMA_VERSION`          | 5       | No — M09 authors no cards                            |
| `SPECTATOR_REPLAY_VERSION`     | 6       | No — Spectator is untouched                          |
| `BOARD_TELEMETRY_VERSION`      | 3       | No, unless M09.17 needs a payload it cannot reuse    |
| `SEED_DERIVATION_VERSION`      | 2       | Only if bot seed derivation changes an existing path |
| `HASH_VERSION`                 | 1       | No                                                   |
| `TELEMETRY_SCHEMA_VERSION`     | 6       | No — M09.17 is match-local, not a durable store      |
| `CALIBRATION_SUITE_VERSION`    | 1       | Likely, in M09.14 and M09.15                         |
| `AGENT_CLASS_REGISTRY_VERSION` | 1       | No — Hard is a difficulty label, not an agent class  |

`docs/status-audit.md` holds the complete generated list. The rows above are the
ones M09 is most likely to be asked about, recorded here so a later tranche can
say what changed and what deliberately did not.

New constants M09 introduces — bot configuration, difficulty registry, generator
and pacing configuration — are named in the tranches that add them, and
[ADR 0024](../architecture/0024-live-bot-seats.md) records why they are
independent of the play-contract versions above.

### What exists

- **Online lobbies are human-only, and the protocol has never heard of a bot.**
  `bot` and `pilot` appear zero times in `packages/protocol/src` and zero times in
  `apps/multiplayer-server/src`. `lobbySeatViewSchema` is a strict object with
  `seatId`, `displayName`, `connected`, `ready`, `deckName`, `deckLegal`,
  `isHost`, `graceSeconds` and `eliminated`, and no controller field. The client
  message union's only host-only members are `set_max_seats` and `start_match`.
  `PROTOCOL_ERROR_CODES` has seventeen members, none about a bot.
- **A seat is shaped like a human.** `Seat` in
  `apps/multiplayer-server/src/lobby.ts` carries a `reconnectToken`, a
  `connectionId`, a `cancelDisconnectTimer` and a `disconnectDeadline` — four
  fields that describe something which can go away. `freeSeats` allocates within
  the host's `maxSeats`, deterministically, in seat order.
- **The server owns state, legality, redaction, reconnection and the disconnect
  timeout.** `MatchServer` holds an injectable `#schedule`, uses it for the
  90-second window, and submits an explicit `server_timeout` action on expiry —
  the engine never reads a clock. Leaving a live match becomes a `concede`
  action. Lobbies and matches are in memory; restarting the process ends them.
- **The web client cannot configure a bot opponent.** `LobbyScreen.tsx` has no
  bot control; the string `bot` does not occur in it.
- **AI Spectator is not a live opponent.** `runSpectatorMatch` returns a finished
  `SpectatorReplay`, and `SpectatorScreen.tsx` awaits the entire match in the
  browser before animating the first frame. It runs two to four pilots on shipped
  precons, entirely client-side, and never touches the match server.
- **`@tcg/bot-interface` ships four pilots** — `random_legal`, `aggressive`,
  `defensive`, `value`. `PILOT_AGENT_CLASSES` puts the last three in one class,
  `generic_heuristic`: they are one procedure pointed at three weight vectors,
  and they are styles rather than difficulty levels.
- **Pilots already sit behind the boundary M09 must preserve.** `BotObservation`
  is deliberately a plain interface with no `MatchState` member, and
  `decideSafely` validates a returned action with `checkActionOffered` before the
  runner submits it, substituting a deterministic random-legal decision and
  recording a `BotFailure` when a pilot throws, returns nothing, returns an
  illegal action, or exceeds its decision budget.
- **Bots do not concede by default.** `mayConcede` is `false` in both
  `candidateActions` and `randomLegalConfigSchema`, and both offer `concede` only
  when no other candidate exists.
- **A deterministic legal deck generator exists, in the simulator app.**
  `generateDeck` and `generatePopulation` in
  `apps/simulator/src/deck-search/generate.ts` build a legal deck for a Commander
  from a format-scoped pool and a seed, with `validateDeck` as the final
  authority and structured diagnostics instead of quiet repair.
- **Q8 is open** and says so: disconnect expiry is a loss, phase timers are
  deferred, and whether a Main Phase or choice timer is wanted at all is
  undecided.

### Corrections to the brief, found by re-checking

- **The brief's own file, at the repository root, fails `npm run audit:check`.**
  `PERMITTED_ROOT_DOCS` in `scripts/lib/status-audit.ts` allows exactly
  `README.md`, `CLAUDE.md` and `IMPLEMENTATION_PLAN.md`, and the audit reports
  every other root Markdown file as unexpected. Verified by running the check
  with the file present — it failed — and again after moving the file out of the
  repository, where it passed. The file belongs outside the repository, as it
  says of itself, and the same thing happened to M08's brief in M08.0.
- **The generator chain is Node-only, not portable as-is.**
  `apps/simulator/src/hash.ts` imports `node:crypto`, and `generate.ts` reaches
  it through `seed.ts`'s `rngFor`. The brief's M09.8 acceptance line asks for
  "browser/server compatibility where required"; the honest answer today is
  server-only, which is sufficient for M09 because generation happens on the
  authoritative server. M09.8 states the supported environments rather than
  implying both.
- **The safe-fallback path can itself throw.** `decideSafely` substitutes
  `createRandomLegalPilot()`, and that pilot throws when it is asked to decide
  with no legal action available — which, with `mayConcede: false`, includes a
  state whose only offered action is `concede`. In the simulator that surfaces as
  a failed match; on a live server it would surface as an exception inside a
  socket handler. M09.4 owns containing it, and must not "fix" it by letting the
  live fallback concede.
- **Nothing else in the brief's starting point had drifted.** The lobby, the
  protocol, the match server, the bot boundary, the Spectator runner, the timers
  and the version constants are as described.

## Locked interpretation

Do not reopen these while implementing M09. The architectural half is
[ADR 0024](../architecture/0024-live-bot-seats.md).

- **A bot is a server-owned seat controller.** Not browser automation, not a
  human client's tab, not a second engine path. It has no connection ID, no
  reconnect token and no disconnect timer, and it cannot disconnect.
- **The observation boundary is unchanged.** A live bot sees its own redacted
  `PlayerView` and the engine's legal actions, and nothing else. Hard difficulty
  does not read hidden state; analysis-mode information never reaches a live
  match.
- **Bot actions use `applyAction`.** Same path, same idempotent action identity,
  revalidated at submission. No privileged action, no free resource, no rule
  exception.
- **`server_timeout` stays server-originated** and is never a bot decision.
  **Bot concession stays off** in ordinary play-against-AI matches.
- **Deck source is public at the Commander, private at the list.** A generated or
  saved list stays hidden from opponents during the match and is revealed or
  exported after it. The host knows the deck they chose; the claim is about
  opponents.
- **No secret counterpicking.** A bot never inspects an opponent's hidden deck,
  hand or saved-deck data when choosing a Commander or building a deck. Adaptive
  counter-search is M08's and is explicit there.
- **Difficulty, style, deck source and timing are four independent axes.** A Hard
  bot does not get a better deck; a slow bot is not an Easy bot; a defensive bot
  is not a stronger bot. Aggressive, defensive and value are **not** renamed
  Easy, Normal and Hard.
- **Hard is a player-facing difficulty label, not an evidence class.** It is not
  archetype-aware, and a Hard result is not final-balance evidence.
- **Bot pacing is server and lobby configuration, and does not answer Q8.** The
  30-second decision and 5-second Reaction budgets are bot-only test dials.
  Nothing in M09 times out, passes for, or defeats a human. Changing a budget is
  a pacing configuration change, not a rules change.
- **A scheduled decision is an opportunity, not a stored action.** At expiry the
  server rebuilds the observation and legal actions, asks the pilot then,
  revalidates, and submits. Obsolete work is cancelled.
- **Simulation stays full speed.** Live pacing must not contaminate simulator
  outcomes, Spectator replays, pilot RNG or deck search.
- **Joining humans never silently replace configured bots.** The host removes a
  bot to free the seat.
- **Every generated deck comes from a format-scoped database**, never the whole
  bundled universe, and passes the same `validateDeck` a human deck does.
- **Wave 1 Commander-legal pools are 41–42 cards for a 40-card singleton deck.**
  Generated decks are therefore minimally different from each other. The UI says
  so; M09 does not author cards to fix it.

## Exclusions

Not part of M09 unless the owner separately changes scope.

- The M08 AI Lab or admin panel, in any form, including scaffolding.
- A durable Player Meta database or dashboard. M09.17 produces a match-local
  summary and a clean ingestion seam, and claims nothing more.
- Public feedback prompts or surrender-reason questionnaires.
- Matchmaking, accounts, MMR, moderation, or bot identities that pretend to be
  people.
- AI Lab finalists as a deck source. That needs M08 to exist.
- Adaptive between-match counterbuilding.
- Authoring cards, rebalancing precons, mutating card definitions, automated
  balance changes, or the 50-card expansion.
- Resolving Q8's human timeout and expiry policy.
- Hidden-information access for Hard difficulty.
- Calling Easy, Normal or Hard a final balance instrument.
- A general-purpose lobby scripting surface or arbitrary bot-code upload.

## Checkpoints

If work stops, it stops at one of these boundaries and says which.

| Checkpoint        | Last tranche | What is genuinely usable                                   |
| ----------------- | ------------ | ---------------------------------------------------------- |
| Architecture only | M09.0        | Reviewed plan and ADR; no runtime change                   |
| First playable    | M09.5        | One human versus one chosen precon bot, Normal and instant |
| Mixed exact decks | M09.7        | Up to four mixed seats using precons and saved decks       |
| All deck modes    | M09.10       | Exact, host-chosen Commander, or full bot choice           |
| Timing usable     | M09.12       | Per-bot percentage pacing with a Reaction override         |
| All difficulties  | M09.15       | Easy, Normal, and evidence-backed Hard                     |
| Complete          | M09.19       | Pacing summary, help, privacy, compatibility and hardening |

M09 is never marked complete at an intermediate checkpoint.

---

## M09.0 — Milestone record and live-bot ADR — **done (2026-08-14)**

Start M09 without implementing product behaviour: re-audit the lobby, protocol,
match server, bot boundary, Spectator runner, deck generator, timers and version
constants; create the milestone record and the ADR; convert the owner decisions
into locked scope and a tranche checklist; and record the baseline from code
rather than from the brief's prose.

### Checklist

- [x] **Every baseline re-read from the branch, not transcribed.** The version
      table was taken from the constants themselves — `PROTOCOL_VERSION` 6 in
      `packages/protocol/src/messages.ts`, `MATCH_SCHEMA_VERSION` 7,
      `RULES_VERSION` `0.4.0`, `CARD_SCHEMA_VERSION` 5 — and "What exists" from
      `apps/multiplayer-server/src/lobby.ts`,
      `apps/multiplayer-server/src/match-server.ts`,
      `packages/protocol/src/messages.ts`, `packages/bot-interface/src/types.ts`,
      `packages/bot-interface/src/run-pilot.ts`,
      `packages/bot-interface/src/registry.ts`,
      `packages/bot-interface/src/candidates.ts`,
      `packages/spectator/src/run.ts`,
      `apps/web-client/src/components/spectator/SpectatorScreen.tsx`,
      `apps/web-client/src/components/match/LobbyScreen.tsx` and
      `apps/simulator/src/deck-search/generate.ts`.
- [x] **Three claims in the brief were checked and corrected rather than
      adopted**, and are recorded above: its own file at the repository root
      fails `npm run audit:check` and was moved out of the repository; the
      generator chain reaches `node:crypto` and is server-only today; and
      `decideSafely`'s random-legal fallback can itself throw when no non-concede
      action is offered, which M09.4 has to contain.
- [x] Exactly one M09 milestone file — this one — and exactly one M09 row in
      `IMPLEMENTATION_PLAN.md`, whose **next bounded task** now names M09.1. The
      M08 row is marked deferred rather than deleted, with its record and
      [ADR 0023](../architecture/0023-admin-lab-boundary.md) left intact, and no
      part of M08 is scaffolded.
- [x] The plan records **why** the order changed: the owner chose M09 first
      because it produces a playable testing tool sooner, and the structured
      manual playtests the plan already names get a real opponent out of it.
- [x] [ADR 0024](../architecture/0024-live-bot-seats.md) records the seven
      decisions M09.0 owes: server-owned bot seat controllers with no connection
      or reconnect identity; ADR 0009's observation boundary unchanged and
      `applyAction` as the only path; Commander-public and list-private deck
      sources with no counterpicking; pacing as server configuration that
      deliberately does not answer Q8, scheduled as an opportunity rather than a
      stored action; difficulty, style, deck source and timing as four
      independent axes with Hard as a label rather than an evidence class; the
      shared generator boundary and its Node-only constraint; and which version
      constants move.
- [x] Every owner decision in the brief appears above as objective, locked
      interpretation, exclusion, checkpoint or a tranche below. Nothing was
      dropped and nothing was added.
- [x] **No runtime behaviour changed.** The tranche touches three documents —
      this file, the ADR and `IMPLEMENTATION_PLAN.md` — plus the regenerated
      `docs/status-audit.md`, whose ADR and milestone inventories moved as a
      result.
- [x] Verified: `npm run check:consistency`, `npm run audit:check` and
      `npm run verify` all pass.

### Versions — deliberately unchanged

Nothing moved. M09.0 adds no schema, no message and no artifact. The first
constant M09 introduces is the bot configuration contract's own, in M09.1, and
[ADR 0024](../architecture/0024-live-bot-seats.md) §7 records why it is
independent of `PROTOCOL_VERSION`, `MATCH_SCHEMA_VERSION` and `RULES_VERSION`,
and which of those does move and when.

---

## M09.1 — Bot configuration contracts — **done (2026-08-14)**

Define the complete strict configuration before any of it crosses the wire:
versioned schemas for bot controller metadata, difficulty, style, deck choice,
pacing percentage, Reaction override, pacing budgets and generated-deck
provenance. Deck choice is a discriminated union over `exact_precon`,
`exact_saved_deck`, `commander_generated` and `autonomous_generated`. The public
lobby projection is defined separately from the private host and server
configuration, so privacy is a type rather than a habit. Percentage-to-delay
calculation, the safety margin, integer and range limits, and stable
decision-category classification are all defined here. A total registry for
difficulty IDs and versions exists without Easy or Hard behaviour behind it yet.

**Acceptance:** strict-object, unknown-member, future-version, privacy-projection,
0/50/100%, budget, safety-margin and round-trip tests, and `npm run verify`.

**Exclusion:** no protocol messages, no pilot implementation, no deck generation,
no UI.

### Checklist

- [x] **Strict versioned schemas for controller metadata, difficulty, style, deck
      choice, pacing and generated-deck provenance**, in a new contract package,
      `packages/bot-config` (`@tcg/bot-config`). Every object is a `strictObject`,
      so an unknown member is a parse failure rather than a field that survives
      to be read later by something that trusts it.
- [x] **Deck choice is a four-member discriminated union** over `exact_precon`,
      `exact_saved_deck`, `commander_generated` and `autonomous_generated`, in
      `deck-source.ts`. There is no fifth: AI Lab finalists as a deck source need
      M08 to exist, and `DECK_MODE_SUPPORT` records which tranche owns each mode
      that a build cannot yet honour, so M09.3 refuses one **by name** from data
      rather than from a hard-coded list of what is finished.
- [x] **Public projection separate from private configuration, and tested as
      such.** `publicDeckSourceOf` and `publicBotSeatOf` are the only routes from
      one to the other, and the public unions have no card list, generator seed,
      deck hash or saved-deck identity to strip — the privacy rule is a type
      rather than a habit. The tests assert it by serialising the whole
      projection and searching the text for every private value, because the
      failure being guarded against is a field being _added_ later.
- [x] **Percentage-to-delay, safety margin, limits and decision categories
      defined** in `pacing.ts`. `pacingDelayMs` is a pure integer function: 0% is
      exactly zero, 50% is half the budget, and 100% stops one
      `PACING_SAFETY_MARGIN_MS` short of it so the decision still lands inside
      the budget being measured. Three categories — `ordinary`, `pending_choice`
      and `reaction` — draw on two budgets through a total map; classifying a
      live opportunity into one of them stays M09.12's.
- [x] **Total difficulty registry with versions; a future version refused.**
      `DIFFICULTY_REGISTRY` is a total `Record` over `easy`, `normal` and `hard`;
      `normal` is `available` with a behaviour version, and the other two are
      `planned`, name the tranche that owns them, and carry a `null` behaviour
      version because nothing implements them yet. `readBotSeatConfig` refuses a
      future `schemaVersion` or `difficultyRegistryVersion` before parsing, so a
      record from a newer build is told it is from a newer build rather than
      handed complaints about fields this build has not learned about.
- [x] **The four axes cannot be collapsed into each other**, and a test says so:
      no identifier is shared between the difficulty and style vocabularies, and
      neither schema accepts a member of the other. `random_legal` is not offered
      as a style, and `automatic` is absent until M09.16 gives it a mapping.
- [x] **A bot controller has no connection identity.**
      `FIELDS_A_BOT_CONTROLLER_NEVER_HAS` names `connectionId`,
      `reconnectToken`, `disconnectDeadline` and `graceSeconds`, and the strict
      controller schema refuses each one, so [ADR 0024](../architecture/0024-live-bot-seats.md)
      §1 is a test rather than a sentence.
- [x] **The dependency direction is enforced, not described.** `@tcg/bot-config`
      depends only on `@tcg/card-data`, `@tcg/shared` and `zod`, and an ESLint
      rule refuses an import of the engine, the UI, the protocol or the pilots
      from inside it — so a client validating a bot seat view never drags a
      decision procedure in with it. The one seam that needs both sides,
      "every style names a real heuristic pilot", is a test in
      `packages/bot-interface`, which is the layer above.
- [x] Verified: the 79 focused tests above, `npm run check:consistency`,
      `npm run audit:check` and `npm run verify` all pass.

### Versions

Three new constants, and nothing existing moved.

| Constant                      | Value | Pins                                                      |
| ----------------------------- | ----- | --------------------------------------------------------- |
| `BOT_CONFIG_SCHEMA_VERSION`   | 1     | One bot seat's configuration record.                      |
| `DIFFICULTY_REGISTRY_VERSION` | 1     | Which difficulty IDs exist and what each claims.          |
| `PACING_CONFIG_VERSION`       | 1     | The budget shape and the percentage-to-delay calculation. |

`PROTOCOL_VERSION` stays 6: nothing here is on a wire yet, and moving it now
would refuse compatible builds for a shape they never send. It moves once, in
M09.2. `MATCH_SCHEMA_VERSION`, `RULES_VERSION` and `CARD_SCHEMA_VERSION` stay
where they are for the reasons [ADR 0024](../architecture/0024-live-bot-seats.md)
§7 already gives — a bot seat is a controller above the engine, and pacing is
configuration rather than a rule. `PACING_CONFIG_VERSION` pins the _calculation_
and not the numbers, which is what makes changing the 30-second budget after a
playtest a configuration change rather than a version bump.

`generatedDeckProvenanceSchema.generatorVersion` is a plain string this package
does not own: the shared generator carries its own constant from M09.8, and
copying the number here would give it two owners.

## M09.2 — Bot lobby protocol — **done (2026-08-14)**

Give host, client and server one versioned wire contract for bot seats: host-only
`add_bot`, `update_bot`, `reroll_bot` and `remove_bot` messages; lobby seat views
extended with controller kind and the safe subset of bot configuration; and
actionable protocol errors for a full table, a non-host sender, an unknown bot
seat, invalid configuration, an illegal deck, an unsupported mode and a started or
locked lobby. Exact and generated card lists and the private generator seed never
appear in another player's lobby view. Protocol compatibility is bumped or
refused at the correct boundary.

**Acceptance:** codec round trips, old-version refusal, non-host refusal,
unknown-field refusal, privacy, and every structured error.

**Exclusion:** the server does not act on the new messages yet.

### Checklist

- [x] **Four host-only bot messages, strict and versioned.** `add_bot`,
      `update_bot`, `reroll_bot` and `remove_bot` are `strictObject` members of
      `clientMessageSchema` in `packages/protocol/src/messages.ts`, and the
      configuration they carry, `botSetupSchema`, is **derived** from
      `botSeatConfigSchema` by `.omit({ controller: true })` rather than
      restated — so the wire cannot fall behind the contract M09.1 defined. Both
      `.omit` and `.extend` preserve the strict object, which a test asserts.
      Three things are deliberately not on this wire: `add_bot` names no seat,
      because the server allocates seats deterministically and a bot never
      displaces anybody; no message carries a `botId`, because a client that
      could choose one could collide with another seat's; and `reroll_bot`
      carries no seed, because a client-supplied seed would make the recorded
      seed transition something a client invented.
- [x] **Seat view carries controller kind and safe configuration only.**
      `lobbySeatViewSchema` is now a discriminated union on `controller`, so the
      invariant is structural rather than a refinement: a `human` seat's `bot` is
      `z.null()` and cannot hold configuration, and a `bot` seat's is
      `botSeatPublicSchema` — the projection `publicBotSeatOf` produces, which
      has no card list, generator seed, deck hash or saved-deck identity to
      strip. A bot seat additionally narrows `connected` to `true` and
      `graceSeconds` to `null`, so a disconnected bot or one counting down a
      reconnect window is not something the wire can describe
      ([ADR 0024](../architecture/0024-live-bot-seats.md) §1). The privacy test
      serialises a whole lobby view holding two bot seats and searches the text
      for every private value, and a companion test asserts those values really
      are in the private fixture, so it cannot pass by searching for nothing.
- [x] **Seven named structured errors, each tested.** `BOT_LOBBY_CONDITIONS`
      names the seven conditions and `botLobbyError` is the only place a refusal
      is built. Four are new codes, because the condition is about a bot seat and
      has no equivalent: `protocol/unknown_bot_seat`,
      `protocol/bot_config_invalid`, `protocol/bot_deck_illegal` and
      `protocol/bot_mode_unsupported`. Three reuse a code that already means
      exactly the same thing about the sender or the lobby —
      `protocol/lobby_full`, `protocol/not_host` and `protocol/already_started` —
      because minting `protocol/bot_not_host` beside `protocol/not_host` would be
      a second name for one fact. `protocol/bot_deck_illegal` is deliberately
      **not** `protocol/deck_illegal`: that one is about the deck the recipient
      submitted themselves and travels in `deck_rejected`, so reusing it would
      leave a host unable to tell whose deck the server means.
      `HOST_ONLY_CLIENT_MESSAGE_TYPES` makes "host-only" a list the server checks
      rather than a comment per handler, which is what `not_host` is refused
      from.
- [x] **`PROTOCOL_VERSION` moved, with the reasoning recorded beside it.** 6 → 7,
      in the constant's own comment: a v6 client validates a seat view against a
      strict object with no `controller` member, so the first lobby view a v7
      server sent it would fail to parse mid-lobby, and the handshake refuses
      first and says which side is older.
      [ADR 0006](../architecture/0006-network-protocol.md) carries the same
      number and a second amendment note.
- [x] **The server does not act on the new messages**, as the exclusion requires.
      The only change in `apps/multiplayer-server` is that `seatView` now
      publishes `controller: 'human'` and `bot: null`, which is what the widened
      view obliges it to say; M09.3 owns bot seats themselves. All 63 existing
      server tests and all 142 web-client tests pass unchanged apart from four
      lobby fixtures that gained the two new fields.
- [x] Verified: the 27 focused tests in
      `packages/protocol/src/bot-lobby.test.ts`, `npm run check:consistency`,
      `npm run audit:check` and `npm run verify` all pass.

### Versions

| Constant           | Move  | Why                                                            |
| ------------------ | ----- | -------------------------------------------------------------- |
| `PROTOCOL_VERSION` | 6 → 7 | The seat view and the client message union both changed shape. |

Nothing else moved. `BOT_CONFIG_SCHEMA_VERSION`, `DIFFICULTY_REGISTRY_VERSION`
and `PACING_CONFIG_VERSION` stay at 1: M09.2 put M09.1's shapes on a wire without
changing one of them, and folding them into `PROTOCOL_VERSION` would teach that a
difficulty improving is a message shape changing.
`MATCH_SCHEMA_VERSION`, `RULES_VERSION` and `CARD_SCHEMA_VERSION` stay where they
are for the reasons [ADR 0024](../architecture/0024-live-bot-seats.md) §7 gives —
a bot seat is a controller above the engine, and a bot waiting is not a rule.
`versionsSchema` still carries three fields, not five: a bot's configuration is
not something two builds must agree on in order to play at all.

**Compatibility.** A v6 and a v7 build refuse each other at the handshake with
`protocol 6 vs server 7`, which is the existing refusal working as designed and
is tested. Nothing is migrated: there is no stored artifact in this tranche, and
a lobby is in memory, so a version move ends no saved data.

## M09.3 — Server-side bot lobby seats — **done (2026-08-14)**

Let the authoritative lobby own bot seats safely: human and bot controllers
stored explicitly per seat; only the host may add, configure, reroll or remove a
bot, and only before the match starts; empty seats allocated deterministically
and a human never evicted; bot seats given no connection ID, reconnect token or
disconnect timer. Exact precon configuration is validated immediately; generated
and saved modes are reserved and refused with their named error until their
tranches land. A valid configured bot is automatically ready; an invalid or
unsupported one is visibly not startable. Current human join, resize, ready,
leave and reconnect behaviour is preserved exactly.

**Acceptance:** add, update, remove, full table, resize, host-only, readiness,
human join, bot non-disconnect and start-gating tests.

**Exclusion:** bots do not take match actions.

### Checklist

- [x] **Explicit per-seat controller; bot seats have no connection identity.**
      `Seat` in `apps/multiplayer-server/src/lobby.ts` is a discriminated union
      on `controller`: `HumanSeat` keeps `reconnectToken`, `connectionId`,
      `cancelDisconnectTimer` and `disconnectDeadline`, and `BotSeat` does not
      have them **by type** rather than by holding `null` — writing
      `seat.connectionId` on a bot seat is a compile error. `Attachment.seat` is
      a `HumanSeat`, so "a bot cannot submit a deck, ready up, reconnect or act
      as a client" is a property of the type instead of a check per handler. A
      test asserts that a live bot seat carries none of
      `FIELDS_A_BOT_CONTROLLER_NEVER_HAS`, that `seatByToken` never returns one,
      and that a human dropping out of a bot match opens exactly one disconnect
      window — the one seat that can lose a connection.
- [x] **Host-only mutation, before start only.** `hostLobbyFor` is the one
      preamble all four handlers share: seated, host, not started. A test drives
      every member of `HOST_ONLY_CLIENT_MESSAGE_TYPES` from a non-host seat and
      requires `protocol/not_host` from each, so the list M09.2 introduced is
      checked against the server rather than trusted. After the match starts all
      four are refused with `protocol/already_started` and the seat is untouched.
- [x] **Deterministic seat allocation that never evicts a human.** `add_bot`
      carries no seat ID; the server takes the first seat from `freeBotSeats`,
      which is `freeSeats` minus the host's — so a bot never lands on the seat
      the lobby takes its host from, and never on an occupied one. A joining
      human takes the next genuinely empty seat and gets `protocol/lobby_full`
      when there is none, rather than displacing a configured bot. A bot counts
      as an occupant when the host shrinks the table, exactly as a person does.
- [x] **Unsupported modes refused by name, not silently accepted.**
      `resolveBotSeat` reads `DECK_MODE_SUPPORT` and the difficulty registry's
      own `status`: each of the three unsupported modes is refused with
      `protocol/bot_mode_unsupported` naming M09.6, M09.9 or M09.10, and `easy`
      and `hard` with `protocol/bot_config_invalid` naming M09.13 and M09.15 —
      from the data, so flipping one entry is how a later tranche turns its own
      option on. `reroll_bot` is refused for the same reason rather than treated
      as a no-op: rerolling builds a new deck, only a generated mode does that,
      and this build has none. An unknown or off-format precon is
      `protocol/bot_deck_illegal`, judged by the same `reviewPrecon` a person's
      `submit_precon` gets. Nothing is written until a setup resolves whole, so a
      refused `update_bot` leaves the previous configuration in place.
- [x] **Existing human lobby behaviour unchanged, and regression-tested.** All 63
      pre-existing server tests pass untouched, and the 44 new ones in
      `apps/multiplayer-server/src/bot-lobby.test.ts` cover join, resize,
      readiness, start-gating, disconnect and lobby closure alongside the bot
      paths. The only behavioural change to a human path is that `status` is
      recomputed after a bot mutation, the line `set_ready` already ran.
- [x] **A configured bot is ready; a deckless one is visibly not startable.**
      `createBotSeat` derives `ready` and `deckLegal` from whether a deck was
      resolved, and `canStart` judges a bot seat by the same three conditions it
      judges a person by — so a seat with no legal deck gates the start instead
      of stalling the match later. No message can produce that state in M09.3;
      the test builds one directly, because the point is that M09.9 cannot
      introduce it quietly. The same test covers `deckName`, which a bot seat
      publishes only for `exact_precon` — shipped public content — and never for
      a mode whose list is private.
- [x] Verified: the 44 focused tests above, the 63 existing server tests,
      `npm run check:consistency`, `npm run audit:check` and `npm run verify` all
      pass.

### Findings recorded rather than fixed

- **A bot seat can start a match it cannot then play.** Nothing in M09.3 blocks
  `start_match` on a table holding a bot, and nothing in M09.3 makes the bot act
  — that is M09.4's whole subject, and the exclusion above says so. Between the
  two tranches a started human-versus-bot match stalls on the bot's first
  decision. It is recorded here rather than papered over with a temporary block,
  because a block would have to be removed by the next tranche and would make
  the start path untestable in this one. A test asserts the state honestly: the
  match starts, the bot is an ordinary player, and its `appliedActions` is empty.
- **A future `BOT_CONFIG_SCHEMA_VERSION` is refused as a malformed message, not
  as a bot configuration.** `botSetupSchema` is derived from
  `botSeatConfigSchema`, whose `schemaVersion` is bounded by the constant, so an
  unreadable version fails at the codec before `readBotSeatConfig` sees it. The
  server still runs `readBotSeatConfig` over the assembled record — a
  configuration it has not validated whole is never stored — but the readable
  "written by a newer build" wording is not what a v7 host would see today. Worth
  deciding in M09.18's compatibility pass; it is not a defect in this tranche.

### Versions — deliberately unchanged

Nothing moved. `PROTOCOL_VERSION` stays 7: M09.2 put the messages and the widened
seat view on the wire and M09.3 only acts on them, so no shape changed.
`BOT_CONFIG_SCHEMA_VERSION`, `DIFFICULTY_REGISTRY_VERSION` and
`PACING_CONFIG_VERSION` stay 1 — no schema widened, no difficulty appeared, and
the pacing calculation was not touched. `MATCH_SCHEMA_VERSION` and
`RULES_VERSION` stay where they are for the reason
[ADR 0024](../architecture/0024-live-bot-seats.md) §7 gives: a bot seat is a
controller above the engine, `createMatch` is handed an ordinary seat list, and
`MatchState` still does not know what a bot is.

## M09.4 — Immediate authoritative bot runner — **done (2026-08-14)**

Make an exact-precon bot play a complete live server match at 0% delay:
instantiate the configured versioned pilot at match start; derive and retain
independent deterministic RNG state per bot seat; after every accepted action or
state transition, schedule every newly eligible bot decision exactly once; build
the current redacted observation and legal actions, call `decideSafely`,
revalidate, and submit through the normal engine path with an idempotent action
identity. Pilot failure and fallback diagnostics are recorded — including the
case where the fallback itself has no legal action to offer, which must not be
answered by letting a live bot concede. Immediate decisions yield through the
scheduler or microtask boundary rather than recursing for a whole match, and all
work stops and cancels at match completion.

**Acceptance:** natural 1v1 completion, human-first and bot-first, pending choice,
Reaction, fallback, illegal pilot result, no-concede, deterministic seed, no
duplicate action, and long-match stack-safety tests.

**Exclusion:** no player-facing bot controls, and no multi-bot concurrency claim.

### Checklist

- [x] **One pilot instance and one independent RNG stream per bot seat**, built
      once at match start in `BotRunner`'s constructor
      (`apps/multiplayer-server/src/bot-runner.ts`). The pilot comes from
      `createBotPilot`, whose `switch` is total over `BotDifficulty` — `normal` is
      the published heuristic for the seat's style and adds nothing, and `easy`
      and `hard` throw by naming their own tranche, so M09.13 and M09.15 cannot
      ship a difficulty without deciding what flies it. The stream is
      `createRngState(botSeedFor(matchSeed, seatId))`: derived from the match
      seed, so the same seed and seating reproduce the same play, and per seat, so
      two bots at one table never share one. A pilot that cannot be built halts
      its own seat with a `pilot_unavailable` incident instead of throwing out of
      `start_match` and taking a human's match with it.
- [x] **Every eligible decision taken exactly once; no duplicate actions.**
      `wake()` is called after every accepted action and every state transition
      and is idempotent — a pump already in flight is not started again — so
      "scheduled exactly once" holds without a queue of opportunities to
      de-duplicate. The action identity is `${botId}#${decisionIndex}`, server-
      generated and monotonic, written into the same `seat.appliedActions` map
      `submit_action` writes for a person; a repeat is refused as
      `duplicate_action` rather than applied. A full match asserts one identity
      per decision, all distinct, in order.
- [x] **Observation rebuilt at decision time; the answer revalidated before
      submission.** The state is read at the top of each iteration, `legalActions`
      and `playerView` are computed from it there, and `decideSafely` is asked
      then. After the await the sequence is compared: if the board moved — a human
      message landing inside the microtask — the answer is discarded as
      `stale_decision`, the seat is asked again against the newer board, and the
      pilot's stream is **not** advanced, so what a bot draws depends on the
      decisions it committed rather than on when an opponent's message arrived.
- [x] **Failure and fallback recorded, never disguised as an intentional play.**
      Eight named incidents in `BOT_RUN_INCIDENTS`, each carrying the seat, the
      bot, the decision index and — for a fallback — the underlying `BotFailure`
      kind. A pilot that throws or answers illegally still finishes the match, and
      every one of its decisions says in the record that it was a substitution.
      The M09.0 finding is **contained rather than patched**: `hasBotDecision`
      ignores `canConcede`, which the engine offers every living seat at all
      times, so the runner never asks a pilot in the one state where the
      substituted random-legal pilot throws. A test stands the two halves next to
      each other. `fallback_unavailable` guards the path anyway, and a board on
      which no seat can act is recorded as `stalled` — never answered by a
      concession.
- [x] **No ordinary concession and no bot-originated `server_timeout`.**
      `ACTIONS_A_LIVE_BOT_NEVER_SUBMITS` is checked after the pilot answers and
      before anything is applied. `checkActionOffered` already refuses
      `server_timeout`, but it _allows_ a concession — it is a legal action for a
      living seat — so this guard is the thing that stops one, and the test proves
      a conceding pilot loses its seat's turn rather than the match.
- [x] **Stack-safe over a long match; cancelled cleanly at completion.** The pump
      is a `while` loop with an injectable yield in it, so a twenty-five-turn game
      costs one stack frame; a per-seat `DEFAULT_BOT_DECISION_LIMIT` of 4000 stops
      a pathological loop pinning the process. `stop()` is called when the match
      completes and when a lobby closes, and it is checked both at the top of the
      loop and immediately after the pilot's await, so a match that finished while
      a bot was thinking receives no last action. A closed lobby drops its runner
      rather than keeping a whole `MatchState` alive behind a stopped pump, and
      the pump can never reject: an unhandled rejection ends a Node process by
      default, and a misbehaving bot must cost the match its bot, never the server
      its humans.
- [x] Verified: the 30 focused tests in
      `apps/multiplayer-server/src/bot-runner.test.ts`, the 107 existing server
      tests, `npm run check:consistency`, `npm run audit:check` and
      `npm run verify` all pass.

### What the acceptance tests actually play

Not a fixture: a real 1v1 through `receive`, against a scripted opponent that
computes its own seat's legality and submits through `submit_action`. Two seeds
are named rather than arbitrary — one puts the bot on the first turn and one puts
the human there — and in both the bot answers a mulligan, a Main Phase, an attack,
a block, a pending choice and an **open Reaction window**, which is how those two
acceptance lines are covered by a game rather than by a hand-built board. The bot
plays `precon_containment_control` because that is the deck that holds Reaction
cards; a window only opens when somebody could use it, so a bot with none would
never have been offered one.

`whenBotsIdle()` is the one concession to asynchrony: a bot decision is
asynchronous while `receive` is not, so a test that read the board immediately
would be reading it mid-turn.

### Findings recorded rather than fixed

- **`fallback_unavailable` guards a state this build cannot reach.** It exists
  because `decideSafely`'s substituted pilot can throw, and the eligibility gate
  is what keeps the runner out of the only state in which it does. The guard is
  kept rather than removed: a later difficulty or a widened candidate set could
  reintroduce the state, and the cost of the guard is a `catch`.
- **`stalled` has no natural cause today.** No engine state in the current
  ruleset leaves every seat without a legal action while the match is running, so
  the test builds one by hand. It is recorded because the honest answer to a stuck
  board is to write it down, and the dishonest one — letting a bot concede to
  unstick it — is exactly what M09.0 said this tranche must not do.
- **M09.3's finding is closed by this tranche.** "A bot seat can start a match it
  cannot then play" was recorded there deliberately; the match no longer stalls on
  the bot's first decision, and the M09.3 test that asserted an empty
  `appliedActions` now asserts the opposite for the same reason.
- **The bot wins nearly every probe match against a scripted `aggressive`
  opponent.** Ten seeds, ten wins for `precon_containment_control`. That is not a
  balance finding — the opponent is `random_legal`-adjacent heuristic play with no
  human judgement in it, and `PILOT_AGENT_CLASSES` refuses to rank the styles —
  but it is the first thing the structured manual playtests should look at.

### Versions — deliberately unchanged

Nothing moved. `PROTOCOL_VERSION` stays 7: M09.4 adds no message and changes no
shape — a bot's actions travel to clients as the ordinary `match_state` a human's
do. `MATCH_SCHEMA_VERSION` and `RULES_VERSION` stay where they are for the reason
[ADR 0024](../architecture/0024-live-bot-seats.md) §7 gives: the runner is a
controller above the engine, `applyAction` is unchanged, and `MatchState` still
does not know what a bot is. `BOT_CONFIG_SCHEMA_VERSION`,
`DIFFICULTY_REGISTRY_VERSION` and `PACING_CONFIG_VERSION` stay 1 — M09.4 acts on
M09.1's shapes without widening one, adds no difficulty, and reads `pacing` only
to record that 0% is the only value this build honours.

`SEED_DERIVATION_VERSION` stays 2, and the milestone's version table anticipated
exactly this: it moves "only if bot seed derivation changes an existing path".
`botSeedFor` is a **new** derivation in the server, on no existing path — the
simulator's hierarchy, the spectator's `derivePilotSeed` and every recorded result
derive their seeds exactly as they did.

## M09.5 — First playable human-versus-precon-bot flow — **done (2026-08-14)**

The earliest useful slice: one human can start and finish a match against a
chosen precon bot. Host controls add and remove one bot, choose its shipped
precon, choose Normal difficulty and one existing style, and start the match. The
bot seat, its Commander, its precon, its readiness and its current supported
settings are clearly labelled. Unsupported generated-deck, timing and difficulty
controls are hidden rather than decorative. Match and result render through the
existing player MatchBoard, unchanged. Loading, error, empty and locked states
exist and every control is keyboard-accessible.

**Acceptance:** create lobby → add bot → choose precon and style → submit human
deck → ready → start → play → complete, plus remove, reconfigure, error and
reconnect UI tests, and `npm run verify`.

**Stop:** this is the first playable checkpoint. Report it explicitly and do not
continue to M09.6.

### Checklist

- [x] **Add, configure and remove exactly one bot from the lobby UI.**
      `BotSeatPanel` in `apps/web-client/src/components/match/BotSeatPanel.tsx`
      is host-only — the same rule `HOST_ONLY_CLIENT_MESSAGE_TYPES` states on the
      wire — and `MatchClient` gained `addBot`, `updateBot` and `removeBot` and
      deliberately **not** `rerollBot`: rerolling builds a new deck, only a
      generated mode does that, and the server refuses every reroll in this build
      by name. The Add control is absent once a seat holds a bot, because M09.5
      is one bot and M09.7 is what opens the table. `Apply bot changes` is
      disabled until something actually differs from the seated configuration,
      and an in-flight request disables the control that sent it, so a double
      press cannot seat two bots before the first broadcast lands.
- [x] **Bot seat labelled with controller, Commander, precon and readiness.**
      `botSeatLabels` in `apps/web-client/src/lib/bot-seat-labels.ts` reads the
      **public** projection a seat view carries and shipped precon content, so
      the labels have no card list, seed or hash available to them to leak
      ([ADR 0024](../architecture/0024-live-bot-seats.md) §3). The row shows a
      `bot` tag **instead of** the connected/disconnected tag a person gets: a
      bot has no connection to report, and the wire already narrows `connected`
      to `true`, so printing "connected" would be describing something that
      cannot be otherwise. The function is total over all four deck modes even
      though one is configurable, and answers every private mode the honest way —
      Commander shown, deck name withheld.
- [x] **Unsupported options absent, not disabled decoration.** The difficulty
      control is built from `AVAILABLE_DIFFICULTIES`, so Easy and Hard are not
      on screen at all and M09.13 turns its own option on by changing the
      registry entry it already owns. There is no deck-mode control, because
      `exact_precon` is the only supported mode; no timing control, because
      pacing is not live; and no reroll. A test asserts each absence by name,
      driven from `PLANNED_DIFFICULTIES` rather than from a hard-coded list.
- [x] **Match and result unchanged, rendered by the existing board.** No file
      under `components/match/MatchBoard.tsx` was touched. A test starts a
      human-versus-bot match from a real engine `PlayerView` and asserts the bot
      renders as an ordinary opponent — a seat and a name, with no controller
      label, difficulty, style or bot control anywhere on the board.
- [x] **Keyboard-accessible controls and designed error states.** Every control
      is a native labelled `<select>` or `<button>`; a test tabs through the
      three selects into the Add button and presses Enter. Four states exist and
      are tested: no precons published for the format, the table full, the lobby
      locked after start, and a refusal. The four `protocol/bot_*` codes print
      beside the form; `protocol/lobby_full`, `protocol/not_host` and
      `protocol/already_started` stay in the screen's own banner, because M09.2
      reused them precisely for saying the same thing about the lobby whatever
      caused them, and routing them to the bot form would sometimes misattribute
      a lobby-wide refusal.
- [x] Verified: the 15 focused tests in
      `apps/web-client/src/bot-lobby-flow.test.tsx`, the 142 existing web-client
      tests, `npm run check:consistency`, `npm run audit:check` and
      `npm run verify` all pass.

### The first playable checkpoint

**Reported explicitly, as the milestone requires.** A person can now create a
lobby, seat a bot on a shipped precon at a chosen style, submit their own deck,
ready up and play a complete match against the software. Nothing after this
tranche was started.

What is genuinely usable is exactly what the checkpoint table promises and no
more: one human, one bot, `exact_precon`, Normal, instant. The three other deck
modes, Easy, Hard, pacing, reroll, multi-bot tables and the pacing summary are
absent from the screen rather than present and refused.

The UI's half of the flow is proven against the real codec — every message this
screen sends is parsed by `clientMessageSchema` on the way out of the fake
transport, so a setup it builds is one the wire accepts. The server's half is
proven by the M09.3 and M09.4 suites, which drive `add_bot` → `submit_precon` →
`set_ready` and play the match out; this tranche presents those three in that
order and adds nothing to the sequence.

### Findings recorded rather than fixed

- **A two-seat table does not start itself when the bot is seated after the host
  readies up.** `set_ready` is the only handler that auto-starts a `MIN_SEATS`
  lobby, so a host who readies first and adds a bot second reaches `canStart`
  with nothing to press — the Start button existed only for tables of three or
  four. M09.5 answers this in the client: the button also appears whenever the
  server says the host could start right now, never disabled. The server was
  left alone deliberately. Moving the auto-start into the bot handlers would mean
  seating a bot could begin a match the host was still configuring, which is a
  worse failure than an extra button, and it would change a human-versus-human
  path this tranche has no business changing.
- **The panel infers "sent, waiting" from the lobby view rather than an
  acknowledgement.** There is no per-request ack on this wire, so `Adding…`
  clears when the seat list or the error changes. That is sufficient for one bot
  and one host, and it avoids putting a second idea of "the current
  configuration" on the client — but M09.7's concurrent seats should decide
  whether it stays sufficient, because two mutations in flight are
  indistinguishable to it.
- **The client does not preview a bot deck's legality, and this is deliberate.**
  A human's own deck gets a `reviewPrecon` preview because the player is
  assembling it; a bot's precon is shipped content the server resolves from its
  own bundle, so previewing it here would be a second opinion about a deck this
  client never sends. The picker is scoped through the same `preconsForFormat`
  the server and the deck browser use, so it cannot offer a deck the server would
  refuse for being off-format.

### Versions — deliberately unchanged

Nothing moved. `PROTOCOL_VERSION` stays 7: M09.5 sends the four messages M09.2
put on the wire and reads the seat view M09.2 widened, and changes neither shape.
`BOT_CONFIG_SCHEMA_VERSION`, `DIFFICULTY_REGISTRY_VERSION` and
`PACING_CONFIG_VERSION` stay 1 — the client writes all three into every setup it
builds and widens none of them. `MATCH_SCHEMA_VERSION`, `RULES_VERSION` and
`CARD_SCHEMA_VERSION` stay where they are for the reason
[ADR 0024](../architecture/0024-live-bot-seats.md) §7 gives, and because a screen
is not a rule.

**One new dependency edge:** `@tcg/web-client` now depends on `@tcg/bot-config`.
That is the direction ADR 0024 §7 chose. `@tcg/bot-config` depends only on
`@tcg/card-data`, `@tcg/shared` and `zod`, so a client rendering a bot seat drags
no pilot, engine or server code in with it, and the ESLint rule that keeps it
that way is unchanged.

## M09.6 — Exact saved-deck mode — **done (2026-08-14)**

Let the host choose one of their own saved legal decks for a bot: the selected
immutable contents are submitted privately as bot configuration and validated
against the server's active format and card pool exactly as a human's submitted
deck is. The list is snapshotted at configuration or start, so a later local edit
cannot alter the live bot deck. Name, Commander, legality and deck hash or
provenance are shown without broadcasting the card list to opponents. Deleted,
edited, stale and illegal saved decks produce actionable errors.

**Acceptance:** legal saved deck, illegal, off-colour, wrong-size and incomplete
decks, post-submit edit, privacy, hash and start-gating tests.

### Checklist

- [x] **Contents travel privately and are validated by the same authority a
      person's deck is.** `add_bot` and `update_bot` already carried
      `botDeckSnapshotSchema` — M09.1 defined it and M09.2 put it on the wire —
      so nothing about the protocol changed; what changed is that
      `resolveBotSeat` now has a resolver for the mode.
      `resolveSnapshotDeck` in `apps/multiplayer-server/src/bot-seats.ts`
      rebuilds a `SavedDeck` from the flat list and runs the identical
      `validateDeck` call `submit_deck` makes, against the same database and the
      same format. A test drives one illegal deck down both routes and requires
      the bot refusal to contain the person's wording, so "judged exactly as a
      human's is" is a comparison rather than a claim. `DECK_MODE_SUPPORT`
      records the mode as supported with no owing tranche — the table M09.3
      refuses from, flipped by the tranche that wrote the resolver.
- [x] **The snapshot is contents, and the freeze is structural.** The client
      sends an immutable copy (`botDeckSnapshotOf` in
      `apps/web-client/src/lib/bot-deck-snapshot.ts`) and the server materialises
      its own `SavedDeck` from it, so there is no reference for a later edit to
      follow. The server test proves it the blunt way: after the bot is seated,
      the host's deck loses half its cards and is renamed, the snapshot object
      that was sent is mutated too, and the seat still holds the original forty.
      The UI test proves the other half — the host goes to the Deck Builder,
      removes a card, comes back, and **nothing was sent**.
- [x] **Name, Commander, legality and fingerprint shown; the list, the name and
      the fingerprint never broadcast.** This tranche owed the decision M09.3
      deliberately left open, and the answer is that a saved deck's name stays
      private. A precon's name reveals nothing because every client already has
      that list; a saved deck's name is the only handle onto a list no opponent
      may see, and its fingerprint is a function of that list — publishing either
      would let an opponent recognise a deck they have met before. What every
      seat sees is what `botDeckSourcePublicSchema` has carried since M09.1: the
      Commander, plus the ordinary `deckLegal` verdict a seat publishes anyway.
      The host sees the name, the card count and the fingerprint, from their own
      configuration. The M09.3 test that asserted `deckName` is null for this
      mode is unchanged and still passes.
- [x] **Deleted, incomplete, edited, stale and illegal decks are all answered by
      name.** `reviewSavedDeckForBot` gives the host one actionable sentence
      before a button is pressed — gone, no Commander, or the validator's own
      wording for the rule it breaks — and the server answers the same four
      conditions on its own authority, with `protocol/bot_deck_illegal` for a
      list it will not accept. A snapshot whose hash does not describe its own
      list is `protocol/bot_config_invalid` naming both hashes and telling the
      host to pick the deck again: that is what an edit racing the send looks
      like on the wire, and seating whichever half won would be worse than
      refusing. A stale but still-legal frozen deck is not an error at all — the
      bot goes on playing what it was given, and the panel says so and offers to
      re-freeze.
- [x] **One fingerprint, computable on both sides.** `deckFingerprint` in
      `@tcg/deck` is pure, dependency-free TypeScript, because the browser has to
      compute the value the server checks. It is deliberately **not**
      `apps/simulator/src/hash.ts`: that one reaches `node:crypto` and is the
      content address of an experiment directory, changing it would rename every
      recorded result, and making its chain portable is M09.8's subject. The
      canonical string is exported so a change to it is visible in a test, and
      entries sort by code unit rather than `localeCompare`, which is not
      identical across ICU builds.
- [x] Verified: the 10 focused tests in `packages/deck/src/fingerprint.test.ts`,
      the 18 in `apps/multiplayer-server/src/bot-saved-deck.test.ts`, the 10 in
      `apps/web-client/src/lib/bot-deck-snapshot.test.ts` and the 11 in
      `apps/web-client/src/bot-saved-deck-flow.test.tsx`, alongside the existing
      server and web-client suites, `npm run check:consistency`,
      `npm run audit:check` and `npm run verify` — 2359 tests in 116 files — all
      pass.

### What the host actually sees

The deck picker gained a source control built from `DECK_MODE_SUPPORT` and a
label map that is total over the four modes, so the two generated modes are
absent because they have no label rather than because a list here forgot them —
and M09.9 and M09.10 turn their own on by filling one in. Choosing "one of your
saved decks" replaces the precon picker with the player's own decks, scoped and
previewed with the same `validateDeck` the builder uses.

Once the bot is seated the host reads the name, the card count and the
fingerprint of what was frozen. That memory lives on `MatchClient`, not in the
panel, and the reason is specific: the private half of the configuration is not
on the wire to read back, and the screen that would hold it is unmounted the
moment the host opens the Deck Builder — which is exactly where the edit that
makes it stale gets made.

### Findings recorded rather than fixed

- **The repository now has two deck hashes, on purpose.** `HASH_VERSION` names
  the simulator's SHA-256 content address; `DECK_FINGERPRINT_VERSION` names the
  portable one M09.6 needed. Both are in `docs/status-audit.md` with what each
  pins. Whether they converge is M09.8's call, when the generator extraction
  answers the `node:crypto` question — and it is a genuine decision rather than
  an oversight, because converging them today would either rename every recorded
  experiment or put `node:crypto` in a browser bundle.
- **A snapshot's `cardIds` has no upper bound.** `botDeckSnapshotSchema` bounds
  each ID and requires at least one, and `validateDeck` refuses anything that is
  not exactly the format's deck size — so an oversized list is rejected, but only
  after it has been parsed. Narrowing the schema is a compatibility question
  rather than a bug fix, and M09.18's compatibility pass is where it belongs.
- **A host who reconnects cannot be told which of their decks a bot is playing.**
  The name and fingerprint are client memory, and the lobby view carries neither
  by design. The seat still shows its Commander and its legality, and the host
  can re-apply a deck to be certain. A host-private lobby projection would fix
  it and would be a protocol change; M09.16, which owns the complete per-bot
  setup surface, is where to decide whether that is worth one.
- **M09.5's finding about inferring "sent, waiting" from the lobby view still
  stands, and now has a second consumer.** `MatchClient.reconcileBotDecks` binds
  an in-flight request to a seat when the next lobby view arrives, matching on
  deck mode and — for `add_bot`, which names no seat — on the first bot seat this
  client has no record of. That is exact for one bot and one host. M09.7's
  concurrent seats should decide whether it stays exact, because two mutations in
  flight are still indistinguishable to it.

### Versions

One new constant, and nothing existing moved.

| Constant                   | Value | Pins                                                                    |
| -------------------------- | ----- | ----------------------------------------------------------------------- |
| `DECK_FINGERPRINT_VERSION` | 1     | The canonical deck string and the digest taken over it, in `@tcg/deck`. |

`PROTOCOL_VERSION` stays 7, and this is the case that shows why M09.1 defined the
whole configuration before any of it was live: `botDeckSnapshotSchema` and the
`exact_saved_deck` member of both deck-source unions have been on the wire since
M09.2, so turning the mode on changed no message shape and refuses no build that
could already talk to this one. `BOT_CONFIG_SCHEMA_VERSION`,
`DIFFICULTY_REGISTRY_VERSION` and `PACING_CONFIG_VERSION` stay 1 — M09.6 acts on
M09.1's shapes without widening one. `DECK_SCHEMA_VERSION` stays 1: a saved deck
is unchanged, and a snapshot is a different record that quotes one.
`MATCH_SCHEMA_VERSION`, `RULES_VERSION` and `CARD_SCHEMA_VERSION` stay where they
are for the reason [ADR 0024](../architecture/0024-live-bot-seats.md) §7 gives —
a bot seat is a controller above the engine, and where its cards came from is not
a rule.

`HASH_VERSION` stays 1 and is untouched. `DECK_FINGERPRINT_VERSION` is a **new**
constant on no existing path: no recorded artifact, replay or experiment
directory is named by it, and nothing that was hashed before is hashed
differently now.

**Compatibility.** Nothing is migrated, because nothing durable was written. A
snapshot lives in an in-memory lobby for the length of a match, and a fingerprint
is recomputed from contents every time it is checked rather than stored.

## M09.7 — Mixed human/bot tables — **done (2026-08-19)**

Support every two-to-four-seat mixture with at least one human: up to three bot
seats, humans in any remaining seats. Multiple eligible bots and independent
pending choices are scheduled without duplicates and without any forbidden
hidden-state access. Free-for-all elimination, Reaction priority, human
disconnect and reconnect, and last-living-player behaviour are all preserved. Host
departure and closed-lobby behaviour follow the current human rules; a bot never
becomes host. Timer callback and action arrival order provably do not change
engine outcomes where order independence is promised.

**Acceptance:** 1H+3B, 2H+2B, 3H+1B, duplicate precons, simultaneous independent
choices, Reaction window, elimination, reconnect, host leave and deterministic
order tests.

### Checklist

- [x] **Up to three bots, and at least one human, enforced in three places that
      agree.** `MAX_BOT_SEATS` is `MAX_SEATS - 1` in
      `packages/protocol/src/messages.ts` — beside the other seat counts, because
      the host's screen and the authoritative lobby both need the number and two
      copies of it would eventually disagree. `freeBotSeats` returns nothing once
      the ceiling is reached, so a fourth `add_bot` is refused with
      `protocol/lobby_full` rather than seated. The guarantee was already
      structural before the constant existed — `freeBotSeats` never offers the
      host's seat and the host seat is created with a person in it — so the
      ceiling is checked as a second lock rather than as the only one, and a test
      asserts both halves: three bots then a refusal, and `seat_1` still human.
      The back half is `closeIfAbandoned`, which counts only _people_: a lobby
      whose last human leaves is closed and its bots discarded, so a table cannot
      outlive the person it exists for.
- [x] **Concurrent independent decisions, taken once each.** The runner
      interleaves seats rather than running them in parallel — one pump asks the
      first seat the engine is offering a move, submits, and comes back round —
      which is what makes duplication structurally impossible: there is never a
      second decision in flight to duplicate. The tests assert what that is worth
      rather than restating it. Three bots answer three simultaneous independent
      mulligans, one `mulligan` each, while the human has answered nothing; every
      committed decision across every seat carries a distinct `${botId}#${index}`
      identity, monotonic from zero per seat and prefixed by the seat's own bot,
      so two bots cannot collide even at the same decision index; and a `submit`
      that re-enters `wake()` twice on every call still produces one decision per
      opportunity in seat order. Nothing new reads hidden state: each seat's
      observation is still the redacted `playerView` for its own player, rebuilt
      at decision time.
- [x] **Elimination, Reaction priority, disconnect, reconnect and the last
      living player are what they were.** A human conceding out of a four-seat
      free-for-all leaves three bots to resolve it between them, down to exactly
      one survivor, with no incident recorded — "this seat is out" is ordinary
      rather than a failure. An open Reaction window is offered to exactly one
      seat at a time throughout a played 1H+3B match, so the runner's seat-order
      scan cannot reorder priority however many bots are eligible elsewhere. A
      dropped human opens exactly one disconnect window, because a bot has no
      connection to lose; the returning player reclaims their seat, cancels the
      timer and is sent the current board. When that window instead expires, the
      server's own `server_timeout` is submitted for the _human_ seat and the
      bots play on from the board it produced.
- [x] **A bot never becomes host.** There is no host migration in the current
      human rules and M09.7 adds none; what it adds is that the seat cannot drift
      to a bot either. `hostSeatId` stays with the person who created the lobby
      when the host disconnects and other people remain, `freeBotSeats` still
      excludes that seat, and the seat view says the same thing to every client —
      the only `isHost` seat is a `human` one.
- [x] **Callback order independence proven, not assumed.** The claim is scoped
      before it is tested: it is about the scheduler callbacks the _runner_
      controls — how often it yields and how often it is woken — and emphatically
      not about the interleaving of genuine game actions, because a human acting
      before or after a bot is a different game. A 1H+3B match played with seven
      extra microtask turns per yield produces the identical sequence, turn,
      result, per-human decision count, per-seat seed, per-seat action tally and
      empty incident list as the same match played with none. A second test
      replays a 2H+2B table exactly from one seed and gets a different match from
      another, so the comparison is not passing by comparing nothing.
- [x] Verified: the 21 focused server tests in
      `apps/multiplayer-server/src/bot-mixed-table.test.ts`, the 13 focused UI
      tests in `apps/web-client/src/bot-mixed-table-flow.test.tsx`, the existing
      server and web-client suites, `npm run check:consistency`,
      `npm run audit:check` and `npm run verify` — 2393 tests in 118 files — all
      pass. One configuration change was needed and is recorded rather than
      hidden: the `server` project in `vitest.config.ts` now carries the same
      60-second per-test timeout the `packages` and `simulator` projects already
      had, because a mixed-table test that plays three complete 2H+2B matches
      exceeded the 5-second default under full-suite parallel load. It passed in
      isolation, so the default was measuring machine load rather than a hang —
      and a genuine loop is still caught by the runner's per-seat decision limit
      and each test loop's own round ceiling, which is the reason the config's
      existing comment already gives for the other two projects.

### What the host actually sees

One form per seated bot, each named by the seat it belongs to — `Seat 3 style`
rather than a third control called `Bot style` — plus one form for the next bot,
which keeps the unscoped names because it belongs to no seat yet and the server
is what decides where it lands. Nothing on this screen chooses a seat, so nothing
on it can race a joining human for one.

**One mutation at a time, deliberately.** Every control in the panel is disabled
while a request is in flight, whichever seat it was about. That is the answer to
the question M09.5 and M09.6 both left open: there is no per-request
acknowledgement on this wire, so `MatchClient.reconcileBotDecks` binds what was
sent to a seat by reading the next lobby view, which is exact for one outstanding
request and ambiguous for two. Serialising them keeps it exact for three bots as
cheaply as it did for one; the alternative — a second idea of "the current
configuration" on the client — is the thing ADR 0024 §3 exists to avoid.

The two reasons another bot cannot be seated are said separately, because the
host fixes them differently: a full table can be made bigger, and the bot ceiling
cannot. Both leave the control present and disabled with its reason beside it,
which is the same answer M09.5 gave a full table.

### The mixed-exact-decks checkpoint

**Reported explicitly, as the milestone requires.** What is genuinely usable is
exactly what the checkpoint table promises: up to four mixed seats — one to three
bots and at least one human — each bot playing a shipped precon or one of the
host's saved decks, at Normal and instant. The three other deck modes, Easy,
Hard, pacing, reroll and the pacing summary are still absent rather than present
and refused, and nothing after this tranche was started.

### Findings recorded rather than fixed

- **A concession during the mulligan phase deadlocks the board, and it predates
  every bot.** `handleMulligan` advances only when every player in `playerOrder`
  has submitted one, and `legalActions` returns nothing at all for an eliminated
  seat — so a player who concedes or times out _during_ the mulligan phase leaves
  a mulligan nobody can ever answer. It is reachable on a human-only path (two
  people, one closing the tab) and changing it is a rules decision about what an
  eliminated seat owes a phase, not a runner change. What M09.7 owed was that the
  runner meets it honestly, and a test pins that down: the board is recorded as
  `stalled`, every bot has answered its own mulligan, and **no bot concedes to
  unstick it**. The two tests that need to get past the mulligan phase say so and
  play into turn 3 first, rather than quietly working around it.
- **"Concurrent" is interleaved, not parallel, and the tests say so.** Several
  bots eligible at once are asked one after another within a single pump. That
  satisfies the tranche's requirement — every eligible decision taken exactly
  once, no duplicates — and it is why the tests assert one committed decision per
  opportunity in seat order rather than asserting overlap. Genuinely concurrent
  waiting is M09.12's, because until a bot waits there is nothing to overlap.
- **The client still infers "sent, waiting" from the lobby view.** M09.5 recorded
  it and M09.6 added a second consumer; M09.7 does not remove the inference, it
  bounds it, by making one outstanding request the only state the panel can be
  in. A per-request acknowledgement would be a protocol change, and M09.16 — which
  owns the complete per-bot setup surface — is where to decide whether the
  concurrent-mutation experience is worth one.
- **A four-bot table is unreachable by two independent rules, and both are kept.**
  The host seat is never offered to a bot, so a fourth bot had nowhere to go even
  before `MAX_BOT_SEATS` existed. The constant is not redundant defence for its
  own sake: it is the number the host's screen needs in order to say _why_ it is
  not offering another bot, and checking it in `freeBotSeats` means a later change
  to seat allocation cannot produce an all-bot table by accident and have it read
  as a bug in something else.

### Versions — deliberately unchanged

Nothing moved. `MAX_BOT_SEATS` is a **new** constant and is not on a wire: no
message carries a bot count, no seat view publishes one, and both sides derive it
from `MAX_SEATS`, which has not changed — so a v7 client and a v7 server agree
about it without ever exchanging it, and `PROTOCOL_VERSION` stays 7. No message
shape changed, no schema widened and no difficulty appeared, so
`BOT_CONFIG_SCHEMA_VERSION`, `DIFFICULTY_REGISTRY_VERSION` and
`PACING_CONFIG_VERSION` stay 1. `MATCH_SCHEMA_VERSION` and `RULES_VERSION` stay
where they are for the reason [ADR 0024](../architecture/0024-live-bot-seats.md)
§7 gives: the runner is a controller above the engine, `createMatch` is handed an
ordinary seat list of two to four players exactly as it always was, and
`MatchState` still does not know what a bot is. `SEED_DERIVATION_VERSION` stays 2
— `botSeedFor` is unchanged, and a third and fourth bot seat simply derive their
own streams from it, which is what per-seat derivation was for.

**Compatibility.** Nothing is migrated, because nothing durable was written. A
mixed lobby is in memory for the length of a match, and the ceiling is recomputed
from the seat map every time a bot is added.

## M09.8 — Shared quick deck generator extraction — **done (2026-08-19)**

Reuse one deterministic legal generator in both the simulator and live lobbies:
move or extract the reusable part of `apps/simulator/src/deck-search/` into the
smallest suitable shared package without changing existing search output for
identical inputs, leaving evolution and search orchestration in the simulator
app. The extracted generator accepts a format-scoped database, a Commander
constraint, an optional plan or package policy, role and curve settings and a
deterministic seed, and returns either a legal immutable deck with provenance or
structured named generation problems — never a repair that reaches outside the
format. It reports legal-pool size and the forced-inclusion floor.

The supported environments are **stated rather than assumed**: the current chain
reaches `node:crypto` through `apps/simulator/src/hash.ts`, so either the
extraction removes that dependency deliberately or the package declares itself
server-only.

**Acceptance:** simulator equivalence on identical inputs, declared-environment
compatibility, Commander legality, singleton and size, package policy,
deterministic seed, insufficient pool, unsupported card, and structured-error
tests.

**Exclusion:** no lobby generated-deck mode yet.

### Checklist

- [x] **Generator in a shared package; search orchestration left behind.**
      `@tcg/deck-generator` holds five modules and nothing else: `generate.ts`
      (the draw), `deck.ts` (the deck value and `checkDeck`), `plan.ts` (plan
      resolution and conformance), `hash.ts` (the content address a deck is named
      by) and `environment.ts` (the input the draw actually reads). `evolve.ts`
      and `mutate.ts` stayed in `apps/simulator/src/deck-search/`, which is now
      exactly the search — fitness, hall of fame, populations across generations,
      checkpoints, mutation and crossover — and imports the generator the way
      anything else does.
- [x] **Byte-equivalent output for identical inputs, proven against the
      simulator.** Ten results were recorded from the pre-move code at `808e7e4`
      and are replayed through the extracted package: seven single decks across
      the real `precon_wave_1` pool (two default seeds, a fixed Commander, a
      curve-and-role weighting, a plan at `all` and at `core`, and a required
      card), one four-deck stratified population, and two more from the
      simulator's own twelve-card fixture environment. Each golden is `digestOf`
      over the **whole** `{ deck, diagnostics }` result, so a label, an origin
      field, a construction verdict or a diagnostic that moved fails alongside a
      card that moved.
- [x] **Legal deck plus provenance, or named problems; never a silent repair.**
      `validateDeck` is still the final authority, reached through `checkDeck`,
      and a deck that fails it comes back `null` with the failing issues rather
      than adjusted; `GENERATION_PROBLEM_CODES` names all fifteen codes the
      package can emit, across the draw, plan resolution and the final legality
      check, and `runtime.test.ts` reads the sources and fails when a `sim/` code
      exists that the list does not name, so a caller can branch on a refusal
      instead of matching prose. Provenance is recorded rather than inferred,
      exactly as M05.5 left it — a deck the draw produced says `unconstrained`
      even when it happens to hold a whole package — and "never reaches outside
      the format" is asserted directly: every card of every generated deck is in
      the environment's pool, and a required card the Commander cannot run is
      skipped and named rather than added. The returned deck is now **frozen**,
      entries included, because a deck is named by a hash of its own contents and
      a caller that edited one in place would be holding an ID that describes a
      different list.
- [x] **Legal-pool size and forced-inclusion floor reported.**
      `GenerationPoolReport` rides on every result that got as far as choosing a
      Commander, and `poolReportFor` computes it alone for a caller that has not
      generated yet. The floor is arithmetic rather than a guess:
      `slack = poolCapacity - deckSize` is the copies a deck may leave out, and
      `forcedInclusionFloor = deckSize - slack` is what any two legal decks under
      that Commander must share, clamped into `[0, poolCapacity]` so a pool too
      small to fill a deck reports every card as forced rather than more than it
      has. The four Wave 1 Commanders measure 42/41/41/42 legal cards against a
      40-card deck, which is a floor of 38/39/39/38 — the "generated decks are
      minimally different from each other" claim, as a number a screen can print.
      The field names are `legalPoolSize` and `forcedInclusionFloor` because
      `generatedDeckProvenanceSchema` in `@tcg/bot-config` has been asking for
      exactly those two since M09.1.
- [x] **Supported environments declared, with the `node:crypto` question
      answered.** Server-side Node only, and deliberately so.
      `SUPPORTED_RUNTIMES` and `NODE_BUILTIN_DEPENDENCIES` say it in
      `version.ts`, `package.json` carries the matching `engines` field, and
      `runtime.test.ts` scans the package's own sources and fails when a Node
      built-in appears that the declaration does not name, so the statement
      cannot quietly become false. Removing the dependency was rejected on its
      merits rather than skipped: `crypto.subtle` has no synchronous digest, so
      portability would mean either an asynchronous generator or a second hash
      implementation, and a second implementation is how one seed comes to name
      two different decks on two machines. Nothing in M09 needs the browser —
      generation happens on the authoritative server, and a client is told a
      Commander and a hash. [ADR 0024](../architecture/0024-live-bot-seats.md) §6
      records the choice beside the constraint that prompted it.

### What moved, and what deliberately did not

The input shrank. `generateDeck` took the simulator's `Environment` — content
hashes, a rules configuration, a resolved config, a set list — and read five
fields of it. It now takes `GenerationEnvironment`, which _is_ those five fields,
and the simulator's `Environment` satisfies it structurally, so no call site had
to be adapted. `generationEnvironmentForFormat` builds one from a bundled format,
which is how a caller with no simulator obtains a **format-scoped** pool rather
than the bundled universe; an unknown format throws instead of falling back.

Two things moved that are not in `deck-search/`. `hash.ts` came because deck
identity is part of what a generated deck _is_ — `makeDeck` names a deck by a
hash of its own contents — and a second implementation of that hash is precisely
the drift that would let one seed name two decks. `apps/simulator/src/hash.ts` is
now a re-export, because the simulator content-addresses far more than decks and
every one of those addresses has to be taken by the same function as every other.
`seed.ts` did **not** move: the generator only ever used `rngFor`, which is
`createRngState` under another name, so it now calls the engine directly and the
seed hierarchy stayed with the experiments it derives.

### How the equivalence claim is proven

Twice, because it is two claims.
`packages/deck-generator/src/equivalence.test.ts` replays the recorded inputs
through the package's own format-scoped environment;
`apps/simulator/src/deck-search/equivalence.test.ts` replays them through a full
simulator `Environment` and through `tinyEnvironment()`, and then asserts
deck-for-deck that the two environments agree. That last assertion is what makes
`generationEnvironmentForFormat` a checked claim rather than a plausible one: it
resolves the same 148-card pool and the same four Commanders the simulator
resolves, or the decks would differ.

The goldens live in `test-goldens.ts` with the commit they were taken at.
Re-recording one to make a test pass is the single thing that file exists to
prevent; if one ever has to move, it moves with `DECK_GENERATOR_VERSION` and with
a recorded reason.

### Names and codes deliberately unchanged

`SimDeck`, `simDeckSchema` and the `sim/` diagnostic prefix moved into a shared
package still carrying a simulator's vocabulary, and that is a decision rather
than an oversight. The codes appear in recorded run diagnostics, and renaming one
rewrites the meaning of records nobody can re-run; the type names appear in a
versioned search checkpoint and in about two hundred places this tranche has no
other reason to touch. M09.8's whole constraint is that identical inputs produce
identical output and that the search keeps working, and a two-hundred-site rename
that changes no behaviour is the least safe way to spend that budget. A later
tranche may rename them; it will be a change with its own reason rather than a
side effect of a move.

### Findings recorded rather than fixed

- **`sim/pool_exhausted` is unreachable today.** The draw checks pool capacity
  against deck size before it starts, and no path afterwards reduces capacity, so
  the mid-draw exhaustion branch cannot fire. It is kept — a guard that costs
  nothing and would catch a future required-card or package rule that consumes
  slots the capacity check did not anticipate — and it is named in
  `GENERATION_PROBLEM_CODES` so it stays honest. No test asserts it, because a
  test would have to fake a state the code cannot reach.
- **`generatePopulation` reports no pool.** It generates across several
  Commanders, so there is no single pool report to attach, and inventing one for
  the first Commander would be worse than none. A caller that wants the numbers
  per deck has `poolReportFor`. M09.9 generates one deck at a time, so nothing
  needs this yet.
- **The `engines` field is a declaration, not an enforcement.** npm warns rather
  than refuses, and nothing at runtime checks it; `runtimeIsSupported()` exists
  for a caller that wants to. The check that actually bites is the source scan in
  `runtime.test.ts`.

### Versions

`DECK_GENERATOR_VERSION` is **new**, and is `'1'` — a string because
`generatedDeckProvenanceSchema.generatorVersion` is one, and a version a recorded
deck cannot cite is not a version. It pins the _draw_: the weighting, the
ordering, the stopping rule. It did not start at 2 despite the code moving,
because the code moving is precisely what the equivalence goldens prove changed
nothing, and a new report field and a new diagnostic registry do not change which
cards come out for a seed. It is in `docs/status-audit.md` under registries and
instruments, beside the pilot versions it most resembles.

Nothing else moved. `HASH_VERSION` stays 1 and stays a single implementation: it
changed address, not algorithm, and `deckHash` embeds it in the string it hashes,
so a bump would have shown up in every golden. `PROTOCOL_VERSION` stays 7 — no
message shape changed and no lobby deck mode was added, which is this tranche's
stated exclusion. `SEARCH_CHECKPOINT_VERSION` stays 2: a checkpoint holds
`simDeckSchema` records and the schema is byte-identical, so a checkpoint written
before this tranche resumes after it. `MATCH_SCHEMA_VERSION`, `RULES_VERSION`,
`SEED_DERIVATION_VERSION` and the three `@tcg/bot-config` versions stay where
they are; none of them describes where a function lives.

**Compatibility.** Nothing is migrated because nothing durable changed shape.
Recorded search checkpoints, match records, reports and experiment configurations
all keep the fields they had; the one moved constant is `HASH_VERSION`, whose
value and algorithm are unchanged, so every existing content address still
resolves to the same string. The extraction is source-level only: no artifact
written before it is read differently after it.

## M09.9 — Host-selected Commander generation — **done (2026-08-20)**

Let the owner choose a Commander while the bot builds the deck: legal implemented
Commanders are exposed from the active format; a legal deck is generated and
frozen under the selected Commander with its seed, generator version,
construction mode, hash and forced-inclusion warning recorded. Explicit reroll is
supported before match start, each with a deterministic recorded seed transition.
The list stays private through lobby and match and is revealed or exported after
completion. Unknown, off-format, incomplete and impossible Commander generation
is refused by name.

**Acceptance:** Commander selection, legality, deterministic generation, reroll,
freeze, privacy, post-match reveal and export, forced-inclusion warning and
refusal tests.

### Checklist

- [x] **Legal implemented Commanders offered from the active format only.**
      `playableCommanders` in `@tcg/deck` is the one rule, and it is the rule
      `validateDeck` already had: `commanderIssues` was extracted out of
      `validateCommander` unchanged, so "which Commanders may a bot's deck be
      generated under" and "is this deck's Commander legal" cannot drift apart.
      Three readers share it — the lobby screen offers the Commanders it returns
      nothing for, `generateBotDeck` refuses the rest under the same
      `deck/commander_*` codes, and the deck the generator produces is validated
      by the function the split came out of. Both readers run it against a
      **format-scoped** database: the bundled universe publishes eight more
      Commanders than `precon_wave_1` does, and each side's test asserts that
      none of the eight is offered.
- [x] **Deck generated, frozen, and identified by seed, version, mode and hash.**
      `generateBotDeck` builds the environment from the server's _own_ database
      and format — not a second lookup — so a deck cannot be legal to the
      generator and illegal to the lobby that seats it, and it restricts
      `generateDeck` to the single requested Commander so the generator's own
      fallback to a random legal one is unreachable rather than merely unwanted.
      What it returns is a `SavedDeck` the seat plays plus a
      `GeneratedDeckProvenance` naming it: generator version, construction mode,
      format, seed, reroll count, Commander, content hash, and the pool report.
      The freeze is the same one M09.6 established — the seat holds a
      materialised deck, and the match is played from it.
- [x] **Reroll before lock, with a recorded deterministic seed transition.**
      `reroll_bot` carries **no seed**. The server rebuilds the seat's own setup,
      adds one to the reroll count and derives the next seed from the base and
      the count (`generationSeedFor`: reroll 0 _is_ the host's seed, every later
      one a suffix), so the recorded transition n → n+1 is reproducible from the
      two values the provenance already carries and is not something a client
      could invent. A reconfiguration keeps its place in the stream unless the
      host changed what _names_ the stream — the Commander or the base seed —
      because otherwise renaming a bot would silently undo three rerolls. A
      refused generation leaves the previous deck in place.
- [x] **Private during play; revealed or exported after completion.** The public
      seat projection publishes the Commander and has no seed in it to strip, so
      the value that would rebuild the list card for card never reaches an
      opponent. Provenance travels down the **host's own connection** as
      `bot_seat_provenance`, restated beside every lobby update so it cannot go
      stale, and dropped by the client for a seat that stops being a generated
      bot. `bot_decks_revealed` is broadcast to **every** seat once, at the moment
      the match's status becomes complete — the promise is to the opponents, so
      they are the ones who eventually read the list — and the board renders it
      beside the result with an export button that writes exactly what arrived.
- [x] **Forced-inclusion warning shown; impossible generation refused.** The
      warning is arithmetic from `legalPoolSize` and `forcedInclusionFloor`
      rather than a sentence written into the screen, so it stays true when the
      pool changes: 41 legal cards for a 40-card deck is a floor of 39 and two
      cards of choice, which is what a host is told a reroll can change. Four
      refusals, each by name: a Commander ID this format does not publish is
      distinguished from one that names nothing at all, a card in the format that
      cannot lead a deck here is refused under `validateDeck`'s own codes, an
      impossible generation carries the generator's own problem codes, and a
      setup that _describes_ a deck the server did not build is refused rather
      than ignored.

### What the host actually sees

One picker per bot, and the Commander control only once the generated mode is
chosen — a mode with no resolver is still absent rather than disabled, which is
how `autonomous_generated` remains off. The seed is an editable text field
because it is an _instruction_: the same seed and Commander name the same deck on
this build, so a host who writes one down can ask for that deck back, and the
test proves it from two cold starts rather than from one screen's memory.
Switching into the mode starts a _fresh_ stream rather than reusing the last
seed, so seating two bots does not quietly seat one deck twice.

Once the server answers, the seat says what was built — Commander, seed, reroll
number, generator version, deck hash — followed by the forced-inclusion warning.
Before it answers, the seat says it does not know, because a client that has not
been told cannot reconstruct a seed from a public Commander. The reroll button
exists only for a seat with a generator behind it; rerolling an exact list is
refused by name on the server, and a control whose only outcome is that refusal
is not offered.

### Findings recorded rather than fixed

- **The export is a match record, not a deck.** It writes the revealed messages
  as they arrived, including provenance, rather than a `SavedDeck` the Deck
  Builder would import. Writing an importable deck would quietly turn "what my
  opponent played" into "a deck of mine", which is a content decision nobody has
  made. A host who wants to build it can read the list and build it.
- **The reveal carries no hash of its own.** The cards are in the message, so a
  reader who wants a fingerprint can take one; the two the project already has —
  `DECK_FINGERPRINT_VERSION` in `@tcg/deck` and `HASH_VERSION` in
  `@tcg/deck-generator` — answer different questions and would not match, so
  carrying one beside the cards would only create something to disagree with.
- **A precon bot is revealed too.** Its list was never private, but leaving it
  out would make the message's meaning depend on each seat's mode rather than on
  the match being over. The rule ADR 0024 §3 states covers a generated list _and_
  a saved deck the host selected; a precon riding along costs nothing and keeps
  the message uniform.
- **Two generated bots under the same Commander are near-identical by the
  format, not by the draw.** 41 legal cards for a 40-card deck leaves two cards
  of choice. The screen says so rather than implying variety the content cannot
  supply; the fix is the 50-card expansion, which is content and is not started.
- **`generatePopulation` still reports no pool**, as M09.8 recorded. Nothing here
  needs it: a lobby generates one deck at a time.

### Versions

`PROTOCOL_VERSION` moves **7 → 8**. Two new server messages carry what a
`LobbyView` cannot: `bot_seat_provenance`, host-only, because a generator seed
would turn "the Commander is public" back into "the list is public"; and
`bot_decks_revealed`, broadcast, because the privacy promise is only kept if the
opponents are the ones who eventually read the list.
[ADR 0024](../architecture/0024-live-bot-seats.md) §7 predicted the constant
would move exactly once in M09 and now records the correction rather than the
guess — the principle it states is unchanged, and it is what governs here.

Nothing else moved. `BOT_CONFIG_SCHEMA_VERSION`, `DIFFICULTY_REGISTRY_VERSION`
and `PACING_CONFIG_VERSION` stay where they are: `commander_generated`,
`botDeckSourceSchema` and `generatedDeckProvenanceSchema` have been in
`@tcg/bot-config` since M09.1, and this tranche turned a support flag on rather
than changing a shape. `DECK_GENERATOR_VERSION` stays `'1'` — no draw changed.
`DECK_SCHEMA_VERSION`, `MATCH_SCHEMA_VERSION`, `RULES_VERSION` and
`SEED_DERIVATION_VERSION` stay too: a generated deck is an ordinary `SavedDeck`,
`MatchState` still does not know what a bot is, no legal action changed, and
`generationSeedFor` is a new derivation rather than a changed one.

**Compatibility.** `serverMessageSchema` is a discriminated union parsed on
receipt, so a v7 client would fail to decode the first `bot_seat_provenance` it
received mid-lobby, or the first `bot_decks_revealed` at the moment a match
ended. It never gets that far: the handshake compares versions and refuses
first, naming which side is older. Nothing durable changed shape, so nothing is
migrated — saved decks, match records and replays all keep the fields they had,
and a lobby that seats no generated bot puts neither message on the wire.

## M09.10 — Full AI Commander-and-deck choice — **done (2026-08-20)**

Let a bot choose its own legal Commander and construct its deck: selection is made
among active-format legal implemented Commanders from a deterministic bot
deck-selection seed, independently of any opponent's private deck or hand, with
the information boundary recorded. The deck is generated and frozen through the
shared generator. The chosen Commander is public; the list stays private until
match end. Reroll is supported, and selection and generator provenance are
recorded. A bot must never prefer a Commander because the server happens to know
another seat's exact deck.

**Acceptance:** determinism, all-Commander eligibility, no-hidden-counterpick,
reroll, freeze, insufficient pool, public-Commander and private-list, and
multiple-bot independent-seed tests.

### Checklist

- [x] **Deterministic Commander selection from its own seed.**
      `selectBotCommander` draws one candidate with `nextInt` from a stream
      `commanderSelectionSeedFor` derives — the generation seed with a
      `:commander` suffix, so the choice and the cards are two streams rather
      than two reads of one cursor. Candidates are sorted by ID with a plain
      code-point comparison rather than by `localeCompare`, because the display
      order a caller hands over is locale-sensitive and a draw whose result
      depended on the server's ICU build would be a different deck on a different
      machine from the same recorded seed. Two cold-started lobbies given one
      seed produce an identical Commander, deck hash and card list.
- [x] **No hidden counterpick, and a test that proves it.** The proof is the
      signature: `selectBotCommander(candidates, seed)` has no third parameter,
      so a lobby, a seat, an opponent's hand and an opponent's saved deck are
      unreachable rather than merely unread. Behaviourally, one seed is seated
      against two deliberately different opponents — after the server has already
      validated and stored each of their decks — and the resulting **deck hash**
      is required to be identical, not only the Commander, because a counterpick
      could as easily be a different draw under the same one. The same bot seated
      before and after its opponent joins builds the same deck.
- [x] **Deck frozen through the shared generator with full provenance.**
      `generateAutonomousBotDeck` chooses, then calls the same
      `buildGeneratedDeck` a host-chosen Commander goes through — same pool, same
      refusals, same `validateDeck`, same provenance shape. `mode` is the only
      difference recorded, which is the honest one: it says who picked. A seed
      and a Commander therefore name one deck whichever mode produced it, and a
      test builds the pair both ways and compares the hash.
- [x] **Commander public, list private until completion.** `publicDeckSourceOf`
      already projected this mode to a nullable Commander and no list; the seat
      publishes the Commander the bot chose, and the guest's entire traffic is
      searched for the seed, the deck hash and every card ID and must contain
      none of them. Provenance goes to the host alone over `bot_seat_provenance`;
      `bot_decks_revealed` broadcasts the list to every seat once the match
      completes, carrying `mode: 'autonomous_generated'` so a reader can say the
      bot chose rather than infer it from a missing deck name.
- [x] **Multiple bots select independently.** Each seat's Commander is the one
      its **own** seed names, asserted seat by seat against a standalone
      computation, so neither the seat ID nor the order the bots were added can
      move a choice. One seed seated in two different lobbies at two different
      seats builds the same deck, which is M09.9's "a host can reproduce a deck
      without reproducing a seating", kept.

### What the host actually sees

The smallest of the four modes: a seed, and nothing else. There is no Commander
control, because a control that pre-empted the choice would be the previous mode
wearing this one's label — and one sentence in its place says what the bot picks
from (this format's playable Commanders, counted from the same list the server
chooses out of) and what it cannot see while picking. Switching into the mode
starts a fresh stream, so seating two bots does not quietly seat one deck twice.

Once the server answers, the seat says **the bot chose** rather than "built for",
read off `provenance.mode` so the sentence cannot disagree with the record it
describes, followed by the Commander, seed, reroll number, generator version and
deck hash. The forced-inclusion warning is the same arithmetic with a different
promise attached: 41 legal cards for a 40-card deck still leaves two of choice,
but a reroll here picks the Commander again as well, so the screen says it can
change more rather than implying the same two-card ceiling.

### Findings recorded rather than fixed

- **A Commander whose pool cannot fill a deck is refused, not swapped.** Trying
  the next candidate down the list would be a repair policy — and an invisible
  one, because the provenance would record the Commander that worked and say
  nothing about the one that did not. No shipped content reaches this state; the
  refusal carries the generator's own problem codes, and a host's remedy is a
  different seed.
- **Two bots given the same seed choose the same Commander.** Determinism is the
  point, and the alternative — mixing the seat ID into the selection stream —
  would break "a recorded seed reproduces this deck", which is the property the
  seed exists for. The panel generates a fresh seed per draft, so it takes
  deliberate typing to reach.
- **A reroll keeps the Commander about a quarter of the time.** Four candidates,
  one uniform draw. The test that asserts a reroll can move the Commander
  searches a small fixed list of seeds for one where it does, rather than
  asserting luck about a single seed.
- **The public projection's `null` Commander is still unreachable.** A seat is
  resolved completely or not seated at all, so a bot's Commander exists by the
  time the seat does. The nullable case is rendered honestly anyway — no tag
  rather than a placeholder — because the shape allows it and a screen that
  guessed would be the thing ADR 0024 §3 is about.
- **`rerollUnsupportedDetails`' first branch is now unreachable.** Every deck
  mode has a resolver, so no generated mode is refused for want of one. It is
  kept, and `DECK_MODE_SUPPORT` with it, so a fifth mode arrives as a refusal
  naming its owner rather than as a crash.

### Versions — deliberately unchanged

`PROTOCOL_VERSION` stays **8**. Nothing new is on the wire: `autonomous_generated`
has been a member of `botDeckSourceSchema`, `botDeckSourcePublicSchema` and
`generatedDeckProvenanceSchema` since M09.1 and on the wire since M09.2, and both
messages this mode uses — `bot_seat_provenance` and `bot_decks_revealed` — were
added by M09.9. This tranche turned a support flag on and wrote the resolver
behind it, so an older build is refused by the handshake for the reason it
already was, and a lobby that seats no bot puts nothing extra on any wire.

`BOT_CONFIG_SCHEMA_VERSION`, `DIFFICULTY_REGISTRY_VERSION` and
`PACING_CONFIG_VERSION` stay where they are for the same reason: no shape moved.
`DECK_GENERATOR_VERSION` stays `'1'` — the draw is the one M09.8 extracted,
unchanged, and choosing which Commander to hand it is not a change to it.
`SEED_DERIVATION_VERSION` stays **2**: `commanderSelectionSeedFor` is a new
derivation beside `generationSeedFor` and `botSeedFor`, not a changed one, and no
previously recorded seed resolves differently. `MATCH_SCHEMA_VERSION`,
`RULES_VERSION`, `DECK_SCHEMA_VERSION` and `CARD_SCHEMA_VERSION` stay: a
generated deck is an ordinary `SavedDeck`, `MatchState` still does not know what
a bot is, no legal action changed, and no card was authored.

**Compatibility.** Nothing durable changed shape, so nothing is migrated. A
`SavedDeck`, a match record and a replay all keep the fields they had. The only
observable difference to an existing client is that the deck-source picker offers
a fourth option and the server accepts it, which is additive on both sides.

## M09.11 — Bot pacing configuration and UI

Configure concrete percentages without changing match behaviour yet: lobby-level
ordinary/choice and Reaction pacing budgets, initially 30 and 5 seconds, labelled
clearly as **bot pacing references rather than human timers**; per-bot 0–100%
timing with an advanced Reaction override; calculated seconds shown beside every
percentage; settings persisted and locked at match start and shown in lobby and
result provenance; a pacing configuration version recorded. Q8 stays open in the
rules documents, and the tranche explains why `RULES_VERSION` does or does not
move.

**Acceptance:** 0/50/100%, changed budget, override and inherit, safety-margin
display, lock, protocol refusal, and Q8 non-regression tests.

**Exclusion:** bots still act immediately until M09.12.

### Checklist

- [ ] Lobby budgets, per-bot percentage and Reaction override configurable.
- [ ] Seconds displayed beside every percentage.
- [ ] Locked at start and shown in provenance.
- [ ] Pacing configuration version recorded.
- [ ] Q8 still open in `docs/open-questions.md`; version reasoning written down.

## M09.12 — Server bot-delay scheduler

Make live bots wait for the configured fraction, safely: classify each
opportunity as ordinary, pending choice or Reaction from structured state and
view data; schedule from the applicable budget and percentage using an injectable
monotonic clock; at expiry rebuild the current observation and legal actions and
decide **then**, never storing a chosen action during the wait; cancel obsolete
work on sequence or eligibility change, reconfiguration, bot removal, a human
action where applicable, elimination and match end; run independent bot delays
concurrently where the engine permits independent choices; record intended and
actual delay without feeding clock values into pilot RNG or engine state. The
simulator and Spectator stay delay-free.

**Acceptance:** fake-clock exact delays, 0/50/100%, safety margin, Reaction
override, stale cancellation, revalidation, concurrent choices, match end,
deterministic outcome, and simulator and Spectator non-regression tests.

### Checklist

- [ ] Decision categories classified from structured data.
- [ ] Injectable clock; every delay tested without waiting.
- [ ] Decision made at expiry, never stored during the wait.
- [ ] Obsolete work cancelled on every named trigger.
- [ ] Clock values never reach pilot RNG or engine state.
- [ ] Simulator and Spectator remain full speed.

## M09.13 — Difficulty registry, Easy, and Normal

Ship two honest, observably different difficulty levels. Normal stays
decision-equivalent to the current published heuristic for the same style,
observation and RNG seed, unless a versioned correction is genuinely required.
Easy is deterministic bounded suboptimality over scored legal candidates — not
uniform random, not an illegal action, not free concession, not deliberate
non-participation — with its candidate band, temperature or error budget defined
explicitly and versioned. Aggressive, defensive and value remain independent
styles; Automatic is added only when it has a deterministic documented mapping.
Calibration and contract tests are extended to prove legality, reproducibility,
and that Easy differs — without claiming every Easy choice is worse.

**Acceptance:** per-style Normal equivalence, Easy legality, seeded variation,
bounded candidate quality, no concession or timeout, difficulty version and
provenance, and UI selection tests.

**Exclusion:** Hard is visible only as unavailable until M09.15 completes.

### Checklist

- [ ] Normal equivalent to the published heuristic per style, seed for seed.
- [ ] Easy defined as an explicit, versioned, bounded degradation.
- [ ] Styles stay independent of difficulty.
- [ ] Difficulty version and provenance recorded on every match.

## M09.14 — Hard tactical improvements

Make Hard materially better at immediate combat and target decisions: address the
named M05.6 calibration gaps for removal lethality and for blocking that
preserves a better defender instead of blindly trading; prefer lethal and
preventive outcomes using only redacted observation and legal candidates; add
focused boards for attacks, blocks, Barrier, Overwhelm, Guardians, removal and
multiplayer target choice; record the new pilot and difficulty version together
with its support and evidence limits; preserve Easy and Normal behaviour unless a
separately justified shared correction is required.

**Acceptance:** named tactical fixtures improve, no hidden-state access,
legality, determinism, multiplayer targeting, calibration-record update, and
Easy/Normal non-regression tests.

**Exclusion:** Hard is not complete until the strategic gaps are addressed.

### Checklist

- [ ] Named M05.6 tactical gaps addressed, with fixtures that show it.
- [ ] Only redacted observation used; no hidden state.
- [ ] Multiplayer target choice covered.
- [ ] Easy and Normal unchanged, and proven unchanged.

## M09.15 — Hard sequencing and resource improvements

Complete Hard with better short-horizon sequencing and resource reservation:
address the named M05.6 gaps for Relic-before-Unit sequencing, additional-sacrifice
payoff, and holding Energy for a Reaction window, using bounded inspectable
short-horizon evaluation rather than a reconstruction of hidden state or an
unbounded search. Test all four Wave 1 archetype plans on representative
decisions and record the remaining known gaps rather than claiming solved play.
Publish Hard only when it outperforms Normal on the declared fixture set without
regressing legality or termination, and keep its evidence class honest.

**Acceptance:** sequencing, sacrifice-payoff, resource-hold, four-precon coverage,
bounded runtime, legality, determinism, difficulty provenance and comparative
fixture tests.

### Checklist

- [ ] Named M05.6 strategic gaps addressed within a bounded horizon.
- [ ] All four Wave 1 archetypes covered by representative decisions.
- [ ] Hard beats Normal on the declared fixtures, and the fixtures are declared.
- [ ] Remaining gaps recorded; no claim of solved play.

## M09.16 — Style automation and complete per-bot setup

Present every approved option coherently for each bot: deck mode, difficulty,
style, timing, Reaction override and reroll, through progressive disclosure.
Automatic style uses a deterministic mapping from recorded deck construction or
archetype data and names its fallback; it never infers from display text. One
bot's configuration can be copied to other bot seats without copying RNG state by
accident. What is locked, generated, private, unavailable, or limited by the
small current card pool is stated. Keyboard accessibility, narrow and wide
layouts, and actionable errors are preserved.

**Acceptance:** every setting combination, copy-with-new-seed, automatic
fallback, privacy, reroll, lock, accessibility and responsive component tests.

### Checklist

- [ ] Full per-bot configuration with progressive disclosure.
- [ ] Automatic style deterministic, from structured data, with a named fallback.
- [ ] Copy configuration without copying seeds.
- [ ] Locked, private, unavailable and pool-limited states all stated.

## M09.17 — Pacing and bot provenance summary

Let testers judge waiting time before M08's durable Player Meta exists: produce a
structured match-local summary carrying wall-clock match duration, configured
budgets and percentages, bot decisions by category, intended and actual wait
totals and distributions, total time attributable to bot pacing, pilot failures,
deck source, difficulty, style and version, Commander and deck hash. Show an
end-of-match Pacing Summary with exact values and plain-language limits, and allow
JSON export for manual playtest notes. Engine turns and actions stay separate
from wall-clock and pacing metrics. Define a clean ingestion seam for later M08
live telemetry without pretending this is already a durable server analytics
store.

**Acceptance:** fake-clock aggregation, multi-bot attribution, immediate bot,
cancelled-delay exclusion, failure, export round trip, privacy and result-UI
tests.

### Checklist

- [ ] Structured match-local summary with every field above.
- [ ] Engine metrics and wall-clock metrics kept separate.
- [ ] JSON export round-trips.
- [ ] Ingestion seam defined; no claim of durable analytics.

## M09.18 — Help, provenance, and compatibility pass

Make the feature understandable and every artifact honest: add player help for
adding bots, the three deck modes, privacy, difficulty versus style, timing
percentages, bot pacing versus human timeout, and the small-pool limitation.
Lobby, match and result surfaces name bots and controllers consistently. Bot
configuration, deck, generator, pilot and difficulty versions, seed derivation
and pacing version are recorded wherever the current artifact contract requires
them. Incompatible protocol, replay or export data is refused rather than
approximated. Consistency and audit generators are re-run, and stale claims that
online play is human-only are removed.

**Acceptance:** help validation, link, anchor and path checks, version refusal,
provenance round trip, stale-wording checks, and `npm run verify`.

### Checklist

- [ ] Player help covers every approved control and every stated limit.
- [ ] Consistent naming across lobby, match and result.
- [ ] Provenance recorded wherever the artifact contract requires it.
- [ ] Incompatible data refused, not approximated.
- [ ] No document still says online play is human-only.

## M09.19 — End-to-end hardening and milestone acceptance

Finish M09 without pulling M08 or content work into it: exercise end-to-end
1H+1B, 1H+3B, 2H+2B and 3H+1B flows across exact precon, saved deck,
Commander-generated and autonomous-generated modes; cover Easy, Normal and Hard,
every style, 0/50/100% timing, Reaction override, reroll, remove, reconnect,
failure fallback, concession, elimination and match completion. Verify that hidden
information does not cross the lobby, player view, log, pacing export or opponent
UI boundaries, and that the simulator and AI Spectator remain full-speed and
deterministic. Benchmark server action latency excluding deliberate pacing, and
confirm bot work does not block human message handling. Perform representative
wide and narrow visual checks, reporting unavailable tooling rather than claiming
inspection. Update the milestone record and the user-facing instructions once,
run the full clean-tree verification and audit practice, commit and push.

**Acceptance:** all M09 checklist items pass, `npm run verify` and the consistency
and audit checks pass, the final working tree is clean, and the pushed branch
contains the reported commits.

**Stop:** do not start M08, public feedback, human timers, matchmaking or card
expansion. Report the next owner choice.

### Checklist

- [ ] Every seat mixture exercised end to end, across every deck mode.
- [ ] Every difficulty, style, timing and lifecycle path covered.
- [ ] Hidden information proven not to cross any boundary.
- [ ] Simulator and Spectator proven unaffected.
- [ ] Latency benchmarked with pacing excluded; human handling never blocked.
- [ ] Visual checks recorded honestly, including unavailable tooling.

---

## Acceptance — not met

M09 is accepted when every tranche checklist above is complete, `npm run verify`
passes, the consistency and audit checks pass, and the tree is clean after the
final record commit.
