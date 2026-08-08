import { z } from 'zod';
import { cardIdSchema } from '@tcg/card-data';
import { pilotSpecSchema } from '@tcg/bot-interface';
import { environmentConfigSchema } from './environment.js';
import { generatorConfigSchema } from './deck-search/generate.js';

/**
 * Experiment configuration (CLAUDE.md §13.13).
 *
 * Every experiment is a file, every file is runtime-validated, and the file plus
 * the software version is enough to reproduce the run exactly. Nothing about an
 * experiment is passed as an undocumented flag.
 */

export const CONFIG_SCHEMA_VERSION = 1;

export const matchLimitsSchema = z.strictObject({
  maxTurns: z.number().int().min(1).max(10_000).default(200),
  maxActions: z.number().int().min(1).max(1_000_000).default(6000),
  maxDecisionsPerSeat: z.number().int().min(1).max(1_000_000).default(4000),
  noProgressWindow: z.number().int().min(4).max(10_000).default(60),
});

/**
 * What to keep. The default large-run mode keeps aggregates plus a sample,
 * because retaining every action and event for every normal match is what makes
 * a big experiment unrunnable (CLAUDE.md §13.14). Abnormal matches are always
 * kept regardless of these settings.
 */
export const retentionSchema = z.strictObject({
  /** Keep a replay for one match in N. 0 keeps none; 1 keeps all. */
  replaySampleRate: z.number().int().min(0).max(100_000).default(50),
  /** Keep full action and event logs in memory for every match. Debug only. */
  keepLogs: z.boolean().default(false),
  /** Keep per-decision pilot diagnostics. Debug only. */
  keepDecisions: z.boolean().default(false),
});

export const deckSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('inline'),
    decks: z
      .array(
        z.strictObject({
          id: z.string().min(1).max(64).optional(),
          label: z.string().min(1).max(80).optional(),
          commanderId: cardIdSchema,
          cards: z.array(
            z.strictObject({ cardId: cardIdSchema, quantity: z.number().int().min(1).max(99) }),
          ),
        }),
      )
      .min(1),
  }),
  z.strictObject({
    kind: z.literal('generated'),
    count: z.number().int().min(2).max(2000),
    generator: generatorConfigSchema.prefault({}),
  }),
  z.strictObject({
    kind: z.literal('files'),
    /** Paths to deck-builder JSON exports, relative to the config file. */
    paths: z.array(z.string().min(1)).min(1),
  }),
]);
export type DeckSource = z.infer<typeof deckSourceSchema>;

export const PILOT_PAIRINGS = ['mirror', 'all_pairs', 'rotate'] as const;
export const pilotPairingSchema = z.enum(PILOT_PAIRINGS);
export type PilotPairing = z.infer<typeof pilotPairingSchema>;

/**
 * Provisional analysis thresholds.
 *
 * These are review-guidance dials, not game rules and not claims about balance.
 * They are configurable and recorded with every report precisely so a reader can
 * see which dial produced a flag (CLAUDE.md §13.11).
 */
export const analysisSettingsSchema = z.strictObject({
  /** Minimum matches before any card-level conclusion is drawn at all. */
  minMatchesPerCard: z.number().int().min(1).default(30),
  /** Minimum co-occurrences before a card pair is reported. */
  minPairSupport: z.number().int().min(1).default(20),
  /** Minimum matches per deck before a deck win rate is reported. */
  minMatchesPerDeck: z.number().int().min(1).default(20),
  /** Confidence level for every interval the analyser prints. */
  confidence: z.number().min(0.5).max(0.999).default(0.95),
  /** Win-rate lift above which a card is flagged for review. */
  autoIncludeWinRateLift: z.number().min(0).max(1).default(0.08),
  /** Share of strategic clusters a card must beat to count as cross-cluster. */
  crossClusterShare: z.number().min(0).max(1).default(0.75),
  /** Replacement impact, in win-rate points, above which review is recommended. */
  replacementImpact: z.number().min(0).max(1).default(0.06),
  /** Matchup win rate beyond which a pairing is called polarised. */
  polarizationThreshold: z.number().min(0.5).max(1).default(0.85),
  /** Share of copies dead in hand above which an inclusion looks wrong. */
  deadHandShare: z.number().min(0).max(1).default(0.5),
  /** Share of matches ending abnormally above which the run is untrustworthy. */
  abnormalShare: z.number().min(0).max(1).default(0.02),
});
export type AnalysisSettings = z.infer<typeof analysisSettingsSchema>;

/**
 * The provisional thresholds an experiment uses when it does not override them.
 *
 * These are analysis settings, not game rules: they say when the tooling should
 * ask a human to look, and they are expected to move as the prototype's sample
 * sizes and card pool grow (CLAUDE.md §13.11).
 */
export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = analysisSettingsSchema.parse({});

const commonFields = {
  schemaVersion: z.literal(CONFIG_SCHEMA_VERSION),
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_-]*$/, 'Experiment IDs must be lowercase and hyphen/underscore safe.'),
  /** Optional display label; empty falls back to the experiment ID. */
  label: z.string().max(120).default(''),
  /** Root seed. Everything else is derived from it (CLAUDE.md §13.4). */
  seed: z.string().min(1).max(64),
  /** Output directory, relative to the working directory. */
  output: z.string().min(1).default('results'),
  playerCount: z.number().int().min(2).max(4).default(2),
  pilots: z.array(pilotSpecSchema).min(1),
  pilotPairing: pilotPairingSchema.default('mirror'),
  limits: matchLimitsSchema.prefault({}),
  retention: retentionSchema.prefault({}),
  analysis: analysisSettingsSchema.prefault({}),
  workers: z.number().int().min(1).max(64).default(1),
  /** Stop the whole run on the first abnormal match instead of recording it. */
  failFast: z.boolean().default(false),
};

