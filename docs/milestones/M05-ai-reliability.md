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
docs/open-questions.md. The bot-valuation half was M05.2's first bullet and is
now done: `keywordIsValued` reads this registry, so no pilot pays for it.

### Findings this tranche surfaced

Both are recorded in the registry rather than fixed here, because both are other
tranches' work:

- **No pilot values `effect: counter`.** `ungatedEffectValue` has no `counter`
  case and falls through to its zero default, so a Reaction whose whole text is a
  counter is priced as a blank card. Every shipped precon carries one, so every
  precon deck now reports `pilot: legal_only`. M05.2. — **Fixed in M05.2**; the
  registry entry now reads `pilot: 'approximate'`.
- **`CardTelemetry.timesReturnedToHand` is never incremented.** The field is in
  the schema and the collector never writes it, so a bounce is invisible to a
  batch. Recorded as `effect: return_to_hand` → `telemetry: 'none'`.

## M05.2 — Exhaustive valuation — **done (2026-08-13)**

Repair `packages/bot-interface/src/scoring.ts`:

- never value unimplemented keywords;
- replace the default-zero effect switch with an exhaustive `EffectType`-keyed
  registry/type check;
- value static abilities by magnitude, scope, duration, and affected board, not
  array length;
- add focused valuation tests for every Wave 1 primitive.

### Checklist

- [x] `keywordIsValued` derives what a keyword is worth from
      `@tcg/card-data`'s mechanic support registry rather than from a second
      list, so an `engine: 'none'` keyword is worth zero on a printed statline,
      on `grant_keyword`, on `remove_keyword`, on a continuous `grant_keyword`
      layer and on the keyword `replace_arrival` hands out. Answers the
      bot-valuation half of Q4.
- [x] `EFFECT_PRICERS` is a total `Record` over `EffectType` — a new instruction
      is a compile error until it is priced — and `effectPricingGaps()` is its
      runtime twin in both directions, for the JSON-driven paths that never see
      the type. The `default: 0` that priced `counter` as a blank card is gone.
- [x] `counter` is priced. `counterValue` is a new named weight, `unlessPays`
      softens it as an even split, and the paid branch is capped at the counter's
      own value because the branch is the opponent's choice. `scoreReaction`
      subtracts the abstract estimate and substitutes the value of the card
      actually on the stack, so holding a counter is approximate and spending one
      is board-aware.
- [x] `staticAbilityValue` prices magnitude × `scopeReach` × a source-bound
      duration × a `sourceState` gate, signed by `scopeSign`. `onlySource` reaches
      one card and a filtered scope is discounted against an unfiltered one, so
      one large layer outranks two tiny ones — the array-length proxy is gone.
      All six continuous effects have their own branch.
- [x] `costValue` / `costsValue` are shared by `scoreActivate`, by a played
      card's `additionalCosts` and by an activated ability priced inside
      `cardValue`, so the same sacrifice costs the same wherever it is paid. A
      played card with an additional cost is no longer read as free.
- [x] `packages/bot-interface/src/scoring.test.ts` covers every Wave 1
      primitive. Its instruction, cost and continuous tables are mapped types
      over the schema's own vocabularies, so a mechanic added without a valuation
      test does not compile — the acceptance criterion checked from the test side.
- [x] The registry records the change rather than being contradicted by it:
      `SUPPORT_REGISTRY_VERSION` 1 → 2, `effect:counter` `legal_only` →
      `approximate`, and every rewritten `where` note names the function its
      claim is now about.

## M05.3 — Choice provenance and intent — **done (2026-08-13)**

Stop inferring whether a choice is helpful/hostile by scanning the entire source
card. Add structured provenance to pending choices: resolution item/effect index,
source, chooser, target relation, and semantic intent. Test mixed helpful/hostile
cards, optional sacrifice, divided damage, and multiplayer choices.

### Checklist

