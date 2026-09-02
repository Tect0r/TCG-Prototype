import { describe, expect, it } from 'vitest';

import { SOURCE_CLASSES, canonicalSourceClasses } from './identity.js';
import {
  AVAILABLE_PRESET_IDS,
  EXPERIMENT_PRESET_IDS,
  PRESET_REGISTRY,
  PRESET_STATUSES,
  PRESET_TEST_STYLES,
  experimentPresetDefinitionSchema,
  experimentPresetIdSchema,
  presetChoiceSchema,
  presetDecisionSchema,
  presetExpansionSchema,
  presetStageSchema,
  type ExperimentPresetId,
  type PresetChoiceInput,
} from './presets.js';

/**
 * The preset vocabulary, checked against itself.
 *
 * Everything here is total over `EXPERIMENT_PRESET_IDS` on purpose: a preset
 * added without a definition, without a limitation or without a choice shape is
 * the failure this file exists to make loud, and a test that listed the eight by
 * hand would keep passing the day a ninth arrived.
 */

const CHOICES: Readonly<
  Record<Exclude<ExperimentPresetId, 'adaptive_counter'>, PresetChoiceInput>
> = {
  precon_smoke: {
    presetId: 'precon_smoke',
    experimentId: 'precon-smoke',
    seed: 'smoke-2026-08',
    preconIds: ['precon_goblin_swarm', 'precon_grave_sacrifice'],
    pilotIds: ['value'],
  },
  precon_standard: {
    presetId: 'precon_standard',
    experimentId: 'precon-standard',
    seed: 'standard-2026-08',
    preconIds: ['precon_goblin_swarm', 'precon_grave_sacrifice'],
    pilotIds: ['value'],
  },
  precon_deep: {
    presetId: 'precon_deep',
    experimentId: 'precon-deep',
    seed: 'deep-2026-08',
    preconIds: ['precon_goblin_swarm', 'precon_grave_sacrifice'],
    pilotIds: ['value', 'aggressive'],
  },
  open_meta: {
    presetId: 'open_meta',
    experimentId: 'open-meta',
    seed: 'meta-2026-08',
    pilotIds: ['value'],
  },
  commander_search: {
    presetId: 'commander_search',
    experimentId: 'commander-search',
    seed: 'commander-2026-08',
    commanderIds: ['goblin_warboss'],
    pilotIds: ['value'],
  },
  candidate_comparison: {
    presetId: 'candidate_comparison',
    experimentId: 'candidate',
    seed: 'candidate-2026-08',
    referencePreconIds: ['precon_goblin_swarm', 'precon_grave_sacrifice'],
    pilotIds: ['value'],
    removeCardIds: ['some_card'],
  },
  pilot_robustness: {
    presetId: 'pilot_robustness',
    experimentId: 'robustness',
    seed: 'robust-2026-08',
    preconIds: ['precon_goblin_swarm', 'precon_grave_sacrifice'],
    pilotIds: ['value'],
    profileIds: ['all_up_10'],
  },
  engine_soak: {
    presetId: 'engine_soak',
    experimentId: 'soak',
    seed: 'soak-2026-08',
    preconIds: ['precon_goblin_swarm', 'precon_grave_sacrifice'],
  },
  card_replacement: {
    presetId: 'card_replacement',
    experimentId: 'card-replacement',
    seed: 'replacement-2026-08',
    baseDeckPreconIds: ['precon_goblin_swarm'],
    opponentPreconIds: ['precon_goblin_swarm', 'precon_grave_sacrifice'],
    pilotIds: ['value'],
    subjectCardId: 'some_card',
  },
};

