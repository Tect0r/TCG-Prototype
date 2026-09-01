import { z } from 'zod';

import {
  SOURCE_CLASSES,
  experimentKindSchema,
  experimentPurposeSchema,
  experimentSlugSchema,
  sourceClassSchema,
  sourceClassesSchema,
  stageIdSchema,
  type SourceClass,
} from './identity.js';

/**
 * The named tests an administrator can start, and the values each one chooses on
 * their behalf.
 *
 * A preset is a **choice plus an expansion**. The choice is what a person picks;
 * the expansion is an ordinary validated experiment configuration, or an ordered
 * plan of them, produced in `apps/admin-server` by
 * `expandPreset`. Nothing here expands anything — this package cannot, because
 * `experimentConfigSchema` lives in `@tcg/simulator` and the simulator is
 * server-only. What this file owns is the vocabulary both ends share: which
 * presets exist, what each one claims about itself, what a person may set, and
 * the record of every value the expansion settled.
 *
 * ## Why a choice names identifiers and nothing else
 *
 * [ADR 0023](../../../docs/architecture/0023-admin-lab-boundary.md) §5: *a
 * request never names a filesystem path; it names an identifier that the server
 * resolves.* Every knob below is an identifier, a count or a flag. There is no
 * output root, no config path, no deck file and no free-form JSON blob, and the
 * strict objects mean an unknown field is a parse error rather than something
 * that reaches the expansion.
 *
 * The identifier schemas here are deliberately shallow — a bounded non-empty
 * string. A precon ID's real shape belongs to `@tcg/card-data`, a pilot ID's to
 * `@tcg/bot-interface` and a perturbation profile's to the same, and restating
 * any of them here would be the second copy this package exists to refuse. The
 * server re-validates each against the package that owns it and refuses by name,
 * which is the check that can actually fail correctly: a shape test here would
 * accept `precon_does_not_exist` and prove nothing.
 *
 * ## Why the expansion record is a list of decisions
 *
 * The milestone asks that a preset record *every value it chose*. It cannot do
 * that by carrying the configuration, for the dependency reason above — and it
 * should not, because a configuration answers "what will run" while a reader of
 * a preset needs "which of these numbers did I pick and which did the preset
 * pick for me". `presetDecisionSchema` answers the second question, and the
 * configuration itself is written into the canonical experiment directory by the
 * tranche that runs it.
 */

/* ---------------------------------------------------------------- the list */

/**
 * Every preset this build knows, available and reserved alike.
 *
 * Eight are available and one is reserved. The milestone's prose names the eight
 * — Precon Smoke, Standard and Deep, Open Meta, Commander Search, Candidate
 * Comparison, Pilot Robustness and Engine Soak — while its checklist line counts
 * seven; the enumeration is the authority, because each of the eight names a
 * distinct expansion and the count named none of them.
 *
 * `adaptive_counter` is listed and cannot be expanded. M08.3's exclusion is that
 * Adaptive Counter Search stays a *reserved type only* and its algorithm is
 * M08.16, and a reserved type that appears nowhere is indistinguishable from one
 * nobody thought of — the registry status is what makes the reservation a fact a
 * test can check.
 */
export const EXPERIMENT_PRESET_IDS = [
  'precon_smoke',
  'precon_standard',
  'precon_deep',
  'open_meta',
  'commander_search',
  'candidate_comparison',
  'pilot_robustness',
  'engine_soak',
  'adaptive_counter',
] as const;
export const experimentPresetIdSchema = z.enum(EXPERIMENT_PRESET_IDS);
export type ExperimentPresetId = z.infer<typeof experimentPresetIdSchema>;

/**
 * The four primary test styles and the three advanced templates the milestone
 * objective names, as a closed set.
 *
 * Separate from the preset ID because three presets share one style: Precon
 * Smoke, Standard and Deep are the same test at three depths, and a result view
 * that wants "every precon benchmark" should not have to know how many depths
 * exist.
 */
