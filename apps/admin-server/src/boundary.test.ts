import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as barrel from './index.js';

/**
 * The boundaries ADR 0023 draws around the admin process, checked against the
 * sources and the manifests rather than promised in prose.
 *
 * Every claim here is about something that is **absent**, and a promise about
 * absence rots quietly: it stays true until the first commit that needs the
 * thing, and nothing fails at that moment. So these read the files, the same way
 * `@tcg/admin-contracts` keeps its own guarantees honest.
 *
 * Three of them are the milestone's exclusions in executable form — no simulator
 * process, no HTTP API, no shell — and one is the rule that outlives M08
 * entirely: **nothing admin may be reachable from the player bundle or from the
 * live match server.**
 */

const SOURCE_ROOT = import.meta.dirname;
const PACKAGE_ROOT = join(SOURCE_ROOT, '..');
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');

interface SourceFile {
  readonly name: string;
  readonly text: string;
}

/** A source file's code, with comments removed — the same reason the contracts package gives. */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts')) continue;
      if (entry.name.endsWith('.test.ts')) continue;
      // The test fixture builder is test-only scaffolding, not shipped behaviour.
      if (entry.name === 'test-catalog.ts') continue;
      files.push({ name: entry.name, text: codeOf(readFileSync(path, 'utf8')) });
    }
  };
  walk(SOURCE_ROOT);
  return files;
}

function manifestOf(path: string): {
  readonly name: string;
  readonly scripts?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
} {
  return JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof manifestOf>;
}

const MANIFEST = manifestOf(join(PACKAGE_ROOT, 'package.json'));

/** The one module M08.4 lets call the simulator's experiment runner. */
const RUNNER = 'job-runner.ts';

