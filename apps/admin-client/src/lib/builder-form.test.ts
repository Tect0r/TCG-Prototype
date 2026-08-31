import { describe, expect, it } from 'vitest';

import { PRESET_REGISTRY, type ContentCatalog, type PresetChoice } from '@tcg/admin-contracts';

import {
  BUILDER_PRESET_IDS,
  PRESET_DEPTHS,
  asBenchmarkChoice,
  benchmarkPresets,
  choiceOf,
  formFingerprint,
  formOf,
  initialForm,
  type BuilderForm,
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