export const PRESET_TEST_STYLES = [
  'precon_benchmark',
  'open_meta_search',
  'commander_search',
  'adaptive_counter_search',
  'candidate_patch_comparison',
  'pilot_robustness',
  'engine_soak',
] as const;
export const presetTestStyleSchema = z.enum(PRESET_TEST_STYLES);
export type PresetTestStyle = z.infer<typeof presetTestStyleSchema>;

/**
 * Whether a preset can be started.
 *
 * The same two words `@tcg/bot-config`'s difficulty registry uses, and for the
 * same reason: a vocabulary entry that exists without behaviour behind it has to
 * say so, or a caller reading a record that cites it cannot tell whether the
 * build that wrote it could actually run one.
 */
export const PRESET_STATUSES = ['available', 'reserved'] as const;
export const presetStatusSchema = z.enum(PRESET_STATUSES);
export type PresetStatus = z.infer<typeof presetStatusSchema>;

export interface ExperimentPresetDefinition {
  readonly id: ExperimentPresetId;
  readonly label: string;
  readonly summary: string;
  readonly status: PresetStatus;
  readonly testStyle: PresetTestStyle;
  /** The experiment kinds its stages are made of. Empty while reserved. */
  readonly kinds: readonly z.infer<typeof experimentKindSchema>[];
  /** What the evidence it produces is, in the milestone's own six words. */
  readonly sourceClasses: readonly SourceClass[];
  /** What a run of this preset may never be cited for, shown with its results. */
  readonly limitations: readonly string[];
}

/**
 * What each preset claims about itself.
 *
 * `limitations` is part of the definition rather than something a result screen
 * writes later, because the milestone's result rules require evidence-claim and
 * calibration standing to be visible *before* a reader may treat a number as
 * evidence — and a limitation that is authored at the point of display is one
 * that can be forgotten at the point of display.
 */
