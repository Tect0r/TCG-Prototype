# Status audit

GENERATED FILE — do not edit. Rebuild with `npm run audit:status`. Every number below the derived-facts marker is read out of the code and content it describes, and `scripts/lib/status-audit.test.ts` fails when this file and the collector disagree.

## Audit run

A measurement rather than a derivation, so it is not re-checked by the drift test:
reproducing it means running the suite again.

| Reading          | Value                                       |
| ---------------- | ------------------------------------------- |
| Commit           | `f4a7884fa76eeb82090e598ba5a4adc637440154`  |
| Working tree     | dirty — the audit includes uncommitted work |
| Taken on         | 2026-09-01                                  |
| Node             | v24.15.0                                    |
| `npm run verify` | not run for this audit                      |

### Verification chain

`npm run verify` runs 7 steps, in order:

1. `npm run content:check`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run format:check`
5. `npm run validate:content`
6. `npm run test`
7. `npm run build`

### Tests

| Vitest project | Files   | Tests    |
| -------------- | ------- | -------- |
| admin-client   | 14      | 278      |
| admin-server   | 27      | 577      |
| packages       | 95      | 2278     |
| scripts        | 4       | 69       |
| server         | 17      | 345      |
| simulator      | 27      | 477      |
| web-client     | 20      | 272      |
| **total**      | **204** | **4296** |

Enumerated with `vitest list`, which collects every case without running it.

<!-- audit:derived:start -->

## Versions

Read from the constants themselves. A version below is what the software
stamps today, not what a document remembers it stamping.

### Play contract

What a client, a server and a saved deck must agree on to play at all.

| Constant                        | Value | Pins                                                                                         |
| ------------------------------- | ----- | -------------------------------------------------------------------------------------------- |
| `RULES_VERSION`                 | 1.0.0 | The rules configuration.                                                                     |
| `PROTOCOL_VERSION`              | 11    | Every message shape, refused at the handshake.                                               |
| `MATCH_SCHEMA_VERSION`          | 7     | Serialized match state.                                                                      |
| `CARD_SCHEMA_VERSION`           | 5     | A card definition, owned per set by its manifest.                                            |
| `DECK_SCHEMA_VERSION`           | 1     | A saved deck.                                                                                |
| `FORMAT_SCHEMA_VERSION`         | 1     | A play format and its construction rules.                                                    |
| `PRECON_SCHEMA_VERSION`         | 1     | A bundled precon definition.                                                                 |
| `DECK_PLAN_SCHEMA_VERSION`      | 1     | A deck's authored package structure.                                                         |
| `CONTENT_BUNDLE_SCHEMA_VERSION` | 2     | The generated bundle envelope (`packages/card-data/src/data/generated/content-bundle.json`). |
| `GLOSSARY_SCHEMA_VERSION`       | 1     | The player-facing glossary.                                                                  |
| `RULEBOOK_SCHEMA_VERSION`       | 1     | The in-app rulebook.                                                                         |

### Recorded artifacts

Documents a finished run leaves behind. Every move so far has been a refusal rather than a migration.

| Constant                              | Value | Pins                                                           |
| ------------------------------------- | ----- | -------------------------------------------------------------- |
| `SPECTATOR_REPLAY_VERSION`            | 6     | A spectator replay log.                                        |
| `BOARD_TELEMETRY_VERSION`             | 3     | The shared board-size and attack-opportunity schema.           |
| `TELEMETRY_SCHEMA_VERSION`            | 6     | A simulator match record.                                      |
| `MATCH_STREAM_HEADER_VERSION`         | 1     | `matches.header.json`, which decides whether a run may resume. |
| `REPORT_SCHEMA_VERSION`               | 9     | `report.md`.                                                   |
| `MANIFEST_SCHEMA_VERSION`             | 8     | `manifest.json`.                                               |
| `SUMMARY_SCHEMA_VERSION`              | 10    | `summary.json`.                                                |
| `MATCHUP_MATRIX_SCHEMA_VERSION`       | 2     | `matchup-matrix.json` and its CSV.                             |
| `SEARCH_CHECKPOINT_VERSION`           | 3     | A deck-search checkpoint.                                      |
| `RESOLVED_ENVIRONMENT_SCHEMA_VERSION` | 1     | A frozen environment snapshot.                                 |
| `REFERENCE_POPULATION_VERSION`        | 1     | A shared reference population.                                 |
| `CONFIG_SCHEMA_VERSION`               | 1     | An experiment configuration file.                              |
| `SEED_DERIVATION_VERSION`             | 2     | How every seed in a run is derived.                            |
| `HASH_VERSION`                        | 1     | How a hash over content or configuration is taken.             |

### Bot seats

What a bot seat is configured by. Independent of the play contract on purpose (ADR 0024 §7): a difficulty can improve, and a pacing dial can move, without a card, a rule or a message shape changing.

| Constant                      | Value | Pins                                                                                                                                                                                          |
| ----------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOT_CONFIG_SCHEMA_VERSION`   | 2     | One bot seat's configuration — controller, difficulty, style, deck source and pacing.                                                                                                         |
| `DIFFICULTY_REGISTRY_VERSION` | 3     | Which difficulty IDs exist and what each claims. Available today: easy, normal, hard.                                                                                                         |
| `PACING_CONFIG_VERSION`       | 1     | The bot pacing budget shape and the percentage-to-delay calculation. Not a rules version.                                                                                                     |
| `BOT_SUMMARY_SCHEMA_VERSION`  | 1     | One match’s bot pacing and provenance summary, as broadcast at completion and exported to a file. Separate from `PROTOCOL_VERSION`, which an exported file has no handshake to be refused at. |
| `DECK_FINGERPRINT_VERSION`    | 1     | How a saved deck frozen into bot configuration is fingerprinted, so a browser and the server agree. Separate from `HASH_VERSION`, which is the simulator’s content address.                   |

