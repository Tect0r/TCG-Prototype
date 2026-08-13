import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_RULES_CONFIG } from '@tcg/rules-engine';
import {
  assertedText,
  checkCountClaims,
  checkDocumentedValues,
  checkMarkdownLinks,
  checkPathReferences,
  checkRetiredTerms,
  checkUnimplementedCards,
  headingAnchors,
  headingSlug,
  isActiveDocument,
  runConsistencyChecks,
  type MarkdownDocument,
} from './consistency.js';

/**
 * The consistency check's own guard (M07.7).
 *
 * Two halves, and both are load bearing. The **repository** half is the gate: a
 * document that starts teaching a retired rule, a link that stops resolving, a
 * dial that moves without its table moving, fails right here. The **planted**
 * half is what makes the first half worth anything — every check is handed
 * input it must reject, because a checker that has quietly stopped matching
 * reports a clean repository in exactly the same words as one that works.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** A one-document corpus, for a check that takes documents rather than a root. */
function doc(path: string, text: string): readonly MarkdownDocument[] {
  return [{ path, text }];
}

const temporaryRoots: string[] = [];

/** A throwaway repository root holding exactly the files a test writes. */
function fixtureRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'tcg-consistency-'));
  temporaryRoots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }
  return root;
}

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

/* -------------------------------------------------------------- the helpers */

describe('assertedText', () => {
  it('blanks a quoted or backticked mention but keeps the offsets', () => {
    const source = 'There is no `unitSlots` field and "unit slot" is retired.';
    const asserted = assertedText(source);

    expect(asserted).not.toContain('unitSlots');
    expect(asserted).not.toContain('unit slot');
    expect(asserted).toHaveLength(source.length);
    expect(asserted.indexOf('retired')).toBe(source.indexOf('retired'));
  });

  it('leaves an ordinary claim alone', () => {
    expect(assertedText('Each relic uses a unit slot.')).toContain('unit slot');
  });
});

describe('headingSlug', () => {
  it('matches the anchors GitHub generates', () => {
    expect(headingSlug('Decks and Commanders')).toBe('decks-and-commanders');
    // An em dash is dropped rather than hyphenated, so the gap it left doubles.
    expect(headingSlug('Match rules — provisional numbers')).toBe(
      'match-rules--provisional-numbers',
    );
    expect(headingSlug('`RulesConfig` **dials**')).toBe('rulesconfig-dials');
  });
});

describe('headingAnchors', () => {
  it('disambiguates repeated headings the way GitHub does', () => {
    const anchors = headingAnchors(['# Notes', '## Notes', '## Notes'].join('\n'));
    expect([...anchors].sort()).toEqual(['notes', 'notes-1', 'notes-2']);
  });

  it('ignores a heading inside a fenced code block', () => {
    const anchors = headingAnchors(['# Real', '```', '# Fake', '```'].join('\n'));
    expect(anchors.has('real')).toBe(true);
    expect(anchors.has('fake')).toBe(false);
  });
});

describe('isActiveDocument', () => {
  it('exempts the record and guards everything else', () => {
    expect(isActiveDocument('CLAUDE.md')).toBe(true);
    expect(isActiveDocument('docs/rules/confirmed-rules.md')).toBe(true);
    expect(isActiveDocument('docs/ADDING_CARDS.md')).toBe(true);

    expect(isActiveDocument('docs/architecture/0016-precon-wave-1-ruleset.md')).toBe(false);
    expect(isActiveDocument('docs/milestones/M07-documentation-consolidation.md')).toBe(false);
    expect(isActiveDocument('docs/history/milestone-log.md')).toBe(false);
    expect(isActiveDocument('docs/status-audit.md')).toBe(false);
  });
});

/* ------------------------------------------------------------ planted failures */

