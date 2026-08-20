# ADR 0024 — Live bot seats: authority, privacy, pacing and the shared generator

**Status:** accepted · **Date:** 2026-08-14 · **Extends:**
[ADR 0006](0006-network-protocol.md),
[ADR 0007](0007-free-for-all-state.md),
[ADR 0009](0009-bot-information-boundary.md),
[ADR 0010](0010-seed-derivation-and-reproducibility.md),
[ADR 0021](0021-choice-contract.md)

Recorded in M09.0, before any of the code it governs exists — the same order
[ADR 0023](0023-admin-lab-boundary.md) used, and for a related reason. M09 does
not add a process; it adds a **new kind of occupant** to a process that until now
has only ever held humans. Every existing safety property of the match server —
redaction, reconnection, action identity, disconnect timeout — was written with a
human at the other end of a socket, and a bot seat either fits inside those
properties or quietly weakens them.

## Context

M09 makes an existing lobby able to hold a bot. What exists today, re-read from
the branch at `6727841` rather than from the brief that proposed the work:

- **A seat is a human.** `Seat` in `apps/multiplayer-server/src/lobby.ts` carries
  a `reconnectToken`, a `connectionId`, a `cancelDisconnectTimer` and a
  `disconnectDeadline`. Every one of those four fields describes a network
  participant that can go away, and none of them means anything for a controller
  that lives inside the server process.
- **The protocol has never heard of a bot.** `bot` and `pilot` appear zero times
  in `packages/protocol/src` and zero times in `apps/multiplayer-server/src`.
  `lobbySeatViewSchema` is a strict object with no controller field, the client
  message union has no host-only seat-configuration message beyond
  `set_max_seats` and `start_match`, and `PROTOCOL_ERROR_CODES` has seventeen
  members, none of them about a bot.
- **The AI Spectator is not a live opponent.** `runSpectatorMatch` in
  `packages/spectator/src/run.ts` returns a finished `SpectatorReplay`;
  `SpectatorScreen.tsx` awaits that whole match in the browser and only then
  animates it. Two to four pilots play a complete game before the first frame is
  drawn, and nothing about it touches the match server.
- **Pilots already respect the boundary this ADR has to preserve.**
  `BotObservation` in `packages/bot-interface/src/types.ts` is deliberately a
  plain interface with no `MatchState` member, and `decideSafely` validates a
  pilot's answer with `checkActionOffered` before anyone submits it. ADR 0009 is
  enforced by the type, not by convention.
- **Concession is already off by default.** `mayConcede` defaults to `false` in
  both `candidateActions` and `randomLegalConfigSchema`, and both only offer
  `concede` when no other candidate exists. A pilot does not concede unless an
  experiment turns it on.
- **The engine is clock-free and the server is not.** `MatchServer` holds an
  injectable `#schedule`, uses it for the 90-second disconnect window, and
  submits an explicit `server_timeout` action when that window expires. That is
  the only clock-driven action in the product, and Q8 leaves phase and choice
  timers open on purpose.
- **The deterministic deck generator is inside the simulator app.**
  `generateDeck` and `generatePopulation` live in
  `apps/simulator/src/deck-search/generate.ts`, and `validateDeck` is their final
  authority — nothing there repairs an illegal deck quietly.

The risk this ADR bounds: a bot is the first thing that can act in a live match
without a socket. Given a shortcut, it could read authoritative state, submit
actions outside `applyAction`, be scheduled twice for one opportunity, or hold a
decision made against a board that has since changed. Each of those is a
different bug, and each becomes structurally impossible or merely unlikely
depending on decisions made here.

## Decision

### 1. A bot is a seat controller the server owns, and nothing else

A seat's controller is explicit: `human` or `bot`. A bot controller is created,
configured and destroyed by the authoritative server, has no `connectionId`, is
issued no `reconnectToken`, and never starts a disconnect timer. It cannot
disconnect because there is nothing for it to disconnect from.

A bot is never browser automation and is never simulated by a player's tab. A
client that closes, refreshes or loses its network has no effect on any bot seat
in the match. This is the property that makes "the host's laptop went to sleep"
not a rules event.

