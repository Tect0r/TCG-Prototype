# Player Help and Data-Driven Content System

## Purpose

Implement a player-facing help system and simplify future card and rule maintenance.

The completed system must provide:

1. A **Rulebook** accessible from every lobby without leaving the lobby.
2. A safe **card inspection/help mode** during matches.
3. Plain-language explanations for cards, effects, triggers, targets, and keywords.
4. A data-driven content structure in which most cards and rules can be added or changed without editing UI code.
5. Runtime validation with useful authoring errors.
6. One authoritative definition for each rule, keyword, effect type, and card.

This is a player-help and content-authoring milestone. Do not change the underlying game rules unless a change is explicitly required to expose existing rules correctly.

---

## Core architectural rules

### One source of truth

- Gameplay behavior comes only from structured, validated data processed by the rules engine.
- The UI must never interpret prose to decide gameplay behavior.
- Player-facing rules text and explanations may be generated from structured data.
- A manually written explanation may clarify unusual behavior, but it must never change behavior.
- Configurable match values must come from the shared match configuration rather than duplicated numbers in the rulebook.
- Keyword names and definitions must come from one shared keyword registry.
- Card IDs are permanent internal identifiers and must not depend on display names.

### Expected editing workflow

A normal card change should require editing only its card data file. Adding an ordinary card should require:

1. Copying a documented template.
2. Assigning a unique stable ID.
3. Filling in the card's structured fields and effects.
4. Optionally dropping an artwork PNG into the artwork folder.
5. Running validation and tests.

No component switch statement, route, hard-coded card list, or CSS file should require editing for an ordinary new card.

Adding a genuinely new rules mechanic may require engine code. When this happens, its effect/trigger/keyword definition, renderer, validation, help description, and tests must be added together.

---

## Recommended content structure

Adapt exact paths to existing repository conventions; do not create duplicate card or engine models.

```text
packages/
  game-data/
    src/
      cards/
        cards.json
      rules/
        rulebook.json
        keywords.json
        effect-definitions.json
        trigger-definitions.json
        glossary.json
      schemas/
        card.schema.json
        rulebook.schema.json
        keyword.schema.json
      loaders/
      validation/
      generated/
  rules-engine/
  shared-protocol/

apps/
  web/
    public/
      card-art/
        default_card.png
        <card_id>.png
    src/
      features/
        rulebook/
        card-inspector/
        help/
```

If cards are already stored as TypeScript or individual JSON files, migrate only when it reduces duplication without breaking existing imports. A single `cards.json` is acceptable for a small pool; individual `cards/<card_id>.json` files are preferable once merge conflicts or file size become inconvenient. The loader API must hide the physical layout from consumers.

All apps, the server, rules engine, deck builder, simulator, rulebook, and inspector must consume the same validated card registry.

---

## Card data model

Preserve the existing executable card schema where possible. Extend it with optional help metadata instead of building a second UI-only card database.

Example:

```json
{
  "id": "desperate_insight",
  "schemaVersion": 1,
  "name": "Desperate Insight",
  "type": "spell",
  "colors": ["blue"],
  "cost": 2,
  "tags": ["draw", "discard"],
  "effects": [
    {
      "type": "discard",
      "player": "self",
      "amount": 1,
      "selection": "player_choice"
    },
    {
      "type": "draw",
      "player": "self",
      "amount": 1
    }
  ],
  "text": {
    "rules": "Discard a card, then draw a card.",
    "flavor": "Clarity sometimes demands a sacrifice.",
    "summary": "Exchange one card in your hand for a new card.",
    "effectExplanations": [
      "You choose one card from your hand and discard it.",
      "After the discard resolves, draw the top card of your deck."
    ],
    "notes": [
      "If your hand contains no card to discard, follow the rules engine's existing resolution behavior."
    ]
  }
}
```

### Required card fields

Use existing repository names when they differ:

- `id`: lowercase snake_case, globally unique, permanent.
- `schemaVersion`: enables controlled future migrations.
- `name`: player-facing name.
- `type`: existing supported card type.
- `cost`: structured numeric or existing value expression.
- Executable effects, abilities, static abilities, stats, colors, tags, and restrictions required by the existing engine.

### Optional help fields

- `text.rules`: canonical concise card text shown on the card.
- `text.summary`: one-sentence beginner explanation.
- `text.effectExplanations`: ordered clarifications corresponding to complex effect steps.
- `text.notes`: edge cases worth showing to players.
- `text.flavor`: non-rules flavor text.

Do not require manual explanation fields for simple cards. Generate a useful fallback from the structured definition. Manual text overrides or supplements the generated explanation only.

### Card artwork

Artwork lookup must use the immutable card ID:

```text
public/card-art/<card_id>.png
```

Rules:

- Lowercase snake_case only.
- PNG is the initial supported format.
- The display name may change without renaming the file.
- Missing artwork falls back to `public/card-art/default_card.png`.
- Missing or broken art must never prevent a card from rendering or a match from loading.
- Provide one shared artwork resolver used by deck building, matches, and help views.

The PNG represents artwork, not authoritative card text. Name, cost, effects, and stats remain dynamically rendered from card data so balance changes never require repainting the image.

---

## Shared rules registries

### Keyword registry

Create or consolidate a shared keyword registry:

```json
[
  {
    "id": "guard",
    "name": "Guard",
    "shortDefinition": "This unit restricts which friendly units may be attacked.",
    "fullDefinition": "Use the exact behavior already implemented by the rules engine.",
    "category": "combat",
    "relatedRuleSections": ["combat.blocking"],
    "examples": ["A Guard unit protects eligible allies according to the targeting rules."],
    "schemaVersion": 1
  }
]
```

Requirements:

- Every keyword used by a card must exist in the registry.
- Unknown keywords fail validation.
- Tooltips, glossary entries, and card explanations use this registry.
- Do not duplicate keyword definitions in React components.
- Definitions must reflect the engine's actual current behavior, not assumptions from another TCG.

### Effect-definition registry

Maintain metadata describing each executable effect type:

```json
[
  {
    "type": "draw",
    "label": "Draw",
    "descriptionTemplate": "{player} draws {amount} {cardWord}.",
    "parameters": ["player", "amount"],
    "requiresChoiceWhen": null,
    "category": "cards"
  },
  {
    "type": "discard",
    "label": "Discard",
    "descriptionTemplate": "{player} discards {amount} {cardWord} from {zone}.",
    "parameters": ["player", "amount", "selection"],
    "requiresChoiceWhen": "selection == player_choice",
    "category": "cards"
  }
]
```

This registry is documentation metadata, not executable scripting. The rules engine remains authoritative. Each supported executable effect must have:

- Runtime/schema validation.
- Engine handling.
- A human-readable explanation renderer.
- Unit tests for resolution.
- Unit tests for generated explanations.

If a card uses an effect that has no explanation renderer, validation or CI must fail with the card ID and unsupported path.

### Trigger-definition registry

Store shared explanations for triggers such as deploy, attack, defeat, turn start, and turn end. Card inspection should combine trigger metadata with the card's executable ability data, for example:

> When deployed: Draw one card.

### Glossary

Use a small shared glossary for game concepts that are not keywords, such as owner, controller, ready, exhausted, active player, battlefield, discard pile, and valid target.

---

## Rulebook data model

The rulebook must be content-driven rather than a hard-coded React page.

Example structure:

```json
{
  "schemaVersion": 1,
  "title": "How to Play",
  "sections": [
    {
      "id": "objective",
      "title": "Objective",
      "order": 10,
      "blocks": [
        {
          "type": "paragraph",
          "text": "Defeat every opposing player to win the match."
        }
      ]
    },
    {
      "id": "turn_structure",
      "title": "Turn Structure",
      "order": 30,
      "blocks": [
        {
          "type": "phaseList",
          "source": "matchConfig.turnPhases"
        }
      ]
    },
    {
      "id": "keywords",
      "title": "Keyword Glossary",
      "order": 90,
      "blocks": [
        {
          "type": "keywordIndex",
          "source": "keywordRegistry"
        }
      ]
    }
  ]
}
```

Supported initial block types:

- `heading`
- `paragraph`
- `bulletList`
- `numberedList`
- `callout`
- `example`
- `configValue`
- `phaseList`
- `keywordIndex`
- `glossaryIndex`

Keep this deliberately constrained. Do not create an arbitrary HTML-in-JSON system. Text must be rendered safely and must not accept executable markup.

### Dynamic values

Values such as starting health, opening hand size, battlefield capacity, hand limit, energy progression, reconnect window, deck size, and copy limits must be referenced from shared configuration when such configuration already exists.

The rulebook loader resolves approved references such as:

```text
matchConfig.startingHealth
matchConfig.openingHandSize
deckRules.minimumDeckSize
```

Unknown references fail validation. Do not allow arbitrary property traversal.

### Required rulebook sections

1. Objective and victory conditions
2. Match setup
3. Deck-building rules
4. Card anatomy
5. Card types
6. Energy and paying costs
7. Turn order and phases
8. Playing cards and using abilities
9. Attacking and blocking
10. Damage, defeat, and elimination
11. Commander rules
12. Multiplayer free-for-all rules
13. Choices, targets, and effect resolution
14. Keywords
15. Glossary
16. Example first turn
17. Common edge cases

