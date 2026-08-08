import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { experimentConfigSchema, type ExperimentConfig } from './config.js';
import { runExperiment, type ExperimentOutcome } from './experiment.js';
import { aggregate } from './analysis/aggregate.js';
import { cardPairs } from './analysis/pairs.js';
import { readJsonl, experimentPaths } from './reporting/sinks.js';
import { matchRecordSchema } from './telemetry/schema.js';

/**
 * CLAUDE.md §13.13 and §13.15 item 19: an experiment directory is the
 * deliverable, and every number in the report reconciles exactly with the raw
 * records it was derived from.
 */

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tcg-exp-'));
  roots.push(dir);
  return dir;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Everything every experiment kind shares. */
const COMMON = {
  schemaVersion: 1,
  seed: 'fixture-seed',
  output: 'results',
  playerCount: 2,
  pilots: [{ id: 'value' }],
  pilotPairing: 'mirror',
  environment: {
    id: 'fixture_env',
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
  },
  limits: { maxTurns: 80 },
  retention: { replaySampleRate: 0 },
  workers: 1,
} as const;

/** A small batch experiment over the bundled prototype set. */
function config(overrides: Record<string, unknown> = {}): ExperimentConfig {
  return experimentConfigSchema.parse({
    ...COMMON,
    kind: 'batch',
    id: 'fixture_batch',
    label: 'Fixture batch',
    decks: { kind: 'generated', count: 3 },
    gamesPerPairing: 2,
    mirrorSeats: true,
    ...overrides,
  });
}

let outcome: ExperimentOutcome;
let dir: string;

beforeAll(async () => {
  dir = tempDir();
  outcome = await runExperiment(config(), { outputDir: dir, softwareCommit: 'test-commit' });
}, 120_000);

describe('experiment directory', () => {
  it('writes every documented artefact', () => {
    const paths = experimentPaths(dir);
    for (const path of [
      paths.manifest,
      paths.config,
      paths.matches,
      paths.decks,
      paths.summary,
      paths.report,
      paths.cardUsage,
      paths.cardPairs,
      paths.errors,
    ]) {
      expect(existsSync(path), path).toBe(true);
    }
    expect(readdirSync(dir)).toContain('replays');
  });

  it('records the provenance a reader needs to reproduce the run', () => {
    const manifest = JSON.parse(readFileSync(experimentPaths(dir).manifest, 'utf8'));
    expect(manifest.experimentId).toBe('fixture_batch');
    expect(manifest.seed).toBe('fixture-seed');
    expect(manifest.softwareCommit).toBe('test-commit');
    expect(manifest.seedDerivationVersion).toBeGreaterThan(0);
    expect(manifest.hashVersion).toBeGreaterThan(0);
    expect(manifest.telemetrySchemaVersion).toBeGreaterThan(0);
    expect(manifest.rulesVersion.length).toBeGreaterThan(0);
    expect(manifest.environments[0].hash.length).toBeGreaterThan(0);
    expect(manifest.deckHashes).toEqual([...manifest.deckHashes].sort());
    expect(manifest.matches).toBe(outcome.records.length);
  });

  it('writes back a config that re-validates', () => {
    const written = JSON.parse(readFileSync(experimentPaths(dir).config, 'utf8'));
    expect(() => experimentConfigSchema.parse(written)).not.toThrow();
  });
});

describe('report reconciliation', () => {
  /**
   * CLAUDE.md §13.15 item 19. Raw records are the primary output; everything in
   * `summary.json`, the CSVs and `report.md` must be re-derivable from them.
   */
  const records = () => readJsonl(experimentPaths(dir).matches, matchRecordSchema).records;

  it('has raw records on disk that match the returned ones exactly', () => {
    const onDisk = [...records()].sort((a, b) => a.orderKey.localeCompare(b.orderKey));
    expect(JSON.stringify(onDisk)).toBe(JSON.stringify(outcome.records));
  });

  it('re-derives the whole summary from matches.jsonl alone', () => {
    const rederived = aggregate(records(), { confidence: 0.95 });
    const summary = JSON.parse(readFileSync(experimentPaths(dir).summary, 'utf8'));
    expect(JSON.stringify(rederived)).toBe(JSON.stringify(summary.aggregate));
  });

  it('re-derives the card pairs from matches.jsonl alone', () => {
    const summary = JSON.parse(readFileSync(experimentPaths(dir).summary, 'utf8'));
    const rederived = cardPairs(records(), { minSupport: 20, confidence: 0.95 });
    expect(JSON.stringify(rederived)).toBe(JSON.stringify(summary.pairs));
  });

  it('reconciles the match count printed in the report with the records', () => {
    const summary = JSON.parse(readFileSync(experimentPaths(dir).summary, 'utf8'));
    expect(summary.aggregate.run.matches).toBe(records().length);
    expect(outcome.report).toContain(String(summary.aggregate.run.matches));
  });

  it('reconciles every card-usage CSV row with the aggregate', () => {
    const csv = readFileSync(experimentPaths(dir).cardUsage, 'utf8').trim().split('\n');
    const header = csv[0]?.split(',') ?? [];
    const rows = csv.slice(1).map((line) => {
      const cells = line.split(',');
      return Object.fromEntries(header.map((name, index) => [name, cells[index]])) as Record<
        string,
        string
      >;
    });

    expect(rows).toHaveLength(outcome.aggregate.cards.length);
    for (const row of rows) {
      const card = outcome.aggregate.cards.find((entry) => entry.definitionId === row.card_id);
      expect(card, row.card_id).toBeDefined();
      expect(Number(row.seat_matches)).toBe(card?.seatMatches);
      expect(Number(row.decks_including)).toBe(card?.decksIncluding);
      expect(Number(row.win_rate_included)).toBe(card?.winRateWhenIncluded.point);
      expect(Number(row.dead_unseen)).toBe(card?.deadHand.unseen ?? 0);
      expect(Number(row.dead_legal_but_unchosen)).toBe(card?.deadHand.legal_but_unchosen ?? 0);
    }
  });

  it('reconciles the seat totals in the aggregate with the raw seats', () => {
    const raw = records();
    const seats = raw.flatMap((record) => record.seats);
    const wins = seats.filter((seat) => seat.won).length;
    const summed = outcome.aggregate.run.seatWinRates.reduce(
      (sum, entry) => sum + entry.rate.successes,
      0,
    );
    expect(summed).toBe(wins);
  });
});