describe('the registry', () => {
  it('defines every declared preset, and nothing it did not declare', () => {
    expect(Object.keys(PRESET_REGISTRY).sort()).toEqual([...EXPERIMENT_PRESET_IDS].sort());
    for (const id of EXPERIMENT_PRESET_IDS) {
      expect(PRESET_REGISTRY[id].id).toBe(id);
    }
  });

  it('names nine available presets and one reserved type', () => {
    // The milestone's prose enumerates eight original expansions and its
    // checklist line says seven; the enumeration is the authority, because each
    // one names a distinct expansion and the count named none of them. M08.20C
    // added the ninth, Card Replacement.
    expect(AVAILABLE_PRESET_IDS).toHaveLength(9);
    const reserved = EXPERIMENT_PRESET_IDS.filter(
      (id) => PRESET_REGISTRY[id].status === 'reserved',
    );
    expect(reserved).toEqual(['adaptive_counter']);
  });

  it('keeps Adaptive Counter Search a reserved type with no experiment kind behind it', () => {
    // M08.3's exclusion, structurally: a reserved preset that named a kind would
    // be one an expansion could quietly approximate with a search.
    expect(PRESET_REGISTRY.adaptive_counter.kinds).toEqual([]);
    expect(PRESET_REGISTRY.adaptive_counter.limitations.join(' ')).toContain('Reserved type');
  });

  it('gives every available preset at least one kind and one limitation', () => {
    for (const id of AVAILABLE_PRESET_IDS) {
      const definition = PRESET_REGISTRY[id];
      expect(definition.kinds.length).toBeGreaterThan(0);
      expect(definition.limitations.length).toBeGreaterThan(0);
      for (const limitation of definition.limitations) expect(limitation).toMatch(/\S/);
    }
  });

  it('classifies every preset with a legal, canonically ordered source class set', () => {
    for (const id of EXPERIMENT_PRESET_IDS) {
      const classes = PRESET_REGISTRY[id].sourceClasses;
      expect(classes.length).toBeGreaterThan(0);
      expect([...classes]).toEqual(canonicalSourceClasses([...classes]));
      for (const value of classes) expect(SOURCE_CLASSES).toContain(value);
    }
  });

  it('never classifies a simulator preset as human or mixed evidence', () => {
    // AI results stay calibration evidence. Human telemetry is a separate source
    // and arrives in M08.21; nothing a preset schedules can produce it.
    for (const id of EXPERIMENT_PRESET_IDS) {
      expect(PRESET_REGISTRY[id].sourceClasses).not.toContain('human');
      expect(PRESET_REGISTRY[id].sourceClasses).not.toContain('mixed');
    }
  });

  it('marks every search-derived preset as search evidence and says discovery is not validation', () => {
    for (const id of ['open_meta', 'commander_search'] as const) {
      expect(PRESET_REGISTRY[id].sourceClasses).toContain('search');
      expect(PRESET_REGISTRY[id].limitations.join(' ')).toMatch(/[Dd]iscovery, not validation/);
    }
  });

  it('says a soak measures engine health rather than balance', () => {
    expect(PRESET_REGISTRY.engine_soak.limitations.join(' ')).toMatch(/never balance/);
  });

  it('uses only declared statuses and declared test styles', () => {
    for (const id of EXPERIMENT_PRESET_IDS) {
      expect(PRESET_STATUSES).toContain(PRESET_REGISTRY[id].status);
      expect(PRESET_TEST_STYLES).toContain(PRESET_REGISTRY[id].testStyle);
    }
  });

  it('covers every declared test style with at least one preset', () => {
    const covered = new Set(EXPERIMENT_PRESET_IDS.map((id) => PRESET_REGISTRY[id].testStyle));
    for (const style of PRESET_TEST_STYLES) expect([...covered]).toContain(style);
  });

  it('is frozen, so a caller cannot edit the vocabulary at runtime', () => {
    expect(Object.isFrozen(PRESET_REGISTRY)).toBe(true);
  });
});

