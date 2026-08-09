import { z } from 'zod';
import { cardIdSchema } from '@tcg/card-data';
import { perturbationProfileIdSchema, pilotSpecSchema } from '@tcg/bot-interface';
import { declaredChangesSchema, environmentConfigSchema } from './environment.js';
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
  /* --------------------------------------------- minimum evidence (counts) */
  /** Seat-matches. Minimum before any card-level conclusion is drawn at all. */
  minMatchesPerCard: z.number().int().min(1).default(30),
  /** Seat-matches. Minimum co-occurrences before a card pair is reported. */
  minPairSupport: z.number().int().min(1).default(20),
  /**
   * Seat-matches. Minimum in *each* of the four cells of a synergy contrast
   * (both cards, A only, B only, neither) before an interaction is estimated.
   * Separate from `minPairSupport`, which only counts the "both" cell.
   */
  minPairCellSupport: z.number().int().min(1).default(15),
  /** Seat-matches. Minimum per deck before a deck win rate is reported. */
  minMatchesPerDeck: z.number().int().min(1).default(20),
  /** Complete pairs. Minimum before a paired estimate is trusted. */
  minPairedGames: z.number().int().min(1).default(20),

  /* ------------------------------------------------------------ intervals */
  /** Confidence level for every interval the analyser prints. */
  confidence: z.number().min(0.5).max(0.999).default(0.95),
  /** Resamples per bootstrap interval. Deterministic given the analysis seed. */
  bootstrapIterations: z.number().int().min(200).max(50_000).default(2000),

  /* -------------------------------------------------- card-level thresholds */
  /** Win-rate points (0–1). Inclusion lift above which a card is flagged. */
  autoIncludeWinRateLift: z.number().min(0).max(1).default(0.08),
  /** Win-rate points (0–1). Replacement impact above which review is advised. */
  replacementImpact: z.number().min(0).max(1).default(0.06),
  /** Share (0–1) of copies dead in hand above which an inclusion looks wrong. */
  deadHandShare: z.number().min(0).max(1).default(0.5),

  /* ------------------------------------------- cross-cluster inclusion (§5) */
  /**
   * Share (0–1) of a *cluster's* decks that must run a card before that cluster
   * counts as covered. Deliberately distinct from `crossClusterShare`: this one
   * is measured within one cluster, that one across clusters.
   */
  withinClusterInclusionThreshold: z.number().min(0).max(1).default(0.5),
  /** Share (0–1) of eligible clusters a card must cover to be cross-cluster. */
  crossClusterShare: z.number().min(0).max(1).default(0.75),
  /** Count. Covered clusters required before the cross-cluster flag can raise. */
  minimumCoveredClusters: z.number().int().min(1).default(3),
  /** Decks. Minimum size for a cluster to enter the cross-cluster denominator. */
  minDecksPerCluster: z.number().int().min(1).default(3),
  /** Seat-matches. Minimum observations for a cluster to be eligible. */
  minObservationsPerCluster: z.number().int().min(0).default(20),
  /** Decks. Minimum total decks running the card behind a cross-cluster flag. */
  minDecksSupportingCard: z.number().int().min(1).default(6),
  /**
   * Share (0–1) of *all* decks running a card, reported separately from cluster
   * coverage under its own name. Never used as a cross-cluster criterion.
   */
  deckInclusionShare: z.number().min(0).max(1).default(0.6),

  /* --------------------------------------------------- cluster and matchup */
  /** Matchup win rate (0–1) beyond which a pairing is called polarised. */
  polarizationThreshold: z.number().min(0.5).max(1).default(0.85),

  /* ------------------------------------------ opponent-field sensitivity (§10.1) */
  /** Win-rate points (0–1). Spread across opponent fields above which to flag. */
  opponentFieldSpread: z.number().min(0).max(1).default(0.2),
  /** Seat-matches. Minimum per opponent field before that field is used. */
  minMatchesPerOpponentField: z.number().int().min(1).default(20),
  /** Count. Opponent fields that must clear the minimum before spread is judged. */
  minOpponentFields: z.number().int().min(2).default(2),

  /* --------------------------------------------------- displacement (§11) */
  /** Share (0–1). Relative drop in normalized inclusion share worth reporting. */
  displacementShareDrop: z.number().min(0).max(1).default(0.5),
  /** Count. Independent search replicates required before displacement flags. */
  minDisplacementReplicates: z.number().int().min(1).default(2),
  /** Decks. Minimum eligible decks per replicate for a displacement claim. */
  minDecksPerReplicate: z.number().int().min(1).default(8),

  /* -------------------------------------------------- pilot robustness (§10.3) */
  /**
   * Share (0–1) of perturbation profiles that must agree with the published
   * pilot before a conclusion is labelled `stable`.
   */
  pilotRobustnessAgreement: z.number().min(0).max(1).default(0.75),

  /* ------------------------------------------------------------ run quality */
  /** Share (0–1) of matches ending abnormally above which the run is suspect. */
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
  /**
   * Independent search runs, each on its own derived seed family.
   *
   * One evolutionary run is one sample. Inclusion counts drawn from a single run
   * fluctuate enough that "6 → 3 copies" is noise, so displacement analysis
   * needs several replicates before it may say anything (PHASE4_HARDENING §11).
   */
  replicates: z.number().int().min(1).max(8).default(1),
});
export type SearchConfig = z.infer<typeof searchConfigSchema>;