Only the host may add, configure, reroll or remove a bot, and only before the
match starts. Bot configuration locks at start, for the same reason a deck does.
A human joining never displaces a configured bot: the host removes one to free
the seat, explicitly. Seat allocation stays deterministic and never evicts a
human.

### 2. The observation boundary is ADR 0009's, unchanged and unwidened

A live bot receives exactly what a human in that seat receives: its own redacted
`PlayerView` and the engine's computed `LegalActions`. It is handed a
`BotObservation`, which has no `MatchState` member, and the boundary stays
enforced by the type rather than by review.

Server-only metadata may say that seat 3 is a bot flying pilot `value` at
difficulty `normal`. Hidden cards never enter a public lobby view, an opponent's
view, or a log any player can read.

Every bot action goes through the same `applyAction` path a human action does,
with the same client-generated-style idempotent action identity, and is
revalidated against the current legal actions **at the moment of submission**. No
direct state mutation, no privileged action, no free resource, no rule exception.
A Hard bot is a better chooser among the same candidates, never a better-informed
one.

Two consequences that are requirements rather than observations:

- **`server_timeout` stays server-originated.** It is not in a bot's action
  vocabulary, and a bot that fails to decide does not produce one.
- **Bot concession is off in ordinary play.** The existing `mayConcede: false`
  default is what delivers this, and the live runner must not turn it on.

### 3. Deck source is public at the Commander and private at the list

The Commander a bot brings is public in the lobby: it is the one fact an opponent
needs to know what they are sitting down against, and every deck mode reveals it.

The card list is not. A generated list, and a saved deck the host selected, stay
private for the duration of the match and are revealed or exported only after it
completes. The host necessarily knows the contents of a deck they chose
themselves; the product does not pretend otherwise, and the privacy claim is
made about _opponents_, which is the claim that is actually true.

Generation is deterministic, format-scoped and fast. It obeys deck size,
singleton, colour identity and implementation status through the same
`validateDeck` a human deck passes, is frozen before the match starts, and is
identified by generator version, seed, Commander and deck hash. A bot never
inspects an opponent's hidden deck, hand or saved-deck data when choosing, and
never counterpicks: adaptive counter-search is M08's, it is explicit there, and
importing it here silently would be the single most dishonest thing this
milestone could do.

M09.10, which is the tranche where a bot chooses its own Commander, makes that a
property of the code rather than a rule somebody keeps. `selectBotCommander`
takes the candidate Commanders and a seed, and takes nothing else: there is no
lobby, no seat, no opponent and no saved deck in scope, so the counterpick this
section forbids is unreachable rather than merely unwritten. The candidates are
the format-scoped `playableCommanders` a host is offered, so a bot cannot choose
something a host could not; the selection stream is derived from the seat's own
seed, so the same seed names the same Commander whoever is sitting across from
it; and that is asserted by seating one bot against deliberately different
opponents and requiring an identical deck hash.

### 4. Bot pacing is server configuration, and it does not answer Q8

Live bots wait before submitting. The waiting is configured as an integer
percentage of a pacing budget, and both the percentage and the budget live in
**server and lobby pacing configuration**, not in `RulesConfig` and not in the
engine. `RULES_VERSION` does not move because a bot waited.

This is deliberate and is the whole point. Q8 asks whether a human should ever be
timed out of a phase or a choice, and what expiry should do. M09 does not answer
it. It gives the owner a way to _feel_ a 30-second decision and a 5-second
Reaction window against a bot, with nothing at stake, before deciding whether
humans should live under those numbers. A bot's pacing budget never times out,
passes for, or defeats a human. The initial 30s and 5s are test dials; changing
them after playing is a pacing configuration change, recorded as one.

Because the engine is clock-free, the schedule is an **opportunity, not an
action**. When a delay expires the server rebuilds that seat's current redacted
observation and legal actions, asks the pilot then, revalidates the answer, and
submits it. Nothing is chosen in advance and held. A state change, a
reconfiguration, a bot removal, an elimination or a match end cancels the
obsolete scheduled work rather than letting it land on a board that has moved.

