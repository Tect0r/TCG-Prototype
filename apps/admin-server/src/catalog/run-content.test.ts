import { describe, expect, it } from 'vitest';

import { environmentConfigForFormat, parseExperimentConfig } from '@tcg/simulator';

import { testConfig } from './test-catalog.js';
import { commanderIdsOf, runContentOf, selectionMatches } from './run-content.js';

const NO_FILTER = { preconIds: [] as string[], commanderIds: [] as string[] };

const ENVIRONMENT = environmentConfigForFormat('precon_wave_1', {
  label: 'Precon Wave 1, for a run-content fixture',
});

describe('what a configuration selects', () => {
  it('finds the precons a precon deck source names', () => {
    const selection = runContentOf(testConfig());
    expect([...selection.preconIds].sort()).toEqual(
      ['precon_bastion_guardians', 'precon_goblin_swarm'].sort(),
    );
    expect(selection.inlineCommanderIds).toEqual([]);
  });

  it('finds no precon and no Commander in a generated deck source', () => {
    const config = parseExperimentConfig({
      schemaVersion: 1,
      kind: 'batch',
      id: 'fixture-generated',
      seed: 'fixture-seed',
      playerCount: 2,
      pilots: [{ id: 'aggressive' }],
      pilotPairing: 'mirror',
      environment: ENVIRONMENT,
      decks: { kind: 'generated', count: 4 },
      schedule: 'round_robin',
      gamesPerPairing: 1,
    });
    const selection = runContentOf(config);
    expect(selection.preconIds).toEqual([]);
    expect(selection.inlineCommanderIds).toEqual([]);
  });

  it('finds the Commander an inline deck states outright', () => {
    const config = parseExperimentConfig({
      schemaVersion: 1,
      kind: 'batch',
      id: 'fixture-inline',
      seed: 'fixture-seed',
      playerCount: 2,
      pilots: [{ id: 'aggressive' }],
      pilotPairing: 'mirror',
      environment: ENVIRONMENT,
      decks: {
        kind: 'inline',
        decks: [
          { commanderId: 'goblin_warboss', cards: [{ cardId: 'goblin_grunt', quantity: 10 }] },
          { commanderId: 'bastion_marshal', cards: [{ cardId: 'goblin_grunt', quantity: 10 }] },
        ],
      },
      schedule: 'round_robin',
      gamesPerPairing: 1,
    });
    const selection = runContentOf(config);
    expect(selection.preconIds).toEqual([]);
    expect([...selection.inlineCommanderIds].sort()).toEqual(
      ['bastion_marshal', 'goblin_warboss'].sort(),
    );
  });

  it('never repeats a precon or a Commander found more than once', () => {
    const config = parseExperimentConfig({
      schemaVersion: 1,
      kind: 'batch',
      id: 'fixture-repeat',
      seed: 'fixture-seed',
      playerCount: 2,
      pilots: [{ id: 'aggressive' }],
      pilotPairing: 'mirror',
      environment: ENVIRONMENT,
      decks: { kind: 'precon', preconIds: ['precon_goblin_swarm', 'precon_goblin_swarm'] },
      schedule: 'round_robin',
      gamesPerPairing: 1,
    });
    expect(runContentOf(config).preconIds).toEqual(['precon_goblin_swarm']);
  });
});

describe('resolving a precon to its Commander', () => {
  const commanderOfPrecon = new Map([
    ['precon_goblin_swarm', 'goblin_warboss'],
    ['precon_bastion_guardians', 'bastion_marshal'],
  ]);

  it('adds the precon’s Commander to the inline ones', () => {
    const selection = {
      preconIds: ['precon_goblin_swarm'],
      inlineCommanderIds: ['containment_warden'],
    };
    expect([...commanderIdsOf(selection, commanderOfPrecon)].sort()).toEqual(
      ['containment_warden', 'goblin_warboss'].sort(),
    );
  });

  it('names no Commander for a precon the map does not know, rather than guessing one', () => {
    const selection = { preconIds: ['precon_withdrawn'], inlineCommanderIds: [] };
    expect(commanderIdsOf(selection, commanderOfPrecon)).toEqual([]);
  });
});

describe('whether a selection matches a filter', () => {
  const selection = { preconIds: ['precon_goblin_swarm'], inlineCommanderIds: [] };
  const commanders = ['goblin_warboss'];

  it('matches everything when neither field is named', () => {
    expect(selectionMatches(selection, commanders, NO_FILTER)).toBe(true);
  });

  it('matches on precon, OR within the field', () => {
    expect(
      selectionMatches(selection, commanders, {
        preconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'],
        commanderIds: [],
      }),
    ).toBe(true);
    expect(
      selectionMatches(selection, commanders, {
        preconIds: ['precon_bastion_guardians'],
        commanderIds: [],
      }),
    ).toBe(false);
  });

  it('matches on Commander independently of precon', () => {
    expect(
      selectionMatches(selection, commanders, { preconIds: [], commanderIds: ['goblin_warboss'] }),
    ).toBe(true);
    expect(
      selectionMatches(selection, commanders, { preconIds: [], commanderIds: ['bastion_marshal'] }),
    ).toBe(false);
  });

  it('requires both fields when both are named, AND across fields', () => {
    expect(
      selectionMatches(selection, commanders, {
        preconIds: ['precon_goblin_swarm'],
        commanderIds: ['bastion_marshal'],
      }),
    ).toBe(false);
    expect(
      selectionMatches(selection, commanders, {
        preconIds: ['precon_goblin_swarm'],
        commanderIds: ['goblin_warboss'],
      }),
    ).toBe(true);
  });
});
