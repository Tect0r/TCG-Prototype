import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  batchIdSchema,
  comparisonAnnotationIdSchema,
  jobIdSchema,
  savedChoiceIdSchema,
} from '@tcg/admin-contracts';
import { describe, expect, it } from 'vitest';

/**
 * M08.28B's own acceptance evidence for "bound every retained artifact and
 * export path … deletion safe or absent"
 * (`docs/milestones/M08-ai-lab-and-player-meta.md`).
 *
 * ADR 0023 §5 already states the rule this file locks in — *a request never
 * names a filesystem path; the resolved real path is checked to be inside
 * its configured root* — and §3 already states the standing deletion
 * preference. Both were true when written and neither has an executable
 * check of its own for the catalog surfaces added since (`saved-choices`
 * M08.8, `comparison-annotations` M08.27E): a promise about absence rots
 * quietly, the same reason `boundary.test.ts` gives for checking every claim
 * there against the sources rather than trusting prose.
 *
 * `apps/admin-server/src/catalog/roots.test.ts` already exercises the
 * symlink-aware `resolveResultLocation` check directly; that mechanism only
 * matters where an *untrusted* path segment could be appended, which is
 * every result read (a run's own directory, named by a stored `rootId` and
 * relative directory) and none of the checks below duplicate it. What this
 * file adds is the property that mechanism depends on for the catalog root:
 * a document path is never anything but `<catalogRoot>/<fixed subdir>/<id>.json`,
 * and the `id` is minted from an alphabet a traversal cannot be built from —
 * so there is no untrusted segment for a catalog document to escape with in
 * the first place.
 */

const SOURCE_ROOT = import.meta.dirname;

interface SourceFile {
  readonly name: string;
  readonly text: string;
}

/** A source file's code, with comments removed — same convention as `boundary.test.ts`. */
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
      if (entry.name === 'test-catalog.ts') continue;
      files.push({ name: entry.name, text: codeOf(readFileSync(path, 'utf8')) });
    }
  };
  walk(SOURCE_ROOT);
  return files;
}

describe('every retained artifact stays inside a configured root (M08.28B)', () => {
  it('has enough sources for the scans below to mean something', () => {
    expect(sourceFiles().length).toBeGreaterThan(4);
  });

  it('mints every catalog document ID from an alphabet no traversal can be built from', () => {
    // `identity.ts`'s own claim: a minted ID is its prefix, an underscore,
    // then `[a-z0-9]{6,40}` — no `.`, `/`, `\`, `..` and no uppercase (a
    // second way to collide on a case-insensitive filesystem). This is the
    // cross-check that claim still holds for every ID a catalog document
    // path is built from, so a future loosening of one schema fails here
    // rather than only in a fuzz test nobody runs.
    for (const schema of [
      batchIdSchema,
      jobIdSchema,
      savedChoiceIdSchema,
      comparisonAnnotationIdSchema,
    ]) {
      for (const unsafe of [
        '../etc/passwd',
        'a/b',
        'a\\b',
        'a/../../b',
        'UPPERCASE123',
        '..',
        '.',
      ]) {
        expect(schema.safeParse(unsafe).success).toBe(false);
      }
    }
  });

  it('builds every catalog document directory from the resolved catalog root alone', () => {
    // `file-catalog-store.ts` assigns six private `#___Dir` fields exactly
    // once, in its constructor, and `documentPath`/`join` calls elsewhere in
    // the file only ever compose onto one of those six — never a method
    // argument. Each assignment must read `options.roots.catalogRoot`,
    // proving a document's directory can never come from anywhere else.
    const store = sourceFiles().find((file) => file.name === 'file-catalog-store.ts');
    expect(store).toBeDefined();
    const assignments = [...store!.text.matchAll(/this\.(#\w+Dir)\s*=\s*([^;]+);/g)];
    expect(assignments.length).toBeGreaterThanOrEqual(6);
    for (const [, field, expression] of assignments) {
      expect(`${field}: ${expression}`).toContain('options.roots.catalogRoot');
    }
  });

  it('joins the orchestrator lock file to the catalog root with a fixed name only', () => {
    // `lock.ts` never derives a subdirectory or a variable segment: the one
    // document it writes is `<catalogRoot>/orchestrator.lock`, a constant
    // string, so there is no untrusted input for it to compose with either.
    const lock = sourceFiles().find((file) => file.name === 'lock.ts');
    expect(lock).toBeDefined();
    expect(lock!.text).toContain("join(catalogRoot, ORCHESTRATOR_LOCK_FILE)");
    expect(lock!.text).toContain("ORCHESTRATOR_LOCK_FILE = 'orchestrator.lock'");
  });

  it('performs no deletion, removal or rename-away of a retained artifact', () => {
    // M08.28 is the tranche that decides whether a deletion feature exists
    // (the milestone file names it explicitly, more than once, and ADR 0023
    // §3 already states the preference). The decision this slice records is
    // omission — no *retained artifact* is ever deleted — and this scan is
    // what keeps that true going forward rather than merely remembered.
    //
    // Two files call `rm`, and both are reviewed exceptions rather than
    // gaps: `files.ts`'s atomic write removes a same-call's own `.tmp` file
    // on a failed write, never a document; `lock.ts`'s `release()` removes
    // only the orchestrator's own lock file, after confirming by PID and
    // host that it still owns it — ephemeral process-coordination state, not
    // a retained artifact. Neither deletes a batch, a job, a saved choice, an
    // annotation or a result. The assertions below confirm each targets
    // exactly what it claims, rather than trusting the claim.
    for (const file of sourceFiles()) {
      if (file.name === 'files.ts') {
        const targets = [...file.text.matchAll(/\brm\(([^,)]+)/g)].map(([, arg]) =>
          (arg ?? '').trim(),
        );
        expect(targets).toEqual(['temporary']);
        continue;
      }
      if (file.name === 'lock.ts') {
        const targets = [...file.text.matchAll(/\brm\(([^,)]+)/g)].map(([, arg]) =>
          (arg ?? '').trim(),
        );
        expect(targets).toEqual(['path']);
        // The one call is inside `release()`, guarded by the PID/host check
        // immediately above it — not reachable any other way.
        expect(file.text).toContain(
          'if (held === null || held.pid !== pid || held.host !== host) return;',
        );
        continue;
      }
      for (const capability of ['unlink', 'rmdir', 'rmSync', 'unlinkSync', 'rmdirSync']) {
        expect(`${file.name}: ${capability}: ${String(file.text.includes(capability))}`).toBe(
          `${file.name}: ${capability}: false`,
        );
      }
      expect(`${file.name}: rm(: ${String(/\brm\(/.test(file.text))}`).toBe(
        `${file.name}: rm(: false`,
      );
    }
  });

  it('gives the catalog store interface no delete, remove or move method', () => {
    // The property ADR 0023 §3 names directly: "there is no delete, no
    // remove and no move anywhere in the interface, which is what makes
    // 'deleting a catalog entry must not delete an experiment directory' a
    // property rather than a policy." Checked against `store.ts` itself
    // rather than only against the implementation, so a future
    // implementation of the same interface inherits the guarantee.
    const iface = sourceFiles().find((file) => file.name === 'store.ts');
    expect(iface).toBeDefined();
    for (const forbidden of ['delete', 'remove', 'move(']) {
      expect(`store.ts: ${forbidden}: ${String(iface!.text.toLowerCase().includes(forbidden))}`).toBe(
        `store.ts: ${forbidden}: false`,
      );
    }
  });
});
