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
| All difficulties  | M09.20       | Easy, Normal, and evidence-backed Hard                     |
| Complete          | M09.19       | Pacing summary, help, privacy, compatibility and hardening |

The rows are in **execution** order, which is why M09.20 sits above M09.19. Q50
was answered "not yet" in M09.16, so the tranche that closes Hard's last gap and
publishes it was added after M09.17–M09.19 were already named in source comments
and in the external brief; renumbering those would have broken the references, so
it took the next free number and runs where it belongs.

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

## M09.11 — Bot pacing configuration and UI — **done (2026-08-20)**

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

- [x] **Lobby budgets, per-bot percentage and Reaction override configurable.**
      The budgets are the **table's** and the percentage is the **bot's**, so
      they are two controls and two places on the wire: `botPacing` on the lobby
      view, and `pacing` on each bot's setup, where it has been since M09.2. The
      host changes the budgets with `set_bot_pacing` — a whole record rather than
      one field, for the reason `update_bot` carries a whole configuration — and
      it goes through the same `hostLobbyFor` preamble every bot message does, so
      a guest is refused `protocol/not_host` and a started lobby
      `protocol/already_started` by name rather than by a fourth copy of the same
      condition. The Reaction override is a checkbox over `null`, because
      `reactionPercent: null` (inherit) and `reactionPercent: 0` (answer a
      Reaction instantly) are different configurations that one number could not
      express; ticking it starts at the ordinary percentage, so turning it on
      changes nothing until the host moves it.
- [x] **Seconds displayed beside every percentage.** From `botDelayMs` — the
      function M09.12's scheduler will call — rather than from arithmetic in a
      component, so the two cannot disagree and a tester with a stopwatch is not
      the one who finds out. They are exact rather than rounded to one decimal,
      because 100% of 30 seconds is 29.75 and a screen printing "29.8 s" would be
      describing a delay nothing will use. `PACING_SAFETY_MARGIN_MS` is stated
      beside the budgets rather than left to surprise somebody, and the seconds
      appear for a guest too: a bot's percentage is public, and a percentage
      without its budget is not a number anybody can read.
- [x] **Locked at start and shown in provenance.** `startMatch` freezes the
      budgets into `lobby.lockedPacing`, and `lobbyView` publishes the frozen
      record from then on. It is a **second** lock rather than the only one —
      every path that could change them is already refused once the lobby has
      started — and it is the one that makes "the match ran under these budgets"
      a value a result can be read off. A test mutates the live record by hand
      after the start, which no message can do, and requires the published view
      not to move. The board prints the locked budgets and every bot's timing
      beside the result, where a playtest note can quote them; the lobby panel
      prints the same thing in place of its controls once the match has started.
- [x] **Pacing configuration version recorded.** `PACING_CONFIG_VERSION` rides on
      every budget record — it is a member of `botPacingBudgetsSchema` — so a
      lobby view and a `set_bot_pacing` message both say which calculation they
      were written against, and `readBotPacingBudgets` refuses a future one by
      name. The constant deliberately **does not move**: M09.1 wrote the shape
      and the arithmetic, and M09.11 put them on a wire and on a screen without
      changing either.
- [x] **Q8 still open in `docs/open-questions.md`; version reasoning written
      down.** A test reads the document and requires Q8 to be above the
      `## Answered` section and still carrying its `**Still open:**` paragraph,
      and a second one requires no key of `DEFAULT_RULES_CONFIG` to mention a
      pacing budget. The version reasoning is under Versions below and in
      [ADR 0024](../architecture/0024-live-bot-seats.md) §7.

### What the host actually sees

One new block above the bot forms, with the table's two budgets in seconds and
two sentences: that these pace bots only and nothing here times a person out of
anything, and that a quarter-second of every budget is kept for deciding and
submitting so 100% stops that much short. Each bot form gains a timing
percentage, the seconds it implies, and a "time Reactions differently" checkbox
that reveals a second percentage when it is ticked. Every seat — host or guest —
carries a `50% · 15 s` tag in the seat list beside its difficulty and style.

The panel says plainly that **timings are recorded and locked but bots still
answer immediately in this build**. That sentence is the tranche's exclusion
written where the person setting the dial will read it, rather than left for them
to discover with a stopwatch; M09.12 is what makes it false.

Once the match starts the controls are replaced by what was locked — the two
budgets, and one line per bot naming its percentage, its Reaction percentage and
the seconds each implies — and the same summary appears beside the result on the
board, next to the revealed decks.

### Findings recorded rather than fixed

- **A budget outside the range is refused as a malformed message, not as a
  pacing record.** `set_bot_pacing` carries `botPacingBudgetsSchema` itself, so
  the codec rejects an unreadable record before the server sees it — exactly the
  finding M09.3 recorded for `botSetupSchema` and `BOT_CONFIG_SCHEMA_VERSION`,
  and it belongs to the same compatibility pass in M09.18. The server still runs
  `readBotPacingBudgets` over what arrives, and a record that reaches it another
  way is refused `protocol/bot_config_invalid` with the reader's own wording; a
  test drives that path through `handle` directly.
- **The per-bot default stays 0%.** A default that waited would make the first
  match anybody plays slower than they asked for, and the dial is the point of
  the tranche rather than the setting. `IMMEDIATE_BOT_PACING` is still what a
  fresh draft carries.
- **The pacing summary's last sentence is expected to become false.** It says
  the bots answered immediately, which is true of this build and is what makes
  the record honest; M09.12 has to change it in the same change that makes the
  server wait. It is written here so that is a known edit rather than a
  contradiction somebody finds later.
- **The budgets are public, and that is deliberate.** They could have been
  host-only, and then a guest could see "50%" with nothing to read it against.
  Nothing about a bot's timing is hidden information: an opponent can time it
  with a stopwatch, which is the same reason difficulty and style are already
  public (ADR 0024 §3).
- **`PACING_BUDGET_BY_CATEGORY` still puts a pending choice on the ordinary
  budget.** M09.1 decided it and nothing here re-opened it, so the screen shows
  two budgets for three categories and says "a decision or a choice" rather than
  offering a third dial nothing would read.

### Versions

`PROTOCOL_VERSION` moves **8 → 9**. `lobbyViewSchema` is a strict object and now
has a required `botPacing` member, so a v8 client would fail to parse the first
lobby view a v9 server sent it — mid-lobby, on the message everything else
depends on. `set_bot_pacing` travels the other way and a v8 server would reject
it as malformed. Both are shapes, which is the only reason this constant ever
moves ([ADR 0024](../architecture/0024-live-bot-seats.md) §7). The budgets went
on the _lobby view_ rather than on each seat because every seat needs them to
read a percentage and three copies would be three chances to disagree.

`PACING_CONFIG_VERSION` stays **1**, and saying why is part of the tranche: it
pins the budget _shape_ and the percentage-to-delay _calculation_, both of which
are exactly what M09.1 wrote. Changing 30 seconds to 45 is a configuration change
and moves nothing — that is the whole point of the numbers being configuration
rather than constants of the game. `BOT_CONFIG_SCHEMA_VERSION` and
`DIFFICULTY_REGISTRY_VERSION` stay 1 for the ordinary reason: no configuration
shape widened and no difficulty appeared.

**`RULES_VERSION` stays `0.4.0`**, and this is the tranche that had to say so out
loud, because it is the one that put seconds on a screen. A pacing budget is not
in `RulesConfig`, no engine code reads one, no legal action, cost or resolution
changed, and nothing in this build times out, passes for, or defeats a person. A
bot waiting is not a rules change (ADR 0024 §4). Q8 — whether a _human_ should
ever be timed out of a phase or a choice, and what expiry should do — is exactly
as open as it was, and a test asserts that against `docs/open-questions.md`
rather than leaving it to review. `MATCH_SCHEMA_VERSION`, `CARD_SCHEMA_VERSION`,
`DECK_SCHEMA_VERSION`, `SEED_DERIVATION_VERSION` and `DECK_GENERATOR_VERSION` all
stay: `MatchState` still does not know what a bot is, no card or deck was
touched, and no seed derivation changed.

**Compatibility.** Nothing durable changed shape, so nothing is migrated. A
`SavedDeck`, a match record and a replay keep the fields they had; a lobby is
in-memory and does not outlive the process, so there is no stored lobby to read
back without budgets. The handshake refuses a v8 client, which is the intended
and only observable break.

## M09.12 — Server bot-delay scheduler — **done (2026-08-20)**

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

