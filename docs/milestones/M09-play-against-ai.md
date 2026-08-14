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

## M09.1 — Bot configuration contracts

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

- [ ] Strict versioned schemas for controller metadata, difficulty, style, deck
      choice, pacing and generated-deck provenance.
- [ ] Deck choice is a four-member discriminated union.
- [ ] Public projection separate from private configuration, and tested as such.
- [ ] Percentage-to-delay, safety margin, limits and decision categories defined.
- [ ] Total difficulty registry with versions; a future version refused.

## M09.2 — Bot lobby protocol

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

- [ ] Four host-only bot messages, strict and versioned.
- [ ] Seat view carries controller kind and safe configuration only.
- [ ] Seven named structured errors, each tested.
- [ ] `PROTOCOL_VERSION` moved, with the reasoning recorded beside it.

## M09.3 — Server-side bot lobby seats

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

- [ ] Explicit per-seat controller; bot seats have no connection identity.
- [ ] Host-only mutation, before start only.
- [ ] Deterministic seat allocation that never evicts a human.
- [ ] Unsupported modes refused by name, not silently accepted.
- [ ] Existing human lobby behaviour unchanged, and regression-tested.

## M09.4 — Immediate authoritative bot runner

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

- [ ] One pilot instance and one independent RNG stream per bot seat.
- [ ] Every eligible decision scheduled exactly once; no duplicate actions.
- [ ] Observation rebuilt at decision time; answer revalidated before submission.
- [ ] Failure and fallback recorded, never disguised as an intentional play.
- [ ] No ordinary concession and no bot-originated `server_timeout`.
- [ ] Stack-safe over a long match; cancelled cleanly at completion.

## M09.5 — First playable human-versus-precon-bot flow

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

- [ ] Add, configure and remove exactly one bot from the lobby UI.
- [ ] Bot seat labelled with controller, Commander, precon and readiness.
- [ ] Unsupported options absent, not disabled decoration.
- [ ] Match and result unchanged, rendered by the existing board.
- [ ] Keyboard-accessible controls and designed error states.

## M09.6 — Exact saved-deck mode

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

- [ ] Saved-deck contents submitted privately and server-validated.
- [ ] Snapshot frozen; later edits cannot reach the live bot.
- [ ] Name, Commander, legality and hash shown; card list not broadcast.
- [ ] Stale and illegal saved decks handled by name.

## M09.7 — Mixed human/bot tables

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

- [ ] Up to three bots; at least one human enforced.
- [ ] Concurrent independent decisions without duplication.
- [ ] Elimination, priority, reconnect and last-player behaviour unchanged.
- [ ] A bot never becomes host.
- [ ] Callback order independence proven, not assumed.

## M09.8 — Shared quick deck generator extraction

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

- [ ] Generator in a shared package; search orchestration left behind.
- [ ] Byte-equivalent output for identical inputs, proven against the simulator.
- [ ] Legal deck plus provenance, or named problems; never a silent repair.
- [ ] Legal-pool size and forced-inclusion floor reported.
- [ ] Supported environments declared, with the `node:crypto` question answered.

## M09.9 — Host-selected Commander generation

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

- [ ] Legal implemented Commanders offered from the active format only.
- [ ] Deck generated, frozen, and identified by seed, version, mode and hash.
- [ ] Reroll before lock, with a recorded deterministic seed transition.
- [ ] Private during play; revealed or exported after completion.
- [ ] Forced-inclusion warning shown; impossible generation refused.

## M09.10 — Full AI Commander-and-deck choice

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

- [ ] Deterministic Commander selection from its own seed.
- [ ] No hidden counterpick, and a test that proves it.
- [ ] Deck frozen through the shared generator with full provenance.
- [ ] Commander public, list private until completion.
- [ ] Multiple bots select independently.

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
