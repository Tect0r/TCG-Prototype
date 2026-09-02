import { describe, expect, it } from 'vitest';

import {
  AVAILABLE_PRESET_IDS,
  EXPERIMENT_KINDS,
  PRESET_REGISTRY,
  presetExpansionSchema,
  type PresetChoiceInput,
} from '@tcg/admin-contracts';
import {
  experimentConfigSchema,
  resolveEnvironment,
  environmentConfigForFormat,
  type ExperimentConfig,
} from '@tcg/simulator';

import { PRESET_FORMAT_ID, PresetRefused, expandPreset, scrubRefusal } from './expand.js';
import { estimatePreset } from './estimate.js';

/**
 * The presets, expanded — and the exact table of what each one schedules.
 *
 * The snapshot below is written out in full rather than recorded automatically,
 * because it is the thing an administrator reads before spending an evening of
 * CPU and the thing a later tranche will change by accident. A number moving here
 * is a real change to what a named test costs, and it should have to be typed.
 */

const PRECONS = [
  'precon_bastion_guardians',
  'precon_containment_control',
  'precon_goblin_swarm',
  'precon_grave_sacrifice',
];

const ENVIRONMENT = resolveEnvironment(environmentConfigForFormat(PRESET_FORMAT_ID, {}));
/** A card that really is in the pool, so a candidate change is a change. */
const A_POOL_CARD = ENVIRONMENT.pool[0]?.id ?? '';
/** A unit in the pool, distinct from `A_POOL_CARD`, whose attack/health a patch can edit. */
const ANOTHER_POOL_CARD =
  ENVIRONMENT.pool.find((card) => card.attack !== undefined && card.id !== A_POOL_CARD)?.id ?? '';
/** A pool card with no combat stats, for the patch-target-type refusal. */
const A_NON_UNIT_POOL_CARD = ENVIRONMENT.pool.find((card) => card.attack === undefined)?.id ?? '';

const CHOICES: Readonly<Record<string, PresetChoiceInput>> = {
  precon_smoke: {
    presetId: 'precon_smoke',
    experimentId: 'precon-smoke',
    seed: 'preset-2026-08',
    preconIds: PRECONS,
    pilotIds: ['value'],
  },
  precon_standard: {
    presetId: 'precon_standard',
    experimentId: 'precon-standard',
    seed: 'preset-2026-08',
    preconIds: PRECONS,
    pilotIds: ['value'],
  },
  precon_deep: {
    presetId: 'precon_deep',
    experimentId: 'precon-deep',
    seed: 'preset-2026-08',
    preconIds: PRECONS,
    pilotIds: ['value', 'aggressive'],
  },
  open_meta: {
    presetId: 'open_meta',
    experimentId: 'open-meta',
    seed: 'preset-2026-08',
    pilotIds: ['value'],
  },
  commander_search: {
    presetId: 'commander_search',
    experimentId: 'commander-search',
    seed: 'preset-2026-08',
    commanderIds: ['goblin_warboss', 'grave_matriarch'],
    pilotIds: ['value'],
  },
  candidate_comparison: {
    presetId: 'candidate_comparison',
    experimentId: 'candidate',
    seed: 'preset-2026-08',
    referencePreconIds: PRECONS,
    pilotIds: ['value'],
    removeCardIds: [A_POOL_CARD],
  },
  pilot_robustness: {
    presetId: 'pilot_robustness',
    experimentId: 'robustness',
    seed: 'preset-2026-08',
    preconIds: PRECONS,
    pilotIds: ['value'],
    profileIds: ['combat_forward', 'card_advantage'],
  },
  engine_soak: {
    presetId: 'engine_soak',
    experimentId: 'soak',
    seed: 'preset-2026-08',
    preconIds: PRECONS,
  },
};

/**
 * What each preset schedules on the selections above, exactly.
 *
 * `stages` is `stageId=matches(basis)`, in plan order.
 */