### Admin surface

The AI Lab's own contract versions (ADR 0023 §7). Independent of the play contract because an admin client and an admin server can disagree without any card, match or protocol meaning having changed — and independent of each other because a stored document is read by a build with no counterpart to negotiate with.

| Constant                   | Value | Pins                                                                                                                                   |
| -------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_CONTRACT_VERSION`   | 6     | The request and response language `apps/admin-client` and `apps/admin-server` speak. Compared per request.                             |
| `CATALOG_DOCUMENT_VERSION` | 3     | A persisted catalog batch or job document. Compared when a file is read, and refused rather than migrated when it names a newer build. |

### Registries and instruments

Classifications a citation is made against. A move here re-judges evidence rather than refusing it.

| Constant                          | Value | Pins                                                                                                                                                                      |
| --------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPPORT_REGISTRY_VERSION`        | 2     | How well each mechanic is supported, in four dimensions.                                                                                                                  |
| `ARCHETYPE_REGISTRY_VERSION`      | 1     | The archetype vocabulary and the roles each one requires.                                                                                                                 |
| `KEYWORD_REGISTRY_SCHEMA_VERSION` | 1     | The keyword registry entry shape.                                                                                                                                         |
| `AGENT_CLASS_REGISTRY_VERSION`    | 1     | Which agent class may make which evidence claim.                                                                                                                          |
| `CALIBRATION_SUITE_VERSION`       | 2     | The tactical fixtures a calibration standing was measured on.                                                                                                             |
| `TACTICS_REGISTRY_VERSION`        | 1     | Which tactical profiles a pilot can be built with — the scoring half of a difficulty. Today: baseline, hard_tactical. A profile's own behaviour version moves separately. |
| `STALL_DEFINITION_VERSION`        | 1     | The rule a quiet round is judged a stall by.                                                                                                                              |
| `PERTURBATION_PROFILE_VERSION`    | 1.0.0 | How a pilot is perturbed for a robustness arm.                                                                                                                            |
| `DECK_GENERATOR_VERSION`          | 1     | The construction procedure a generated deck cites. Runs on node only.                                                                                                     |
| `pilot random_legal`              | 1.0.0 | Decision procedure; agent class `random_legal`.                                                                                                                           |
| `pilot aggressive`                | 1.1.0 | Decision procedure; agent class `generic_heuristic`.                                                                                                                      |
| `pilot defensive`                 | 1.1.0 | Decision procedure; agent class `generic_heuristic`.                                                                                                                      |
| `pilot value`                     | 1.1.0 | Decision procedure; agent class `generic_heuristic`.                                                                                                                      |

