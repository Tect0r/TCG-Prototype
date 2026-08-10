import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CardDefinitionInput } from '@tcg/card-data';
import {
  declaredChangesSchema,
  checkDeclaredChanges,
  diffEnvironments,
  resolveEnvironment,
  type Environment,
  type EnvironmentConfigInput,
} from './environment.js';
import {
  deckSourceSchema,
  experimentConfigSchema,
  parseExperimentConfig,
  type ExperimentConfig,
} from './config.js';
import { runExperiment, configHashOf } from './experiment.js';
import {
  assertSharedPopulation,
  freezeReferencePopulation,
  populationHash,
  referencePopulationSchema,
} from './reference-population.js';
import { experimentPaths, readJsonl } from './reporting/sinks.js';
import { matchRecordSchema } from './telemetry/schema.js';
import { tinyEnvironment } from './test-fixtures.js';

/**
 * Hardening regression tests at the experiment level (PHASE4_HARDENING §14).
 *
 * These run real experiments rather than stubbing them, because the properties
 * being checked — that every kind streams to one resumable file, that a resumed
 * run summarises identically, that the reference population is frozen — are
 * properties of the wiring and would survive any amount of unit testing of the
 * parts in isolation.
 */

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tcg-hard-'));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A twelve-card neutral format, so a whole experiment runs in seconds. */
const ENVIRONMENT: EnvironmentConfigInput = {
  id: 'hardening_env',
  allowCardIds: [
    'prototype_drone',
    'prototype_scout',
    'prototype_guard',
    'trench_guard',
    'unstable_construct',
    'surveyors_lens',
    'energy_font',
    'field_survey',
    'prototype_commander_blue',
    'prototype_commander_red',
  ],
  deckFormat: { deckSize: 12, copyLimit: 2 },
};

const COMMON = {
  schemaVersion: 1,
  seed: 'hardening-seed',
  output: 'results',
  playerCount: 2,
  pilots: [{ id: 'value' }],
  pilotPairing: 'mirror',
  limits: { maxTurns: 60 },
  retention: { replaySampleRate: 0 },
  workers: 1,
} as const;

/* ------------------------------------- §4: the candidate fixture is real */