const SNAPSHOT: readonly {
  readonly presetId: string;
  readonly total: number;
  readonly basis: string;
  readonly stages: readonly string[];
  readonly floors: number;
  readonly deferred: readonly string[];
}[] = [
  {
    presetId: 'precon_smoke',
    total: 12,
    basis: 'exact',
    stages: ['matches=12(exact)'],
    floors: 4,
    deferred: [],
  },
  {
    presetId: 'precon_standard',
    total: 48,
    basis: 'exact',
    stages: ['matches=48(exact)'],
    floors: 4,
    deferred: [],
  },
  {
    presetId: 'precon_deep',
    total: 288,
    basis: 'exact',
    stages: ['matches=288(exact)'],
    floors: 4,
    deferred: [],
  },
  {
    presetId: 'open_meta',
    total: 2560,
    basis: 'upper_bound',
    stages: ['search=2560(upper_bound)'],
    floors: 4,
    deferred: [],
  },
  {
    presetId: 'commander_search',
    total: 2560,
    basis: 'upper_bound',
    stages: ['search-goblin-warboss=1280(upper_bound)', 'search-grave-matriarch=1280(upper_bound)'],
    floors: 2,
    deferred: ['championship'],
  },
  {
    presetId: 'candidate_comparison',
    total: 1536,
    basis: 'upper_bound',
    stages: ['comparison-reference=96(upper_bound)', 'comparison-search=1440(upper_bound)'],
    floors: 4,
    deferred: [],
  },
  {
    presetId: 'pilot_robustness',
    total: 144,
    basis: 'exact',
    stages: ['robustness=144(exact)'],
    floors: 4,
    deferred: [],
  },
  {
    presetId: 'engine_soak',
    total: 300,
    basis: 'exact',
    stages: ['soak=300(exact)'],
    floors: 4,
    deferred: [],
  },
];

describe('every available preset expands', () => {
  it('covers all eight, so the snapshot below cannot silently miss one', () => {
    expect(SNAPSHOT.map((row) => row.presetId).sort()).toEqual([...AVAILABLE_PRESET_IDS].sort());
    expect(Object.keys(CHOICES).sort()).toEqual([...AVAILABLE_PRESET_IDS].sort());
  });

  for (const row of SNAPSHOT) {
    it(`schedules exactly what ${row.presetId} says it does`, () => {
      const result = estimatePreset(CHOICES[row.presetId]);
      expect({
        presetId: result.expansion.presetId,
        total: result.estimate.totalMatches,
        basis: result.estimate.basis,
        stages: result.estimate.stages.map(
          (stage) => `${stage.stageId}=${String(stage.matches)}(${stage.basis})`,
        ),
        floors: result.estimate.forcedInclusion.length,
        deferred: result.expansion.deferredStages.map((stage) => stage.stageId),
      }).toEqual(row);
    });
  }

  it('produces a configuration the simulator itself accepts, for every preset', () => {
    // "Expands into an *ordinary validated* config" is the claim; re-parsing each
    // one through the simulator's own schema is what settles it.
    for (const id of AVAILABLE_PRESET_IDS) {
      for (const stage of expandPreset(CHOICES[id]).stages) {
        expect(experimentConfigSchema.safeParse(stage.config).success).toBe(true);
      }
    }
  });

  it('produces only kinds the admin contract names, which is the seam M08.1 deferred', () => {
    // `EXPERIMENT_KINDS` is restated in `@tcg/admin-contracts` because a
    // schema-only package cannot import the simulator. M08.1 said the check that
    // needs both sides belongs to the first layer able to import both; M08.3 is
    // that layer, so the check lands here rather than staying a comment.
    const simulatorKinds = experimentConfigSchema.options.map(
      (option) => option.shape.kind.value as ExperimentConfig['kind'],
    );
    expect([...EXPERIMENT_KINDS].sort()).toEqual([...simulatorKinds].sort());
    for (const id of AVAILABLE_PRESET_IDS) {
      for (const stage of expandPreset(CHOICES[id]).stages) {
        expect(EXPERIMENT_KINDS).toContain(stage.config.kind);
        expect(PRESET_REGISTRY[id].kinds).toContain(stage.config.kind);
      }
    }
  });

  it('travels as a contract-shaped expansion with no configuration inside it', () => {
    for (const id of AVAILABLE_PRESET_IDS) {
      const expansion = expandPreset(CHOICES[id]).expansion;
      expect(presetExpansionSchema.parse(expansion)).toEqual(expansion);
      expect(JSON.stringify(expansion)).not.toContain('schemaVersion');
    }
  });

  it('states every value it chose, and who chose it', () => {
    const { expansion } = expandPreset(CHOICES.precon_standard as PresetChoiceInput);
    const decisions = new Map(
      expansion.stages[0]?.decisions.map((entry) => [entry.path, entry] as const),
    );
    expect(decisions.get('gamesPerPairing')).toEqual({
      path: 'gamesPerPairing',
      value: 4,
      source: 'preset',
    });
    expect(decisions.get('decks.preconIds')?.source).toBe('chosen');
    expect(decisions.get('seed')).toEqual({
      path: 'seed',
      value: 'preset-2026-08',
      source: 'chosen',
    });
    // Every recorded value has to be the value the configuration actually holds.
    const config = expandPreset(CHOICES.precon_standard as PresetChoiceInput).stages[0]?.config;
    expect(config?.kind === 'batch' ? config.gamesPerPairing : null).toBe(4);
  });
});