## Content

### Sets

| Set              | Status      | Card schema | Playable cards | Tokens | Unimplemented | No pilot values | No record observes |
| ---------------- | ----------- | ----------- | -------------- | ------ | ------------- | --------------- | ------------------ |
| `precon_wave_1`  | playtest    | v5          | 152            | 3      | 0             | 0               | 39                 |
| `prototype_core` | development | v5          | 52             | 4      | 0             | 1               | 15                 |

### Formats

| Format          | Sets             | Pool | Deck size | Singleton | Max Commander colours | Banned |
| --------------- | ---------------- | ---- | --------- | --------- | --------------------- | ------ |
| `development`   | `prototype_core` | 56   | 30        | no        | 2                     | 0      |
| `precon_wave_1` | `precon_wave_1`  | 155  | 40        | yes       | 2                     | 0      |

### Precons

| Precon                       | Format          | Commander                   | Colours | Cards | Legal | Plan                       | Colour-legal pool |
| ---------------------------- | --------------- | --------------------------- | ------- | ----- | ----- | -------------------------- | ----------------- |
| `precon_bastion_guardians`   | `precon_wave_1` | `bastion_commander`         | white   | 40    | yes   | `plan_bastion_guardians`   | 42 (+2)           |
| `precon_containment_control` | `precon_wave_1` | `chief_containment_scholar` | blue    | 40    | yes   | `plan_containment_control` | 41 (+1)           |
| `precon_goblin_swarm`        | `precon_wave_1` | `goblin_warboss`            | red     | 40    | yes   | `plan_goblin_swarm`        | 41 (+1)           |
| `precon_grave_sacrifice`     | `precon_wave_1` | `grave_matriarch`           | black   | 40    | yes   | `plan_grave_sacrifice`     | 42 (+2)           |

The last column is the cards a Commander's colour identity allows against the deck size it has to fill.

### Deck plans

| Plan                       | Precon                       | Archetype           | Packages | Core | Slots | Share of deck |
| -------------------------- | ---------------------------- | ------------------- | -------- | ---- | ----- | ------------- |
| `plan_bastion_guardians`   | `precon_bastion_guardians`   | defensive_attrition | 6        | 4    | 27    | 68%           |
| `plan_containment_control` | `precon_containment_control` | reactive_control    | 6        | 5    | 29    | 73%           |
| `plan_goblin_swarm`        | `precon_goblin_swarm`        | token_swarm         | 5        | 3    | 28    | 70%           |
| `plan_grave_sacrifice`     | `precon_grave_sacrifice`     | sacrifice_value     | 6        | 4    | 29    | 73%           |

A plan may cover at most 75% of a deck, enforced by the content build, so every
plan-generated deck keeps free slots no generator setting can take away.

## Coverage

| Instrument                    | Reading                                  |
| ----------------------------- | ---------------------------------------- |
| Card behaviour contracts      | 155 of 155 cards in `precon_wave_1`      |
| Tactical calibration fixtures | 24, of which 11 record a known pilot gap |
| Glossary entries              | 35                                       |
| Rulebook sections             | 19                                       |

| Pilot        | Fixtures it misses |
| ------------ | ------------------ |
| `aggressive` | 9                  |
| `defensive`  | 10                 |
| `value`      | 10                 |

## Mechanic support

63 classified mechanics across seven executable vocabularies.

