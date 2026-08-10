# Readiness milestone — progress log

Working notes for the implementation of `PRE_CARD_AND_AGENT_TESTING_READINESS.md`.
Delete this file when the milestone is done.

**Last updated:** 2026-08-10, Gate G complete.

---

## ⚠️ Repository state right now

`npm run verify` **will fail in exactly one way**, and it is the intended
temporary one:

- `package.json#scripts.verify` starts with `npm run content:check`, which points
  at `packages/card-data/src/content/cli.ts` — **not written yet** (Gate C1).
  Same for `cards:new` → `scripts/new-card.ts` (Gate C2).

Everything after that step passes: typecheck, lint, `format:check`,
`validate:content`, **727 tests across 44 files**, and the production build.

To get a fully green tree quickly if needed, drop `npm run content:check &&` from
the `verify` script.

---

## Baseline (recorded, unchanged)

- Commit `5f13d248bf1fc645ce830dced63fee22414f683f` ("Helper Ui").
- Node `24.15.0`, npm 11.12.1.
- `npm run verify` passed: **679 tests across 42 files**, clean build.
- Only formatting deviation was `PRE_CARD_AND_AGENT_TESTING_READINESS.md` itself
  (quote style inside fenced code blocks); it has been prettier-formatted.

---

## Design decisions already taken (do not re-litigate)

