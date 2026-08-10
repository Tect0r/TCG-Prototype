# Pre-Card Pool and Agent-Testing Readiness

## Purpose

This document defines the final preparation work required before the first real card batch is authored and before automated pilots are used to draw balance conclusions from it.

The current application is a strong prototype. This is not a request to redesign Phases 1–4 or rebuild the new player-help system. It is a narrow readiness and truthfulness pass that must:

1. close the remaining Phase 4 defect;
2. make real-card authoring safe and convenient;
3. prevent accepted-but-nonfunctional card data;
4. make simulator replays survive later card edits;
5. make the pilots honest about which mechanics they understand;
6. isolate the real card pool from the generic prototype fixtures;
7. establish a reproducible first-batch testing workflow.

The goal is not to implement every Magic: The Gathering mechanic before creating cards. The goal is to make the system extensible, truthful, and trustworthy for the mechanics deliberately selected for the first batch.

---

## 1. Audited baseline

Audit target:

- Repository: `Tect0r/TCG-Prototype`
- Commit: `5f13d248bf1fc645ce830dced63fee22414f683f`
- Commit label: `Helper Ui`
- Audit date: 2026-08-09

Verification passed:

- clean `npm ci`;
- TypeScript type-check across all workspaces;
- ESLint;
- Prettier check;
- content validation;
- all **679 tests across 42 files**;
- production build;
- a complete 12-match simulator smoke experiment with no abnormal termination.

The newly implemented help system is structurally good and should be preserved:

- the lobby rulebook is data-driven;
- live rule values come from shared configuration;
- card explanations are generated from structured mechanics;
- curated help supplements rather than replaces executable truth;
- hidden information is not exposed to the inspector;
- Help mode replaces action handlers rather than trying to undo an accidental action;
- every current effect type has explanation metadata and a renderer.

Passing tests do not remove the following pre-card risks. Most are boundary or experimental-design defects rather than broad implementation failures.

---

## 2. Readiness classification

### Must be complete before real card authoring begins

1. Establish a real-set content structure instead of editing one large prototype JSON file.
2. Isolate generic prototype cards from the first real format.
3. Decide the first-batch Commander model.
4. Either define `guardian` and `resilient` or prohibit them in the real set.
5. Fix or remove accepted `while_source_present` behavior.
6. Define the first-batch color/faction and archetype matrix.
7. Add strict real-set validation and a card scaffolding command.
8. Clean the contradictory status and rules documentation.

### Must be complete before automated balance findings are trusted

1. Implement genuine insertion experiments.
2. Freeze resolved card definitions inside experiment/replay artifacts.
3. Add a real single-replay command and hash verification.
4. Stop pilots valuing inert keywords as mechanical bonuses.
5. Make pilot scoring exhaustive for every supported effect and keyword.
6. Give pending choices explicit semantic intent instead of inferring it from the whole source card.
7. Add pilot-support and telemetry-support validation for every mechanic in the real set.
8. Add strategy-aware seed decks and testing profiles for the first-batch archetypes.

### May be deliberately deferred

- Commander battlefield deployment, combat, defeat, and recovery, if the first batch keeps Commanders in the Commander zone;
- reaction-speed cards, opponent-turn actions, priority, and an MTG-style stack;
- every alternate victory condition not selected for the first batch;
- generic counters, variable values, and conditional effects that no first-batch card requires;
- three- and four-player balance verdicts while the 1v1 data is still immature;
- accounts, matchmaking, real-player telemetry, progression, rarity economy, and monetization;
- polished animation and final art.

Deferred features must be absent or clearly rejected by schemas. The system must not accept data that looks supported but silently behaves as something else.

---

## 3. Gate A — close Phase 4 honestly

### A1. Implement real insertion experiments

Current defect:

`ReplacementConfig.includeInsertion` records a note when a base deck does not contain the subject card. It does not create or test an insertion variant. This leaves build-around cards and newly introduced cards without the controlled insertion experiment promised by the Phase 4 specification.

Required behavior:

- When `includeInsertion` is true and a base deck does not contain `subjectCardId`, build one or more legal variants that insert the requested number of copies.
- Remove the same number of copies from explicitly recorded cards so deck size remains unchanged.
- Prefer removal candidates that are comparable to the inserted card by:
  - card type;
  - energy cost;
  - functional role;
  - archetype tags;
  - uniqueness/copy constraints;
  - color legality.
- Do not silently repair an otherwise illegal deck.
- Record for every variant:
  - base deck hash;
  - variant deck hash;
  - inserted card ID and quantity;
  - every removed card and quantity;
  - selection method;
  - explicit confounds;
  - legality result.