describe('declared environment changes', () => {
  const baseline: Environment = tinyEnvironment({ id: 'declared_baseline' });

  /** One numeric field, nothing else. The shape §4 asks a fixture to have. */
  const buffed: CardDefinitionInput = {
    schemaVersion: 2,
    id: 'fixture_baseline_unit',
    name: 'Fixture Baseline Unit',
    type: 'unit',
    colorIdentity: [],
    cost: 2,
    attack: 4,
    health: 2,
    role: 'attacker',
    powerClass: 'standard',
    tags: ['fixture'],
    displayText: 'A deliberately ordinary body.',
  };

  it('accepts a one-field numeric change that was declared', () => {
    const candidate = tinyEnvironment({ id: 'declared_candidate', cardOverrides: [buffed] });
    const diff = diffEnvironments(baseline, candidate);
    expect(diff.cardsChanged).toHaveLength(1);
    expect(diff.cardsChanged[0]?.fields).toEqual(['attack']);

    const check = checkDeclaredChanges(
      diff,
      declaredChangesSchema.parse({
        cardsChanged: [{ cardId: 'fixture_baseline_unit', fields: ['attack'] }],
      }),
    );
    expect(check.ok).toBe(true);
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([]);
  });

  it('rejects a candidate whose declared card is structurally identical', () => {
    // The audited defect: the fixture claimed a change the pools did not contain.
    const twin = resolveEnvironment(baseline.config);
    const diff = diffEnvironments(baseline, twin);
    expect(diff.identical).toBe(true);

    const check = checkDeclaredChanges(
      diff,
      declaredChangesSchema.parse({
        cardsChanged: [{ cardId: 'fixture_baseline_unit', fields: ['effects'] }],
      }),
    );
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toMatch(/identical in the baseline and candidate pools/);
    expect(check.errors.join(' ')).toMatch(/hash identically/);
  });

  it('detects an undeclared targeting change alongside a declared one', () => {
    const alsoRetargeted: CardDefinitionInput = {
      ...buffed,
      // The undeclared second change: a different keyword set.
      keywords: ['rush'],
    };
    const candidate = tinyEnvironment({
      id: 'declared_confounded',
      cardOverrides: [alsoRetargeted],
    });
    const diff = diffEnvironments(baseline, candidate);
    expect(diff.cardsChanged[0]?.fields.sort()).toEqual(['attack', 'keywords']);

    const declared = declaredChangesSchema.parse({
      cardsChanged: [{ cardId: 'fixture_baseline_unit', fields: ['attack'] }],
    });
    const rejected = checkDeclaredChanges(diff, declared);
    expect(rejected.ok).toBe(false);
    expect(rejected.errors.join(' ')).toMatch(/undeclared field\(s\): keywords/);

    // `warn` downgrades it to a prominent report warning rather than hiding it.
    const warned = checkDeclaredChanges(diff, { ...declared, onUndeclared: 'warn' });
    expect(warned.ok).toBe(true);
    expect(warned.warnings.join(' ')).toMatch(/undeclared field\(s\): keywords/);
  });

  it('rejects a declaration naming a field that did not move', () => {
    const candidate = tinyEnvironment({ id: 'declared_wrong_field', cardOverrides: [buffed] });
    const check = checkDeclaredChanges(
      diffEnvironments(baseline, candidate),
      declaredChangesSchema.parse({
        cardsChanged: [{ cardId: 'fixture_baseline_unit', fields: ['attack', 'cost'] }],
      }),
    );
    expect(check.ok).toBe(false);
    expect(check.errors.join(' ')).toMatch(/declared to change in cost/);
  });

  it('the shipped comparison fixture measures the change it claims', () => {
    // §4 requirement 7 and §14 item 1, checked against the file that ships.
    const config = parseExperimentConfig(
      JSON.parse(readFileSync('experiments/candidate-vs-baseline.json', 'utf8')),
    );
    expect(config.kind).toBe('comparison');
    if (config.kind !== 'comparison') return;

    const diff = diffEnvironments(
      resolveEnvironment(config.baseline),
      resolveEnvironment(config.candidate),
    );
    expect(diff.identical).toBe(false);
    expect(diff.cardsChanged).toHaveLength(1);
    expect(diff.cardsChanged[0]?.cardId).toBe('scorch');
    // The declared damage change is real: 3 in the baseline, 4 in the candidate.
    expect(diff.cardsChanged[0]?.before).toMatch(/"amount":3/);
    expect(diff.cardsChanged[0]?.after).toMatch(/"amount":4/);
    // And the targeting filter is deliberately untouched, so the comparison is
    // measuring the damage number and nothing else.
    expect(diff.cardsChanged[0]?.before).toMatch(/"cardTypes":\["unit","token"\]/);
    expect(diff.cardsChanged[0]?.after).toMatch(/"cardTypes":\["unit","token"\]/);

    const check = checkDeclaredChanges(diff, config.declaredChanges);
    expect(check.errors).toEqual([]);
    expect(check.warnings).toEqual([]);
    expect(check.ok).toBe(true);
  });
});

/* --------------------------------- §6: immutable reference populations */

