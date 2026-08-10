import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CardDefinitionInput } from '@tcg/card-data';
import { computeEnvironmentHashes, snapshotCards } from './content-hash.js';
import { diffEnvironments, resolveEnvironment } from './environment.js';
import {
  freezeEnvironment,
  restoreEnvironment,
  serializeSnapshot,
  snapshotFileName,
  verifyEnvironmentHashes,
  type ResolvedEnvironment,
} from './resolved-environment.js';
import { loadReplayBundle, replayBundle, formatReplayResult } from './replay.js';
import { runBatch } from './run-batch.js';
import { runExperiment } from './experiment.js';
import { parseExperimentConfig } from './config.js';
import { buildSchedule } from './schedule.js';
import { MatchStore } from './reporting/match-store.js';
import { experimentPaths } from './reporting/sinks.js';
import { replayBundleSchema, type ReplayBundle } from './telemetry/schema.js';
import { FAST_LIMITS, VALUE_PILOT, fixtureDeck, tinyEnvironment } from './test-fixtures.js';

/**
 * Readiness §9: experiments that survive card iteration.
 *
 * Three separate guarantees are checked here, because they fail in different
 * ways and one passing does not imply another:
 *
 * - **G1 — frozen environments.** An experiment writes the resolved card
 *   definitions, not the recipe that produced them.
 * - **G2 — a real replay command.** A bundle re-derives its own match and the
 *   comparison actually fails when the result moves.
 * - **G3 — hashes separated by meaning.** A typo fix in flavour text must not
 *   invalidate an experiment, and a cost change must.
 *
 * The central test is `reproduces a match whose card no longer exists anywhere in
 * the checkout`. That is the property the old bundles only claimed to have.
 */

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tcg-frozen-'));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * A card that exists **only** inside the environment that layers it on.
 *
 * Nothing in `packages/card-data` defines it, so a replay that reproduces a match
 * played with it can only be reading the frozen snapshot. This is a stronger
 * check than editing a bundled card: there is no version of this card to fall
 * back to, so a fallback would surface as a hard failure rather than as a subtly
 * different match.
 */
const EPHEMERAL_UNIT: CardDefinitionInput = {
  schemaVersion: 2,
  id: 'fixture_ephemeral_unit',
  name: 'Fixture Ephemeral Unit',
  type: 'unit',
  colorIdentity: [],
  cost: 2,
  attack: 3,
  health: 3,
  role: 'attacker',
  powerClass: 'standard',
  tags: ['fixture'],
  displayText: 'Defined by one experiment and by nothing else in the repository.',
};

const baseEnv = tinyEnvironment({ id: 'frozen' });

/* ------------------------------------------------------------------ hashes */