Write these sections from the implemented game rules. If a rule remains intentionally unresolved, do not invent it; mark the relevant authoring task clearly and keep the application build from presenting false information.

---

## Lobby rulebook UX

- Add a clearly visible `Rulebook` button to the lobby screen.
- It opens a large modal, drawer, or overlay without navigating away or losing lobby state.
- It must work in every lobby state, including while waiting for other players.
- Include a table of contents and text search.
- Clicking a result or section scrolls to it.
- Include a dedicated keyword/glossary view generated from the shared registries.
- The panel must be keyboard accessible, close with Escape, trap focus correctly, and restore focus to the opening control.
- It must be usable on desktop and the application's existing smallest supported viewport.
- Reopening it should preserve the current section during the same lobby session when practical.

The rulebook may also be exposed from another global Help entry later, but the lobby button is required.

---

## In-match card inspection

### Entry points

Provide both:

- A visible `? Help` toggle in the match screen.
- A small help/inspect affordance on visible cards where it does not create visual clutter.

When Help mode is active, clicking a visible card opens the inspector and must not select, play, target, attack with, or otherwise act on that card.

Do not change normal card-click behavior when Help mode is inactive. If right-click is supported, it may also inspect, but it must not be the only route.

### Inspectable cards

- Cards in the local player's hand.
- Friendly and enemy public battlefield cards.
- Commanders.
- Relics and other public permanents.
- Public discard-pile cards when the discard UI exposes individual cards.
- Any other card whose identity is legitimately public.

Never reveal hidden enemy hands, face-down cards, unrevealed deck contents, hidden choices, or other private state. The server/view-model boundary remains authoritative for what the client may inspect.

### Inspector contents

Show:

- Card name and resolved artwork.
- Cost, type, colors, stats, and relevant tags.
- Canonical rules text.
- One-sentence summary when available.
- Structured explanation of each effect or ability in resolution order.
- Trigger timing.
- Valid target description.
- Keyword definitions.
- Conditions, limits, and optional/mandatory status.
- Curated notes when present.
- Current contextual status, when deterministically derivable from the player's legal view.

Possible contextual messages:

- `This unit cannot attack this turn.`
- `This card is exhausted.`
- `You cannot currently afford this card.`
- `There are no valid targets for this effect.`
- `This ability triggers when the unit is defeated.`
- `This card is not playable during the current phase.`

Contextual explanations must use existing legal-action/validation APIs. Do not reimplement rule legality inside React. If the client cannot know why an action is illegal reliably, show a neutral explanation rather than guessing.

### Inspector behavior

- Open as a compact side panel or modal that does not obscure the entire board when space allows.
- Allow moving directly between inspectable cards.
- Close with Escape and a visible close button.
- Pause no timers and change no match state.
- Send no gameplay action to the server merely because a card was inspected.
- Remain safe during reconnects and match-state updates.
- Clearly label generated explanations as explanations, while retaining the exact canonical card text.

---

## Explanation generation

Build a shared pure explanation service, not component-specific formatting.

Suggested API:

```ts
type CardExplanation = {
  summary: string;
  sections: ExplanationSection[];
  keywords: KeywordDefinition[];
  notes: string[];
};

function explainCard(
  card: CardDefinition,
  registries: HelpRegistries,
  context?: PublicCardContext,
): CardExplanation;
```

Requirements:

- Deterministic output.
- Pure and side-effect free.
- Exhaustive handling of all currently supported effects, triggers, selectors, value expressions, costs, conditions, and static abilities.
- Correct grammar for singular/plural and self/opponent/player wording.
- Preserve effect order and distinctions such as `then`, simultaneous resolution, optional choices, costs, and consequences.
- Explain selectors in plain language, including controller, zone, type, tags, amount, and restrictions.
- Explain variable amounts, maxima, and conditions without evaluating hidden information.
- Support explicit card-authored overrides for rare cases.
- Never infer gameplay behavior from `text.rules`.

Fallback policy:

1. Use structured generation for every supported mechanic.
2. Add curated `summary`, `effectExplanations`, or `notes` when they improve clarity.
3. If generation cannot describe executable behavior completely, fail content validation in development/CI. Do not silently display a misleading generic sentence.

---

## Authoring and validation

### Validation command

Add one obvious repository command, following existing package-manager conventions, such as:

```text
pnpm validate:content
```

It must validate:

- JSON syntax and schema versions.
- Unique card, keyword, glossary, and rule-section IDs.
- Stable ID naming convention.
- Required fields by card type.
- Effect, trigger, selector, value-expression, and condition structures.
- Every referenced keyword exists.
- Every executable effect has an explanation renderer.
- Every rulebook source reference is allow-listed and resolvable.
- Rulebook section ordering and link targets.
- Artwork naming; missing art is allowed because a fallback exists.
- Unsupported or stale manual explanation mappings.
- Cards remain compatible with existing deck and game validators.

