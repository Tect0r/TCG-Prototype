# TCG Prototype

A deterministic TypeScript card-game prototype with a deck builder,
authoritative two-to-four-player matches, structured card effects, local bot
simulation, balance tooling, replays, and an AI spectator interface.

## Current state

The original deck-builder, rules-engine, multiplayer, free-for-all, simulation,
and Phase 4 hardening work is implemented. The active project goal is making the
155-card `precon_wave_1` catalog fully executable and trustworthy for precon
playtesting.

At the handoff baseline (`d49529b`, 2026-08-11):

- 155 authored Wave 1 cards, including 4 Commanders and 3 Tokens.
- 142 cards executable; 13 still declare `implemented: false`.
- Four 40-card singleton precons.
- A separate 56-card `prototype_core` development fixture set.
- Deployable Commanders, Reactions, unlimited Units, one active Relic, Guardian,
  Barrier, Overwhelm, Rush, and Newly Deployed behavior.
- AI spectator mode for deterministic two-to-four-bot matches, replay playback,
  normal/analysis information modes, and configurable visual speed.

The spectator is valid for UI and replay testing. Precon balance conclusions are
not valid until all 13 remaining cards are executable and the AI/telemetry gates
in the implementation plan are complete.

Since M02.6 all 155 cards are executable and every shipped precon is legal. A
precon can be inspected and copied in the deck builder, or picked by name in the
lobby's deck list and played exactly as printed: the client sends its permanent
ID and the match server resolves and validates its own copy of the definition
(M03.2). An edited copy is an ordinary saved deck and is judged on its contents.

Since M04.1 the evidence about unlimited boards is one shared measurement:
`@tcg/board-telemetry` defines board size, combat cost and trigger load once, and
both a watched match and a simulator batch record it from the same event stream.
It is raw observation only — the numbers say how wide boards got, how expensive
the largest combats were and how many rounds passed with no attacker, and
deliberately do not say whether any of that is a stall. No Unit cap follows from
them.

The refusal path for an unfinished card is unchanged and still under test
against a doctored pool, because it has to keep working for the next card
somebody starts and does not finish. The spectator refuses such a deck by name
and can only run it under a developer override (`--allow-incomplete-cards`, or
the matching checkbox on the setup screen), which marks the replay and its
telemetry `resultsValid: false` and warns on every screen that shows the match.

See [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for live status and the
next bounded task.

## Requirements

- Node.js `24.15.0` as pinned by the repository.
- npm using the committed lockfile.

## Setup

```bash
npm ci
npm run dev
```

Run the authoritative multiplayer server separately when needed:

```bash
npm run dev:server
```

## Useful commands

```bash
npm run verify
npm run test
npm run typecheck
npm run validate:content
npm run content:check
npm run cards:new -- --help
npm run report:triggers
npm run simulate -- --help
npm run simulate -- spectate --help
```

`npm run verify` is the completion gate. It runs generated-content checks,
type-checking, lint, formatting checks, player-help validation, tests, and the
production build.

Type-checking covers every workspace **and** the root project — `scripts/`,
`vitest.config.ts` and `eslint.config.js` — so repository tooling is held to the
same strictness as shipped code. `npm run typecheck:root` runs that part alone.

## Content and formats

Card sources live under `content/sets/`; generated bundles must not be edited by
hand. `development` and `precon_wave_1` are separate formats. Code that means
"cards legal here" must request a format-scoped pool rather than use the entire
bundled database.

The deck builder and the match server both resolve their pool through
`loadFormatCardData(resolveFormatId(...))` and run `precon_wave_1` by default.
Set `VITE_TCG_FORMAT` (client) or `TCG_FORMAT` (server) to `development` to run
the fixture set instead; an unknown format ID is refused rather than replaced.

Card prose is presentation. Executable behavior is structured data validated by
the schema and rules engine. See [`docs/ADDING_CARDS.md`](docs/ADDING_CARDS.md)
before adding or changing a card.

## Documentation map

- `CLAUDE.md` — short permanent agent constraints.
- `IMPLEMENTATION_PLAN.md` — live milestone index and active tranche.
- `docs/milestones/` — bounded implementation specifications.
- `docs/architecture/` — accepted architectural decisions and rationale.
- `docs/rules/` — confirmed rules and genuinely open decisions; refreshed in
  Milestone 07.
- `docs/PHASE4_HARDENING.md` — historical hardening specification retained
  because code comments cite its contracts.

## Core safety properties

- Deterministic engine and replay behavior.
- Authoritative server and strict hidden-information projection.
- Serializable choices and atomic cost payment.
- Structured effects rather than rules-text parsing.
- Raw match evidence retained separately from derived balance claims.
- Random-legal bots test legality and termination; they do not prove balance.
