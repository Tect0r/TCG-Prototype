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

| Type        | Where it lives                  | Notes                                                            |
| ----------- | ------------------------------- | ---------------------------------------------------------------- |
| `unit`      | A battlefield slot              | Needs `attack` and `health`. Attacks and blocks.                 |
| `spell`     | Resolves, then the discard pile | Must have at least one effect. No triggered or static abilities. |
| `relic`     | The relic row                   | Persists. Does not use a unit slot.                              |
| `commander` | The Commander zone              | `cost` must be `null`. Never deployed as a unit.                 |
| `token`     | Created by an effect            | `cost` must be `null`, and `collectible` must be `false`.        |

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

Warnings do not fail the build. Missing artwork, an inert keyword and a token
nothing creates are all legitimate states.

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

Every template is validated by `npm run validate:content`, so they cannot fall
behind the schema.
