import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BUNDLED_PRECONS, formatCardPool, preconsForFormat } from '@tcg/card-data';
import { experimentConfigSchema } from './config.js';
import { resolveEnvironment, type EnvironmentConfigInput } from './environment.js';
import { resolveDeckSource } from './deck-source.js';
import { checkDeck } from './deck-search/deck.js';
import { runExperiment } from './experiment.js';
import { experimentPaths } from './reporting/sinks.js';

/**
 * M03.3 — precons in experiment configs.
 *
 * An experiment names a precon by its permanent ID and the simulator resolves
 * it against the same bundled content the deck builder, the lobby and the match
 * server read. The two things worth holding down are that the resolved deck is
 * the shipped list, and that everything which could quietly turn it into a
 * *different* experiment — an unknown ID, another format's precon, a card the
 * environment bans — stops the run instead.
 */

const WAVE_1 = 'precon_wave_1';

/** An environment that states the Wave 1 construction rules outright. */
function wave1Environment(overrides: Partial<EnvironmentConfigInput> = {}): EnvironmentConfigInput {
  return {
    id: 'wave_1',
    format: WAVE_1,
    deckFormat: { formatId: WAVE_1, deckSize: 40, singleton: true },
    ...overrides,
  };
}

describe('format-scoped environments', () => {
  it('resolves the named format’s pool rather than the whole card universe', () => {
    const environment = resolveEnvironment(wave1Environment());
    const expected = formatCardPool(WAVE_1).filter(
      (card) => card.collectible && card.type !== 'token',
    );

    expect(environment.pool.length).toBeGreaterThan(0);
    expect(environment.pool.every((card) => expected.some((entry) => entry.id === card.id))).toBe(
      true,
    );
    // The invariant this exists for: fixture cards are only present when a set
    // or format asks for them.
    expect(environment.pool.some((card) => card.id.startsWith('prototype_'))).toBe(false);
    expect(environment.database.get('prototype_drone')).toBeUndefined();
    expect(environment.formatId).toBe(WAVE_1);
  });

  it('scopes to the development fixtures when that format is named', () => {
    const environment = resolveEnvironment({
      id: 'fixtures',
      format: 'development',
      deckFormat: { formatId: 'development', deckSize: 30, copyLimit: 2 },
    });
    expect(environment.pool.some((card) => card.id === 'prototype_drone')).toBe(true);
    expect(environment.database.get('goblin_warboss')).toBeUndefined();
  });

  it('selects named sets in place of the format’s own selection', () => {
    const environment = resolveEnvironment({ id: 'by_set', sets: [WAVE_1] });
    expect(environment.database.get('goblin_warboss')).toBeDefined();
    expect(environment.database.get('prototype_drone')).toBeUndefined();
  });

  it('still resolves the whole bundled universe when neither is named', () => {
    // Every pre-M03.3 fixture config resolves this way and its recorded hashes
    // depend on it, so this is a regression guard rather than an endorsement.
    const environment = resolveEnvironment({ id: 'universe' });
    expect(environment.database.get('prototype_drone')).toBeDefined();
    expect(environment.database.get('goblin_warboss')).toBeDefined();
  });

  it('refuses an unknown format or set by name instead of falling back', () => {
    expect(() => resolveEnvironment({ id: 'bad_format', format: 'no_such_format' })).toThrow(
      /no_such_format/,
    );
    expect(() => resolveEnvironment({ id: 'bad_sets', sets: ['no_such_set'] })).toThrow(
      /no_such_set/,
    );
  });
});