describe('a choice', () => {
  it('parses one for every available preset', () => {
    for (const id of AVAILABLE_PRESET_IDS) {
      const choice = CHOICES[id as keyof typeof CHOICES];
      expect(presetChoiceSchema.parse(choice).presetId).toBe(id);
    }
  });

  it('has no member for the reserved preset, so one cannot be requested', () => {
    expect(() =>
      presetChoiceSchema.parse({
        presetId: 'adaptive_counter',
        experimentId: 'adaptive',
        seed: 'seed',
      }),
    ).toThrow();
    expect(experimentPresetIdSchema.parse('adaptive_counter')).toBe('adaptive_counter');
  });

  it('refuses an unknown field rather than ignoring it', () => {
    expect(() =>
      presetChoiceSchema.parse({ ...CHOICES.precon_smoke, outputRoot: 'C:/results' }),
    ).toThrow();
  });

  it('has nowhere to put a filesystem path in any member', () => {
    // ADR 0023 §5 as a property of the input types: a request names identifiers.
    // Whole words rather than substrings, because `profileIds` contains `file`
    // and refusing it would be the check being wrong rather than the schema.
    const FORBIDDEN = new Set([
      'path',
      'paths',
      'dir',
      'directory',
      'root',
      'roots',
      'file',
      'files',
      'output',
      'outputs',
      'location',
    ]);
    for (const option of presetChoiceSchema.options) {
      for (const field of Object.keys(option.shape)) {
        for (const word of field.split(/(?=[A-Z])/)) {
          expect(`${field}: ${word.toLowerCase()}`).toBe(
            `${field}: ${FORBIDDEN.has(word.toLowerCase()) ? 'REFUSED' : word.toLowerCase()}`,
          );
        }
      }
    }
  });

  it('names every knob it has, so a later tranche cannot widen one quietly', () => {
    const fields = new Set(
      presetChoiceSchema.options.flatMap((option) => Object.keys(option.shape)),
    );
    expect([...fields].sort()).toEqual(
      [
        'archiveSize',
        'baseDeckPreconIds',
        'blockSize',
        'candidateCardIds',
        'candidateCount',
        'cardPatches',
        'commanderIds',
        'commanderPolicy',
        'copies',
        'crossoverShare',
        'eliteCount',
        'experimentId',
        'finalValidationGames',
        'gamesPerOpponent',
        'gamesPerSeatOrder',
        'generations',
        'includeInsertion',
        'informationPolicy',
        'insertionCopies',
        'insertionRemoveCardIds',
        'mirrorSeats',
        'mutationStrength',
        'opponentPreconIds',
        'opponentsPerEvaluation',
        'pilotIds',
        'planId',
        'populationSize',
        'preconIds',
        'presetId',
        'rebuildTrigger',
        'referenceFieldShare',
        'referencePreconIds',
        'removeCardIds',
        'replicates',
        'retention',
        'selectedCommanderIds',
        'settings',
        'searchBothEnvironments',
        'seed',
        'startingPreconIds',
        'subjectCardId',
        'swapBound',
        'totalLearningBudget',
        'profileIds',
      ].sort(),
    );
  });

  it('fills the budget knobs from documented defaults', () => {
    const open = presetChoiceSchema.parse(CHOICES.open_meta);
    expect(open).toMatchObject({ populationSize: 16, generations: 5, replicates: 2 });
    const comparison = presetChoiceSchema.parse(CHOICES.candidate_comparison);
    expect(comparison).toMatchObject({ gamesPerSeatOrder: 4, searchBothEnvironments: true });
    const soak = presetChoiceSchema.parse(CHOICES.engine_soak);
    expect(soak).toMatchObject({ gamesPerSeatOrder: 25 });
    const replacement = presetChoiceSchema.parse(CHOICES.card_replacement);
    expect(replacement).toMatchObject({
      candidateCardIds: [],
      copies: 'all',
      gamesPerSeatOrder: 4,
      includeInsertion: true,
      insertionCopies: 1,
      insertionRemoveCardIds: [],
    });
  });

  it('refuses a one-deck benchmark, because a two-seat table needs two decks', () => {
    expect(() =>
      presetChoiceSchema.parse({ ...CHOICES.precon_smoke, preconIds: ['precon_goblin_swarm'] }),
    ).toThrow();
  });

  it('refuses an empty pilot selection', () => {
    expect(() => presetChoiceSchema.parse({ ...CHOICES.precon_smoke, pilotIds: [] })).toThrow();
  });

  it('accepts an empty removal list and an empty patch list at the schema level', () => {
    // "A comparison must declare *some* change" is a business rule about the two
    // fields together, not a bound on either one — `expand.ts`'s
    // `requireCandidatePatches`/empty-declared-change refusal enforces it
    // (`expand.test.ts`), the same split as `adaptiveSwapBoundSchema`'s min/max
    // check elsewhere in this file.
    expect(() =>
      presetChoiceSchema.parse({
        ...CHOICES.candidate_comparison,
        removeCardIds: [],
        cardPatches: [],
      }),
    ).not.toThrow();
  });

  it('refuses an experiment ID that is not the simulator’s authored slug', () => {
    for (const bad of ['Precon Smoke', '9-lives', 'precon/smoke', '../escape', '']) {
      expect(() =>
        presetChoiceSchema.parse({ ...CHOICES.precon_smoke, experimentId: bad }),
      ).toThrow();
    }
  });

  it('offers no games-per-seat-order knob on the three precon depths', () => {
    // The depth *is* the preset. M08.8 owns the custom-workload control and will
    // widen this shape visibly rather than by an optional field appearing.
    for (const id of ['precon_smoke', 'precon_standard', 'precon_deep'] as const) {
      expect(() => presetChoiceSchema.parse({ ...CHOICES[id], gamesPerSeatOrder: 9 })).toThrow();
    }
  });
});