export const PRESET_REGISTRY: Readonly<Record<ExperimentPresetId, ExperimentPresetDefinition>> =
  Object.freeze({
    precon_smoke: {
      id: 'precon_smoke',
      label: 'Precon Smoke',
      summary:
        'The shipped precons against each other, one game per seat order. Fast enough to run ' +
        'after a content change, and sized to show that every pairing terminates rather than ' +
        'to measure anything.',
      status: 'available',
      testStyle: 'precon_benchmark',
      kinds: ['batch'],
      sourceClasses: ['ai', 'precon'],
      limitations: [
        'One game per seat order is a termination and determinism check, not a win-rate ' +
          'measurement. Nothing in a smoke run supports a balance conclusion.',
      ],
    },
    precon_standard: {
      id: 'precon_standard',
      label: 'Precon Standard',
      summary:
        'The shipped precons against each other over four games per seat order — the default ' +
        'depth for reading a matchup table.',
      status: 'available',
      testStyle: 'precon_benchmark',
      kinds: ['batch'],
      sourceClasses: ['ai', 'precon'],
      limitations: [
        'Calibration evidence flown by heuristic pilots. No shipped pilot is archetype-aware ' +
          'or human, so a result describes how the decks behave under these instruments.',
      ],
    },
    precon_deep: {
      id: 'precon_deep',
      label: 'Precon Deep',
      summary:
        'The shipped precons over twelve games per seat order, with every pilot in the ' +
        'selection flown separately, for a matchup table with enough support to read a ' +
        'confidence interval.',
      status: 'available',
      testStyle: 'precon_benchmark',
      kinds: ['batch'],
      sourceClasses: ['ai', 'precon'],
      limitations: [
        'Calibration evidence flown by heuristic pilots. More games narrow the interval ' +
          'around what these pilots do; they do not make the pilots human.',
      ],
    },
    open_meta: {
      id: 'open_meta',
      label: 'Open Meta Search',
      summary:
        'The search chooses legal Commanders and builds its own decks, over independent ' +
        'replicates, to find what the card pool allows rather than what anyone expected.',
      status: 'available',
      testStyle: 'open_meta_search',
      kinds: ['search'],
      sourceClasses: ['ai', 'search'],
      limitations: [
        'Discovery, not validation. Decks found on search games have been selected on those ' +
          'games and must be frozen and replayed on a fresh seed family before any claim ' +
          'about their strength.',
        'Inclusion counts from a search are bounded below by the forced-inclusion floor, and ' +
          'a single replicate is one sample of a stochastic process.',
      ],
    },
    commander_search: {
      id: 'commander_search',
      label: 'Commander Search',
      summary:
        'One equal-budget search per selected Commander, so the ecosystems are compared on ' +
        'the same amount of work rather than on how long each was left running.',
      status: 'available',
      testStyle: 'commander_search',
      kinds: ['search'],
      sourceClasses: ['ai', 'search'],
      limitations: [
        'Discovery, not validation. These searches alone support no comparison between ' +
          'Commanders; the `schedule-championship` request turns a batch of completed ones ' +
          'into a frozen, fresh-seed round once every search in it has finished.',
        'Equal budget is equal *configured* budget. Two Commanders with differently sized ' +
          'legal pools are not equally free at the same population size.',
      ],
    },
    candidate_comparison: {
      id: 'candidate_comparison',
      label: 'Candidate Patch Comparison',
      summary:
        'The same reference decks, the same seeds and the same seat orders played in two ' +
        'environments that differ only by the cards the candidate removes.',
      status: 'available',
      testStyle: 'candidate_patch_comparison',
      kinds: ['comparison'],
      sourceClasses: ['ai', 'precon', 'search'],
      limitations: [
        'A candidate environment is a temporary experiment environment. Nothing in it can ' +
          'publish live content.',
        'The declared change is checked against the two resolved pools before any match ' +
          'runs; an undeclared difference stops the run rather than being measured.',
      ],
    },
    pilot_robustness: {
      id: 'pilot_robustness',
      label: 'Pilot Robustness',
      summary:
        'One bounded schedule played once per perturbation profile, on identical seeds, to ' +
        'ask whether a conclusion survives the pilots being wrong.',
      status: 'available',
      testStyle: 'pilot_robustness',
      kinds: ['robustness'],
      sourceClasses: ['ai', 'precon'],
      limitations: [
        'Profiles are never pooled into one rate. The result is an agreement question — do ' +
          'the arms agree — and a pooled number would hide exactly the sensitivity being ' +
          'measured.',
      ],
    },
    engine_soak: {
      id: 'engine_soak',
      label: 'Engine Soak',
      summary:
        'A bounded batch flown by the random-legal pilot, run for volume, to surface crashes, ' +
        'stalls, loops, illegal choices and limit trips.',
      status: 'available',
      testStyle: 'engine_soak',
      kinds: ['batch'],
      sourceClasses: ['ai', 'precon'],
      limitations: [
        'Engine health, never balance. A random-legal pilot does not play the game, so a win ' +
          'rate from a soak run means nothing at all.',
      ],
    },
    adaptive_counter: {
      id: 'adaptive_counter',
      label: 'Adaptive Counter Search',
      summary:
        'Decks revise between evaluation blocks, with the cumulative series and the frozen ' +
        'final strength recorded separately. Reserved: the schema and the algorithm are ' +
        'M08.16 and later.',
      status: 'reserved',
      testStyle: 'adaptive_counter_search',
      kinds: [],
      sourceClasses: ['ai', 'adaptive'],
      limitations: [
        'Reserved type. This build can name an adaptive run and cannot schedule one; a ' +
          'request to expand it is refused rather than approximated with a search.',
      ],
    },
  });

/** Presets an administrator can actually start, in registry order. */
export const AVAILABLE_PRESET_IDS: readonly ExperimentPresetId[] = EXPERIMENT_PRESET_IDS.filter(
  (id) => PRESET_REGISTRY[id].status === 'available',
);

