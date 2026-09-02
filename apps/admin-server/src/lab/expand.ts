import {
  PRESET_REGISTRY,
  adminError,
  adminSchemaErrors,
  looksLikeFilesystemPath,
  presetChoiceSchema,
  presetExpansionSchema,
  type AdminError,
  type CandidateCardPatch,
  type ExperimentPurpose,
  type PresetChoice,
  type PresetChoiceInput,
  type PresetDecision,
  type PresetExpansion,
  type PresetValue,
} from '@tcg/admin-contracts';
import {
  environmentConfigForFormat,
  parseExperimentConfig,
  resolveEnvironment,
  resolvePlan,
  PlanResolutionError,
  type CardPatch,
  type Environment,
  type EnvironmentConfig,
  type ExperimentConfig,
} from '@tcg/simulator';
import { z } from 'zod';

/**
 * Turning a preset choice into ordinary validated experiment configurations.
 *
 * The whole of this module's authority is *assembling*. Every value it produces
 * ends up inside `experimentConfigSchema`, which is the simulator's and which
 * refuses an unknown field, an out-of-range count and an unknown pilot before
 * anything here can be believed — so the expansion cannot invent a legal-looking
 * configuration the simulator would not accept. There is no second schema, no
 * second legality rule and no second scheduler; ADR 0023 §2 fixes the direction,
 * and `boundary.test.ts` keeps it structural by refusing anything that *runs* a
 * configuration.
 *
 * ## Where the format's numbers come from
 *
 * From the format. `environmentConfigForFormat` reads `content/formats` once and
 * writes the construction rules into the configuration exactly as a hand-authored
 * file states them. An admin layer that transcribed "40 cards, singleton, one
 * copy" would be a second copy of the format that keeps working, wrongly, the
 * day the format changes.
 *
 * ## Why a refusal is `admin/schema`
 *
 * Every refusal below is a value the request supplied being wrong for the field
 * it was supplied for — an unknown precon, a Commander this format does not
 * publish, a card the pool does not contain. That is what `admin/schema` names,
 * and the error carries the field path so a form can put the message beside the
 * control. No new error code was added, because none of these is a new *kind* of
 * failure; a policy refusal that is not a bad value — there is none in M08.3 —
 * would be, and would move `ADMIN_CONTRACT_VERSION` deliberately.
 */

/* ------------------------------------------------------------ the vocabulary */

/** The format every preset in this build runs in. */
export const PRESET_FORMAT_ID = 'precon_wave_1';

/**
 * The pilot the Engine Soak preset flies, chosen by the preset and not by the
 * administrator.
 *
 * A soak measures whether the engine survives being driven, so the driver has to
 * be the one that makes no judgements at all. Letting a heuristic pilot fly it
 * would produce a run that looks like a benchmark and is not one.
 */
const SOAK_PILOT_ID = 'random_legal';

/** Games per seat order at each precon-benchmark depth. The depth *is* the preset. */
const PRECON_DEPTHS = Object.freeze({
  precon_smoke: 1,
  precon_standard: 4,
  precon_deep: 12,
});

/** A bounded turn limit, so a stalled match is a finding rather than an evening. */
const SOAK_TURN_LIMIT = 150;

export interface ExpandedStage {
  readonly stageId: string;
  readonly label: string;
  readonly purpose: ExperimentPurpose;
  /** The ordinary, fully validated configuration this stage runs. */
  readonly config: ExperimentConfig;
  readonly decisions: readonly PresetDecision[];
}

export interface ExpandedPreset {
  /** What travels to a client: identity, stages, decisions, deferrals, limits. */
  readonly expansion: PresetExpansion;
  /** What stays on the server: the same stages, carrying their configurations. */
  readonly stages: readonly ExpandedStage[];
  /** The resolved environment the stages were built against, reused by the estimator. */
  readonly environment: Environment;
}

/** A refusal carrying the field it is about. Thrown, so no caller can ignore one. */
export class PresetRefused extends Error {
  readonly errors: readonly AdminError[];

  constructor(errors: readonly AdminError[]) {
    super(errors.map((entry) => entry.message).join(' | '));
    this.name = 'PresetRefused';
    this.errors = errors;
  }
}

/**
 * A message from another layer, with anything that could be a path taken out.
 *
 * The simulator's refusals are the authoritative ones — `resolveDeckSource`
 * already knows which precons a format publishes — so they are reused rather
 * than rewritten. What the simulator does not know is that its message is about
 * to cross an admin boundary, and ADR 0023 §5 keeps filesystem locations off it.
 * A token that could be a path becomes `<path>`: the sentence still says what
 * went wrong, and the location does not travel.
 */
export function scrubRefusal(message: string): string {
  return message
    .split(/\s+/)
    .map((token) => (looksLikeFilesystemPath(token) ? '<path>' : token))
    .join(' ')
    .slice(0, 480);
}

