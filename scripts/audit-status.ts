/**
 * The status audit — `npm run audit:status` (M07.1).
 *
 * The CLI shell only. What the audit contains, and how it is laid out, is
 * `scripts/lib/status-audit.ts`; this gathers the three things a collector
 * cannot read out of the source — the commit, whether the tree was clean, and
 * the test totals from a real `vitest list` — and writes the document.
 *
 * Flags:
 *
 * - `--check` compares the committed document's derived half against a fresh
 *   collection and exits non-zero on drift. It never runs the suite, so it is
 *   cheap enough to sit in a test.
 * - `--verify <passed|failed|not-run>` records what `npm run verify` did at this
 *   commit. There is no default of "passed": an audit that has not been told
 *   says so.
 * - `--out <path>` writes somewhere other than `docs/status-audit.md`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectAudit,
  derivedSectionOf,
  parseVitestList,
  renderAuditDocument,
  renderDerivedFacts,
  verifySteps,
  VERIFY_OUTCOMES,
  type AuditRun,
  type VerifyOutcome,
} from './lib/status-audit.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const DEFAULT_OUT = join('docs', 'status-audit.md');

function flagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index === -1 ? null : (argv[index + 1] ?? null);
}

function git(args: readonly string[]): string {
  const result = spawnSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/**
 * Every test case the runner knows about, without running one.
 *
 * Node runs the installed runner directly rather than through `npx`: the
 * launcher is a `.cmd` shim on Windows, which recent Node refuses to spawn
 * without a shell, and `shell: true` concatenates arguments instead of escaping
 * them. The module path is the same on every platform.
 */
function listTests(): string {
  const vitest = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const result = spawnSync(process.execPath, [vitest, 'list'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`\`npx vitest list\` failed (exit ${String(result.status)}): ${result.stderr}`);
  }
  return result.stdout;
}

function main(argv: readonly string[]): number {
  const outPath = join(REPO_ROOT, flagValue(argv, '--out') ?? DEFAULT_OUT);
  const facts = collectAudit(REPO_ROOT);

  if (argv.includes('--check')) {
    const written = derivedSectionOf(readFileSync(outPath, 'utf8'));
    if (written === null) {
      process.stderr.write(`audit:status: ${outPath} has no derived-facts markers.\n`);
      return 1;
    }
    if (written !== renderDerivedFacts(facts)) {
      process.stderr.write(
        `audit:status: ${outPath} no longer matches the code it describes. ` +
          'Run `npm run audit:status` and commit the result.\n',
      );
      return 1;
    }
    process.stdout.write(`audit:status: ${outPath} is current.\n`);
    return 0;
  }

  const requested = flagValue(argv, '--verify') ?? 'not-run';
  const normalized = requested.replace('-', '_');
  if (!(VERIFY_OUTCOMES as readonly string[]).includes(normalized)) {
    process.stderr.write(
      `audit:status: --verify must be one of passed, failed, not-run (got "${requested}").\n`,
    );
    return 1;
  }

  const run: AuditRun = {
    commit: git(['rev-parse', 'HEAD']),
    treeClean: git(['status', '--porcelain']) === '',
    takenOn: new Date().toISOString().slice(0, 10),
    nodeVersion: process.version,
    verify: normalized as VerifyOutcome,
    verifySteps: verifySteps(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')),
    tests: parseVitestList(listTests()),
  };

  writeFileSync(outPath, renderAuditDocument(facts, run), 'utf8');
  process.stdout.write(
    `audit:status: wrote ${outPath} — ${String(run.tests.tests)} tests in ` +
      `${String(run.tests.files)} files at ${run.commit.slice(0, 7)}.\n`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
