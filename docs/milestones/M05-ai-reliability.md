# M05 — AI and balance reliability

## Objective

Separate "the bot can make a legal move" from "the bot is credible evidence for
balance." Complete these tranches in order.

## M05.1 — Machine-readable mechanic support — **done (2026-08-12)**

Create an exhaustive registry for every effect, trigger, keyword, condition, and
value expression:

```ts
{
  engine: 'full' | 'none',
  help: 'full' | 'partial' | 'none',
  pilot: 'full' | 'approximate' | 'legal_only',
  telemetry: 'full' | 'partial' | 'none'
}
```

Derive content/playtest support from registries, not author claims. Manifests and
reports must state the weakest support in each deck and suppress/downgrade balance
flags that depend on legal-only pilots or missing telemetry.

Resolve Q4 before calling keyword coverage complete: implement `resilient` or
remove it from playable content and bot valuation.

### Checklist

- [x] `packages/card-data/src/support.ts` classifies **seven** vocabularies, not
      five: instruction effects, continuous (`staticAbilities`) effects, triggers,
      keywords, conditions, value expressions and costs. Continuous effects and
      costs are separate schema unions with separate executors, and leaving them
      out would have left two families unclassifiable.
- [x] Every table is a total `Record` over a vocabulary read off the schema, so
      adding a mechanic without classifying it is a compile error;
      `supportRegistryGaps()` makes the same check at runtime in both directions.
- [x] Each entry carries a `where` note naming the module the claim is about, so
      a downgrade is actionable rather than an adjective.
- [x] `mechanicsUsedBy(card)` derives what a card is built from by walking its
      structured data — keywords, additional costs, every effect list, ability
      triggers and gates, value expressions, continuous effects, and the keyword
      a `grant_keyword` or `replace_arrival` hands out.
- [x] `KEYWORD_REGISTRY.implemented` is now _derived_ from the registry rather
      than typed beside each entry, so the glossary and the content gate cannot
      disagree.
- [x] The content build fails a `playtest`/`active` set containing a card built
      on an `engine: 'none'` mechanic (`content/unsupported_mechanic`), and warns
      in a `development` set. Derived, never read off `card.implemented`.
- [x] `bot-interface` publishes `LEGAL_ONLY_PILOT_IDS`.
- [x] The simulator's `analysis/support.ts` projects the registry onto the decks
      that actually played; `manifest.json` (schema 4 → 5) and `summary.json`
      (3 → 4) carry the block, and the report (schema 4 → 5) gains a
      `## Mechanic support` section plus a limitations bullet.
- [x] `applySupportLimits` downgrades a balance flag to `insufficient_data` —
      never drops it — when every pilot is legality-only, when its subject card
      carries a mechanic no pilot values, or when its subject card does nothing a
      match record observes. `run_quality` flags are untouched, and a
      `unsupported_mechanics` note names what was missing.

### Q4

Half-answered, deliberately. `resilient` is now structurally barred from playable
content by a derived check rather than by luck, and the registry records it as
`engine: 'none'` / `pilot: 'legal_only'`. Whether to implement it — and under
which reading — or delete it from `KEYWORD_IDS` is still an owner decision; see
docs/open-questions.md. The bot-valuation half (`keywordCount` still pays a flat
bonus for it) is M05.2's first bullet.

### Findings this tranche surfaced

Both are recorded in the registry rather than fixed here, because both are other
tranches' work:

- **No pilot values `effect: counter`.** `ungatedEffectValue` has no `counter`
  case and falls through to its zero default, so a Reaction whose whole text is a
  counter is priced as a blank card. Every shipped precon carries one, so every
  precon deck now reports `pilot: legal_only`. M05.2.
- **`CardTelemetry.timesReturnedToHand` is never incremented.** The field is in
  the schema and the collector never writes it, so a bounce is invisible to a
  batch. Recorded as `effect: return_to_hand` → `telemetry: 'none'`.

## M05.2 — Exhaustive valuation

Repair `packages/bot-interface/src/scoring.ts`:

- never value unimplemented keywords;
- replace the default-zero effect switch with an exhaustive `EffectType`-keyed
  registry/type check;
- value static abilities by magnitude, scope, duration, and affected board, not
  array length;
- add focused valuation tests for every Wave 1 primitive.

## M05.3 — Choice provenance and intent

Stop inferring whether a choice is helpful/hostile by scanning the entire source
card. Add structured provenance to pending choices: resolution item/effect index,
source, chooser, target relation, and semantic intent. Test mixed helpful/hostile
cards, optional sacrifice, divided damage, and multiplayer choices.

## M05.4 — Honest agent classes

Encode and report distinct claims:

- random-legal: legality, termination, loop, crash discovery only;
- generic heuristic: approximate play quality for supported linear mechanics;
- archetype-aware: required for synergy, sacrifice, control, and combo evidence;
- human playtest: required before final balance conclusions.

Never pool these as one skill distribution.

## M05.5 — Archetype registry and deck plans

Add a versioned archetype registry and deck-plan schema for the four Wave 1
decks. Generation should seed coherent packages, mutation may protect or replace
packages, and reports must distinguish hand-authored, plan-generated, and
unconstrained decks. Search must remain able to explore outside plans.

## M05.6 — Calibration before balance

For each precon:

- hand-author tactical decision fixtures;
- verify characteristic sequencing/targeting/sacrifice decisions;
- compare pilots on identical seeds;
- run the ordered matchup matrix;
- label results as calibration until human sanity checks agree.

## Acceptance

- Adding an unscored mechanic fails loudly.
- Every report states pilot and telemetry support.
- Sacrifice/control choices reflect the resolving instruction, not unrelated
  text on the card.
- Balance claims are limited to evidence the active pilot class supports.

## Exclusions

- Autonomous live-player telemetry.
- Declaring a final meta from bot games alone.
- Optimizing visual spectator pacing.
