# M02 — Remaining Wave 1 card mechanics

## Objective

Move `precon_wave_1` from 142/155 executable cards to 155/155 without parsing
display text or approximating unsupported behavior.

Every tranche must ship the full mechanic contract: schema/versioning, engine,
legal actions and serializable choices, protocol/redaction, UI, help/glossary,
pilot scoring, telemetry/provenance, replay/mechanics hashing, authoring
templates, and focused tests.

Do one tranche per instruction and stop.

## M02.1 — Delayed end-of-turn effects — **done (2026-08-11)**

Cards: `fading_wisp`, `marked_for_death`.

Implement a general serializable delayed-effect representation tied to an
explicit turn boundary, source, controller, targets, and provenance. Define
what happens if source/target leaves play from the printed card semantics; do
not key behavior to card IDs. Pin multiplayer turn ownership and replay behavior.

### What shipped

- [x] **Authoring form.** A card carries `delayedAbilities` (boundary, optional
      `trigger`, optional `subject`, optional `condition`, `effects`) and sets one
      up with a `schedule_delayed` instruction naming it by ID. The reference
      keeps `EffectDefinition` flat and non-recursive; a delayed body may not
      schedule another or `counter`, so delay is one level deep. A dangling
      reference, an unscheduled entry, a duplicate ID, a watch with no subject and
      a `previous_target` at index 0 are all schema errors.
- [x] **Engine.** `packages/rules-engine/src/delayed.ts` owns the whole
      lifecycle. Entries live in `MatchState.delayedEffects`, are advanced from
      `settle` beside trigger discovery, and fire at the transition into
      `turn_end` — before `performTurnEnd`, which would already have handed the
      turn on.
- [x] **Subject binding.** Resolved once, at scheduling time, to a concrete
      instance: `source`, or `previous_target`, which reads the entity targets the
      preceding instruction resolved with (filed in `ResolutionItem.selections`
      under a `<index>:targets` key, so it survives a pause and a JSON round trip).
      `marked_for_death` therefore asks the player to choose exactly once.
- [x] **Leaving play.** An entry records the zone its subject occupied when it
      was scheduled and is discarded the moment the subject is somewhere else —
      the same principle that makes `moveToZone` shed a permanent's modifiers.
      Firing beats pruning within one settle pass, which is what lets a defeat
      satisfy a watch even though the defeat is itself the zone change.
- [x] **Turn ownership.** An entry is stamped with `createdOnTurn` and its
      boundary is `end_of_turn`, so nothing survives into a turn belonging to
      another seat. A controller who is eliminated takes their delayed effects
      with them (CLAUDE.md §12 step 3).
- [x] **Contract surfaces.** `delayed_effect_scheduled` / `_fired` / `_expired`
      events; a public `delayedEffects` list on `PlayerView`; web-client log
      lines; spectator and simulator telemetry count a delayed fire as that card's
      ability resolving; pilot valuation prices a delayed body at a discount;
      `CARD_FIELD_KINDS.delayedAbilities` is `mechanics`, so the change moves every
      card-pool and environment hash; help renderer, effect registry, glossary
      entry, rulebook subsection, `docs/ADDING_CARDS.md` §3a and
      `template_delayed_spell.json`.

### Rules interpretations recorded here

- A delayed effect stops watching its subject as soon as the subject leaves the
  zone it was named in. `fading_wisp` reanimated before the turn ends is _not_
  bounced; `marked_for_death` on a Unit returned to hand creates no Tokens.
- A watch that reaches its boundary unfired simply ends. "When it is defeated
  **this turn**" is a window, and the window closes.
- Delayed effects queued at the `turn_end` transition go on the queue **ahead of**
  the `on_turn_end` abilities discovered from that same transition: the promise
  was made earlier in the turn. Deterministic and documented, not accidental.

### Verification

`npm run verify` (2026-08-11): 68 test files, 1074 tests, build clean. New
focused suites: `packages/rules-engine/src/delayed.test.ts` (11) and
`packages/card-data/src/delayed.test.ts` (11), plus two delayed cases in
`packages/help-content/src/explain/explain.test.ts`. `precon_wave_1` is now
144/155 executable; the remaining 11 are M02.2–M02.5.

## M02.2 — Zone transitions — **done (2026-08-11)**

Cards: `corpse_stitcher`, `grave_reassembly`.

Required primitives:

- remove a card/unit from the game through the existing `removed` zone contract;
- move an eligible card from discard directly to the battlefield as a new
  instance;
- battlefield entry gains Newly Deployed and fires `entersBattlefield`, not
  `deployed`, unless the card explicitly says otherwise.

Review these two cards individually. Do not generalize the trigger choice to the
catalog.

### What shipped