function refuse(path: string, message: string): never {
  throw new PresetRefused([adminError('admin/schema', message, { path })]);
}

/* -------------------------------------------------------------- decisions */

/** Records one settled value. `chosen` means the administrator picked it. */
function decision(path: string, value: PresetValue, source: 'chosen' | 'preset'): PresetDecision {
  return { path, value, source };
}

/* ------------------------------------------------------------- validation */

function requireDistinct(path: string, values: readonly string[], noun: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value))
      refuse(path, `${noun} "${value}" is listed twice, and a selection is a set.`);
    seen.add(value);
  }
}

/**
 * Checks a Commander selection against the ones the environment actually has.
 *
 * `generatorConfigSchema.commanderIds` is an array of plain strings, so a
 * misspelled Commander would parse, produce a search over an empty selection and
 * be discovered an hour later. The environment is the authority on which
 * Commanders the format publishes, and this is the only place that answer is
 * asked for.
 */
function requireCommanders(environment: Environment, commanderIds: readonly string[]): void {
  const known = new Set(environment.commanders.map((card) => card.id));
  for (const [index, id] of commanderIds.entries()) {
    if (known.has(id)) continue;
    refuse(
      `commanderIds.${String(index)}`,
      `"${id}" is not a Commander in format "${PRESET_FORMAT_ID}". Available: ` +
        `${[...known].sort().join(', ')}.`,
    );
  }
}

/**
 * Checks a plan seed policy against the plans this format actually publishes,
 * and against a non-empty Commander scope, before anything is priced (M08.14).
 *
 * `generatorConfigSchema.planId` is a plain string, so a misspelled or
 * unpublished plan would otherwise parse, price and enqueue, and only fail
 * once `runSearchExperiment` calls `resolvePlan` itself — after the run has
 * already started. `resolvePlan` is the simulator's own authority on which
 * plans exist and which Commander each names, reused rather than duplicated,
 * the same way `requireCommanders` reuses the environment rather than
 * maintaining a second Commander list.
 */
function requirePlan(
  environment: Environment,
  planId: string | undefined,
  commanderIds: readonly string[],
): void {
  if (planId === undefined) return;
  let plan;
  try {
    plan = resolvePlan(planId, environment);
  } catch (cause) {
    if (cause instanceof PlanResolutionError) {
      refuse('generator.planId', scrubRefusal(cause.message));
    }
    throw cause;
  }
  if (commanderIds.length > 0 && !commanderIds.includes(plan.commanderId)) {
    refuse(
      'generator.planId',
      `Deck plan "${planId}" names Commander "${plan.commanderId}", which is outside the ` +
        `selected Commander scope (${commanderIds.join(', ')}).`,
    );
  }
}

/** Checks that a candidate change targets cards the pool actually contains. */
function requirePoolCards(
  environment: Environment,
  cardIds: readonly string[],
  path: string,
  verb: string,
): void {
  const pool = new Set(environment.pool.map((card) => card.id));
  for (const [index, id] of cardIds.entries()) {
    if (pool.has(id)) continue;
    refuse(
      `${path}.${String(index)}`,
      `"${id}" is not in the playable pool of format "${PRESET_FORMAT_ID}", so ${verb} it ` +
        'would declare a change that does not happen.',
    );
  }
}

/**
 * Checks one scalar candidate-change field against the pool the same way
 * `requirePoolCards` checks an array — kept separate rather than wrapped as a
 * one-element array so the refusal's field path is `subjectCardId`, not a
 * misleadingly indexed `subjectCardId.0`.
 */
function requirePoolCard(environment: Environment, cardId: string, path: string, verb: string): void {
  const pool = new Set(environment.pool.map((card) => card.id));
  if (pool.has(cardId)) return;
  refuse(
    path,
    `"${cardId}" is not in the playable pool of format "${PRESET_FORMAT_ID}", so ${verb} it ` +
      'would declare a change that does not happen.',
  );
}

/**
 * Checks a candidate patch list: every target is in the pool once, no card is
 * named by both a removal and a patch, and a combat-stat edit only lands on a
 * card that has combat stats.
 *
 * The last check stands in for `@tcg/card-data`'s statted-type rule without
 * importing it — this workspace cannot (`boundary.test.ts`) — by reading the
 * resolved card itself: a card the pool already carries an `attack` for is a
 * unit, and one it does not is not. `resolveEnvironment` would otherwise catch
 * the same mismatch by re-validating the patched card and throwing a raw
 * `Error`, which is exactly the failure mode `requirePoolCards` exists to turn
 * into an ordinary admin refusal instead.
 */