- [x] `@tcg/card-data`'s `intent.ts` classifies the valence of every member of
      the instruction vocabulary — `benefit` / `detriment` / `neutral`, meaning
      what happens **to the thing selected**. `EFFECT_INTENTS` is a total mapped
      type over `EffectType`, so an unclassified instruction is a compile error,
      and `effectIntentGaps()` is its runtime twin in both directions. Four
      entries read a printed parameter instead of returning a constant, because
      for those four the number is the direction: a stat modifier's sign, a cost
      delta's sign, a search's destination, and a zone move's journey (a revival
      and a bounce are one instruction).
- [x] `PendingChoice.provenance` carries the resolution item and effect index
      that asked, the asking instruction, the source's controller, how the seat
      being asked relates to that controller, whose entities the options are, and
      the intent. It is stamped at all four places a choice is built —
      `effects.ts`, the Ready Step replacement offer, the hand-size discard and
      the interactive cost — and the three non-instruction origins say so
      (`cost`, `replacement`, `turn_structure`) rather than filling the
      resolution fields with something that is not one.
- [x] `targetRelation` is read **from the seat being asked**, not from the
      ability's controller, so "a Unit you control" in an `each_player_choice`
      means each seat's own units. `any` is the honest answer when the chooser is
      not the controller and the selector said `opponent`.
- [x] Provenance carries **no card identity**. `sourceInstanceId` beside it
      already attributes the question; adding the source's `definitionId` would
      hand the seat being asked the printed identity of a card it may never have
      been shown. Asserted by name in `choice-provenance.test.ts`.
- [x] `heuristic.ts`'s `scoreChoice` reads `provenance.intent` and the option's
      owner. `sourceIsHostile`, the `HOSTILE_EFFECTS` set and the hard-coded list
      of "always costly" reasons are all deleted; a cost is now just a detriment
      aimed at cards the chooser owns. The ordered branch uses the same direction,
      so reordering somebody else's deck comes out the right way round.
- [x] The `choice_requested` event carries the provenance too, because the
      pending choice is gone the moment it is answered and a replay would
      otherwise record what was picked but not what picking it meant.
- [x] Versions moved as refusals, not migrations: `MATCH_SCHEMA_VERSION` 6 → 7,
      `PROTOCOL_VERSION` 4 → 5 (the view shape a client validates changed),
      `SPECTATOR_REPLAY_VERSION` 5 → 6, and the three heuristic pilots 1.0.0 →
      1.1.0, since their decision procedure changed and a record has to be
      traceable to the pilot that produced it. `SUPPORT_REGISTRY_VERSION` stays
      at 2: no mechanic's support level changed.
- [x] `packages/rules-engine/src/choice-provenance.test.ts` covers a mixed
      helpful/hostile card, the optional sacrifice (confirm then selection), the
      divided-damage allocation, a four-seat `each_player_choice`, the
      `select_opponent`-then-discard chain, the interactive cost and the
      hand-size discard, plus the event, the view and a serialisation round trip.
      `packages/bot-interface/src/choice-intent.test.ts` holds the board fixed and
      moves only the provenance, so the preference flip is the assertion.
      `packages/card-data/src/intent.test.ts` is a mapped type over `EffectType`.

### The rule the UI gained

`keep_exhausted` was worded "Pay to keep one **enemy** unit Exhausted" and was
wrong half the time — the same reason is raised at your own Ready Step and at
somebody else's. The prompt now reads `provenance.targetRelation` and asks the
question the player is actually being asked.

## M05.4 — Honest agent classes — **done (2026-08-13)**

Encode and report distinct claims:

- random-legal: legality, termination, loop, crash discovery only;
- generic heuristic: approximate play quality for supported linear mechanics;
- archetype-aware: required for synergy, sacrifice, control, and combo evidence;
- human playtest: required before final balance conclusions.

Never pool these as one skill distribution.

### Checklist

