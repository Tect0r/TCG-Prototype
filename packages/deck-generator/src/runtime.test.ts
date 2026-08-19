import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DECK_GENERATOR_VERSION,
  NODE_BUILTIN_DEPENDENCIES,
  SUPPORTED_RUNTIMES,
  runtimeIsSupported,
} from './version.js';
import { GENERATION_PROBLEM_CODES } from './generate.js';

/**
 * M09.8 asks this package to *state* its supported environments rather than
 * imply them, and to answer the `node:crypto` question rather than leave it
 * open. A statement in a comment would rot; these tests read the package's own
 * sources, so the statement fails when it stops being true.
 */

const SOURCE_DIR = import.meta.dirname;

function sourceFiles(): { readonly name: string; readonly text: string }[] {
  return readdirSync(SOURCE_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: readFileSync(join(SOURCE_DIR, name), 'utf8') }));
}

describe('the declared runtime', () => {
  it('is Node, and says so in one place', () => {
    expect(SUPPORTED_RUNTIMES).toEqual(['node']);
    expect(runtimeIsSupported()).toBe(true);
  });

  it('imports no Node built-in it has not declared', () => {
    const found = new Set<string>();
    for (const file of sourceFiles()) {
      for (const match of file.text.matchAll(/from '(node:[a-z/]+)'/g)) {
        found.add(match[1] as string);
      }
    }
    expect([...found].sort()).toEqual([...NODE_BUILTIN_DEPENDENCIES].sort());
  });

  it('answers the node:crypto question rather than leaving it implied', () => {
    // The dependency is real and is why the package is server-only. If it ever
    // leaves, the declaration above has to move with it deliberately.
    expect(NODE_BUILTIN_DEPENDENCIES).toContain('node:crypto');
    const hash = sourceFiles().find((file) => file.name === 'hash.ts');
    expect(hash?.text).toMatch(/from 'node:crypto'/);
  });

  it('declares a generator version a recorded deck can cite', () => {
    // `generatedDeckProvenanceSchema.generatorVersion` in `@tcg/bot-config` is a
    // string of 1-32 characters; a version that cannot be recorded is not one.
    expect(typeof DECK_GENERATOR_VERSION).toBe('string');
    expect(DECK_GENERATOR_VERSION.length).toBeGreaterThan(0);
    expect(DECK_GENERATOR_VERSION.length).toBeLessThanOrEqual(32);
  });
});

describe('the generation problem registry', () => {
  it('names every problem code the package can emit', () => {
    const found = new Set<string>();
    for (const file of sourceFiles()) {
      for (const match of file.text.matchAll(/'(sim\/[a-z_]+)'/g)) found.add(match[1] as string);
    }
    expect([...found].sort()).toEqual([...GENERATION_PROBLEM_CODES].sort());
  });

  it('has no duplicates', () => {
    expect(new Set(GENERATION_PROBLEM_CODES).size).toBe(GENERATION_PROBLEM_CODES.length);
  });
});