describe('frozen reference population', () => {
  const inlineSource = deckSourceSchema.parse({
    kind: 'inline',
    decks: [
      {
        id: 'blue_one',
        commanderId: 'prototype_commander_blue',
        cards: [
          { cardId: 'prototype_scout', quantity: 2 },
          { cardId: 'prototype_drone', quantity: 2 },
          { cardId: 'prototype_guard', quantity: 2 },
          { cardId: 'trench_guard', quantity: 2 },
          { cardId: 'unstable_construct', quantity: 2 },
          { cardId: 'field_survey', quantity: 2 },
        ],
      },
      {
        id: 'blue_two',
        commanderId: 'prototype_commander_blue',
        cards: [
          { cardId: 'prototype_scout', quantity: 2 },
          { cardId: 'prototype_drone', quantity: 2 },
          { cardId: 'surveyors_lens', quantity: 2 },
          { cardId: 'trench_guard', quantity: 2 },
          { cardId: 'unstable_construct', quantity: 2 },
          { cardId: 'field_survey', quantity: 2 },
        ],
      },
    ],
  });

  const baseline: Environment = resolveEnvironment(ENVIRONMENT);

  function freeze(candidate: Environment) {
    return freezeReferencePopulation({
      source: inlineSource,
      baseline,
      candidate,
      seed: 'reference',
      configDir: '.',
    });
  }

  it('resolves a generated population once and hashes it by content', () => {
    const generated = deckSourceSchema.parse({ kind: 'generated', count: 4 });
    const first = freezeReferencePopulation({
      source: generated,
      baseline,
      candidate: resolveEnvironment(ENVIRONMENT),
      seed: 'reference',
      configDir: '.',
    });
    const second = freezeReferencePopulation({
      source: generated,
      baseline,
      candidate: resolveEnvironment(ENVIRONMENT),
      seed: 'reference',
      configDir: '.',
    });
    expect(first.hash).toBe(second.hash);
    expect(() => referencePopulationSchema.parse(first)).not.toThrow();
    expect(first.policy).toBe('shared_legal_reference_population');
    expect(first.resolvedAgainst).toBe(baseline.id);
  });

  it('hashes independently of entry order', () => {
    const population = freeze(resolveEnvironment(ENVIRONMENT));
    expect(populationHash([...population.decks].reverse())).toBe(population.hash);
  });

  it('does not regenerate when the candidate adds a card', () => {
    // §14 item 7. A new card in the candidate pool must not change which decks
    // the reference arm plays, or "the same decks, unchanged" is untrue.
    const withExtra = resolveEnvironment({
      ...ENVIRONMENT,
      allowCardIds: [...(ENVIRONMENT.allowCardIds ?? []), 'goblin_scout'],
    });
    expect(freeze(withExtra).hash).toBe(freeze(resolveEnvironment(ENVIRONMENT)).hash);
  });

  it('excludes a deck made illegal by the candidate, with its reason, from both arms', () => {
    // The candidate drops `surveyors_lens`, which only `blue_two` runs.
    const narrowed = resolveEnvironment({
      ...ENVIRONMENT,
      allowCardIds: (ENVIRONMENT.allowCardIds ?? []).filter((id) => id !== 'surveyors_lens'),
    });
    const population = freeze(narrowed);

    expect(population.decks.map((deck) => deck.id)).toEqual(['blue_one']);
    expect(population.excluded).toHaveLength(1);
    expect(population.excluded[0]?.deckId).toBe('blue_two');
    expect(population.excluded[0]?.environmentId).toBe(narrowed.id);
    expect(population.excluded[0]?.reasons.join(' ')).toMatch(/surveyors_lens/);
    // The surviving population is a strict subset, never a repaired deck.
    expect(population.hash).not.toBe(population.resolvedHash);
  });

  it('fails loudly rather than comparing two different populations', () => {
    expect(() => assertSharedPopulation('hash_a', 'hash_a', 'ctx')).not.toThrow();
    expect(() => assertSharedPopulation('hash_a', 'hash_b', 'Comparison "x"')).toThrow(
      /different reference populations/,
    );
  });
});

/* ------------------------------------ §7: one streaming record format */