- [x] **Authoring form.** Both transitions are the existing `move_card`
      instruction with a `toZone`; the card being moved is an ordinary entity
      target read from the zone it is currently in, so `selector.zone: "discard"`
      is the whole of "a Unit card in your discard pile". One field is new:
      `entersExhausted`, the "… to the battlefield **Exhausted**" clause. It is a
      schema error anywhere but a battlefield arrival, because readiness does not
      exist in any other zone.
- [x] **Engine.** `moveToZone` gained one option and one guarantee: a permanent
      arriving on the battlefield has its readiness set as part of the arrival —
      Ready unless the effect says Exhausted — so it no longer depends on which
      zone the card came from, and nothing can observe a unit Ready that the card
      says arrived Exhausted. Everything else the two cards need was already
      there: `removed` is a list zone, `detach` handles a discard pile, and an
      arrival from a non-battlefield zone already cleared marked damage,
      modifiers and a spent Barrier, set Newly Deployed, and emitted
      `unit_entered_battlefield` with method `effect`.
- [x] **`corpse_stitcher`.** `Pay 1 Energy, Exhaust` (`usageLimit: unlimited` —
      the Exhaust _is_ the limit, as on `ritual_butcher`), then a mandatory
      `move_card` to `removed` filtered to Units in the controller's own discard
      pile, then two `thrall_token`s.
- [x] **`grave_reassembly`.** One `move_card` to `battlefield` with
      `entersExhausted: true`, `count: 2`, `optional: true` ("up to two") and a
      `cost: { max: 3 }` filter over the controller's discard pile.
- [x] **Contract surfaces.** `removedCount` on every `PlayerViewSummary` and a
      `removed N` stat in the web client; log lines that say "is removed from the
      game" and "returns to the battlefield from …" instead of naming a zone;
      help renderer, effect registry, `Removed from the game` glossary entry and
      a "Where cards go" rulebook subsection; pilot valuation prices a revival
      above a draw, prices removing an opponent's card as denial and our own as a
      small cost, and refuses to pay for a revival into an empty discard pile;
      `docs/ADDING_CARDS.md` §3b and `template_reanimation_spell.json`. Telemetry
      needed no change — the collector already tracks zones from `card_moved` and
      already counts a card that ends in `removed`.

### Rules interpretations recorded here

- "As a new instance" is read as a **fresh permanent**, not a fresh identity. The
  card keeps its match-local instance ID — which is what per-copy telemetry,
  replay and the glossary's "one physical copy of a card" all mean by a card —
  and arrives with no marked damage, no modifiers, no spent Barrier, Newly
  Deployed, and readiness decided by the effect. Minting a second ID for the same
  physical card would break the copy-level tracking without changing a single
  rule outcome.
- The removal on `corpse_stitcher` is an **instruction, not a cost**: its two
  sentences are two instructions, so an empty discard pile fizzles the removal
  and the Thralls are still created. This is the engine's documented behaviour
  for instruction lists, applied rather than invented.
- Removal is terminal in the view as well as in the rules: seats are told **how
  many** cards a player has had removed and never which, because nothing may
  target the zone and a future card that removed from a hand or a deck would
  otherwise leak through the same field.
- `entersExhausted` is a **card-local arrival flag**, not the replacement layer
  M02.4 needs. "Units your opponents deploy enter Exhausted" is a different
  mechanism — it rewrites somebody else's arrival — and must not be built on this
  field.

### Verification

`npm run verify` (2026-08-11): 70 test files, 1091 tests, lint, formatting,
content check and build clean. New focused suites:
`packages/rules-engine/src/zone-transitions.test.ts` (10) and
`packages/card-data/src/zone-transitions.test.ts` (6), plus a zone-transition
case in `packages/help-content/src/explain/explain.test.ts`. `precon_wave_1` is
now 146/155 executable; every precon still contains at least one of the remaining
9, so none is legal yet.

## M02.3 — Derived values and costs — **done (2026-08-11)**

Cards: `bastion_commander`, `stitched_abomination`.

Required primitives:

- derive an effect value from the chosen target's current/derived statline at
  the correct resolution point;
- calculate a hand-card cost reduction from current board state with the existing
  floor rules, without storing a stale discounted cost on the card.

Tests must cover target changes before resolution, continuous stat modifiers,
board changes, minimum cost, affordability/legal actions, and pilot valuation.

### What shipped

- [x] **Authoring form — a value.** `ValueExpression` and
      `SignedValueExpression` gained a third member beside the printed number and
      the count: `{ kind: "stat", of, stat }`. `of` names whose statline —
      `effect_target` (the default, and the "it" every card prints), `source`, or
      `trigger_subject` — and `stat` is `attack` or `health`. Deliberately no
      `per`: dividing a statline is a rounding rule nobody has written. Remaining
      Health is deliberately absent for the same reason. An `effect_target` on an
      instruction with **no** target, or on one aimed at a player, is a schema
      error rather than a value that silently resolves to zero.