/**
 * The definition above, as a schema, so it can cross a wire and be checked on
 * arrival.
 *
 * M08.1 wrote `ExperimentPresetDefinition` as an interface because the registry
 * is a constant in this package and a constant needs no parser. M08.6 sends the
 * registry to a client, and a response the service does not validate on its way
 * out is a response whose shape is decided by whatever the handler happened to
 * build. It is derived from the same enums the interface's members are, and
 * `presets.test.ts` parses all eight entries through it, so the two cannot
 * describe different things without a test failing.
 *
 * `limitations` and `kinds` are required to be non-empty for an **available**
 * preset only: a preset a person can start must say what its results may never be
 * cited for and what it is made of, and a `reserved` one has neither results nor
 * stages yet. That is the same asymmetry `PRESET_REGISTRY` already holds —
 * `adaptive_counter` carries no kinds — expressed as a rule rather than as an
 * accident of the data.
 */
export const experimentPresetDefinitionSchema = z
  .strictObject({
    id: experimentPresetIdSchema,
    label: z.string().min(1).max(80),
    summary: z.string().min(1).max(800),
    status: presetStatusSchema,
    testStyle: presetTestStyleSchema,
    kinds: z.array(experimentKindSchema).max(8),
    sourceClasses: z.array(sourceClassSchema).max(SOURCE_CLASSES.length),
    limitations: z.array(z.string().min(1).max(600)).max(16),
  })
  .refine(
    (preset) => preset.status !== 'available' || preset.limitations.length >= 1,
    'A preset an administrator can start must say what its results may not be cited for.',
  )
  .refine(
    (preset) => preset.status !== 'available' || preset.kinds.length >= 1,
    'A preset an administrator can start is made of at least one experiment kind.',
  );
export type ExperimentPresetDefinitionValue = z.infer<typeof experimentPresetDefinitionSchema>;

/* -------------------------------------------------------------- the choice */

/**
 * A named thing the server resolves: a precon, a pilot, a Commander, a card, a
 * perturbation profile.
 *
 * Bounded and non-empty, and nothing further — see the header. The name of the
 * schema says what it is for so a future reader does not mistake the looseness
 * for an oversight.
 */
const resolvedIdSchema = z.string().min(1).max(64);

const commonChoiceFields = {
  /** The name this run is filed under. */
  experimentId: experimentSlugSchema,
  /** The root seed everything else is derived from. */
  seed: z.string().min(1).max(64),
};

const preconSelection = z.array(resolvedIdSchema).min(2).max(16);
const pilotSelection = z.array(resolvedIdSchema).min(1).max(4);

/* ------------------------------------------- the precon-benchmark settings */

/**
 * How many games per seat order: the preset's own depth, or a number.
 *
 * A discriminated union rather than an optional integer, because "leave it to
 * the preset" and "I want four" are different intentions and an optional field
 * cannot hold the first one. `mode: 'preset'` says the depth *is* the preset —
 * which is what separates Smoke from Standard from Deep — and `mode: 'custom'`
 * says an administrator overrode it, which is a fact the expansion records as
 * `chosen` rather than `preset` and which a result reader needs in order to know
 * that "Precon Standard" did not run at Standard's depth.
 */
export const preconWorkloadSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('preset') }),
  z.strictObject({
    mode: z.literal('custom'),
    /** Matches per deck tuple, per pilot tuple, per seat order. */
    gamesPerSeatOrder: z.number().int().min(1).max(10_000),
  }),
]);
export type PreconWorkload = z.infer<typeof preconWorkloadSchema>;

/**
 * The one retention dial a builder exposes.
 *
 * `retentionSchema` in `@tcg/simulator` has three fields and two of them —
 * `keepLogs` and `keepDecisions` — are marked *debug only* there, because each
 * holds every action and every per-decision diagnostic of every match in memory
 * for the length of the run. A form offering them would be a form offering to
 * exhaust the lab machine on a large schedule, in one click, with nothing to say
 * that is what it does. So they are settled by the expansion at `false`, and
 * recorded as `preset` decisions rather than silently omitted; the tranche that
 * has a real reason to expose them is the one that can also bound them.
 *
 * The replay sample rate is different in kind: it decides how much of the run is
 * reproducible afterwards, an operator genuinely trades it against disk, and its
 * cost is linear and visible. `0` keeps none and `1` keeps all — the simulator's
 * own meaning, restated nowhere.
 */