describe('every experiment kind streams to a resumable matches.jsonl', () => {
  function configFor(kind: string, overrides: Record<string, unknown> = {}): ExperimentConfig {
    return experimentConfigSchema.parse({
      ...COMMON,
      kind,
      id: `stream_${kind}`,
      environment: ENVIRONMENT,
      ...overrides,
    });
  }

  const batch = () =>
    configFor('batch', {
      decks: { kind: 'generated', count: 3 },
      gamesPerPairing: 2,
    });

  const search = () =>
    configFor('search', {
      populationSize: 4,
      generations: 2,
      eliteCount: 2,
      mutationStrength: 2,
      crossoverShare: 0,
      opponentsPerEvaluation: 2,
      gamesPerOpponent: 1,
      archiveSize: 4,
    });

  const robustness = () =>
    configFor('robustness', {
      decks: { kind: 'generated', count: 3 },
      profiles: ['published', 'combat_forward'],
      gamesPerPairing: 1,
    });

  const replacement = () =>
    configFor('replacement', {
      subjectCardId: 'trench_guard',
      candidateCardIds: ['prototype_guard'],
      copies: 'all',
      baseDecks: {
        kind: 'inline',
        decks: [
          {
            id: 'runs_subject',
            commanderId: 'prototype_commander_blue',
            cards: [
              { cardId: 'trench_guard', quantity: 2 },
              { cardId: 'prototype_scout', quantity: 2 },
              { cardId: 'prototype_drone', quantity: 2 },
              { cardId: 'unstable_construct', quantity: 2 },
              { cardId: 'surveyors_lens', quantity: 2 },
              { cardId: 'field_survey', quantity: 2 },
            ],
          },
        ],
      },
      opponentDecks: { kind: 'generated', count: 2 },
      gamesPerPairing: 2,
    });

  const comparison = () =>
    experimentConfigSchema.parse({
      ...COMMON,
      kind: 'comparison',
      id: 'stream_comparison',
      baseline: ENVIRONMENT,
      candidate: {
        ...ENVIRONMENT,
        id: 'hardening_candidate',
        rulesConfig: { startingHealth: 24 },
      },
      declaredChanges: { rulesChanged: ['startingHealth'] },
      referenceDecks: { kind: 'generated', count: 3 },
      gamesPerPairing: 1,
      searchBothEnvironments: false,
    });

  const kinds: readonly [string, () => ExperimentConfig][] = [
    ['batch', batch],
    ['search', search],
    ['replacement', replacement],
    ['comparison', comparison],
    ['robustness', robustness],
  ];

  for (const [name, make] of kinds) {
    it(`writes ${name} matches to matches.jsonl and never to matches.json`, async () => {
      const dir = tempDir();
      const outcome = await runExperiment(make(), { outputDir: dir });
      const paths = experimentPaths(dir);

      const onDisk = readJsonl(paths.matches, matchRecordSchema);
      expect(onDisk.skipped).toEqual([]);
      expect(onDisk.records.length).toBeGreaterThan(0);
      expect(onDisk.records.length).toBe(outcome.records.length);
      // The legacy array file must not come back as the canonical raw store.
      expect(existsSync(join(dir, 'matches.json'))).toBe(false);
      // Every record carries the identity resume needs.
      for (const record of onDisk.records) {
        expect(record.experimentKind).toBe(name);
        expect(record.configHash).toBe(configHashOf(make()));
      }
      // And the header sidecar says which configuration wrote them.
      const header = JSON.parse(readFileSync(paths.matchesHeader, 'utf8'));
      expect(header.configHash).toBe(configHashOf(make()));
      expect(header.experimentKind).toBe(name);
      // The report names the file that actually exists.
      expect(outcome.report).toContain('matches.jsonl');
      expect(outcome.report).not.toMatch(/`matches\.json`/);
    }, 240_000);
  }

  it('separates a comparison’s two arms within the one stream', async () => {
    const dir = tempDir();
    await runExperiment(comparison(), { outputDir: dir });
    const records = readJsonl(experimentPaths(dir).matches, matchRecordSchema).records;
    const arms = new Set(records.map((record) => record.arm));
    expect(arms).toEqual(new Set(['baseline', 'candidate']));
    const baseline = records.filter((record) => record.arm === 'baseline');
    const candidate = records.filter((record) => record.arm === 'candidate');
    expect(baseline.length).toBe(candidate.length);
    expect(baseline.length).toBeGreaterThan(0);

    // The two arms are the *same games* — identical derived match seeds — under
    // different environments. Their match IDs differ because the environment is
    // part of a match's identity, which is exactly why deduplication keys on the
    // arm as well and why the two halves can share one stream.
    const seedsOf = (rows: typeof records) =>
      rows
        .map((record) => `${record.deckPairId}:${record.gameIndex}:${record.seeds.matchSeed}`)
        .sort();
    expect(seedsOf(candidate)).toEqual(seedsOf(baseline));
    expect(new Set(records.map((record) => record.matchId)).size).toBe(records.length);
  }, 240_000);

  it('labels each search generation and each robustness profile as its own arm', async () => {
    const searchDir = tempDir();
    await runExperiment(search(), { outputDir: searchDir });
    const searchArms = new Set(
      readJsonl(experimentPaths(searchDir).matches, matchRecordSchema).records.map(
        (record) => record.arm,
      ),
    );
    expect([...searchArms].every((arm) => arm?.startsWith('search:'))).toBe(true);
    expect(searchArms.size).toBeGreaterThan(1);

    const robustnessDir = tempDir();
    await runExperiment(robustness(), { outputDir: robustnessDir });
    const profiles = new Set(
      readJsonl(experimentPaths(robustnessDir).matches, matchRecordSchema).records.map(
        (record) => record.arm,
      ),
    );
    expect(profiles).toEqual(new Set(['profile:published', 'profile:combat_forward']));
  }, 240_000);
});