describe('precon deck source', () => {
  const environment = resolveEnvironment(wave1Environment());

  it('resolves every shipped precon into the deck it actually prints', () => {
    const ids = preconsForFormat(WAVE_1).map((precon) => precon.id);
    expect(ids.length).toBe(4);

    const resolved = resolveDeckSource({ kind: 'precon', preconIds: ids }, environment, 'seed');
    expect(resolved.decks).toHaveLength(4);
    expect(resolved.rejected).toEqual([]);

    for (const precon of preconsForFormat(WAVE_1)) {
      const deck = resolved.decks.find((entry) => entry.id === precon.id);
      expect(deck, precon.id).toBeDefined();
      if (!deck) continue;
      expect(deck.label).toBe(precon.name);
      expect(deck.commanderId).toBe(precon.commanderId);
      expect(deck.cards).toHaveLength(40);
      expect(deck.cards.every((entry) => entry.quantity === 1)).toBe(true);
      expect(deck.cards.map((entry) => entry.cardId).sort()).toEqual([...precon.cardIds].sort());
      expect(checkDeck(deck, environment).legal, precon.id).toBe(true);
    }
  });

  it('records each precon’s ID beside the deck hash it resolved to', () => {
    const resolved = resolveDeckSource(
      { kind: 'precon', preconIds: ['precon_goblin_swarm', 'precon_bastion_guardians'] },
      environment,
      'seed',
    );
    expect(resolved.precons.map((entry) => entry.preconId)).toEqual([
      'precon_goblin_swarm',
      'precon_bastion_guardians',
    ]);
    for (const entry of resolved.precons) {
      expect(entry.formatId).toBe(WAVE_1);
      expect(resolved.decks.some((deck) => deck.hash === entry.deckHash)).toBe(true);
    }
  });

  it('resolves the same list a config could have inlined, with the same identity', () => {
    const precon = BUNDLED_PRECONS.find((entry) => entry.id === 'precon_goblin_swarm');
    if (!precon) throw new Error('precon_goblin_swarm is missing from the bundle.');

    const byId = resolveDeckSource({ kind: 'precon', preconIds: [precon.id] }, environment, 'seed');
    const inline = resolveDeckSource(
      {
        kind: 'inline',
        decks: [
          {
            id: precon.id,
            commanderId: precon.commanderId,
            cards: precon.cardIds.map((cardId) => ({ cardId, quantity: 1 })),
          },
        ],
      },
      environment,
      'seed',
    );
    expect(byId.decks[0]?.hash).toBe(inline.decks[0]?.hash);
  });

  it('stops the experiment on an unknown ID rather than substituting a deck', () => {
    expect(() =>
      resolveDeckSource({ kind: 'precon', preconIds: ['precon_nonexistent'] }, environment, 'seed'),
    ).toThrow(/No built-in precon has ID "precon_nonexistent"/);
    // The message has to say what *is* available for this format, or the only
    // way to fix the config is to go reading content/precons.
    expect(() =>
      resolveDeckSource({ kind: 'precon', preconIds: ['precon_nonexistent'] }, environment, 'seed'),
    ).toThrow(/precon_goblin_swarm/);
  });

  it('refuses a precon built for another format, naming the mismatch', () => {
    const fixtures = resolveEnvironment({
      id: 'fixtures',
      format: 'development',
      deckFormat: { formatId: 'development', deckSize: 30, copyLimit: 2 },
    });
    expect(() =>
      resolveDeckSource({ kind: 'precon', preconIds: ['precon_goblin_swarm'] }, fixtures, 'seed'),
    ).toThrow(/precon\/format_mismatch/);
  });

  it('refuses a precon the environment’s own bans would gut', () => {
    const precon = BUNDLED_PRECONS.find((entry) => entry.id === 'precon_goblin_swarm');
    const banned = precon?.cardIds[0];
    if (!banned) throw new Error('precon_goblin_swarm is missing from the bundle.');

    const restricted = resolveEnvironment(wave1Environment({ id: 'banned', banCardIds: [banned] }));
    expect(() =>
      resolveDeckSource({ kind: 'precon', preconIds: ['precon_goblin_swarm'] }, restricted, 'seed'),
    ).toThrow(/precon_goblin_swarm/);
    expect(() =>
      resolveDeckSource({ kind: 'precon', preconIds: ['precon_goblin_swarm'] }, restricted, 'seed'),
    ).toThrow(new RegExp(banned));
  });

  it('refuses the same precon listed twice in one source', () => {
    expect(() =>
      resolveDeckSource(
        { kind: 'precon', preconIds: ['precon_goblin_swarm', 'precon_goblin_swarm'] },
        environment,
        'seed',
      ),
    ).toThrow(/listed twice/);
  });

  it('rejects a malformed precon ID at configuration time', () => {
    expect(() =>
      experimentConfigSchema.parse({
        schemaVersion: 1,
        kind: 'batch',
        id: 'bad',
        seed: 'seed',
        pilots: [{ id: 'value' }],
        environment: wave1Environment(),
        decks: { kind: 'precon', preconIds: ['Precon Goblin Swarm'] },
      }),
    ).toThrow();
  });
});