- [x] **Authoring form — a cost.** A new `cost_reduction` static-ability effect,
      carrying a `ValueExpression` amount and the printed `minimum` floor, plus
      one new field on `ContinuousScope`: `onlySource`, the whole of "**this**
      card". It is pinned by the schema to `controller: "self"` and
      `zone: "hand"` — a play cost only exists for a card its holder might play —
      and setting `onlySource` beside `excludeSource` is rejected as the
      contradiction it is.
- [x] **Engine — values.** `CountScope` gained `targetInstanceId`, and the three
      instructions that loop over recipients (`deal_damage`, `heal`,
      `modify_stats`, plus `prevent_damage`) now evaluate their amount **once per
      recipient** inside that loop. `modify_stats` reads each number once and uses
      it for both the modifier and the event, so the log can never report a
      different number from the one applied. A statline is read through
      `currentAttack`/`currentHealth`, so it includes every applied modifier and
      the continuous layer.
- [x] **Engine — costs.** New `packages/rules-engine/src/costs.ts`. `playCostOf`
      is the single answer to "what does playing this card cost right now", and
      every caller was moved onto it: the play path, `legalActions`,
      `reactionCostOf`, the simulator's telemetry, and the player view. Reductions
      from several sources add — the only composition that does not depend on the
      order sources are scanned in — and the strictest printed floor wins.
- [x] **A read-only context.** `ReadContext` (`database`, `config`, `state`) is
      the new parameter type for the value evaluator, the condition evaluator and
      the cost path; `MatchContext` extends it. A caller that only wants to know
      what a card costs — telemetry, a view — no longer has to clone a whole match
      into a mutable action context to ask.
- [x] **`bastion_commander`.** An `on_block` ability, `scope.controller: "self"`,
      `limit: "each_turn"`, `activeZone: "battlefield"`, applying
      `+0/+{its ATK}` with `duration: "end_of_combat"`.
- [x] **`stitched_abomination`.** One `cost_reduction` static ability,
      `activeZone: "hand"`, `affects.onlySource`, scaling on
      `units_defeated_this_turn` for the controller, `minimum: 3`.
- [x] **Contract surfaces.** `energyCost` on `CardInstanceView`, populated only
      for the viewer's own hand and `null` everywhere else, and read by the web
      client's hand — so a discount is visible **before** the card becomes
      affordable, which is the only moment it can be seen at all. Help: a
      `describeValue` form for the stat variant, a dedicated `describeStatic`
      sentence for a cost reduction, `describeScaling` so the sentence reads "1
      less for each …" rather than "the number of … less", and a sign fix in
      `statChange` that also corrected a pre-existing bug wording a `-1`-signed
      count as a buff. Glossary: `Cost reduction` and `Derived value`. Rulebook: a
      "Costs that change" subsection under Energy. Pilot: `estimateValue` prices a
      stat expression at an assumed statline instead of crashing, and
      `staticAbilitiesValue` replaces `staticAbilities.length × buffValue × 2` —
      a Reaction discount and a cost reduction are priced in energy, and neither
      counts toward a unit already on the battlefield. `docs/ADDING_CARDS.md` §3c,
      `template_derived_value_spell.json` and `template_scaling_cost_unit.json`.
      The display-text linter maps `cost_reduction` to `modify_cost` so "costs 1
      less" is not reported as drift.
- [x] **Hashing.** Both cards' `abilities`/`staticAbilities`/`implemented` are
      `mechanics` fields, so every card-pool and environment hash moves — as it
      must. `onlySource` is `.optional()` rather than `.default(false)`, matching
      `entersExhausted` and `groupByTokenDefinition`, so no existing card's
      serialized scope gains a field it does not use.

### Rules interpretations recorded here

- **"It" is read per recipient, at resolution.** A stat value is not evaluated
  once for the instruction: an instruction acting on three units reads three
  statlines. And it is read when the instruction resolves, not when the target was
  chosen — a unit buffed while a choice was pending is measured as it is when the
  damage lands.
- **"Friendly Unit" includes a deployed Commander.** `bastion_commander`'s scope
  carries no `cardTypes` filter, because a deployed Commander behaves as a Unit
  (CLAUDE.md) and only units and Commanders ever block. Filtering to
  `cardTypes: ["unit"]` would have quietly excluded the Commander itself.
- **The Bastion bonus does not outlive the combat, and that has teeth.** "For
  that combat" is `end_of_combat`, and marked damage is not cleared until end of
  turn — so a blocker that takes damage equal to or above its **printed** Health
  survives the damage step and is then defeated when the bonus expires. That is
  the documented behaviour of every combat-length Health bonus (see
  `durations.test.ts`), not something this card does specially. Where the bonus
  is worth the most is Overwhelm: the split is measured against the blocker's
  current Health, so a bigger blocker keeps more damage off its controller. This
  is a **balance** observation about a card whose text is fixed, and M02 excludes
  balance changes; it is recorded rather than acted on.
