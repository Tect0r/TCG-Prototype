# TCG Prototype — Phase 4 Hardening and Completion Specification

## 1. Purpose

Phase 4 is implemented and the monorepo currently passes its verification suite. This milestone is a **correctness and trustworthiness pass** over the simulator and balance laboratory. The goal is not to redesign the rules engine or add a new product phase. The goal is to ensure that experiments measure what they claim, reports use statistically honest language, large runs remain streamable and resumable, and every automated warning is supported by reproducible evidence.

Treat the existing repository as the source of truth. Preserve all working Phase 1–4 behavior unless this document explicitly requires a correction.

## 2. Current verified baseline

At the start of this work:

- Phases 1–3 are complete.
- Phase 4 simulator, pilots, batch execution, telemetry, deck generation, evolutionary search, replacement experiments, comparisons, and reporting are implemented.
- `npm run verify` passes.
- The latest recorded baseline is 544 passing tests in 35 files, with type-checking, linting, formatting, and production builds clean.

Run `npm run verify` before changing anything and record the actual current baseline. Do not assume the recorded number is still exact if the repository has advanced.

## 3. Non-negotiable constraints

- Do not change game rules to make simulator results look better.
- Do not create a second or simplified rules path for bots. All simulations must continue to use the authoritative shared rules engine and `legalActions` surface.
- Preserve seeded determinism, replayability, hidden-information boundaries, saved-deck compatibility, and online protocol behavior.
- Results must be independent of worker count, worker scheduling, chunk size, and resume boundaries.
- Raw measurements must remain available beside derived interpretations.
- Automated warnings are evidence for human review, not declarations that a card is objectively balanced or broken.
- Do not add machine learning in this milestone.
- Do not expand into Phase 5 real-player telemetry.
- Do not silently resolve open game-design questions such as keyword behavior, Commander combat, balance thresholds, or multiplayer rule values.

## 4. Required correction A — make the candidate fixture real

The example experiment in `experiments/candidate-vs-baseline.json` currently claims to compare Scorch at 2 damage against Scorch at 3 damage, while the baseline already deals 3 damage. This makes the flagship example misleading.

Correct it so that baseline and candidate differ by exactly one intentional, machine-verifiable gameplay change.

Requirements:

1. Choose one of these approaches:
   - change the candidate to a genuinely different Scorch value, such as 4 damage; or
   - add a dedicated test card whose baseline and candidate versions differ in one clearly named numeric parameter.
2. Keep all unrelated structured fields identical, including targeting filters, unless the experiment explicitly declares them as additional changes.
3. The experiment manifest must describe the actual structured diff, not merely a prose claim.
4. Before execution, validate that baseline and candidate pools differ as declared.
5. Reject a comparison whose declared changed card is structurally identical between pools.
6. Reject or prominently warn when undeclared fields differ.
7. Include the validated card-definition diff in the report.

Tests must prove that:

- an identical candidate fixture fails validation;
- a one-field numeric change passes;
- an undeclared targeting change is detected;
- the example comparison produces the expected structured diff.

## 5. Required correction B — true cross-cluster inclusion

`broad_cross_cluster_inclusion` must measure strategic-cluster coverage, not the percentage of individual decks containing a card.

### Required definitions

For card `c` and eligible strategic clusters `K`:

```text
cluster_inclusion(c, k) =
  number of eligible decks in cluster k containing c
  / number of eligible decks in cluster k

covered(c, k) = cluster_inclusion(c, k) >= withinClusterInclusionThreshold

cross_cluster_share(c) =
  number of eligible clusters for which covered(c, k) is true
  / number of eligible clusters
```

An eligible cluster must meet a configurable minimum number of decks and, where results depend on games, a configurable minimum number of observations. Tiny or noise clusters must not count equally to established clusters.

### Flag behavior

Raise `broad_cross_cluster_inclusion` only when all conditions are met:

