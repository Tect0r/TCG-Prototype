# Adding and changing cards

Adding an ordinary card is data work. Copy a template, give it an ID, fill in
its fields, optionally drop in a PNG, and run one command. No component, route,
switch statement, card list or stylesheet needs editing.

This guide covers what you can do with data alone, and — just as importantly —
how to tell when you cannot.

## The short version

1. Scaffold the file:
   `npm run cards:new -- --set <setId> --type <type> --id <card_id>`.
   It copies the right template from [`templates/cards/`](templates/cards) into
   `content/sets/<setId>/cards/<card_id>.json` (or `tokens/` for a token), and
   refuses to overwrite an existing card.
2. Fill in its name, cost, colours, stats and structured `effects`.
   Do **not** add a `schemaVersion` — the set's `set.json` owns it.
3. Optionally drop `assets/card-art/<your_card_id>.png` into place.
4. Run `npm run content:build` to regenerate the shipped bundle, and commit it.
5. Run `npm run validate:content`, then `npm test`.

One card per file. The filename and the permanent card ID must agree — the
content build enforces it, and every validation error names the file it came
from.

## 1. Choosing an ID

```text
lowercase_english_snake_case
```

Lowercase ASCII letters, digits and underscores; it must start with a letter.
No spaces, hyphens, punctuation or localised words.

**An ID is permanent.** Decks, replays, simulator results and artwork filenames
all reference it. Renaming one breaks saved decks; renaming the card's `name`
breaks nothing at all. If you dislike a card's name, change `name`.

## 2. Choosing a type

| Type        | Where it lives                  | Notes                                                                  |
| ----------- | ------------------------------- | ---------------------------------------------------------------------- |
| `unit`      | The battlefield                 | Needs `attack` and `health`. Attacks and blocks. No limit on how many. |
| `spell`     | Resolves, then the discard pile | Must have at least one effect. No triggered or static abilities.       |
| `relic`     | The relic row                   | Persists. Playing a second one replaces the first.                     |
| `commander` | The Command Zone                | Needs `cost`, `attack` and `health`. Deploys onto the battlefield.     |
| `token`     | Created by an effect            | `cost` must be `null`, and `collectible` must be `false`.              |

The schema enforces all of this. A unit without stats, a token with a cost, or a
spell with a triggered ability fails validation with the exact field named.

## 3. Composing effects

Behaviour is structured data. **Never write behaviour in prose** — `displayText`
is presentation and is never parsed.

There is exactly one authoring form for each kind of behaviour:

- **When it arrives or resolves** → the card's top-level `effects`. This covers
  a spell resolving, a unit or relic deploying, and a token being created.
  There is deliberately no `on_deploy` trigger.
- **When something happens later** → `abilities`, each with one `trigger` from
  `on_attack`, `on_block`, `on_survive_combat`, `on_defeated`, `on_turn_start`,
  `on_turn_end`, `on_sacrifice`.
- **When the player chooses to** → `activatedAbilities`, with a structured
  `costs` array and a `usageLimit`.
- **Continuously, while it is in play** → `staticAbilities`. These are derived
  from the board on every recalculation, never stamped onto their recipients,
  which is why a lord automatically covers units that arrive later.
- **Before the card is even queued** → `additionalCosts`, which is "As an
  additional cost, sacrifice a Unit". See §4a.
- **Later in the same turn** → a `delayedAbilities` entry plus a
  `schedule_delayed` instruction naming it. See §3a.

