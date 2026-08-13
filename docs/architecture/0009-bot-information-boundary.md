# ADR 0009 — The bot information boundary (Phase 4)

**Status:** accepted · **Date:** 2026-08-08 · **Extended by:**
[ADR 0022](0022-evidence-claims.md)

**Amended 2026-08-13 (M07.3).** The boundary is unchanged and was re-read at
this date: `BotObservation` still has exactly six fields and none of them is
`MatchState`. One consequence below is now understated rather than wrong. "Results
describe what competent-ish heuristics do, which is stated in every report's
limitations" is no longer a sentence in a limitations section — a pilot's
**agent class** is a registry entry, every review signal names the evidence
claim it rests on, and a run that did not fly a class carrying that claim
declines the signal instead of printing it. What the pilots are actually blind
to is measured one hand-authored decision at a time by the calibration suite.
See [ADR 0022](0022-evidence-claims.md).

## Context

Phase 4 puts heuristic pilots in charge of playing matches so the simulator can
produce evidence about cards (CLAUDE.md §13.3). A pilot that can see more than a
human player could would invalidate every number the laboratory produces: a bot
that peeks at the opponent's hand does not play the game we are trying to
measure, and the resulting win rates would describe the leak rather than the
cards.

The engine already computes a redacted `PlayerView` and a `LegalActions` set for
the multiplayer server. The question was whether pilots should receive those, or
something more convenient.

## Decision

### The boundary is a type, not a convention

`BotObservation` has exactly six fields and none of them is `MatchState`:

```ts
interface BotObservation {
  readonly view: PlayerView; // already redacted by the engine
  readonly legal: LegalActions; // already computed by the engine
  readonly history: readonly LogEntry[]; // the public log for this seat
  readonly database: CardDatabase; // public card definitions
  readonly rulesConfig: RulesConfig; // public rule numbers
  readonly decisionIndex: number; // how many decisions this seat has made
}
```

A pilot cannot reach the authoritative state, the deck order, another player's
hand, an unrevealed choice or the engine's generator, because none of those is
in the object it is handed. Nothing has to remember to redact anything.

This is the same `playerView` the multiplayer server sends to a browser. A pilot
and a human client see identical information by construction, so a change that
leaks to one leaks to the other and is caught by both suites.

### Pilots are pure functions of their observation

`decide(observation, rng) => BotDecision`. A pilot gets a seeded generator
stream and returns an action plus optional diagnostics. It has no mutation
access to anything: the match runner validates the returned action against the
same `LegalActions` the pilot was shown, and only then submits it through
`applyAction`.

Given the same observation, bot version, configuration and seed, a pilot must
return the same decision. That is what makes a simulated match reproducible at
all, and it is tested rather than assumed.

### Failure is recorded, never absorbed

A pilot that throws, returns an illegal action, returns nothing, or exceeds its
decision budget is replaced for that decision by a random-legal fallback, and
the substitution is written into the match record as a `BotFailure`. A match
that finished normally but needed a fallback is reclassified from `victory` to
`pilot_error`, so it can never be mistaken for a clean result.

The alternative — letting the fallback quietly cover for a broken pilot — would
turn a defect into a statistic.

### Heuristics are data

Every weight a pilot uses is a named, runtime-validated number in a serializable
config, exported in the result metadata and overridable from an experiment file.
There are no card-ID-specific rules; the heuristics reason over authored tags,
roles, keywords and costs.

That means a reader can see exactly what "aggressive" meant in a given run, and
a run can be repeated with perturbed weights to check that a finding is not an
artefact of one particular set of numbers (CLAUDE.md §13.11).

## Consequences

- A pilot cannot cheat, so no test needs to check that it did not. The one test
  that does exist walks the whole observation looking for any hidden identifier
  and fails if one appears — it guards the _shape_, not each pilot.
- Pilots cannot be smarter than the information a player has. That is the point,
  and it also caps how good they can get; results describe what competent-ish
  heuristics do, which is stated in every report's limitations.
- `bot-interface` depends on public engine and card types only. The engine does
  not depend on it. A circular dependency here would have let engine internals
  reach a pilot.

## Alternatives considered

**Give pilots the full `MatchState`.** Simpler to write, and it would have made
lookahead search possible later. Rejected: the guarantee that a bot sees only
what a player sees is the foundation the entire laboratory rests on, and it
cannot be maintained by discipline across a growing set of pilots.

**Let pilots compute their own legal actions.** Rejected for the same reason the
web client does not: two implementations of legality diverge, and the divergence
shows up as an illegal-action termination rather than as a clear error.
