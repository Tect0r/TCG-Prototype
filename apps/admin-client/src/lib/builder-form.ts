import {
  PRESET_REGISTRY,
  presetChoiceSchema,
  type CandidateCardPatch,
  type ContentCatalog,
  type ExperimentPresetDefinitionValue,
  type ExperimentPresetId,
  type PresetChoice,
} from '@tcg/admin-contracts';

/**
 * The builder's form, and the one function that turns it into a request.
 *
 * React-free and on its own, for the reason `transport.ts` and `session.ts` are:
 * the rules this screen has to get right — *what does this form mean*, *is it
 * complete*, *has the thing on screen changed since the number was obtained* —
 * are decidable without a DOM, and a component test that had to click through
 * eleven controls to check one of them would be testing the clicking.
 *
 * ## The screen validates nothing the service validates
 *
 * `presetChoiceSchema` is the contract's, and it is the only shape check here:
 * `choiceOf` parses and hands back either a choice or the schema's own field
 * errors. Whether a precon exists, whether the format publishes it and whether
 * the environment can play it are all the **server's** answers, arriving as a
 * refusal naming the field — so this module has no precon list, no pilot list
 * and no idea what a legal deck is. What it does have is the two rules that are
 * properties of the *form* rather than of the content: a benchmark needs at
 * least two decks and at least one pilot, which is what the schema's own bounds
 * say, restated as a message beside the control instead of as a parse error.
 */

/** The three depths of the one test style this builder configures. */
export const BUILDER_PRESET_IDS = [
  'precon_smoke',
  'precon_standard',
  'precon_deep',
] as const satisfies readonly ExperimentPresetId[];

export type BuilderPresetId = (typeof BUILDER_PRESET_IDS)[number];

/** A choice this builder can put back into its form. */
export type BenchmarkChoice = Extract<PresetChoice, { presetId: BuilderPresetId }>;

/**
 * The same choice, narrowed — or `null` for one this screen does not configure.
 *
 * A switch rather than an `includes` test, because only the switch narrows the
 * discriminated union: a saved configuration for a preset this builder does not
 * own is a real possibility once a second builder exists, and the honest answer
 * is to leave it in the list and decline to open it here.
 */
export function asBenchmarkChoice(choice: PresetChoice): BenchmarkChoice | null {
  switch (choice.presetId) {
    case 'precon_smoke':
    case 'precon_standard':
    case 'precon_deep':
      return choice;
    default:
      return null;
  }
}

/**
 * The precon-benchmark presets this build publishes, taken from the catalog the
 * service sent.
 *
 * Derived from `testStyle` rather than from `BUILDER_PRESET_IDS` alone, so a
 * build whose service published a fourth depth would offer it — and a build
 * whose service withdrew one would stop offering it — without this screen being
 * edited. The ID list above is the type-level half of the same statement, and
 * `PRESET_REGISTRY` is what keeps the two honest.
 */
export function benchmarkPresets(
  presets: readonly ExperimentPresetDefinitionValue[],
): readonly ExperimentPresetDefinitionValue[] {
  return presets.filter(
    (preset) => preset.testStyle === 'precon_benchmark' && preset.status === 'available',
  );
}

export interface BuilderForm {
  readonly presetId: BuilderPresetId;
  /** What the batch is called in the catalog. */
  readonly batchLabel: string;
  /** The experiment ID each stage's configuration carries. */
  readonly experimentId: string;
  /** The root seed everything else is derived from. */
  readonly seed: string;
  readonly preconIds: readonly string[];
  readonly pilotIds: readonly string[];
  readonly workloadMode: 'preset' | 'custom';
  readonly gamesPerSeatOrder: number;
  readonly replicates: number;
  readonly mirrorSeats: boolean;
  readonly replaySampleRate: number;
  readonly workers: number;
}

/**
 * The form a person meets when the screen opens.
 *
 * Every precon the environment can play, one pilot that can carry a balance
 * claim, and the preset's own depth — which is the run M08.6 already produced,
 * so the default form is the default test rather than an empty one somebody has
 * to assemble before they can see a number.
 *
 * The seed is a fixed string rather than a random one. A generated seed would
 * mean two runs of "the same" configuration are different experiments and
 * nobody was told; a stated one is reproducible, and changing it is what an
 * administrator does when they want a fresh seed family.
 */
export function initialForm(content: ContentCatalog | null): BuilderForm {
  const playable = (content?.precons ?? []).filter((precon) => precon.refusals.length === 0);
  const pilot =
    content?.pilots.find((entry) => entry.playQualityEvidence)?.pilotId ??
    content?.pilots[0]?.pilotId;
  return {
    presetId: 'precon_standard',
    batchLabel: 'Precon benchmark',
    experimentId: 'precon-standard',
    seed: 'precon-benchmark-1',
    preconIds: playable.map((precon) => precon.preconId),
    pilotIds: pilot === undefined ? [] : [pilot],
    workloadMode: 'preset',
    gamesPerSeatOrder: 4,
    replicates: 1,
    mirrorSeats: true,
    replaySampleRate: 50,
    workers: 1,
  };
}