The supported effect types are listed in
`packages/help-content/src/registries/effects.ts`, with a description of each.
Amounts may be a fixed integer or a `CountQuery` ("for each Goblin you
control").

Every instruction may also carry two gates:

- `condition` — an "if" re-checked when that instruction resolves, not when the
  card was played. A gated instruction that is skipped does not stop the ones
  after it.
- `optional` — "you may". The controller is asked yes/no when the instruction
  resolves; "no" skips that step alone.

## 3a. Effects that happen later in the same turn

"Return it to your hand **at the end of the turn**" and "**when it is defeated
this turn**, create two Tokens" are both delayed effects. They are authored in
two halves, deliberately:

- a `delayedAbilities` entry holds the instructions and says when they happen;
- a `schedule_delayed` instruction, anywhere in the card's `effects` or in a
  triggered ability, names that entry by ID and sets it up.

The split keeps the instruction union flat — nothing has to walk _into_ an
effect to find more effects — and it is why an entry nothing schedules, and a
schedule naming no entry, are both rejected outright.

A delayed entry has four fields:

- `boundary` — the moment it is tied to. `end_of_turn` is the only one, and the
  entry never survives past it.
- `trigger` — optional. Absent, the instructions run **at** the boundary. Present,
  they run when that event happens to the subject **before** the boundary, once;
  a watch that never fires simply ends with the turn.
- `subject` — what the delayed text calls "it". `source` is the card the text is
  printed on; `previous_target` is whatever the instruction immediately before
  the `schedule_delayed` acted on, which is how "Target friendly Unit gains +3
  ATK. When **it** is defeated…" asks the player to choose exactly once. Omit it
  when the delayed instructions name nothing.
- `condition` — an "if" re-checked when the delayed effect fires, not when it
  was scheduled.

Three rules to author against, none of them keyed to a card:

- The subject is bound **once**, when the schedule resolves. It is never
  re-chosen and never re-targeted.
- A subject that moves to a different zone before the promise comes due **ends
  it**. The delayed text was about the card where it was, not about wherever the
  card is now — the same principle that makes a permanent shed its modifiers
  when it leaves play.
- A delayed body may not schedule another delayed ability, and may not
  `counter`. Delay is one level deep, always.

## 3b. Moving a card between zones

Every zone transition a card can print is one `move_card` instruction with a
`toZone`. The target is an ordinary entity target, so the card being moved is
chosen from the zone it is _currently_ in — `selector.zone: "discard"` is what
makes "a Unit card in your discard pile" mean that and not something on the
battlefield.

Two destinations mean more than a change of address, and both are engine
behaviour rather than something the card text arranges:

- **`battlefield`** is a revival. The card arrives as a fresh permanent: no
  marked damage, no modifiers, no spent Barrier. It is Newly Deployed, and it
  fires `entersBattlefield` and **not** `deployed`, because nobody paid its
  deployment cost. Set `entersExhausted: true` for "… to the battlefield
  Exhausted"; it is part of the arrival, so nothing ever sees the card Ready,
  and it is a schema error for any other destination.
- **`removed`** is terminal. Nothing may target the removed zone, no effect
  returns a card from it, and the card is out of the match for good. Use it only
  when the printed card really says "from the game".

"Return **up to** two…" is `count: 2` with `optional: true` on the selector: the
chooser may take fewer, or none, and the card still resolves. Without `optional`
the instruction is mandatory and simply fizzles when the zone holds nothing legal
— and a fizzled instruction does not stop the ones after it, which is what makes
"Remove a Unit card in your discard pile. Create two Tokens." create the Tokens
either way.

## 3c. Numbers the board decides

Two ways an amount can depend on the game rather than on a printed number, and
they answer different questions.

**Counting** is `{ "kind": "count", … }`: "for each Goblin you control", "for
every three Units defeated this turn". `per` divides and rounds down, `plus` adds
a flat base, and `minimum`/`maximum` clamp the result.

**Reading a statline** is `{ "kind": "stat", … }`, and it is the "equal to its
ATK" clause:

```json
{ "kind": "stat", "of": "effect_target", "stat": "attack" }
```

`of` says whose statline. `effect_target` — the default — is the card the
instruction is currently acting on, and it is read **once per recipient**, so
"each friendly Unit gains Health equal to its ATK" reads three statlines for
three units. Use `source` for the card the text is printed on and
`trigger_subject` for the card a triggered ability fired about. An instruction
with no target cannot carry `effect_target`, and neither can one aimed at a
player: both are schema errors rather than a value that quietly resolves to zero.

`stat` is always the **derived** number — printed stats plus every applied
modifier plus the continuous layer — read at the moment the instruction resolves.
A target buffed after the ability was queued is measured as it is then, not as it
was when it was chosen.

**Costs** are the third case, and they are neither an instruction nor an amount
on one. "This card costs 1 less for each friendly Unit defeated this turn, to a
minimum cost of 3" is a static ability:

```json
{
  "id": "scaling_cost",
  "activeZone": "hand",
  "affects": { "zone": "hand", "controller": "self", "onlySource": true },
  "effect": {
    "type": "cost_reduction",
    "amount": {
      "kind": "count",
      "count": { "subject": "units_defeated_this_turn", "controller": "self" }
    },
    "minimum": 3
  }
}
```

Not a `modify_cost` instruction: that stamps a fixed delta onto its controller
for a duration, which would freeze the discount at whatever the board looked like
when it resolved. A `cost_reduction` is derived and recomputed every time a cost
is asked for, so nothing has to be invalidated when the board moves.

`affects.onlySource` is the whole of "**this** card"; without it the reduction
covers every card in hand that matches `affects.filter`. A cost reduction is
always `controller: "self"` and always `zone: "hand"` — a play cost only ever
exists for a card its holder might play — and both are schema errors otherwise.
`minimum` is the printed floor; it is clamped against the printed cost, so it can
never make a card _more_ expensive, and a reduction with no floor really can take
a card to nothing.

## 3d. Rewriting an event instead of reacting to it

A **replacement** changes an event as it happens, so nothing ever observes the
un-rewritten version. "The first enemy Unit deployed each turn enters Exhausted"
does not put the unit onto the battlefield and then exhaust it: the unit arrives
Exhausted, and there is no moment in between for a trigger, a Reaction or a
state-based check to see it Ready.

That distinction is the whole reason to reach for this instead of a trigger. An
`on_deployed` ability that exhausts the unit is a **different card** — it goes on
the queue, it can be answered, and it can be undone by removing the source before
it resolves. Write the replacement only when the printed text really replaces
something.

Exactly two moments are replaceable, and both are on the battlefield:

**An arrival**, through a `replace_arrival` static ability:

```json
{
  "id": "containment_field",
  "activeZone": "battlefield",
  "affects": {
    "zone": "battlefield",
    "controller": "opponent",
    "filter": { "cardTypes": ["unit", "token", "commander"] }
  },
  "effect": {
    "type": "replace_arrival",
    "on": "deployed",
    "limit": "first_each_turn",
    "entersExhausted": true
  }
}
```

`on: "deployed"` covers a card an opponent plays **and** a Token they create,
because creating a Token is how a Token is ever deployed; `on:
"entered_battlefield"` — the default — also covers a revival out of a discard
pile. `onlyOnControllerTurn: true` is "…during your turn". At least one of
`entersExhausted` and `grantKeyword` must be set: a replacement that changes
nothing is an authoring mistake, not a no-op. A granted keyword takes
`grantDuration`, `end_of_turn` by default.

**A permanent readying at its controller's Ready Step**, through a
`replace_ready` static ability:

```json
{
  "id": "temporal_drag",
  "activeZone": "battlefield",
  "affects": { "zone": "battlefield", "controller": "opponent" },
  "effect": { "type": "replace_ready", "energyCost": 1, "limit": "first_each_turn" }
}
```

With an `energyCost` above zero the Ready Step pauses and asks the ability's
controller, once, which permanent to hold down; a controller who cannot pay is
never asked at all. At zero it applies with no prompt, to as many permanents as
its limit allows.

Both are `zone: "battlefield"` — an arrival and a Ready Step do not happen
anywhere else — and both are `first_each_turn` or `unlimited`, counted **per
copy** of the card. A `replace_arrival` cannot be scoped `onlySource`: a card's
static abilities only switch on once it is already in play, so its own arrival is
a moment that has already passed.

The other half of the readiness layer is an ordinary instruction, not a static
ability. `skip_next_ready` fixes "it does not Ready during its controller's next
Ready Step" onto one permanent, in advance:

```json
{ "type": "skip_next_ready", "target": { "kind": "previous_target" } }
```

It rides on the permanent rather than on the card that applied it, so it survives
the Spell going to a discard pile and the Unit that applied it being defeated —
and it is shed with everything else when the permanent leaves the battlefield.
`{ "kind": "blocked_by_source" }` names the attackers the source blocked, which is
the one set nobody chooses.

Stored skips are consumed **before** standing replacements are offered, so nobody
is ever asked to pay for a permanent that was already staying Exhausted. Where
several replacements apply to one event, they are visited in the engine's trigger
order — active seat first, then clockwise, then instance creation order, then
ability index — and every rewrite emits an event naming the card that did it.

## 3e. Choices several players make, and totals they split

Two shapes the catalog needs that a single-chooser selector cannot express.

**"Each player chooses …"** is a plural `chooser` on an ordinary selector:

```json
{
  "type": "sacrifice",
  "target": {
    "kind": "entity",
    "selector": {
      "zone": "battlefield",
      "controller": "self",
      "filter": { "cardTypes": ["unit", "token"] },
      "count": 1,
      "selection": "player_choice",
      "chooser": "all_players"
    }
  }
}
```

`chooser: "all_players"` or `"each_opponent"` turns one selection into a
distributed one. Two things change, and nothing else does:

- **`controller` is read relative to the seat being asked.** `"self"` becomes "a
  Unit **they** control". With the default `chooser: "self"` the seat being asked
  is the ability's controller, so every card written before this existed means
  exactly what it always meant.
- **Every answer is collected before any of them is applied.** Seats are asked in
  the selector's own order — `all_players` is the controller then clockwise — and
  nothing resolves until the last one replies, so no seat is ever deciding
  against a board an earlier seat has already changed. The collected targets are
  then acted on in that same order.

A seat with no legal option is not asked and contributes nothing; a seat
eliminated mid-collection drops out with its answer. A plural chooser beside a
`random` or `automatic` selection is rejected: nobody is asked, so there is
nothing to distribute.

**"The damage may be divided among targets"** is `divided` on a `deal_damage`:

```json
{
  "type": "deal_damage",
  "amount": { "kind": "previous_targets" },
  "divided": true,
  "target": {
    "kind": "entity",
    "selector": {
      "zone": "battlefield",
      "controller": "opponent",
      "filter": { "cardTypes": ["unit", "token", "commander"] },
      "count": "all",
      "selection": "player_choice"
    }
  }
}
```

`divided` flips what `amount` means: it is a **total** the chooser splits, not an
amount each recipient takes. The allocation decides which targets are hit at all,
so the selector underneath is the pool it draws from — `count: "all"` and
`selection: "player_choice"` are both required, and one player allocates, so the
chooser may not be plural. Each target takes its whole share as a single hit, so
Barrier answers the share rather than each point. Points with no legal target are
lost, and a total of zero simply does nothing.

`{ "kind": "previous_targets" }` is the amount used above: however many things
the instruction **immediately before** it resolved with. It is the value-side twin
of `{ "kind": "previous_target" }` and reads the same record, so "sacrifice up to
five Units, then deal that much damage" cannot disagree with itself. It is
deliberately not a `units_sacrificed_this_turn` count — that number includes every
earlier sacrifice on the same turn — and it is a schema error on the first
instruction of a list, where there is no preceding step to count.

## 4. Targets and choices

A target is a discriminated union, not a free-form string:

```json
{ "kind": "source" }
{ "kind": "player", "relation": "opponent", "selection": "player_choice" }
{ "kind": "players", "relation": "each_opponent" }
{ "kind": "entity", "selector": { "zone": "battlefield", "controller": "opponent", "count": 1 } }
```

An `entity` selector is a zone query with an optional `filter`, a `count`
(a number or `"all"`), a `selection` mode and a `chooser`. Some consequences
worth knowing before you author:

- `selection: "player_choice"` pauses the whole match until that player answers.
- `optional: true` lets the effect resolve harmlessly with no target; otherwise a
  required target with no legal option means the card cannot be played at all.
- `controller: "opponent"` widens to _every_ living opponent at a three or
  four player table. Write cards that read sensibly at four seats.
- A target that becomes illegal before the effect resolves is skipped, and the
  rest of the effect still happens.

## 4a. The three ways to write "you may"

They are not interchangeable, and the difference is _when_ the player is asked.
[ADR 0017](architecture/0017-optional-instructions-and-interactive-costs.md) has
the full reasoning; this is the authoring rule.

**If the decision is which card** → `optional: true` on the target **selector**.
Declining is picking nothing, which is one interaction. This is what
`pit_executioner` uses for "you may sacrifice another Unit".

**If there is nothing to decline by picking** → `optional: true` on the
**instruction**. `formation_tactician` readies the unit its trigger was about;
there is no target to leave empty, so the only decision left is whether to do it,
and that arrives as a yes/no. Do not use both on the same instruction — you would
be asking twice for one decision.

**If the player must pay before the card resolves** → `additionalCosts`. This is
the only form whose timing differs: the cost is paid as the card is played,
_before_ an opponent's Reaction window opens, so countering the card does not
refund it. A first instruction would resolve after that window closed and give
the whole thing back. Only `unit`, `spell` and `relic` may carry one.

`"If you do, …"` is `{ "kind": "previous_step" }` as an instruction's
`condition`. It is true when the instruction **immediately before it** changed
something — which covers all three of "the player said no", "there was nothing
to act on" and "it was already true of the board". It refers to the preceding
instruction only, so it can never be the first one in a list; the schema rejects
that rather than leaving a gate that is false forever.

Two things the engine does on your behalf, so do not author around them:

- **Nobody is asked when there is one possible answer.** An optional step with
  no legal target is skipped silently, and a sacrifice cost with exactly as many
  candidates as it needs is paid without a prompt.
- **A sacrifice cost is the player's choice by default.** Set
  `"selection": "automatic"` only when the victim genuinely does not matter, and
  `"excludeSource": true` for "sacrifice **another** Unit".

## 5. Card text, generated and curated

Two things are shown to players, and they are always distinguished:

- `displayText` — the canonical card text, exactly as printed on the card.
  Written by you. This is the only field that holds rules text; there is no
  second one.
- The **generated explanation** — produced from the structured effects by
  `@tcg/help-content`, step by step, in resolution order. You do not write it,
  and you cannot make it say something the card does not do.

Optional curated help in `text` supplements the generated explanation:

| Field                | Use it for                                                        |
| -------------------- | ----------------------------------------------------------------- |
| `summary`            | A one-sentence beginner explanation, replacing the generated one. |
| `effectExplanations` | Per-step clarifications, index-aligned with `effects`.            |
| `notes`              | Edge cases worth surfacing.                                       |
| `flavor`             | Non-rules flavour text.                                           |

Curated text never replaces a generated step — it appears beside it. Writing
more `effectExplanations` than the card has effects is an error, so a
clarification cannot outlive the step it describes.

Any of these may quote a live configuration value:

```json
{ "notes": ["You may hold at most {matchConfig.maxHandSize} cards at end of turn."] }
```

Allowed references are the keys of the shared rules configuration
(`matchConfig.*`) and the deck format (`deckRules.*`). An unknown reference fails
validation — never type the number itself, or it will be wrong the next time
someone tunes a value.

## 6. Artwork

Drop a PNG at:

```text
assets/card-art/<card_id>.png
```

At `768 × 1024`. That is the whole process — no data change, no code change, no
build step.

Missing artwork is completely normal: the card falls back to
`assets/defaults/default_card.png` and plays identically. The PNG is decoration.
Name, cost, stats and text are always rendered as live UI, so a balance change
never means repainting an image.

## 7. Validating and testing

```bash
npm run validate:content   # cards, registries, rulebook and templates
npm test                   # the full suite
npm run verify             # typecheck, lint, content, tests, build
```

`validate:content` checks more than the schema. It also proves that every effect
on every card can be explained to a player, that no curated text references a
setting that does not exist, and that no explanation comes out empty. If a card
cannot be explained, that is an error rather than a vague sentence shown to a
player.

Warnings do not fail the build **in a `development` set**. In a `playtest` or
`active` set — `precon_wave_1` is one — the content build turns every card
warning into an error, so a card there has to be clean rather than merely
loadable. Missing artwork, an inert keyword and a token nothing creates stay
legitimate states in a fixture set.

### The two things a new card owes

**A behaviour contract.** Every card in `precon_wave_1` has one entry in
`packages/rules-engine/src/card-contracts/`, and `registry.test.ts` fails by
name when a card in the set has none. Add yours to the faction file, as a
one-sentence `claim` and a short script that arranges a board, uses the card and
asserts what it did. The harness (`harness.ts`) has the arrangements already —
`board`, `cast`, `activate`, `attack`, `block`, `endTurn`, `react` — so a
contract is usually five lines. Keep it to the card's printed headline: the
edge cases belong in the suite for the mechanic, not here.

**Prose that matches its structure.** `lintDisplayText` reads `displayText`
against the card's effects in _both_ directions. Prose naming a mechanic the
card does not have is reported, and so is a mechanic the card has that the prose
never mentions — including a keyword it carries or grants. There is no exemption
for a card whose `text` block is hand-written: curated help describes the same
card the engine runs, or it is wrong.

## 8. When data is not enough

You need engine work — not just a card file — when the card needs:

- **A new effect type.** Anything the effect vocabulary cannot express.
- **A variable amount.** Every amount in the schema is a fixed integer. "Draw
  cards equal to your unit count" has no representation today.
- **A new trigger.** The trigger vocabulary is closed.
- **A new keyword.** Keyword IDs are a fixed enum.
- **A condition.** There is no "if" in effect data; an effect always resolves.

When you do add a mechanic, these ship **together**, in one change:

1. The schema for the new effect, trigger or keyword.
2. The engine handler that executes it.
3. An entry in the effect, trigger or keyword registry.
4. An explanation renderer in `packages/help-content/src/explain/effects.ts`.
5. Unit tests for resolution _and_ for the generated explanation.
6. A rulebook or glossary entry if it introduces a player-facing concept.

The renderer table is a total `Record<EffectType, …>`, so forgetting step 4 is a
compile error rather than a card that quietly renders as "does something".

Two more rules worth stating plainly:

- **Do not describe a rule the engine does not implement.** `Guardian` and
  `Resilient` are printed on cards and do nothing; their registry entries say
  exactly that. Inventing a plausible definition would be worse than admitting
  the gap.
- **Do not put a number in prose that the configuration owns.** Use a reference.

## Templates

| File                                                                                         | Shows                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [`template_basic_unit.json`](templates/cards/template_basic_unit.json)                       | The minimum viable card                    |
| [`template_choice_spell.json`](templates/cards/template_choice_spell.json)                   | A spell that pauses for a player choice    |
| [`template_triggered_unit.json`](templates/cards/template_triggered_unit.json)               | Deploy effects plus a triggered ability    |
| [`template_static_relic.json`](templates/cards/template_static_relic.json)                   | A continuous effect                        |
| [`template_filtered_target_spell.json`](templates/cards/template_filtered_target_spell.json) | A filtered, required target                |
| [`template_optional_cost_spell.json`](templates/cards/template_optional_cost_spell.json)     | An additional cost, "you may", "if you do" |
| [`template_delayed_spell.json`](templates/cards/template_delayed_spell.json)                 | A delayed effect that watches its target   |
| [`template_reanimation_spell.json`](templates/cards/template_reanimation_spell.json)         | A zone transition: discard to battlefield  |
| [`template_derived_value_spell.json`](templates/cards/template_derived_value_spell.json)     | An amount read from the target's statline  |
| [`template_scaling_cost_unit.json`](templates/cards/template_scaling_cost_unit.json)         | A cost that scales with the board          |
| [`template_replacement_relic.json`](templates/cards/template_replacement_relic.json)         | Rewriting an arrival and a Ready Step      |
| [`template_shared_choice_spell.json`](templates/cards/template_shared_choice_spell.json)     | A choice every player makes at once        |
| [`template_divided_damage_spell.json`](templates/cards/template_divided_damage_spell.json)   | A damage total split across targets        |

Every template is validated by `npm run validate:content`, so they cannot fall
behind the schema.