describe('hash separation by meaning (G3)', () => {
  const original = resolveEnvironment({
    id: 'hashes',
    cardOverrides: [EPHEMERAL_UNIT] as never,
    allowCardIds: [
      'fixture_ephemeral_unit',
      'prototype_scout',
      'prototype_commander_blue',
    ] as never,
  });

  const withEdit = (patch: Record<string, unknown>) =>
    resolveEnvironment({
      id: 'hashes',
      cardOverrides: [{ ...EPHEMERAL_UNIT, ...patch }] as never,
      allowCardIds: [
        'fixture_ephemeral_unit',
        'prototype_scout',
        'prototype_commander_blue',
      ] as never,
    });

  it('leaves mechanics and pilot input untouched when only printed text changes', () => {
    const edited = withEdit({
      name: 'Fixture Ephemeral Unit (typo fixed)',
      displayText: 'Reworded, mechanically identical.',
    });

    expect(edited.hashes.mechanicsHash).toBe(original.hashes.mechanicsHash);
    expect(edited.hashes.pilotInputHash).toBe(original.hashes.pilotInputHash);
    expect(edited.hashes.presentationHash).not.toBe(original.hashes.presentationHash);
    expect(edited.hashes.fullContentHash).not.toBe(original.hashes.fullContentHash);
  });

  it('moves every hash when the engine would execute the card differently', () => {
    const edited = withEdit({ cost: 5 });

    expect(edited.hashes.mechanicsHash).not.toBe(original.hashes.mechanicsHash);
    expect(edited.hashes.pilotInputHash).not.toBe(original.hashes.pilotInputHash);
    expect(edited.hashes.fullContentHash).not.toBe(original.hashes.fullContentHash);
    // Presentation is unchanged: the printed name and text are identical.
    expect(edited.hashes.presentationHash).toBe(original.hashes.presentationHash);
  });

  it('moves only the pilot-input hash when authored metadata changes', () => {
    const edited = withEdit({ role: 'blocker', powerClass: 'minor' });

    expect(edited.hashes.mechanicsHash).toBe(original.hashes.mechanicsHash);
    expect(edited.hashes.presentationHash).toBe(original.hashes.presentationHash);
    expect(edited.hashes.pilotInputHash).not.toBe(original.hashes.pilotInputHash);
  });

  it('treats tags as mechanical, because card filters match on them', () => {
    const edited = withEdit({ tags: ['fixture', 'soldier'] });
    expect(edited.hashes.mechanicsHash).not.toBe(original.hashes.mechanicsHash);
  });

  it('treats a ban as mechanical without touching any definition', () => {
    const banned = resolveEnvironment({
      id: 'hashes',
      cardOverrides: [EPHEMERAL_UNIT] as never,
      allowCardIds: ['prototype_scout', 'prototype_commander_blue'] as never,
    });
    expect(banned.hashes.mechanicsHash).not.toBe(original.hashes.mechanicsHash);
  });

  it('is independent of the order cards were resolved in', () => {
    const cards = snapshotCards(original.pool, original.commanders, original.database);
    const forwards = computeEnvironmentHashes({
      cards,
      rulesConfig: original.rulesConfig,
      deckFormat: original.deckFormat,
      poolCardIds: original.pool.map((card) => card.id),
      commanderCardIds: original.commanders.map((card) => card.id),
    });
    const backwards = computeEnvironmentHashes({
      cards: [...cards].reverse(),
      rulesConfig: original.rulesConfig,
      deckFormat: original.deckFormat,
      poolCardIds: [...original.pool].reverse().map((card) => card.id),
      commanderCardIds: [...original.commanders].reverse().map((card) => card.id),
    });
    expect(backwards).toEqual(forwards);
  });

  it('agrees with the hashes the frozen snapshot recomputes from its own content', () => {
    expect(freezeEnvironment(original).hashes).toEqual(original.hashes);
  });
});

/* ----------------------------------------------------------- card patches */