Clock values never enter pilot RNG or engine state, and the scheduler is
injectable exactly as `MatchServer`'s disconnect timer already is, so delays are
tested against a fake clock rather than by waiting. Simulator and AI Spectator
runs stay delay-free: artificial live pacing must not contaminate a search, a
replay or a calibration result.

### 5. Difficulty, style, deck source and timing are four axes, not one

They are configured independently per bot and are never collapsed into each
other:

- **Deck source** decides what cards it brings.
- **Difficulty** decides how well it chooses among legal actions.
- **Style** decides what it prefers — the existing `aggressive`, `defensive` and
  `value` weight vectors.
- **Timing** decides how long it waits.

A Hard bot does not silently get a better deck. A slow bot is not an Easy bot. A
defensive bot is not a stronger bot. The three shipped styles are one heuristic
procedure pointed at three different weight vectors, and
`PILOT_AGENT_CLASSES` already refuses to rank them — relabelling them Easy,
Normal and Hard would resurrect exactly the pooled skill axis ADR 0022 and M05.4
exist to prevent.

Difficulty is a registry with its own version. Normal is the current published
heuristic behaviour for the chosen style. Easy is bounded, deterministic
suboptimality over the same scored candidates — not uniform random, not illegal,
not deliberate non-participation. Hard is a versioned improvement on named
calibration gaps, and it is a **player-facing difficulty label, not an evidence
class**: it does not become archetype-aware, it does not gain hidden information,
and a Hard win is not a balance finding.

### 6. The quick generator moves to a shared package; the search stays behind

The reusable half of `apps/simulator/src/deck-search/` — build one legal deck for
a Commander from a format-scoped database and a seed — moves into the smallest
suitable shared package. Evolution, population search and experiment
orchestration stay in the simulator app.

Two reasons it must move rather than be imported where it sits. An app depending
on another app inverts the dependency direction ADR 0001 chose; and the live
lobby needs a _small_ deterministic constructor, not the search that happens to
contain one. Identical inputs must keep producing identical output, so the
extraction is verified by equivalence against the simulator's current results
rather than by inspection.

One portability constraint, found by re-reading rather than assumed:
`apps/simulator/src/hash.ts` imports `node:crypto`, and the generator reaches it
through `seed.ts`'s `rngFor`. The chain is therefore **Node-only today**. That is
sufficient for M09, where generation happens on the authoritative server, and it
is a real limit on any future browser-side preview — so the extracting tranche
states which environments the shared package supports instead of implying both.

**What M09.8 did with that** (2026-08-19): the package is `@tcg/deck-generator`,
and it declares itself server-only rather than removing the dependency. The
choice was between an asynchronous digest — `crypto.subtle` has no synchronous
form — and a second hash implementation, and a second implementation is exactly
the drift that would let one seed name two different decks on two machines. The
declaration is `SUPPORTED_RUNTIMES` and `NODE_BUILTIN_DEPENDENCIES` in the
package's `version.ts`, and `runtime.test.ts` reads the package's own sources so
the claim fails when it stops being true. Deck identity moved with the
generator; the generator no longer reaches the simulator's `seed.ts` at all, and
takes `createRngState` directly.

### 7. Versions move where the shape moves, and nowhere else

- **`PROTOCOL_VERSION` moves where a message shape moves.** It first moved in
  M09.2, the tranche that put bot messages and the widened seat view on the wire:
  `lobbySeatViewSchema` is a strict object, so an older client would reject the
  first lobby view carrying a controller field; the handshake refuses first and
  says why.

  This ADR originally predicted that move would be the **only** one M09 made, and
  M09.9 showed the prediction was wrong rather than the principle. A generated
  deck has two audiences a `LobbyView` cannot serve — provenance the host alone
  may read, because the generator seed would rebuild the list card for card, and
  the list itself, which every seat may read once the match is over — so M09.9
  added `bot_seat_provenance` and `bot_decks_revealed` and moved the constant to 8. The correction is recorded here rather than the guess, because the rule this
  section states is the version moves where the _shape_ moves, and both of those
  are shapes. `serverMessageSchema` is a discriminated union parsed on receipt, so
  a v7 client would fail to decode the first of either; the handshake refuses
  first and names the older side.

  It moved a third time in M09.11, for the same rule. A table's pacing budgets
  are a required member of a strict `lobbyViewSchema` — every seat needs them to
  turn a bot's public percentage into the seconds beside it, and a copy per seat
  would be three chances for them to disagree — and `set_bot_pacing` is a fifth
  host-only message travelling the other way. Both are shapes, so the constant is 9. **`PACING_CONFIG_VERSION` deliberately did not move with it**: the budget
  shape and the percentage-to-delay calculation are exactly what M09.1 wrote, and
  what changed is the wire learning to carry them. Changing a budget's _value_
  moves nothing at all — that is the whole point of the numbers being
  configuration.