export const comparisonConfigSchema = z.strictObject({
  ...commonFields,
  kind: z.literal('comparison'),
  baseline: environmentConfigSchema,
  candidate: environmentConfigSchema,
  /**
   * What this comparison claims to change, checked against the resolved pools
   * before any match runs (PHASE4_HARDENING §4).
   *
   * An empty declaration means "do not check", which is legal for exploratory
   * work but is reported as a limitation: an unchecked comparison cannot promise
   * it measured the change its label describes.
   */
  declaredChanges: declaredChangesSchema.prefault({}),
  /**
   * Decks evaluated unchanged in both environments.
   *
   * Resolved exactly once, against the baseline, and then frozen. The identical
   * deck definitions, seat assignments, pilots and derived seeds are replayed in
   * the candidate environment (PHASE4_HARDENING §6).
   */
  referenceDecks: deckSourceSchema,
  /**
   * How the reference population is shared between the two environments.
   *
   * `shared_legal_reference_population` — the only supported policy — keeps the
   * decks legal in *both* environments and reports the rest as exclusions with
   * their legality reasons. Regenerating a population per environment is what
   * §6 forbids, so there is deliberately no option that does it.
   */
  referencePolicy: z
    .enum(['shared_legal_reference_population'])
    .default('shared_legal_reference_population'),
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
      /** Independent replicates per environment, for stable displacement evidence. */
      replicates: z.number().int().min(1).max(8).default(2),
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
  /**
   * The opponent decks a "counter" is supposed to answer (PHASE4_HARDENING §10.2).
   *
   * When set, each candidate replacement is measured twice: against this target
   * subset of the opponent field, and against the rest of it. That is what turns
   * "this cluster loses to that cluster" into evidence about a *card* — an answer
   * only counts as practical when it improves the target matchup without
   * becoming dead against everything else. Empty means counter breadth is
   * reported as `unavailable` rather than guessed from matchup clusters.
   */
  counterTargetDeckIds: z.array(z.string().min(1)).default([]),
});
export type ReplacementConfig = z.infer<typeof replacementConfigSchema>;

/**
 * Pilot-robustness experiment (PHASE4_HARDENING §10.3).
 *
 * Runs one bounded, common-seed schedule once per named perturbation profile and
 * asks whether the conclusions move. It deliberately does not merge the profiles
 * into one population: a pooled result would hide exactly the sensitivity the
 * experiment exists to measure.
 */
export const robustnessConfigSchema = z.strictObject({
  ...commonFields,
  kind: z.literal('robustness'),
  environment: environmentConfigSchema,
  decks: deckSourceSchema,
  /** Profiles to run. `published` is always included as the reference arm. */
  profiles: z.array(perturbationProfileIdSchema).min(1).default(['published']),
  gamesPerPairing: z.number().int().min(1).max(10_000).default(4),
  mirrorSeats: z.boolean().default(true),
  schedule: z.enum(['round_robin', 'sampled']).default('round_robin'),
  sampledPairings: z.number().int().min(1).max(100_000).default(50),
});
export type RobustnessConfig = z.infer<typeof robustnessConfigSchema>;

export const experimentConfigSchema = z.discriminatedUnion('kind', [
  batchConfigSchema,
  searchConfigSchema,
  comparisonConfigSchema,
  replacementConfigSchema,
  robustnessConfigSchema,
]);
export type ExperimentConfig = z.infer<typeof experimentConfigSchema>;
export type ExperimentConfigInput = z.input<typeof experimentConfigSchema>;

export function parseExperimentConfig(input: unknown): ExperimentConfig {
  return experimentConfigSchema.parse(input);
}