function requireCandidatePatches(
  environment: Environment,
  removeCardIds: readonly string[],
  patches: readonly CandidateCardPatch[],
): void {
  requireDistinct(
    'cardPatches',
    patches.map((patch) => patch.cardId),
    'Card',
  );
  const pool = new Map(environment.pool.map((card) => [card.id, card] as const));
  const removed = new Set(removeCardIds);
  for (const [index, patch] of patches.entries()) {
    const card = pool.get(patch.cardId);
    if (!card) {
      refuse(
        `cardPatches.${String(index)}.cardId`,
        `"${patch.cardId}" is not in the playable pool of format "${PRESET_FORMAT_ID}", so ` +
          'patching it would declare a change that does not happen.',
      );
    }
    if (removed.has(patch.cardId)) {
      refuse(
        `cardPatches.${String(index)}.cardId`,
        `"${patch.cardId}" is declared both removed and patched. Choose one change for this card.`,
      );
    }
    if ((patch.attack !== undefined || patch.health !== undefined) && card.attack === undefined) {
      refuse(
        `cardPatches.${String(index)}`,
        `"${patch.cardId}" has no attack or health to patch; only a unit's combat stats can be ` +
          'edited this way.',
      );
    }
  }
}

/** The exact declared-change field names a candidate patch produces (§ engine's exact-match check). */
function candidatePatchFields(patch: CandidateCardPatch): string[] {
  const fields: string[] = [];
  if (patch.cost !== undefined) fields.push('cost');
  if (patch.attack !== undefined) fields.push('attack');
  if (patch.health !== undefined) fields.push('health');
  return fields;
}

/* ------------------------------------------------------------- assembling */

/**
 * The one environment every preset in this build runs in, resolved.
 *
 * Exported so `content.ts` offers a chooser exactly the precons this
 * environment can play, rather than a second environment that happens to be
 * spelled the same way. Two constructions of "Precon Wave 1" that drifted would
 * be a form offering a precon the expansion then refuses.
 */
export function presetEnvironment(): Environment {
  return resolveEnvironment(baseEnvironment());
}

/** The same environment, unresolved — what a stage's own `environment` field carries. */
export function presetEnvironmentConfig(): EnvironmentConfig {
  return baseEnvironment();
}

function baseEnvironment(
  overrides: {
    readonly id?: string;
    readonly label?: string;
    readonly banCardIds?: string[];
    readonly cardPatches?: CardPatch[];
  } = {},
): EnvironmentConfig {
  return environmentConfigForFormat(PRESET_FORMAT_ID, {
    label: 'Precon Wave 1: its own card pool, 40-card singleton construction',
    ...overrides,
  });
}

/** Fields every expanded configuration shares, and the decisions that record them. */
function common(
  choice: PresetChoice,
  pilotIds: readonly string[],
): { readonly fields: Record<string, unknown>; readonly decisions: PresetDecision[] } {
  return {
    fields: {
      schemaVersion: 1,
      id: choice.experimentId,
      seed: choice.seed,
      playerCount: 2,
      pilots: pilotIds.map((id) => ({ id })),
      pilotPairing: 'mirror',
    },
    decisions: [
      decision('id', choice.experimentId, 'chosen'),
      decision('seed', choice.seed, 'chosen'),
      decision('playerCount', 2, 'preset'),
      decision('pilots', [...pilotIds], pilotIds.length > 0 ? 'chosen' : 'preset'),
      decision('pilotPairing', 'mirror', 'preset'),
    ],
  };
}

/**
 * Parses an assembled configuration, turning a failure into an admin refusal.
 *
 * This is where "expands into an *ordinary validated* config" stops being a
 * claim: a pilot ID the registry does not know, a count outside its range and a
 * field this build spelled wrongly all fail here, in the simulator's own words,
 * before anything is estimated or enqueued.
 */
