/**
 * The repository consistency check — `npm run check:consistency` (M07.7).
 *
 * The CLI shell only. What is checked, and why each check is scoped the way it
 * is, is `scripts/lib/consistency.ts`; the same checks run inside the suite as
 * `scripts/lib/consistency.test.ts`, so this command exists to give a person a
 * readable list rather than a test failure.
 *
 * Exits non-zero on the first finding, so it can be chained into a script.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatConsistencyReport, runConsistencyChecks } from './lib/consistency.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

function main(): number {
  const report = runConsistencyChecks(REPO_ROOT);
  const rendered = `${formatConsistencyReport(report)}\n`;

  if (report.ok) {
    process.stdout.write(rendered);
    return 0;
  }
  process.stderr.write(rendered);
  return 1;
}

process.exitCode = main();
