# ADR 0015 — Player help and the data-driven content system

**Status:** accepted · **Date:** 2026-08-09

## Context

The game had no way to explain itself. A player could see a board and a hand,
but nothing told them what a keyword meant, when a trigger fired, why a card was
not playable, or what the turn structure was. The information all existed — in
schemas, in the engine, in `CLAUDE.md` — and none of it reached a player.

The obvious fix, a hand-written React rulebook page and a tooltip component, was
the wrong one. Two things were already true and would have got worse:

- **Rules text existed in several places and disagreed.** `card-data`'s
  `KEYWORD_INFO` claimed Evasive could "only be blocked by Evasive units" and
  that Siphon healed "your Commander"; the engine made Evasive unblockable and
  healed the _controller_. It described Guardian and Resilient as working rules
  when `rules-engine`'s `KEYWORD_BEHAVIOUR` recorded both as deliberately inert.
  Two registries, two audiences, no mechanism keeping them honest.
- **Numbers get copied.** Starting health, hand size, slot counts and deck size
  are all provisional playtest dials. Any prose that spells them out is wrong the
  next time one is tuned, and nothing would catch it.

The milestone therefore had to be a content system, not a help page.

## Decision

### One registry per concept, and dependency direction decides where it lives

The keyword registry moved into `@tcg/card-data`, which owns `KEYWORD_IDS` and
sits below everything else. It carries the player-facing definition _and_ the
`implemented` flag. `rules-engine` imports that flag rather than keeping a copy,
and retains only its developer-facing note about which handler owns each
keyword. The two can no longer disagree about whether a keyword does anything.

`KEYWORD_INFO` and `KeywordInfo` were removed rather than kept as aliases. An
alias is a second name for the truth, and second names are how the drift
started.

### Definitions describe the engine, not another card game

Every keyword definition was rewritten against the actual handler. Evasive is
"cannot be blocked". Siphon heals "its controller". Guardian and Resilient say,
in the words a player reads, that they currently do nothing and why. That is
less satisfying than a plausible rule and considerably more honest; a player
told Guardian forces blocks would be actively misled.

### Configuration is referenced, never quoted

Content may write `{matchConfig.armoredReduction}` or `{deckRules.deckSize}`.
`references.ts` resolves those against the live `RulesConfig` and
`DeckFormatConfig`. The namespace is fixed and two levels deep — enumerated from
the configuration objects themselves, not traversed — so a reference cannot point
at something the engine does not have, and an unknown one fails validation.

One mechanism serves keyword definitions, glossary entries, rulebook blocks and
curated card text. Tuning a provisional value updates every sentence quoting it.

### The rulebook is content with a closed block vocabulary

`rulebook.json` is a list of sections of typed blocks: `paragraph`,
`bulletList`, `callout`, `configValue`, `phaseList`, `keywordIndex`,
`glossaryIndex` and a few more. Deliberately **not** HTML-in-JSON: text fields
reject angle brackets at the schema boundary, so markup cannot be smuggled
through content, and the renderer's escaping is a second line of defence rather
than the only one.

`RulebookPanel.tsx` knows about block _types_ and contains no rule, no number
and no keyword name. Correcting a rule is a JSON edit.

### Explanations are generated, exhaustively, or validation fails

`explainCard` is pure and deterministic. It walks a card's structured effects in
resolution order and renders each one through a total
`Record<EffectType, Renderer>` table. There is no `default` branch — a default
is precisely what would let an unhandled effect render as a plausible sentence
that omits what the card really does.

`npm run validate:content` generates an explanation for every card in the pool
and fails on any empty step. Adding an effect type without a renderer is a
compile error; shipping a card whose behaviour cannot be described is a build
failure.

Curated `text.summary`, `text.effectExplanations` and `text.notes` supplement
the generated output and are shown beside it, never instead of it. Writing more
`effectExplanations` than the card has effects is an error, so a clarification
cannot outlive the step it describes. There is no `text.rules`: `displayText`
remains the single canonical rules text.

### The inspector may only say what the view already knows

`publicCardContext` reads from the seat's own `PlayerView` and
`view.legalActions`. It cannot reach a card the engine did not send, so an
inspector built on it cannot leak a hidden hand even if it asks — those cards
were never in the payload. No protocol change was needed.

Where the view does not explain _why_ something is illegal, the inspector says
so plainly instead of guessing. A cost reducer, a filter and a target
requirement can each make a card unplayable, and several can apply at once; a
client that inferred a reason would eventually tell a player something false
about the rules. "The server is not offering this card as playable right now"
is worth more than a confident wrong answer.

### Help mode replaces click handlers rather than guarding them

In `MatchBoard`, Help mode is one nullable value that every click handler
branches on. When it is set, the inspect handler _is_ the handler — there is no
path through the attacker, blocker, target or play branches at all. "Help mode
cannot perform a game action" is then a single property rather than a promise
spread across a dozen call sites. The inspector is never handed the match
client.

## Consequences

- Adding an ordinary card is a data edit plus an optional PNG. No component,
  route, switch statement or stylesheet is involved. `docs/ADDING_CARDS.md`
  documents the path, and five validated templates back it.
- Three player-facing keyword definitions changed meaning, because the old ones
  were wrong. That is a content correction, not a rules change: no engine
  behaviour moved.
- `@tcg/help-content` depends on `card-data`, `deck` and `rules-engine`. Nothing
  depends on it except the web client, so the engine, server and simulator are
  untouched by presentation.
- The rulebook is honest about being unfinished. Sections carry `unresolved`
  callouts where a rule is deliberately undecided — Commander deployment,
  keyword semantics — rather than filling the gap with invention.
- `npm run verify` now runs `validate:content` between lint and test.

## Alternatives considered

**A separate UI-only card database.** Rejected outright: a second card model is
the drift problem with extra steps.

**Keeping `KEYWORD_INFO` as a deprecated alias.** Rejected. Three call sites is
a cheap migration, and leaving the old name alive invites new code to use it.

**Letting the inspector infer why a card is unplayable.** Rejected. It would
have required a partial reimplementation of `legalActions` in React — exactly
what CLAUDE.md §11 forbids — and would be wrong in cases the client cannot see.

**Migrating cards to one file per card.** Deferred. `prototype_core.json` at 56
cards is not yet inconvenient, the loader API already hides the physical layout
from every consumer, and a move would touch saved data for no current benefit.