describe('the store runs one experiment, through exactly one door', () => {
  it('has enough sources for the scans below to mean something', () => {
    expect(sourceFiles().length).toBeGreaterThan(4);
  });

  it('imports the simulator as a library and never the engine beside it', () => {
    // M08.3 is where `@tcg/simulator` arrives: ADR 0023 §2 puts the estimator
    // behind `buildSchedule` and the preset expansion behind
    // `experimentConfigSchema`, so an admin layer that avoided the dependency
    // could only get there by writing a second scheduler. M08.2 predicted M08.4
    // would add it; this is the correction, and the exclusion that survives it is
    // the one below — nothing here *runs* a match.
    //
    // Everything else stays out. Reaching past the simulator into the engine, the
    // generator or the play protocol would be this workspace acquiring an opinion
    // about rules, deck legality or the wire, each of which has exactly one owner.
    for (const file of sourceFiles()) {
      for (const forbidden of [
        "from '@tcg/rules-engine'",
        "from '@tcg/deck-generator'",
        "from '@tcg/bot-interface'",
        "from '@tcg/protocol'",
        "from '@tcg/bot-config'",
        "from '@tcg/card-data'",
      ]) {
        expect(`${file.name}: ${forbidden}: ${String(file.text.includes(forbidden))}`).toBe(
          `${file.name}: ${forbidden}: false`,
        );
      }
    }
  });

  it('reaches the simulator’s experiment runner from one file and no other', () => {
    // M08.4 is the tranche that gets to run something, and this is the shape of
    // the permission: `runExperiment` is reachable from the job runner, which is
    // the bridge from a catalog job to a canonical experiment directory. Nowhere
    // else — a store, an estimator or a preset expansion that could start a run
    // would be four places able to consume a machine instead of one.
    for (const file of sourceFiles()) {
      const allowed = file.name === RUNNER;
      expect(`${file.name}: ${String(file.text.includes('runExperiment'))}`).toBe(
        `${file.name}: ${String(allowed)}`,
      );
    }
  });

  it('still imports no simulator entry point below the experiment runner', () => {
    // Scheduling, configuring and reading a directory are library calls.
    // `runExperiment` composes the rest — the batch runner, the match runner, the
    // search and the worker pool — and reaching past it to any of those would be
    // this workspace assembling a run rather than asking for one, which is the
    // second scheduler ADR 0023 §2 forbids wearing a different hat.
    for (const file of sourceFiles()) {
      for (const forbidden of [
        'runBatch',
        'runMatch',
        'runSearch',
        'runOne',
        'runJobsInPool',
        'TelemetryCollector',
      ]) {
        expect(`${file.name}: ${forbidden}: ${String(file.text.includes(forbidden))}`).toBe(
          `${file.name}: ${forbidden}: false`,
        );
      }
    }
  });

  it('defaults the runner to the simulator’s own function, so the seam is a test seam', () => {
    // `ExperimentRunnerOptions.runExperiment` exists so a test can drive a real
    // failure through the real bridge. It would be worth nothing if the default
    // were anything but the simulator's, so the default is named here.
    expect(barrel.ExperimentRunner.name).toBe('ExperimentRunner');
    const runner = codeOf(readFileSync(join(SOURCE_ROOT, 'run', RUNNER), 'utf8'));
    expect(runner).toContain('runExperiment as runExperimentDirectly');
    expect(runner).toContain("} from '@tcg/simulator';");
    expect(runner).toContain('options.runExperiment ?? runExperimentDirectly');
  });

  it('takes its notion of a deliberate stop from the simulator too (M08.5)', () => {
    // A stop is a *simulator* outcome: `runExperiment` unwinds with
    // `ExperimentStopped` before it writes a manifest, and this workspace has to
    // tell that apart from a run that fell over. Recognising it by message, by
    // name string, or by a locally declared class would all be this layer
    // guessing at another package's control flow — and would go on compiling
    // long after the simulator renamed it.
    const runner = codeOf(readFileSync(join(SOURCE_ROOT, 'run', RUNNER), 'utf8'));
    expect(runner).toContain('isExperimentStopped');
    expect(runner).toContain('isExperimentStopped(cause)');
    for (const file of sourceFiles()) {
      expect(`${file.name}: ${String(file.text.includes('class ExperimentStopped'))}`).toBe(
        `${file.name}: false`,
      );
    }
  });

  it('reaches a run through the one runner, from the queue as from anywhere else', () => {
    // M08.5 adds the first caller of `ExperimentRunner` that is not a test.
    // `JobQueue` takes one rather than building one, so the one-door property
    // above is a fact about what this file *has* rather than about what it
    // happens not to use: a queue holding the runner's own seams — its result
    // root, its poll interval, its injectable function — could open a second
    // door without ever naming the simulator.
    const queue = codeOf(readFileSync(join(SOURCE_ROOT, 'run', 'queue.ts'), 'utf8'));
    expect(queue).toContain("import type { ExperimentRunner } from './job-runner.js';");
    expect(queue).toContain('readonly runner: ExperimentRunner;');
    expect(queue).not.toContain('new ExperimentRunner');
  });

  it('spawns nothing and invokes no shell', () => {
    // ADR 0023 §2: where a child process is genuinely required it gets a fixed
    // executable and a fixed argument vector. M08.4 requires none at all — the
    // simulator is a library and is called as one — and "the admin service cannot
    // execute arbitrary commands" is a structural fact only while there is
    // nothing here that could.
    for (const file of sourceFiles()) {
      for (const capability of ['child_process', 'spawn', 'execFile', 'execSync', 'exec(']) {
        expect(`${file.name}: ${capability}: ${String(file.text.includes(capability))}`).toBe(
          `${file.name}: ${capability}: false`,
        );
      }
    }
  });

  it('crosses one process boundary, and it has no argument vector to build', () => {
    // The one place a run becomes more than one process is `@tcg/simulator`'s
    // worker pool, underneath `runExperiment`. What ADR 0023 §2 asks for is that
    // nothing an administrator supplies can reach a command line, and the reason
    // that holds is stronger than care: there is no command line. The pool starts
    // a *fixed module* — a URL relative to its own source — with no `argv` at
    // all, and the job payload travels as a structured message rather than as
    // text a shell would parse.
    const pool = codeOf(
      readFileSync(join(REPO_ROOT, 'apps', 'simulator', 'src', 'workers', 'pool.ts'), 'utf8'),
    );
    expect(pool).toContain("import { Worker } from 'node:worker_threads'");
    expect(pool).toContain("new URL('./bootstrap.mjs', import.meta.url)");
    expect(pool).toContain('new Worker(bootstrap, { workerData: options.setup })');
    for (const capability of ['child_process', 'execFile', 'execSync', 'exec(', 'shell', 'argv']) {
      expect(`pool.ts: ${capability}: ${String(pool.includes(capability))}`).toBe(
        `pool.ts: ${capability}: false`,
      );
    }
  });
});