/** The depth a preset chooses for itself, for the screen to print beside it. */
export const PRESET_DEPTHS: Readonly<Record<BuilderPresetId, number>> = Object.freeze({
  precon_smoke: 1,
  precon_standard: 4,
  precon_deep: 12,
});

export interface FormProblem {
  /** The control this is about, so a screen can put it beside one. */
  readonly field: keyof BuilderForm;
  readonly message: string;
}

export type ChoiceResult =
  | { readonly ok: true; readonly choice: PresetChoice }
  | { readonly ok: false; readonly problems: readonly FormProblem[] };

/**
 * The request this form means, or the fields that are not ready.
 *
 * Parsed by `presetChoiceSchema` rather than assembled and hoped for: the
 * schema is the contract, and a client that built a payload it had not checked
 * would discover the mistake as a refusal from a service that had already been
 * asked.
 */
export function choiceOf(form: BuilderForm): ChoiceResult {
  const problems: FormProblem[] = [];
  if (form.preconIds.length < 2) {
    problems.push({
      field: 'preconIds',
      message: 'Choose at least two precons — a benchmark needs an opponent.',
    });
  }
  if (form.pilotIds.length < 1) {
    problems.push({ field: 'pilotIds', message: 'Choose at least one pilot to fly the decks.' });
  }
  if (form.experimentId.trim() === '') {
    problems.push({ field: 'experimentId', message: 'Give the run a name.' });
  }
  if (form.seed.trim() === '') {
    problems.push({
      field: 'seed',
      message: 'Give the run a seed; it is what makes it repeatable.',
    });
  }
  if (form.batchLabel.trim() === '') {
    problems.push({ field: 'batchLabel', message: 'Give the batch a label.' });
  }
  if (problems.length > 0) return { ok: false, problems };

  const parsed = presetChoiceSchema.safeParse({
    presetId: form.presetId,
    experimentId: form.experimentId.trim(),
    seed: form.seed.trim(),
    preconIds: [...form.preconIds],
    pilotIds: [...form.pilotIds],
    settings: {
      workload:
        form.workloadMode === 'custom'
          ? { mode: 'custom', gamesPerSeatOrder: form.gamesPerSeatOrder }
          : { mode: 'preset' },
      replicates: form.replicates,
      mirrorSeats: form.mirrorSeats,
      retention: { replaySampleRate: form.replaySampleRate },
      workers: form.workers,
    },
  });

  if (parsed.success) return { ok: true, choice: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => ({
      field: fieldOf(issue.path),
      message: issue.message,
    })),
  };
}

/** Which control a schema issue belongs beside. Unrecognised paths land on the name. */
function fieldOf(path: readonly PropertyKey[]): keyof BuilderForm {
  const head = String(path[0] ?? '');
  if (head === 'preconIds') return 'preconIds';
  if (head === 'pilotIds') return 'pilotIds';
  if (head === 'seed') return 'seed';
  if (head === 'settings') {
    const member = String(path[1] ?? '');
    if (member === 'replicates') return 'replicates';
    if (member === 'workload') return 'gamesPerSeatOrder';
    if (member === 'retention') return 'replaySampleRate';
    if (member === 'workers') return 'workers';
  }
  return 'experimentId';
}

/**
 * The form, as a value that changes whenever anything a run depends on changes.
 *
 * This is what makes *the exact total is shown before anything is enqueued* a
 * property rather than a habit: the screen keeps the fingerprint the estimate
 * was obtained for, and offers to enqueue only while it still matches. Edit one
 * control and the enqueue is withdrawn until the number is asked for again.
 *
 * The **batch label is deliberately excluded**. It names the batch in the
 * catalog and changes nothing about the schedule, so renaming it before
 * enqueueing should not throw away a number that is still correct.
 */
export function formFingerprint(form: BuilderForm): string {
  const result = choiceOf(form);
  return result.ok ? JSON.stringify(result.choice) : '';
}

/**
 * The form that reproduces a saved choice.
 *
 * Total over the choice's own shape rather than a spread, because a saved
 * configuration is a document that may have been written by a build with fewer
 * settings than this one — `settings` prefaults, so an older document parses —
 * and a spread would leave whichever fields it lacked `undefined` in a control.
 */
export function formOf(input: PresetChoice, batchLabel: string): BuilderForm | null {
  const choice = asBenchmarkChoice(input);
  if (choice === null) return null;
  const settings = choice.settings;
  return {
    presetId: choice.presetId,
    batchLabel,
    experimentId: choice.experimentId,
    seed: choice.seed,
    preconIds: [...choice.preconIds],
    pilotIds: [...choice.pilotIds],
    workloadMode: settings.workload.mode,
    gamesPerSeatOrder:
      settings.workload.mode === 'custom'
        ? settings.workload.gamesPerSeatOrder
        : PRESET_DEPTHS[choice.presetId],
    replicates: settings.replicates,
    mirrorSeats: settings.mirrorSeats,
    replaySampleRate: settings.retention.replaySampleRate,
    workers: settings.workers,
  };
}