/* -------------------------------------- §7: interruption and resume */

describe('interrupted experiments resume without duplicates or loss', () => {
  const searchConfig = experimentConfigSchema.parse({
    ...COMMON,
    kind: 'search',
    id: 'resume_search',
    environment: ENVIRONMENT,
    populationSize: 4,
    generations: 2,
    eliteCount: 2,
    mutationStrength: 2,
    crossoverShare: 0,
    opponentsPerEvaluation: 2,
    gamesPerOpponent: 1,
    archiveSize: 4,
  });

  it('produces an identical summary whether or not it was interrupted', async () => {
    const whole = await runExperiment(searchConfig, { outputDir: tempDir() });

    // "Interrupt" by running once, damaging the tail, then resuming. The second
    // pass re-runs only what is missing.
    const dir = tempDir();
    await runExperiment(searchConfig, { outputDir: dir });
    const path = experimentPaths(dir).matches;
    const before = readJsonl(path, matchRecordSchema).records.length;
    appendFileSync(path, '{"matchId":"m_half_written","schemaVer', 'utf8');

    const resumed = await runExperiment(searchConfig, { outputDir: dir, resume: true });

    expect(resumed.resumedMatches).toBe(before);
    expect(resumed.records.length).toBe(whole.records.length);
    expect(new Set(resumed.records.map((record) => record.matchId)).size).toBe(
      new Set(whole.records.map((record) => record.matchId)).size,
    );
    // The damaged tail was dropped once and reported, not carried forward.
    expect(readJsonl(path, matchRecordSchema).skipped).toEqual([]);
    // And the derived numbers are the same run.
    expect(JSON.stringify(resumed.aggregate)).toBe(JSON.stringify(whole.aggregate));
    expect(JSON.stringify(resumed.flags)).toBe(JSON.stringify(whole.flags));
  }, 300_000);

  it('refuses to resume into a stream written by a different configuration', async () => {
    const dir = tempDir();
    await runExperiment(searchConfig, { outputDir: dir });
    const different = experimentConfigSchema.parse({
      ...COMMON,
      kind: 'search',
      id: 'resume_search',
      environment: ENVIRONMENT,
      seed: 'a-different-seed',
      populationSize: 4,
      generations: 2,
      eliteCount: 2,
      mutationStrength: 2,
      crossoverShare: 0,
      opponentsPerEvaluation: 2,
      gamesPerOpponent: 1,
      archiveSize: 4,
    });
    await expect(runExperiment(different, { outputDir: dir, resume: true })).rejects.toThrow(
      /different run|configuration hash/i,
    );
  }, 240_000);
});