describe('report.md', () => {
  it('leads with limitations before any finding', () => {
    const limitations = outcome.report.indexOf('## Limitations');
    expect(limitations).toBeGreaterThanOrEqual(0);
    for (const heading of ['## Cards', '## Strategic clusters', '## Review guidance']) {
      const index = outcome.report.indexOf(heading);
      if (index >= 0) expect(index).toBeGreaterThan(limitations);
    }
  });

  it('states the scale and environment of the run', () => {
    expect(outcome.report).toMatch(/fixture_env/);
    expect(outcome.report).toMatch(/matches/i);
    expect(outcome.report).toMatch(/value/);
  });

  it('separates observation from recommendation and never states a verdict', () => {
    // Affirmative verdicts only: the report is expected — and required — to say
    // things like "this is *not* a statement that the environment is balanced".
    expect(outcome.report).not.toMatch(/\bthis (card|environment) is (balanced|overpowered)\b/i);
    expect(outcome.report).not.toMatch(/\bproves\b/i);
    expect(outcome.report).toMatch(/not a balance verdict/i);
    expect(outcome.report).toMatch(/\*\(observation\)\*/);
    // The guidance section, when present, is explicitly non-definitive.
    if (outcome.report.includes('## Review guidance')) {
      expect(outcome.report).toMatch(/review_recommended|insufficient_data|possible_interaction/);
    }
  });

  it('is reproducible: the same experiment writes the same report', async () => {
    const again = await runExperiment(config(), {
      outputDir: tempDir(),
      softwareCommit: 'test-commit',
    });
    // Wall-clock lines are the only thing allowed to differ.
    const strip = (text: string): string =>
      text.replaceAll(/\d+(\.\d+)?\s*(ms|s)\b/g, 'T').replaceAll(/\d+\.\d+ matches\/s/g, 'R');
    expect(strip(again.report)).toBe(strip(outcome.report));
    expect(JSON.stringify(again.records)).toBe(JSON.stringify(outcome.records));
  }, 120_000);
});

describe('experiment kinds', () => {
  it('runs a replacement experiment end to end', async () => {
    const replacement = experimentConfigSchema.parse({
      ...COMMON,
      kind: 'replacement',
      id: 'fixture_replacement',
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
      mirrorSeats: true,
    });
    const result = await runExperiment(replacement, { outputDir: tempDir() });
    expect(result.replacements).toHaveLength(1);
    expect(result.replacements[0]?.subjectCardId).toBe('trench_guard');
    // The two arms played the same games.
    expect(result.replacements[0]?.pairedGames).toBeGreaterThan(0);
    expect(result.report).toContain('trench_guard');
  }, 120_000);

  it('runs a search experiment end to end and writes checkpoints', async () => {
    const output = tempDir();
    const search = experimentConfigSchema.parse({
      ...COMMON,
      kind: 'search',
      id: 'fixture_search',
      populationSize: 4,
      generations: 2,
      eliteCount: 2,
      mutationStrength: 2,
      crossoverShare: 0,
      opponentsPerEvaluation: 2,
      gamesPerOpponent: 1,
      archiveSize: 4,
      checkpointEvery: 1,
    });
    const result = await runExperiment(search, { outputDir: output });
    expect(result.searchHistory).toHaveLength(2);
    expect(readdirSync(join(output, 'checkpoints')).length).toBeGreaterThan(0);
    expect(result.report).toMatch(/## Deck search/);
    // Diversity is printed whether or not it looks healthy.
    expect(result.report).toMatch(/entropy/i);
  }, 180_000);
});

describe('configuration validation', () => {
  it('rejects an unknown experiment kind', () => {
    expect(() => experimentConfigSchema.parse({ ...config(), kind: 'nonsense' })).toThrow();
  });

  it('rejects an unknown field rather than ignoring it', () => {
    expect(() => experimentConfigSchema.parse({ ...config(), typo: true })).toThrow();
  });

  it('rejects an environment ID that is not lowercase_snake_case', () => {
    expect(() =>
      experimentConfigSchema.parse({
        ...config(),
        environment: { id: 'Not Valid' },
      }),
    ).toThrow(/lowercase_snake_case/);
  });

  it('applies documented defaults', () => {
    const parsed = config();
    expect(parsed.analysis.confidence).toBe(0.95);
    expect(parsed.analysis.minMatchesPerCard).toBe(30);
    expect(parsed.retention.keepLogs).toBe(false);
  });
});