- [x] `packages/bot-interface/src/agent-class.ts` is the registry: four classes
      and twelve evidence claims, with `AGENT_CLASS_CLAIMS` a total `Record` over
      **both** vocabularies, so adding a class or a claim without deciding every
      pair is a compile error. `agentClassGaps()` is its runtime twin in both
      directions. `AGENT_CLASS_REGISTRY_VERSION` starts at 1 and moves when a
      classification does.
- [x] Claims are monotone along the published order and that is **asserted, not
      assumed**: nothing folds a class set to a rank, so a future class that is
      genuinely incomparable fails a test instead of being averaged into a skill
      axis.
- [x] `PILOT_AGENT_CLASSES` is total over `PILOT_IDS` — a new pilot cannot ship
      without deciding what a run it flies may be cited for. `aggressive`,
      `defensive` and `value` are one class with three weight vectors, not three
      skill levels. `LEGAL_ONLY_PILOT_IDS` is now a **view** of that table (the
      pilots whose class cannot carry `play_quality`) rather than a second list
      beside it, so the M05.1 downgrade and this taxonomy cannot disagree.
- [x] `AGENT_CLASSES_WITHOUT_PILOTS` states that nothing in this build is
      archetype-aware or a human, so the absence of synergy/sacrifice/control/
      combo/final-balance evidence is a printed fact rather than an omission a
      reader has to notice.
- [x] `FLAG_CLAIMS` maps every flag reason to the claim it rests on, total over
      `FLAG_REASONS`, so a new review signal is a compile error until somebody
      decides which class of agent is entitled to make it. `flagClaimGaps()` is
      the runtime twin.
- [x] `applyAgentClassLimits` downgrades a signal to `insufficient_data` — never
      drops it, evidence and interval intact — when the run's classes cannot
      carry its claim. A set of classes carries a claim only when **all** of them
      do, because the numbers a flag is computed from pool every seat.
      `agentClassFlags` raises one `run_quality` note naming the classes and both
      lists, emitted even when nothing was downgraded.
- [x] `aggregate`'s `RunSummary` gains `agentClassWinRates`, reported beside the
      pilot rates and never combined with them; an unrecognised pilot ID gets its
      own `unclassified` bucket rather than a guess.
- [x] The report gains `## Agent classes` (report schema 5 → 6) between the
      review signals and mechanic support, plus a per-class outcome table and a
      limitations bullet. The manifest (5 → 6) and `summary.json` (4 → 5) carry
      the `agentClasses` block with the registry version that made the citation.
- [x] `packages/bot-interface/src/agent-class.test.ts` restates the claim table
      independently as a mapped type, and `apps/simulator/src/agent-class.test.ts`
      covers the downgrade, the mixed run, the unclassified pilot, the per-class
      win rates and the rendered section. `precon-source.test.ts` asserts the
      block on a real four-precon batch.

### What this changed about existing runs

Two behaviours moved, both deliberately, and both in the direction of claiming
less:

- **A card-pair or counter-breadth signal is now declined by every run this
  build can produce.** `strong_card_pair` rests on `synergy` and
  `single_narrow_counter` on `control`, and no shipped pilot is archetype-aware.
  This is the milestone's own rule — "archetype-aware: required for synergy,
  sacrifice, control, and combo evidence" — encoded rather than described. M05.5
  is what turns them back on.
- **A run mixing `random_legal` with a heuristic now declines its play-quality
  signals.** M05.1 deliberately made its own `legalOnlyPilots` switch "every, not
  any", so as not to throw away a properly flown arm. That reading is superseded
  here for the pooled columns only: a pooled win rate genuinely mixes both seats,
  and citing it as play quality is exactly the pooled skill distribution this
  tranche exists to forbid. The properly flown arm is not thrown away — it is
  reported in its own row, which is what M05.1 had no place to put.

