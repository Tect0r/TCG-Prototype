import { describe, expect, it } from 'vitest';

import { PRESET_REGISTRY, type ContentCatalog, type PresetChoice } from '@tcg/admin-contracts';

import {
  BUILDER_PRESET_IDS,
  EMPTY_CARD_PATCH_ROW,
  PRESET_DEPTHS,
  asBenchmarkChoice,
  benchmarkPresets,
  candidateComparisonChoiceOf,
  candidateComparisonFormFingerprint,
  candidateComparisonFormOf,
  cardReplacementChoiceOf,
  cardReplacementFormOf,
  catalogCommanderIds,
  choiceOf,
  engineSoakChoiceOf,
  engineSoakFormOf,
  formFingerprint,
  formOf,
  idListRaw,
  initialCandidateComparisonForm,
  initialCardReplacementForm,
  initialEngineSoakForm,
  initialForm,
  initialOpenMetaForm,
  initialPilotRobustnessForm,
  openMetaChoiceOf,
  openMetaFormFingerprint,
  openMetaFormOf,
  parseIdList,
  pilotRobustnessChoiceOf,
  pilotRobustnessFormOf,
  type BuilderForm,
  type CandidateComparisonForm,
  type CardReplacementForm,
  type EngineSoakForm,
  type OpenMetaForm,
  type PilotRobustnessForm,
} from './builder-form.js';
import { contentCatalogFixture, presetCatalogFixture } from '../test/fake-service.js';

/**
 * The form's rules, without a DOM.
 *
 * Three of them carry the tranche's own promises and are worth stating plainly:
 * a form becomes a request only through `presetChoiceSchema`; the fingerprint
 * changes when anything that changes the schedule changes, which is what makes
 * "the exact total is shown before enqueue" enforceable rather than habitual;
 * and a saved configuration reopens into the form it was saved from.
 */

const CONTENT: ContentCatalog = contentCatalogFixture();

function form(overrides: Partial<BuilderForm> = {}): BuilderForm {
  return { ...initialForm(CONTENT), ...overrides };
}

describe('the default form', () => {
  it('selects every precon this environment can play, and no refused one', () => {
    expect(initialForm(CONTENT).preconIds).toEqual([
      'precon_goblin_swarm',
      'precon_bastion_guardians',
      'precon_containment_control',
    ]);
    expect(initialForm(CONTENT).preconIds).not.toContain('precon_broken_deck');
  });

  it('starts with a pilot that can carry a balance claim', () => {
    const pilots = initialForm(CONTENT).pilotIds;
    expect(pilots).toHaveLength(1);
    const chosen = CONTENT.pilots.find((pilot) => pilot.pilotId === pilots[0]);
    expect(chosen?.playQualityEvidence).toBe(true);
  });

  it('uses the preset’s own depth, and a stated seed rather than a generated one', () => {
    const initial = initialForm(CONTENT);
    expect(initial.workloadMode).toBe('preset');
    expect(initial.mirrorSeats).toBe(true);
    expect(initial.replicates).toBe(1);
    // A generated seed would make two runs of "the same" configuration different
    // experiments without anybody being told.
    expect(initialForm(CONTENT).seed).toBe(initial.seed);
    expect(initial.seed.length).toBeGreaterThan(0);
  });

  it('is empty rather than invented when no content has arrived', () => {
    expect(initialForm(null).preconIds).toEqual([]);
    expect(initialForm(null).pilotIds).toEqual([]);
  });
});