describe('card patches (C5)', () => {
  const patched = resolveEnvironment({
    id: 'patched',
    cardOverrides: [EPHEMERAL_UNIT] as never,
    cardPatches: [{ cardId: 'fixture_ephemeral_unit', note: 'cost test', patch: { cost: 4 } }],
    allowCardIds: [
      'fixture_ephemeral_unit',
      'prototype_scout',
      'prototype_commander_blue',
    ] as never,
  });

  it('applies the edit to the resolved definition', () => {
    expect(patched.database.get('fixture_ephemeral_unit')?.cost).toBe(4);
    // Untouched fields survive: a patch states what moves, nothing more.
    expect(patched.database.get('fixture_ephemeral_unit')?.attack).toBe(3);
  });

  it('does not let a schema default overwrite a field the patch never named', () => {
    // The regression this guards: a patch body built with `.pick().partial()`
    // still fires every `.default()`, so `{ cost: 4 }` arrives carrying empty
    // tags, keywords and effects and a one-number balance edit deletes the
    // card's rules text.
    const withRules = resolveEnvironment({
      id: 'patched',
      cardOverrides: [
        {
          ...EPHEMERAL_UNIT,
          keywords: ['rush'],
          effects: [{ type: 'draw', player: 'self', amount: 1 }],
        },
      ] as never,
      cardPatches: [{ cardId: 'fixture_ephemeral_unit', patch: { cost: 4 } }],
    });

    const card = withRules.database.get('fixture_ephemeral_unit');
    expect(card?.cost).toBe(4);
    expect(card?.tags).toEqual(['fixture']);
    expect(card?.keywords).toEqual(['rush']);
    expect(card?.effects).toHaveLength(1);
    expect(card?.collectible).toBe(true);
  });

  it('rejects a patch to a card that does not exist', () => {
    expect(() =>
      resolveEnvironment({
        id: 'patched',
        cardPatches: [{ cardId: 'not_a_real_card', patch: { cost: 1 } }],
      }),
    ).toThrow(/does not exist in the resolved card pool/);
  });

  it('rejects a patch whose fields are each legal but whose result is not a card', () => {
    // Every field-level rule passes here — an empty effect list is an ordinary
    // value. Only re-validating the *merged* card catches it, which is exactly
    // the guarantee a patch has to carry: nothing reachable by a patch is
    // something an author could not have written directly.
    expect(() =>
      resolveEnvironment({
        id: 'patched',
        cardOverrides: [
          {
            schemaVersion: 2,
            id: 'fixture_ephemeral_spell',
            name: 'Fixture Ephemeral Spell',
            type: 'spell',
            colorIdentity: [],
            cost: 1,
            effects: [{ type: 'draw', player: 'self', amount: 1 }],
          },
        ] as never,
        cardPatches: [{ cardId: 'fixture_ephemeral_spell', patch: { effects: [] } }],
      }),
    ).toThrow(/invalid card[\s\S]*at least one effect/);
  });

  it('rejects a field that is not on the patch allow-list', () => {
    expect(() =>
      resolveEnvironment({
        id: 'patched',
        cardOverrides: [EPHEMERAL_UNIT] as never,
        // Changing `id` or `type` would produce a different card wearing the old
        // one's identity, so every deck hash and record downstream would be
        // quietly wrong about what was played.
        cardPatches: [
          { cardId: 'fixture_ephemeral_unit', patch: { id: 'something_else' } as never },
        ],
      }),
    ).toThrow();
  });

  it('derives the environment diff from the patch, with the full before and after', () => {
    const baseline = resolveEnvironment({
      id: 'patched',
      cardOverrides: [EPHEMERAL_UNIT] as never,
      allowCardIds: [
        'fixture_ephemeral_unit',
        'prototype_scout',
        'prototype_commander_blue',
      ] as never,
    });

    const diff = diffEnvironments(baseline, patched);
    expect(diff.identical).toBe(false);
    expect(diff.cardsAdded).toEqual([]);
    expect(diff.cardsRemoved).toEqual([]);
    expect(diff.cardsChanged).toHaveLength(1);

    const changed = diff.cardsChanged[0];
    expect(changed?.cardId).toBe('fixture_ephemeral_unit');
    // The patch named one field, so the derived diff must name exactly that one.
    expect(changed?.fields).toEqual(['cost']);
    expect(changed?.before).toContain('"cost":2');
    expect(changed?.after).toContain('"cost":4');
  });
});

/* -------------------------------------------------------------- snapshots */

describe('frozen environment snapshots (G1)', () => {
  const snapshot = freezeEnvironment(baseEnv);

  it('round-trips through JSON without losing anything', () => {
    const parsed: ResolvedEnvironment = JSON.parse(serializeSnapshot(snapshot));
    expect(parsed).toEqual(snapshot);
    expect(verifyEnvironmentHashes(parsed)).toEqual([]);
  });

  it('carries every playable card and Commander', () => {
    const ids = new Set(snapshot.cards.map((card) => card.id));
    for (const card of [...baseEnv.pool, ...baseEnv.commanders])
      expect(ids.has(card.id)).toBe(true);
    expect(snapshot.poolCardIds).toEqual([...snapshot.poolCardIds].sort());
  });

  it('carries the tokens the pool can create, since a match can reach them', () => {
    const tokenMakers = baseEnv.pool.filter((card) =>
      [...card.effects, ...card.abilities.flatMap((a) => a.effects)].some(
        (effect) => effect.type === 'create_token',
      ),
    );
    // Guard: if the fixture pool ever loses its token makers this test is vacuous.
    expect(tokenMakers.length).toBeGreaterThan(0);

    const ids = new Set(snapshot.cards.map((card) => card.id));
    for (const maker of tokenMakers) {
      for (const effect of maker.effects) {
        if (effect.type !== 'create_token') continue;
        expect(ids.has(effect.tokenCardId)).toBe(true);
      }
    }
  });

  it('names its file by its own content', () => {
    expect(snapshotFileName(snapshot)).toBe(
      `${snapshot.environmentId}.${snapshot.hashes.fullContentHash}.json`,
    );
  });

  it('refuses to restore a snapshot whose content was edited underneath its hashes', () => {
    const tampered: ResolvedEnvironment = {
      ...snapshot,
      cards: snapshot.cards.map((card, index) =>
        index === 0 ? { ...card, cost: (card.cost ?? 0) + 1 } : card,
      ),
    };

    expect(verifyEnvironmentHashes(tampered).length).toBeGreaterThan(0);
    expect(() => restoreEnvironment(tampered)).toThrow(/failed hash verification/);
  });

  it('restores an environment that reads only from the snapshot', () => {
    const restored = restoreEnvironment(snapshot);
    expect(restored.hashes).toEqual(snapshot.hashes);
    expect(restored.pool.map((card) => card.id).sort()).toEqual([...snapshot.poolCardIds].sort());
    // Nothing outside the snapshot leaks in through the bundled database.
    expect(restored.database.all().length).toBe(snapshot.cards.length);
  });
});