/**
 * The depths this build's own registry states, checked against what the screen
 * prints.
 *
 * `PRESET_DEPTHS` above is a client-side restatement of a number the *server*
 * settles, and the honest way to hold a restated constant still is to fail on
 * the day it drifts. The expansion records the depth it used as a decision, so a
 * screen that printed a stale number would be contradicted by the estimate the
 * same form produced — this is the cheaper half of the same check, and
 * `builder-form.test.ts` asserts each preset's summary still names its depth.
 */
export function depthClaim(presetId: BuilderPresetId): string {
  return PRESET_REGISTRY[presetId].summary;
}

/* ------------------------------------------------------------- open meta */

/**
 * The Open Meta search form (M08.14).
 *
 * Kept apart from `BuilderForm` rather than folded into one union: the two
 * forms share nothing but identity and workload-adjacent fields, and a single
 * form type wide enough to hold a precon list *and* a mutation strength would
 * be a form every screen has to know how to leave half full. `BuilderScreen`
 * holds one of each and switches which is live, the same way it already
 * switches which section renders.
 */
export interface OpenMetaFormProblem {
  /** The control this is about, so a screen can put it beside one. */
  readonly field: keyof OpenMetaForm;
  readonly message: string;
}

export type OpenMetaChoiceResult =
  | { readonly ok: true; readonly choice: OpenMetaChoice }
  | { readonly ok: false; readonly problems: readonly OpenMetaFormProblem[] };

export interface OpenMetaForm {
  readonly batchLabel: string;
  readonly experimentId: string;
  readonly seed: string;
  readonly pilotIds: readonly string[];
  /** `'all'` is every legal Commander — still "open" — `'selected'` narrows it. */
  readonly commanderScope: 'all' | 'selected';
  readonly commanderIds: readonly string[];
  /** Unconstrained generation when empty; an authored plan ID otherwise. */
  readonly planId: string;
  readonly populationSize: number;
  readonly generations: number;
  readonly eliteCount: number;
  readonly mutationStrength: number;
  readonly crossoverShare: number;
  readonly opponentsPerEvaluation: number;
  readonly gamesPerOpponent: number;
  readonly archiveSize: number;
  readonly replicates: number;
  readonly replaySampleRate: number;
}

/** A choice this form can put back into itself — the `open_meta` member only. */
export type OpenMetaChoice = Extract<PresetChoice, { presetId: 'open_meta' }>;

export function asOpenMetaChoice(choice: PresetChoice): OpenMetaChoice | null {
  return choice.presetId === 'open_meta' ? choice : null;
}

/**
 * The Commanders this catalog's playable precons name, deduplicated.
 *
 * The content catalog has no Commander list of its own (`content.ts`'s own
 * comment: *nothing here is a card, a decklist or a pool*), so this reads the
 * one field a precon already carries. It is a convenience list for the
 * picker, not the legality check — the server is the authority on which
 * Commander a format publishes, and a misspelled or stale entry here is
 * refused there in exactly the words `requireCommanders` already gives.
 */
export function catalogCommanderIds(content: ContentCatalog | null): readonly string[] {
  if (content === null) return [];
  const seen = new Set<string>();
  for (const precon of content.precons) {
    if (precon.refusals.length === 0) seen.add(precon.commanderId);
  }
  return [...seen].sort();
}

export function initialOpenMetaForm(content: ContentCatalog | null): OpenMetaForm {
  const pilot =
    content?.pilots.find((entry) => entry.playQualityEvidence)?.pilotId ??
    content?.pilots[0]?.pilotId;
  return {
    batchLabel: 'Open meta search',
    experimentId: 'open-meta',
    seed: 'open-meta-1',
    pilotIds: pilot === undefined ? [] : [pilot],
    commanderScope: 'all',
    commanderIds: [],
    planId: '',
    populationSize: 16,
    generations: 5,
    eliteCount: 4,
    mutationStrength: 3,
    crossoverShare: 0.25,
    opponentsPerEvaluation: 4,
    gamesPerOpponent: 2,
    archiveSize: 24,
    replicates: 2,
    replaySampleRate: 50,
  };
}

/**
 * The request an Open Meta form means, or the fields that are not ready.
 *
 * Parsed by `presetChoiceSchema` for the same reason `choiceOf` is: the
 * schema is the contract, and a client-side rule this function invented could
 * accept a form the service would still refuse.
 */