describe('turning a form into a request', () => {
  it('produces a choice the contract accepts', () => {
    const result = choiceOf(form());
    expect(result.ok).toBe(true);
  });

  it('refuses fewer than two precons, beside the control', () => {
    const result = choiceOf(form({ preconIds: ['precon_goblin_swarm'] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.field).toBe('preconIds');
    expect(result.problems[0]?.message).toContain('at least two');
  });

  it('refuses no pilot at all', () => {
    const result = choiceOf(form({ pilotIds: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.field)).toContain('pilotIds');
  });

  it('reports a schema failure against the control it belongs to', () => {
    // 0 replicates is refused by the contract, not by a second rule here.
    const result = choiceOf(form({ replicates: 0 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.field)).toContain('replicates');
  });

  it('refuses an experiment name the simulator’s slug rule would', () => {
    const result = choiceOf(form({ experimentId: 'Not A Slug' }));
    expect(result.ok).toBe(false);
  });

  it('carries the custom workload only when custom is chosen', () => {
    const preset = choiceOf(form({ workloadMode: 'preset', gamesPerSeatOrder: 99 }));
    const custom = choiceOf(form({ workloadMode: 'custom', gamesPerSeatOrder: 99 }));
    expect(
      preset.ok && preset.choice.presetId === 'precon_standard'
        ? preset.choice.settings.workload
        : null,
    ).toEqual({ mode: 'preset' });
    expect(
      custom.ok && custom.choice.presetId === 'precon_standard'
        ? custom.choice.settings.workload
        : null,
    ).toEqual({ mode: 'custom', gamesPerSeatOrder: 99 });
  });
});

describe('the fingerprint', () => {
  it('changes when anything that changes the schedule changes', () => {
    const base = formFingerprint(form());
    const changes: Partial<BuilderForm>[] = [
      { presetId: 'precon_deep' },
      { preconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'] },
      { pilotIds: ['value', 'aggressive'] },
      { workloadMode: 'custom' },
      { replicates: 2 },
      { mirrorSeats: false },
      { replaySampleRate: 0 },
      { workers: 3 },
      { seed: 'another-seed' },
      { experimentId: 'another-name' },
    ];
    for (const change of changes) {
      expect(`${JSON.stringify(change)}: ${String(formFingerprint(form(change)) === base)}`).toBe(
        `${JSON.stringify(change)}: false`,
      );
    }
  });

  it('does not change when only the batch label is renamed', () => {
    // The label names the batch in the catalog and changes nothing about the
    // schedule, so renaming it must not throw away a total that is still right.
    expect(formFingerprint(form({ batchLabel: 'Renamed' }))).toBe(formFingerprint(form()));
  });

  it('is empty for a form that is not yet a request', () => {
    expect(formFingerprint(form({ pilotIds: [] }))).toBe('');
  });
});

describe('reopening a saved configuration', () => {
  it('restores every setting the form can hold', () => {
    const original = form({
      presetId: 'precon_deep',
      preconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'],
      pilotIds: ['aggressive'],
      workloadMode: 'custom',
      gamesPerSeatOrder: 7,
      replicates: 3,
      mirrorSeats: false,
      replaySampleRate: 0,
      workers: 2,
      seed: 'kept-seed',
      experimentId: 'kept-run',
    });
    const result = choiceOf(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reopened = formOf(result.choice, 'Kept');
    expect(reopened).not.toBeNull();
    expect(reopened).toEqual({ ...original, batchLabel: 'Kept' });
    // And the round trip is stable: reopening produces the same request again.
    expect(formFingerprint(reopened as BuilderForm)).toBe(formFingerprint(original));
  });

  it('falls back to the preset’s depth when the workload was the preset’s', () => {
    const result = choiceOf(form({ presetId: 'precon_deep', workloadMode: 'preset' }));
    if (!result.ok) return;
    expect(formOf(result.choice, 'Kept')?.gamesPerSeatOrder).toBe(PRESET_DEPTHS.precon_deep);
  });

  it('declines a choice for a preset this builder does not configure', () => {
    const soak = {
      presetId: 'engine_soak',
      experimentId: 'soak',
      seed: 'seed',
      preconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'],
      gamesPerSeatOrder: 25,
    } as unknown as PresetChoice;
    expect(asBenchmarkChoice(soak)).toBeNull();
    expect(formOf(soak, 'Soak')).toBeNull();
  });
});

describe('which presets this builder offers', () => {
  it('is every available precon-benchmark preset the service published', () => {
    const offered = benchmarkPresets(presetCatalogFixture().presets);
    expect(offered.map((preset) => preset.id)).toEqual([...BUILDER_PRESET_IDS]);
    for (const preset of offered) expect(preset.testStyle).toBe('precon_benchmark');
  });

  it('offers no reserved preset, because this build cannot schedule one', () => {
    const offered = benchmarkPresets([
      ...presetCatalogFixture().presets,
      { ...presetCatalogFixture().presets[0], id: 'adaptive_counter', status: 'reserved' } as never,
    ]);
    expect(offered.map((preset) => preset.id)).not.toContain('adaptive_counter');
  });

  it('prints each depth from the registry’s own summary rather than a second copy', () => {
    // `PRESET_DEPTHS` is a client-side restatement of a number the server
    // settles. This is the cheap half of holding it still: each summary names the
    // number this screen would print beside it.
    const words: Readonly<Record<number, string>> = {
      1: 'one game',
      4: 'four games',
      12: 'twelve',
    };
    for (const id of BUILDER_PRESET_IDS) {
      expect(`${id}: ${PRESET_REGISTRY[id].summary}`).toContain(words[PRESET_DEPTHS[id]] ?? '—');
    }
  });
});

/* ------------------------------------------------------------- open meta */

function openMetaForm(overrides: Partial<OpenMetaForm> = {}): OpenMetaForm {
  return { ...initialOpenMetaForm(CONTENT), ...overrides };
}

describe('the Commander picker', () => {
  it('offers every Commander a playable precon names, deduplicated and sorted', () => {
    expect(catalogCommanderIds(CONTENT)).toEqual([
      'bastion_marshal',
      'containment_warden',
      'goblin_warboss',
    ]);
  });

  it('is empty rather than invented when no content has arrived', () => {
    expect(catalogCommanderIds(null)).toEqual([]);
  });
});

describe('the Open Meta form', () => {
  it('defaults to every legal Commander — still "open"', () => {
    const initial = initialOpenMetaForm(CONTENT);
    expect(initial.commanderScope).toBe('all');
    expect(initial.commanderIds).toEqual([]);
    const result = openMetaChoiceOf(initial);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.choice.commanderIds).toEqual([]);
  });

  it('carries a selected Commander scope through to the request, and only then', () => {
    const scoped = openMetaChoiceOf(
      openMetaForm({ commanderScope: 'selected', commanderIds: ['goblin_warboss'] }),
    );
    expect(scoped.ok).toBe(true);
    if (scoped.ok) expect(scoped.choice.commanderIds).toEqual(['goblin_warboss']);

    // Selecting a scope with nothing chosen is a form problem beside the control,
    // not a request the contract has to refuse.
    const empty = openMetaChoiceOf(openMetaForm({ commanderScope: 'selected', commanderIds: [] }));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.problems.map((problem) => problem.field)).toContain('commanderIds');
  });

  it('refuses no pilot at all', () => {
    const result = openMetaChoiceOf(openMetaForm({ pilotIds: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.map((problem) => problem.field)).toContain('pilotIds');
  });

  it('carries the budget knobs into the request unchanged', () => {
    const result = openMetaChoiceOf(
      openMetaForm({
        populationSize: 32,
        generations: 8,
        eliteCount: 5,
        mutationStrength: 4,
        crossoverShare: 0.4,
        opponentsPerEvaluation: 6,
        gamesPerOpponent: 3,
        archiveSize: 40,
        replicates: 3,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.choice).toMatchObject({
      populationSize: 32,
      generations: 8,
      eliteCount: 5,
      mutationStrength: 4,
      crossoverShare: 0.4,
      opponentsPerEvaluation: 6,
      gamesPerOpponent: 3,
      archiveSize: 40,
      replicates: 3,
    });
  });

  it('sends a plan ID only when one is set, so the search stays unconstrained by default', () => {
    const unconstrained = openMetaChoiceOf(openMetaForm());
    expect(unconstrained.ok && unconstrained.choice.planId).toBeUndefined();
    const planned = openMetaChoiceOf(openMetaForm({ planId: 'bastion_core' }));
    expect(planned.ok && planned.choice.planId).toBe('bastion_core');
  });

  it('changes fingerprint when a budget knob or the Commander scope changes', () => {
    const base = openMetaFormFingerprint(openMetaForm());
    const changes: Partial<OpenMetaForm>[] = [
      { commanderScope: 'selected', commanderIds: ['goblin_warboss'] },
      { populationSize: 32 },
      { generations: 8 },
      { eliteCount: 6 },
      { mutationStrength: 5 },
      { crossoverShare: 0.5 },
      { opponentsPerEvaluation: 8 },
      { gamesPerOpponent: 4 },
      { archiveSize: 40 },
      { replicates: 4 },
      { planId: 'bastion_core' },
      { pilotIds: ['value', 'aggressive'] },
      { seed: 'another-seed' },
      { experimentId: 'another-name' },
    ];
    for (const change of changes) {
      expect(
        `${JSON.stringify(change)}: ${String(openMetaFormFingerprint(openMetaForm(change)) === base)}`,
      ).toBe(`${JSON.stringify(change)}: false`);
    }
  });

  it('does not change fingerprint when only the batch label is renamed', () => {
    expect(openMetaFormFingerprint(openMetaForm({ batchLabel: 'Renamed' }))).toBe(
      openMetaFormFingerprint(openMetaForm()),
    );
  });

  it('reopens a saved Open Meta choice into the form it was saved from', () => {
    const original = openMetaForm({
      commanderScope: 'selected',
      commanderIds: ['goblin_warboss', 'bastion_marshal'],
      planId: 'bastion_core',
      populationSize: 32,
      generations: 8,
      eliteCount: 6,
      mutationStrength: 5,
      crossoverShare: 0.5,
      opponentsPerEvaluation: 8,
      gamesPerOpponent: 4,
      archiveSize: 40,
      replicates: 4,
      replaySampleRate: 0,
      seed: 'kept-seed',
      experimentId: 'kept-run',
    });
    const result = openMetaChoiceOf(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reopened = openMetaFormOf(result.choice, 'Kept');
    expect(reopened).toEqual({ ...original, batchLabel: 'Kept' });
    expect(openMetaFormFingerprint(reopened as OpenMetaForm)).toBe(
      openMetaFormFingerprint(original),
    );
  });

  it('declines a choice for a preset this form does not configure', () => {
    const precon = choiceOf(form());
    expect(precon.ok).toBe(true);
    if (!precon.ok) return;
    expect(openMetaFormOf(precon.choice, 'Kept')).toBeNull();
  });
});

/* --------------------------------------------------------- id list parsing */

describe('parseIdList', () => {
  it('splits on commas and newlines, trims, and drops blanks and duplicates', () => {
    expect(parseIdList('a, b\nc,, a ,  \n')).toEqual(['a', 'b', 'c']);
  });

  it('round-trips through idListRaw', () => {
    expect(parseIdList(idListRaw(['x', 'y']))).toEqual(['x', 'y']);
  });
});

/* ------------------------------------------------- candidate patch comparison */

function candidateComparisonForm(
  overrides: Partial<CandidateComparisonForm> = {},
): CandidateComparisonForm {
  return { ...initialCandidateComparisonForm(CONTENT), ...overrides };
}

describe('the Candidate Patch Comparison form (M08.20D)', () => {
  it('turns reference decks, pilots and a card patch into a request the contract accepts', () => {
    const result = candidateComparisonChoiceOf(
      candidateComparisonForm({
        referencePreconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'],
        cardPatchRows: [{ cardId: 'goblin_raider', cost: '3', attack: '', health: '' }],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.choice.referencePreconIds).toEqual([
      'precon_goblin_swarm',
      'precon_bastion_guardians',
    ]);
    expect(result.choice.cardPatches).toEqual([{ cardId: 'goblin_raider', cost: 3 }]);
  });

  it('refuses fewer than two reference decks, beside the control', () => {
    const result = candidateComparisonChoiceOf(
      candidateComparisonForm({ referencePreconIds: ['precon_goblin_swarm'] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.field).toBe('referencePreconIds');
  });

  it('drops a card patch row whose card ID is blank, without failing the request', () => {
    const result = candidateComparisonChoiceOf(
      candidateComparisonForm({
        referencePreconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'],
        cardPatchRows: [
          EMPTY_CARD_PATCH_ROW,
          { cardId: 'goblin_raider', cost: '3', attack: '', health: '' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.choice.cardPatches).toEqual([{ cardId: 'goblin_raider', cost: 3 }]);
    }
  });

  it('changes fingerprint when the candidate change changes, not when the label does', () => {
    const base = candidateComparisonFormFingerprint(
      candidateComparisonForm({
        referencePreconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'],
      }),
    );
    const removed = candidateComparisonFormFingerprint(
      candidateComparisonForm({
        referencePreconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'],
        removeCardIdsRaw: 'goblin_raider',
      }),
    );
    expect(removed).not.toBe(base);

    const relabeled = candidateComparisonFormFingerprint(
      candidateComparisonForm({
        referencePreconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'],
        batchLabel: 'Renamed',
      }),
    );
    expect(relabeled).toBe(base);
  });

  it('reopens a saved choice into the form it was saved from', () => {
    const original = candidateComparisonForm({
      referencePreconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'],
      removeCardIdsRaw: 'goblin_raider, shock_bolt',
      cardPatchRows: [{ cardId: 'goblin_raider', cost: '3', attack: '2', health: '' }],
      searchBothEnvironments: false,
      seed: 'kept-seed',
      experimentId: 'kept-run',
    });
    const result = candidateComparisonChoiceOf(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reopened = candidateComparisonFormOf(result.choice, 'Kept');
    expect(reopened).toEqual({ ...original, batchLabel: 'Kept' });
    expect(candidateComparisonFormFingerprint(reopened as CandidateComparisonForm)).toBe(
      candidateComparisonFormFingerprint(original),
    );
  });

  it('declines a choice for a preset this form does not configure', () => {
    const precon = choiceOf(form());
    expect(precon.ok).toBe(true);
    if (!precon.ok) return;
    expect(candidateComparisonFormOf(precon.choice, 'Kept')).toBeNull();
  });
});

/* --------------------------------------------------------- pilot robustness */

function pilotRobustnessForm(overrides: Partial<PilotRobustnessForm> = {}): PilotRobustnessForm {
  return { ...initialPilotRobustnessForm(CONTENT), ...overrides };
}

describe('the Pilot Robustness form (M08.20D)', () => {
  it('turns decks, pilots and named profiles into a request the contract accepts', () => {
    const result = pilotRobustnessChoiceOf(
      pilotRobustnessForm({
        preconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'],
        profileIdsRaw: 'timing_jitter, mulligan_noise',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.choice.profileIds).toEqual(['timing_jitter', 'mulligan_noise']);
    }
  });

  it('refuses no perturbation profile named at all, beside its own control', () => {
    const result = pilotRobustnessChoiceOf(
      pilotRobustnessForm({ preconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.field)).toContain('profileIdsRaw');
  });

  it('reopens a saved choice into the form it was saved from', () => {
    const original = pilotRobustnessForm({
      preconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'],
      profileIdsRaw: 'timing_jitter, mulligan_noise',
      seed: 'kept-seed',
      experimentId: 'kept-run',
    });
    const result = pilotRobustnessChoiceOf(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reopened = pilotRobustnessFormOf(result.choice, 'Kept');
    expect(reopened).toEqual({ ...original, batchLabel: 'Kept' });
  });

  it('declines a choice for a preset this form does not configure', () => {
    const precon = choiceOf(form());
    expect(precon.ok).toBe(true);
    if (!precon.ok) return;
    expect(pilotRobustnessFormOf(precon.choice, 'Kept')).toBeNull();
  });
});

/* -------------------------------------------------------------- engine soak */

function engineSoakForm(overrides: Partial<EngineSoakForm> = {}): EngineSoakForm {
  return { ...initialEngineSoakForm(), ...overrides };
}

describe('the Engine Soak form (M08.20D)', () => {
  it('carries no pilot and no seat-order control — only decks and the games knob', () => {
    const initial = initialEngineSoakForm();
    expect(initial.preconIds).toEqual([]);
    expect(initial.gamesPerSeatOrder).toBe(25);
  });

  it('turns two or more decks into a request the contract accepts', () => {
    const result = engineSoakChoiceOf(
      engineSoakForm({ preconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'] }),
    );
    expect(result.ok).toBe(true);
  });

  it('refuses fewer than two decks, beside the control', () => {
    const result = engineSoakChoiceOf(engineSoakForm({ preconIds: ['precon_goblin_swarm'] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]?.field).toBe('preconIds');
  });

  it('reopens a saved choice into the form it was saved from', () => {
    const original = engineSoakForm({
      preconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'],
      gamesPerSeatOrder: 100,
      seed: 'kept-seed',
      experimentId: 'kept-run',
    });
    const result = engineSoakChoiceOf(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reopened = engineSoakFormOf(result.choice, 'Kept');
    expect(reopened).toEqual({ ...original, batchLabel: 'Kept' });
  });

  it('declines a choice for a preset this form does not configure', () => {
    const precon = choiceOf(form());
    expect(precon.ok).toBe(true);
    if (!precon.ok) return;
    expect(engineSoakFormOf(precon.choice, 'Kept')).toBeNull();
  });
});

/* ---------------------------------------------------------- card replacement */

function cardReplacementForm(overrides: Partial<CardReplacementForm> = {}): CardReplacementForm {
  return { ...initialCardReplacementForm(CONTENT), ...overrides };
}

describe('the Card Replacement form (M08.20D)', () => {
  it('turns a base deck, a fixed opponent field and a subject card into a request', () => {
    const result = cardReplacementChoiceOf(
      cardReplacementForm({
        baseDeckPreconIds: ['precon_goblin_swarm'],
        opponentPreconIds: ['precon_bastion_guardians', 'precon_containment_control'],
        subjectCardId: 'goblin_raider',
        candidateCardIdsRaw: 'shock_bolt, iron_wall',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.choice.subjectCardId).toBe('goblin_raider');
    expect(result.choice.candidateCardIds).toEqual(['shock_bolt', 'iron_wall']);
  });

  it('sends the copies control as "all" or a bounded count, never both', () => {
    const base = {
      baseDeckPreconIds: ['precon_goblin_swarm'],
      opponentPreconIds: ['precon_bastion_guardians', 'precon_containment_control'],
      subjectCardId: 'goblin_raider',
    };
    const all = cardReplacementChoiceOf(cardReplacementForm({ ...base, copiesMode: 'all' }));
    expect(all.ok && all.choice.copies).toBe('all');

    const custom = cardReplacementChoiceOf(
      cardReplacementForm({ ...base, copiesMode: 'custom', copiesCount: 2 }),
    );
    expect(custom.ok && custom.choice.copies).toBe(2);
  });

  it('refuses no subject card at all, beside its own control', () => {
    const result = cardReplacementChoiceOf(
      cardReplacementForm({
        baseDeckPreconIds: ['precon_goblin_swarm'],
        opponentPreconIds: ['precon_bastion_guardians', 'precon_containment_control'],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((problem) => problem.field)).toContain('subjectCardId');
  });

  it('reopens a saved choice into the form it was saved from, including the insertion controls', () => {
    const original = cardReplacementForm({
      baseDeckPreconIds: ['precon_goblin_swarm'],
      opponentPreconIds: ['precon_bastion_guardians', 'precon_containment_control'],
      subjectCardId: 'goblin_raider',
      candidateCardIdsRaw: 'shock_bolt, iron_wall',
      copiesMode: 'custom',
      copiesCount: 2,
      includeInsertion: true,
      insertionCopiesMode: 'custom',
      insertionCopiesCount: 1,
      insertionRemoveCardIdsRaw: 'chaff_token',
      seed: 'kept-seed',
      experimentId: 'kept-run',
    });
    const result = cardReplacementChoiceOf(original);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reopened = cardReplacementFormOf(result.choice, 'Kept');
    expect(reopened).toEqual({ ...original, batchLabel: 'Kept' });
  });

  it('declines a choice for a preset this form does not configure', () => {
    const precon = choiceOf(form());
    expect(precon.ok).toBe(true);
    if (!precon.ok) return;
    expect(cardReplacementFormOf(precon.choice, 'Kept')).toBeNull();
  });
});