export const preconRetentionSchema = z.strictObject({
  replaySampleRate: z.number().int().min(0).max(100_000).default(50),
});
export type PreconRetention = z.infer<typeof preconRetentionSchema>;

/**
 * What an administrator sets on a precon benchmark beyond *which decks* and
 * *which pilots*.
 *
 * M08.3 named this widening in advance and said it should be visible: *games per
 * seat order is what separates Smoke from Standard from Deep, so it is not a
 * knob on any of them; M08.8 owns the custom-workload control and will widen
 * this shape visibly when it adds one.* This is that widening, and it prefaults
 * whole — a client that sends no `settings` gets the preset's own depth, one
 * replicate, mirrored seat orders, the simulator's own replay rate and one
 * worker, which is exactly the run M08.6 built.
 *
 * The four bounds restate `@tcg/simulator`'s, which this package cannot import.
 * That restatement is safe in one direction only, and it is the safe one: every
 * value here is re-validated by `parseExperimentConfig` inside the expansion, so
 * a bound that drifted *wider* than the simulator's is refused there rather than
 * accepted, and a bound that drifted narrower refuses a run this build would
 * otherwise have accepted. Neither produces a run nobody asked for.
 */
export const preconBenchmarkSettingsSchema = z.strictObject({
  workload: preconWorkloadSchema.prefault({ mode: 'preset' }),
  /**
   * Independent repeats of the whole benchmark, each on its own seed family.
   *
   * One stage per replicate, so each is its own job and its own canonical
   * experiment directory. That is the only honest shape available: replicates
   * exist to answer *how much does this move between independent runs*, and
   * pooling them into one directory would answer a different question — the one
   * `gamesPerSeatOrder` already answers, by adding games inside a single seed
   * family.
   *
   * Nothing in this build pools replicate directories into one number, and the
   * expansion says so in its own limitations rather than leaving a reader to
   * assume that four runs are one run with four times the support.
   */
  replicates: z.number().int().min(1).max(16).default(1),
  /**
   * Play every pairing in both seat orders.
   *
   * `true` by default because a matchup played one way round cannot separate
   * deck strength from seat advantage, and CLAUDE.md §13.7 is the repository's
   * standing answer to that. Turning it off is offered, because halving a
   * schedule is a real thing to want from a smoke run — and the expansion
   * attaches a limitation to the result when it is off, so the saving is visible
   * wherever the number it produced is read.
   */
  mirrorSeats: z.boolean().default(true),
  retention: preconRetentionSchema.prefault({}),
  /**
   * Simulator worker threads this run asks for.
   *
   * A request and never a grant: `grantWorkers` in the orchestrator takes the
   * smallest of what a configuration asked for, what one job may have and what
   * is left, so raising this can never widen a run past the operator's own
   * bound. `configHashOf` excludes it, so changing it does not make a resumed
   * run a different run.
   */
  workers: z.number().int().min(1).max(64).default(1),
});
export type PreconBenchmarkSettings = z.infer<typeof preconBenchmarkSettingsSchema>;
export type PreconBenchmarkSettingsInput = z.input<typeof preconBenchmarkSettingsSchema>;