export const batchConfigSchema = z.strictObject({
  ...commonFields,
  kind: z.literal('batch'),
  environment: environmentConfigSchema,
  decks: deckSourceSchema,
  schedule: z.enum(['round_robin', 'sampled']).default('round_robin'),
  /** Number of deck pairings to sample when `schedule` is `sampled`. */
  sampledPairings: z.number().int().min(1).max(100_000).default(50),
  gamesPerPairing: z.number().int().min(1).max(10_000).default(4),
  /** Play every pairing in both seat orders (CLAUDE.md §13.7). */
  mirrorSeats: z.boolean().default(true),
});
export type BatchConfig = z.infer<typeof batchConfigSchema>;

export const searchConfigSchema = z.strictObject({
  ...commonFields,
  kind: z.literal('search'),
  environment: environmentConfigSchema,
  /** Optional decks to seed the population with, alongside generated ones. */
  seedDecks: deckSourceSchema.optional(),
  generator: generatorConfigSchema.prefault({}),
  populationSize: z.number().int().min(4).max(500).default(16),
  generations: z.number().int().min(1).max(500).default(5),
  /** Decks carried forward untouched each generation. */
  eliteCount: z.number().int().min(1).max(100).default(4),
  /** Card swaps applied per mutation. */
  mutationStrength: z.number().int().min(1).max(20).default(3),
  /** Share of offspring produced by crossover rather than mutation. */
  crossoverShare: z.number().min(0).max(1).default(0.25),
  /** Opponents sampled from the archive when evaluating a candidate. */
  opponentsPerEvaluation: z.number().int().min(1).max(64).default(4),
  gamesPerOpponent: z.number().int().min(1).max(100).default(2),
  /** Maximum decks kept in the hall of fame (CLAUDE.md §13.9). */
  archiveSize: z.number().int().min(1).max(500).default(24),
  /** Write a resumable checkpoint every N generations. */
  checkpointEvery: z.number().int().min(1).max(100).default(1),
  /** Re-evaluate elites on fresh seeds each generation to blunt overfitting. */
  reevaluateElites: z.boolean().default(true),
});
export type SearchConfig = z.infer<typeof searchConfigSchema>;

export const comparisonConfigSchema = z.strictObject({
  ...commonFields,
  kind: z.literal('comparison'),
  baseline: environmentConfigSchema,
  candidate: environmentConfigSchema,
  /** Decks evaluated unchanged in both environments, where they stay legal. */
  referenceDecks: deckSourceSchema,
  gamesPerPairing: z.number().int().min(1).max(10_000).default(4),
  mirrorSeats: z.boolean().default(true),
  /**
   * Run an independent deck search in *both* environments as well.
   *
   * Reference decks alone miss novel abuse a new card enables; searched decks
   * alone bias the other way. CLAUDE.md §13.12 requires both.
   */
  searchBothEnvironments: z.boolean().default(true),
  search: z
    .strictObject({
      generator: generatorConfigSchema.prefault({}),
      populationSize: z.number().int().min(4).max(200).default(10),
      generations: z.number().int().min(1).max(100).default(3),
      eliteCount: z.number().int().min(1).max(50).default(3),
      mutationStrength: z.number().int().min(1).max(20).default(3),
      crossoverShare: z.number().min(0).max(1).default(0.25),
      opponentsPerEvaluation: z.number().int().min(1).max(32).default(3),
      gamesPerOpponent: z.number().int().min(1).max(50).default(2),
      archiveSize: z.number().int().min(1).max(200).default(12),
    })
    .prefault({}),
});
export type ComparisonConfig = z.infer<typeof comparisonConfigSchema>;

export const replacementConfigSchema = z.strictObject({
  ...commonFields,
  kind: z.literal('replacement'),
  environment: environmentConfigSchema,
  /** The decks a substitution is applied to. */
  baseDecks: deckSourceSchema,
  /** The opponent field every variant is measured against. */
  opponentDecks: deckSourceSchema,
  /** Card that is taken out. */
  subjectCardId: cardIdSchema,
  /**
   * Candidate replacements. Empty means "pick comparable cards automatically"
   * by cost, type, role, tags, colour legality and power class (CLAUDE.md §13.10).
   */
  candidateCardIds: z.array(cardIdSchema).default([]),
  /** Copies swapped out per variant; `all` removes the card entirely. */
  copies: z.union([z.number().int().min(1).max(4), z.literal('all')]).default('all'),
  gamesPerPairing: z.number().int().min(1).max(10_000).default(4),
  mirrorSeats: z.boolean().default(true),
  /** Also insert the subject into decks that do not run it (CLAUDE.md §13.10). */
  includeInsertion: z.boolean().default(true),
});
export type ReplacementConfig = z.infer<typeof replacementConfigSchema>;

export const experimentConfigSchema = z.discriminatedUnion('kind', [
  batchConfigSchema,
  searchConfigSchema,
  comparisonConfigSchema,
  replacementConfigSchema,
]);
export type ExperimentConfig = z.infer<typeof experimentConfigSchema>;
export type ExperimentConfigInput = z.input<typeof experimentConfigSchema>;

export function parseExperimentConfig(input: unknown): ExperimentConfig {
  return experimentConfigSchema.parse(input);
}