- [x] **Decision categories classified from structured data.**
      `classifyDecisionCategory` lives in `@tcg/bot-interface` beside
      `candidateActions`, because the category is a statement about _what the
      pilot is being asked_ and that is the question `candidateActions` already
      answers. It reads the engine's own `LegalActions` and nothing else — no
      display text, no card name, no rendered view — in `candidateActions`' own
      precedence: a pending choice first, then a mulligan, then a Reaction
      window, then the ordinary case. `CATEGORY_BY_DECISION_FAMILY` is total over
      `DECISION_FAMILIES`, so a new family cannot be added without deciding
      whether it is somebody else's window or the bot's own turn, and
      `decisionCategoryDisagreement` cross-checks the answer against the families
      the candidates actually came out as — run over every board of a complete
      driven match rather than over a fixture. Only the two Reaction families are
      `reaction`: `assign_blockers` deliberately is not, because blocking answers
      a declaration rather than an open Reaction window, and the five-second
      budget is named for the mechanic rather than for "anything on somebody
      else's turn".
- [x] **Injectable clock; every delay tested without waiting.** The server's two
      time seams are now one file, `scheduling.ts`, holding `ScheduleTimer` and
      `MonotonicClock`: the disconnect window and every bot delay take both from
      there, so a test that would have had to stub two of them cannot stub one.
      They are deliberately two values — the timer says _when to run something_,
      the clock says _what time it is now_ and is asked nothing but "how long was
      that", which is why it is monotonic rather than a wall clock an NTP
      adjustment could run backwards. The whole delay suite runs on a hand-driven
      timer wheel, so a 29 750 ms decision is asserted to the millisecond and
      costs the suite nothing.
- [x] **Decision made at expiry, never stored during the wait.** `PendingDelay`
      has a category, an intended length, a start reading and a cancel, and
      nothing else: `FIELDS_A_SCHEDULED_DELAY_NEVER_HAS` names the five members
      it must never grow and a source scan checks the interface against them —
      the same treatment `FIELDS_A_BOT_CONTROLLER_NEVER_HAS` has had since M09.3.
      At expiry the pump comes back around and rebuilds the state, the legality
      and the redacted observation from scratch before the pilot is asked
      anything; a test moves the board five sequences while the timer runs and
      requires the pilot to have been asked nothing until then, and then to have
      been asked about the later board.
- [x] **Obsolete work cancelled on every named trigger.** Eligibility change,
      elimination, match end and lobby closure each drop the outstanding wait,
      with `lastDelayCancellation` naming which; `stop()` cancels everything,
      which matters on a long-running process because a live timer holds a whole
      `MatchState`. A change of _category_ is a reschedule rather than a
      cancellation — an ordinary decision that became a Reaction window is
      counted under `delaysRescheduled` and restarted on the other budget — and a
      still-valid wait is deliberately **not** restarted by somebody else's
      action, because a bot that recounted from every sequence change would
      starve at a busy table. Reconfiguration and bot removal are triggers that
      **cannot arise** rather than triggers that fire: every bot message goes
      through the one `hostLobbyFor` preamble, and a started lobby refuses all of
      them `protocol/already_started`, which a test asserts against a live wait
      rather than leaving to inspection.
- [x] **Clock values never reach pilot RNG or engine state.** The same seed plays
      the identical match paced and unpaced — same sequence, same turn, same
      result, same per-seat decisions and actions, same incidents — with the
      paced run's timers firing 3 ms late and its clock ending well past zero.
      Nothing but `BotDelayRecord.actualMs` is derived from a reading, and
      nothing reads that back.
- [x] **Simulator and Spectator remain full speed.** A source scan over every
      file under `apps/simulator/src` and `packages/spectator/src` requires none
      of them to mention `botDelayMs`, `BotPacing`, `BotRunner` or
      `scheduling.js`. They do not opt out of pacing; they have no way to reach
      it.

### What changed for a person at the table

The lobby panel's warning is gone, because it stated the exclusion rather than
the behaviour: it said timings were recorded but bots still answered
immediately, and that sentence is now false. In its place the panel says what the
numbers do — bots wait for the seconds shown against each seat, the timings lock
when the match starts, and a seat left at 0% answers immediately. The last clause
is there because 0% is still what a fresh bot is seated at, so it is the case
most first matches will be.

The summary beside the result changed the same way, and says which of the two
this table actually was: a table of instant bots "waited for nothing", and any
other table "waited for the times above before each decision". Both sentences are
read off the locked budgets and the public per-seat percentages, so the summary
still quotes the match rather than the last thing the host typed.

Nothing else moved. No control was added, no number changed, and the board
renders a paced bot exactly as it rendered an instant one — a bot that is
thinking looks like an opponent who is thinking, which is the point.

### Findings recorded rather than fixed

- **Reconfiguration and bot removal are unreachable mid-match, so the scheduler
  has no branch for them.** ADR 0024 §4 names both as cancellation triggers, and
  in this build both are refused before they reach the lobby. That is recorded
  rather than coded around: the day `hostLobbyFor` grows a caller that is allowed
  after the start is the day the scheduler needs the path, and the test asserting
  the three refusals against a live wait is what will fail then.
- **`driveMatch` cannot produce a Reaction window.** Its `seatToAct` resolves a
  seat from pending choice, mulligan, blocker and active player, and has no
  branch for an open Reaction window, so a deck holding a Reaction desynchronises
  the driver rather than exercising one. The classification's real-board Reaction
  coverage is therefore in the server suite, which plays shipping precons and
  sees all three categories in one match. Fixing the driver is a bot-interface
  change with no M09.12 caller, and belongs to whoever next needs it.
- **A still-valid wait survives an opponent's action, and that is a decision.**
  Restarting the countdown whenever the sequence moved would be defensible and is
  wrong here: at a busy table a slow bot would never reach expiry. The
  countdown's job is to pace, and the revalidation that makes it safe happens at
  expiry rather than continuously.
- **`delaysCancelled` and `delaysRescheduled` count different things
  deliberately.** The first implementation counted a category change as both,
  which would have made a paced table look as though it were constantly
  abandoning work. `#dropDelay` stops a wait without counting it; `#cancelDelay`
  is the one that records an abandonment and its reason.
- **`actualMs` is measured to the decision, not to the timer.** It is taken when
  the pump reaches the seat, so it includes whatever the event loop and the scan
  cost after expiry. That is the number a stopwatch would have seen, which is
  what the record is for; it is never a number anything is scheduled from.
- **A paced table is not a stalled one.** `#noteStallIfStuck` is skipped while any
  seat has a wait outstanding, because otherwise every configured delay would
  file a defect report against itself.

### Versions — deliberately unchanged

`PROTOCOL_VERSION` stays **9**. Nothing new travels: the budgets have been on the
lobby view and the percentage on each bot's setup since M09.11, and this tranche
only spends them. `BotDelayRecord` and `BotWaitingDelay` are server-internal
diagnostics on `BotRunReport`, which is not a message and has never been on a
wire.

`PACING_CONFIG_VERSION` stays **1** for the third time, and for the same reason:
it pins the budget shape and the percentage-to-delay calculation, and M09.12
called `botDelayMs` rather than changing it. `BOT_CONFIG_SCHEMA_VERSION`,
`DIFFICULTY_REGISTRY_VERSION`, `SEED_DERIVATION_VERSION` and
`DECK_GENERATOR_VERSION` all stay: no configuration shape widened, no difficulty
appeared, and no seed derivation was touched — a delay is not a draw.

**`RULES_VERSION` stays `0.4.0`.** This is the tranche where a bot actually
waits, and it is still not a rules change: no pacing budget is in `RulesConfig`,
no engine code reads a clock, no legal action, cost or resolution moved, and
nothing here times out, passes for, or defeats a person (ADR 0024 §4). Q8 is
exactly as open as it was, and the M09.11 test that asserts so against
`docs/open-questions.md` is untouched. `MATCH_SCHEMA_VERSION`,
`CARD_SCHEMA_VERSION` and `DECK_SCHEMA_VERSION` stay: `MatchState` still does not
know what a bot is, and no card or deck was touched.

**Compatibility.** Nothing durable changed shape, so nothing is migrated, and no
handshake refuses a build it accepted yesterday. The one observable change is
behavioural, and only for a bot configured above 0%: it now waits. Every match
recorded, replayed or written before this tranche used `IMMEDIATE_BOT_PACING`,
which still schedules no timer and still acts inside the wake that offered the
opportunity — asserted rather than assumed, so the M09.4 path is unchanged rather
than merely believed to be.

## M09.13 — Difficulty registry, Easy, and Normal — **done (2026-08-20)**

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