export function openMetaChoiceOf(form: OpenMetaForm): OpenMetaChoiceResult {
  const problems: OpenMetaFormProblem[] = [];
  if (form.pilotIds.length < 1) {
    problems.push({ field: 'pilotIds', message: 'Choose at least one pilot to fly the decks.' });
  }
  if (form.commanderScope === 'selected' && form.commanderIds.length === 0) {
    problems.push({
      field: 'commanderIds',
      message: 'Choose at least one Commander, or switch back to "every legal Commander".',
    });
  }
  if (form.experimentId.trim() === '') {
    problems.push({ field: 'experimentId', message: 'Give the run a name.' });
  }
  if (form.seed.trim() === '') {
    problems.push({
      field: 'seed',
      message: 'Give the run a seed; it is what makes it repeatable.',
    });
  }
  if (form.batchLabel.trim() === '') {
    problems.push({ field: 'batchLabel', message: 'Give the batch a label.' });
  }
  if (problems.length > 0) return { ok: false, problems };

  const parsed = presetChoiceSchema.safeParse({
    presetId: 'open_meta',
    experimentId: form.experimentId.trim(),
    seed: form.seed.trim(),
    pilotIds: [...form.pilotIds],
    commanderIds: form.commanderScope === 'selected' ? [...form.commanderIds] : [],
    ...(form.planId.trim() === '' ? {} : { planId: form.planId.trim() }),
    populationSize: form.populationSize,
    generations: form.generations,
    eliteCount: form.eliteCount,
    mutationStrength: form.mutationStrength,
    crossoverShare: form.crossoverShare,
    opponentsPerEvaluation: form.opponentsPerEvaluation,
    gamesPerOpponent: form.gamesPerOpponent,
    archiveSize: form.archiveSize,
    replicates: form.replicates,
    retention: { replaySampleRate: form.replaySampleRate },
  });

  if (parsed.success) {
    const choice = asOpenMetaChoice(parsed.data);
    // Unreachable: `presetId: 'open_meta'` was just sent, so the discriminated
    // union can only have parsed to that member.
    if (choice === null) throw new Error('Parsed an open_meta request into another preset.');
    return { ok: true, choice };
  }
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => ({
      field: openMetaFieldOf(issue.path),
      message: issue.message,
    })),
  };
}

function openMetaFieldOf(path: readonly PropertyKey[]): keyof OpenMetaForm {
  const head = String(path[0] ?? '');
  const known = new Set<keyof OpenMetaForm>([
    'pilotIds',
    'commanderIds',
    'planId',
    'populationSize',
    'generations',
    'eliteCount',
    'mutationStrength',
    'crossoverShare',
    'opponentsPerEvaluation',
    'gamesPerOpponent',
    'archiveSize',
    'replicates',
    'seed',
  ]);
  if ((known as ReadonlySet<string>).has(head)) return head as keyof OpenMetaForm;
  if (head === 'retention') return 'replaySampleRate';
  return 'experimentId';
}

/** Changes whenever anything a run depends on changes — the same rule `formFingerprint` states. */
export function openMetaFormFingerprint(form: OpenMetaForm): string {
  const result = openMetaChoiceOf(form);
  return result.ok ? JSON.stringify(result.choice) : '';
}

/** The form that reproduces a saved Open Meta choice, or `null` for a different preset. */
export function openMetaFormOf(input: PresetChoice, batchLabel: string): OpenMetaForm | null {
  const choice = asOpenMetaChoice(input);
  if (choice === null) return null;
  return {
    batchLabel,
    experimentId: choice.experimentId,
    seed: choice.seed,
    pilotIds: [...choice.pilotIds],
    commanderScope: choice.commanderIds.length > 0 ? 'selected' : 'all',
    commanderIds: [...choice.commanderIds],
    planId: choice.planId ?? '',
    populationSize: choice.populationSize,
    generations: choice.generations,
    eliteCount: choice.eliteCount,
    mutationStrength: choice.mutationStrength,
    crossoverShare: choice.crossoverShare,
    opponentsPerEvaluation: choice.opponentsPerEvaluation,
    gamesPerOpponent: choice.gamesPerOpponent,
    archiveSize: choice.archiveSize,
    replicates: choice.replicates,
    replaySampleRate: choice.retention.replaySampleRate,
  };
}

/* -------------------------------------------------- advanced templates */

/**
 * The free-text control every card, profile and identifier field below uses.
 *
 * None of the four templates' card or perturbation-profile fields have a
 * catalog to build a checkbox list from — `content.ts`'s own answer carries
 * no card list and no profile list (`@tcg/bot-interface` owns the real
 * profile enum, and this package cannot import it; see `presets.ts`'s
 * header) — so a person types the identifiers the same way an experiment
 * name is typed, and `presetChoiceSchema` is what actually checks them.
 */