describe('an expansion', () => {
  const stage = {
    stageId: 'matches',
    label: 'The four precons, four games per seat order',
    kind: 'batch',
    purpose: 'exploration',
    experimentId: 'precon-standard',
    decisions: [
      { path: 'gamesPerPairing', value: 4, source: 'preset' },
      { path: 'pilots', value: ['value'], source: 'chosen' },
    ],
  };

  it('round-trips a single-stage plan', () => {
    const parsed = presetExpansionSchema.parse({
      presetId: 'precon_standard',
      testStyle: 'precon_benchmark',
      sourceClasses: ['ai', 'precon'],
      stages: [stage],
    });
    expect(parsed.stages[0]?.decisions).toHaveLength(2);
    expect(parsed.deferredStages).toEqual([]);
  });

  it('names a deferred stage rather than omitting it', () => {
    const parsed = presetExpansionSchema.parse({
      presetId: 'commander_search',
      testStyle: 'commander_search',
      sourceClasses: ['ai', 'search'],
      stages: [{ ...stage, kind: 'search', stageId: 'search-goblin-warboss' }],
      deferredStages: [
        {
          stageId: 'championship',
          label: 'Frozen finalist championship',
          reason: 'The finalist field does not exist until the searches finish.',
        },
      ],
    });
    expect(parsed.deferredStages[0]?.stageId).toBe('championship');
  });

  it('refuses two stages with the same ID', () => {
    expect(() =>
      presetExpansionSchema.parse({
        presetId: 'commander_search',
        testStyle: 'commander_search',
        sourceClasses: ['ai', 'search'],
        stages: [stage, stage],
      }),
    ).toThrow(/unique/);
  });

  it('refuses a source classification the identity contract would refuse', () => {
    expect(() =>
      presetExpansionSchema.parse({
        presetId: 'precon_standard',
        testStyle: 'precon_benchmark',
        sourceClasses: ['precon', 'ai'],
        stages: [stage],
      }),
    ).toThrow();
  });

  it('records who settled each value, from a closed set', () => {
    expect(() =>
      presetDecisionSchema.parse({ path: 'workers', value: 4, source: 'inferred' }),
    ).toThrow();
    for (const source of ['chosen', 'preset'] as const) {
      expect(presetDecisionSchema.parse({ path: 'workers', value: 4, source }).source).toBe(source);
    }
  });

  it('refuses a decision path that is not a dotted field name', () => {
    for (const bad of ['../workers', 'C:/results', 'workers/', '.workers', 'work ers']) {
      expect(() => presetDecisionSchema.parse({ path: bad, value: 4, source: 'preset' })).toThrow();
    }
    expect(() =>
      presetDecisionSchema.parse({
        path: 'environment.banCardIds',
        value: ['x'],
        source: 'chosen',
      }),
    ).not.toThrow();
  });

  it('refuses a stage whose experiment ID is not an authored slug', () => {
    expect(() => presetStageSchema.parse({ ...stage, experimentId: 'Precon Standard' })).toThrow();
  });

  it('has no member that can hold a configuration, so nothing here copies the simulator’s', () => {
    expect(() =>
      presetStageSchema.parse({ ...stage, config: { schemaVersion: 1, kind: 'batch' } }),
    ).toThrow();
  });
});

describe('the definition schema M08.6 added', () => {
  it('parses every entry in the registry, so the interface and the schema agree', () => {
    // The registry is a constant and needed no parser while it stayed inside the
    // process. M08.6 sends it to a client, and a response nothing validates on
    // the way out has whatever shape the handler happened to build.
    for (const id of EXPERIMENT_PRESET_IDS) {
      const parsed = experimentPresetDefinitionSchema.safeParse(PRESET_REGISTRY[id]);
      expect(`${id}: ${String(parsed.success)}`).toBe(`${id}: true`);
    }
  });

  it('requires an available preset to carry its limitations and its kinds', () => {
    expect(
      experimentPresetDefinitionSchema.safeParse({
        ...PRESET_REGISTRY.precon_smoke,
        limitations: [],
      }).success,
    ).toBe(false);
    expect(
      experimentPresetDefinitionSchema.safeParse({ ...PRESET_REGISTRY.precon_smoke, kinds: [] })
        .success,
    ).toBe(false);
  });

  it('lets a reserved preset carry neither, because it has no results to caveat', () => {
    const reserved = EXPERIMENT_PRESET_IDS.filter(
      (id) => PRESET_REGISTRY[id].status === 'reserved',
    );
    expect(reserved.length).toBeGreaterThan(0);
    for (const id of reserved) {
      expect(`${id}: ${String(PRESET_REGISTRY[id].kinds.length)}`).toBe(`${id}: 0`);
      expect(
        `${id}: ${String(experimentPresetDefinitionSchema.safeParse(PRESET_REGISTRY[id]).success)}`,
      ).toBe(`${id}: true`);
    }
  });

  it('refuses a field nobody declared', () => {
    expect(
      experimentPresetDefinitionSchema.safeParse({
        ...PRESET_REGISTRY.precon_smoke,
        gamesPerPairing: 4,
      }).success,
    ).toBe(false);
  });
});