- Replay base and insertion variants against the same opponent, seat orientation, pilot tuple, and derived seed.
- Analyse insertion outcomes as paired data.
- Keep build-around context visible. A card inserted into a deck with no support is a stress/control experiment, not proof that the card is weak.

Required tests:

- insertion into a legal deck;
- insertion at copy limits;
- unique-card insertion;
- no legal removal candidate;
- multi-copy insertion;
- identical common-seed schedule;
- paired estimate generation;
- deterministic output across worker counts;
- accurate variant metadata and report wording.

### A2. Mark Phase 4 complete only after A1 passes

Update all status sources together:

- `CLAUDE.md`;
- `README.md`;
- `docs/project-status.md`;
- `docs/open-questions.md`;
- `docs/rules/open-decisions.md`;
- `PHASE4_HARDENING.md`, by adding a completion note rather than rewriting its historical specification.

Remove or archive obsolete instructions that still tell Claude to implement Phase 4 or Phase 4 hardening.

Correct stale claims in `docs/rules/open-decisions.md` and `docs/open-questions.md`. They currently describe `staticAbilities`, structured activation costs, source targets, and some Phase 3 work as “not implemented” even though those systems are live.

### A3. Fix runtime and verification drift

Current dependency warning:

- `jsdom@30.0.1` requires Node `^22.22.2`, `^24.15.0`, or `>=26`;
- the audit runtime is Node `24.14.0`;
- root `package.json` claims support for Node `>=20.11`.

Required behavior:

- Select and pin one supported Node line. Prefer the Node 24 line already used by the project, at a version accepted by `jsdom`.
- Add `.nvmrc` and `.node-version` with the selected exact version.
- Make `package.json#engines.node`, README requirements, and CI agree.
- Add a GitHub Actions verification workflow if none exists.
- CI must run on a clean checkout with `npm ci` and `npm run verify`.
- Add `npm run format:check` to `npm run verify`.
- Update the stale root package description, which still says the rules engine, multiplayer, and simulator are future work.

---

## 4. Gate B — make the implemented rules truthful

### B1. Resolve `while_source_present`

Current defect:

`durationSchema` accepts `while_source_present` for stat, keyword, cost, and prevention effects. Source IDs are stored on some modifier types, but the engine does not consistently expire those modifiers when the source leaves its active zone. Accepted data can therefore behave like a permanent effect.

Choose exactly one solution:

#### Preferred solution

Implement source-bound expiry consistently:

- every source-bound modifier records its source instance;
- it remains active only while that source exists in the required active zone and its controller is not eliminated;
- leaving the zone, changing control where relevant, being removed, or being eliminated removes the modifier during deterministic settlement;
- losing a source-bound Health increase immediately runs state-based checks;
- source-bound player cost modifiers and prevention shields follow the same rule;
- serialization and replay preserve the relationship.

#### Acceptable smaller solution

Remove `while_source_present` from every effect schema and template for now. Authors must use `staticAbilities` for auras/lords. Add a migration or clear load error for old data.

Do not leave the current accepted-but-wrong state.

### B2. Resolve inert keyword policy

Current facts:

- `guardian` and `resilient` are accepted and displayed but mechanically inert;
- six bundled cards print one of them;
- content validation only warns;
- heuristic pilots currently count every keyword as positive value, including inert keywords.

Before the first real set, choose one policy per keyword:

1. define and implement it completely; or
2. keep it prototype-only and reject it in real/playtest sets.

The recommended first-batch policy is to reject inert keywords in real sets unless their rules are deliberately settled. There is no need to invent their meaning merely to keep their names.

If a keyword is implemented, ship together:

- one player-facing definition;
- engine behavior;
- combat/targeting interactions;
- pilot valuation;
- telemetry attribution if relevant;
- rulebook/glossary entry;
- deterministic rules tests;
- agent decision tests.

### B3. Decide the first-batch Commander model

Current contradiction:

- Commanders remain in the Commander zone and never enter combat;
- Commanders are required to define Attack and Health;
- the inspector can show those stats;
- three prototype Commanders use `on_attack` or `on_survive_combat`, which can never trigger under the implemented rules.

Recommended first-batch decision:

> Commanders remain non-combat leaders in the Commander zone. They provide continuous, triggered, or activated abilities but are not units.

If that recommendation is accepted:

- make Commander Attack and Health optional or remove them from the first-batch schema;
- do not display meaningless combat stats;
- reject self-combat triggers on Commander cards;
- allow Commander-zone abilities to observe explicitly scoped friendly/player events through the trigger model in Gate E;
- rewrite or isolate the three nonfunctional prototype Commanders;
- keep Commander combat/recovery as a documented later module.

If Commanders are intended to fight in the first batch, stop and specify deployment cost, battlefield slot use, defeat, recovery, repeated deployment, ownership, Commander damage if any, and FFA elimination interactions before authoring any Commander.

### B4. Separate development fixtures from the real pool

The existing 56-card `prototype_core` set is test scaffolding. It contains intentionally inert keywords, placeholder color identity, generic names, and deliberately rough balance.

Required behavior:

- keep it as a `development` or `fixture` set;
- do not mix it into the default real/playtest format;
- allow explicit inclusion for regression tests;
- create a format or environment manifest that selects sets and cards deliberately;
- make the deck builder show which format/pool is active;
- make every simulator output identify the exact selected set versions and hashes.

The first real card batch must start in a new set ID. Do not rename `prototype_core` into the real set.

---

## 5. Gate C — make adding and changing cards genuinely easy

### C1. Replace the single giant authoring file

Current workflow:

Every card is edited inside `packages/card-data/src/data/prototype_core.json`. This will become conflict-prone and difficult to review as soon as real cards are added in batches.

Required source layout:

```text
content/
  sets/
    prototype_core/
      set.json
      cards/
        prototype_scout.json
        ...
    first_real_set/
      set.json
      cards/
        <one-card-per-file>.json
      tokens/
        <one-token-per-file>.json
  formats/
    development.json
    first_playtest.json
  archetypes/
    archetypes.json
  decks/
    first_playtest/
      <seed-deck>.json
```

Equivalent naming is acceptable, but one card per source file and one explicit set manifest are required.

The browser/server still need deterministic bundled data. Add a content build step that:

1. discovers source files in stable sorted order;
2. validates each file with its filename in every error;
3. validates cross-card and cross-set references;
4. emits deterministic generated bundles consumed by `@tcg/card-data`;
5. has a `--check` mode that fails when generated output is stale;
6. runs before development/build and in `npm run verify`;
7. never makes generated output the human source of truth.

### C2. Add a card scaffolding command

Provide a command such as:

```bash
npm run cards:new -- --set first_real_set --type unit --id trench_scout
```

It must:

- validate the ID before writing;
- refuse to overwrite an existing card;
- copy the correct type-specific template;
- place the file in the correct set folder;
- fill `schemaVersion`, `id`, `type`, and safe defaults;
- print the next validation command;
- never invent card mechanics, names, lore, or balance values beyond placeholders.

Add templates for at least:

- unit;
- spell;
- relic;
- Commander;
- token;
- triggered permanent;
- activated permanent;
- static/continuous permanent;
- targeted card;
- card using a player choice.

### C3. Add set and design metadata

The current card schema has one `role` and free-form `tags`. That is too weak for the archetype catalogue, deck generation, and later analysis.

Add validated design metadata without allowing it to control game rules:

```ts
type CardDesignMetadata = {
  setId: string;
  status: 'draft' | 'playtest' | 'active' | 'retired';
  roles: FunctionalRoleId[];
  archetypes: ArchetypeId[];
  creatureTypes?: string[];
  themes?: string[];
  complexity: 'simple' | 'intermediate' | 'complex';
};
```

Requirements:

- migrate singular `role` to `roles` or preserve it as a clearly documented primary role;
- use a controlled archetype registry, not typo-prone free-form strings;
- keep creature/lore tags separate from strategic archetypes;
- validate every archetype reference;
- expose roles/archetypes to deck-builder filters and simulator deck generation;
- include pilot-relevant design metadata in simulator provenance;
- never execute design metadata as a game rule.

### C4. Add strict validation modes

Warnings are appropriate for prototype fixtures but unsafe for a real playtest set.

Add content policies by set status:

- `development`: warnings allowed;
- `draft`: warnings visible;
- `playtest` and `active`: no inert keywords, missing rules text, unknown archetypes, unreachable abilities, unsupported pilot semantics, or unsupported telemetry;
- missing artwork remains allowed in every status.

Required validation rules for real cards:

- filename and permanent card ID agree;
- card belongs to exactly one set;
- no duplicate card, set, ability, or archetype IDs;
- every token reference resolves;
- every executable effect is supported by engine, help, pilot, and telemetry registries;
- no Commander carries an unreachable trigger;
- no accepted duration has undefined behavior;
- canonical `displayText` is present for every collectible card;
- structured mechanics and printed text pass strict drift checks;
- every set can produce at least one legal deck for every included Commander;
- every collectible card is legal in at least one declared format or explicitly marked test-only;
- no real-set card references a prototype-only mechanic accidentally.