- **`MATCH_SCHEMA_VERSION` does not move.** A bot seat is a controller above the
  engine. `MatchState` does not learn what a bot is, and a replay of a
  human-versus-bot match is a replay of an ordinary match.
- **`RULES_VERSION` does not move** for pacing, for difficulty or for bot seats.
  None of them changes a legal action, a cost, or a resolution. M09.11 is the
  tranche that had to say so out loud, because it is the one that put seconds on
  a screen: the budgets live on the lobby rather than in `RulesConfig`, nothing
  in the engine reads them, and open-questions.md Q8 — whether a _human_ should
  ever be timed out of a phase or a choice — is exactly as open afterwards as it
  was before.
- **Bot configuration, difficulty, generator and pacing carry their own version
  constants**, because a difficulty can improve without a card, a rule or a
  message shape changing, and a result that cites "Hard" has to be able to say
  _which_ Hard. M09.13 is the first demonstration rather than the theory:
  `easy` moved `planned` → `available`, `DIFFICULTY_REGISTRY_VERSION` moved 1 →
  2, and `PROTOCOL_VERSION` stayed at 9 — `botDifficultySchema` had carried the
  ID since M09.1 and no shape on any wire changed. A difficulty's own
  `behaviorVersion` is the third, narrower constant: Easy improving moves that
  and neither of the other two.

A future version is refused with a readable message rather than migrated
speculatively — the treatment M07.9 applied to `CARD_SCHEMA_VERSION`.

## Consequences

- The lobby gains a genuine second controller kind, and every existing
  seat-shaped code path has to answer whether it applies to a bot. That is
  intentional exposure: the alternative is a `null` connection ID meaning "bot"
  by accident.
- The match server acquires scheduled work that is not a disconnect timer. It has
  to be cancellable, non-duplicating, and independent of callback arrival order
  wherever the engine promises order independence — which is a testing burden
  paid against a fake clock, not against real time.
- A single-bot immediate match is reachable early; every later property (pacing,
  difficulty, generated decks) is additive on top of it. That is why the first
  playable checkpoint sits at M09.5 rather than at the end.
- Nothing here decides what Hard actually does. The named tactical and strategic
  gaps, their fixtures, and the evidence limits of the result are decided in
  their own tranches.

## Alternatives considered

**Let a human client drive the bot.** The host's tab computes the bot's move and
submits it. Cheapest possible implementation, and rejected outright: it makes the
bot's legality depend on a client, gives one player's machine a reason to be
handed information about another seat, and turns a browser refresh into a stalled
match. The server is authoritative for exactly this class of reason.

**Reuse the AI Spectator runner for live play.** Attractive because it already
drives two to four pilots to a complete match. Rejected: it runs a whole match
before returning, which is the opposite of a live opponent, and its pacing is a
playback speed rather than a decision delay.

**Put pacing budgets in `RulesConfig`.** It is where `disconnectGraceSeconds`
lives, so it has real precedent. Rejected because that precedent is the problem:
a value in the rules configuration reads as a rule, and this one is explicitly
_not_ one — it is a test dial for how waiting feels, and putting it beside the
match rules would quietly pre-answer Q8 in the direction of "yes, phases have
timers".

**Map Easy, Normal and Hard onto the three existing styles.** No new pilot code
at all. Rejected as the dishonest option: `aggressive` and `defensive` are the
same instrument with different weights, and calling one of them harder than the
other would publish a skill ranking the calibration record does not support.

**Import the generator from `apps/simulator` where it sits.** Rejected on
dependency direction, and on the fact that the live lobby needs the constructor
rather than the search around it.