- [x] **Normal equivalent to the published heuristic per style, seed for seed.**
      Equivalence is by construction rather than by measurement:
      `createHeuristicPilot` gained one optional `selection` parameter defaulting
      to `{ kind: 'best' }`, and the `best` branch is the argmax-with-tie-break
      that has been there since M05 — moved into a function, not rewritten. The
      measurement is there as well, because "by construction" is a claim about
      code somebody could get wrong: for each of the three styles a whole match
      is played by `createPilot({ id })`, the path that shipped, and by the new
      parameter set to `best`, and the two are compared on every action, the
      final sequence, the turn, the result and the failure list. `normal`'s
      registry entry is literally `{ kind: 'best' }`, so the wiring is checked
      too, and the existing 46-test contract suite passed unmodified.
- [x] **Easy defined as an explicit, versioned, bounded degradation.**
      `EASY_SELECTION` is `{ kind: 'bounded_error', errorBudget: 0.5, maxBand: 3 }`,
      in `@tcg/bot-config` beside the registry entry that names it, with
      `behaviorVersion: '1.0.0'`. The bound is a sentence a person can check with
      a stopwatch of their own: **never a candidate from the worse half of the
      range it was offered, and never one outside the best three**. It is
      relative to the spread of the board rather than absolute, because a
      heuristic score has no units and "within 2.0 of the best" would mean
      something different on every turn. The parameters are parsed by
      `difficultySelectionSchema` inside `difficultyRegistryGaps()`, so
      `errorBudget: 1.5` — which type-checks, and would quietly mean "anything at
      all" — is a registry gap rather than a silently wider Easy.
- [x] **Styles stay independent of difficulty.** Difficulty selects among the
      candidates; style scores them; neither function can reach the other's half.
      An Easy bot's exported configuration carries its style's published weight
      vector unmodified and differs from the Normal bot of the same style in
      exactly one member. Every one of the six live combinations is configurable
      and none collapses: two styles at the same difficulty still play different
      matches, and the same style at two difficulties still plays different
      matches. `random_legal` is refused a difficulty by name —
      `STYLED_PILOT_IDS` is derived from the agent-class taxonomy, because a
      bounded degradation of a pilot that is not trying is not a weaker player,
      it is noise with a bound printed on it.
- [x] **Difficulty version and provenance recorded on every match.**
      `BotSeatActivity` gained `difficulty` and `difficultyBehaviorVersion`,
      beside the `pilotId` and `pilotVersion` it already carried. Two pairs,
      because two independent things decided every move, and each half moves for
      its own reason: Easy improving bumps `difficultyBehaviorVersion` and
      nothing else, while the label a person picked stays `easy`. The behaviour
      version is read from the registry rather than from the pilot, because a
      pilot's `version` identifies the _scorer_ — smuggling a difficulty into it
      would produce a string nothing could parse back out.

### What a host actually sees

One more option in a control that already existed. The difficulty select is
built from `AVAILABLE_DIFFICULTIES`, so **no screen changed to add Easy** — the
registry entry flipped and the option appeared, which is the same mechanism
M09.6, M09.9 and M09.10 each used to turn on a deck mode. Hard is still absent
rather than present-and-disabled, for the reason it always was: the server
refuses it by name, and a control whose only outcome is an error message is
decoration.

The default is still Normal. Easy is a thing a host asks for, not something a
first match quietly starts at, and the seat tag beside the bot says which one it
got — publicly, like difficulty always has been, because an opponent may know
what it is playing against.

### Findings recorded rather than fixed

- **A difficulty is not something an experiment can name, deliberately.**
  `PilotSpec` was left alone and `createStyledPilot` added beside `createPilot`.
  Widening the manifest schema would have been less code and would have let a
  deliberately suboptimal run be filed under `generic_heuristic` and cited for
  play quality — the pooled-skill mistake M05.4 exists to refuse. Experiments and
  the calibration suite reach the pilots through `createPilot`, which has no
  difficulty parameter at all; that absence is the guarantee, and a source scan
  over `calibration/fixture.ts` is the check on it.
- **The calibration suite stays a Normal instrument.** A fixture asks "was that
  the characteristic decision for this style", and Easy is _defined_ as sometimes
  not making it, so an Easy calibration result would be a measurement of the
  wrong thing wearing the right label. Running the fixtures at Easy to record
  _how often_ it diverges would be a genuinely interesting measurement and is not
  this tranche's; it needs its own claim, its own suite version and its own
  reader.
- **`CALIBRATED_PILOT_IDS` and `STYLED_PILOT_IDS` are the same list, derived
  twice.** They answer different questions — "which pilots is it meaningful to
  calibrate" and "which pilots can carry a difficulty" — that happen to have one
  answer today. Cross-checked in the calibration suite rather than merged, which
  is the treatment `LEGAL_ONLY_PILOT_IDS` and the agent-class registry already
  get.
- **Easy's two numbers are a first setting, not a finding.** 0.5 and 3 were
  chosen to be observably different without being erratic, and the tests assert
  the _bound_ rather than a win rate: nothing here claims Easy loses more often,
  and a table saying so would need the structured playtests the plan is waiting
  on. Moving either number is a change to what "Easy" means and moves
  `behaviorVersion`.
- **Most Easy decisions are Normal's decision.** On most boards the best
  candidate is the only one inside the band, which is why the test asserts both
  halves — that some choice was below the best, and that many were not. A
  difficulty that was wrong every turn would be a different pilot, not an easier
  one.
- **`brokeTie` now means "the RNG chose" rather than "the scores were equal".**
  It was already the former in substance; Easy is the first caller for which the
  two readings come apart. The diagnostic gains a note naming which of the band
  was taken, so a replay can say why without a new field on
  `botDiagnosticsSchema` — which is written into replay bundles and was
  deliberately not widened.

### Versions

`DIFFICULTY_REGISTRY_VERSION` moves **1 → 2**. `easy` changed status from
`planned` to `available`, which is precisely what this constant is documented to
move for: a record that cites `easy` against registry 1 was written by a build
that could not fly one. The registry also gained `selection`, so a definition
read from another build is a wider shape than a v1 build knows. A v2 client's
configuration is refused by a v1 server with the existing readable message; the
other direction is accepted, because older is readable.

`easy.behaviorVersion` is new and is **`'1.0.0'`** — the third, narrowest
constant, and the one that moves when Easy itself improves without the
vocabulary changing. `normal.behaviorVersion` stays `'1.0.0'`: the equivalence
above is exactly the claim that its decision procedure did not change.

**`PROTOCOL_VERSION` stays 9**, and this is the tranche ADR 0024 §7 now cites as
the demonstration rather than the theory. `botDifficultySchema` has enumerated
`easy` since M09.1 — the wire always knew the word, and only the registry knew
whether anything was behind it — so no message shape moved and no build is
refused that was not refused yesterday. `BotSeatActivity` is a server-internal
record on `BotRunReport`, which has never been a message.

`BOT_CONFIG_SCHEMA_VERSION` stays 1 (no configuration shape widened),
`PACING_CONFIG_VERSION` stays 1, `DECK_GENERATOR_VERSION` stays `'1'`,
`SEED_DERIVATION_VERSION` stays 2, and `CALIBRATION_SUITE_VERSION` stays 1
because no fixture changed. The three style pilots keep `1.1.0`: their weights
and their scorer are untouched, and a difficulty is not a change to either.

**`RULES_VERSION` stays `0.4.0`.** A difficulty chooses among actions the engine
had already declared legal. No legal action, cost or resolution moved, nothing in
`RulesConfig` learned what a difficulty is, and `MATCH_SCHEMA_VERSION` and
`CARD_SCHEMA_VERSION` stay for the same reason they always have: `MatchState`
still does not know what a bot is.

**Compatibility.** Nothing durable changed shape, so nothing is migrated. A
`SavedDeck`, a match record and a replay keep the fields they had; an experiment
manifest is untouched, because `PilotSpec` deliberately was. The one behavioural
change is that a configuration naming `easy` is now accepted instead of refused,
which widens what a build will do rather than narrowing it.

## M09.14 — Hard tactical improvements — **done (2026-08-20)**

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

- [x] **Named M05.6 tactical gaps addressed, with fixtures that show it.** Both of
      them, for all three styles, on the boards that recorded them. _Removal
      lethality_ — `goblin_swarm/bomb_the_body_it_defeats` and
      `grave_sacrifice/knife_the_unit_it_kills` — closes because a removal target
      is now priced by **how much of it the instruction removes**: the whole body
      when the printed damage defeats it, and the fraction of its remaining Health
      otherwise. _Blocking that preserves_ —
      `containment_control/wall_eats_the_attack`,
      `goblin_swarm/absorb_with_the_wall_not_the_bruiser` and
      `grave_sacrifice/block_with_the_body_that_survives` — closes from two
      corrections working together, and the split is recorded rather than
      averaged: `block:preserve` puts the plan on the menu, and `ownLossAversion`
      is what makes the plan win for a vector that values taking a body above
      losing one. The five fixtures' `knownGaps` are **unchanged**, because Normal
      still misses all five; what is new is `tacticalGaps`, which is empty for
      each of them.