- **A cost floor never raises a price.** `minimum: 3` on a card printed at 2
  leaves it at 2. The floor is clamped against the printed cost, exactly as
  `energyCostOf` clamps one, and a reduction that prints **no** floor really can
  take a card to zero — which is what `costReductionFloor`'s "when the reducing
  effect prints one" has always meant.
- **The reduction is instruction-free.** A `cost_reduction` contributes nothing
  to the continuous layer and nothing to `player.costModifiers`. It is read at the
  moment a cost is computed, like the Reaction discount beside it, because a
  stamped delta would be stale the instant a unit died and would have to be
  invalidated from four places.
- **Two reductions compose in a pinned order.** A derived `cost_reduction` is
  applied first and the per-turn Reaction discount second, each respecting its own
  printed floor. No authored card carries both, so the order is currently
  unobservable; it is fixed in `reactionCostOf` rather than left to whichever call
  site ran first.
- **A cost is never shown for another seat's card.** `CardInstanceView.energyCost`
  is `null` for everything but the viewer's own hand: a cost on an opponent's card
  would be meaningless and, for a card in their hand, a leak.

### Verification

`npm run verify` (2026-08-11): 72 test files, 1132 tests, lint, formatting,
content check and build clean. New focused suites:
`packages/rules-engine/src/derived-values.test.ts` (22) and
`packages/card-data/src/derived-values.test.ts` (13), plus two explanation cases
in `packages/help-content/src/explain/explain.test.ts` and four pilot-valuation
cases in `packages/bot-interface/src/contract.test.ts`.

`precon_wave_1` is now **148/155** executable, and
**`precon_bastion_guardians` is the first legal precon**: its forty cards were
already implemented and `bastion_commander` was the only thing holding it back.
Three M01.2 regression tests that used it as the canonical _unfinished_ Commander
were rewritten to assert the newly true fact rather than relaxed — the refusal
paths they covered are still covered by the three precons that do still hold
unfinished cards, and by `validate.test.ts`'s synthetic database. The remaining 7
cards are M02.4 (5) and M02.5 (2).

## M02.4 — Replacement effects — **done (2026-08-12)**

Cards: `containment_array`, `goblin_warhorn_captain`, `stasis_keeper`,
`stasis_seal`, `temporal_anchor`.

Implement a bounded, deterministic replacement/prevention layer for the exact
arrival/readiness events these cards require. It must:

- be structured and source-scoped;
- define ordering when several replacements apply;
- avoid recursive replacement loops;
- retain attribution to the replacing source;
- work identically in headless, online, replay, and spectator paths;
- never be inferred from final state.

If ordering changes gameplay and no existing rule decides it, stop with the
smallest concrete ordering question.

### What shipped

- [x] **Two replaceable moments, and only two.** An arrival on a battlefield and
      a permanent readying at its controller's Ready Step. Nothing else in the
      ruleset is replaceable, and the schema says so: a `replace_arrival` or a
      `replace_ready` scoped anywhere but `zone: "battlefield"` is an authoring
      error, because an arrival and a Ready Step do not happen anywhere else.
- [x] **Authoring form — the standing half.** Two new static-ability effects.
      `replace_arrival` carries `on` (`deployed` | `entered_battlefield`),
      `onlyOnControllerTurn`, a `limit`, and the rewrite itself —
      `entersExhausted`, `grantKeyword`, `grantDuration`. At least one rewrite
      must be set; a replacement that changes nothing is rejected rather than
      accepted as a no-op, and `affects.onlySource` is rejected because a card's
      static abilities only switch on once its own arrival is already over.
      `replace_ready` carries an `energyCost` and a `limit`, and nothing else:
      the only thing it can do is stop a readying.
- [x] **Authoring form — the fixed half.** A `skip_next_ready` instruction and a
      `blocked_by_source` target kind, the one set nobody chooses. The skip rides
      on the permanent, not on the card that applied it.
- [x] **Engine.** `packages/rules-engine/src/replacement.ts` owns the layer.
      `applyArrivalReplacements` is called from `moveToZone` and from token
      creation, always _before_ the arrival is announced, so the rewrite is part
      of the arrival. `runReadyStep` in `flow.ts` is the Ready Step in three
      fixed stages — stored skips, then standing replacements, then readying —
      and is the one part of turn start that can pause for a choice.
- [x] **Ordering.** `replacementOrder` reuses the engine's existing trigger order
      (CLAUDE.md §12): active seat first, then clockwise, then instance creation
      order, then ability index. Deliberately not the continuous layer's plain
      ordinal order — that layer is a commutative sum where order is
      unobservable, and this one is a sequence of decisions where a
      `first_each_turn` limit makes it observable.
