import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLED_PRECONS } from '@tcg/card-data';
import {
  AUDIT_BANNER,
  collectAudit,
  derivedSectionOf,
  parseVitestList,
  renderAuditDocument,
  renderDerivedFacts,
  verifySteps,
  type AuditRun,
} from './status-audit.js';

/**
 * The audit's own guard (M07.1).
 *
 * The document is only worth having if it cannot quietly go stale, so the
 * load-bearing case here is the drift test: the derived half of the committed
 * `docs/status-audit.md` has to be byte-identical to what the collector produces
 * from today's code. A card added, a schema version bumped, a question answered
 * or an ADR written fails this test until the audit is regenerated, which is the
 * whole point of generating it.
 *
 * The run record above the marker is deliberately outside that comparison: it is
 * a measurement taken at one commit, and re-deriving it would mean running the
 * suite from inside the suite.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const AUDIT_PATH = join(REPO_ROOT, 'docs', 'status-audit.md');

describe('parseVitestList', () => {
  it('counts cases and distinct files per project', () => {
    const totals = parseVitestList(
      [
        '',
        '> tcg-prototype@0.1.0 test',
        '[packages] packages/deck/src/validate.test.ts > validateDeck > refuses a short deck',
        '[packages] packages/deck/src/validate.test.ts > validateDeck > accepts a legal deck',
        '[packages] packages/deck/src/precon.test.ts > reviewPrecon > refuses another format',
        '[scripts] scripts/lib/card-scaffold.test.ts > scaffold > writes a card',
      ].join('\n'),
    );

    expect(totals.projects).toEqual([
      { project: 'packages', files: 2, tests: 3 },
      { project: 'scripts', files: 1, tests: 1 },
    ]);
    expect(totals.files).toBe(3);
    expect(totals.tests).toBe(4);
  });

  it('ignores lines that are not a listed case', () => {
    const totals = parseVitestList('RUN v3.2.4\n[packages] not-a-case-line\n\n');
    expect(totals.tests).toBe(0);
    expect(totals.projects).toEqual([]);
  });
});

describe('verifySteps', () => {
  it('reads the chain off the script rather than a written list', () => {
    const steps = verifySteps(
      JSON.stringify({ scripts: { verify: 'npm run typecheck && npm run test  ' } }),
    );
    expect(steps).toEqual(['npm run typecheck', 'npm run test']);
  });

  it('returns nothing when there is no verify script', () => {
    expect(verifySteps(JSON.stringify({ scripts: {} }))).toEqual([]);
  });

  it("describes this repository's real chain", () => {
    const steps = verifySteps(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(steps).toContain('npm run test');
    expect(steps[0]).toBe('npm run content:check');
  });
});

describe('collectAudit', () => {
  const facts = collectAudit(REPO_ROOT);

  it('reads every bundled precon and reviews it the way the server does', () => {
    expect(facts.precons).toHaveLength(BUNDLED_PRECONS.length);
    expect(facts.precons.filter((precon) => !precon.legal)).toEqual([]);
  });

  it('counts behaviour contracts against the set they cover', () => {
    expect(facts.coverage.contracts).toBe(facts.coverage.contractSetCards);
    expect(facts.coverage.contracts).toBeGreaterThan(0);
  });

  it('splits a set into playable cards and tokens rather than reporting one total', () => {
    const wave1 = facts.sets.find((set) => set.setId === 'precon_wave_1');
    expect(wave1).toBeDefined();
    expect(wave1?.tokens).toBeGreaterThan(0);
    expect(wave1?.unimplemented).toBe(0);
  });

  it('reports only the contradicting direction as a contradiction', () => {
    for (const contradiction of facts.questions.contradictions) {
      expect(contradiction).toMatch(/^Q\d+ is listed open in/);
    }
    // A question open in the file and absent from the plan's curated short list
    // is ordinary, and must not be counted as the plan contradicting anything.
    expect(facts.questions.openNotListed).toBeGreaterThan(0);
    expect(facts.questions.contradictions.length).toBeLessThan(facts.questions.openNotListed);
    // Every row came from one of the two documents, so it must be in one.
    for (const row of facts.questions.rows) {
      expect(row.inQuestions !== 'absent' || row.inPlan).toBe(true);
    }
  });
});

describe('the written audit', () => {
  it('carries the generated banner and both markers', () => {
    const written = readFileSync(AUDIT_PATH, 'utf8');
    expect(written).toContain(AUDIT_BANNER);
    expect(derivedSectionOf(written)).not.toBeNull();
  });

  it('still describes the code it was generated from', () => {
    const written = derivedSectionOf(readFileSync(AUDIT_PATH, 'utf8'));
    expect(
      written,
      '`docs/status-audit.md` is stale. Run `npm run audit:status` and commit the result.',
    ).toBe(renderDerivedFacts(collectAudit(REPO_ROOT)));
  });

  it('keeps the run record out of the compared half', () => {
    const run: AuditRun = {
      commit: '0'.repeat(40),
      treeClean: true,
      takenOn: '2026-01-01',
      nodeVersion: 'v24.0.0',
      verify: 'not_run',
      verifySteps: ['npm run test'],
      tests: { projects: [{ project: 'packages', files: 1, tests: 2 }], files: 1, tests: 2 },
    };
    const document = renderAuditDocument(collectAudit(REPO_ROOT), run);

    expect(document).toContain('0'.repeat(40));
    expect(derivedSectionOf(document)).not.toContain('0'.repeat(40));
  });
});