- [x] **Only redacted observation used; no hidden state.** Three ways, because one
      of them alone would be a promise. By _signature_: `tactics.ts`,
      `candidates.ts` and `heuristic.ts` import no `MatchState` and touch no
      `state.instances` or `state.players`, which a source scan checks. By
      _construction_: a `TacticalProfile` is a frozen record of five booleans with
      no way to acquire anything, and every refinement reads `BotObservation`
      members that were already read — `view.instances`, `view.combat`,
      `legal.blocking`, `barrierSpent` and `keywords`, all of them public board
      facts. By _measurement_: every fixture is played through the same redacted
      `PlayerView` a networked bot receives, and a live match asserts that no
      observation the profile was handed contains a deck card or another seat's
      hand.
- [x] **Multiplayer target choice covered.**
      `goblin_swarm/knife_the_seat_holding_the_killable_body` is the suite's first
      **three-seat** board: the killable 2/1 belongs to one opponent and the 2/5 it
      cannot defeat to another, so the choice is genuinely across seats and cannot
      be posed on a two-seat table at all. All three styles hit the wrong seat at
      the baseline and the right one under the profile. Three- and four-seat
      matches are also played end to end under the profile, legally and without a
      fallback firing.
- [x] **Easy and Normal unchanged, and proven unchanged.** `baseline` turns every
      refinement off, so the arithmetic is the arithmetic that shipped — and it is
      measured anyway, at three grains. Per _pilot_: the config built through the
      profile equals the published one plus the profile field. Per _decision_: all
      twenty-four fixtures × three styles produce an identical list of decision
      keys through `createPilot` and through the explicit baseline. Per _match_:
      each style plays a whole match action-for-action identically at Normal **and
      at Easy**, the second because a refinement that reached the selection would
      move both.

### What the profile actually corrects

Five named refinements, each pointing at the defect it fixes rather than at the
mechanism it uses. All five are off in `baseline`.

| Refinement               | The defect it corrects                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `readsRemovalLethality`  | `rankChoiceOptions` orders by board value alone, so damage is aimed at the biggest body rather than the one it kills |
| `offersPreservingBlocks` | `greedyBlocks` takes the smallest blocker that kills _or_ survives, which for a small attacker is the one that dies  |
| `ownLossAversion`        | two independent trade weights make an even exchange worth points out of nothing for any vector where gain > loss     |
| `modelsBarrier`          | `wouldDefeat` compares Attack against Health and stops, so an unspent Barrier reads as killable                      |
| `modelsOverwhelm`        | a blocked attacker is treated as fully stopped, so chumping a 7/7 Overwhelm reads as seven damage saved              |

Two of them deserve their reasoning written down, because both could have been a
tuned number and deliberately are not.

**Lethality is a fraction of the body, not a bonus.** A bonus over board value has
no units: it would have to be re-tuned against every weight vector, and a big
enough statline would out-scale it anyway. "How much of this body does the
instruction remove" is the same sentence for all three styles — and it is read only
where the pilot can see the amount on a card it has been shown. The source of a
_resolving_ Spell is in neither `view.instances` nor any hand array, so it is
resolved from the seat's own `card_played` log event, which is unredacted because
playing a card is public. A dynamic amount, a `divided` total, a non-`instruction`
origin or an effect index that does not land on a `deal_damage` all read as "cannot
tell" and leave the valuation exactly where it was.

**Loss aversion raises a coefficient and never lowers one.** The correction is
`max(gain, loss)` rather than a new weight: a body you give up is never worth less
to you than the same body would be worth taking from an opponent. That makes an
even trade exactly zero for every vector, leaves a style that was already
loss-averse — `aggressive` and `value` both are — completely untouched, and cannot
make any pilot more willing to throw a body away than it already was. It is the one
refinement that changes a number rather than a candidate list or a rule of the
engine, and it is the reason `containment_control/wall_eats_the_attack` closes for
`defensive`, whose vector was the one manufacturing the points.

### The suite grew, and gained a facet

`CALIBRATION_SUITE_VERSION` moves **1 → 2**: sixteen fixtures become twenty-four,
and `attacking` joins the facet vocabulary. The facet is not decoration. Blocking
was calibrated from the beginning and the other half of the same combat was not, so
"which bodies go in" had no fixture anywhere while "which bodies come back" had
three — and attacking is half of what this tranche changes. Adding it obliges
**every** deck in the format to answer an attack question, because
`calibrationGaps()` is what makes a facet mean anything.

The eight new boards, and what they found:

| Fixture                                                     | Facet     | What it found                                                               |
| ----------------------------------------------------------- | --------- | --------------------------------------------------------------------------- |
| `containment_control/bomb_the_body_the_barrier_is_not_on`   | targeting | all three aim into an unspent Barrier at the baseline; none under Hard      |
| `goblin_swarm/knife_the_seat_holding_the_killable_body`     | targeting | the same lethality gap, across three seats                                  |
| `grave_sacrifice/no_chump_against_overwhelm`                | blocking  | `defensive` and `value` chump a 7/7 Overwhelm for one damage; Hard does not |
| `bastion_guardians/the_guardian_blocks_what_it_survives`    | blocking  | the Guardian obligation is already spent characteristically — no gap        |
| `containment_control/send_only_what_cannot_be_answered`     | attacking | `aggressive` sends the body that trades; loss aversion keeps it home        |
| `bastion_guardians/the_wall_does_not_walk_into_the_captain` | attacking | no gap: a 2/3 stays home against a ready 4/4 at both profiles               |
| `goblin_swarm/swing_at_the_open_board`                      | attacking | no gap: an unblockable board is attacked into at both profiles              |
| `grave_sacrifice/an_exhausted_wall_cannot_block`            | attacking | no gap: `exhausted` is read correctly at both profiles                      |

Four of the eight record no gap at all, and that is deliberate: a suite whose every
new board happened to show an improvement would be a suite chosen to show one.

`CalibrationTable` gained a `seats` option and now opens through the engine's own
`startTable`/`keepAllHands` rather than the two-seat `startMatch`/`keepBothHands`.
A two-seat table is byte-identical — both derive the generator from the same seed
string, and every pre-existing fixture produces the same decisions — which is what
made it safe to widen at all.

### Findings recorded rather than fixed

- **The three strategic M05.6 gaps are untouched, and now say so twice.**
  `bastion_guardians/armory_before_the_guardian`,
  `grave_sacrifice/make_fodder_before_spending_it` and
  `containment_control/hold_energy_for_the_counter` each carry a `tacticalGaps`
  entry for all three styles naming M09.15 as the tranche that owns them. They are
  the whole of what is left between this and a publishable Hard.
- **A resolving Spell is not in `view.instances`.** `playerView` reveals a seat's
  own hand from the `player.hand` array, and the engine removes a card from that
  array while it resolves — so `PendingChoice.sourceInstanceId` is a **dangling
  reference** for exactly the case a targeting choice is asked in. Not fixed here:
  revealing the source instance would hand the seat being asked the printed
  identity of a card it may never have been shown, which `choiceProvenance` refuses
  on purpose (M05.3). The log is the correct source and is already public.
- **`attack:safe` reads `blocker.attack >= remainingHealth` directly rather than
  through `wouldDefeat`.** It therefore ignores the combat model, so a Barrier body
  is not recognised as safe to attack with, and it also does not filter exhausted
  blockers the way `scoreAttack` does. Left alone: routing it through `wouldDefeat`
  would change the **baseline** filter, because the two disagree about a
  zero-Attack `venom` blocker, and a shared correction was not required to close a
  named gap.
- **`greedyBlocks` still predicts the opponent's blocks without `preserve`.**
  Modelling an opponent as playing the improved block would be a claim about
  somebody else's difficulty. The combat _model_ is shared, because Barrier and
  Overwhelm are arithmetic about the engine rather than a policy; the _pairing
  preference_ is not.
- **The Overwhelm and Barrier models are still the shape of the model they live
  in.** `resolveHypotheticalCombat` reproduces the engine's split exactly for one
  attacker against one blocker; multi-blocker Overwhelm allocation, damage shields
  and `armored` are still approximated away, as they were before. No fixture claims
  otherwise.

### Versions

`CALIBRATION_SUITE_VERSION` moves **1 → 2** — eight fixtures added and a facet
added, which is precisely what it is documented to move for. A calibration citation
made against suite 1 was made against an instrument that never asked an attack
question.

`TACTICS_REGISTRY_VERSION` is new and is **1**: which tactical profiles exist,
pinned the way `AGENT_CLASS_REGISTRY_VERSION` pins a taxonomy. Each profile carries
its own `version` beside it — both `'1.0.0'` — because a result citing
`hard_tactical` needs to say _which_ one it flew, and improving a profile must move
that and not the vocabulary.