export function parseIdList(raw: string): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const piece of raw.split(/[,\n]/)) {
    const trimmed = piece.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

/** The reverse of `parseIdList`, for restoring a saved choice into the control. */
export function idListRaw(ids: readonly string[]): string {
  return ids.join(', ');
}

/* ---------------------------------------------- candidate patch comparison */

/** One row of the candidate patch editor. Blank dials are left out of the patch. */
export interface CardPatchRowForm {
  readonly cardId: string;
  readonly cost: string;
  readonly attack: string;
  readonly health: string;
}

export const EMPTY_CARD_PATCH_ROW: CardPatchRowForm = { cardId: '', cost: '', attack: '', health: '' };

function cardPatchesOf(rows: readonly CardPatchRowForm[]): readonly CandidateCardPatch[] {
  const patches: CandidateCardPatch[] = [];
  for (const row of rows) {
    const cardId = row.cardId.trim();
    if (cardId === '') continue;
    const patch: { cardId: string; cost?: number; attack?: number; health?: number } = { cardId };
    if (row.cost.trim() !== '') patch.cost = Number(row.cost);
    if (row.attack.trim() !== '') patch.attack = Number(row.attack);
    if (row.health.trim() !== '') patch.health = Number(row.health);
    patches.push(patch as CandidateCardPatch);
  }
  return patches;
}

export interface CandidateComparisonForm {
  readonly batchLabel: string;
  readonly experimentId: string;
  readonly seed: string;
  readonly referencePreconIds: readonly string[];
  readonly pilotIds: readonly string[];
  readonly removeCardIdsRaw: string;
  readonly cardPatchRows: readonly CardPatchRowForm[];
  readonly gamesPerSeatOrder: number;
  readonly searchBothEnvironments: boolean;
}

export type CandidateComparisonChoice = Extract<PresetChoice, { presetId: 'candidate_comparison' }>;

export function asCandidateComparisonChoice(
  choice: PresetChoice,
): CandidateComparisonChoice | null {
  return choice.presetId === 'candidate_comparison' ? choice : null;
}

export function initialCandidateComparisonForm(
  content: ContentCatalog | null,
): CandidateComparisonForm {
  const pilot =
    content?.pilots.find((entry) => entry.playQualityEvidence)?.pilotId ?? content?.pilots[0]?.pilotId;
  return {
    batchLabel: 'Candidate patch comparison',
    experimentId: 'candidate-comparison',
    seed: 'candidate-comparison-1',
    referencePreconIds: [],
    pilotIds: pilot === undefined ? [] : [pilot],
    removeCardIdsRaw: '',
    cardPatchRows: [],
    gamesPerSeatOrder: 4,
    searchBothEnvironments: true,
  };
}

export interface CandidateComparisonFormProblem {
  readonly field: keyof CandidateComparisonForm;
  readonly message: string;
}

export type CandidateComparisonChoiceResult =
  | { readonly ok: true; readonly choice: CandidateComparisonChoice }
  | { readonly ok: false; readonly problems: readonly CandidateComparisonFormProblem[] };

export function candidateComparisonChoiceOf(
  form: CandidateComparisonForm,
): CandidateComparisonChoiceResult {
  const problems: CandidateComparisonFormProblem[] = [];
  if (form.referencePreconIds.length < 2) {
    problems.push({
      field: 'referencePreconIds',
      message: 'Choose at least two reference decks — a comparison needs an opponent.',
    });
  }
  if (form.pilotIds.length < 1) {
    problems.push({ field: 'pilotIds', message: 'Choose at least one pilot to fly the decks.' });
  }
  if (form.experimentId.trim() === '') {
    problems.push({ field: 'experimentId', message: 'Give the run a name.' });
  }
  if (form.seed.trim() === '') {
    problems.push({
      field: 'seed',
      message: 'Give the run a seed; it is what makes it repeatable.',
    });
  }
  if (form.batchLabel.trim() === '') {
    problems.push({ field: 'batchLabel', message: 'Give the batch a label.' });
  }
  if (problems.length > 0) return { ok: false, problems };

  const parsed = presetChoiceSchema.safeParse({
    presetId: 'candidate_comparison',
    experimentId: form.experimentId.trim(),
    seed: form.seed.trim(),
    referencePreconIds: [...form.referencePreconIds],
    pilotIds: [...form.pilotIds],
    removeCardIds: parseIdList(form.removeCardIdsRaw),
    cardPatches: cardPatchesOf(form.cardPatchRows),
    gamesPerSeatOrder: form.gamesPerSeatOrder,
    searchBothEnvironments: form.searchBothEnvironments,
  });

  if (parsed.success) {
    const choice = asCandidateComparisonChoice(parsed.data);
    // Unreachable: `presetId: 'candidate_comparison'` was just sent.
    if (choice === null) throw new Error('Parsed a candidate_comparison request into another preset.');
    return { ok: true, choice };
  }
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => ({
      field: candidateComparisonFieldOf(issue.path),
      message: issue.message,
    })),
  };
}

function candidateComparisonFieldOf(
  path: readonly PropertyKey[],
): keyof CandidateComparisonForm {
  const head = String(path[0] ?? '');
  const known = new Set<keyof CandidateComparisonForm>([
    'referencePreconIds',
    'pilotIds',
    'seed',
    'gamesPerSeatOrder',
    'searchBothEnvironments',
  ]);
  if ((known as ReadonlySet<string>).has(head)) return head as keyof CandidateComparisonForm;
  if (head === 'removeCardIds') return 'removeCardIdsRaw';
  if (head === 'cardPatches') return 'cardPatchRows';
  return 'experimentId';
}

export function candidateComparisonFormFingerprint(form: CandidateComparisonForm): string {
  const result = candidateComparisonChoiceOf(form);
  return result.ok ? JSON.stringify(result.choice) : '';
}

export function candidateComparisonFormOf(
  input: PresetChoice,
  batchLabel: string,
): CandidateComparisonForm | null {
  const choice = asCandidateComparisonChoice(input);
  if (choice === null) return null;
  return {
    batchLabel,
    experimentId: choice.experimentId,
    seed: choice.seed,
    referencePreconIds: [...choice.referencePreconIds],
    pilotIds: [...choice.pilotIds],
    removeCardIdsRaw: idListRaw(choice.removeCardIds),
    cardPatchRows: choice.cardPatches.map((patch) => ({
      cardId: patch.cardId,
      cost: patch.cost === undefined || patch.cost === null ? '' : String(patch.cost),
      attack: patch.attack === undefined ? '' : String(patch.attack),
      health: patch.health === undefined ? '' : String(patch.health),
    })),
    gamesPerSeatOrder: choice.gamesPerSeatOrder,
    searchBothEnvironments: choice.searchBothEnvironments,
  };
}

