import { describe, expect, it } from 'vitest';

import { configHashOf, parseExperimentConfig } from '@tcg/simulator';

import { testConfig } from '../catalog/test-catalog.js';
import { MAX_COPIES, duplicateConfig } from './duplicate.js';

/**
 * M08.9 — what a copy of a queued job actually is.
 *
 * The naive reading of *duplicate* is the dangerous one, and it is the reason
 * this module exists at all: an experiment's seed is what every shuffle,
 * mulligan and pilot decision derives from, so writing the same configuration
 * twice would put two identical run directories in the catalog. A later reader
 * would have two records that look like independent evidence and are one
 * measurement counted twice.
 */

describe('a copy is a replicate, not the same run twice', () => {
  it('derives a new experiment identity and a new seed family', () => {
    const source = testConfig({ id: 'bench', seed: 'august' });
    const copy = duplicateConfig(source, ['bench']);

    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    expect(copy.config.id).toBe('bench-c2');
    expect(copy.config.seed).toBe('august|c2');
  });

  it('changes the configuration hash, so the two are different runs to the simulator', () => {
    // The property that matters downstream. `configHash` is what a resumed
    // stream is checked against and what a manifest stamps, so two jobs whose
    // hashes differ cannot silently share a directory or a record.
    const source = testConfig({ id: 'bench', seed: 'august' });
    const copy = duplicateConfig(source, ['bench']);
    if (!copy.ok) throw new Error('refused');

    expect(configHashOf(copy.config)).not.toBe(configHashOf(source));
  });

  it('changes nothing else, because a queue control is not a builder', () => {
    const source = testConfig({ id: 'bench', seed: 'august' });
    const copy = duplicateConfig(source, ['bench']);
    if (!copy.ok) throw new Error('refused');

    // Re-parsed, because `duplicateConfig` returns the simulator's own parse of
    // the object it built and a comparison against an unparsed fixture would be
    // measuring which defaults zod filled in rather than what this module moved.
    const { id: _sourceId, seed: _sourceSeed, ...sourceRest } = parseExperimentConfig(source);
    const { id: _copyId, seed: _copySeed, ...copyRest } = copy.config;
    expect(copyRest).toEqual(sourceRest);
  });

  it('skips an ordinal a sibling already holds, so no two members collide', () => {
    const source = testConfig({ id: 'bench', seed: 'august' });
    const copy = duplicateConfig(source, ['bench', 'bench-c2', 'bench-c3']);
    if (!copy.ok) throw new Error('refused');

    expect(copy.config.id).toBe('bench-c4');
    expect(copy.config.seed).toBe('august|c4');
  });

  it('keeps numbering from the base when a copy is itself copied', () => {
    // Nesting would spell `bench-c2-c2`, run an ID into its 40-character ceiling
    // after four copies, and produce a seed family that no longer says which run
    // it descends from.
    const copyOfCopy = duplicateConfig(testConfig({ id: 'bench-c2', seed: 'august|c2' }), [
      'bench',
      'bench-c2',
    ]);
    if (!copyOfCopy.ok) throw new Error('refused');

    expect(copyOfCopy.config.id).toBe('bench-c3');
    expect(copyOfCopy.config.seed).toBe('august|c3');
  });

  it('keeps a long experiment ID inside the length its schema allows', () => {
    const long = 'a'.repeat(40);
    const copy = duplicateConfig(testConfig({ id: long, seed: 'august' }), [long]);
    if (!copy.ok) throw new Error('refused');

    expect(copy.config.id.length).toBeLessThanOrEqual(40);
    expect(copy.config.id.endsWith('-c2')).toBe(true);
  });

  it('refuses rather than looping when every ordinal is taken', () => {
    const taken = [
      'bench',
      ...Array.from({ length: MAX_COPIES }, (_, n) => `bench-c${String(n + 2)}`),
    ];
    const copy = duplicateConfig(testConfig({ id: 'bench', seed: 'august' }), taken);

    expect(copy.ok).toBe(false);
    if (copy.ok) return;
    expect(copy.problem.message).toContain('copies of that job');
  });
});