describe('what the presets decide for themselves', () => {
  it('separates smoke, standard and deep by games per seat order alone', () => {
    const games = (id: string): number => {
      const config = expandPreset(CHOICES[id]).stages[0]?.config;
      return config?.kind === 'batch' ? config.gamesPerPairing : -1;
    };
    expect([games('precon_smoke'), games('precon_standard'), games('precon_deep')]).toEqual([
      1, 4, 12,
    ]);
  });

  it('flies the soak with the random-legal pilot, whatever the administrator prefers', () => {
    // A soak driven by a heuristic pilot would look like a benchmark and not be
    // one, so the pilot is the preset's decision and there is no knob for it.
    const config = expandPreset(CHOICES.engine_soak).stages[0]?.config;
    expect(config?.pilots.map((pilot) => pilot.id)).toEqual(['random_legal']);
    expect(config?.kind === 'batch' ? config.failFast : null).toBe(false);
  });

  it('gives every Commander search the same budget', () => {
    const stages = expandPreset(CHOICES.commander_search).stages;
    const budgets = stages.map((stage) =>
      stage.config.kind === 'search'
        ? [stage.config.populationSize, stage.config.generations, stage.config.replicates]
        : null,
    );
    expect(budgets[0]).toEqual(budgets[1]);
    // A different seed family per Commander, so the two are independent samples.
    expect(new Set(stages.map((stage) => stage.config.seed)).size).toBe(stages.length);
  });

  it('locks each Commander search to its own Commander', () => {
    for (const stage of expandPreset(CHOICES.commander_search).stages) {
      expect(
        stage.config.kind === 'search' ? stage.config.generator.commanderIds : [],
      ).toHaveLength(1);
    }
  });

  it('leaves an open search unconstrained, because choosing is what open means', () => {
    const config = expandPreset(CHOICES.open_meta).stages[0]?.config;
    expect(config?.kind === 'search' ? config.generator.commanderIds : ['x']).toEqual([]);
  });

  it('narrows an open search to the Commanders named, and no others (M08.14)', () => {
    const config = expandPreset({
      ...CHOICES.open_meta,
      commanderIds: ['goblin_warboss', 'grave_matriarch'],
    }).stages[0]?.config;
    expect(config?.kind === 'search' ? config.generator.commanderIds : ['x']).toEqual([
      'goblin_warboss',
      'grave_matriarch',
    ]);
  });

  it('refuses an open search scoped to a Commander this format does not publish', () => {
    expect(() =>
      expandPreset({ ...CHOICES.open_meta, commanderIds: ['not_a_real_commander'] }),
    ).toThrow(PresetRefused);
  });

  it('accepts a plan seed policy naming a plan this format actually publishes (M08.14)', () => {
    const config = expandPreset({
      ...CHOICES.open_meta,
      planId: 'plan_goblin_swarm',
    }).stages[0]?.config;
    expect(config?.kind === 'search' ? config.generator.planId : undefined).toBe(
      'plan_goblin_swarm',
    );
  });

  it('refuses a plan seed policy naming a plan this build does not publish, before pricing (M08.14)', () => {
    expect(() => expandPreset({ ...CHOICES.open_meta, planId: 'plan_does_not_exist' })).toThrow(
      PresetRefused,
    );
  });

  it('refuses a plan whose Commander sits outside a non-empty Commander scope (M08.14)', () => {
    expect(() =>
      expandPreset({
        ...CHOICES.open_meta,
        planId: 'plan_goblin_swarm',
        commanderIds: ['grave_matriarch'],
      }),
    ).toThrow(PresetRefused);
  });

  it('accepts a plan whose Commander is inside the Commander scope named (M08.14)', () => {
    const config = expandPreset({
      ...CHOICES.open_meta,
      planId: 'plan_goblin_swarm',
      commanderIds: ['goblin_warboss', 'grave_matriarch'],
    }).stages[0]?.config;
    expect(config?.kind === 'search' ? config.generator.planId : undefined).toBe(
      'plan_goblin_swarm',
    );
  });

  it('declares the candidate change and refuses an undeclared difference', () => {
    const config = expandPreset(CHOICES.candidate_comparison).stages[0]?.config;
    if (config?.kind !== 'comparison') throw new Error('expected a comparison');
    expect(config.candidate.banCardIds).toEqual([A_POOL_CARD]);
    expect(config.declaredChanges.cardsRemoved).toEqual([A_POOL_CARD]);
    expect(config.declaredChanges.onUndeclared).toBe('reject');
    // The reference decks are the same in both arms, by construction.
    expect(config.baseline.banCardIds).toEqual([]);
  });

  it('declares a card patch alongside, or instead of, a removal (M08.20A)', () => {
    const patchOnlyCard = ANOTHER_POOL_CARD;
    const config = expandPreset({
      ...(CHOICES.candidate_comparison as object),
      removeCardIds: [],
      cardPatches: [{ cardId: patchOnlyCard, cost: 1 }],
    }).stages[0]?.config;
    if (config?.kind !== 'comparison') throw new Error('expected a comparison');
    expect(config.candidate.banCardIds).toEqual([]);
    expect(config.candidate.cardPatches).toEqual([
      { cardId: patchOnlyCard, note: '', patch: { cost: 1 } },
    ]);
    expect(config.declaredChanges.cardsRemoved).toEqual([]);
    expect(config.declaredChanges.cardsChanged).toEqual([
      { cardId: patchOnlyCard, fields: ['cost'], note: '' },
    ]);
  });

  it('declares a removal and a patch together, on different cards', () => {
    const config = expandPreset({
      ...(CHOICES.candidate_comparison as object),
      removeCardIds: [A_POOL_CARD],
      cardPatches: [{ cardId: ANOTHER_POOL_CARD, attack: 3, health: 4 }],
    }).stages[0]?.config;
    if (config?.kind !== 'comparison') throw new Error('expected a comparison');
    expect(config.declaredChanges.cardsRemoved).toEqual([A_POOL_CARD]);
    expect(config.declaredChanges.cardsChanged).toEqual([
      { cardId: ANOTHER_POOL_CARD, fields: ['attack', 'health'], note: '' },
    ]);
  });

  it('always includes `published` as the robustness reference arm', () => {
    const config = expandPreset(CHOICES.pilot_robustness).stages[0]?.config;
    expect(config?.kind === 'robustness' ? config.profiles : []).toEqual([
      'published',
      'combat_forward',
      'card_advantage',
    ]);
  });

  it('does not add `published` twice when it was already chosen', () => {
    const config = expandPreset({
      ...(CHOICES.pilot_robustness as object),
      profileIds: ['published', 'combat_forward'],
    }).stages[0]?.config;
    expect(config?.kind === 'robustness' ? config.profiles : []).toEqual([
      'published',
      'combat_forward',
    ]);
  });

  it('reads the format’s construction rules rather than transcribing them', () => {
    for (const id of AVAILABLE_PRESET_IDS) {
      for (const stage of expandPreset(CHOICES[id]).stages) {
        const environment =
          stage.config.kind === 'comparison' ? stage.config.baseline : stage.config.environment;
        expect(environment.deckFormat).toEqual({
          formatId: 'precon_wave_1',
          deckSize: 40,
          singleton: true,
          copyLimit: 1,
          uniqueCopyLimit: 1,
          maxCommanderColors: 2,
        });
        expect(environment.format).toBe('precon_wave_1');
      }
    }
  });
});