describe('the store opens no port', () => {
  it('imports no server or socket module', () => {
    // M08.2's exclusion is "no HTTP API". M08.6 owns the boundary, the loopback
    // default and the non-loopback authentication refusal.
    for (const file of sourceFiles()) {
      for (const forbidden of [
        "'node:http'",
        "'node:https'",
        "'node:net'",
        "'node:tls'",
        "'ws'",
        'createServer',
        'WebSocket',
        'fetch(',
      ]) {
        expect(`${file.name}: ${forbidden}: ${String(file.text.includes(forbidden))}`).toBe(
          `${file.name}: ${forbidden}: false`,
        );
      }
    }
  });

  it('declares no start script, because there is nothing to start yet', () => {
    // An entry point that bound nothing and ran nothing would be the decorative
    // scaffolding the milestone warns against. M08.6 adds one when it has a
    // reason to.
    expect(Object.keys(MANIFEST.scripts ?? {})).toEqual(['typecheck']);
  });

  it('renders nothing and imports no UI framework', () => {
    // The DOM check names members rather than the bare global `document`: a
    // catalog *document* is this store's central noun, and a scan that read
    // every mention of it as a browser API would have to be either wrong or
    // switched off.
    for (const file of sourceFiles()) {
      expect(file.text).not.toMatch(/from 'react/);
      expect(file.text).not.toContain('.tsx');
      expect(file.text).not.toMatch(/\b(?:window|localStorage|navigator)\s*\./);
      expect(file.text).not.toMatch(
        /\bdocument\s*\.(?:getElementById|querySelector|createElement|body|head|addEventListener)\b/,
      );
    }
  });
});

describe('the declared dependencies', () => {
  it('are exactly the admin contract, the shared vocabulary, the simulator and zod', () => {
    expect(MANIFEST.name).toBe('@tcg/admin-server');
    expect(Object.keys(MANIFEST.dependencies ?? {}).sort()).toEqual([
      '@tcg/admin-contracts',
      '@tcg/shared',
      '@tcg/simulator',
      'zod',
    ]);
    expect(MANIFEST.devDependencies).toBeUndefined();
  });

  it('cover every workspace import the sources actually make', () => {
    const imported = new Set<string>();
    for (const file of sourceFiles()) {
      for (const match of file.text.matchAll(/from '(@tcg\/[a-z-]+)'/g)) {
        imported.add(match[1] as string);
      }
    }
    const declared = new Set(Object.keys(MANIFEST.dependencies ?? {}));
    for (const name of imported) expect([...declared]).toContain(name);
  });

  it('creates no cycle back into the contract package', () => {
    const contracts = manifestOf(join(REPO_ROOT, 'packages', 'admin-contracts', 'package.json'));
    expect(Object.keys(contracts.dependencies ?? {})).not.toContain('@tcg/admin-server');
  });
});

describe('nothing admin is reachable from the player bundle or the live match server', () => {
  it('is absent from the web client’s dependencies', () => {
    const client = manifestOf(join(REPO_ROOT, 'apps', 'web-client', 'package.json'));
    for (const set of [client.dependencies, client.devDependencies]) {
      expect(Object.keys(set ?? {})).not.toContain('@tcg/admin-server');
      expect(Object.keys(set ?? {})).not.toContain('@tcg/admin-contracts');
    }
  });

  it('is absent from the live match server’s dependencies', () => {
    // ADR 0023 §1: the two never share an event loop, and M08 excludes simulator
    // CPU work from the live multiplayer process entirely.
    const server = manifestOf(join(REPO_ROOT, 'apps', 'multiplayer-server', 'package.json'));
    expect(Object.keys(server.dependencies ?? {})).not.toContain('@tcg/admin-server');
    expect(Object.keys(server.dependencies ?? {})).not.toContain('@tcg/admin-contracts');
  });

  it('is imported by no source outside this workspace', () => {
    const hits: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        if (path.startsWith(PACKAGE_ROOT)) continue;
        if (readFileSync(path, 'utf8').includes("'@tcg/admin-server'")) hits.push(path);
      }
    };
    for (const root of ['packages', 'apps']) walk(join(REPO_ROOT, root));
    expect(hits).toEqual([]);
  });
});