/* ------------------------------------------------------------- replay (G2) */

/** Plays a couple of matches with replays retained, and returns the bundles. */
async function bundlesFrom(environment = baseEnv): Promise<ReplayBundle[]> {
  const dir = tempDir();
  const decks = [
    fixtureDeck('frozen_a', 'prototype_commander_blue', [
      ['fixture_ephemeral_unit', 2],
      ['prototype_scout', 2],
      ['prototype_guard', 2],
      ['prototype_drone', 2],
      ['trench_guard', 2],
      ['unstable_construct', 2],
    ]),
    fixtureDeck('frozen_b', 'prototype_commander_blue', [
      ['prototype_scout', 2],
      ['prototype_guard', 2],
      ['prototype_drone', 2],
      ['trench_guard', 2],
      ['surveyors_lens', 2],
      ['field_survey', 2],
    ]),
  ];

  await runBatch({
    experimentId: 'frozen',
    experimentKind: 'batch',
    configHash: 'frozen-config',
    arm: null,
    environment,
    decks,
    pilots: [VALUE_PILOT],
    schedule: buildSchedule({
      experimentId: 'frozen',
      experimentSeed: 'frozen-seed',
      environmentId: environment.id,
      decks,
      pilots: [VALUE_PILOT],
      pilotPairing: 'mirror',
      playerCount: 2,
      gamesPerPairing: 1,
      mirrorSeats: true,
      schedule: 'round_robin',
      sampledPairings: 100,
    }),
    limits: FAST_LIMITS,
    // Every match keeps a full bundle: these tests are about the bundles.
    retention: { replaySampleRate: 1, keepLogs: true, keepDecisions: false },
    workers: 1,
    failFast: false,
    softwareCommit: null,
    sink: new MatchStore(null, {
      experimentId: 'frozen',
      experimentKind: 'batch',
      configHash: 'frozen-config',
    }),
    replayDir: dir,
  });

  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  return files.map((name) => loadReplayBundle(join(dir, name)));
}

