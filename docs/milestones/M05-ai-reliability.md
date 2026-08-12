# M05 — AI and balance reliability

## Objective

Separate "the bot can make a legal move" from "the bot is credible evidence for
balance." Complete these tranches in order.

## M05.1 — Machine-readable mechanic support

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