**Nothing in `@tcg/bot-config` moved.** `DIFFICULTY_REGISTRY_VERSION` stays 2 and
`DIFFICULTY_REGISTRY.hard` stays `planned`, `plannedIn: 'M09.15'`, with a null
`behaviorVersion` and a null `selection`. That is the tranche's exclusion made
structural rather than promised: Hard has no difficulty version yet **because it is
not a difficulty yet**, and `difficultySelection('hard')` still throws by name. A
lobby's control is still built from `AVAILABLE_DIFFICULTIES`, so Hard remains
absent rather than disabled, and `tactics.test.ts` asserts all of that from the side
that would otherwise look like publication.

**The three style pilots keep `1.1.0`.** `pilotId`/`pilotVersion` identify the
weight vector and the scorer that reads it; which profile flew is recorded beside
them in `config.tactics`, the same separation M09.13 made for difficulty. A profile
improving must move the profile's version and not the pilot's, or a Normal result
and a Hard result would become indistinguishable in a record.

`PROTOCOL_VERSION` stays **9**, `BOT_CONFIG_SCHEMA_VERSION` stays 1,
`PACING_CONFIG_VERSION` stays 1, `DECK_GENERATOR_VERSION` stays `'1'`,
`SEED_DERIVATION_VERSION` stays 2, `AGENT_CLASS_REGISTRY_VERSION` stays 1 — Hard is
a difficulty label and not an agent class, so nothing about what a run may be cited
for changed — and `BOARD_TELEMETRY_VERSION`, `SPECTATOR_REPLAY_VERSION`,
`MATCH_SCHEMA_VERSION` and `CARD_SCHEMA_VERSION` stay where they were.

**`RULES_VERSION` stays `0.4.0`.** Every refinement either widens a candidate list
with a plan the engine had already declared legal, or changes a number attached to a
candidate that was on the list either way. No legal action, cost or resolution
moved; `RulesConfig` still does not know what a tactical profile is; and the Barrier
and Overwhelm work is a _bot_ learning what the engine already did, not the engine
learning anything.

**Compatibility.** Nothing durable changed shape, so nothing is migrated. No wire
message, `SavedDeck`, match record, replay or experiment manifest gained a field —
`PilotSpec` deliberately still names a pilot and nothing else, so an experiment
cannot acquire a tactical profile and be cited for play quality under it. Several
public functions gained optional trailing parameters (`wouldDefeat`,
`resolveHypotheticalCombat`, `greedyBlocks`, `rankChoiceOptions`, `scoreCandidate`,
`runFixture`, `compareCalibrationSuite`), each defaulted to the behaviour that
shipped, so every existing call site compiles and behaves identically.
`FixtureResult` and `CalibrationReport` gained a `tactics` field: a report that did
not carry it could not be read at all once two profiles exist.

## M09.15 — Hard sequencing and resource improvements — **done (2026-08-20)**

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

- [x] **Named M05.6 strategic gaps addressed within a bounded horizon.** Two of
      the three close and the third is measured and recorded, and the three
      closed for three different reasons — which is the whole finding of this
      tranche. `bastion_guardians/armory_before_the_guardian` closes at
      `hard_tactical` from `sequencesEnablers`, a depth-two pass over the plays
      the engine has already declared legal.
      `grave_sacrifice/make_fodder_before_spending_it` closes at **every**
      profile, because it was never a pilot defect: the engine would not let a
      Thrall pay "sacrifice a Unit", so the line was illegal for a person too
      (Q49, below). `containment_control/hold_energy_for_the_counter` does **not**
      close: `reservesReactionEnergy` moves the two candidates about four points
      closer for every style and the body still wins, for a reason that is
      recorded rather than tuned around.
- [x] **All four Wave 1 archetypes covered by representative decisions.** The
      twenty-four-board calibration suite already covers all four and is
      unchanged in size; the tournament below plays all sixteen ordered precon
      pairings, at all three styles, at both profiles.
- [x] **Hard beats Normal on the declared fixtures, and the fixtures are
      declared.** The declared set is `CALIBRATION_FIXTURES`, suite version 2.
      Hard is characteristic on **six** boards Normal misses — the five M09.14
      closed plus the Armory sequencing — and regresses none;
      `compareCalibrationSuite` asserts both directions and reports nothing
      stale.
- [x] **Remaining gaps recorded; no claim of solved play.** One M05.6 strategic
      gap is open with a note for every pilot, the calibration rate is asserted
      to stay below 1, and Hard is **not published** — the reason is a decision
      rather than a defect, and it is written down as Q50.

### The ruling underneath it, and why it was not a pilot change

The tranche opened blocked. `grave_sacrifice/make_fodder_before_spending_it` asks
a pilot to convert its last body into two Thralls and then spend one of them on a
draw, and no pilot could: `forbidden_offering` filters its additional cost on
`cardTypes: ['unit']`, and `matchesCardFilter` tested `definition.type` and
nothing else, so a Token was not a Unit anywhere in the engine. The fixture was
not asking for a decision no bot made. It was asking for a line no **player**
could take.