describe('checkRetiredTerms', () => {
  it('reports a retired term asserted by an active document', () => {
    const findings = checkRetiredTerms(doc('README.md', 'A relic does not use a unit slot.'));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.check).toBe('retired-term');
    expect(findings[0]?.message).toContain('unit slot');
    expect(findings[0]?.line).toBe(1);
  });

  it('allows a denial, which is the sentence the rulebook needs to print', () => {
    expect(checkRetiredTerms(doc('README.md', 'There is no recovery zone.'))).toEqual([]);
    expect(checkRetiredTerms(doc('README.md', 'There is no separate recovery zone.'))).toEqual([]);
  });

  it('does not read "not" as a denial that the thing exists', () => {
    expect(checkRetiredTerms(doc('README.md', 'It does not use a unit slot.'))).toHaveLength(1);
  });

  it('allows a quoted mention, so a document can discuss what it retired', () => {
    expect(checkRetiredTerms(doc('README.md', 'The old text said "unit slot".'))).toEqual([]);
    expect(checkRetiredTerms(doc('README.md', 'No `unitSlots` field exists.'))).toEqual([]);
  });

  it('leaves historical documents alone', () => {
    const historical = doc('docs/history/milestone-log.md', 'Units used a unit slot each.');
    expect(checkRetiredTerms(historical)).toEqual([]);
  });

  it('reports the line the term was on, not the line the file starts at', () => {
    const findings = checkRetiredTerms(doc('README.md', ['one', 'two', 'a unit slot'].join('\n')));
    expect(findings[0]?.line).toBe(3);
  });
});

describe('checkMarkdownLinks', () => {
  it('reports a link to a file that is not there', () => {
    const root = fixtureRoot({ 'README.md': '[gone](docs/missing.md)' });
    const { findings } = checkMarkdownLinks(root, doc('README.md', '[gone](docs/missing.md)'));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('docs/missing.md');
  });

  it('reports a link to an anchor the target has no heading for', () => {
    const root = fixtureRoot({
      'README.md': '[x](docs/a.md#nowhere)',
      'docs/a.md': '# Somewhere',
    });
    const { findings } = checkMarkdownLinks(root, doc('README.md', '[x](docs/a.md#nowhere)'));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('#nowhere');
  });

  it('accepts a resolving link, a same-file anchor and an external URL', () => {
    const root = fixtureRoot({
      'README.md': '[a](docs/a.md#somewhere) [b](#top) [c](https://example.com/x.md)',
      'docs/a.md': '# Somewhere',
    });
    const result = checkMarkdownLinks(
      root,
      doc('README.md', '# Top\n[a](docs/a.md#somewhere) [b](#top) [c](https://example.com/x.md)'),
    );

    expect(result.findings).toEqual([]);
    // The external link is skipped rather than counted as checked.
    expect(result.links).toBe(2);
  });
});

describe('checkPathReferences', () => {
  it('reports a backticked path that does not exist', () => {
    const root = fixtureRoot({ 'README.md': 'see `docs/gone.md`' });
    const { findings } = checkPathReferences(root, doc('README.md', 'see `docs/gone.md`'));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.check).toBe('path-reference');
  });

  it('does not mistake an issue code or a path template for a file', () => {
    const root = fixtureRoot({ 'README.md': 'x' });
    const text =
      'codes `content/unimplemented_card` and shapes `content/sets/<set>/cards/<id>.json`';
    const { findings, references } = checkPathReferences(root, doc('README.md', text));

    expect(findings).toEqual([]);
    expect(references).toBe(0);
  });

  it('ignores globs, package names and prose that merely contains a slash', () => {
    const root = fixtureRoot({ 'README.md': 'x' });
    const text = 'workspaces `packages/*`, the package `@tcg/card-data`, and `playtest`/`active`';
    const { findings, references } = checkPathReferences(root, doc('README.md', text));

    expect(findings).toEqual([]);
    expect(references).toBe(0);
  });
});