/* --------------------------------------------------------- pilot robustness */

export interface PilotRobustnessForm {
  readonly batchLabel: string;
  readonly experimentId: string;
  readonly seed: string;
  readonly preconIds: readonly string[];
  readonly pilotIds: readonly string[];
  readonly profileIdsRaw: string;
  readonly gamesPerSeatOrder: number;
}

export type PilotRobustnessChoice = Extract<PresetChoice, { presetId: 'pilot_robustness' }>;

export function asPilotRobustnessChoice(choice: PresetChoice): PilotRobustnessChoice | null {
  return choice.presetId === 'pilot_robustness' ? choice : null;
}

export function initialPilotRobustnessForm(content: ContentCatalog | null): PilotRobustnessForm {
  const pilot =
    content?.pilots.find((entry) => entry.playQualityEvidence)?.pilotId ?? content?.pilots[0]?.pilotId;
  return {
    batchLabel: 'Pilot robustness',
    experimentId: 'pilot-robustness',
    seed: 'pilot-robustness-1',
    preconIds: [],
    pilotIds: pilot === undefined ? [] : [pilot],
    profileIdsRaw: '',
    gamesPerSeatOrder: 4,
  };
}

export interface PilotRobustnessFormProblem {
  readonly field: keyof PilotRobustnessForm;
  readonly message: string;
}

export type PilotRobustnessChoiceResult =
  | { readonly ok: true; readonly choice: PilotRobustnessChoice }
  | { readonly ok: false; readonly problems: readonly PilotRobustnessFormProblem[] };

export function pilotRobustnessChoiceOf(form: PilotRobustnessForm): PilotRobustnessChoiceResult {
  const problems: PilotRobustnessFormProblem[] = [];
  if (form.preconIds.length < 2) {
    problems.push({ field: 'preconIds', message: 'Choose at least two precons.' });
  }
  if (form.pilotIds.length < 1) {
    problems.push({ field: 'pilotIds', message: 'Choose at least one pilot to fly the decks.' });
  }
  const profileIds = parseIdList(form.profileIdsRaw);
  if (profileIds.length < 1) {
    problems.push({
      field: 'profileIdsRaw',
      message: 'Name at least one perturbation profile.',
    });
  }
  if (form.experimentId.trim() === '') {
    problems.push({ field: 'experimentId', message: 'Give the run a name.' });
  }
  if (form.seed.trim() === '') {
    problems.push({
      field: 'seed',
      message: 'Give the run a seed; it is what makes it repeatable.',
    });
  }
  if (form.batchLabel.trim() === '') {
    problems.push({ field: 'batchLabel', message: 'Give the batch a label.' });
  }
  if (problems.length > 0) return { ok: false, problems };

  const parsed = presetChoiceSchema.safeParse({
    presetId: 'pilot_robustness',
    experimentId: form.experimentId.trim(),
    seed: form.seed.trim(),
    preconIds: [...form.preconIds],
    pilotIds: [...form.pilotIds],
    profileIds,
    gamesPerSeatOrder: form.gamesPerSeatOrder,
  });
  if (parsed.success) {
    const choice = asPilotRobustnessChoice(parsed.data);
    // Unreachable: `presetId: 'pilot_robustness'` was just sent.
    if (choice === null) throw new Error('Parsed a pilot_robustness request into another preset.');
    return { ok: true, choice };
  }
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => ({
      field: pilotRobustnessFieldOf(issue.path),
      message: issue.message,
    })),
  };
}

function pilotRobustnessFieldOf(path: readonly PropertyKey[]): keyof PilotRobustnessForm {
  const head = String(path[0] ?? '');
  const known = new Set<keyof PilotRobustnessForm>(['preconIds', 'pilotIds', 'seed', 'gamesPerSeatOrder']);
  if ((known as ReadonlySet<string>).has(head)) return head as keyof PilotRobustnessForm;
  if (head === 'profileIds') return 'profileIdsRaw';
  return 'experimentId';
}

export function pilotRobustnessFormFingerprint(form: PilotRobustnessForm): string {
  const result = pilotRobustnessChoiceOf(form);
  return result.ok ? JSON.stringify(result.choice) : '';
}

export function pilotRobustnessFormOf(
  input: PresetChoice,
  batchLabel: string,
): PilotRobustnessForm | null {
  const choice = asPilotRobustnessChoice(input);
  if (choice === null) return null;
  return {
    batchLabel,
    experimentId: choice.experimentId,
    seed: choice.seed,
    preconIds: [...choice.preconIds],
    pilotIds: [...choice.pilotIds],
    profileIdsRaw: idListRaw(choice.profileIds),
    gamesPerSeatOrder: choice.gamesPerSeatOrder,
  };
}

/* -------------------------------------------------------------- engine soak */

export interface EngineSoakForm {
  readonly batchLabel: string;
  readonly experimentId: string;
  readonly seed: string;
  readonly preconIds: readonly string[];
  readonly gamesPerSeatOrder: number;
}