`seat_sensitivity` deliberately survives a random-legal run: the schedule mirrors
seats, so uniform play is an unbiased probe of a turn-order advantage. That is
the one outcome claim `random_legal` carries, and it is named
`structural_asymmetry` rather than folded into play quality.

## M05.5 — Archetype registry and deck plans — **done (2026-08-13)**

Add a versioned archetype registry and deck-plan schema for the four Wave 1
decks. Generation should seed coherent packages, mutation may protect or replace
packages, and reports must distinguish hand-authored, plan-generated, and
unconstrained decks. Search must remain able to explore outside plans.

### Checklist

- [x] `packages/card-data/src/archetype.ts` is the registry: four archetypes with
      a label, a summary, a pilot note and the package roles a plan claiming that
      archetype must supply. `ARCHETYPE_REGISTRY` is a total `Record` over
      `ARCHETYPE_IDS`, so adding an archetype without deciding what it requires
      is a compile error, and `archetypeGaps()` is the runtime twin — which
      matters here more than anywhere, because every consumer arrives as JSON.
      `ARCHETYPE_REGISTRY_VERSION` starts at 1 and pins the taxonomy a label was
      read against. The registry names **no card**, which is what keeps the
      vocabulary stable when the pool moves; that is asserted by name.
- [x] `packages/card-data/src/schema/deck-plan.ts` is the plan schema: named
      packages carrying a role, a rationale, a `core` flag and their cards, plus
      the archetype, format, Commander and the precon the plan describes. A
      package is present **all or nothing** — a half-present package would let
      mutation dismantle an engine one card at a time and still report it
      protected.
- [x] Four authored plans in `content/deck-plans/`, one per Wave 1 precon, with
      package membership derived from the cards' own `role` and
      `design.identity` rather than assigned by hand.
- [x] The content build checks every claim a plan makes: the archetype's required
      roles are supplied, packages do not overlap, at least one is core, every
      card is in the format pool, and — when the plan names a precon — the
      Commander and every card belong to that precon. All errors in every set
      status: a `development` set may hold an unimplemented card because that is
      inventory, but a plan that misdescribes a deck is a search input that would
      steer a whole population wrong. Bundle schema 1 → 2.
- [x] `generatorConfig.planId` makes generation seed **whole packages** in
      declared order and fills only the rest by the weighted draw;
      `planPackages: 'core'` seeds only the defining ones. A package that cannot
      go in whole is skipped and reported (`sim/package_not_seeded`), never
      applied partially. The plan fixes the Commander, and an unresolvable plan
      stops the generation instead of quietly producing the unconstrained decks
      it was configured to replace.
- [x] `mutateDeck` takes a `packagePolicy`: `protect` never removes a card of an
      intact **core** package; `replace` removes one whole core package and
      refills the freed slots **from the pool**, not from the plan. `none` is the
      default and is byte-identical to the pre-M05.5 operator, which is asserted.
- [x] Search remains able to explore outside plans, structurally rather than by
      configuration: `MAX_PLAN_SHARE` caps a plan at 75% of the deck and the
      content build enforces it, so every plan-generated deck has free slots and
      no generator setting can take them away.
- [x] `SimDeck.construction` records `hand_authored` / `plan_generated` /
      `unconstrained`, the plan and archetype, and which packages are intact,
      broken or off-plan. **Recorded, never inferred** — a random deck holding a
      whole package is still a random deck — and outside the deck hash, because
      two identical lists are the same deck to the engine whoever built them.
- [x] `apps/simulator/src/analysis/construction.ts` projects it; the report gains
      `## Deck construction` (report schema 6 → 7) between the agent classes and
      the mechanic support, plus a limitations bullet; the manifest (6 → 7) and
      `summary.json` (5 → 6) carry the block with the registry version.
      `SEARCH_CHECKPOINT_VERSION` 1 → 2, a refusal: a v1 checkpoint never
      recorded where its decks came from.