Errors must include the filename/card ID and a precise path, for example:

```text
cards/desperate_insight.json: effects[0].selection — unsupported value "choose"
```

### Templates and documentation

Add:

- A documented basic unit example.
- A spell with a player choice.
- A triggered unit.
- A static/continuous ability example.
- A card with a variable value and target filter.
- A short `ADDING_CARDS.md` guide.

The guide should explain:

1. How to choose an ID.
2. How to select a card type.
3. How to compose supported effects.
4. How targets and choices work.
5. How generated and curated explanations interact.
6. Where to place artwork.
7. How to validate and test.
8. When a new card requires engine work rather than data alone.

Do not introduce a graphical card editor in this milestone. Design the loader/validation APIs so one can be added later.

---

## Compatibility and migration

- Preserve all existing card IDs and saved deck compatibility.
- Do not change network payloads merely to render help unless required public card metadata is genuinely absent.
- Do not send the entire hidden card registry as match state if that would reveal private information.
- Existing deck builder, online matches, multiplayer, simulator, replays, and deterministic tests must continue to work.
- Card data used by simulations and live matches must remain byte-for-byte or semantically identical after a pure organizational migration.
- If generated rules text differs from existing card text, treat that as a review item rather than silently rewriting all text.
- Add explicit schema migrations when future breaking data changes become necessary.

---

## Required tests

### Content and schema

1. All current cards pass the new content validator.
2. Duplicate and malformed IDs fail with precise errors.
3. Unknown effects, triggers, keywords, and source references fail.
4. Every current effect and ability produces a complete explanation.
5. Missing artwork resolves to the default without error.
6. A valid newly added data-only card appears in the shared registry without UI code changes.

### Rulebook

7. Rulebook renders all required sections from data.
8. Dynamic configuration values display current shared values.
9. Keyword and glossary entries come from shared registries.
10. Search returns relevant sections and terms.
11. Lobby state survives opening and closing the rulebook.
12. Keyboard focus, Escape behavior, and accessible labels work.

### Card inspector

13. Help-mode card clicks never dispatch gameplay actions.
14. Normal clicks retain existing behavior when Help mode is off.
15. All permitted public card zones can be inspected.
16. Hidden information can never be inspected or inferred.
17. Keyword, trigger, target, choice, and ordered-effect explanations render correctly.
18. Context messages use authoritative legality information.
19. Opening/closing the inspector changes no deterministic game state.
20. Inspector remains stable during state updates and reconnects.

### Regression

21. All existing tests pass.
22. Type-check, lint, and production build pass.
23. Representative 1v1 and multiplayer matches remain deterministic.
24. Simulator results do not change solely because help metadata was added.
25. Existing saved decks continue to load.

---

## Implementation sequence

Claude may implement the complete milestone continuously, but validate each gate before proceeding:

1. Inventory the existing card, rule, keyword, configuration, legal-action, and artwork systems.
2. Produce a migration map and reuse existing types instead of duplicating them.
3. Add shared registries, schemas, loaders, and validation.
4. Migrate existing content without changing behavior.
5. Add exhaustive explanation generation and its tests.
6. Add the data-driven rulebook and lobby UI.
7. Add safe in-match Help mode and the card inspector.
8. Add contextual legality explanations through existing engine APIs.
9. Add authoring templates and `ADDING_CARDS.md`.
10. Run the full regression, deterministic, accessibility, and production-build checks.
11. Update project status and record any intentionally deferred improvements.

Stop only when an unresolved rule would force invented player-facing information, or when a migration would break compatibility without an honest migration path.

---

## Definition of done

This milestone is complete only when:

- Players can open a complete, searchable rulebook from the lobby.
- Players can safely inspect every legitimately visible card during a match.
- Inspection explains effects, abilities, triggers, targets, choices, and keywords in plain language.
- Help mode cannot accidentally perform a game action.
- Hidden information remains hidden.
- Rules, configuration values, keywords, effects, and cards each have one authoritative source.
- An ordinary supported card can be added or balanced through data plus optional artwork, without editing UI code.
- Unsupported mechanics fail validation instead of degrading into misleading explanations.
- Missing artwork uses the default card image.
- Existing decks, matches, multiplayer, replays, simulations, and determinism remain intact.
- All required tests, type-checking, linting, content validation, and production builds pass.
- Documentation clearly tells a future author how to add and change cards and rules.

The guiding principle is:

> Make common card and rule changes data work; make genuinely new mechanics explicit engine work; never let presentation text become hidden game logic.