export type EngineSoakChoice = Extract<PresetChoice, { presetId: 'engine_soak' }>;

export function asEngineSoakChoice(choice: PresetChoice): EngineSoakChoice | null {
  return choice.presetId === 'engine_soak' ? choice : null;
}

export function initialEngineSoakForm(): EngineSoakForm {
  return {
    batchLabel: 'Engine soak',
    experimentId: 'engine-soak',
    seed: 'engine-soak-1',
    preconIds: [],
    gamesPerSeatOrder: 25,
  };
}

export interface EngineSoakFormProblem {
  readonly field: keyof EngineSoakForm;
  readonly message: string;
}

export type EngineSoakChoiceResult =
  | { readonly ok: true; readonly choice: EngineSoakChoice }
  | { readonly ok: false; readonly problems: readonly EngineSoakFormProblem[] };

export function engineSoakChoiceOf(form: EngineSoakForm): EngineSoakChoiceResult {
  const problems: EngineSoakFormProblem[] = [];
  if (form.preconIds.length < 2) {
    problems.push({ field: 'preconIds', message: 'Choose at least two precons.' });
  }
  if (form.experimentId.trim() === '') {
    problems.push({ field: 'experimentId', message: 'Give the run a name.' });
  }
  if (form.seed.trim() === '') {
    problems.push({
      field: 'seed',
      message: 'Give the run a seed; it is what makes it repeatable.',
    });
  }
  if (form.batchLabel.trim() === '') {
    problems.push({ field: 'batchLabel', message: 'Give the batch a label.' });
  }
  if (problems.length > 0) return { ok: false, problems };

  const parsed = presetChoiceSchema.safeParse({
    presetId: 'engine_soak',
    experimentId: form.experimentId.trim(),
    seed: form.seed.trim(),
    preconIds: [...form.preconIds],
    gamesPerSeatOrder: form.gamesPerSeatOrder,
  });
  if (parsed.success) {
    const choice = asEngineSoakChoice(parsed.data);
    // Unreachable: `presetId: 'engine_soak'` was just sent.
    if (choice === null) throw new Error('Parsed an engine_soak request into another preset.');
    return { ok: true, choice };
  }
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => ({
      field: engineSoakFieldOf(issue.path),
      message: issue.message,
    })),
  };
}

function engineSoakFieldOf(path: readonly PropertyKey[]): keyof EngineSoakForm {
  const head = String(path[0] ?? '');
  const known = new Set<keyof EngineSoakForm>(['preconIds', 'seed', 'gamesPerSeatOrder']);
  if ((known as ReadonlySet<string>).has(head)) return head as keyof EngineSoakForm;
  return 'experimentId';
}

export function engineSoakFormFingerprint(form: EngineSoakForm): string {
  const result = engineSoakChoiceOf(form);
  return result.ok ? JSON.stringify(result.choice) : '';
}

export function engineSoakFormOf(input: PresetChoice, batchLabel: string): EngineSoakForm | null {
  const choice = asEngineSoakChoice(input);
  if (choice === null) return null;
  return {
    batchLabel,
    experimentId: choice.experimentId,
    seed: choice.seed,
    preconIds: [...choice.preconIds],
    gamesPerSeatOrder: choice.gamesPerSeatOrder,
  };
}

/* ---------------------------------------------------------- card replacement */

export interface CardReplacementForm {
  readonly batchLabel: string;
  readonly experimentId: string;
  readonly seed: string;
  readonly baseDeckPreconIds: readonly string[];
  readonly opponentPreconIds: readonly string[];
  readonly pilotIds: readonly string[];
  readonly subjectCardId: string;
  readonly candidateCardIdsRaw: string;
  readonly copiesMode: 'all' | 'custom';
  readonly copiesCount: number;
  readonly gamesPerSeatOrder: number;
  readonly includeInsertion: boolean;
  readonly insertionCopiesMode: 'all' | 'custom';
  readonly insertionCopiesCount: number;
  readonly insertionRemoveCardIdsRaw: string;
}

export type CardReplacementChoice = Extract<PresetChoice, { presetId: 'card_replacement' }>;

export function asCardReplacementChoice(choice: PresetChoice): CardReplacementChoice | null {
  return choice.presetId === 'card_replacement' ? choice : null;
}

export function initialCardReplacementForm(content: ContentCatalog | null): CardReplacementForm {
  const pilot =
    content?.pilots.find((entry) => entry.playQualityEvidence)?.pilotId ?? content?.pilots[0]?.pilotId;
  return {
    batchLabel: 'Card replacement',
    experimentId: 'card-replacement',
    seed: 'card-replacement-1',
    baseDeckPreconIds: [],
    opponentPreconIds: [],
    pilotIds: pilot === undefined ? [] : [pilot],
    subjectCardId: '',
    candidateCardIdsRaw: '',
    copiesMode: 'all',
    copiesCount: 1,
    gamesPerSeatOrder: 4,
    includeInsertion: true,
    insertionCopiesMode: 'custom',
    insertionCopiesCount: 1,
    insertionRemoveCardIdsRaw: '',
  };
}

