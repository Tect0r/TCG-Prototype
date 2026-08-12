/**
 * Entry-trigger review report — `npm run report:triggers`.
 *
 * The CLI shell only. What counts as an entry trigger, and how the report is
 * laid out, is `scripts/lib/entry-trigger-report.ts`.
 *
 * `--json` prints the same data as a machine-readable document. `--set <id>`
 * narrows to one set.
 */
import { loadBundledCardData } from '@tcg/card-data';
import {
  collectEntryUses,
  entryReportJson,
  formatEntryReport,
} from './lib/entry-trigger-report.js';

function main(argv: readonly string[]): number {
  const sets = loadBundledCardData().sets;

  const setIndex = argv.indexOf('--set');
  const setFilter = setIndex === -1 ? null : (argv[setIndex + 1] ?? null);

  if (setFilter && !sets.some((set) => set.setId === setFilter)) {
    const known = sets.map((set) => set.setId).join(', ');
    process.stderr.write(`report:triggers: unknown set "${setFilter}". Known sets: ${known}.\n`);
    return 1;
  }

  const uses = collectEntryUses(sets, setFilter);
  process.stdout.write(
    argv.includes('--json') ? entryReportJson(uses) : formatEntryReport(uses, setFilter),
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
