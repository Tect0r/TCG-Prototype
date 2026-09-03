import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import * as barrel from './index.js';

/**
 * The guarantees ADR 0023 §1 makes about this package are guarantees about what
 * is *not* here, and a promise about absence rots quietly. These tests read the
 * package's own sources and its own manifest, so each promise fails when it
 * stops being true rather than when somebody notices.
 */

const SOURCE_DIR = import.meta.dirname;
const PACKAGE_ROOT = join(SOURCE_DIR, '..');
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');

interface SourceFile {
  readonly name: string;
  readonly text: string;
}

/**
 * A source file's *code*, with comments removed.
 *
 * The scans below look for capabilities this package must not have, and the
 * package's own documentation is full of the words that name them — it says it
 * spawns no process and holds catalog documents. Scanning the prose would make
 * every honest sentence about an exclusion into a violation of it, so the
 * comments come out first and what is left is what the module actually does.
 */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(): SourceFile[] {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: codeOf(readFileSync(join(SOURCE_DIR, name), 'utf8')) }));
}

function manifestOf(path: string): {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
} {
  return JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof manifestOf>;
}

describe('the package is schema-only', () => {
  it('has more than one source file, so the scans below mean something', () => {
    expect(sourceFiles().length).toBeGreaterThan(5);
  });

  it('imports no Node built-in at all', () => {
    // No filesystem access, no process spawning, no network. The production
    // sources are `zod`, `@tcg/shared` and each other.
    for (const file of sourceFiles()) {
      expect(file.text).not.toMatch(/from '(node:[a-z/]+)'/);
      expect(file.text).not.toMatch(/require\(/);
    }
  });

  it('names none of the capabilities the milestone excludes', () => {
    const forbidden = [
      'readFileSync',
      'writeFileSync',
      'readdirSync',
      'createServer',
      'listen(',
      'spawn',
      'execFile',
      'child_process',
      'fetch(',
      'XMLHttpRequest',
      'WebSocket',
    ];
    for (const file of sourceFiles()) {
      for (const capability of forbidden) {
        expect(`${file.name}: ${String(file.text.includes(capability))}`).toBe(
          `${file.name}: false`,
        );
      }
    }
  });

  it('renders nothing and imports no UI framework', () => {
    for (const file of sourceFiles()) {
      expect(file.text).not.toMatch(/from 'react/);
      expect(file.text).not.toMatch(/from 'react-dom/);
      expect(file.text).not.toContain('.tsx');
      expect(file.text).not.toMatch(/\b(?:document|window|navigator|localStorage)\s*\./);
    }
  });

  it('does not execute an experiment, or import anything that could', () => {
    for (const file of sourceFiles()) {
      expect(file.text).not.toContain("from '@tcg/simulator'");
      expect(file.text).not.toContain("from '@tcg/rules-engine'");
      expect(file.text).not.toContain("from '@tcg/deck-generator'");
      expect(file.text).not.toContain("from '@tcg/bot-interface'");
    }
  });
});

describe('the declared dependencies', () => {
  const manifest = manifestOf(join(PACKAGE_ROOT, 'package.json'));

  it('are exactly zod and the shared issue vocabulary', () => {
    expect(manifest.name).toBe('@tcg/admin-contracts');
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(['@tcg/shared', 'zod']);
    expect(manifest.devDependencies).toBeUndefined();
  });

  it('cover every workspace import the sources actually make', () => {
    const imported = new Set<string>();
    for (const file of sourceFiles()) {
      for (const match of file.text.matchAll(/from '(@tcg\/[a-z-]+)'/g)) {
        imported.add(match[1] as string);
      }
    }
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    for (const name of imported) expect([...declared]).toContain(name);
  });

  it('point at other packages only, never at an application', () => {
    // ADR 0001's direction: a `packages/*` workspace depends on packages. An
    // admin contract that imported `apps/simulator` would drag a worker pool
    // into the admin client's bundle.
    const appNames = readdirSync(join(REPO_ROOT, 'apps'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const bare = dependency.replace('@tcg/', '');
      expect(appNames).not.toContain(bare);
    }
  });

  it('creates no cycle: nothing this package depends on depends back on it', () => {
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (!dependency.startsWith('@tcg/')) continue;
      const other = manifestOf(
        join(REPO_ROOT, 'packages', dependency.replace('@tcg/', ''), 'package.json'),
      );
      expect(Object.keys(other.dependencies ?? {})).not.toContain('@tcg/admin-contracts');
    }
  });
});

describe('nothing admin is reachable from the player bundle', () => {
  it('is absent from the web client’s dependencies', () => {
    // A separate bundle is what makes "a player build cannot ship an admin
    // control" a fact rather than a guard that could be wrong.
    const client = manifestOf(join(REPO_ROOT, 'apps', 'web-client', 'package.json'));
    expect(Object.keys(client.dependencies ?? {})).not.toContain('@tcg/admin-contracts');
    expect(Object.keys(client.devDependencies ?? {})).not.toContain('@tcg/admin-contracts');
  });

  it('is absent from the live match server’s dependencies', () => {
    // ADR 0023 §1: the two never share an event loop, and M08's exclusions put
    // no simulator CPU work in the live multiplayer process.
    const server = manifestOf(join(REPO_ROOT, 'apps', 'multiplayer-server', 'package.json'));
    expect(Object.keys(server.dependencies ?? {})).not.toContain('@tcg/admin-contracts');
  });

  // `apps/multiplayer-server/src/boundary.test.ts` (M08.22A) asserts the
  // converse of this whole describe block — that the live match server
  // declares no dependency on this package — which means it has to write the
  // package name down. The scan below reads a mention rather than an import,
  // so the file is excluded here and checked, immediately after, to be a
  // refusal rather than an importer.
  const NAMED_BY_REFUSAL = join(REPO_ROOT, 'apps', 'multiplayer-server', 'src', 'boundary.test.ts');

  it('is imported by the admin workspaces and by nothing else', () => {
    // M08.1 could state this as "imported by nobody", because the applications
    // ADR 0023 §1 names did not exist yet. M08.2 built the first of them, so the
    // claim becomes the one that actually matters and will keep mattering: the
    // *only* importers are admin workspaces. A hit under `apps/web-client`,
    // `apps/multiplayer-server` or any package is what this exists to fail on.
    const ALLOWED = [join('apps', 'admin-server'), join('apps', 'admin-client')];
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        if (path.startsWith(PACKAGE_ROOT)) continue;
        if (path === NAMED_BY_REFUSAL) continue;
        if (!readFileSync(path, 'utf8').includes("'@tcg/admin-contracts'")) continue;
        const relative = path.slice(REPO_ROOT.length + 1);
        if (ALLOWED.some((allowed) => relative.startsWith(allowed))) continue;
        hits.push(relative);
      }
    };
    for (const root of ['packages', 'apps']) walk(join(REPO_ROOT, root));
    expect(hits).toEqual([]);
  });

  it('is imported by an admin workspace, so the allowance above is doing work', () => {
    // An allow-list that matched nothing would make the test above pass for the
    // wrong reason from the day the last importer was removed.
    const store = readFileSync(
      join(REPO_ROOT, 'apps', 'admin-server', 'src', 'catalog', 'file-catalog-store.ts'),
      'utf8',
    );
    expect(store).toContain("from '@tcg/admin-contracts'");
  });

  it('is named by that one exception only in order to forbid it', () => {
    // The scan above reads a *mention* rather than an import, so the honest
    // allowance is this one file plus a check that its mention really is a
    // refusal. A file that stopped refusing and started importing fails here.
    // The single-line regex only catches `import ... from '...'` on one line;
    // this second check requires an `import` keyword and the quoted specifier
    // to share a statement (no semicolon between them), which real import
    // syntax always does — including a prettier-wrapped multi-line import or
    // a dynamic `import('...')` — and this file's actual refusal calls never
    // do (verified: `import` never shares a statement with the quoted name).
    const text = readFileSync(NAMED_BY_REFUSAL, 'utf8');
    expect(text).toContain(`not.toContain('@tcg/admin-contracts')`);
    expect(text).not.toMatch(/^\s*import .*'@tcg\/admin-contracts'/m);
    expect(text).not.toMatch(/\bimport\b[^;]*?['"]@tcg\/admin-contracts['"]/);
  });
});

describe('the public barrel', () => {
  it('is the one deliberate entry point the manifest names', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      readonly exports: Readonly<Record<string, string>>;
      readonly main: string;
    };
    expect(Object.keys(manifest.exports)).toEqual(['.']);
    expect(manifest.exports['.']).toBe('./src/index.ts');
    expect(manifest.main).toBe('./src/index.ts');
  });

  it('exports something from every module the package has', () => {
    // A module nobody can import is a module that will drift.
    const modules = sourceFiles()
      .map((file) => file.name.replace(/\.ts$/, ''))
      .filter((name) => name !== 'index');
    const barrelText = readFileSync(join(SOURCE_DIR, 'index.ts'), 'utf8');
    for (const name of modules) expect(barrelText).toContain(`from './${name}.js'`);
  });

  it('exports every version constant, lifecycle model and builder a caller needs', () => {
    for (const name of [
      'ADMIN_CONTRACT_VERSION',
      'CATALOG_DOCUMENT_VERSION',
      'ADMIN_ERROR_CODES',
      'JOB_LIFECYCLE',
      'BATCH_LIFECYCLE',
      'JOB_STATUSES',
      'BATCH_STATUSES',
      'NO_PROGRESS',
      'NO_ANNOTATIONS',
      'NO_CATALOG_FILTER',
      'adminError',
      'refuseFutureVersion',
      'applyJobTransition',
      'applyBatchTransition',
      'catalogJobViewOf',
      'catalogBatchViewOf',
      'resultReferenceOf',
      'adminRequest',
      'adminResponse',
      'pageOf',
    ]) {
      expect(Object.keys(barrel)).toContain(name);
    }
  });

  it('exports every strict schema the package defines', () => {
    const defined = new Set<string>();
    for (const file of sourceFiles()) {
      if (file.name === 'index.ts') continue;
      for (const match of file.text.matchAll(/^export const (\w+Schema) =/gm)) {
        defined.add(match[1] as string);
      }
    }
    expect(defined.size).toBeGreaterThan(10);
    for (const name of defined) expect(Object.keys(barrel)).toContain(name);
  });

  it('leaks no internal helper the package did not mean to publish', () => {
    for (const name of Object.keys(barrel)) {
      expect(name.startsWith('_')).toBe(false);
    }
  });
});