describe('what a preset refuses', () => {
  function refusal(choice: unknown): { code: string; path?: string; message: string } {
    try {
      expandPreset(choice);
    } catch (cause) {
      if (cause instanceof PresetRefused) {
        const first = cause.errors[0];
        if (first === undefined) throw new Error('a refusal with no errors');
        return {
          code: first.code,
          ...(first.path === undefined ? {} : { path: first.path }),
          message: first.message,
        };
      }
      throw cause;
    }
    throw new Error('expected a refusal');
  }

  it('refuses the reserved Adaptive Counter type rather than approximating it', () => {
    // M08.3's exclusion. The choice union has no member for it at all, so the
    // refusal happens at the schema rather than in a branch somebody could add to.
    const refused = refusal({
      presetId: 'adaptive_counter',
      experimentId: 'adaptive',
      seed: 'seed',
    });
    expect(refused.code).toBe('admin/schema');
  });

  it('refuses a Commander this format does not publish, and says which it has', () => {
    const refused = refusal({ ...(CHOICES.commander_search as object), commanderIds: ['nobody'] });
    expect(refused.path).toBe('commanderIds.0');
    expect(refused.message).toContain('goblin_warboss');
  });

  it('refuses a candidate change that removes a card the pool does not contain', () => {
    const refused = refusal({
      ...(CHOICES.candidate_comparison as object),
      removeCardIds: ['not_a_card'],
    });
    expect(refused.path).toBe('removeCardIds.0');
    expect(refused.message).toMatch(/declare a change that does not happen/);
  });

  it('refuses a candidate comparison that declares no change at all (M08.20A)', () => {
    const refused = refusal({
      ...(CHOICES.candidate_comparison as object),
      removeCardIds: [],
    });
    expect(refused.message).toMatch(/at least one change/);
  });

  it('refuses a card patch that targets a card the pool does not contain', () => {
    const refused = refusal({
      ...(CHOICES.candidate_comparison as object),
      removeCardIds: [],
      cardPatches: [{ cardId: 'not_a_card', cost: 1 }],
    });
    expect(refused.path).toBe('cardPatches.0.cardId');
    expect(refused.message).toMatch(/declare a change that does not happen/);
  });

  it('refuses a patch that edits combat stats on a card with none', () => {
    const refused = refusal({
      ...(CHOICES.candidate_comparison as object),
      removeCardIds: [],
      cardPatches: [{ cardId: A_NON_UNIT_POOL_CARD, attack: 1 }],
    });
    expect(refused.path).toBe('cardPatches.0');
    expect(refused.message).toMatch(/only a unit's combat stats/);
  });

  it('refuses the same card named by both a removal and a patch', () => {
    const refused = refusal({
      ...(CHOICES.candidate_comparison as object),
      removeCardIds: [A_POOL_CARD],
      cardPatches: [{ cardId: A_POOL_CARD, cost: 1 }],
    });
    expect(refused.path).toBe('cardPatches.0.cardId');
    expect(refused.message).toMatch(/both removed and patched/);
  });

  it('refuses two patches naming the same card', () => {
    const refused = refusal({
      ...(CHOICES.candidate_comparison as object),
      removeCardIds: [],
      cardPatches: [
        { cardId: ANOTHER_POOL_CARD, cost: 1 },
        { cardId: ANOTHER_POOL_CARD, cost: 2 },
      ],
    });
    expect(refused.path).toBe('cardPatches');
    expect(refused.message).toMatch(/listed twice/);
  });

  it('refuses a card patch that changes nothing', () => {
    const refused = refusal({
      ...(CHOICES.candidate_comparison as object),
      removeCardIds: [],
      cardPatches: [{ cardId: ANOTHER_POOL_CARD }],
    });
    expect(refused.code).toBe('admin/schema');
  });

  it('refuses a selection that lists the same thing twice', () => {
    const refused = refusal({
      ...(CHOICES.precon_smoke as object),
      preconIds: ['precon_goblin_swarm', 'precon_goblin_swarm'],
    });
    expect(refused.path).toBe('preconIds');
    expect(refused.message).toMatch(/listed twice/);
  });

  it('refuses an unknown pilot in the simulator’s own words', () => {
    const refused = refusal({ ...(CHOICES.precon_smoke as object), pilotIds: ['grandmaster'] });
    expect(refused.code).toBe('admin/schema');
    expect(refused.message).toContain('Stage "matches"');
  });

  it('refuses an unknown field rather than ignoring it', () => {
    expect(refusal({ ...(CHOICES.precon_smoke as object), outputRoot: 'C:/results' }).code).toBe(
      'admin/schema',
    );
  });

  it('carries the field path on every refusal it can, so a form can place it', () => {
    const refused = refusal({ ...(CHOICES.precon_smoke as object), experimentId: 'Not A Slug' });
    expect(refused.path).toBe('experimentId');
  });

  it('never lets a filesystem location into a refusal', () => {
    // ADR 0023 §5. The simulator's messages are reused because they are the
    // authoritative ones, and it has no idea it is about to cross an admin
    // boundary — so the scrub is the boundary rather than a hope.
    expect(scrubRefusal('Could not read "D:\\results\\decks.json": missing')).not.toContain(
      'results',
    );
    expect(scrubRefusal('Could not read /var/lib/x: missing')).toContain('<path>');
    expect(scrubRefusal('Precon "precon_goblin_swarm" is unknown.')).toBe(
      'Precon "precon_goblin_swarm" is unknown.',
    );
  });

  it('refuses a precon this build does not publish', () => {
    expect(() =>
      estimatePreset({ ...(CHOICES.precon_smoke as object), preconIds: ['a_precon', 'b_precon'] }),
    ).toThrow(/No built-in precon has ID/);
  });
});

describe('the limitations travel with the estimate', () => {
  it('carries every limitation its preset declares', () => {
    for (const id of AVAILABLE_PRESET_IDS) {
      const { estimate } = estimatePreset(CHOICES[id]);
      for (const limitation of PRESET_REGISTRY[id].limitations) {
        expect(estimate.limitations).toContain(limitation);
      }
    }
  });

  it('names the stage this choice cannot itself schedule, and how to schedule it', () => {
    const { estimate } = estimatePreset(CHOICES.commander_search);
    expect(estimate.limitations.join(' ')).toMatch(/Frozen finalist championship/);
    expect(estimate.limitations.join(' ')).toContain('schedule-championship');
  });

  it('says a soak is engine health rather than balance', () => {
    const { estimate } = estimatePreset(CHOICES.engine_soak);
    expect(estimate.limitations.join(' ')).toMatch(/never balance/);
  });

  it('says a search is discovery rather than validation', () => {
    for (const id of ['open_meta', 'commander_search'] as const) {
      const { estimate } = estimatePreset(CHOICES[id]);
      expect(estimate.limitations.join(' ')).toMatch(/[Dd]iscovery, not validation/);
    }
  });

  it('puts the forced-inclusion caveat beside every preset that fixes a Commander', () => {
    for (const id of AVAILABLE_PRESET_IDS) {
      const { estimate } = estimatePreset(CHOICES[id]);
      expect(estimate.forcedInclusion.length).toBeGreaterThan(0);
      expect(estimate.limitations.join(' ')).toMatch(/forced-inclusion floor/);
    }
  });

  it('repeats no limitation, however many stages declared it', () => {
    const { estimate } = estimatePreset(CHOICES.commander_search);
    expect(new Set(estimate.limitations).size).toBe(estimate.limitations.length);
  });
});

describe('expansion is deterministic', () => {
  it('produces byte-identical plans for the same choice', () => {
    for (const id of AVAILABLE_PRESET_IDS) {
      const first = estimatePreset(CHOICES[id]);
      const second = estimatePreset(CHOICES[id]);
      expect(JSON.stringify(second.expansion)).toBe(JSON.stringify(first.expansion));
      expect(JSON.stringify(second.estimate)).toBe(JSON.stringify(first.estimate));
    }
  });

  it('does not depend on the order a selection was typed in', () => {
    const forward = estimatePreset(CHOICES.precon_standard);
    const reversed = estimatePreset({
      ...(CHOICES.precon_standard as object),
      preconIds: [...PRECONS].reverse(),
    });
    // The schedule is over deck *count*; which order the four were named in is
    // not a difference in how much work it is.
    expect(reversed.estimate.totalMatches).toBe(forward.estimate.totalMatches);
  });
});