- [x] `packages/card-data/src/archetype.test.ts` restates the required-role table
      as a mapped type and holds the four shipped plans against their precons;
      `apps/simulator/src/deck-plan.test.ts` covers resolution, whole-package
      seeding, protection, replacement, the free-slot guarantee and the
      three-way construction count; `precon-source.test.ts` asserts the block on
      the real four-precon batch.

### What the shipped content cannot support, and why that is recorded

`goblin_warboss` is mono-red, so its colour-legal Wave 1 pool is **41 cards
against a 40-card singleton deck** — one spare. Every package-scale move has
nowhere to put the cards it frees, so `replace` correctly declines on a full-size
Wave 1 deck with `no intact core package … short of legal size` rather than
producing something smaller or putting the package back. This is a property of
the shipped card pool and not of the operator: it is the same reason crossover
between two full-size Wave 1 decks already reported "no legal change" before this
tranche. The replacement behaviour is therefore exercised at a smaller deck size
over the same pool, and the constraint is written down here rather than hidden
behind a test fixture.

## M05.6 — Calibration before balance — **done (2026-08-13)**

For each precon:

- hand-author tactical decision fixtures;
- verify characteristic sequencing/targeting/sacrifice decisions;
- compare pilots on identical seeds;
- run the ordered matchup matrix;
- label results as calibration until human sanity checks agree.

### Checklist

- [x] `packages/bot-interface/src/calibration/` is the tactical fixture suite:
      sixteen hand-authored boards over the four Wave 1 precons, each asking the
      one question that board exists to ask. A fixture drives the real pilot
      through the real observation boundary — `playerView` plus `legalActions`,
      the same pair a networked bot receives — so nothing can be calibrated
      against information no seat can see. The board itself is built with the
      engine's own arrangement helpers, published for the first time as
      `@tcg/rules-engine/test-fixtures`, because a fixture's board has to be a
      board the engine could have produced and there is one definition of that.
- [x] `CALIBRATION_FACETS` is the decision vocabulary — sequencing, targeting,
      sacrifice, blocking, reaction — with `CALIBRATION_FACET_REGISTRY` a total
      `Record` over it, so a facet added without a question and an applicability
      rule is a compile error, and `calibrationFacetGaps()` is the runtime twin.
      The three the milestone names, plus the two that are the whole identity of
      two of the four shipped decks: a Guardian deck is a blocking deck and a
      Containment deck is a Reaction deck, and leaving those out would have
      calibrated every precon except at the thing it is for.
- [x] **Applicability is derived from the cards, never claimed.**
      `precon_goblin_swarm` contains no sacrifice and `precon_grave_sacrifice`
      contains no Reaction, so neither is asked a question it cannot pose — and
      that is read off `mechanicsUsedByAll` and the card types rather than typed
      into a table beside the deck. Precon IDs arrive as content and are not a
      union a `Record` can be total over, so the coverage guarantee the facet
      vocabulary gets from the type system is made by `calibrationGaps()`
      instead: a precon added to the format without a fixture, or a fixture filed
      under a facet its own deck cannot pose, is a named failure.
- [x] Every fixture records what the pilot **actually does**, and `knownGaps`
      names the pilots that do not make the characteristic decision, with the
      part of the valuation that cannot see the difference. The suite asserts the
      record in **both directions**: a gap that closes fails exactly as loudly as
      a characteristic decision that regresses, because both mean the written
      record has stopped being true. A suite containing only decisions the pilots
      already make would measure nothing.
- [x] `compareCalibrationSuite` is the pilot comparison. The seed is a function
      of the fixture ID alone, so every pilot faces the identical board, the
      identical scripted opponent and the identical generator state — "compare
      pilots on identical seeds" is true by construction rather than by
      discipline, and a disagreement between two pilots is a difference in
      valuation and cannot be a difference in luck. It ranks nothing:
      `aggressive` and `defensive` are one agent class with two weight vectors,
      and a fixture they answer differently is a fact about the fixture.
      `CALIBRATED_PILOT_IDS` is a **view** of the agent class registry — the
      pilots whose class can carry `play_quality` — so `random_legal` is excluded
      by the M05.4 taxonomy rather than by a second list.