export function validated(config: unknown, stageId: string): ExperimentConfig {
  try {
    return parseExperimentConfig(config);
  } catch (cause) {
    if (cause instanceof z.ZodError) {
      throw new PresetRefused(
        adminSchemaErrors(cause).map((entry) => ({
          ...entry,
          message: scrubRefusal(`Stage "${stageId}": ${entry.message}`),
        })),
      );
    }
    throw new PresetRefused([
      adminError(
        'admin/schema',
        scrubRefusal(
          `Stage "${stageId}" could not be configured: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
      ),
    ]);
  }
}

/* ------------------------------------------------------------- expansions */

/**
 * The precon benchmark, at whatever depth and width M08.8's settings asked for.
 *
 * Four of the five settings land inside one configuration — the workload becomes
 * `gamesPerPairing`, the mirror flag becomes `mirrorSeats`, the retention dial
 * becomes `retention.replaySampleRate`, and the worker request becomes
 * `workers`. The fifth, `replicates`, cannot: a replicate is an *independent*
 * run on its own seed family, and two seed families inside one experiment
 * directory would be one aggregate over both, which is the question
 * `gamesPerPairing` already answers.
 *
 * So `n` replicates expand into `n` stages, which `enqueuePreset` turns into `n`
 * jobs and `n` canonical experiment directories. Each derives its own seed from
 * the root one — the same way `commanderSearch` derives one per Commander — so
 * the whole set is reproducible from the single seed an administrator typed.
 *
 * With one replicate the stage keeps its original identity (`matches`, and the
 * experiment ID as given), because a benchmark that was not replicated should
 * produce exactly the run M08.6 produced.
 */
function preconBenchmark(
  choice: Extract<PresetChoice, { presetId: 'precon_smoke' | 'precon_standard' | 'precon_deep' }>,
  environment: EnvironmentConfig,
): ExpandedStage[] {
  const settings = choice.settings;
  const depth = PRECON_DEPTHS[choice.presetId];
  const custom = settings.workload.mode === 'custom';
  const games = settings.workload.mode === 'custom' ? settings.workload.gamesPerSeatOrder : depth;
  const base = common(choice, choice.pilotIds);
  const replicates = settings.replicates;
  const single = replicates === 1;

  return Array.from({ length: replicates }, (_, index) => {
    const ordinal = String(index + 1);
    const stageId = single ? 'matches' : `matches-r${ordinal}`;
    const experimentId = single
      ? choice.experimentId
      : `${choice.experimentId}-r${ordinal}`.slice(0, 40);
    const seed = single ? choice.seed : `${choice.seed}|r${ordinal}`;

    return {
      stageId,
      label:
        `${String(choice.preconIds.length)} precons, ${String(games)} games per seat order` +
        (single ? '' : ` (replicate ${ordinal} of ${String(replicates)})`),
      purpose: 'exploration' as const,
      config: validated(
        {
          ...base.fields,
          id: experimentId,
          seed,
          kind: 'batch',
          label: PRESET_REGISTRY[choice.presetId].label,
          environment,
          decks: { kind: 'precon', preconIds: [...choice.preconIds] },
          schedule: 'round_robin',
          gamesPerPairing: games,
          mirrorSeats: settings.mirrorSeats,
          retention: {
            replaySampleRate: settings.retention.replaySampleRate,
            // Debug-only in the simulator's own words, and settled here rather
            // than exposed: each holds every action and every per-decision
            // diagnostic of every match in memory for the length of the run, and
            // a form offering them would be a form offering to exhaust the lab
            // machine on a large schedule in one click.
            keepLogs: false,
            keepDecisions: false,
          },
          workers: settings.workers,
        },
        stageId,
      ),
      decisions: [
        ...base.decisions.filter((entry) => entry.path !== 'id' && entry.path !== 'seed'),
        decision('id', experimentId, single ? 'chosen' : 'preset'),
        decision('seed', seed, single ? 'chosen' : 'preset'),
        decision('decks.preconIds', [...choice.preconIds], 'chosen'),
        decision('schedule', 'round_robin', 'preset'),
        decision('gamesPerPairing', games, custom ? 'chosen' : 'preset'),
        decision('mirrorSeats', settings.mirrorSeats, 'chosen'),
        decision('retention.replaySampleRate', settings.retention.replaySampleRate, 'chosen'),
        decision('retention.keepLogs', false, 'preset'),
        decision('retention.keepDecisions', false, 'preset'),
        decision('workers', settings.workers, 'chosen'),
        decision('replicates', replicates, 'chosen'),
      ],
    };
  });
}

/**
 * What a precon-benchmark choice's own settings make untrue about its results,
 * beyond what the preset already publishes.
 *
 * Attached to the expansion rather than left for a result screen, for the reason
 * `PRESET_REGISTRY.limitations` is authored at all: *a limitation that is
 * authored at the point of display is one that can be forgotten at the point of
 * display*. These four are consequences of what an administrator chose in the
 * form, and none of them is knowable from the preset ID alone.
 */
function preconBenchmarkLimitations(
  choice: Extract<PresetChoice, { presetId: 'precon_smoke' | 'precon_standard' | 'precon_deep' }>,
): string[] {
  const settings = choice.settings;
  const notes: string[] = [];

  if (settings.workload.mode === 'custom') {
    notes.push(
      `Games per seat order was set to ${String(settings.workload.gamesPerSeatOrder)} rather ` +
        `than this preset's own depth of ${String(PRECON_DEPTHS[choice.presetId])}. The result ` +
        'carries the preset name and not the support that name implies.',
    );
  }
  if (!settings.mirrorSeats) {
    notes.push(
      'Seat orders are not mirrored, so each pairing is played one way round only. A win rate ' +
        'from this run cannot separate deck strength from seat advantage, and comparing it ' +
        'against a mirrored run compares two different measurements.',
    );
  }
  if (settings.replicates > 1) {
    notes.push(
      `${String(settings.replicates)} independent replicates are scheduled as ` +
        `${String(settings.replicates)} separate runs, each with its own seed family and its ` +
        'own experiment directory. This build does not pool them: read them as repeated ' +
        'measurements that agree or disagree, never as one run with more support.',
    );
  }
  if (settings.retention.replaySampleRate === 0) {
    notes.push(
      'No replays are kept for normal matches, so a surprising result in this run cannot be ' +
        'replayed afterwards. Abnormal matches are retained regardless.',
    );
  }
  return notes;
}

function openMeta(
  choice: Extract<PresetChoice, { presetId: 'open_meta' }>,
  environment: EnvironmentConfig,
): ExpandedStage[] {
  const base = common(choice, choice.pilotIds);
  // Scoping `commanderIds` (M08.14) narrows *which* legal Commanders the
  // search may choose; leaving it empty is still "open" — every legal one.
  const commanderIds = [...choice.commanderIds];
  return [
    {
      stageId: 'search',
      label: `Open search, ${String(choice.replicates)} replicate(s) of ${String(choice.generations)} generations`,
      purpose: 'exploration',
      config: validated(
        {
          ...base.fields,
          kind: 'search',
          label: PRESET_REGISTRY.open_meta.label,
          environment,
          generator: {
            commanderIds,
            ...(choice.planId === undefined ? {} : { planId: choice.planId }),
          },
          populationSize: choice.populationSize,
          generations: choice.generations,
          eliteCount: choice.eliteCount,
          mutationStrength: choice.mutationStrength,
          crossoverShare: choice.crossoverShare,
          opponentsPerEvaluation: choice.opponentsPerEvaluation,
          gamesPerOpponent: choice.gamesPerOpponent,
          archiveSize: choice.archiveSize,
          replicates: choice.replicates,
          retention: { replaySampleRate: choice.retention.replaySampleRate },
        },
        'search',
      ),
      decisions: [
        ...base.decisions,
        decision(
          'generator.commanderIds',
          commanderIds,
          commanderIds.length > 0 ? 'chosen' : 'preset',
        ),
        ...(choice.planId === undefined
          ? []
          : [decision('generator.planId', choice.planId, 'chosen' as const)]),
        decision('populationSize', choice.populationSize, 'chosen'),
        decision('generations', choice.generations, 'chosen'),
        decision('eliteCount', choice.eliteCount, 'chosen'),
        decision('mutationStrength', choice.mutationStrength, 'chosen'),
        decision('crossoverShare', choice.crossoverShare, 'chosen'),
        decision('opponentsPerEvaluation', choice.opponentsPerEvaluation, 'chosen'),
        decision('gamesPerOpponent', choice.gamesPerOpponent, 'chosen'),
        decision('archiveSize', choice.archiveSize, 'chosen'),
        decision('replicates', choice.replicates, 'chosen'),
        decision('retention.replaySampleRate', choice.retention.replaySampleRate, 'chosen'),
      ],
    },
  ];
}

function commanderSearch(
  choice: Extract<PresetChoice, { presetId: 'commander_search' }>,
  environment: EnvironmentConfig,
): ExpandedStage[] {
  const base = common(choice, choice.pilotIds);
  // Equal budget: the same population, generations and replicates for each
  // Commander, so a difference between them is not a difference of how long each
  // was left running.
  return choice.commanderIds.map((commanderId) => {
    const stageId = `search-${commanderId.replace(/_/g, '-')}`;
    const experimentId = `${choice.experimentId}-${commanderId.replace(/_/g, '-')}`.slice(0, 40);
    return {
      stageId,
      label: `Equal-budget search for ${commanderId}`,
      purpose: 'exploration' as const,
      config: validated(
        {
          ...base.fields,
          id: experimentId,
          seed: `${choice.seed}|${commanderId}`,
          kind: 'search',
          label: `${PRESET_REGISTRY.commander_search.label}: ${commanderId}`,
          environment,
          generator: { commanderIds: [commanderId] },
          populationSize: choice.populationSize,
          generations: choice.generations,
          replicates: choice.replicates,
        },
        stageId,
      ),
      decisions: [
        ...base.decisions.filter((entry) => entry.path !== 'id' && entry.path !== 'seed'),
        decision('id', experimentId, 'preset'),
        decision('seed', `${choice.seed}|${commanderId}`, 'preset'),
        decision('generator.commanderIds', [commanderId], 'chosen'),
        decision('populationSize', choice.populationSize, 'chosen'),
        decision('generations', choice.generations, 'chosen'),
        decision('replicates', choice.replicates, 'chosen'),
      ],
    };
  });
}

function candidateComparison(
  choice: Extract<PresetChoice, { presetId: 'candidate_comparison' }>,
  environment: EnvironmentConfig,
): ExpandedStage[] {
  const base = common(choice, choice.pilotIds);
  const cardPatches: CardPatch[] = choice.cardPatches.map((patch) => ({
    cardId: patch.cardId,
    note: '',
    patch: {
      ...(patch.cost !== undefined ? { cost: patch.cost } : {}),
      ...(patch.attack !== undefined ? { attack: patch.attack } : {}),
      ...(patch.health !== undefined ? { health: patch.health } : {}),
    },
  }));
  const declaredCardsChanged = choice.cardPatches.map((patch) => ({
    cardId: patch.cardId,
    fields: candidatePatchFields(patch),
  }));
  const candidate = baseEnvironment({
    id: 'precon_wave_1_candidate',
    label: 'Precon Wave 1 with the candidate changes applied',
    banCardIds: [...choice.removeCardIds],
    cardPatches,
  });
  return [
    {
      stageId: 'comparison',
      label:
        `Baseline against a candidate that removes ${String(choice.removeCardIds.length)} ` +
        `card(s) and patches ${String(choice.cardPatches.length)} card(s)`,
      purpose: 'exploration',
      config: validated(
        {
          ...base.fields,
          kind: 'comparison',
          label: PRESET_REGISTRY.candidate_comparison.label,
          baseline: environment,
          candidate,
          // The claim is checked against the two resolved pools before a match
          // runs, and an undeclared difference stops the run rather than being
          // measured — which is why `onUndeclared` is left at `reject`.
          declaredChanges: {
            cardsRemoved: [...choice.removeCardIds],
            cardsChanged: declaredCardsChanged,
          },
          referenceDecks: { kind: 'precon', preconIds: [...choice.referencePreconIds] },
          gamesPerPairing: choice.gamesPerSeatOrder,
          mirrorSeats: true,
          searchBothEnvironments: choice.searchBothEnvironments,
        },
        'comparison',
      ),
      decisions: [
        ...base.decisions,
        // Defaults are left unrecorded (§ presetDecisionSchema doc comment):
        // a run using only one of the two candidate-change kinds does not
        // record a "chosen" decision for the one it left empty.
        ...(choice.removeCardIds.length > 0
          ? [
              decision('candidate.banCardIds', [...choice.removeCardIds], 'chosen'),
              decision('declaredChanges.cardsRemoved', [...choice.removeCardIds], 'preset'),
            ]
          : []),
        ...(choice.cardPatches.length > 0
          ? [
              decision(
                'candidate.cardPatches',
                choice.cardPatches.map(
                  (patch) => `${patch.cardId}(${candidatePatchFields(patch).join('+')})`,
                ),
                'chosen',
              ),
              decision(
                'declaredChanges.cardsChanged',
                declaredCardsChanged.map((entry) => `${entry.cardId}:${entry.fields.join('+')}`),
                'preset',
              ),
            ]
          : []),
        decision('declaredChanges.onUndeclared', 'reject', 'preset'),
        decision('referenceDecks.preconIds', [...choice.referencePreconIds], 'chosen'),
        decision('gamesPerPairing', choice.gamesPerSeatOrder, 'chosen'),
        decision('mirrorSeats', true, 'preset'),
        decision('searchBothEnvironments', choice.searchBothEnvironments, 'chosen'),
      ],
    },
  ];
}

function pilotRobustness(
  choice: Extract<PresetChoice, { presetId: 'pilot_robustness' }>,
  environment: EnvironmentConfig,
): ExpandedStage[] {
  const base = common(choice, choice.pilotIds);
  // `published` is always the reference arm. Listing it here rather than relying
  // on the runner to add it keeps the recorded decision and the run identical.
  const profiles = [...new Set(['published', ...choice.profileIds])];
  return [
    {
      stageId: 'robustness',
      label: `${String(profiles.length)} perturbation profiles on identical seeds`,
      purpose: 'exploration',
      config: validated(
        {
          ...base.fields,
          kind: 'robustness',
          label: PRESET_REGISTRY.pilot_robustness.label,
          environment,
          decks: { kind: 'precon', preconIds: [...choice.preconIds] },
          profiles,
          gamesPerPairing: choice.gamesPerSeatOrder,
          mirrorSeats: true,
          schedule: 'round_robin',
        },
        'robustness',
      ),
      decisions: [
        ...base.decisions,
        decision('decks.preconIds', [...choice.preconIds], 'chosen'),
        decision('profiles', profiles, 'chosen'),
        decision('gamesPerPairing', choice.gamesPerSeatOrder, 'chosen'),
        decision('mirrorSeats', true, 'preset'),
        decision('schedule', 'round_robin', 'preset'),
      ],
    },
  ];
}

function engineSoak(
  choice: Extract<PresetChoice, { presetId: 'engine_soak' }>,
  environment: EnvironmentConfig,
): ExpandedStage[] {
  const base = common(choice, [SOAK_PILOT_ID]);
  return [
    {
      stageId: 'soak',
      label: `${String(choice.gamesPerSeatOrder)} random-legal games per seat order`,
      purpose: 'exploration',
      config: validated(
        {
          ...base.fields,
          kind: 'batch',
          label: PRESET_REGISTRY.engine_soak.label,
          environment,
          decks: { kind: 'precon', preconIds: [...choice.preconIds] },
          schedule: 'round_robin',
          gamesPerPairing: choice.gamesPerSeatOrder,
          mirrorSeats: true,
          limits: { maxTurns: SOAK_TURN_LIMIT },
          // A soak is looking for abnormal matches, so it must not stop at the
          // first one; stopping would throw away every later finding.
          failFast: false,
        },
        'soak',
      ),
      decisions: [
        ...base.decisions,
        decision('decks.preconIds', [...choice.preconIds], 'chosen'),
        decision('gamesPerPairing', choice.gamesPerSeatOrder, 'chosen'),
        decision('limits.maxTurns', SOAK_TURN_LIMIT, 'preset'),
        decision('failFast', false, 'preset'),
      ],
    },
  ];
}

/**
 * Card Replacement (CLAUDE.md §13.10): the subject swapped for one or more
 * candidates across the base decks, and — unless turned off — inserted into
 * base decks that do not run it, against a fixed opponent field.
 *
 * One stage, not two: `runReplacementExperiment` already builds a removal
 * variant per candidate per base deck and an insertion variant per base deck
 * that lacks the subject, all inside one `kind: 'replacement'` configuration,
 * the same way `runExperiment`'s dispatcher already confirmed (M08.20C). A
 * second stage here would just be the same configuration run twice.
 */
function cardReplacement(
  choice: Extract<PresetChoice, { presetId: 'card_replacement' }>,
  environment: EnvironmentConfig,
): ExpandedStage[] {
  const base = common(choice, choice.pilotIds);
  return [
    {
      stageId: 'replacement',
      label:
        `${String(choice.baseDeckPreconIds.length)} base deck(s), subject "${choice.subjectCardId}" ` +
        (choice.candidateCardIds.length > 0
          ? `against ${String(choice.candidateCardIds.length)} named candidate(s)`
          : 'against automatically comparable candidates'),
      purpose: 'exploration',
      config: validated(
        {
          ...base.fields,
          kind: 'replacement',
          label: PRESET_REGISTRY.card_replacement.label,
          environment,
          baseDecks: { kind: 'precon', preconIds: [...choice.baseDeckPreconIds] },
          opponentDecks: { kind: 'precon', preconIds: [...choice.opponentPreconIds] },
          subjectCardId: choice.subjectCardId,
          candidateCardIds: [...choice.candidateCardIds],
          copies: choice.copies,
          gamesPerPairing: choice.gamesPerSeatOrder,
          mirrorSeats: true,
          includeInsertion: choice.includeInsertion,
          insertionCopies: choice.insertionCopies,
          insertionRemoveCardIds: [...choice.insertionRemoveCardIds],
        },
        'replacement',
      ),
      decisions: [
        ...base.decisions,
        decision('baseDecks.preconIds', [...choice.baseDeckPreconIds], 'chosen'),
        decision('opponentDecks.preconIds', [...choice.opponentPreconIds], 'chosen'),
        decision('subjectCardId', choice.subjectCardId, 'chosen'),
        decision(
          'candidateCardIds',
          [...choice.candidateCardIds],
          choice.candidateCardIds.length > 0 ? 'chosen' : 'preset',
        ),
        decision('copies', choice.copies, 'chosen'),
        decision('gamesPerPairing', choice.gamesPerSeatOrder, 'chosen'),
        decision('mirrorSeats', true, 'preset'),
        decision('includeInsertion', choice.includeInsertion, 'chosen'),
        decision('insertionCopies', choice.insertionCopies, 'chosen'),
        decision(
          'insertionRemoveCardIds',
          [...choice.insertionRemoveCardIds],
          choice.insertionRemoveCardIds.length > 0 ? 'chosen' : 'preset',
        ),
      ],
    },
  ];
}

/** Limitations a *choice* creates, on top of the ones its preset publishes. */
function choiceLimitations(choice: PresetChoice): string[] {
  switch (choice.presetId) {
    case 'precon_smoke':
    case 'precon_standard':
    case 'precon_deep':
      return preconBenchmarkLimitations(choice);
    default:
      return [];
  }
}

/* ---------------------------------------------------------------- the door */

/**
 * Expands one preset choice into a validated plan.
 *
 * Throws `PresetRefused` rather than returning a result, because every caller of
 * this — the estimator, and the builder screens after it — has to stop when a
 * choice cannot be honoured, and a returned failure that a caller can forget to
 * read is exactly the shape that produces an estimate of a run that could never
 * start.
 */
export function expandPreset(input: PresetChoiceInput | unknown): ExpandedPreset {
  const parsed = presetChoiceSchema.safeParse(input);
  if (!parsed.success) throw new PresetRefused(adminSchemaErrors(parsed.error));
  const choice = parsed.data;

  const definition = PRESET_REGISTRY[choice.presetId];
  const environmentConfig = baseEnvironment();
  const environment = resolveEnvironment(environmentConfig);

  const stages = ((): ExpandedStage[] => {
    switch (choice.presetId) {
      case 'precon_smoke':
      case 'precon_standard':
      case 'precon_deep':
        requireDistinct('preconIds', choice.preconIds, 'Precon');
        return preconBenchmark(choice, environmentConfig);
      case 'open_meta':
        requireDistinct('commanderIds', choice.commanderIds, 'Commander');
        requireCommanders(environment, choice.commanderIds);
        requirePlan(environment, choice.planId, choice.commanderIds);
        return openMeta(choice, environmentConfig);
      case 'commander_search':
        requireDistinct('commanderIds', choice.commanderIds, 'Commander');
        requireCommanders(environment, choice.commanderIds);
        return commanderSearch(choice, environmentConfig);
      case 'candidate_comparison':
        requireDistinct('referencePreconIds', choice.referencePreconIds, 'Precon');
        requireDistinct('removeCardIds', choice.removeCardIds, 'Card');
        requirePoolCards(environment, choice.removeCardIds, 'removeCardIds', 'removing');
        requireCandidatePatches(environment, choice.removeCardIds, choice.cardPatches);
        if (choice.removeCardIds.length === 0 && choice.cardPatches.length === 0) {
          refuse(
            'removeCardIds',
            'A candidate comparison must declare at least one change: remove a card or patch one.',
          );
        }
        return candidateComparison(choice, environmentConfig);
      case 'pilot_robustness':
        requireDistinct('preconIds', choice.preconIds, 'Precon');
        return pilotRobustness(choice, environmentConfig);
      case 'engine_soak':
        requireDistinct('preconIds', choice.preconIds, 'Precon');
        return engineSoak(choice, environmentConfig);
      case 'card_replacement':
        requireDistinct('baseDeckPreconIds', choice.baseDeckPreconIds, 'Precon');
        requireDistinct('opponentPreconIds', choice.opponentPreconIds, 'Precon');
        requireDistinct('candidateCardIds', choice.candidateCardIds, 'Card');
        requireDistinct('insertionRemoveCardIds', choice.insertionRemoveCardIds, 'Card');
        requirePoolCard(environment, choice.subjectCardId, 'subjectCardId', 'replacing');
        requirePoolCards(environment, choice.candidateCardIds, 'candidateCardIds', 'naming');
        requirePoolCards(
          environment,
          choice.insertionRemoveCardIds,
          'insertionRemoveCardIds',
          'naming',
        );
        if (choice.candidateCardIds.includes(choice.subjectCardId)) {
          refuse(
            'candidateCardIds',
            `"${choice.subjectCardId}" is both the subject and a candidate. A card cannot be ` +
              'compared against itself.',
          );
        }
        return cardReplacement(choice, environmentConfig);
      case 'adaptive_counter':
        // Reserved (M08.19A): `adaptive_choice.ts` validates and estimates
        // this preset on its own, separate path — see its own header for
        // why. This function stays the single door onto
        // `experimentConfigSchema`, so it refuses here exactly as
        // `PRESET_REGISTRY.adaptive_counter.limitations` already promises,
        // rather than growing a stage kind nothing downstream can run.
        return refuse(
          'presetId',
          definition.limitations[0] ??
            'adaptive_counter is reserved and cannot be expanded into stages.',
        );
      default: {
        const never: never = choice;
        throw new PresetRefused([
          adminError('admin/schema', `Unknown preset: ${JSON.stringify(never)}`, {
            path: 'presetId',
          }),
        ]);
      }
    }
  })();

  const expansion = presetExpansionSchema.parse({
    presetId: choice.presetId,
    testStyle: definition.testStyle,
    sourceClasses: [...definition.sourceClasses],
    stages: stages.map((stage) => ({
      stageId: stage.stageId,
      label: stage.label,
      kind: stage.config.kind,
      purpose: stage.purpose,
      experimentId: stage.config.id,
      decisions: stage.decisions,
    })),
    deferredStages:
      choice.presetId === 'commander_search'
        ? [
            {
              stageId: 'championship',
              label: 'Frozen finalist championship on fresh seeds',
              reason:
                'The finalist field does not exist until every search named here has finished, ' +
                'so this choice can only schedule the searches. Once they complete, the ' +
                '`schedule-championship` request selects and freezes finalists per Commander ' +
                'from this batch and schedules the round this stage names.',
            },
          ]
        : [],
    limitations: [...definition.limitations, ...choiceLimitations(choice)],
  });

  return { expansion, stages, environment };
}