describe('replaying a bundle (G2)', () => {
  /**
   * The environment that plays these matches layers on a card the repository does
   * not define. Every replay below therefore proves the snapshot did the work.
   */
  const ephemeralEnv = tinyEnvironment({
    id: 'ephemeral',
    cardOverrides: [EPHEMERAL_UNIT],
    extraCardIds: ['fixture_ephemeral_unit'],
  });

  it('embeds the resolved environment rather than the recipe that produced it', async () => {
    const [bundle] = await bundlesFrom(ephemeralEnv);
    expect(bundle).toBeDefined();

    const snapshot = (bundle as ReplayBundle).environment;
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.environmentId).toBe('ephemeral');
    // The definitions themselves, not an ID list and not a config.
    const ephemeral = snapshot.cards.find((card) => card.id === 'fixture_ephemeral_unit');
    expect(ephemeral?.attack).toBe(3);
    expect(ephemeral?.health).toBe(3);
    expect(snapshot.rulesConfig.version).toBe(ephemeralEnv.rulesConfig.version);
  });

  it('reproduces a match whose card no longer exists anywhere in the checkout', async () => {
    const [bundle] = await bundlesFrom(ephemeralEnv);
    expect(bundle).toBeDefined();

    // The premise: resolving today's card data cannot find this card at all.
    const today = resolveEnvironment({ id: 'today' });
    expect(today.database.get('fixture_ephemeral_unit')).toBeUndefined();

    const result = replayBundle(bundle as ReplayBundle);
    expect(result.divergences).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.actionsApplied).toBe((bundle as ReplayBundle).actions.length);
    expect(formatReplayResult(result)).toContain('Reproduced exactly');
  });

  it('still reproduces after the same card ID is redefined with different mechanics', async () => {
    const [bundle] = await bundlesFrom(ephemeralEnv);
    expect(bundle).toBeDefined();

    // Somebody rebalances the card into something else entirely.
    const rebalanced = resolveEnvironment({
      id: 'ephemeral',
      cardOverrides: [{ ...EPHEMERAL_UNIT, cost: 6, attack: 1, health: 1 }] as never,
    });
    expect(rebalanced.database.get('fixture_ephemeral_unit')?.attack).toBe(1);

    // The bundle is unmoved: it reads its own snapshot and nothing else.
    const result = replayBundle(bundle as ReplayBundle);
    expect(result.ok).toBe(true);
    const restored = restoreEnvironment((bundle as ReplayBundle).environment);
    expect(restored.database.get('fixture_ephemeral_unit')?.attack).toBe(3);
  });

  it('reproduces every bundle a batch wrote, not merely the first', async () => {
    const bundles = await bundlesFrom(ephemeralEnv);
    for (const bundle of bundles) expect(replayBundle(bundle).ok).toBe(true);
  });

  it('emits a readable event trace when asked, and none when not', async () => {
    const [bundle] = await bundlesFrom(ephemeralEnv);
    expect(bundle).toBeDefined();

    const traced = replayBundle(bundle as ReplayBundle, { trace: true });
    // One line per replayed event, each naming the event type it describes.
    expect(traced.trace).toHaveLength((bundle as ReplayBundle).events.length);
    const firstEventType = ((bundle as ReplayBundle).events[0] as { type: string }).type;
    expect(traced.trace[0]).toContain(firstEventType);

    expect(replayBundle(bundle as ReplayBundle).trace).toEqual([]);
  });

  it('reports the first divergence with its sequence, expectation and actual value', async () => {
    const [bundle] = await bundlesFrom(ephemeralEnv);
    expect(bundle).toBeDefined();

    // Corrupt one recorded event, as a changed engine would.
    const events = [...(bundle as ReplayBundle).events];
    const index = Math.min(2, events.length - 1);
    events[index] = { ...(events[index] as Record<string, unknown>), type: 'not_a_real_event' };

    const result = replayBundle({ ...(bundle as ReplayBundle), events });
    expect(result.ok).toBe(false);

    const first = result.divergences[0];
    expect(first?.kind).toBe('event');
    expect(first?.expected).toContain('not_a_real_event');
    expect(first?.actual).not.toContain('not_a_real_event');
    expect(typeof first?.sequence).toBe('number');

    const printed = formatReplayResult(result);
    expect(printed).toContain('DIVERGED');
    expect(printed).toContain('expected:');
    expect(printed).toContain('actual:');
  });

  it('reports a divergence when the recorded outcome no longer holds', async () => {
    const [bundle] = await bundlesFrom(ephemeralEnv);
    const record = { ...(bundle as ReplayBundle).record, winnerId: 'nobody_at_all' };

    const result = replayBundle({ ...(bundle as ReplayBundle), record }, { stopOnFirst: false });
    expect(result.ok).toBe(false);
    expect(result.divergences.some((entry) => entry.kind === 'result')).toBe(true);
  });

  it('refuses a bundle whose snapshot was edited after the fact', async () => {
    const [bundle] = await bundlesFrom(ephemeralEnv);
    const snapshot = (bundle as ReplayBundle).environment;
    const tampered: ReplayBundle = {
      ...(bundle as ReplayBundle),
      environment: {
        ...snapshot,
        cards: snapshot.cards.map((card) =>
          card.id === 'fixture_ephemeral_unit' ? { ...card, attack: 99 } : card,
        ),
      },
    };

    expect(() => replayBundle(tampered)).toThrow(/failed hash verification/);
  });

  it('validates a bundle read from disk against the schema', () => {
    expect(() => replayBundleSchema.parse({ schemaVersion: 2, matchId: 'x' })).toThrow();
  });
});