- [x] **No recursion.** A replacement may only set flags on the object the event
      is about; it cannot emit a replaceable event. The layer therefore cannot
      re-enter itself and there is no loop bound to tune. The Ready Step's offer
      loop is bounded by the number of sources on the board — every pass either
      records a source in `askedSourceIds` and never revisits it, or ends.
- [x] **Attribution.** Three events: `arrival_replaced`, `ready_prevented` and
      `ready_skip_applied`, each naming the source instance, its definition and
      the ability ID. `ready_prevented` covers both halves, with `abilityId` null
      for the stored-skip half — one event, because what a player needs to know
      is identical.
- [x] **Contract surfaces.** `willNotReady` on `UnitView` and the web client's
      board; log lines for all three events; a `keep_exhausted` choice reason and
      a `ready_step_replacement` continuation, both serialized in match state and
      re-derived on resume, so the pause survives a reconnect and a replay;
      help renderer, effect registry, `Replacement effect` glossary entry and a
      rulebook subsection under the Ready Step; pilot valuation prices an arrival
      rewrite as tempo denial or a buff and a paid ready replacement net of its
      Energy; `docs/ADDING_CARDS.md` §3d and `template_replacement_relic.json`.
- [x] **Telemetry.** A static ability rewriting an event reaches no queue, so it
      emits no `trigger_queued` and, after the turn it landed, no play or
      activation of its own. Both collectors now count `arrival_replaced` and the
      standing half of `ready_prevented` against the _replacing_ source, so a
      Relic whose entire text is a replacement does not report zero of everything
      and read to balance work as a card nobody used.
- [x] **Hashing.** `abilities`, `staticAbilities` and `implemented` are all
      `mechanics` fields, so all five cards move every card-pool and environment
      hash. Every new schema field is `.optional()` or `.default()`, so no
      existing card's serialized form gains a field it does not use.

### Rules interpretations recorded here

- **A replacement is not a trigger, and the difference is visible.** The rewrite
  happens as the event happens: nothing observes the un-rewritten state, no
  Reaction window opens between the two, and removing the source after the fact
  does not undo it. A unit that `containment_array` catches is Exhausted rather
  than merely Newly Deployed, so Rush does not help it — Rush answers Newly
  Deployed, and this is a different restriction.
- **Creating a Token is deploying one.** `on: "deployed"` covers a Token an
  opponent creates, matching what the trigger layer already says, so
  `containment_array` catches the first enemy Token of the turn.
- **A `first_each_turn` limit is per copy, across the whole table.** Recorded on
  the instance, like a triggered ability's `each_turn` limit. At four seats the
  first enemy deployment of the turn spends it, whichever seat made it.
- **Stored skips are consumed before standing replacements are offered.** This is
  a gameplay decision, not an implementation detail: a permanent already held
  down for free is not offered to a replacement that would charge for the same
  outcome, so nobody is ever asked to pay for a no-op.
- **A stored skip is used up by one Ready Step whether or not it stopped
  anything.** "It does not Ready during its controller's next Ready Step" names
  one specific Ready Step. A unit readied by an effect in the meantime has
  already had its reprieve, and the skip is spent at that Ready Step regardless.
- **A skip is shed with the permanent, not with the card that applied it.**
  `stasis_seal` going to a discard pile and `stasis_keeper` dying in the combat
  it blocked both leave the lock in place; the attacker leaving the battlefield
  removes it, along with everything else it was carrying.
- **A `replace_ready` offer is rebuilt from the board on resume, never trusted
  from the pending choice.** A paused match may have been serialized, stored and
  reloaded; an answer that no longer validates simply does not apply and the
  permanent readies.
- **A controller who cannot pay is not asked.** A prompt whose only legal answer
  is "no" decides nothing. The same rule keeps a permanent an earlier free
  prevention already holds down out of the offer entirely.
- **Attribution counts the replacer, once.** A `ready_prevented` with a null
  `abilityId` came from a stored `skip_next_ready`, and the instruction that
  armed it was already counted where it resolved — as a Spell played or a trigger
  queued. Counting the payoff too would bill one card twice for one decision, so
  telemetry counts only the standing `replace_ready` half.

### Verification

`npm run verify` (2026-08-12): 75 test files, 1175 tests, lint, formatting,
content check and build clean. Focused suites:
`packages/rules-engine/src/replacement.test.ts` (19),
`packages/card-data/src/replacement.test.ts` (12) and
`apps/simulator/src/telemetry-replacement.test.ts` (3), plus three replacement
explanations in `packages/help-content/src/explain/explain.test.ts`, four
pilot-valuation cases in `packages/bot-interface/src/contract.test.ts` and a
precon-legality case in `packages/deck/src/precon.test.ts`.