/**
 * What an administrator picks, per preset.
 *
 * A discriminated union rather than one shape with optional fields, because the
 * knobs genuinely differ — a soak has no Commander selection and a search has no
 * precon list — and an optional field is a field somebody will fill in for the
 * preset that ignores it.
 *
 * Everything a preset decides for itself is deliberately absent. Games per seat
 * order is what separates Smoke from Standard from Deep, so it is not a knob on
 * any of them — **except** through `settings.workload`, which M08.8 added as the
 * visible widening M08.3 said it would be. Choosing `mode: 'custom'` overrides
 * the depth and is recorded as a `chosen` decision, so a run cannot claim a
 * preset's depth without having used it.
 *
 * The `settings` block is on the three precon-benchmark presets and on no
 * other. M08.8's exclusion is *no other builder*, and a knob on a preset with no
 * screen behind it would be a shape nothing sends and nothing validates against
 * a real form.
 */
export const presetChoiceSchema = z.discriminatedUnion('presetId', [
  z.strictObject({
    presetId: z.literal('precon_smoke'),
    ...commonChoiceFields,
    preconIds: preconSelection,
    pilotIds: pilotSelection,
    settings: preconBenchmarkSettingsSchema.prefault({}),
  }),
  z.strictObject({
    presetId: z.literal('precon_standard'),
    ...commonChoiceFields,
    preconIds: preconSelection,
    pilotIds: pilotSelection,
    settings: preconBenchmarkSettingsSchema.prefault({}),
  }),
  z.strictObject({
    presetId: z.literal('precon_deep'),
    ...commonChoiceFields,
    preconIds: preconSelection,
    pilotIds: pilotSelection,
    settings: preconBenchmarkSettingsSchema.prefault({}),
  }),
  z.strictObject({
    presetId: z.literal('open_meta'),
    ...commonChoiceFields,
    pilotIds: pilotSelection,
    /**
     * Restrict the search to these Commanders. Empty means every legal one —
     * still "open" (M08.14): scoping the field is a way to search *within*
     * the open meta, not a different preset.
     */
    commanderIds: z.array(resolvedIdSchema).max(16).default([]),
    /**
     * Seed every generated deck from an authored plan (M08.14's "unconstrained
     * or plan" seed policy). Omitted is unconstrained generation, which is the
     * default and what "open" meant before this field existed.
     */
    planId: resolvedIdSchema.optional(),
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
    /** Maximum decks kept in the hall of fame. */
    archiveSize: z.number().int().min(1).max(500).default(24),
    replicates: z.number().int().min(1).max(8).default(2),
    retention: preconRetentionSchema.prefault({}),
  }),
  z.strictObject({
    presetId: z.literal('commander_search'),
    ...commonChoiceFields,
    /** One equal-budget search per Commander named here. */
    commanderIds: z.array(resolvedIdSchema).min(1).max(16),
    pilotIds: pilotSelection,
    populationSize: z.number().int().min(4).max(500).default(16),
    generations: z.number().int().min(1).max(500).default(5),
    replicates: z.number().int().min(1).max(8).default(1),
  }),
  z.strictObject({
    presetId: z.literal('candidate_comparison'),
    ...commonChoiceFields,
    /** Decks played unchanged in both environments. */
    referencePreconIds: preconSelection,
    pilotIds: pilotSelection,
    /**
     * The candidate change: cards the candidate environment removes from the pool.
     *
     * One kind of change rather than a patch editor, and a complete one — a ban
     * list is declarable, checkable against both resolved pools, and reversible.
     * The wider candidate-patch editor is M08.20's, and it widens this member
     * rather than being smuggled in as free-form JSON.
     */
    removeCardIds: z.array(resolvedIdSchema).min(1).max(40),
    gamesPerSeatOrder: z.number().int().min(1).max(200).default(4),
    /** Also run an independent search in both environments (CLAUDE.md §13.12). */
    searchBothEnvironments: z.boolean().default(true),
  }),
  z.strictObject({
    presetId: z.literal('pilot_robustness'),
    ...commonChoiceFields,
    preconIds: preconSelection,
    pilotIds: pilotSelection,
    /** `published` is always the reference arm, whether or not it is listed. */
    profileIds: z.array(resolvedIdSchema).min(1).max(16),
    gamesPerSeatOrder: z.number().int().min(1).max(200).default(4),
  }),
  z.strictObject({
    presetId: z.literal('engine_soak'),
    ...commonChoiceFields,
    preconIds: preconSelection,
    gamesPerSeatOrder: z.number().int().min(1).max(500).default(25),
  }),
]);
export type PresetChoice = z.infer<typeof presetChoiceSchema>;
export type PresetChoiceInput = z.input<typeof presetChoiceSchema>;