| Spec item                       | Decision                                                                                                                                                                                                                                                                                                    | Rationale                                                                                                                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B1 `while_source_present`**   | Implement the **preferred** solution: source-bound expiry, consistently, for stat / keyword / cost / prevention modifiers. Additionally reject the duration where the source cannot persist (a spell's own top-level effects).                                                                              | `staticAbilities` already covers lords/auras correctly, but it cannot express "the _chosen_ unit gets +2/+0 while this relic is out". Removing the duration would leave that hole; implementing it closes the accepted-but-wrong state honestly. |
| **B2 inert keywords**           | Take the spec's recommendation: `guardian` and `resilient` stay prototype-only. Rejected in `playtest`/`active` sets, warned about in `development`/`draft`. Pilots must value them at zero.                                                                                                                | No need to invent rules to keep names.                                                                                                                                                                                                           |
| **B3 Commander model**          | Take the spec's recommendation: **Commanders remain non-combat leaders in the Commander zone.** Attack/Health become _optional_ on commanders, combat stats are not displayed for them, and self-combat triggers (`on_attack`, `on_block`, `on_survive_combat`) on a Commander are rejected in strict sets. | Making a required field optional is backward compatible; existing v2 data keeps loading. The three broken prototype Commanders are isolated by the fixture-set split rather than rewritten.                                                      |
| **Gate D (first-batch design)** | **This is the stop point.** Everything else gets built; `docs/design/FIRST_CARD_BATCH.md` gets drafted with recommendations and the colour/archetype/counterplay matrix is put to the user as a decision.                                                                                                   | §13 of the spec says to stop for "a game-design choice in Gate D or B3". B3 has a stated recommendation to accept; D genuinely does not.                                                                                                         |
| **Gate E2 primitives**          | Deferred and documented, because "only what Batch 1 needs" cannot be known until Gate D is answered. E1 (event-scoped triggers) is foundational and gets built regardless.                                                                                                                                  | Spec §7 E2 explicitly says defer and document in `docs/ADDING_CARDS.md`.                                                                                                                                                                         |
| **Replay bundles**              | **Embed** the frozen environment snapshot rather than referencing it by hash.                                                                                                                                                                                                                               | Makes a bundle standalone, which is what "works without access to the original experiment config" requires. Size is bounded by only snapshotting reachable cards.                                                                                |

---

## Gate status

| Gate                                      | Status                                              |
| ----------------------------------------- | --------------------------------------------------- |
| A1 — real insertion experiments           | ✅ **done, tested, verified end-to-end**            |
| A2 — mark Phase 4 complete in docs        | ⬜ not started (part of the docs pass)              |
| A3 — Node pin / CI / verify               | 🟡 mostly done; blocked on `content:check` existing |
| B1 — `while_source_present`               | ⬜ not started                                      |
| B2 — inert keyword policy                 | ⬜ not started                                      |
| B3 — Commander model                      | ⬜ not started                                      |
| B4 — fixture/real pool split              | ⬜ not started (folded into C1)                     |
| C1 — per-card sources + content build     | ⬜ not started                                      |
| C2 — card scaffolder                      | ⬜ not started                                      |
| C3 — design metadata + archetypes         | ⬜ not started                                      |
| C4 — strict validation modes              | ⬜ not started                                      |
| C5 — card patches                         | ✅ **done, tested** (with §9 below)                 |
| D — first-batch design brief              | ⬜ **user decision required**                       |
| E1 — event-scoped triggers                | ⬜ not started                                      |
| E2 — value/condition primitives           | ⬜ deliberately deferred                            |
| E3 — mechanic implementation contract     | ⬜ not started                                      |
| F1/F2 — pilot honesty + choice provenance | ⬜ not started                                      |
| F3 — mechanic-support matrix              | ⬜ not started                                      |
| F4 — agent-layer language                 | ⬜ not started                                      |
| F5 — deck plans + seed decks              | ⬜ not started                                      |
| G1 — frozen environments                  | ✅ **done, tested, verified end-to-end**            |
| G2 — replay command                       | ✅ **done, tested, verified end-to-end**            |
| G3 — hash separation                      | ✅ **done, tested**                                 |
| H — telemetry support/attribution         | ⬜ not started                                      |

---

## ✅ A1 — insertion experiments (complete)

Everything below is written, passing and exercised by a real experiment run.

**`apps/simulator/src/analysis/replacement.ts`**

- `replacementVariantSchema` gained `direction` (`removal` | `insertion`),
  `subjectPresentIn`, `removedCards`, `addedCards`, `selectionMethod`, `legal`.
- `insertionRemovalCandidates()` ranks the base deck's own cards by
  comparability to the inserted card (type, cost, role, power class, shared
  tags, uniqueness penalty).
- `buildInsertionVariant()` — checks pool membership, Commander colour legality
  and copy limits (unique vs ordinary), plans removals (explicit list, or
  round-robin down the ranking), builds, re-validates, and returns `null` rather
  than repairing.
- `planRemovals()` and `insertionConfoundsOf()` are the two helpers; the latter
  always emits the "inserted rather than swapped" confound and adds a
  **stress/control experiment** note when the deck shares no tag with the
  subject, plus a "measures the floor" note for a `build_around`/`centerpiece`.
- `quantityDeltas()` derives added/removed from the two card lists, so the
  removal path records its round-robin refill correctly too.
- `replacementImpact()` is now direction-aware: it works in terms of
  `withSubject` / `withoutSubject`, so **positive impact always means "the deck
  did better with the card"** in both directions. `ReplacementImpact` gained
  `direction`, `removedCards`, `addedCards`, `selectionMethod`.

**Elsewhere**

- `config.ts`: `insertionCopies` (default `1`) and `insertionRemoveCardIds`.
- `experiment.ts`: base decks that lack the subject now build a real insertion
  variant instead of only recording a note.
- `reporting/report.ts`: section renamed "Controlled replacement and insertion",
  new `Direction` and `Swapped for / paid by` columns, direction-aware confound
  prose.
- `analysis/flags.ts`: direction-aware flag messages.
- `index.ts`: new exports.
- `test-fixtures.ts`: `FIXTURE_UNIQUE_UNIT`, deliberately **not** in
  `FIXTURE_CARDS` — adding it there perturbs every seeded generated population
  in the suite (this broke `search.test.ts` and `telemetry.test.ts` once; the
  fix was to scope it to the one test that needs it).
- `experiments/replacement.json`: added `izzet_tempo_no_champion`, a legal
  blue/red deck that does _not_ run Pyre Champion, so the shipped example
  actually exercises the insertion arm. (A mono-red deck cannot do this — the
  prototype set has too few legal mono-red cards to build 30 without the
  Champion.)

**`apps/simulator/src/insertion.test.ts`** — 18 tests: legal insertion, multi-copy,
unique limit, at-limit refusal, no-legal-removal-candidate, colour illegality,
pool exclusion, ranked/explicit removal, build-around confounds, paired estimate,
sign convention, metadata passthrough, worker-count equivalence, small-sample
suppression, flag shape, report wording.

Fixture note: the signal only appears with the right opponent field. Base deck
`fixture_baseline_unit ×6 + prototype_scout ×6`, opponents `guard+scout` and
`guard+drone`, 16 games/pairing → impact `+0.44`, interval `[0.25, 0.63]`,
64 pairs. At 4 games/pairing the interval correctly spans zero.

**Verified**: `npx vite-node apps/simulator/src/cli.ts -- --config
experiments/replacement.json --output /tmp/xrepl --workers 2` → 240 matches, 0
abnormal, report shows removal _and_ insertion rows with distinct wording.

---

## 🟡 A3 — Node / CI / verify

Done:

- `.nvmrc` and `.node-version` → `24.15.0`.
- `package.json#engines.node` → `>=24.15.0 <25` (the lowest line `jsdom@30`
  accepts). Root `description` de-staled.
- `.github/workflows/verify.yml` — clean checkout, `npm ci`, `npm run verify`,
  Node from `.nvmrc`.
- README requirements section rewritten to quote the pinned version.
- `verify` script now: `content:check → typecheck → lint → format:check →
validate:content → test → build`.

Outstanding: `content:check` and `cards:new` targets do not exist yet
(Gates C1/C2). **This is why verify is currently red.**

---

## ✅ Gate G + C5 (complete)

### Module layout, and why

`content-hash.ts` is a **leaf**: it imports nothing from `environment.ts` or
`resolved-environment.ts`. That is deliberate. Both a live `Environment` and a
frozen snapshot must be hashed by the same code, and putting that code in either
of them creates a cycle. It owns `environmentHashesSchema`, the three projections
(`cardMechanics` / `cardPilotMetadata` / `cardPresentation`),
`computeEnvironmentHashes()`, and `snapshotCards()`.

`snapshotCards(pool, commanders, database)` decides **one** card set — the
playable cards plus transitively reachable tokens — and both `resolveEnvironment`
and `freezeEnvironment` hash exactly that set. This is what makes a frozen
snapshot's hashes _equal_ the live environment's rather than merely resemble
them; the earlier draft had the two computing over different lists.

Boundary decisions worth keeping: `tags` are **mechanical** (`CardFilter` matches
on them), and `unique` / `collectible` are **mechanical** (deck legality reads
them). `role`, `powerClass` and the future `design.*` block are pilot-input only.
Name / `displayText` / `text` are presentation only.

### What `hash` now means

`Environment.hash` = `fullContentHash`, `Environment.cardPoolHash` =
`mechanicsHash`, plus the full `hashes` object. Safe because `matchId` and every
seed derive from `environmentId`, **never** from a hash — so no seed moved and no
match was renamed. Only `environmentHash` in records changed value.

### 🐛 Defect found and fixed while testing C5

`cardPatchBodySchema` was built as `baseCardSchema.pick(…).partial()`. In Zod 4,
`.partial()` makes a field optional but **leaves its `.default()` in place**, and
the default fires when the key is absent. So `{"cost": 4}` parsed to
`{cost: 4, tags: [], keywords: [], effects: [], abilities: [], …}` — a one-number
balance edit that silently **deleted the card's rules text**.

Fixed by building the shape field-by-field and unwrapping `ZodDefault` (via
`.unwrap()`) before `.optional()`. The regression test is
`does not let a schema default overwrite a field the patch never named`.

The now-unreachable `null`-clearing loop in `applyCardPatch` was removed rather
than made reachable: "remove this field" is not a balance edit, and
`cardOverrides` already covers it.

### Everything else that landed

- `Environment` gained `hashes`, `sets` (empty until C1) and `formatId`.
- `resolveEnvironment` applies `cardOverrides` then `cardPatches`, hard-erroring
  on an unknown card ID and on a patch whose merged card fails re-validation.
- The C5 environment diff is derived automatically: `diffEnvironments` compares
  the two _resolved_ pools, so a patch shows up as exactly the fields it moved,
  and the report already printed the full before/after definitions.
- `experiment.ts#finish` writes `resolved-environment.json` plus
  `environments/<id>.<fullContentHash>.json` for every environment (comparison
  arms keep their own). Manifest and report carry all four hashes.
- `run-one.ts` embeds the frozen snapshot in every replay bundle, memoized per
  `Environment` in a `WeakMap` so freezing happens once per worker, not per match.
  `replayBundleSchema.environment` is now `resolvedEnvironmentSchema`, not
  `z.unknown()`.
- `replay.ts` + `--replay` / `--trace`. Verified end-to-end: a real smoke bundle
  reproduced 117 actions / 575 events exactly; a hand-corrupted event produced
  `DIVERGED`, sequence 41, the causing `submit_choice` action, expected vs actual,
  and exit 1.

### Test-design note worth keeping

The strongest replay test does not edit a bundled card — it plays the match with
`fixture_ephemeral_unit`, a card that exists **only** in that experiment's
`cardOverrides`. Nothing in `packages/card-data` defines it, so there is no
version to fall back to: a fallback surfaces as a hard failure instead of as a
subtly different match. `resolveEnvironment({id:'today'}).database.get(…)` is
asserted to be `undefined` in the same test, so the premise is checked too.

---

## Remaining work, in the order I intended to do it

1. **F1/F2** — pilot honesty. `packages/bot-interface/src/scoring.ts`:
   `keywordCount()` must filter by `IMPLEMENTED_KEYWORDS` (already exported from
   `@tcg/card-data`); `effectValue()` must become an exhaustive registry keyed by
   `EffectType` with no `default: return 0`, so a new effect type fails
   type-check until scoring exists; `cardValue`/`unitBoardValue` must value
   static abilities by magnitude/scope/board-count rather than
   `staticAbilities.length * buffValue * 2`.
   `heuristic.ts#sourceIsHostile` is the F2 defect — it inspects _every_ effect
   on the source card. Replace with structured provenance on `PendingChoice`
   (`packages/rules-engine/src/schema/choice.ts`): resolution item ID, effect
   index, effect type, source, chooser, target relation, semantic intent. Add
   mixed helpful/hostile regression cards.
2. **B1** — source-bound expiry. `damageShieldSchema` needs a
   `sourceInstanceId`; add an expiry pass to `queue.ts#settle` (or alongside
   `flow.ts#expireEndOfTurnEffects`) that drops a source-bound modifier when the
   source is no longer in `battlefield`/`commander_zone`, then runs state-based
   checks (losing a Health bonus can be lethal).
3. **B3** — Commander model. Optional `attack`/`health` for commanders in
   `card.ts`; hide combat stats for commanders in `CardFrame`/`CardInspector`;
   unreachable-trigger validation.
4. **C1/B4** — the big one. `content/sets/<set>/cards/*.json`, `set.json`
   manifests with `status`, `content/formats/*.json`, a deterministic compiler
   with `--check`, and the prototype set demoted to `development`. This is also
   what finally makes `verify` green again, and what fills in the `sets` /
   `formatId` fields Gate G left deliberately empty.
5. **C2/C3/C4** — scaffolder, design metadata + archetype registry, per-status
   validation policies. C3's `design.*` block already has its slot in
   `cardPilotMetadata()`, so adding it moves `pilotInputHash` and nothing else.
6. **E1** — event-scoped triggers.
7. **F3/F4/F5**, **H**.
8. Docs pass (A2 + `docs/testing/FIRST_CARD_BATCH_TEST_PLAN.md` + ADRs), then
   draft `docs/design/FIRST_CARD_BATCH.md` and **stop for the user's Gate D
   decision**.
9. Final verification.

---

## Things learned the hard way

- Adding a card to `FIXTURE_CARDS` changes the pool every `tinyEnvironment()`
  draws from, which changes every seeded generated population, which breaks
  `search.test.ts` and `telemetry.test.ts`. Scope one-test fixtures to that test.
- `cardDefinitionSchema` is wrapped by `superRefine`, so `.pick()` / `.partial()`
  must be taken from `baseCardSchema`.
- **Zod 4's `.partial()` does not strip `.default()`.** The field becomes
  optional, but the default still fires on an absent key. Any "subset of a
  schema" built that way silently materializes every default. Unwrap `ZodDefault`
  explicitly. This cost a real bug in `cardPatchBodySchema` — see Gate C5 above.
- A cross-field `superRefine` rule is the only thing a patch's _own_ schema
  cannot catch, so a test that a patch "produces an invalid card" has to pick a
  violation that is legal field-by-field (e.g. a spell patched to `effects: []`).
  Field-level violations are rejected earlier, by the patch body itself.
- Experiment labels are capped at 80 characters; the validator's error is a raw
  Zod dump, which is easy to misread as a config-loading failure.
- The tiny test environment's 12-card decks make matches decide on deck-out as
  often as on damage, so a "clearly stronger card" fixture needs its opponent
  field chosen deliberately, not assumed.
