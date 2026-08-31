import { describe, expect, it } from 'vitest';

import {
  contentCatalogSchema,
  playablePrecons,
  presetExpansionSchema,
  type PresetChoiceInput,
} from '@tcg/admin-contracts';
import { resolveDeckSource } from '@tcg/simulator';

import { readContentCatalog } from './content.js';
import { estimatePreset } from './estimate.js';
import { PRESET_FORMAT_ID, PresetRefused, expandPreset, presetEnvironment } from './expand.js';

/**
 * M08.8 — what a builder may offer, and what its settings actually change.
 *
 * Two properties, and both are about **agreement** rather than about a screen.
 *
 * The content a form offers has to be the content a run resolves: a precon this
 * build lists as playable must be one `resolveDeckSource` accepts, and one it
 * marks refused must be one the same call rejects. A builder whose list came
 * from anywhere else would offer a choice the enqueue then refuses.
 *
 * And a setting has to reach the configuration. Every control M08.8 adds —
 * workload, replicates, seat-order mirroring, replay retention, workers — is
 * asserted here against the *expanded configuration*, not against the choice it
 * came from, because a knob that a form collects and an expansion ignores is a
 * knob that lies.
 */

const PRECONS = [
  'precon_bastion_guardians',
  'precon_containment_control',
  'precon_goblin_swarm',
  'precon_grave_sacrifice',
];

function benchmark(
  settings?: PresetChoiceInput extends never ? never : unknown,
): PresetChoiceInput {
  return {
    presetId: 'precon_standard',
    experimentId: 'precon-standard',
    seed: 'builder-2026-08',
    preconIds: PRECONS,
    pilotIds: ['value'],
    ...(settings === undefined ? {} : { settings }),
  } as PresetChoiceInput;
}

/** The one batch configuration a precon-benchmark stage expands into. */
function batchConfigOf(choice: PresetChoiceInput, stage = 0) {
  const expanded = expandPreset(choice);
  const config = expanded.stages[stage]?.config;
  if (config === undefined || config.kind !== 'batch') {
    throw new Error('A precon benchmark expands into batch stages.');
  }
  return config;
}

/* --------------------------------------------------------------- content */