### C5. Make card balance edits small and reviewable

Current candidate experiments often require a complete duplicated `CardDefinition` in `cardOverrides`.

Add a validated patch form for existing cards:

```json
{
  "cardId": "scorch",
  "patch": {
    "cost": 3,
    "effects": []
  }
}
```

Requirements:

- keep full overrides for adding/replacing complete definitions;
- use card patches for ordinary balance edits;
- reject unknown or prohibited patch fields;
- apply patches deterministically to a resolved baseline;
- derive the environment diff from the patch automatically;
- still verify declared changes before running an experiment;
- print the fully resolved before/after definitions in the report.

---

## 6. Gate D — define the first batch before coding it

Create `docs/design/FIRST_CARD_BATCH.md` before the first real card JSON is added.

It must define:

### D1. Format boundary

- intended deck size and copy limits for the first test;
- 1v1 as the initial balance mode;
- which match values remain provisional;
- whether the first pool is closed or includes selected neutral staples;
- target card count by type and cost band;
- target Commander count;
- which cards/tokens are test-only.

### D2. Color/faction identity

For every first-batch color or faction:

- core fantasy and gameplay promise;
- primary strengths;
- structural weaknesses;
- permitted removal, draw, healing, token, tempo, and denial tools;
- primary archetypes;
- secondary/splash archetypes;
- mechanics it should not receive efficiently;
- expected counterplay.

Recommended identity model:

- keep stable language-independent internal color IDs;
- separate player-facing faction names from those IDs;
- let multiple factions share a color identity later without renaming saved card IDs.

### D3. Archetype matrix

Use the vault's deck-archetype catalogue as the broad reference, but choose a small coherent subset for Batch 1.

For every selected archetype, record:

- macro plan: aggro, midrange, control, tempo, combo, ramp, etc.;
- board/resource engine: tokens, sacrifice, spells, relics, graveyard, etc.;
- win condition;
- early/mid/late game plan;
- enablers, payoffs, interaction, recovery, and finishers required;
- natural predators and prey;
- counter cards available inside the same pool;
- primary and secondary colors/factions;
- whether current heuristic pilots can play it competently.

Do not build one isolated preconstructed list per faction. Cards should overlap so each color/faction supports at least two plausible builds, while no card is expected to belong everywhere.

### D4. Counterplay budget

For every major engine or threat in Batch 1, identify at least two answer channels, such as:

- direct removal;
- combat contest;
- discard or hand pressure;
- graveyard denial;
- relic destruction;
- speed/racing;
- prevention/healing;
- tax or cost pressure;
- narrow side-grade tech.

Avoid hard locks, unavoidable infinite loops, and strategies whose only answer is “draw one exact card.”

---

## 7. Gate E — extend mechanics only where the first batch needs them

The current schema supports fixed effects well, but many common archetypes cannot yet be expressed. Specifically:

- triggered abilities are almost entirely self-referential;
- there is no “whenever another friendly unit is defeated”;
- there is no cast/play, heal, token-created, or general damage event trigger;
- amounts are fixed integers;
- there are no conditions;
- counters are internal state only and cannot be manipulated by cards;
- there is no alternate-win framework.

Do not respond by building a universal scripting language.

### E1. Implement event-scoped triggers as a core foundation

Replace or extend the current trigger shape so an ability states both the event and the subject relationship.

Conceptual example:

```json
{
  "event": "unit_defeated",
  "subject": "another_friendly",
  "filter": { "tags": ["soldier"] },
  "reason": ["combat", "destroyed", "sacrificed"]
}
```

Minimum useful event vocabulary should be selected from actual Batch 1 needs, likely including:

- card played/deployed;
- unit attacks;
- unit blocks;
- combat survived;
- unit defeated;
- unit sacrificed;
- damage dealt to player/unit;
- player healed;
- token created;
- turn start/end.

Minimum subject relationships:

- self/source;
- another friendly;
- any friendly including source;
- opposing;
- any.

Requirements:

- deterministic trigger ordering remains unchanged;
- active zone is explicit, so Commander-zone passives are valid without pretending the Commander attacked;
- event filters use public, structured event data;
- no hidden information may leak through trigger discovery or choices;
- source attribution survives source removal;
- old trigger data migrates without changing behavior;
- help text explains event, subject, filter, and timing;
- pilots and telemetry know which event the ability depends on.

### E2. Add only the selected expression primitives