`precon_wave_1` is now **153/155** executable, and **three of the four precons
are legal**: `precon_bastion_guardians` (M02.3), plus `precon_containment_control`
and `precon_goblin_swarm`, which the five replacement cards were the last thing
holding back. Only `precon_grave_sacrifice` still needs the developer override,
for `equal_price` and `mass_offering` in M02.5 — which is why the four-seat
spectator suite still runs with it.

The spectator's per-turn replacement count is the same two-line rule as the
simulator's and is exercised by the full four-bot replay suites; the focused
attribution coverage lives in the simulator collector test rather than being
duplicated against a synthetic spectator match.

## M02.5 — Multiplayer and distributed choices — **done (2026-08-12)**

Cards: `equal_price`, `mass_offering`.

Required primitives:

- serializable "each player chooses" collection with fixed seat-order policy,
  hidden-information safety, elimination handling, and deterministic resolution;
- divide a fixed damage amount among legal targets, validating non-negative
  integer allocations whose sum equals the required total.

Do not fake simultaneous choices by resolving visible choices one at a time if
later players could gain information the card does not grant.

### What shipped

- [x] **Authoring form — an each-player choice.** No new effect type and no new
      target kind: a **plural `chooser`** on an ordinary `TargetSelector`
      (`all_players` or `each_opponent`) turns one selection into a distributed
      one. Two things change and nothing else does — `controller` is read
      relative to the seat being asked, which is the whole of "a Unit **they**
      control", and every answer is collected before any is applied. With the
      default `self` chooser the seat being asked _is_ the ability's controller,
      so every card authored before this means exactly what it always meant. A
      plural chooser beside a `random` or `automatic` selection is a schema
      error: nobody is asked, so there is nothing to distribute.
- [x] **Authoring form — a divided total.** One new field, `divided`, on
      `deal_damage`. It flips what `amount` means: a total the chooser splits
      rather than an amount each recipient takes. Because the allocation decides
      _which_ targets are hit, the selector under it must be the pool it draws
      from — `count: "all"` and `selection: "player_choice"` are schema-required,
      a plural chooser is rejected (one player allocates), and an
      `effect_target` statline amount is rejected because the total is read
      before anything is targeted.
- [x] **Authoring form — the amount.** A third `ValueExpression` member,
      `{ kind: "previous_targets" }`: however many entities the instruction
      immediately before it resolved with. The value-side twin of the
      `previous_target` target kind, reading the same `<index>:targets` record,
      so the two halves of "sacrifice up to five Units … for each Unit
      sacrificed" cannot disagree. A schema error on the first instruction of a
      list, exactly like an "if you do" condition.
- [x] **Engine — collection.** `resolveDistributed` in `effects.ts` asks each
      seat in the selector's own order, files each answer under its own
      `<index>:by:<playerId>` key, and only returns targets once the last seat
      has replied. A seat with no legal option is never asked; a seat eliminated
      mid-collection drops out of the selector and takes its answer with it; a
      stored answer is re-validated against the current legal set like every
      other selection. `resolveEffectPlayers` gained a key namespace so a
      chooser selector and an instruction's own `player` selector cannot collide.
- [x] **Engine — allocation.** `divideDamage` raises a `divide_damage` choice
      whose answer is a **multiset**: one entry per point, so `[a, a, b]` is two
      damage to `a` and one to `b`. The uniqueness check in `handleSubmitChoice`
      is skipped for this one type and nothing else about validation changes —
      every entry must be a legal target and the list must be exactly as long as
      the total, which is the same claim as "non-negative integers summing to N".
      Targets are damaged in board order, once each, for their whole share.
- [x] **Contract surfaces.** New choice type `divide_damage` and reasons
      `each_player_choice` / `divide_damage`; `enumerateActions` emits a valid
      allocation rather than a short slice; the web client renders an allocation
      as click-to-add-a-point with a `×N` badge, a "left to place" counter and a
      Start over button; pilots get a dedicated `divide_damage` enumerator with
      three plans (concentrate, spread, finish off) because the generic one
      builds sets of distinct options; help renderer, `Each player chooses` and
      `Divided damage` glossary entries, two rulebook subsections,
      `docs/ADDING_CARDS.md` §3e, `template_shared_choice_spell.json` and
      `template_divided_damage_spell.json`.
- [x] **Hidden information.** Nothing new was needed and that is the finding:
      `choice_resolved` already redacts `selectedIds` for everyone but the
      chooser, and `PlayerView` already exposes only the viewer's own pending
      choice. What makes the collection safe is that **nothing is applied until
      the last answer is in** — a later seat sees exactly the board the first
      seat saw.
- [x] **Pilot valuation.** `estimateValue` prices a `previous_targets` amount at
      the same middling assumption every other unknown count takes; a `divided`
      total is priced **once** rather than multiplied by the size of the target
      set; and a distributed `sacrifice` is priced as the symmetrical effect it
      is rather than as a pure self-cost, which would have mulliganed Equal Price
      away.
