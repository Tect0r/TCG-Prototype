import { EXPERIMENT_KINDS, SOURCE_CLASSES } from '@tcg/admin-contracts';
import { describe, expect, it } from 'vitest';

import {
  EXPERIMENT_KIND_LABELS,
  LABELLED_VOCABULARIES,
  SOURCE_CLASS_LABELS,
  formatBytes,
  formatUptime,
  formatWindow,
  labelledList,
} from './vocabulary.js';

/**
 * The wording, checked against the contract's own enumerations.
 *
 * The compiler already refuses a `Record` with a member missing; this suite is
 * what survives somebody widening one of those types, and it is also what fails
 * on the day a seventh source class arrives — which is the moment a screen would
 * otherwise start printing `adaptive_v2` at an administrator.
 */

describe('every closed vocabulary has a label', () => {
  for (const [name, vocabulary] of Object.entries(LABELLED_VOCABULARIES)) {
    it(`is total over ${name}`, () => {
      const labels = vocabulary.labels as Readonly<Record<string, string>>;
      expect(Object.keys(labels).sort()).toEqual([...vocabulary.members].sort());
      for (const member of vocabulary.members) {
        expect(labels[member]).toBeTruthy();
        // A label is prose, not the token again: printing `open_meta_search` at
        // an operator is the same as having no label.
        expect(labels[member]).not.toBe(member);
      }
    });
  }

  it('covers the six evidence classes M08 keeps distinguishable', () => {
    expect([...SOURCE_CLASSES]).toEqual(['ai', 'human', 'mixed', 'precon', 'search', 'adaptive']);
    for (const member of SOURCE_CLASSES) expect(SOURCE_CLASS_LABELS[member]).toBeTruthy();
  });

  it('says outright that a reserved preset cannot be scheduled by this build', () => {
    expect(LABELLED_VOCABULARIES.presetStatus.labels.reserved).toContain('cannot');
  });
});

describe('a list of labels', () => {
  it('is the labels, in the order the record gave them', () => {
    expect(labelledList(['ai', 'precon'], SOURCE_CLASS_LABELS)).toBe('AI, Precon');
  });

  it('is an em dash when there are none, so "none" is not an empty cell', () => {
    expect(labelledList([...EXPERIMENT_KINDS].slice(0, 0), EXPERIMENT_KIND_LABELS)).toBe('—');
  });
});

describe('numbers a person has to compare something against', () => {
  it('keep the exact byte count beside the readable one', () => {
    expect(formatBytes(900)).toBe('900 bytes');
    expect(formatBytes(131_072)).toBe('128 KiB (131072 bytes)');
    expect(formatBytes(2_097_152)).toBe('2 MiB (2097152 bytes)');
  });

  it('print a window in seconds when it divides evenly, and in milliseconds when it does not', () => {
    expect(formatWindow(60_000)).toBe('60 seconds');
    expect(formatWindow(1000)).toBe('1 second');
    expect(formatWindow(1500)).toBe('1500 ms');
  });
});

describe('how long the process has been up', () => {
  it('is measured from the reading, not from now', () => {
    expect(formatUptime('2026-08-24T09:00:00.000Z', '2026-08-24T09:00:45.000Z')).toBe('45 seconds');
    expect(formatUptime('2026-08-24T09:00:00.000Z', '2026-08-24T09:30:00.000Z')).toBe('30 minutes');
    expect(formatUptime('2026-08-24T09:00:00.000Z', '2026-08-24T14:00:00.000Z')).toBe('5 hours');
    expect(formatUptime('2026-08-20T09:00:00.000Z', '2026-08-24T09:00:00.000Z')).toBe('4 days');
  });

  it('says so rather than guessing when the two instants make no sense together', () => {
    // A clock that moved, or a start time from the future. "unknown" is the
    // honest answer; a negative duration would be a number somebody reads.
    expect(formatUptime('2026-08-24T10:00:00.000Z', '2026-08-24T09:00:00.000Z')).toBe('unknown');
    expect(formatUptime('not a timestamp', '2026-08-24T09:00:00.000Z')).toBe('unknown');
  });
});