If Batch 1 needs scaling values, add a small `ValueDefinition` union rather than arbitrary formulas. Candidate primitives:

- fixed integer;
- count matching entities in a named public zone;
- cards in controller's hand;
- damage marked on source;
- number of friendly units/tokens/relics;
- number of times a tracked event occurred this turn.

If Batch 1 needs conditions, add a small `ConditionDefinition` union. Candidate primitives:

- source is damaged/exhausted;
- controller/opponent Health above or below a threshold;
- matching entity exists;
- controller has at least N matching permanents;
- a specific event reason matches;
- `all`, `any`, and `not` composition with a strict nesting limit.

If Batch 1 needs poison, experience, charges, or similar counters, add a typed counter registry with explicit owners, visibility, caps, events, help text, pilot value, telemetry, and victory interaction.

If Batch 1 does not need a primitive, defer it. Document the omission in `docs/ADDING_CARDS.md` instead of accepting pseudo-support.

### E3. Expand the mechanic implementation contract

The current `ADDING_CARDS.md` contract covers schema, engine, help, and rules tests. Before agent testing, every new mechanic must ship with all of these:

1. schema and migration;
2. authoritative engine resolution;
3. legal-action/choice representation;
4. protocol and redacted-view safety where relevant;
5. UI interaction;
6. player-facing registry and generated explanation;
7. pilot valuation and target/choice semantics;
8. telemetry attribution;
9. simulator provenance/hash support;
10. rules tests;
11. explanation tests;
12. pilot decision tests;
13. telemetry reconciliation tests;
14. rulebook/glossary update;
15. authoring template and example.

A mechanic missing any applicable layer is not ready for a `playtest` card.

---

## 8. Gate F — make the pilots honest enough for the selected cards

### F1. Fix current pilot valuation defects

#### Inert keyword inflation

`keywordCount` currently values all keywords. Change valuation to count only mechanically implemented keywords. Add regression tests proving an inert keyword does not change card or board value.

#### Unreachable Commander ability inflation

Pilots currently value triggered abilities by their printed effect even when the trigger can never fire from that card's active zone. After the Commander decision and event-trigger migration, value only reachable abilities. Validation should reject unreachable real-set abilities before simulation.

#### Non-exhaustive effect scoring

`effectValue` currently has a default score of zero. A new effect can therefore compile or be forced through and become invisible to heuristic pilots.

Required behavior:

- use an exhaustive switch or total scorer registry keyed by `EffectType`;
- adding an effect type must fail type-check/content validation until pilot scoring support is added;
- allow explicit `legal_only` support for a mechanic that pilots cannot evaluate, but refuse balance conclusions for runs containing it.

#### Static ability approximation

Static abilities currently receive a near-flat value based largely on their count. Value at least:

- effect magnitude;
- affected scope;
- self/exclude-source behavior;
- current matching board count;
- active zone;
- implemented keyword value.

This can remain heuristic, but it must not treat `+3/+3 to all units` and `+1/+0 to one narrow tag` as equivalent.

### F2. Give choices explicit intent

Current problem:

When a choice is pending, the pilot examines every effect printed on the source card and decides the choice is hostile if any hostile effect exists. A card containing both beneficial and hostile steps can therefore target the wrong entity for the specific step being resolved.

Required behavior:

- pending choices carry structured provenance for the exact effect/cost that requested them;
- include resolution item ID, effect index, effect type, source, chooser, target relation, and semantic intent;
- distinguish choosing:
  - a beneficial friendly target;
  - a hostile enemy target;
  - a discard/sacrifice cost;
  - a tutor/search result;
  - an ordering;
  - an opponent/player target;
- pilots score the active choice, not the entire source card;
- the client may use the same provenance for clearer prompts without exposing hidden information.

Add mixed-effect regression cards designed to fail the old heuristic.

### F3. Publish a mechanic-support matrix

Add a machine-readable capability registry for every effect, trigger, keyword, value expression, and condition:

```ts
type MechanicSupport = {
  engine: 'full';
  help: 'full';
  pilot: 'full' | 'approximate' | 'legal_only';
  telemetry: 'full' | 'partial' | 'none';
};
```

Requirements:

- content validation derives support from registries rather than trusting card authors;
- every playtest card reports its weakest support level;
- simulator manifests aggregate support levels for every card in the run;
- reports prominently state when a conclusion depends on approximate pilots;
- balance flags are suppressed or downgraded when relevant mechanics are `legal_only` or telemetry is incomplete;
- random-legal crash testing remains allowed regardless of heuristic support.

### F4. Separate rule agents from balance agents