- [x] **Telemetry.** No change needed. Both cards are ordinary Spells that are
      played and resolve, and both collectors already count a played card, a
      sacrifice and a damage event attributed to its source.

### Rules interpretations recorded here

- **"Unit" includes a Token on both cards.** The catalog was inconsistent —
  `mob_justice` and `phase_withdrawal` say `["unit", "token"]`, the older
  sacrifice filters on `ritual_butcher` and `feed_the_pit` say `["unit"]` — and
  the rulebook's own definition settles it: "Token — a unit created by an
  effect". Owner-confirmed for these two cards. The existing `["unit"]`-only
  filters were left alone: re-reading thirty-eight cards is a balance change,
  which M02 excludes.
- **Collect, then apply — and the order is the same both times.** `all_players`
  is the controller then clockwise, which fixes both who is asked first and the
  order the collected targets are acted on. Resolving one at a time would hand
  every seat after the first information the card never granted them, which is
  the failure M02.5 names explicitly.
- **`controller` is relative to whoever is choosing.** Not a special case for
  distributed selectors: it is the general reading, and it happens to be
  identical to the old one for every single-chooser selector because the chooser
  _is_ the controller there.
- **A seat with nothing to offer is skipped, not fizzled.** The instruction does
  not fail because one player has an empty board; it simply has no share for
  that seat. The same principle as an `each_opponent` discard against an empty
  hand.
- **A divided share is one hit, not N hits of one.** Two points allocated to a
  unit is a single two-damage event. Splitting it further would let a Barrier
  absorb the same allocation twice, and would report a combat log nobody could
  read.
- **An allocation is answered in board order, whatever order it was clicked in.**
  `[a, a, b]` and `[a, b, a]` describe the same allocation and produce the same
  match, event for event.
- **A total of zero does nothing, and that is a legal outcome.** "Sacrifice up
  to five Units" that took none leaves nothing to divide; the Spell finishes
  without asking for an allocation.

### Verification

`npm run verify` (2026-08-12): 77 test files, 1225 tests, lint, formatting,
content check and build clean. New focused suites:
`packages/rules-engine/src/shared-choices.test.ts` (17) and
`packages/card-data/src/shared-choices.test.ts` (16), plus two explanations in
`packages/help-content/src/explain/explain.test.ts` and four pilot-valuation
cases in `packages/bot-interface/src/contract.test.ts`.

`precon_wave_1` is **155/155** executable and **all four precons are legal**, so
the AI spectator, the multiplayer server and the deck builder all take every
shipped deck with no developer override. Eight tests that used
`precon_grave_sacrifice` as the canonical _unfinished_ deck were rewritten to
assert the newly true fact rather than relaxed, and the refusal machinery they
covered was moved to where it can still be exercised: a synthetic unfinished
**card** in `packages/deck/src/validate.test.ts` (the Commander case was already
synthetic), a doctored pool in `packages/spectator/src/spectator.test.ts` and in
`apps/multiplayer-server/src/format-pool.test.ts`, and a direct
`SpectatorSummary` render for the "results invalid" wording in
`apps/web-client/src/spectator-flow.test.tsx`.

One coverage gap is recorded rather than papered over: the web client's
`divide_damage` allocation panel has no automated test, because no web-client
test drives the pending-choice panel at all today and building that harness is
outside this tranche. The choice contract it renders is covered engine-side.

## M02.6 — Catalog closure — **done (2026-08-12)**

After all five tranches:

- regenerate content and confirm 155/155 are implemented;
- remove obsolete `unsupportedReason` fields;
- establish at least one executable happy-path behavior contract for every one
  of the 155 cards, preferably through a table-driven scenario registry that
  fails when a newly implemented card has no case;
- add a per-card check that structured behavior and player-facing text describe
  the same mechanics; do not skip implemented cards merely because their prose
  is curated rather than generated;
- run `report:triggers` and perform the outstanding card-by-card
  `deployed`/`entersBattlefield` review without bulk conversion;
- promote `precon_wave_1` from `draft` to `playtest` only when strict validation
  passes;
- run `npm run verify`.

### What shipped

- [x] **155/155, confirmed by a test rather than by a count.** The bundle was
      rebuilt and `display-text.test.ts` now asserts the set holds exactly 155
      cards, that none is `implemented: false`, and that none carries an
      `unsupportedReason`. No card file had one left; the schema field stays,
      because it still has to work for the next card somebody starts and does
      not finish (M01.2).
- [x] **A behaviour contract for every card.**
      `packages/rules-engine/src/card-contracts/` holds one entry per card,
      grouped into the five files the catalogue is already organised by. Each is
      a `claim` — the sentence the card prints — and a short script driven
      through the real engine from a real action. The coverage guard is the
      point: `registry.test.ts` compares the registry's keys against the set and
      fails **by name** when a card has no case, so a newly authored card cannot
      arrive without one.