describe('the shipped example config', () => {
  it('parses and resolves to the four shipped precons', () => {
    const raw: unknown = JSON.parse(readFileSync('experiments/precon-smoke.json', 'utf8'));
    const config = experimentConfigSchema.parse(raw);
    if (config.kind !== 'batch' || config.decks.kind !== 'precon') {
      throw new Error('experiments/precon-smoke.json is no longer a precon batch.');
    }

    const environment = resolveEnvironment(config.environment);
    const resolved = resolveDeckSource(config.decks, environment, config.seed);
    expect(resolved.precons.map((entry) => entry.preconId).sort()).toEqual(
      preconsForFormat(WAVE_1)
        .map((precon) => precon.id)
        .sort(),
    );
    expect(resolved.decks.every((deck) => checkDeck(deck, environment).legal)).toBe(true);
  });
});

describe('a precon experiment', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('records the precon IDs it ran in the manifest and the report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tcg-precon-'));
    roots.push(dir);

    const config = experimentConfigSchema.parse({
      schemaVersion: 1,
      kind: 'batch',
      id: 'precon_smoke',
      label: 'Two precons, one seeded game each way',
      seed: 'precon-fixture',
      playerCount: 2,
      pilots: [{ id: 'value' }],
      pilotPairing: 'mirror',
      environment: wave1Environment(),
      decks: {
        kind: 'precon',
        preconIds: [
          'precon_bastion_guardians',
          'precon_containment_control',
          'precon_goblin_swarm',
          'precon_grave_sacrifice',
        ],
      },
      gamesPerPairing: 1,
      mirrorSeats: true,
      limits: { maxTurns: 150 },
      retention: { replaySampleRate: 0 },
      workers: 1,
    });

    const outcome = await runExperiment(config, { outputDir: dir, softwareCommit: 'test-commit' });
    expect(outcome.records.length).toBeGreaterThan(0);

    // Every pairing of the four shipped decks ran to a normal end. This is the
    // regression for the defect M03.3's first smoke run found: an open Reaction
    // window was offered to the active player instead of the seat holding
    // priority, which left the pilots with no legal action and killed the match
    // outright (`seatToAct`, run-match.ts).
    expect(outcome.records.filter((record) => record.termination !== 'victory')).toEqual([]);

    const manifest = JSON.parse(readFileSync(experimentPaths(dir).manifest, 'utf8'));
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.failedMatches).toBe(0);
    expect(manifest.abnormalMatches).toBe(0);
    expect(manifest.precons.map((entry: { preconId: string }) => entry.preconId)).toEqual([
      'precon_bastion_guardians',
      'precon_containment_control',
      'precon_goblin_swarm',
      'precon_grave_sacrifice',
    ]);
    // The IDs are only reproducible next to what they resolved to: the deck
    // hashes here, and the environment hashes recorded beside them.
    for (const entry of manifest.precons) {
      expect(entry.formatId).toBe(WAVE_1);
      expect(manifest.deckHashes).toContain(entry.deckHash);
    }
    expect(manifest.environments[0].formatId).toBe(WAVE_1);
    expect(manifest.environments[0].hashes.mechanicsHash.length).toBeGreaterThan(0);

    expect(outcome.report).toContain('Precon `precon_goblin_swarm`');
    // The frozen environment is what pins the definitions those IDs named.
    const snapshot = JSON.parse(readFileSync(experimentPaths(dir).resolvedEnvironment, 'utf8'));
    expect(snapshot.formatId).toBe(WAVE_1);
    expect(snapshot.poolCardIds).not.toContain('prototype_drone');
  }, 180_000);
});