| Dimension | Levels                               |
| --------- | ------------------------------------ |
| engine    | full 62, none 1                      |
| help      | full 63, partial 0, none 0           |
| pilot     | full 4, approximate 58, legal_only 1 |
| telemetry | full 10, partial 22, none 31         |

The engine does not execute (1):

`keyword:resilient`

No pilot values (1):

`keyword:resilient`

No match record observes (31):

`condition:active_turn`, `condition:count`, `condition:previous_step`, `condition:source_state`, `cost:exhaust_source`, `effect:counter`, `effect:exhaust`, `effect:grant_keyword`, `effect:modify_stats`, `effect:prevent_damage`, `effect:ready`, `effect:remove_keyword`, `effect:reorder_zone`, `effect:return_to_hand`, `effect:search_zone`, `keyword:armored`, `keyword:barrier`, `keyword:evasive`, `keyword:guardian`, `keyword:overwhelm`, `keyword:quick_strike`, `keyword:resilient`, `keyword:rush`, `keyword:siphon`, `keyword:untargetable_by_opponents`, `keyword:venom`, `static_effect:grant_keyword`, `static_effect:modify_stats`, `value:count`, `value:previous_targets`, `value:stat`

## Known limitations

- Keywords the engine does not execute: resilient. Barred from a `playtest` or `active` set by the content build, so no shipped card carries one (Q4).
- Of 63 classified mechanics, no pilot values 1 and no counter records 31. Both lists are in the section above.
- Set `precon_wave_1` (playtest): 0 card(s) marked `implemented: false`; no pilot values 0 of its cards; no match record observes 39.
- `precon_bastion_guardians` has 42 colour-legal cards for a 40-card deck (2 spare). A package-scale mutation has nowhere to put what it frees.
- `precon_containment_control` has 41 colour-legal cards for a 40-card deck (1 spare). A package-scale mutation has nowhere to put what it frees.
- `precon_goblin_swarm` has 41 colour-legal cards for a 40-card deck (1 spare). A package-scale mutation has nowhere to put what it frees.
- `precon_grave_sacrifice` has 42 colour-legal cards for a 40-card deck (2 spare). A package-scale mutation has nowhere to put what it frees.
- No pilot in this build implements agent class(es): archetype_aware, human_playtest. Every claim resting on one is declined by every run this build can produce.
- 11 of 24 calibration fixtures record a pilot that misses the characteristic decision. The record is asserted in both directions, so a closed gap fails as loudly as a regression.

## Question ledger

`docs/open-questions.md` against the owner-decision list in `IMPLEMENTATION_PLAN.md`.