- [x] **A harness, not 155 bespoke setups.** `ContractTable` opens a two-seat
      match past the mulligan with both seats at the Energy cap, and offers the
      six or seven arrangements every card needs: put this on the board, hand
      that to a seat, play it, activate it, attack, block, pass the turn, answer
      the window. Choices are answered by one documented policy — take the
      offer, take the maximum, decline a cost that would stop a Reaction — which
      a contract can override with `prefer` where the board holds more than one
      legal target and the contract is about a specific one.
- [x] **The drift check now runs in both directions.** `lintDisplayText` already
      reported prose that promised behaviour the card lacked. It now also
      reports behaviour the card performs that the prose never mentions, effect
      by effect and keyword by keyword, against a vocabulary of every word the
      catalogue actually uses. There is no exemption for a card with a curated
      `text` block, and a test asserts that.
- [x] **`precon_wave_1` is `playtest`.** Which is what makes the check above a
      gate rather than advice: the content build turns every card warning into
      an error for a strict-status set. All 155 pass clean. Promoting the set
      surfaced five real drifts in the `prototype_core` fixture set — cards
      carrying Venom, Resilient, Siphon, Rush or Guardian and never saying so —
      which were corrected in `displayText` only, a presentation field, so no
      card-pool or environment hash moved.
- [x] **The entry-trigger review is done and recorded.**
      [`docs/rules/entry-trigger-review.md`](../rules/entry-trigger-review.md)
      judges all 21 uses individually. Sixteen are correct as they stand. Five
      are not, and are **left alone**: see below.

### Rules interpretations recorded here

- **A contract proves one claim, and that is deliberate.** The card's printed
  headline, from a real action, through the real engine. The mechanic suites
  still own the edge cases; a contract that grew a second scenario would be
  duplicating them and would start failing for reasons that are not about the
  card.
- **A `"for that combat"` buff is asserted from its event, not from the
  statline.** By the time `block()` returns, combat is over and the modifier has
  expired — which is the duration working, not the card failing. Five contracts
  read `stats_modified` instead, and say so.
- **Behaviour the prose never mentions is the worse drift.** Prose that
  over-promises disappoints a player; prose that under-reports means the card
  does something nobody reading it could have known about. Both are reported,
  and the second is the half that was missing.
- **A trigger is not something the card performs.** "The first time you
  sacrifice a Unit each turn, draw a card" carries out a draw and no sacrifice,
  so the reverse check never asks a card to narrate the event it waits for. A
  **cost** is included, because "Pay 1 Energy and Exhaust" is printed on the
  card and is as visible as any instruction.
- **Implicit deploy effects run on a play and on a Token, and not on a
  revival.** Established by reading the engine rather than assumed: the
  enqueue happens in the play path and in token creation, and `moveToZone` does
  not do it. This is what makes the five-card finding below real rather than
  theoretical.

### The one thing left open — Q48

Five cards print "When this Unit **enters the battlefield**, …" and are authored
as top-level effects, which is the implicit _deploy_ form: `goblin_bomb_thrower`,
`goblin_lookout`, `goblin_mob_caller`, `goblin_recruiter` and
`goblin_siege_leader`. A `goblin_recruiter` returned by `grave_reassembly`
therefore creates no Goblin Token, which is not what the card says. Verified
against the engine.

Both fixes are one line and they are not equivalent — correcting the prose
changes nothing about the game, converting the structure hands the Goblin deck a
revival payoff it does not have today, which is a gameplay change M02 excludes.
Choosing silently would be inventing a design decision, so the five are
unchanged and the question is recorded as **Q48**. The fifteen cards that print
"When deployed" and use the same form are correct and are not part of it;
nothing was converted in bulk.

### Verification

`npm run verify` (2026-08-12): 79 test files, 1547 tests, lint, formatting,
content check, content validation and build clean. New focused suites:
`packages/rules-engine/src/card-contracts/registry.test.ts` (158 — 155 card
contracts plus three coverage guards) and
`packages/card-data/src/display-text.test.ts` (164 — 155 per-card drift checks
plus nine directed cases).

`precon_wave_1` is **155/155 executable, `playtest` status, and clean under
strict validation**.

## Acceptance

- No Wave 1 card or Commander is marked incomplete.
- All four precons pass normal deck validation.
- Spectator matches no longer need an incomplete-content override.
- Each new primitive has deterministic engine, UI, help, pilot, telemetry, and
  replay coverage.

## Exclusions

- `resilient`, unless a Wave 1 card genuinely requires it. Q4 remains an owner
  decision.
- Reaction additional costs. No authored card needs them; Q46 remains open.
- Balance changes to costs/stats/text.