- the card appears in at least `minimumCoveredClusters` eligible clusters;
- `cross_cluster_share` meets `crossClusterShare`;
- each counted cluster meets the within-cluster inclusion threshold;
- the total supporting deck/sample count meets the configured minimum;
- the report lists the qualifying clusters and their individual inclusion values.

Do not infer that a card is unhealthy merely because it is broadly included. The flag must say that it is a review signal for low opportunity cost or excessive generic utility.

Preserve ordinary deck-level inclusion as a separate metric with a separate name.

Tests must include:

- high inclusion inside one cluster only: no cross-cluster flag;
- low scattered inclusion across many clusters: no flag;
- meaningful inclusion across enough eligible clusters: flag;
- tiny clusters excluded from the denominator;
- configured `crossClusterShare` materially changes the result.

## 6. Required correction C — immutable reference populations

Baseline-versus-candidate comparison must use the same reference decks in both environments. Generated reference populations must never be independently regenerated from the two card pools.

### Required workflow

1. Generate or load the reference population exactly once.
2. Assign every reference deck a stable content hash based on its normalized Commander and card quantities.
3. Freeze the population in the experiment manifest or a referenced artifact.
4. Validate every reference deck against both card pools.
5. Reuse the identical deck definitions, pilot assignments, seat assignments, and derived seeds in baseline and candidate runs.
6. Store population hashes in both result sets and fail comparison if they differ.

### Legality policy

The default comparison policy is `shared_legal_reference_population`:

- generate from the baseline or load an explicit population;
- retain only decks legal in both environments;
- do not repair, mutate, or regenerate a deck differently for one side;
- report excluded decks and exact legality reasons.

If the experiment is specifically intended to study a newly added card, evaluate it in a separate candidate/discovery population. Do not mix that population into the unchanged-reference estimate. Reports should distinguish:

- **reference impact:** how the candidate rules/card pool affects unchanged decks;
- **discovery impact:** what new or altered decks become possible when search can use the candidate.

Tests must cover added cards, removed cards, changed legality, stable hashes, and a deliberate population mismatch that must fail loudly.

## 7. Required correction D — one streaming record format

Batch, search, replacement, and comparison experiments must all write raw match records incrementally to `matches.jsonl`.

### Storage contract

Every line is one runtime-validated, schema-versioned match record. Each record must include enough identity to deduplicate and resume safely:

- schema version;
- experiment ID and experiment type;
- run/config hash;
- match ID;
- deterministic seed lineage;
- baseline/candidate or search generation label where applicable;
- deck content hashes and pilot IDs;
- seat assignments;
- outcome and termination reason;
- compact card telemetry or a stable reference to it;
- replay/diagnostic reference for abnormal matches.

### Writer behavior

- Append after each completed match or bounded flush interval.
- Never keep every match record in memory merely to write one final JSON array.
- Use backpressure-aware writes.
- A record becomes resumable only after a complete newline-delimited entry is committed.
- On resume, validate the existing header/manifest and reject configuration drift.
- Ignore or safely truncate only an incomplete final line; never discard valid prior records.
- Deduplicate by stable match identity.
- Produce summaries from the stream, using incremental aggregators where practical.
- `matches.json` may be read for backward compatibility, but new runs must not create it as the canonical raw store.

Search generations, replacement pairs, and baseline/candidate pairs may have separate metadata/checkpoint files, but their underlying matches still belong in `matches.jsonl`.

Update every report and README reference so it names the file that actually exists.

Tests must simulate interruption and resume for all experiment types, including a partial final line, duplicate prevention, worker-count independence, and summary equality between uninterrupted and resumed runs.

## 8. Metric semantics and naming corrections

### 8.1 Plays per draw is not a bounded play rate

The current `timesPlayed / timesDrawn` value can exceed 1 when a card is returned, replayed, copied, or otherwise played multiple times. Do not present it as a percentage-style `playRate`.

Implement separate metrics where the event model supports them:

- `playsPerDraw = total play events / total draw events` — unbounded;
- `drawnCopyPlayConversion = unique drawn card instances played at least once / unique drawn card instances` — bounded 0–1;
- `gamesDrawnAndPlayedShare = games in which the card was both drawn and played / games in which it was drawn` — bounded 0–1.

If historical data cannot support instance-level conversion, mark the field unavailable instead of fabricating it. Version the report schema and migrate or clearly reject incompatible prior summaries.

### 8.2 Dead-hand categories

Keep dead-hand reasons mutually interpretable. At minimum distinguish:

- never legally playable before match end;
- legally playable but never chosen;
- unaffordable when relevant decisions occurred;
- missing a legal target;
- blocked by board/zone capacity;
- held at match end after having had a legal opportunity.

Do not collapse strategic non-use into mechanical unusability.

## 9. Statistical corrections

Use a small, tested statistics module rather than scattering formulas across reporters.

### 9.1 Paired experiments

Replacement and baseline/candidate experiments already use common seeds. Analyze their primary deltas as paired outcomes.

For paired binary wins, report at minimum:

- number of valid pairs;
- baseline and candidate win shares;
- paired delta;
- discordant-pair counts;
- a paired confidence interval or paired bootstrap interval;
- an effect-size interpretation without a hard balance verdict.

For continuous outcomes such as match length, use paired differences and report their interval. Do not use independent-sample intervals when pairing is intact.

If a pair is incomplete or invalid, exclude it from the paired estimate, count it, and report why. Never silently fall back to pretending all observations are independent.

### 9.2 Card-pair synergy uncertainty

The synergy estimate must include uncertainty from all groups used in the contrast: together, A-only, B-only, and any explicit neither/baseline group in the formula.

Requirements:

- document the exact estimand;
- require minimum samples per contributing cell;
- return insufficient evidence when any required cell is too sparse;
- compute uncertainty using a method that propagates every component, preferably stratified bootstrap with deterministic analysis seeds;
- control or at least stratify by pilot, seat, opponent field, and deck cluster where data allows;
- avoid causal wording for observational archive associations.

### 9.3 Multiple warnings

Reports may scan many cards and pairs. Include the number of hypotheses examined and label raw versus adjusted significance where significance testing is used. Prefer confidence intervals and effect sizes. If p-values are exposed, support a false-discovery-rate adjustment and never hide the unadjusted values.

## 10. Complete currently promised analyzers

### 10.1 Opponent-field sensitivity

`opponent_field_sensitivity` exists as a reason code and must either be implemented or removed from public schemas and documentation until it is implemented. Prefer implementation.

For a card or deck cluster, compare its estimated impact across sufficiently sampled opponent clusters. Flag only when:

- multiple opponent clusters meet minimum samples;
- the spread or heterogeneity exceeds a configurable threshold;
- uncertainty does not make the apparent spread meaningless.

Report best and worst supported fields, their estimates, intervals, and sample counts. Describe this as context sensitivity or polarization—not automatically as a defect.

### 10.2 Practical counter breadth

Do not claim true card-level counter availability from cluster matchup counts alone.

Add an evidence model that can distinguish:

- unfavorable opponent archetypes/clusters;
- card substitutions associated with improved results against the target;
- broadly playable answers versus narrow silver bullets;
- answers observed only in tiny samples.

An initial implementation may use controlled replacement experiments against a fixed target population. A candidate counter counts as practical only if it improves the target matchup with adequate evidence and does not become nonfunctional against the wider reference field. If that controlled evidence is unavailable, report `counterBreadth: unavailable` and retain cluster matchup breadth under its honest name.

### 10.3 Pilot robustness

Add a repeatable robustness experiment rather than relying only on manually editable pilot weights.

- Define named, versioned perturbation profiles around each heuristic pilot.
- Re-run a bounded common-seed sample across those profiles.
- Measure whether major card flags, cluster rankings, and matchup conclusions persist.
- Report conclusions as stable, pilot-sensitive, or insufficient evidence.
- Do not merge all pilot variants into one pseudo-player population without labeling them.