| Question | Title                                                                  | Question file | Listed open in the plan |
| -------- | ---------------------------------------------------------------------- | ------------- | ----------------------- |
| Q1       | Do `effects` and `abilities` collapse into one form? — answered 202... | answered      | no                      |
| Q2       | How are static / continuous abilities expressed? — answered 2026-08-07 | answered      | no                      |
| Q3       | Is `sacrifice` a cost or an effect? — answered 2026-08-07              | answered      | no                      |
| Q4       | What should `resilient` do, or should it be deleted?                   | open          | yes                     |
| Q5       | What happens to a Commander after battlefield defeat? — answered 20... | answered      | no                      |
| Q6       | Is there an alternate victory condition?                               | open          | no                      |
| Q7       | What is the client/server protocol contract? — answered 2026-08-07     | answered      | no                      |
| Q8       | What is the turn/action timeout policy?                                | open          | no                      |
| Q9       | Should a match survive a server restart?                               | open          | no                      |
| Q10      | Multiplayer combat and targeting — answered 2026-08-07                 | answered      | no                      |
| Q11      | Priority order for simultaneous triggers — answered 2026-08-07         | answered      | no                      |
| Q12      | Elimination semantics — answered 2026-08-07                            | answered      | no                      |
| Q13      | Team play — in or out? — answered 2026-08-07                           | answered      | no                      |
| Q14      | What thresholds should actually gate a card change?                    | open          | no                      |
| Q15      | How is "a healthy plural meta" measured?                               | open          | no                      |
| Q16      | Simulator determinism boundary — answered 2026-08-08                   | answered      | no                      |
| Q17      | Colour identity — names, count, and what each colour does              | open          | no                      |
| Q18      | Does creating a coloured Token leak colour identity into the creator?  | open          | no                      |
| Q19      | Is 40-card singleton with a two-colour Commander cap right?            | open          | no                      |
| Q20      | Should `displayText` be generated from structured effects?             | open          | no                      |
| Q21      | Localisation                                                           | open          | no                      |
| Q22      | Is 768 × 1024 px the right art size?                                   | open          | no                      |
| Q23      | Should an effect be able to target a player directly? — answered 20... | answered      | no                      |
| Q24      | Does a sacrificed unit also trigger `on_defeated`? — answered 2026-... | answered      | no                      |
| Q25      | Must a search find something if a legal card exists? — answered 202... | answered      | no                      |
| Q26      | Is player healing capped? — answered 2026-08-07                        | answered      | no                      |
| Q27      | Is the activated-ability shape right? — answered 2026-08-07            | answered      | no                      |
| Q28      | Should a trigger created mid-card resolve before the rest of that c... | answered      | no                      |
| Q29      | Confirm the `targetsSource` addition to the target schema — answere... | answered      | no                      |
| Q30      | Is strict stale-revision rejection the behaviour you want? — answer... | answered      | no                      |
| Q31      | How is seat order determined? — answered 2026-08-08                    | answered      | no                      |
| Q32      | Is `removed` a real zone, and does elimination reveal hidden inform... | answered      | no                      |
| Q33      | What order does `all_players` resolve in? — answered 2026-08-08        | answered      | no                      |
| Q34      | Does the disconnect grace window run while it is not that player's ... | open          | no                      |
| Q35      | Do three- and four-player matches need different rule values?          | open          | no                      |
| Q36      | Who controls the lobby, and can its size change after players join?... | answered      | no                      |
| Q37      | Should the pilots be better players than they are?                     | open          | no                      |
| Q38      | When is a multiplayer balance run worth it?                            | open          | no                      |
| Q39      | What is the Reaction chaining and ordering policy? — answered 2026-... | answered      | no                      |
| Q40      | Should root `cards.json` and `precons.json` be deleted? — answered ... | answered      | no                      |
| Q41      | Are unimplemented cards visible in the deck builder, and is there a... | answered      | no                      |
| Q42      | What makes two Tokens "identical" for visual stacking? — answered 2... | answered      | no                      |
| Q43      | What counts as a board stall? — answered 2026-08-12                    | answered      | no                      |
| Q44      | Do you want multiple blockers per attacker, and if so, when?           | open          | yes                     |
| Q45      | Is Barrier consumed before or after other prevention and reduction?    | open          | yes                     |
| Q46      | May a Reaction carry an additional cost?                               | open          | yes                     |
| Q47      | May a Reaction answer another Reaction? — answered 2026-08-14          | answered      | no                      |
| Q48      | Five Goblin cards say "enters the battlefield" and behave as "when ... | answered      | no                      |
| Q49      | Does a Token count as a Unit? — answered 2026-08-20                    | answered      | no                      |
| Q50      | Is Hard good enough to publish? — answered 2026-08-20, discharged 2... | answered      | no                      |
| Q51      | Keep the card-in-hand price, or keep Hard's win rate? — open           | open          | yes                     |
| Q52      | Should `pilotSpecSchema`'s overrides stop carrying the generic vector? | open          | no                      |

16 question(s) are open in the question file and not on the plan's
short list, which is the curated set a tranche might have to stop on rather than an index.

No question the plan calls open is missing or answered in the question file.

## Repository inventory