export interface CardReplacementFormProblem {
  readonly field: keyof CardReplacementForm;
  readonly message: string;
}

export type CardReplacementChoiceResult =
  | { readonly ok: true; readonly choice: CardReplacementChoice }
  | { readonly ok: false; readonly problems: readonly CardReplacementFormProblem[] };

export function cardReplacementChoiceOf(form: CardReplacementForm): CardReplacementChoiceResult {
  const problems: CardReplacementFormProblem[] = [];
  if (form.baseDeckPreconIds.length < 1) {
    problems.push({ field: 'baseDeckPreconIds', message: 'Choose at least one base deck.' });
  }
  if (form.opponentPreconIds.length < 2) {
    problems.push({
      field: 'opponentPreconIds',
      message: 'Choose at least two opponent decks for the fixed field.',
    });
  }
  if (form.pilotIds.length < 1) {
    problems.push({ field: 'pilotIds', message: 'Choose at least one pilot to fly the decks.' });
  }
  if (form.subjectCardId.trim() === '') {
    problems.push({ field: 'subjectCardId', message: 'Name the card being replaced.' });
  }
  if (form.experimentId.trim() === '') {
    problems.push({ field: 'experimentId', message: 'Give the run a name.' });
  }
  if (form.seed.trim() === '') {
    problems.push({
      field: 'seed',
      message: 'Give the run a seed; it is what makes it repeatable.',
    });
  }
  if (form.batchLabel.trim() === '') {
    problems.push({ field: 'batchLabel', message: 'Give the batch a label.' });
  }
  if (problems.length > 0) return { ok: false, problems };

  const parsed = presetChoiceSchema.safeParse({
    presetId: 'card_replacement',
    experimentId: form.experimentId.trim(),
    seed: form.seed.trim(),
    baseDeckPreconIds: [...form.baseDeckPreconIds],
    opponentPreconIds: [...form.opponentPreconIds],
    pilotIds: [...form.pilotIds],
    subjectCardId: form.subjectCardId.trim(),
    candidateCardIds: parseIdList(form.candidateCardIdsRaw),
    copies: form.copiesMode === 'all' ? 'all' : form.copiesCount,
    gamesPerSeatOrder: form.gamesPerSeatOrder,
    includeInsertion: form.includeInsertion,
    insertionCopies: form.insertionCopiesMode === 'all' ? 'all' : form.insertionCopiesCount,
    insertionRemoveCardIds: parseIdList(form.insertionRemoveCardIdsRaw),
  });
  if (parsed.success) {
    const choice = asCardReplacementChoice(parsed.data);
    // Unreachable: `presetId: 'card_replacement'` was just sent.
    if (choice === null) throw new Error('Parsed a card_replacement request into another preset.');
    return { ok: true, choice };
  }
  return {
    ok: false,
    problems: parsed.error.issues.map((issue) => ({
      field: cardReplacementFieldOf(issue.path),
      message: issue.message,
    })),
  };
}

function cardReplacementFieldOf(path: readonly PropertyKey[]): keyof CardReplacementForm {
  const head = String(path[0] ?? '');
  const known = new Set<keyof CardReplacementForm>([
    'baseDeckPreconIds',
    'opponentPreconIds',
    'pilotIds',
    'subjectCardId',
    'seed',
    'gamesPerSeatOrder',
    'includeInsertion',
  ]);
  if ((known as ReadonlySet<string>).has(head)) return head as keyof CardReplacementForm;
  if (head === 'candidateCardIds') return 'candidateCardIdsRaw';
  if (head === 'copies') return 'copiesCount';
  if (head === 'insertionCopies') return 'insertionCopiesCount';
  if (head === 'insertionRemoveCardIds') return 'insertionRemoveCardIdsRaw';
  return 'experimentId';
}

export function cardReplacementFormFingerprint(form: CardReplacementForm): string {
  const result = cardReplacementChoiceOf(form);
  return result.ok ? JSON.stringify(result.choice) : '';
}

export function cardReplacementFormOf(
  input: PresetChoice,
  batchLabel: string,
): CardReplacementForm | null {
  const choice = asCardReplacementChoice(input);
  if (choice === null) return null;
  return {
    batchLabel,
    experimentId: choice.experimentId,
    seed: choice.seed,
    baseDeckPreconIds: [...choice.baseDeckPreconIds],
    opponentPreconIds: [...choice.opponentPreconIds],
    pilotIds: [...choice.pilotIds],
    subjectCardId: choice.subjectCardId,
    candidateCardIdsRaw: idListRaw(choice.candidateCardIds),
    copiesMode: choice.copies === 'all' ? 'all' : 'custom',
    copiesCount: choice.copies === 'all' ? 1 : choice.copies,
    gamesPerSeatOrder: choice.gamesPerSeatOrder,
    includeInsertion: choice.includeInsertion,
    insertionCopiesMode: choice.insertionCopies === 'all' ? 'all' : 'custom',
    insertionCopiesCount: choice.insertionCopies === 'all' ? 1 : choice.insertionCopies,
    insertionRemoveCardIdsRaw: idListRaw(choice.insertionRemoveCardIds),
  };
}
