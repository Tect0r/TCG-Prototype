import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * M08.22A's own half of ADR 0023 §1: "the two never share an event loop... M08
 * excludes simulator CPU work from the live multiplayer process entirely."
 * `apps/admin-server/src/boundary.test.ts` already proves the admin process
 * cannot reach this workspace; this file proves the converse from here — the
 * live match server declares no dependency on, and no source imports,
 * simulator-grade work.
 *
 * A promise about absence rots quietly, so this reads the manifest and the
 * sources rather than asserting a sentence.
 */

const SOURCE_ROOT = import.meta.dirname;
const PACKAGE_ROOT = join(SOURCE_ROOT, '..');
const REPO_ROOT = join(PACKAGE_ROOT, '..', '..');

interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

function manifestOf(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

const MANIFEST = manifestOf(join(PACKAGE_ROOT, 'package.json'));

/** Every non-test `.ts` source in this workspace, with comments stripped. */
function sourceFiles(): { readonly name: string; readonly text: string }[] {
  const files: { name: string; text: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const text = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      files.push({ name: entry.name, text });
    }
  };
  walk(SOURCE_ROOT);
  return files;
}

describe('no simulator-grade work in the live event loop', () => {
  it('declares no dependency on the simulator, the admin process or its contracts', () => {
    expect(MANIFEST.name).toBe('@tcg/multiplayer-server');
    for (const set of [MANIFEST.dependencies, MANIFEST.devDependencies]) {
      expect(Object.keys(set ?? {})).not.toContain('@tcg/simulator');
      expect(Object.keys(set ?? {})).not.toContain('@tcg/admin-server');
      expect(Object.keys(set ?? {})).not.toContain('@tcg/admin-contracts');
    }
  });

  it('imports none of them from any source file', () => {
    for (const file of sourceFiles()) {
      expect(file.text, file.name).not.toMatch(/from ['"]@tcg\/simulator['"]/);
      expect(file.text, file.name).not.toMatch(/from ['"]@tcg\/admin-server['"]/);
      expect(file.text, file.name).not.toMatch(/from ['"]@tcg\/admin-contracts['"]/);
    }
  });

  it('is itself absent from the simulator’s dependencies', () => {
    const simulator = manifestOf(join(REPO_ROOT, 'apps', 'simulator', 'package.json'));
    expect(Object.keys(simulator.dependencies ?? {})).not.toContain('@tcg/multiplayer-server');
  });
});