/* ---------------------------------------------------- experiment artefacts */

describe('an experiment directory carries its frozen environment (G1)', () => {
  it('writes resolved-environment.json and a content-addressed copy per environment', async () => {
    const output = tempDir();
    const config = parseExperimentConfig({
      schemaVersion: 1,
      id: 'frozen_smoke',
      kind: 'batch',
      seed: 'frozen-smoke',
      environment: {
        id: 'tiny',
        cardOverrides: [EPHEMERAL_UNIT],
        allowCardIds: [
          'fixture_ephemeral_unit',
          'prototype_drone',
          'prototype_scout',
          'prototype_guard',
          'trench_guard',
          'unstable_construct',
          'surveyors_lens',
          'energy_font',
          'field_survey',
          'prototype_commander_blue',
        ],
        deckFormat: { deckSize: 12, copyLimit: 2, uniqueCopyLimit: 1 },
      },
      decks: { kind: 'generated', count: 2 },
      pilots: [VALUE_PILOT],
      gamesPerPairing: 1,
      limits: FAST_LIMITS,
      retention: { replaySampleRate: 1, keepLogs: false, keepDecisions: false },
      output,
    });

    const outcome = await runExperiment(config, { outputDir: output, workers: 1 });
    const paths = experimentPaths(outcome.outputDir);

    const primary: ResolvedEnvironment = JSON.parse(
      readFileSync(paths.resolvedEnvironment, 'utf8'),
    );
    expect(verifyEnvironmentHashes(primary)).toEqual([]);
    expect(primary.cards.some((card) => card.id === 'fixture_ephemeral_unit')).toBe(true);

    // The content-addressed copy beside it is byte-identical to its own name.
    const files = readdirSync(paths.environments);
    expect(files).toContain(snapshotFileName(primary));
    const addressed: ResolvedEnvironment = JSON.parse(
      readFileSync(join(paths.environments, snapshotFileName(primary)), 'utf8'),
    );
    expect(addressed).toEqual(primary);

    const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8')) as {
      environments: { hashes: Record<string, string>; snapshotPath: string }[];
    };
    expect(manifest.environments[0]?.hashes).toEqual(primary.hashes);
    expect(manifest.environments[0]?.snapshotPath).toBe(
      `environments/${snapshotFileName(primary)}`,
    );

    // And the report states all four, so a reader can check a guarantee without
    // recomputing anything.
    const report = readFileSync(paths.report, 'utf8');
    expect(report).toContain(primary.hashes.mechanicsHash);
    expect(report).toContain(primary.hashes.pilotInputHash);
    expect(report).toContain(primary.hashes.presentationHash);
    expect(report).toContain(primary.hashes.fullContentHash);
  }, 60_000);

  it('replays a bundle the experiment wrote, straight off disk', async () => {
    const output = tempDir();
    const config = parseExperimentConfig({
      schemaVersion: 1,
      id: 'frozen_replayable',
      kind: 'batch',
      seed: 'frozen-replayable',
      environment: {
        id: 'tiny',
        cardOverrides: [EPHEMERAL_UNIT],
        allowCardIds: [
          'fixture_ephemeral_unit',
          'prototype_drone',
          'prototype_scout',
          'prototype_guard',
          'trench_guard',
          'unstable_construct',
          'surveyors_lens',
          'energy_font',
          'field_survey',
          'prototype_commander_blue',
        ],
        deckFormat: { deckSize: 12, copyLimit: 2, uniqueCopyLimit: 1 },
      },
      decks: { kind: 'generated', count: 2 },
      pilots: [VALUE_PILOT],
      gamesPerPairing: 1,
      limits: FAST_LIMITS,
      retention: { replaySampleRate: 1, keepLogs: true, keepDecisions: false },
      output,
    });

    const outcome = await runExperiment(config, { outputDir: output, workers: 1 });
    const paths = experimentPaths(outcome.outputDir);
    const replays = readdirSync(paths.replays).filter((name) => name.endsWith('.json'));
    expect(replays.length).toBeGreaterThan(0);

    for (const name of replays) {
      const result = replayBundle(loadReplayBundle(join(paths.replays, name)));
      expect(result.ok).toBe(true);
    }
  }, 60_000);
});