Use explicit language in code and reports:

- **Random-legal pilot:** legality, termination, loop, and crash discovery only.
- **Heuristic pilots:** approximate play-quality and comparative evidence for supported linear mechanics.
- **Archetype-aware pilots/profiles:** required for synergy, combo, sacrifice, control, or alternate-win decks whose cards are individually weak but collectively strong.
- **Human playtests:** required before any final balance conclusion.

Do not pool all pilot results as though they represented one skill distribution.

### F5. Add archetype-aware deck plans

The current generator has curve, role, tag, required-card, and unit-count weights, which is a useful base. Add a versioned deck-plan schema used by both generation and pilot evaluation:

```json
{
  "id": "token_aggro",
  "commanderIds": [],
  "requiredPackages": [],
  "preferredArchetypes": ["token", "go_wide", "aggro"],
  "minimumRoles": {},
  "curve": {},
  "protectedCards": [],
  "pilotProfile": "aggressive"
}
```

Requirements:

- seed generation with coherent packages, not only independent card weights;
- mutation can protect required engine pieces or replace a whole package coherently;
- crossover does not claim strategic coherence merely because two decks share a Commander;
- search still explores outside the seed plans to find abuse;
- every first-batch archetype has at least one human-authored legal seed deck and one deck plan;
- reports distinguish hand-authored reference decks, plan-generated decks, and unconstrained discovery decks.

---

## 9. Gate G — make experiments survive card iteration

### G1. Freeze resolved environments

Current critical defect:

Replay bundles store `environment.config`, not the fully resolved card database. A baseline config normally refers implicitly to whatever bundled cards exist in the current checkout. If a card is edited later, an old replay or copied experiment configuration can resolve to new mechanics while retaining an old environment hash in its historical record.

This contradicts the report's claim that a replay bundle reproduces exactly on its own.

Required behavior:

- Every experiment writes a content-addressed `resolved-environment.json` containing:
  - every playable card and Commander definition used;
  - referenced tokens and other required non-deckable definitions;
  - exact rules configuration;
  - exact deck format;
  - set/format IDs and versions;
  - mechanical/pilot content hashes;
  - schema versions.
- Replay bundles either embed that snapshot or reference a snapshot included beside them by immutable content hash.
- Replaying never silently falls back to the current bundled card database.
- A missing or mismatched snapshot is a hard, actionable error.
- Comparison arms retain their own resolved snapshots.
- Old artifacts remain replayable after names, text, costs, effects, or set membership change in the repository.

### G2. Add a real replay command

Provide a command such as:

```bash
npm run simulate -- --replay results/<experiment>/replays/<match>.json
```

It must:

- load the frozen environment;
- validate every schema and hash;
- replay the recorded actions from the original initial seed/state;
- compare resulting state/events/outcome with the stored bundle;
- print the first divergence with sequence, action, and expected/actual values;
- return nonzero on divergence;
- optionally emit a readable event trace;
- work without access to the original experiment config or current bundled set.

Add a regression test that writes a replay, changes the in-memory current card definition, and proves the replay still reproduces from the frozen snapshot.

### G3. Separate hashes by meaning

The simulator currently hashes complete card definitions. Presentation-only edits can therefore invalidate experiments even though they cannot change match behavior.

Record at least:

- `mechanicsHash`: executable rules only;
- `pilotInputHash`: mechanics plus metadata the pilots/generator actually use, such as roles, tags, power class, and archetypes;
- `presentationHash`: names, display text, curated help, and other player-facing content;
- `fullContentHash`: complete resolved snapshot.

Use the correct hash for the correct guarantee:

- engine replay equivalence uses `mechanicsHash`;
- automated-pilot equivalence uses `pilotInputHash` plus pilot versions/config hashes;
- content/build identity uses `fullContentHash`;
- reports show all relevant hashes.

---

## 10. Gate H — telemetry and analysis readiness for new mechanics

### H1. Make telemetry support explicit

For every mechanic selected for Batch 1, determine what causal evidence is required.

Examples:

- trigger count and source;
- cards/units/tokens produced;
- damage prevented, redirected, or amplified;
- counters added/removed;
- cost reduction actually used, not merely available;
- cards tutored versus naturally drawn;
- sacrifice paid as cost versus resolved as effect;
- alternate-win progress;
- continuous bonuses applied over card-turns;
- failed effects due to no target/capacity.

Do not infer all of this from final state. Extend structured events and the collector where necessary.

### H2. Validate causal attribution

Required tests for each new mechanic:

- the source receives credit after leaving play if its queued/triggered effect resolves;
- tokens and copied effects retain the correct source definition;
- sacrifice costs are not double-counted as voluntary card plays;
- prevention records prevented amount, not printed shield amount;
- multiplayer effects attribute each affected opponent separately;
- telemetry totals reconcile with event logs;
- unsupported telemetry downgrades analysis rather than fabricating zero.

### H3. Keep raw evidence primary

The simulator must continue to:

- stream raw match records;
- pair controlled comparisons correctly;
- label heuristic conclusions as evidence;
- retain abnormal replays;
- refuse to call cards balanced or overpowered automatically;
- report insufficient data explicitly.

---

## 11. First-batch testing protocol

Create `docs/testing/FIRST_CARD_BATCH_TEST_PLAN.md` and checked-in experiment templates.

### Stage 1 — content and mechanic validation

For every card:

- strict schema/content validation;
- generated explanation snapshot;
- one deterministic rules scenario exercising its primary mechanic;
- one negative/edge scenario where relevant;
- reachability check for every ability;
- pilot/telemetry support status.

No balance conclusions.

### Stage 2 — random-legal robustness

- all declared seed decks;
- every Commander;
- mirrored 1v1 games;
- many deterministic seeds;
- strict failure on illegal action, loop safeguard, engine error, missing choice, serialization failure, or telemetry mismatch.

Goal: find rules defects and nonterminating interactions.

### Stage 3 — scripted interaction matrix

Test every high-risk interaction deliberately:

- simultaneous defeat;
- sacrifice plus defeat triggers;
- source leaves before queued effect;
- static source leaves and Health bonuses disappear;
- full unit/relic zones;
- missing/invalidated targets;
- deck-out during multi-draw;
- multiple triggers in deterministic order;
- copied/created tokens;
- each selected keyword versus every relevant keyword;
- Commander-zone event triggers;
- selected alternate-win/counter rules if present.

Goal: verify semantics, not win rates.

### Stage 4 — reference-deck pilot calibration

- at least one human-authored seed deck per primary archetype;
- at least one counter deck for each primary archetype;
- published pilot profile plus bounded perturbations;
- decision traces retained for a small sample;
- manually inspect whether pilots use payoffs, preserve engine pieces, choose sensible targets, and recognize lethal/defense.

If a pilot repeatedly misplays an archetype, improve/replace that pilot or mark the archetype unsupported. Do not “balance” cards around a known bad pilot.

### Stage 5 — exploratory batch testing

- mirrored 1v1 schedule;
- common seeds across candidate changes;
- reference decks plus plan-generated variants;
- raw card metrics, matchup matrix, first-seat advantage, match length, deck-out share, and abnormal share;
- pilot-support caveats in every report.

Goal: find large outliers and dead cards, not final numbers.

### Stage 6 — evolutionary abuse search

- seed population from coherent deck plans;
- keep unconstrained discovery population separate;
- multiple search replicates;
- opponent archive;
- inspect discovered deck lists and decision traces;
- run controlled removal and insertion experiments on suspicious cards;
- rerun findings under pilot perturbations and counter decks.

Goal: discover combinations humans did not explicitly seed.

### Stage 7 — human sanity check

Before accepting a balance change:

- play or spectate representative matches;
- check whether the automated line resembles a reasonable player line;
- check fun, clarity, agency, and counterplay;
- record qualitative findings separately from simulator statistics.

Only after this stage should a card move from `playtest` toward `active`.

---

## 12. Required automated tests

Add regression coverage for at least these areas:

1. true insertion variants;
2. paired insertion results;
3. per-card source-file discovery order;
4. stale generated content detection;
5. card scaffolder refuses overwrite;
6. set/format isolation;
7. prototype cards excluded from the first-playtest pool;
8. strict real-set warning policy;
9. filename/ID agreement;
10. controlled archetype registry;
11. multi-role metadata migration;
12. Commander unreachable-trigger rejection;
13. `while_source_present` expiry or schema rejection;
14. inert keywords have zero pilot value;
15. exhaustive effect-scoring registry;
16. static ability magnitude/scope valuation;
17. exact-effect choice provenance;
18. mixed helpful/hostile card target selection;
19. mechanic-support matrix completeness;
20. balance flag downgrade for `legal_only` pilot support;
21. deck-plan generation produces legal coherent decks;
22. mutation preserves required packages when configured;
23. frozen environment snapshot validation;
24. replay after current bundled cards change;
25. replay divergence reporting;
26. mechanics/pilot/presentation hash separation;
27. new trigger event scope and filters;
28. Commander-zone triggers observe friendly events without pretending the Commander acted;
29. selected value/condition primitives, if introduced;
30. telemetry attribution for every selected new mechanic;
31. every first-batch card has an executable scenario;
32. every seed deck completes matches under random-legal pilots;
33. heuristic pilots complete matches for every fully supported archetype;
34. worker-count and resume determinism remain unchanged;
35. all existing 679 tests remain passing unless an intentionally changed rule has an updated replacement test.

