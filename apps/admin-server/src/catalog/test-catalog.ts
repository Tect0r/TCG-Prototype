import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unwrap, type IdSources } from '@tcg/shared';
import {
  environmentConfigForFormat,
  parseExperimentConfig,
  type ExperimentConfig,
} from '@tcg/simulator';

import { FileCatalogStore } from './file-catalog-store.js';
import { resolveCatalogRoots, type ResolvedCatalogRoots } from './roots.js';

/**
 * The fixtures every catalog suite shares: a real temporary catalog, a clock
 * that does not surprise anyone, and an ID minter a test can make collide.
 *
 * Real directories rather than a mocked filesystem, deliberately. What M08.2
 * promises — a document is never seen half-written, a truncated log line is
 * dropped and reported, a symlink out of a result root is refused, a restart
 * finds `running` work and does not call it finished — are all claims about how
 * a filesystem behaves. A mock would answer them by agreeing with whatever this
 * code already does.
 */

export interface TestCatalog {
  readonly store: FileCatalogStore;
  readonly roots: ResolvedCatalogRoots;
  readonly catalogRoot: string;
  readonly resultRoot: string;
  /** Advances the injected clock, so two entries can be ordered on purpose. */
  advance(milliseconds: number): void;
  /** The instant the clock will stamp next. */
  now(): string;
  dispose(): Promise<void>;
}

/**
 * A minter whose output is a pure function of a counter.
 *
 * `generateId` takes its time and randomness as arguments precisely so a test
 * can do this. Returning the *same* pair twice is how the duplicate-ID refusal
 * is exercised without waiting for a real collision, which is the only honest
 * way to test a branch that exists for an event that should never happen.
 */
export function sequentialIdSources(start = 1): { sources: IdSources; repeatLast(): void } {
  let counter = start;
  let replay: number | null = null;
  return {
    sources: {
      now: () => {
        if (replay !== null) {
          const held = replay;
          replay = null;
          return held * 1_000;
        }
        const value = counter;
        counter += 1;
        return value * 1_000;
      },
      random: () => 0.5,
    },
    /** The next mint repeats the previous one, and the one after resumes the sequence. */
    repeatLast: () => {
      replay = counter - 1;
    },
  };
}

export async function makeTestCatalog(
  options: { readonly idSources?: IdSources } = {},
): Promise<TestCatalog> {
  const base = await mkdtemp(join(tmpdir(), 'tcg-admin-catalog-'));
  const catalogRoot = join(base, 'catalog');
  const resultRoot = join(base, 'results');

  const roots = unwrap(
    resolveCatalogRoots({ catalogRoot, resultRoots: { local: resultRoot } }),
    'test catalog roots',
  );

  let clock = Date.UTC(2026, 7, 21, 9, 0, 0, 0);
  const store = new FileCatalogStore({
    roots,
    ...(options.idSources === undefined ? {} : { idSources: options.idSources }),
    clock: () => new Date(clock),
  });
  await store.open();

  return {
    store,
    roots,
    catalogRoot,
    resultRoot,
    advance: (milliseconds) => {
      clock += milliseconds;
    },
    now: () => new Date(clock).toISOString(),
    dispose: () => rm(base, { recursive: true, force: true }),
  };
}

/**
 * The environment every fixture configuration runs in, resolved once.
 *
 * `environmentConfigForFormat` reads `content/formats` rather than the card pool,
 * so this is cheap — but it is the format's own construction rules rather than a
 * transcription of them, which is the same reason `expand.ts` gives for using it.
 */
const FIXTURE_ENVIRONMENT = environmentConfigForFormat('precon_wave_1', {
  label: 'Precon Wave 1, for a catalog fixture',
});

/**
 * The smallest experiment configuration a job can legally hold.
 *
 * A real one, parsed by `parseExperimentConfig`, because M08.4 makes a job's
 * configuration a thing the store writes, re-reads and re-validates: a fixture
 * the simulator would refuse would test the wrong file. It schedules one match,
 * and nothing in the catalog suites ever runs it.
 */
export function testConfig(
  overrides: { readonly id?: string; readonly seed?: string } = {},
): ExperimentConfig {
  return parseExperimentConfig({
    schemaVersion: 1,
    kind: 'batch',
    id: overrides.id ?? 'fixture-batch',
    seed: overrides.seed ?? 'fixture-seed',
    playerCount: 2,
    pilots: [{ id: 'aggressive' }],
    pilotPairing: 'mirror',
    environment: FIXTURE_ENVIRONMENT,
    decks: { kind: 'precon', preconIds: ['precon_bastion_guardians', 'precon_goblin_swarm'] },
    schedule: 'round_robin',
    gamesPerPairing: 1,
    mirrorSeats: false,
  });
}

/** A run identity that is legal, complete, and obviously a fixture. */
export function testIdentity(overrides: Record<string, unknown> = {}) {
  return {
    experimentId: 'precon-smoke',
    kind: 'batch' as const,
    seed: 'seed-1',
    configHash: 'abcdef0123456789',
    environments: [
      {
        environmentId: 'baseline',
        hashes: {
          mechanicsHash: '1111111111111111',
          pilotInputHash: '2222222222222222',
          presentationHash: '3333333333333333',
          fullContentHash: '4444444444444444',
        },
      },
    ],
    manifestSchemaVersion: 8,
    softwareCommit: '2b1a6ec',
    ...overrides,
  };
}