## 11. Displacement evidence must be stable

Do not raise a strong displacement/obsolescence warning from tiny raw archive counts such as `6 → 3` produced by separate evolutionary runs.

Required improvements:

- compare normalized inclusion shares, not only counts;
- require minimum eligible decks and repeated independent search replicates;
- use matched search budgets and deterministic seed families;
- report between-replicate variation;
- separate disappearance caused by card-pool illegality from evolutionary selection;
- identify which cards/roles replaced the displaced card;
- downgrade small or unstable changes to `insufficient_evidence` or an informational note.

The default report must never describe an unstable archive fluctuation as confirmed obsolescence.

## 12. Reporting requirements

Every experiment report must be self-auditing. Include:

- experiment type and schema version;
- full configuration hash;
- source commit when available;
- card-pool hashes;
- immutable reference-population hash where applicable;
- seed derivation version;
- pilot IDs and versions;
- worker count and execution settings, explicitly marked as non-semantic;
- completed, failed, abnormal, excluded, and resumed match counts;
- raw-record path;
- minimum-sample rules;
- all thresholds used;
- estimates, uncertainty, and sample counts together;
- distinction between descriptive association, controlled comparison, and automated review flag;
- reproducible abnormal-match identifiers and replay commands;
- warnings when evidence is unavailable or underpowered.

Use calibrated language:

- `observed`, `estimated`, `associated`, `review signal`, `insufficient evidence`;
- avoid `proves`, `causes`, `balanced`, `broken`, or `countered` unless the relevant controlled design truly supports the claim.

Machine-readable JSON is authoritative. Markdown and CSV are derived views and must agree with it.

## 13. Configuration and schema policy

- Centralize thresholds in validated, versioned experiment configuration.
- Give every threshold an explicit unit and description.
- Do not reuse one threshold for deck share, cluster share, and game observations.
- Preserve old result readers where reasonable, but never silently reinterpret an old field under a new meaning.
- Increment result/report schema versions for renamed metrics and streaming changes.
- Add migrations only when semantics can be preserved exactly. Otherwise emit a clear compatibility error or mark the field unavailable.
- Persist the exact normalized configuration used for every run.

## 14. Test requirements

Add regression and property-style tests for at least the following areas:

1. Candidate fixture has a real declared structured diff.
2. Identical baseline/candidate definitions are rejected.
3. Undeclared candidate changes are detected.
4. Cross-cluster inclusion uses clusters rather than deck share.
5. Tiny clusters and sparse samples are excluded.
6. Immutable reference populations are byte/content-hash identical across conditions.
7. Added/removed candidate cards do not regenerate reference decks.
8. Illegal shared-reference decks are excluded with reasons.
9. All experiment types stream `matches.jsonl`.
10. Interrupted experiments resume without duplicates or missing valid records.
11. A partial final JSONL line is handled safely.
12. Uninterrupted and resumed summaries are identical.
13. Worker counts 1 and N produce semantically identical records and summaries.
14. `playsPerDraw` may exceed 1 and is never formatted as a percentage.
15. Instance and game-level conversion metrics remain within 0–1.
16. Paired estimates use only complete pairs and expose exclusions.
17. Paired intervals differ appropriately from independent estimates on designed fixtures.
18. Synergy uncertainty responds to uncertainty in every contributing group.
19. Sparse synergy cells return insufficient evidence.
20. Opponent-field sensitivity is computed or the unused public reason code is removed.
21. Counter breadth never claims card-level answers from matchup clusters alone.
22. Pilot perturbation runs are reproducible.
23. Displacement flags require normalized, replicated evidence.
24. Machine-readable and Markdown report values agree.
25. Existing deterministic replay and hidden-information suites remain unchanged and pass.

Use small synthetic fixtures with known expected outcomes for analytical tests. Do not rely only on the bundled card set producing a convenient result.

## 15. Implementation sequence

Claude may implement the entire hardening milestone in one run, but must proceed through these gates in order and keep the repository passing after each gate:

1. Record baseline verification and map current schemas.
2. Correct and validate the candidate fixture.
3. Fix cross-cluster inclusion and its report evidence.
4. Freeze and hash comparison reference populations.
5. Standardize streaming JSONL and resume behavior.
6. Version and rename misleading telemetry fields.
7. Centralize and correct paired and synergy statistics.
8. Implement opponent-field sensitivity and honest counter breadth.
9. Add pilot robustness experiments.
10. Stabilize displacement analysis across search replicates.
11. Align JSON, CSV, Markdown, CLI help, examples, and documentation.
12. Run realistic smoke experiments in addition to unit tests.
13. Run the complete verification suite and update status documents.

Do not stop merely because a gate is large. Stop only if a genuinely unresolved game-design decision is required, determinism would be compromised, or an incompatible data migration cannot be performed honestly.

## 16. Required smoke experiments

After automated tests pass, run small but real end-to-end experiments:

1. Baseline batch with each built-in pilot.
2. Corrected baseline-versus-candidate comparison.
3. Controlled replacement experiment.
4. Short evolutionary search with at least two independent replicates.
5. Interrupted-and-resumed batch.
6. Same experiment at worker counts 1 and at least 2.
7. Pilot-perturbation robustness sample.

Check that outputs are finite, internally consistent, correctly linked, resumable, and reproducible. Do not commit large generated match corpora. Commit only small fixtures or example summaries needed for documentation/tests.

## 17. Documentation cleanup

Update all affected documentation in the same change:

- `CLAUDE.md` must no longer call Phase 4 an active, unimplemented milestone.
- `docs/project-status.md` must describe Phase 4 as complete only after this hardening specification is satisfied.
- Until then, use a status such as `Hardening in progress` rather than claiming full analytical completion.
- Document renamed metrics and result schema changes.
- Document the immutable-reference and discovery-population distinction.
- Document JSONL streaming/resume behavior for every experiment type.
- Document statistical limitations and evidence labels.
- Update CLI examples and checked-in experiment fixtures.
- Update `docs/open-questions.md` only where this work genuinely answers an implementation question. Do not close playtest-dependent design questions.

Add an ADR for any material persisted-data or statistical-contract decision that future work must preserve.

## 18. Definition of done

This hardening milestone is complete only when all of the following are true:

- All four audited correctness defects are fixed with regression tests.
- The example candidate comparison measures the change it claims.
- Cross-cluster inclusion is truly cluster-based.
- Baseline and candidate reuse one immutable legal reference population.
- Every experiment type streams raw matches to resumable `matches.jsonl`.
- Misleading play-rate naming is removed from schemas, reports, and UI/CLI output.
- Paired experiments use paired analysis.
- Synergy uncertainty includes every contributing group.
- Opponent-field sensitivity is implemented or removed everywhere.
- Counter breadth is either supported by controlled evidence or explicitly unavailable.
- Pilot robustness is executable and reported.
- Displacement warnings require normalized, replicated evidence.
- Reports expose raw evidence, uncertainty, thresholds, exclusions, and provenance.
- New result schemas are versioned and compatibility behavior is documented.
- All required smoke experiments complete successfully.
- `npm run verify` passes for the whole monorepo.
- Phase 1–3 behavior, replay determinism, hidden information, and online protocol tests remain intact.
- `CLAUDE.md`, project status, open questions, ADRs, examples, and CLI help agree with the implemented state.

## 19. Final implementation report

When finished, provide a concise completion report containing:

- files and modules materially changed;
- defects fixed;
- schema versions changed and compatibility implications;
- tests added and final verification counts;
- smoke experiments run;
- before/after examples for the corrected warnings;
- any remaining analytical limitations;
- any genuinely unresolved decisions requiring the game designer.

Do not describe Phase 4 as trustworthy merely because the test suite passes. The final claim must be supported by the corrected experimental contracts, regression fixtures, and end-to-end smoke results defined above.