Use small synthetic fixtures for semantic tests. Do not rely on the first real card pool accidentally producing the necessary board state.

---

## 13. Implementation sequence

Claude may implement this readiness milestone in one run, but must proceed through gates and keep verification green.

1. Record the audited baseline and run `npm run verify` plus `npm run format:check`.
2. Implement genuine insertion experiments and their tests.
3. Freeze resolved environments and add the replay command.
4. Fix pilot inert-keyword scoring and exact-choice provenance.
5. Make mechanic scoring/support registries exhaustive.
6. Resolve `while_source_present` by implementation or schema removal.
7. Apply the chosen Commander-zone model and reject unreachable abilities.
8. Split prototype fixtures from selectable real formats.
9. Introduce per-card source files, deterministic content compilation, and scaffolding.
10. Add set/design metadata, controlled archetypes, and strict validation policies.
11. Add environment card patches and meaningful hash separation.
12. Implement event-scoped triggers.
13. Implement only the additional expressions/conditions/counters required by the approved first-batch design.
14. Add deck plans, seed decks, capability reporting, and testing templates.
15. Update all docs and status files to one consistent current state.
16. Pin Node, add CI, and make clean verification authoritative.
17. Run all existing and new tests, content validation, smoke experiments, replay tests, build, and formatting checks.

Stop only when:

- a game-design choice in Gate D or B3 is genuinely unresolved;
- implementing a selected first-batch mechanic requires choosing semantics not recorded in the design brief;
- backward compatibility cannot be preserved through a documented migration;
- determinism, information boundaries, or replay truthfulness would be compromised.

Do not stop merely because balance values are provisional.

---

## 14. Definition of done

This readiness milestone is complete only when all of the following are true:

- Phase 4 insertion controls are real and tested.
- All status documents agree that Phase 4 and the help milestone are complete.
- The repository has one pinned, supported Node version and clean CI.
- `npm run verify` includes formatting and content compilation checks.
- Prototype fixture cards are isolated from the first real playtest format.
- Real cards live one-per-file under an explicit set manifest.
- A single command scaffolds a new card safely.
- Playtest sets use strict validation.
- Accepted mechanics cannot silently do nothing or behave with the wrong duration.
- The first-batch Commander model is explicit and mechanically consistent.
- The first-batch color/faction and archetype matrix is documented.
- Every playtest card's engine/help/pilot/telemetry support is known.
- Pilots do not value inert or unreachable mechanics.
- Pending choices expose exact structured intent.
- Resolved environments are frozen in experiment artifacts.
- A single replay bundle reproduces after the repository's current card data changes.
- Every first-batch card has at least one deterministic semantic scenario.
- Every primary first-batch archetype has a legal seed deck, a deck plan, a counter deck, and a supported pilot strategy or an explicit limitation.
- Random-legal robustness, heuristic calibration, and evolutionary discovery are treated as different evidence layers.
- All automated findings remain review guidance with raw evidence and limitations attached.
- The complete clean verification suite passes.

Only then should the first real card batch move from design notes into executable card JSON and large agent-driven balance runs.

---

## 15. Explicit non-goals

Do not use this milestone to add:

- every archetype from the vault catalogue;
- a generic programming language in card JSON;
- arbitrary user-authored scripts;
- an MTG stack or priority system;
- Commander combat unless Gate B3 explicitly chooses it;
- machine learning;
- public matchmaking or accounts;
- a rarity/pack economy;
- final lore or art for cards Claude has not been asked to design;
- automatic declarations that a card is “balanced” or “overpowered.”

The catalogue is a map of future design space, not a demand to implement every mechanic now.

---

## Instruction for Claude

> Implement the complete pre-card-pool and agent-testing readiness specification in `PRE_CARD_AND_AGENT_TESTING_READINESS.md`. Preserve all working Phase 1–4 and player-help behavior. Progress through the implementation sequence automatically while each gate passes. Do not author the first real card batch yet. Stop only for a genuinely unresolved game-design decision identified by this specification, an incompatible migration that cannot be handled honestly, or a change that would compromise deterministic replay, hidden-information safety, or experimental truthfulness.