describe('checkDocumentedValues', () => {
  /** The provisional-numbers table, with one dial's value replaced. */
  function openDecisions(startingHealth: string, extra = ''): string {
    return [
      '# Provisional rules',
      '',
      '## Deck construction',
      '',
      '| Format | Size | Copies | Commander colours | Pool |',
      '| --- | --- | --- | --- | --- |',
      '| `precon_wave_1` | 40 | singleton (1 each ID) | 2 | `precon_wave_1` |',
      '',
      '## Match rules — provisional numbers',
      '',
      '| Value | Current | Field |',
      '| --- | --- | --- |',
      `| Starting health | ${startingHealth} | \`startingHealth\` |`,
      extra,
      '',
    ].join('\n');
  }

  it('reports a dial whose documented value is no longer the live one', () => {
    const root = fixtureRoot({ 'docs/rules/open-decisions.md': openDecisions('19') });
    const { findings } = checkDocumentedValues(root);

    const drift = findings.filter((entry) => entry.message.includes('startingHealth'));
    expect(drift).toHaveLength(1);
    expect(drift[0]?.message).toContain(String(DEFAULT_RULES_CONFIG.startingHealth));
  });

  it('accepts the live value and reports the dials with no row at all', () => {
    const root = fixtureRoot({
      'docs/rules/open-decisions.md': openDecisions(String(DEFAULT_RULES_CONFIG.startingHealth)),
    });
    const { findings } = checkDocumentedValues(root);

    expect(findings.filter((entry) => entry.message.includes('is "19"'))).toEqual([]);
    // Every other field of RulesConfig is missing from this cut-down table.
    expect(findings.some((entry) => entry.message.includes('has no row'))).toBe(true);
  });

  it('reports a field that is not on RulesConfig at all', () => {
    const root = fixtureRoot({
      'docs/rules/open-decisions.md': openDecisions(
        String(DEFAULT_RULES_CONFIG.startingHealth),
        '| Made up | 3 | `notARealDial` |',
      ),
    });
    const { findings } = checkDocumentedValues(root);

    expect(
      findings.some((entry) => entry.message.includes('`notARealDial`, which is not a field')),
    ).toBe(true);
  });

  it('reports a deck size that disagrees with the bundled format', () => {
    const root = fixtureRoot({
      'docs/rules/open-decisions.md': openDecisions(
        String(DEFAULT_RULES_CONFIG.startingHealth),
      ).replace('| `precon_wave_1` | 40 |', '| `precon_wave_1` | 41 |'),
    });
    const { findings } = checkDocumentedValues(root);

    expect(findings.some((entry) => entry.message.includes('41 cards'))).toBe(true);
  });
});

describe('checkCountClaims', () => {
  it('reports a card count that disagrees with the content', () => {
    const findings = checkCountClaims(
      doc('docs/testing/x.md', 'the 999-card Wave 1 batch'),
    ).findings;

    expect(findings).toHaveLength(1);
    expect(findings[0]?.check).toBe('count-claim');
  });

  it('reads a claim broken across a line, the way the document writes it', () => {
    const result = checkCountClaims(doc('docs/testing/x.md', 'the 999-card\n  Wave 1 set'));
    expect(result.claims).toBe(1);
    expect(result.findings).toHaveLength(1);
  });
});

/* --------------------------------------------------- this repository, right now */

describe('the repository', () => {
  const report = runConsistencyChecks(REPO_ROOT);

  it('has no inconsistency', () => {
    const detail = report.findings
      .map(
        (entry) => `${entry.file ?? 'code'}${entry.line ? `:${entry.line}` : ''} ${entry.message}`,
      )
      .join('\n');
    expect(report.findings, `\n${detail}`).toEqual([]);
  });

  it('actually looked at something, in every check that can match nothing', () => {
    expect(report.counts.documents).toBeGreaterThan(20);
    expect(report.counts.activeDocuments).toBeGreaterThan(0);
    expect(report.counts.links).toBeGreaterThan(100);
    expect(report.counts.pathReferences).toBeGreaterThan(0);
    expect(report.counts.documentedValues).toBeGreaterThan(0);
    expect(report.counts.countClaims).toBeGreaterThan(0);
  });

  it('ships no unimplemented card in a playable set', () => {
    expect(checkUnimplementedCards()).toEqual([]);
  });

  it('documents every RulesConfig dial', () => {
    const { findings } = checkDocumentedValues(REPO_ROOT);
    expect(findings.filter((entry) => entry.message.includes('has no row'))).toEqual([]);
  });
});
