import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContent, serializeBundle, warningsOfBuild } from './build.js';
import { GENERATED_BUNDLE_PATH } from './source.js';

/** Repository root, four levels up from `packages/card-data/src/content`. */
function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
}

function report(
  label: string,
  issues: readonly { code: string; message: string; path?: string }[],
) {
  if (issues.length === 0) return;
  process.stderr.write(`\n${label}:\n`);
  for (const problem of issues) {
    const where = problem.path ? ` (${problem.path})` : '';
    process.stderr.write(`  ${problem.code}${where}\n    ${problem.message}\n`);
  }
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check');
  const root = repoRoot();
  const outputPath = join(root, GENERATED_BUNDLE_PATH);

  const { bundle, issues } = buildContent(root);
  const errors = issues.filter((problem) => problem.severity === 'error');
  const warnings = warningsOfBuild(issues);

  report('Content warnings', warnings);

  if (!bundle || errors.length > 0) {
    report('Content errors', errors);
    process.stderr.write(`\ncontent: ${errors.length} error(s). Bundle not written.\n`);
    return 1;
  }

  const serialized = serializeBundle(bundle);
  const cardCount = bundle.sets.reduce((total, set) => total + set.cards.length, 0);
  const summary = `${bundle.sets.length} set(s), ${cardCount} card(s), ${bundle.formats.length} format(s)`;

  if (check) {
    const current = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : null;
    if (current === serialized) {
      process.stdout.write(`content: up to date — ${summary}.\n`);
      return 0;
    }
    process.stderr.write(
      current === null
        ? `\ncontent: ${GENERATED_BUNDLE_PATH} is missing. Run \`npm run content:build\`.\n`
        : `\ncontent: ${GENERATED_BUNDLE_PATH} is stale. Run \`npm run content:build\` and commit the result.\n`,
    );
    return 1;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serialized);
  process.stdout.write(`content: wrote ${GENERATED_BUNDLE_PATH} — ${summary}.\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