describe('the content a builder is offered', () => {
  it('is the active format’s, and validates against its own schema', () => {
    const catalog = readContentCatalog();
    expect(contentCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(catalog.formatId).toBe(PRESET_FORMAT_ID);
    expect(catalog.precons.length).toBeGreaterThan(1);
    expect(catalog.pilots.length).toBeGreaterThan(1);
  });

  it('offers exactly the precons a run of this build would resolve', () => {
    // The property the whole module exists for. Any disagreement here is a form
    // that offers a precon the enqueue refuses, or hides one it would accept.
    const environment = presetEnvironment();
    for (const precon of readContentCatalog().precons) {
      const resolves = ((): boolean => {
        try {
          resolveDeckSource(
            { kind: 'precon', preconIds: [precon.preconId] },
            environment,
            'agreement',
          );
          return true;
        } catch {
          return false;
        }
      })();
      expect(`${precon.preconId}: ${String(resolves)}`).toBe(
        `${precon.preconId}: ${String(precon.refusals.length === 0)}`,
      );
    }
  });

  it('publishes every shipped precon as playable, so all/some selections are real', () => {
    const catalog = readContentCatalog();
    expect(playablePrecons(catalog).map((precon) => precon.preconId)).toEqual(
      catalog.precons.map((precon) => precon.preconId),
    );
  });

  it('names each pilot’s agent class and whether it can carry a balance claim', () => {
    const pilots = readContentCatalog().pilots;
    const random = pilots.find((pilot) => pilot.pilotId === 'random_legal');
    expect(random?.playQualityEvidence).toBe(false);
    expect(pilots.some((pilot) => pilot.playQualityEvidence)).toBe(true);
    for (const pilot of pilots) expect(pilot.agentClass.length).toBeGreaterThan(0);
  });

  it('carries no card list, no deck and no filesystem location', () => {
    // ADR 0023 §5, and the reason the answer is small enough to re-fetch: a
    // chooser needs to pick between precons, not to read them.
    const text = JSON.stringify(readContentCatalog());
    expect(text).not.toMatch(/[A-Za-z]:\\\\/);
    expect(text).not.toContain('cardIds');
    expect(text).not.toContain('/');
  });
});

/* -------------------------------------------------------------- workload */

describe('the workload control', () => {
  it('leaves the preset’s own depth in place when nothing is set', () => {
    expect(batchConfigOf(benchmark()).gamesPerPairing).toBe(4);
    expect(batchConfigOf(benchmark({})).gamesPerPairing).toBe(4);
  });

  it('overrides the depth when a custom workload is chosen', () => {
    const config = batchConfigOf(benchmark({ workload: { mode: 'custom', gamesPerSeatOrder: 9 } }));
    expect(config.gamesPerPairing).toBe(9);
  });

  it('records who chose the depth, so a preset name cannot imply support it lacks', () => {
    const preset = expandPreset(benchmark()).expansion.stages[0]?.decisions;
    const custom = expandPreset(benchmark({ workload: { mode: 'custom', gamesPerSeatOrder: 9 } }))
      .expansion.stages[0]?.decisions;

    expect(preset?.find((entry) => entry.path === 'gamesPerPairing')).toEqual({
      path: 'gamesPerPairing',
      value: 4,
      source: 'preset',
    });
    expect(custom?.find((entry) => entry.path === 'gamesPerPairing')).toEqual({
      path: 'gamesPerPairing',
      value: 9,
      source: 'chosen',
    });
  });

  it('says outright that an overridden depth is not the preset’s', () => {
    const expansion = expandPreset(
      benchmark({ workload: { mode: 'custom', gamesPerSeatOrder: 1 } }),
    ).expansion;
    expect(expansion.limitations.join(' ')).toContain('rather than this preset');
  });

  it('changes the exact total the estimator reports', () => {
    const four = estimatePreset(benchmark()).estimate.totalMatches;
    const eight = estimatePreset(benchmark({ workload: { mode: 'custom', gamesPerSeatOrder: 8 } }))
      .estimate.totalMatches;
    expect(eight).toBe(four * 2);
    expect(estimatePreset(benchmark()).estimate.basis).toBe('exact');
  });

  it('refuses a workload outside the simulator’s own range', () => {
    expect(() =>
      expandPreset(benchmark({ workload: { mode: 'custom', gamesPerSeatOrder: 0 } })),
    ).toThrow(PresetRefused);
  });
});

/* ------------------------------------------------------------- mirroring */

describe('seat-order mirroring', () => {
  it('is on by default, which is the run M08.6 produced', () => {
    expect(batchConfigOf(benchmark()).mirrorSeats).toBe(true);
  });

  it('halves the schedule when it is turned off', () => {
    const mirrored = estimatePreset(benchmark()).estimate;
    const oneWay = estimatePreset(benchmark({ mirrorSeats: false })).estimate;
    expect(batchConfigOf(benchmark({ mirrorSeats: false })).mirrorSeats).toBe(false);
    expect(oneWay.totalMatches).toBeLessThan(mirrored.totalMatches);
    // One orientation rather than two: the fact the breakdown exists to show.
    expect(oneWay.stages[0]?.seatOrders).toHaveLength(1);
    expect(mirrored.stages[0]?.seatOrders.length).toBeGreaterThan(1);
  });

  it('attaches the limitation that a one-way schedule creates', () => {
    const expansion = expandPreset(benchmark({ mirrorSeats: false })).expansion;
    expect(expansion.limitations.join(' ')).toContain('seat advantage');
    // And says nothing of the sort when it is left on.
    expect(expandPreset(benchmark()).expansion.limitations.join(' ')).not.toContain(
      'seat advantage',
    );
  });
});

/* ------------------------------------------------------------ replicates */

describe('replicates', () => {
  it('produce one stage each, on their own seed families', () => {
    const expansion = expandPreset(benchmark({ replicates: 3 })).expansion;
    expect(expansion.stages.map((stage) => stage.stageId)).toEqual([
      'matches-r1',
      'matches-r2',
      'matches-r3',
    ]);
    const seeds = expansion.stages.map(
      (stage) => stage.decisions.find((entry) => entry.path === 'seed')?.value,
    );
    expect(new Set(seeds).size).toBe(3);
    expect(seeds).toEqual(['builder-2026-08|r1', 'builder-2026-08|r2', 'builder-2026-08|r3']);
  });

  it('give each replicate its own experiment identity, so nothing shares a directory', () => {
    const expansion = expandPreset(benchmark({ replicates: 2 })).expansion;
    const ids = expansion.stages.map((stage) => stage.experimentId);
    expect(ids).toEqual(['precon-standard-r1', 'precon-standard-r2']);
    expect(new Set(ids).size).toBe(2);
  });

  it('are reproducible: the same choice expands to the same seeds every time', () => {
    const once = expandPreset(benchmark({ replicates: 4 })).expansion;
    const twice = expandPreset(benchmark({ replicates: 4 })).expansion;
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('leave a single replicate exactly as M08.6 expanded it', () => {
    // The regression that matters: a benchmark nobody replicated must produce the
    // run it produced before this control existed.
    const before = expandPreset(benchmark()).expansion;
    const explicit = expandPreset(benchmark({ replicates: 1 })).expansion;
    expect(before.stages).toHaveLength(1);
    expect(before.stages[0]?.stageId).toBe('matches');
    expect(before.stages[0]?.experimentId).toBe('precon-standard');
    expect(JSON.stringify(explicit)).toBe(JSON.stringify(before));
  });

  it('multiply the estimate, and say that this build does not pool them', () => {
    const one = estimatePreset(benchmark()).estimate;
    const three = estimatePreset(benchmark({ replicates: 3 })).estimate;
    expect(three.totalMatches).toBe(one.totalMatches * 3);
    expect(three.stages).toHaveLength(3);
    expect(three.limitations.join(' ')).toContain('does not pool them');
  });
});

/* --------------------------------------------------- retention and workers */

describe('retention and the worker request', () => {
  it('default to the simulator’s own replay rate and one worker', () => {
    const config = batchConfigOf(benchmark());
    expect(config.retention.replaySampleRate).toBe(50);
    expect(config.workers).toBe(1);
  });

  it('carry a chosen replay rate into the configuration', () => {
    const config = batchConfigOf(benchmark({ retention: { replaySampleRate: 1 } }));
    expect(config.retention.replaySampleRate).toBe(1);
  });

  it('never turn on the two debug-only retention flags', () => {
    // Both hold every action and every per-decision diagnostic of every match in
    // memory for the length of the run, so the form does not offer them and the
    // expansion settles them.
    for (const rate of [0, 1, 50, 1000]) {
      const config = batchConfigOf(benchmark({ retention: { replaySampleRate: rate } }));
      expect(`${String(rate)}: ${String(config.retention.keepLogs)}`).toBe(
        `${String(rate)}: false`,
      );
      expect(`${String(rate)}: ${String(config.retention.keepDecisions)}`).toBe(
        `${String(rate)}: false`,
      );
    }
  });

  it('says what keeping no replays costs', () => {
    expect(
      expandPreset(benchmark({ retention: { replaySampleRate: 0 } })).expansion.limitations.join(
        ' ',
      ),
    ).toContain('cannot be replayed');
  });

  it('carries a worker request into the configuration, where the grant still bounds it', () => {
    expect(batchConfigOf(benchmark({ workers: 6 })).workers).toBe(6);
    // The simulator's own ceiling refuses the rest; nothing here re-implements it.
    expect(() => expandPreset(benchmark({ workers: 0 }))).toThrow(PresetRefused);
  });
});

/* ------------------------------------------------------ the whole expansion */

describe('a settings-carrying expansion', () => {
  it('is still an ordinary validated expansion', () => {
    const expansion = expandPreset(
      benchmark({
        workload: { mode: 'custom', gamesPerSeatOrder: 2 },
        replicates: 2,
        mirrorSeats: false,
        retention: { replaySampleRate: 0 },
        workers: 3,
      }),
    ).expansion;
    expect(presetExpansionSchema.parse(expansion)).toEqual(expansion);
    // Every limitation the four settings create, and the preset's own, together.
    expect(expansion.limitations.length).toBeGreaterThanOrEqual(5);
  });

  it('refuses a precon this content no longer publishes, by name', () => {
    // The stale-content case. `expandPreset` assembles a configuration the
    // simulator's *schema* accepts — a precon ID is a string — and the refusal
    // comes from the environment when the estimator resolves the deck source,
    // which is the same call a run makes. Its sentence names the ID and lists
    // what the format does publish, so a builder can put it beside the control.
    const stale = {
      presetId: 'precon_standard',
      experimentId: 'stale',
      seed: 'builder-2026-08',
      preconIds: ['precon_goblin_swarm', 'precon_withdrawn_yesterday'],
      pilotIds: ['value'],
    } satisfies PresetChoiceInput;

    expect(() => estimatePreset(stale)).toThrow(/precon_withdrawn_yesterday/);
    expect(() => estimatePreset(stale)).toThrow(/precon_goblin_swarm/);
  });
});