The owner settled it on 2026-08-20, in these words: _"Tokens count as Units while
they are on the battlefield. Any rule, target, or additional cost that says 'Unit'
includes Unit Tokens unless it explicitly says 'nontoken Unit' or 'Unit card.' A
token-only filter remains token-only."_ It is recorded as **Q49** and written up
in [confirmed-rules.md](../rules/confirmed-rules.md#tokens).

It is implemented as one sentence in the central filter and nothing else.
`satisfiesCardTypes` widens a `unit` request to cover a Token, and the three
boundaries are in the function rather than in a promise:

- **One-way.** `cardTypes: ['token']` stays token-only. A token-only filter is an
  authored restriction — it is how `containment_pulse` names "every Token with
  the same definition" and how `goblin_warhorn_captain` names "Goblin Tokens you
  create" — and reading it as shorthand for "Unit" would break both cards.
- **Battlefield-only.** A Token is a Unit while it is in play and is never a Unit
  _card_. The seven `['unit']` filters that name the discard pile or the deck —
  `back_to_the_warrens`, `book_of_the_dead`, `corpse_stitcher`,
  `grave_reassembly`, `grave_robber`, `tactical_assessment`,
  `unearth_the_remains` — are asked of zones a Token cannot be in, and a filter
  evaluated with no instance behind it does not widen either.
- **Nothing else.** `commander` still means `commander`, and every other
  predicate on the filter is applied on top exactly as before.

The catalog was audited rather than edited. Forty-one filters are exactly
`['unit']`: thirty-four name the battlefield or a sacrifice cost and are the
correction, seven name a deck or a discard pile and are untouched. Fourteen are
`['unit', 'token']` and every one of them is a battlefield filter, so they are now
redundant and go on meaning precisely what they meant — they are **deliberately
not normalised**, because rewriting fourteen cards to remove a harmless word would
be content churn standing in for a rules change. Two are `['token']` and stay
token-only; two are `['unit', 'token', 'commander']` and still reach Commanders,
which the widening does not.

### What the two new refinements actually do

`hard_tactical` moves **1.0.0 → 1.1.0** and gains two switches. Both are off in
`baseline`, so Normal and Easy are unchanged by construction and are measured
unchanged at the three grains M09.14 established.

**`sequencesEnablers` — the play that improves the next play leads.** For each
pair of currently legal plays it asks whether one of them, once in play, would
improve the _arrival_ of the other, and whether the other is still affordable
once the first is paid for. Both halves are required: an enabler played into a
turn that can no longer afford what it enables is a wasted turn, not a sequence.
"Improves the arrival" is read structurally in the two authored shapes that
express it — a triggered ability on `on_deployed`/`on_entered_battlefield` whose
scope covers the beneficiary and whose instructions act on the `trigger_subject`,
and a `replace_arrival` static ability that grants the arriving card a keyword —
and priced with the same instruction pricer everything else uses, so it carries
the style's own weights and the inert-keyword rule for free. No card ID, no deck
name, no Commander appears in it.

The correction is **bounded above**, and that ceiling is the reason it is safe:
the lead is raised to the follower's own score plus what leading adds to it, and
never higher. A candidate that already beat the follower still beats the pair, so
the refinement can only ever decide the _order_ of two plays that were both going
to happen — which is exactly the defect, because the Armory and the Guardian are
both played either way and only one order gives the Guardian its Barrier. The
search is depth two over `legal.playableCards` with an explicit
`SEQUENCING_HORIZON` of twelve, so "bounded" is a number in the source rather than
a property of the current card pool.

**`reservesReactionEnergy` — the Energy a held Reaction needs is not spent.** Two
arithmetic changes, both narrow. The reserved points stop being charged
`unspentEnergyPenalty` on `pass_phase`, because they are not idle — the rulebook
says in as many words that whatever is unspent "is what pays for a Reaction on
another player's turn" — and a play that would take the seat below the reserve is
charged the Reaction it strands, at that card's own `cardValue`.

A reserve is raised only for a Reaction the pilot **actually holds**, that it can
**already afford**, and whose named window a living opponent could still open — a
spell window needs an opponent who can still come by a card, a combat window needs
an opponent who controls a body. It is never a fixed number of points, it never
reads the deck, and it is the largest single Reaction's cost rather than the sum,
because a window offers one Reaction per eligible player. A pilot holding two
counters does not hold six Energy.

It changes decisions in both directions, which is what stops it from being a
licence to pass: at three Energy holding `calculated_response`, `aggressive`
declines to buy `archive_acolyte` — a 0/3 wall worth less than the answer it would
strand — and buys `veil_skirmisher` anyway, because a 3/2 is worth more.

### The tournament

A deterministic seeded smoke tournament, because passing three fixtures is
necessary and not sufficient. All sixteen ordered pairings of the four Wave 1
precons, at all three styles, over four seeds: **192 matches per configuration,
768 in total.**

| Configuration      | Seat 1 wins | Seat 2 wins | Illegal actions | Unfinished | Actions/match | Passes/match | Turns/match |
| ------------------ | ----------- | ----------- | --------------- | ---------- | ------------- | ------------ | ----------- |
| Normal vs Normal   | 96 (50.0%)  | 96 (50.0%)  | 0               | 0          | 113.7         | 39.9         | 20.5        |
| Hard vs Hard       | 103 (53.6%) | 89 (46.4%)  | 0               | 0          | 103.9         | 36.8         | 18.9        |
| Hard (1) vs Normal | 100 (52.1%) | 92 (47.9%)  | 0               | 0          | 107.3         | 38.0         | 19.5        |
| Normal vs Hard (2) | 90 (46.9%)  | 102 (53.1%) | 0               | 0          | 109.3         | 38.4         | 19.7        |

Four readings, and the last two are the ones that were actually at risk:

- **Hard is better, on both sides of the table.** 202 wins out of 384 head to
  head — **52.6%** — and the edge is 52.1% seated first and 53.1% seated second,
  so it is not a seat-order artefact. Normal against Normal is exactly 96–96,
  which is what makes that reading available at all.
- **Nothing broke.** No illegal action, no pilot failure, no unfinished match, no
  draw, in 768 matches. Every match ended in a result, and deck-outs fell from 11
  to 4 under Hard.
- **The reserve did not make the bots passive.** Passes per match fell 39.9 →
  36.8 and turns per match fell 20.5 → 18.9. A resource rule that had turned into
  "hold everything" would have moved both the other way, and the containment deck
  — the only Reaction-heavy one — is a quarter of every configuration.
- **Matches did not get longer.** The whole tournament is shorter under Hard,
  which is the shape a better attacker produces rather than a more cautious one.

The tournament is a **recorded measurement, not a test**: 768 matches take about
eleven minutes, which does not belong in `npm run verify`. It is reproducible from
the repository — `driveMatch` over `preconMatchDeck` for each ordered pairing,
`createTacticalPilot` per style, seeds `m0915-a`…`m0915-d` composed with the
pairing, style and configuration name — and the corner of it that would rot is
committed: `tactics.test.ts` plays four precon-versus-precon matches under the
profile end to end, which is the only place in that file exercising the shipped
card pool rather than the `prototype_core` fixtures.

The tournament is run through `driveMatch`, which needed one correction to run at
all: its `seatToAct` never looked at `state.reactionWindow`, so it asked the
active player while the engine was waiting on the seat holding priority. Every
deck the contract tests fly is built from `prototype_core`, which prints no
Reaction, so nothing had ever asked. Fixed, and the fix changes nothing for a deck
without Reactions.

### Findings recorded rather than fixed

- **`hold_energy_for_the_counter` is narrowed, not closed, and the remaining half
  is a different defect.** The window is priced now. What is left is that the
  scorer values a card **played** at its whole card value and a card **kept** at
  nothing — so a 3/2 body reads as a permanent gain rather than as one turn of
  tempo over playing the same card next turn, and no honest reservation charge can
  outweigh a body worth twice the counter. Correcting that is a change to how
  every card in every hand is valued, in every decision the pilot makes. It is not
  a resource rule and it was not M09.15's to make.
- **A fixture can close for a reason that is not about pilots.** The sacrifice
  sequencing board closed at both profiles, and it is recorded in the fixture and
  asserted in `tactics.test.ts` as a rules correction specifically so that nobody
  cites it as evidence about Hard. Every style already sequenced it correctly; the
  engine was what stopped the second card.
- **`arrivalBoostValue` reads printed abilities only.** An enabler whose
  improvement arrives through a granted ability, a delayed effect or a continuous
  layer that is not `replace_arrival` is not recognised, and reads as no enabler
  at all rather than as a guess. Nothing in Wave 1 wears that shape.
- **The reserve does not model a `reaction_discount`.** A Relic granting one can
  only make the real cost lower, so the reserve is never smaller than the Energy
  actually needed — it is conservative in the safe direction, and deliberately not
  reconstructed.
- **`RULES_VERSION` moving invalidates every recorded replay, and that is the
  mechanism working.** `results/` is a local, gitignored run artefact and is not
  migrated: a replay is a claim about what the engine did, and nothing can
  re-derive a decision the recording build was never offered.

### Versions

**`RULES_VERSION` moves `0.4.0` → `1.0.0`.** The policy in `config.ts` is that a
provisional _value_ moves the minor and a structural _rule_ moves the major, and
the Token ruling is the second: it changes what is a legal target and what may pay
an additional cost. The evidence that it has to move at all is
`checkReplayCompatibility`, which compares `rulesVersion` and refuses a replay
whose recording engine would now answer differently — and a match recorded under
0.4.0 contains seats that were never offered a legal move this build offers.
Refusal is tested by name in `spectator.test.ts`. The number is a **compatibility
token and not a maturity claim**; `1.0.0` says the ruleset changed structurally,
not that it is finished, and `config.ts` now says so where somebody would read it.

**`hard_tactical` moves `1.0.0` → `1.1.0`** — two refinements added, which is
exactly what a profile's own version is documented to move for.
`TACTICS_REGISTRY_VERSION` stays **1**: which profiles exist did not change, and
that is the only thing it pins. The three style pilots keep `1.1.0` for the reason
M09.14 gave — a profile improving must move the profile's version and not the
pilot's, or a Normal result and a Hard result become indistinguishable in a
record.

**`CALIBRATION_SUITE_VERSION` stays 2.** No fixture was added or removed and no
facet appeared. Three fixtures' recorded gaps changed, which is a **measurement**
moving rather than the instrument moving — and a suite version that moved whenever
a gap closed would be useless for the one thing it is for, which is saying whether
two results were measured by the same instrument.

**`DIFFICULTY_REGISTRY_VERSION` stays 2, and `DIFFICULTY_REGISTRY.hard` stays
`planned`.** Its `plannedIn` moves `M09.15` → `M09.16`, which is neither an ID
appearing, nor one disappearing, nor a status changing — the three things that
constant is documented to move for. `behaviorVersion` and `selection` are still
null, so `difficultySelection('hard')` still throws by name and
`AVAILABLE_DIFFICULTIES` still does not contain Hard. Why it was not published is
under **Q50**, not here: no threshold was ever recorded, one of the three gaps the
tranche owned is open, and choosing the standard a result is then measured against
is not a measurement's job.

`PROTOCOL_VERSION` stays 9, `BOT_CONFIG_SCHEMA_VERSION` 1, `PACING_CONFIG_VERSION`
1, `MATCH_SCHEMA_VERSION` 7, `CARD_SCHEMA_VERSION` 5, `SPECTATOR_REPLAY_VERSION`
6, `BOARD_TELEMETRY_VERSION` 3, `SEED_DERIVATION_VERSION` 2,
`AGENT_CLASS_REGISTRY_VERSION` 1, `DECK_GENERATOR_VERSION` `'1'`. No wire message,
`SavedDeck`, match record, replay or experiment manifest gained a field, and
`PilotSpec` still names a pilot and nothing else, so an experiment still cannot
acquire a tactical profile and be cited for play quality under it.

**Compatibility.** Nothing durable changed shape, so nothing is migrated; what
changed is behaviour behind a version that exists to refuse stale recordings.
`matchesCardFilter`'s signature is unchanged and two new pure helpers —
`isTokenEntity` and `satisfiesCardTypes` — are exported beside it. `scoreCandidate`
and `scorePlayCard` take the tactical profile they already had in scope, and every
existing call site compiles and behaves identically because `baseline` turns both
new switches off.

The M09.0 baseline table above predicted `RULES_VERSION` would not move in M09,
on the grounds that "pacing and difficulty are not rules". That prediction was
correct about its own reason and wrong about the milestone: what moved the
constant is an owner rules ruling that a calibration fixture happened to surface,
not anything about a bot. Recorded here rather than by editing the prediction, for
the same reason M09.10 recorded its `PROTOCOL_VERSION` correction.

## M09.16 — Style automation and complete per-bot setup — **done (2026-08-20)**

Present every approved option coherently for each bot: deck mode, difficulty,
style, timing, Reaction override and reroll, through progressive disclosure.
Automatic style uses a deterministic mapping from recorded deck construction or
archetype data and names its fallback; it never infers from display text. One
bot's configuration can be copied to other bot seats without copying RNG state by
accident. What is locked, generated, private, unavailable, or limited by the
small current card pool is stated. Keyboard accessibility, narrow and wide
layouts, and actionable errors are preserved.

It also owned **whether Hard becomes one of those approved options**, which is
**Q50**. The answer, from the owner on 2026-08-20 with M09.15's measurements in
front of them, was **not yet**: close the third strategic gap first. What that
costs this tranche is recorded under [Q50, answered](#q50-answered-not-yet)
below; what it deliberately did not cost is a registry field.

**Acceptance:** every setting combination, copy-with-new-seed, automatic
fallback, privacy, reroll, lock, accessibility and responsive component tests.

### Checklist

- [x] Full per-bot configuration with progressive disclosure.
- [x] Automatic style deterministic, from structured data, with a named fallback.
- [x] Copy configuration without copying seeds.
- [x] Locked, private, unavailable and pool-limited states all stated.
- [x] Q50 answered, and Hard published or re-planned according to the answer.

### Automatic is a setting, not a fourth style

The distinction the whole tranche rests on, and it is a type rather than a
convention. `BOT_STYLES` is unchanged — three styles, three published weight
vectors — and `BOT_STYLE_SETTINGS` is the new vocabulary a _control_ offers:
`automatic` plus those three. A `BotSeatConfig` carries **both** members,
`styleSetting` and `style`, because they answer different questions: `style` is
what the pilot flies and can never be `automatic`, and `styleSetting` is what a
host would see if they opened the form again. Collapsing them would mean either a
lobby that cannot show "Automatic" after a reload, or a runner re-resolving a
style every time it builds a pilot.

`botStyleSchema` still refuses `'automatic'` and `botStyleSettingSchema` accepts
it, so nothing downstream of the resolution can be handed a setting by accident —
`createBotPilot` reads `config.style` and needed no change at all.

### Where the mapping comes from, and where it stops

**Commander → the format's authored `DeckPlan` → `archetypeId` →
`ARCHETYPE_STYLE_MAP` → style.** Nothing reads a card's rules text, a card name,
or a precon's `strategy` line, all three of which are display text and all three
of which CLAUDE.md's engineering invariants forbid parsing into behaviour.

The Commander is the key rather than the precon ID because it is the one handle
all four deck modes share: a generated deck has no precon and a saved deck has no
plan, so one rule covers every mode instead of four. `ARCHETYPE_STYLE_MAP` is a
total `Record` over `ArchetypeId`, so a fifth archetype arriving in
`@tcg/card-data` is a compile error here rather than a silent slide into the
fallback, and `botStyleRegistryGaps()` says the same at runtime for the callers
that arrive with a string.

The four Wave 1 entries are each the archetype's own stated payoff matched
against the style summary that prices it: `token_swarm` converts board width into
damage and is `aggressive`; `defensive_attrition` keeps the blockers that survive
and is `defensive`; `sacrifice_value` and `reactive_control` both win on
accumulated advantage and are `value`. The last is the only judgement call worth
recording — `reactive_control` is not `defensive`, because surviving is how it
gets there rather than what it is for.

**Format-scoped**, for the reason every pool lookup in this repository is:
`deckPlansForFormat` rather than `BUNDLED_DECK_PLANS`, so a plan from another
format is not evidence about this table. A test proves it by asking for
`goblin_warboss` under `development`, which publishes no plans, and getting the
fallback rather than `aggressive`.

**The fallback is named and is `value`.** Not the first entry of `BOT_STYLES`,
because a fallback is a statement about _not knowing_: `value` prices card
advantage and board value, which is the least specific claim of the three, where
`aggressive` would be a wager about a deck nothing has classified. Two ways to
reach it, and both are named rather than silent — `no_plan` when the format
publishes none for that Commander, and `ambiguous` when two plans name the same
Commander, where picking the first would make the answer depend on file order.
`chosen` is the fourth member of the same closed set, for a style the host named,
so one field answers "where did this style come from?" for every seat.

### The server resolves it, because only the server can

`resolveBotSeat` is where a setup becomes a configuration, and since this tranche
it is also the single place a style stops being a setting: every branch returns
through `withResolvedStyle`, for **every** deck mode including the two that name
a style outright. That is the property being bought — "automatic resolves once,
from the Commander, after the deck exists" is a fact about the control flow
rather than about four remembered call sites.

It has to be the server rather than the host's browser because of one mode. An
`autonomous_generated` bot picks its own Commander _during_ generation, so at the
moment the host presses the button there is no Commander for anybody to map. The
Commander is therefore read off the resolved `SavedDeck` rather than off the
configuration — the same value for three modes, and the only source of it for the
fourth.

`setupOf` sends the **setting** back, not the resolved style. A reroll builds a
new deck and can land on a different Commander, so an automatic seat re-resolves
rather than carrying the style its previous deck implied; sending the resolved
value would quietly convert an automatic seat into a hand-picked one at the first
reroll, and a test asserts the transition by name.

### What the host sees

The style control offers **Automatic** first and three named styles behind it,
and automatic is now the **default**. The old default was whichever style
happened to be first in the vocabulary, which made every bot a host had not
thought about aggressive; automatic is the option that needs no opinion, and the
note under the control says which style it landed on and why — so it is a default
that explains itself rather than a hidden one.

That note is total over the three cases a host can be in. A named style prints
its own summary, exactly as before. Automatic with a Commander in hand names the
Commander, the archetype its plan claims and the style that implies, computed by
the same `resolveAutomaticStyle` the server will run against the same format —
so it is a prediction the server is bound to rather than a second opinion.
Automatic with no Commander yet says the style is decided when the deck is built
and names the fallback, because a preview there would be an invention.

**Progressive disclosure.** Deck source, deck, difficulty and style are on the
surface; timing, the Reaction override and the deck seed are inside a native
`<details>` that starts closed. Native rather than scripted for the accessibility
requirement: it is in the tab order, it opens from the keyboard, and it announces
itself as a disclosure without a line of script. The keyboard test walks deck →
difficulty → style → the disclosure → timing → override → the button, and
asserts activating the disclosure opens the group. It asserts that by _clicking_,
because jsdom does not implement `<summary>`'s Enter/Space activation — the
limitation is recorded in the test rather than papered over with an assertion
that would pass for the wrong reason.

Every control is seat-scoped for a seated bot, including the new disclosure:
"Seat 2 timing and deck seed", so a table with three bots stays readable to
somebody listening to the page rather than looking at it.

### Copying a setup, and the one thing that does not copy

A copy and a paste rather than a "copy to seat 3" menu, because the host is
choosing two things — which setup, and which seat gets it — and a single control
would have to guess one of them. It is also the shape that scales to the form for
the _next_ bot without a special case: that form is a paste target like any
other.

**Nothing is sent by pasting.** It fills a form, and the host still presses Apply
or Add, which keeps the panel's one-mutation-at-a-time rule exactly where M09.7
left it and means a paste can be looked at before it is committed.

**A generated seat is pasted onto a new stream.** `withFreshGenerationStream`
mints a seed at paste time, so copying a bot never copies its RNG state: two
seats built from one form get two different decks, and the note beside the button
says so before the host presses anything. The reroll count is deliberately _not_
handled here, because it is not in a draft at all — it is the server's record of
how far one seat has walked its own stream, and `carriedRerollCount` already
restarts it at 0 whenever the seed changes. A pasted generated seat begins at its
new stream's first deck by the rule that was already there rather than by a
second one written here.

The decision RNG is untouched by any of this and always was: `BotRunner` derives
a seat's stream from the seat at match start, not from its configuration, so
there is no route by which copying a form could duplicate a pilot's rolls.

**A seat this browser did not configure cannot be copied**, and says why. The
private half of a saved-deck or generated configuration never comes back down the
wire, so that form is showing defaults rather than the seat's setup, and copying
it would copy something that was never true. The button is absent and the reason
is on screen, which is the same absent-not-disabled rule the deck modes and the
difficulties follow.

### Locked, private, unavailable, pool-limited

Four states, each said rather than left to be inferred from a control that is
missing.

- **Locked** was already stated at M09.11 and is unchanged: once the match
  starts, the panel says the settings are locked and prints the frozen budgets
  and each seat's timing as provenance.
- **Private** is stated in three places now — the frozen saved deck the host
  cannot see the name of, the generated deck this browser was never told about,
  and the new one above: a seat whose setup cannot be copied because this client
  never sent it.
- **Unavailable** is the state that had been silent. Hard was absent from the
  difficulty list and nothing said so, which reads as a broken build rather than
  as a plan. The panel now names every entry of `PLANNED_DIFFICULTIES` and the
  tranche that owns it, read from the registry so the sentence empties itself
  when the last planned difficulty is published. Absent-not-disabled is still the
  rule; what changed is that the absence is explained. Each available difficulty
  also prints its own summary now, which the style control has done since M09.5.
- **Pool-limited** keeps its arithmetic home in `GeneratedDeckSummary` — 41 legal
  cards for a 40-card deck is a floor of 39, so a reroll changes at most two —
  and gains a second, smaller instance: an automatic style that falls back
  because this format publishes no plan for a Commander says exactly that, which
  is a content limit rather than a failure.

### Q50, answered: not yet

The owner's ruling on 2026-08-20 was that the numbers are not what is missing.
`containment_control/hold_energy_for_the_counter` is still open, and it is open
because the scorer prices a card played at its whole value and a card kept in
hand at nothing — a valuation defect in every decision the pilot makes rather
than a resource rule. Hard is published once that closes. No rate was named,
deliberately: the standard is the named gap, which can be finished, rather than a
threshold that would have to be argued about.

So this tranche made the smaller of the two moves the question could have caused.
`DIFFICULTY_REGISTRY.hard.plannedIn` moves `M09.16` → `M09.20`, and **nothing
else does**. `DifficultyDefinition` still has no field for a tactical profile,
`behaviorVersion` and `selection` are still null, `difficultySelection('hard')`
still throws by name, and `AVAILABLE_DIFFICULTIES` still does not contain Hard —
which is what keeps publishing Hard a decision rather than a status flip a later
tranche could make by accident. A test asserts the missing field by name.

M09.20 is the tranche that closes the gap and publishes Hard. It is numbered 20
rather than inserted at 17 because M09.17, M09.18 and M09.19 are already named in
source comments and in the external brief, and renumbering them would break those
references; it runs **before** M09.19, and this document places it where it runs
rather than where its number would sort.

### Findings recorded rather than fixed

- **`botStyleRegistryGaps()` is checked by a test rather than by a startup
  assertion.** `assertDifficultyRegistryComplete()` exists for the difficulty
  registry and has no style equivalent, so the style registry's runtime twin is
  only ever called from `style.test.ts`. That is enough for a build that ships
  both registries from source, and it would not be enough if a style ever
  arrived as content. Not fixed here because adding an assertion nothing calls is
  not a check; the tranche that makes styles content is the one that needs it.
- **`seatStyleLabel` is the only place the "(automatic)" suffix is composed**,
  and it is composed rather than translated. Every user-facing string in the
  client is written in English at its use site, so this is consistent with the
  rest of the app and inconsistent with nothing — but it is the second place a
  parenthetical qualifier has been concatenated onto a label, and a third would
  be the point to introduce a formatter. Recorded, not built.
- **The `ambiguous` fallback is unreachable with shipped content.** Wave 1
  publishes four plans naming four different Commanders, so nothing in the
  bundle can produce it. It is implemented and tested at the function level
  anyway, because the alternative — picking the first match — would make a
  bot's style depend on file order the moment a second plan for one Commander is
  authored, which is a thing M08's deck work could plausibly do.
- **`BOT_STYLE_SETTINGS` is a superset of `BOT_STYLES` by construction**
  (`['automatic', ...BOT_STYLES]`), so a style can never be settable-but-missing.
  There is no equivalent guarantee in the other direction for deck modes:
  `DECK_MODE_LABELS` is a hand-written total map and a mode could be supported
  with a `null` label. That was M09.5's deliberate choice and is unchanged.

### Versions

**`PROTOCOL_VERSION` moves 9 → 10.** `botSeatPublicSchema` is a strict object and
gains a required `styleSetting`, so a v9 client would fail to parse the first
lobby view a v10 server sent it that held a bot — the same failure mode M09.2 and
M09.11 both had. `botSetupSchema` travels the other way with a widened `style`,
and a v9 server would reject `style: "automatic"` as an invalid enum member: it
has no mapping to resolve it with, so refusing is the correct answer rather than
a compatibility gap to paper over. The handshake compares first and names the
older side.

**`BOT_CONFIG_SCHEMA_VERSION` moves 1 → 2**, and that is deliberately not
redundant with the above. The two answer different questions: the protocol
constant refuses a peer whose messages this build cannot decode, and this one
refuses a bot configuration record written by a newer build. M09.13 is the case
where only the second kind of thing moved. Nothing persists a bot configuration —
it lives in a lobby's memory and on the wire — so there is no stored v1 record to
migrate, and `refuseFutureVersion` is the whole of the compatibility story.

**`DIFFICULTY_REGISTRY_VERSION` stays 2.** `plannedIn` moving is neither an ID
appearing, nor one disappearing, nor a status changing — the three things that
constant is documented to move for. This is the second tranche in a row to move
it for that reason and the reasoning is the same both times.

`PACING_CONFIG_VERSION` stays 1, `RULES_VERSION` `1.0.0`, `MATCH_SCHEMA_VERSION`
7, `CARD_SCHEMA_VERSION` 5, `SPECTATOR_REPLAY_VERSION` 6,
`BOARD_TELEMETRY_VERSION` 3, `SEED_DERIVATION_VERSION` 2,
`AGENT_CLASS_REGISTRY_VERSION` 1, `DECK_GENERATOR_VERSION` `'1'`,
`TACTICS_REGISTRY_VERSION` 1, `CALIBRATION_SUITE_VERSION` 2,
`ARCHETYPE_REGISTRY_VERSION` 1. Deriving a style from an authored deck plan is a
lobby decision above the engine: `MatchState` never learns what a style is, no
card was read or edited, and no archetype's classification changed — the mapping
is a new consumer of the taxonomy, not a change to it.

**Compatibility.** `BotSetup.style` is the field that widened rather than a new
field beside it, so every existing caller that sends a named style compiles and
behaves identically; only a caller that wants automatic sends anything new.
`publicBotSeatOf` is still the only route from configuration to projection, and it
gained a member rather than changing one. `createBotPilot` reads `config.style`
and is untouched, which is the check that the resolution really does happen
before a pilot exists.

## M09.20 — Card-in-hand valuation, and Hard's publication

**Runs before M09.19, and is numbered 20 because M09.17–M09.19 are already named
in source comments and in the external brief.** This document places it where it
runs rather than where its number would sort.

Close the third strategic gap M09.15 measured and left open —
`containment_control/hold_energy_for_the_counter` — and publish Hard. The gap is
a valuation defect rather than a resource rule: the scorer prices a card played
at its whole value and a card kept in hand at nothing, so holding Energy for a
window that has not opened can never win against playing a body. It is in every
decision the pilot makes, not only in Reaction decks, so closing it is a change
to `hard_tactical` measured at the same three grains M09.14 established —
Normal's decisions unchanged by construction, the same decision key on every
calibration fixture for every style, and whole matches action for action at
Normal and at Easy.

Publishing Hard is then the bounded piece of work Q50 named.
`DifficultyDefinition` has no field for a tactical profile, so the registry gains
one and `DIFFICULTY_REGISTRY_VERSION` moves 2 → 3; `BotRunner` builds the pilot
through it; and the lobby, the help text and the seat provenance each gain an
option. The lobby's planned-difficulty sentence empties itself when that happens,
because it is read from the registry.

**Acceptance:** the third fixture's recorded gap closes with no regression on the
other twenty-three, Normal and Easy are proven unchanged, Hard is selectable and
refused by nothing, and a seat that flew Hard records which Hard.

**Stop:** do not rebalance a card, author one, or widen the calibration suite to
make the gap close.

### Checklist

- [ ] `hold_energy_for_the_counter` closes, with Normal and Easy unchanged.
- [ ] `DifficultyDefinition` carries a tactical profile; registry version 2 → 3.
- [ ] Hard is selectable, and the planned-difficulty statement empties itself.
- [ ] A recorded seat says which Hard it flew.

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