/* --------------------------------------- §14.13: worker-count invariance */

describe('worker count is non-semantic', () => {
  it('produces the same records and summary at one and four workers', async () => {
    const config = experimentConfigSchema.parse({
      ...COMMON,
      kind: 'batch',
      id: 'workers_batch',
      environment: ENVIRONMENT,
      decks: { kind: 'generated', count: 3 },
      gamesPerPairing: 2,
    });

    const sequential = await runExperiment(config, { outputDir: tempDir(), workers: 1 });
    const parallel = await runExperiment(config, { outputDir: tempDir(), workers: 4 });

    expect(JSON.stringify(parallel.records)).toBe(JSON.stringify(sequential.records));
    expect(JSON.stringify(parallel.aggregate)).toBe(JSON.stringify(sequential.aggregate));
    expect(JSON.stringify(parallel.flags)).toBe(JSON.stringify(sequential.flags));
  }, 300_000);
});

/* ---------------------------- §8.1: play metrics say what they measure */

describe('play metrics', () => {
  it('never formats plays-per-draw as a percentage and keeps conversions in 0–1', async () => {
    const dir = tempDir();
    const outcome = await runExperiment(
      experimentConfigSchema.parse({
        ...COMMON,
        kind: 'batch',
        id: 'metrics_batch',
        environment: ENVIRONMENT,
        decks: { kind: 'generated', count: 3 },
        gamesPerPairing: 2,
      }),
      { outputDir: dir },
    );

    for (const card of outcome.aggregate.cards) {
      expect(card.playsPerDraw).toBeGreaterThanOrEqual(0);
      if (card.drawnCopyPlayConversion !== null) {
        expect(card.drawnCopyPlayConversion).toBeGreaterThanOrEqual(0);
        expect(card.drawnCopyPlayConversion).toBeLessThanOrEqual(1);
      }
      expect(card.gamesDrawnAndPlayedShare).toBeGreaterThanOrEqual(0);
      expect(card.gamesDrawnAndPlayedShare).toBeLessThanOrEqual(1);
    }

    // The misleading name is gone from every output, not merely from the report.
    const summary = readFileSync(experimentPaths(dir).summary, 'utf8');
    const usage = readFileSync(experimentPaths(dir).cardUsage, 'utf8');
    for (const text of [summary, usage, outcome.report]) {
      expect(text).not.toMatch(/playRatePerDrawn|play_rate_per_drawn/);
    }
    expect(usage).toMatch(/plays_per_draw/);
    expect(usage).toMatch(/drawn_copy_play_conversion/);
    expect(outcome.report).toMatch(/plays\/draw/);
    expect(outcome.report).toMatch(/unbounded/i);
    // A `1.2×` multiplier is legal; a `120%` play rate is the bug.
    expect(outcome.report).not.toMatch(/plays\/draw[^|]*\|\s*\d+(\.\d+)?%/);
  }, 240_000);

  it('is unbounded above one when copies are replayed', () => {
    // Not observable from the bundled set, which has no bounce, so the invariant
    // is asserted directly on the aggregator's arithmetic: plays over draw
    // *events*, with no clamp anywhere in the path.
    const source = readFileSync('apps/simulator/src/analysis/aggregate.ts', 'utf8');
    expect(source).toMatch(/playsPerDraw:[\s\S]{0,120}tally\.played \/ tally\.drawn/);
    expect(source).not.toMatch(/Math\.min\(1[,)][^)]*playsPerDraw/);
  });
});

/* ------------------------- §12/§14.24: JSON, CSV and Markdown agree */