/* ----------------------------------------------------------- the expansion */

/** Who settled one value: the administrator, or the preset on their behalf. */
export const PRESET_DECISION_SOURCES = ['chosen', 'preset'] as const;
export const presetDecisionSourceSchema = z.enum(PRESET_DECISION_SOURCES);
export type PresetDecisionSource = z.infer<typeof presetDecisionSourceSchema>;

const presetValueSchema = z.union([
  z.string().max(400),
  z.number(),
  z.boolean(),
  z.array(z.string().max(200)).max(64),
]);
export type PresetValue = z.infer<typeof presetValueSchema>;

/**
 * One value the expansion settled, and who settled it.
 *
 * `path` is the dotted position in the experiment configuration the value landed
 * at — `gamesPerPairing`, `environment.banCardIds`, `search.replicates` — so a
 * reader comparing a preset run against a hand-authored config is comparing the
 * same names. Values that the configuration schema defaults are deliberately not
 * listed: a preset that recorded every default would bury the six numbers it
 * actually decided under forty it merely did not override, and `config.json` in
 * the run directory is where the complete resolved configuration already lives.
 */
export const presetDecisionSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(80)
    .regex(
      /^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*$/,
      'A decision path is dotted field names.',
    ),
  value: presetValueSchema,
  source: presetDecisionSourceSchema,
});
export type PresetDecision = z.infer<typeof presetDecisionSchema>;

/**
 * One stage of an expanded preset, as the client sees it.
 *
 * The configuration itself is not here and cannot be: it is
 * `experimentConfigSchema`'s, the server holds it, and it is written into the
 * canonical experiment directory when the job runs. What travels is the stage's
 * identity, what it is for, and the decisions that produced it.
 */
export const presetStageSchema = z.strictObject({
  stageId: stageIdSchema,
  label: z.string().min(1).max(160),
  kind: experimentKindSchema,
  purpose: experimentPurposeSchema,
  /** The experiment ID the stage's configuration carries. */
  experimentId: experimentSlugSchema,
  decisions: z.array(presetDecisionSchema).max(128),
});
export type PresetStage = z.infer<typeof presetStageSchema>;

/**
 * A preset, expanded: an ordered plan of validated stages and what each chose.
 *
 * `deferredStages` is the honest half. A Commander Search's frozen finalist
 * championship is a real part of the test that **this expansion** cannot
 * configure — its decks do not exist until every named search has finished —
 * so it is named as a stage that is not scheduled *here* rather than omitted,
 * which would quietly turn "not by this call" into "not part of the test".
 * `scheduleChampionship` (M08.15) is the request that schedules it once the
 * named batch's searches have completed.
 */
export const presetExpansionSchema = z
  .strictObject({
    presetId: experimentPresetIdSchema,
    testStyle: presetTestStyleSchema,
    sourceClasses: sourceClassesSchema,
    stages: z.array(presetStageSchema).min(1).max(64),
    deferredStages: z
      .array(
        z.strictObject({
          stageId: stageIdSchema,
          label: z.string().min(1).max(160),
          /** Why it is not scheduled, naming the tranche that will schedule it. */
          reason: z.string().min(1).max(400),
        }),
      )
      .max(16)
      .default([]),
    limitations: z.array(z.string().min(1).max(400)).max(32).default([]),
  })
  .refine(
    (expansion) =>
      new Set(expansion.stages.map((stage) => stage.stageId)).size === expansion.stages.length,
    'Stage IDs are unique within one expansion.',
  );
export type PresetExpansion = z.infer<typeof presetExpansionSchema>;