- [x] `apps/simulator/src/analysis/calibration.ts` labels the run. The standing
      is `claimCarriedBy(classes, 'final_balance')` and nothing else: derived from
      the agent classes that flew, **not a field in an experiment file**, so no
      configuration promotes a run from an instrument reading to a balance
      conclusion. The report opens with `## Calibration standing` before the
      limitations and before any number it could qualify (report schema 7 → 8),
      and the manifest (7 → 8) and `summary.json` (6 → 7) carry the block so a
      downstream tool can refuse to publish on a calibration run without parsing
      prose.
- [x] The ordered matchup matrix was run on the shipped four-precon
      configuration and its result recorded below, under the standing this
      tranche introduced.
- [x] `packages/bot-interface/src/calibration/calibration.test.ts` asserts the
      three things separately: the suite is complete, every fixture's recorded
      behaviour is still true, and the pilots faced identical positions.
      `apps/simulator/src/calibration.test.ts` covers the standing, the
      unclassified-pilot withdrawal, the promoted case (reachable only by handing
      the analysis a human class directly, which is what stops the standing being
      a constant dressed up as a derivation) and the mixed run that is **not**
      promoted by its strongest arm.

### What the fixtures found

Nine of the sixteen fixtures are answered characteristically by all three
heuristic pilots, one splits, and six are answered by none. The six are not a
verdict on the pilots; they are the list of things a match result could never
have told anybody, and each is recorded on the fixture that found it:

- **Removal targeting ignores lethality.** `rankChoiceOptions` orders by board
  value, so Throwing Knife and Crude Bomb are aimed at the biggest body on the
  table rather than at the one the damage actually defeats. Two fixtures, two
  decks. `aggressive` gets the Goblin one right and `defensive` and `value` get
  it wrong, for a reason unrelated to lethality: its weight vector values ATK
  enough that the killable body ranks higher anyway. That split is the finding.
- **Blocking prefers a trade to a block that loses nothing.** All three blocking
  gaps are the same shape: `greedyBlocks` looks for the kill, so a 2/1 is thrown
  in front of a 3/2 that a 2/5 would have eaten and survived. `aggressive`
  additionally declines to block at all while its own Health is not in danger.
- **Sequencing is scored one play at a time.** Nothing prices a play for what it
  makes the _next_ play worth, so the Bastion Armory lands after the Guardian it
  was meant to arm. The Goblin War Drum happens to land first, but because a
  Relic outranks a 1-cost spell rather than because anything read the trigger.
- **An additional sacrifice cost outweighs what it buys.** `costsValue` prices
  the body given up and nothing prices the Thralls that replaced it, so the
  Grave deck's own draw engine is never cast after its own converter.
- **Nothing prices holding Energy for a window that has not opened.**
  `unspentEnergyPenalty` is unconditional, so a held counter is always spent on a
  body. This is the clearest single reason a Reaction deck cannot be judged by
  this build's pilots, and it is `control` evidence — which M05.4 already
  declines for every run this software can produce.

All six are recorded rather than fixed. Fixing them is pilot-quality work; this
tranche is the instrument that says which of them are worth fixing, and the
suite fails the moment any of them silently changes.

### Why the standing is derived rather than configured

The milestone says "label results as calibration **until human sanity checks
agree**". Modelling the human check as a field an operator sets would have made
the label a promise rather than a reading. It is instead the `final_balance`
claim from M05.4's registry, which only `human_playtest` carries and which no
pilot in this build belongs to — so a person's agreement enters the system the
same way any other evidence does, by flying the run, and not by editing JSON.
Every batch this software can produce is therefore calibration, and says so in
its first section with the reason and with what would have to change.

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