describe('report views agree with the machine-readable summary', () => {
  it('prints the provenance, thresholds and counts that summary.json records', async () => {
    const dir = tempDir();
    const config = experimentConfigSchema.parse({
      ...COMMON,
      kind: 'batch',
      id: 'agreement_batch',
      environment: ENVIRONMENT,
      decks: { kind: 'generated', count: 3 },
      gamesPerPairing: 2,
    });
    await runExperiment(config, { outputDir: dir, softwareCommit: 'deadbeef' });

    const paths = experimentPaths(dir);
    const summary = JSON.parse(readFileSync(paths.summary, 'utf8'));
    const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8'));
    const report = readFileSync(paths.report, 'utf8');

    // Provenance the reader needs to reproduce or distrust the run.
    expect(report).toContain(configHashOf(config));
    expect(summary.configHash).toBe(configHashOf(config));
    expect(manifest.configHash).toBe(configHashOf(config));
    expect(report).toContain('deadbeef');
    expect(report).toContain(manifest.environments[0].cardPoolHash);
    expect(report).toContain('matches.jsonl');
    expect(report).toMatch(/non-semantic/);

    // Counts.
    expect(report).toContain(`| Matches completed | ${summary.aggregate.run.matches} |`);
    expect(report).toContain(`| Matches usable | ${summary.aggregate.run.usableMatches} |`);

    // Every threshold, by name and value.
    for (const [name, value] of Object.entries(summary.thresholds)) {
      expect(report).toContain(`| \`${name}\` | ${String(value)} |`);
    }

    // Every flag row in the table is a flag in the JSON, with the same sample size.
    for (const flag of summary.flags.filter(
      (entry: { level: string }) =>
        entry.level === 'review_recommended' || entry.level === 'possible_interaction',
    )) {
      expect(report).toContain(`\`${flag.reason}\` | \`${flag.subject}\` | ${flag.sampleSize}`);
    }

    // Calibrated language, and the evidence-label legend that explains it.
    expect(report).toMatch(/\| \*observation\* \|/);
    expect(report).toMatch(/\| \*review signal\* \|/);
    expect(report).not.toMatch(/\bproves\b/i);
  }, 240_000);
});

/* ----------------------------- §10.3: pilot perturbation is repeatable */

describe('pilot robustness experiment', () => {
  const config = experimentConfigSchema.parse({
    ...COMMON,
    kind: 'robustness',
    id: 'robustness_run',
    environment: ENVIRONMENT,
    decks: { kind: 'generated', count: 3 },
    profiles: ['published', 'combat_forward', 'card_advantage'],
    gamesPerPairing: 1,
  });

  it('runs every profile on the same seeds and reports them separately', async () => {
    const outcome = await runExperiment(config, { outputDir: tempDir() });
    expect(outcome.robustness).not.toBeNull();
    expect(outcome.robustness?.profiles.sort()).toEqual([
      'card_advantage',
      'combat_forward',
      'published',
    ]);

    const records = outcome.records;
    const byArm = new Map<string, Set<string>>();
    for (const record of records) {
      const arm = record.arm ?? '';
      byArm.set(arm, (byArm.get(arm) ?? new Set()).add(record.seeds.matchSeed));
    }
    // Common random numbers across arms: the seed path deliberately ignores the
    // profile, so a difference between arms is the pilots and nothing else.
    const seedSets = [...byArm.values()].map((set) => [...set].sort().join('|'));
    expect(new Set(seedSets).size).toBe(1);

    expect(outcome.report).toMatch(/## Pilot robustness/);
    expect(outcome.report).toMatch(/never pooled/i);
  }, 300_000);

  it('is reproducible', async () => {
    const first = await runExperiment(config, { outputDir: tempDir() });
    const second = await runExperiment(config, { outputDir: tempDir() });
    expect(JSON.stringify(second.records)).toBe(JSON.stringify(first.records));
    expect(JSON.stringify(second.robustness)).toBe(JSON.stringify(first.robustness));
  }, 300_000);
});