| Reading                                  | Value                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspaces                               | `packages/admin-contracts`, `packages/board-telemetry`, `packages/bot-config`, `packages/bot-interface`, `packages/card-data`, `packages/deck`, `packages/deck-generator`, `packages/help-content`, `packages/protocol`, `packages/rules-engine`, `packages/shared`, `packages/spectator`, `apps/admin-client`, `apps/admin-server`, `apps/multiplayer-server`, `apps/simulator`, `apps/web-client` |
| Root files                               | `CLAUDE.md`, `IMPLEMENTATION_PLAN.md`, `README.md`, `eslint.config.js`, `package-lock.json`, `package.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`                                                                                                                                                                                                                              |
| Root Markdown beyond the three permitted | none                                                                                                                                                                                                                                                                                                                                                                                                |
| Architecture decision records            | 24                                                                                                                                                                                                                                                                                                                                                                                                  |
| Milestone documents                      | 9                                                                                                                                                                                                                                                                                                                                                                                                   |

### Architecture decision records

| File                                                     | Title                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `0001-monorepo-and-tooling.md`                           | ADR 0001 — Monorepo layout and toolchain                                             |
| `0002-card-data-model.md`                                | ADR 0002 — Card data model and structured effects                                    |
| `0003-deck-save-format.md`                               | ADR 0003 — Deck save format, migrations and persistence                              |
| `0004-artwork-resolution.md`                             | ADR 0004 — Artwork resolution and the card frame                                     |
| `0005-rules-engine.md`                                   | ADR 0005 — Deterministic rules engine (Phase 2A)                                     |
| `0006-network-protocol.md`                               | ADR 0006 — Network boundary and authoritative server (Phase 2B)                      |
| `0007-free-for-all-state.md`                             | ADR 0007 — Free-for-all state, choices and combat (Phase 3)                          |
| `0008-continuous-effects.md`                             | ADR 0008 — Continuous effects and static abilities                                   |
| `0009-bot-information-boundary.md`                       | ADR 0009 — The bot information boundary (Phase 4)                                    |
| `0010-seed-derivation-and-reproducibility.md`            | ADR 0010 — Seed derivation and reproducibility (Phase 4)                             |
| `0011-telemetry-and-provenance.md`                       | ADR 0011 — Telemetry, provenance and dead-hand categories (Phase 4)                  |
| `0012-experiment-storage-and-checkpointing.md`           | ADR 0012 — Experiment storage, streaming and checkpointing (Phase 4)                 |
| `0013-statistical-contracts.md`                          | ADR 0013 — Statistical contracts for the balance laboratory (Phase 4 hardening)      |
| `0014-unified-match-stream-and-reference-populations.md` | ADR 0014 — One match stream, and immutable reference populations (Phase 4 hardening) |
| `0015-player-help-and-content.md`                        | ADR 0015 — Player help and the data-driven content system                            |
| `0016-precon-wave-1-ruleset.md`                          | 16. Precon Wave 1 ruleset — format, battlefield, Relics, Commanders, Reactions       |
| `0017-optional-instructions-and-interactive-costs.md`    | 17. Optional instructions, "if you do", and costs a player chooses                   |
| `0018-delayed-and-replacement-effects.md`                | ADR 0018 — Delayed effects, replacements, and the Ready Step                         |
| `0019-precon-identity.md`                                | ADR 0019 — A precon is an identity, not a decklist                                   |
| `0020-board-telemetry-and-stall-definition.md`           | ADR 0020 — Board telemetry: one collector, two feeds, and a versioned stall          |
| `0021-choice-contract.md`                                | ADR 0021 — The choice contract: who is asked, what the answer is, and why            |
| `0022-evidence-claims.md`                                | ADR 0022 — What a run may be cited for: support, pilots, decks, calibration          |
| `0023-admin-lab-boundary.md`                             | ADR 0023 — The AI Lab admin boundary: app, service, catalog and access               |
| `0024-live-bot-seats.md`                                 | ADR 0024 — Live bot seats: authority, privacy, pacing and the shared generator       |

<!-- audit:derived:end -->