describe('the public barrel', () => {
  it('is the one entry point the manifest names', () => {
    expect(MANIFEST.name).toBe('@tcg/admin-server');
    const raw = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      readonly exports: Readonly<Record<string, string>>;
      readonly main: string;
    };
    expect(Object.keys(raw.exports)).toEqual(['.']);
    expect(raw.main).toBe('./src/index.ts');
  });

  it('exports the store, its interface and the boundary helpers', () => {
    for (const name of [
      'FileCatalogStore',
      'openFileCatalogStore',
      'resolveCatalogRoots',
      'resolveResultLocation',
      'encodeCursor',
      'decodeCursor',
      'writeJsonAtomically',
      'readJsonLines',
      'readDocument',
      'KeyedMutex',
      'expandPreset',
      'estimatePreset',
      'estimateExperiment',
      'estimateConfig',
      'forcedInclusionFor',
      'deckCountFor',
      'ExperimentRunner',
      'JobQueue',
      'JobStopControl',
      'settleActionFor',
      'parseResourceLimits',
      'grantWorkers',
      'DEFAULT_RESOURCE_LIMITS',
      'readCanonicalProgress',
      'countCommittedRecords',
      'readRunIdentity',
    ]) {
      expect(Object.keys(barrel)).toContain(name);
    }
  });

  it('exports no fixture builder, so test scaffolding cannot become an API', () => {
    for (const name of ['makeTestCatalog', 'sequentialIdSources', 'testIdentity']) {
      expect(Object.keys(barrel)).not.toContain(name);
    }
  });
});

describe('no play-contract or artifact version is reachable from here', () => {
  it('names none of them in its own sources', () => {
    // M08.2 adds no message to the play wire, no field to a serialized match, no
    // rule and no card. The catalog *records* a manifest version a run was
    // written with, which is reading a number rather than owning one.
    for (const file of sourceFiles()) {
      // M08.4 does not weaken this. It reads a manifest's `schemaVersion` field
      // and writes the number down; reading a number is not owning one, and the
      // constant that decides it stays the simulator's.
      for (const constant of [
        'PROTOCOL_VERSION',
        'MATCH_SCHEMA_VERSION',
        'RULES_VERSION',
        'CARD_SCHEMA_VERSION',
        'MANIFEST_SCHEMA_VERSION',
        'SUMMARY_SCHEMA_VERSION',
        'REPORT_SCHEMA_VERSION',
      ]) {
        expect(`${file.name}: ${constant}: ${String(file.text.includes(constant))}`).toBe(
          `${file.name}: ${constant}: false`,
        );
      }
    }
  });
});
