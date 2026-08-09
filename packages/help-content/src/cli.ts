/* eslint-disable no-console */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CardDatabase, loadBundledCardData, loadCardSets } from '@tcg/card-data';
import { isOk, type Issue } from '@tcg/shared';
import { validateContent } from './validate.js';

/**
 * `npm run validate:content`
 *
 * Checks that the card data, the registries and the rulebook agree with each
 * other, and that every executable effect in the pool can actually be explained
 * to a player. Part of `npm run verify`, so content that cannot be explained
 * never reaches a build.
 *
 * Exits non-zero on any error. Warnings are printed and do not fail the run:
 * missing artwork and inert keywords are normal states, not mistakes.
 */

const ART_DIRECTORY = fileURLToPath(new URL('../../../assets/card-art', import.meta.url));
const TEMPLATE_DIRECTORY = fileURLToPath(new URL('../../../docs/templates/cards', import.meta.url));

function artworkFiles(): readonly string[] | undefined {
  try {
    return readdirSync(ART_DIRECTORY);
  } catch {
    // No artwork folder is a legitimate state: every card falls back to the
    // default image. Skip the filename checks rather than inventing a failure.
    return undefined;
  }
}

/**
 * Validates the documented card templates as if they were a real set.
 *
 * A template that no longer parses is worse than no template at all: an author
 * copies it, gets a schema error they did not cause, and stops trusting the
 * guide. Checking them here means the templates cannot drift away from the
 * schema without the build noticing.
 */
function validateTemplates(): readonly Issue[] {
  let files: readonly string[];
  try {
    files = readdirSync(TEMPLATE_DIRECTORY).filter((file) => file.endsWith('.json'));
  } catch {
    return [];
  }
  if (files.length === 0) return [];

  const cards = files.map((file) =>
    JSON.parse(readFileSync(`${TEMPLATE_DIRECTORY}/${file}`, 'utf8')),
  );
  const loaded = loadCardSets([
    { schemaVersion: 2, setId: 'documentation_templates', name: 'Documentation templates', cards },
  ]);

  if (!isOk(loaded)) {
    console.log(`\nCard template errors (${loaded.error.length}):`);
    loaded.error.forEach(print);
    return loaded.error;
  }

  // Templates must also be explainable, exactly like shipped cards.
  const report = validateContent({
    database: new CardDatabase([...loaded.value.database.all()]),
  });
  console.log(`Validated ${files.length} card templates in docs/templates/cards.`);
  return report.errors;
}

function print(issue: Issue): void {
  const location = issue.path ? `${issue.path}` : '(content)';
  const label = issue.severity === 'error' ? 'error' : 'warn ';
  console.log(`  ${label}  ${location}\n         ${issue.message}  [${issue.code}]`);
}

function main(): void {
  const loaded = loadBundledCardData();
  const files = artworkFiles();
  const report = validateContent({
    database: loaded.database,
    ...(files === undefined ? {} : { artworkFiles: files }),
  });

  const { counts } = report;
  console.log(
    `Validated ${counts.cards} cards, ${counts.keywords} keywords, ${counts.effectTypes} effect types, ` +
      `${counts.glossaryEntries} glossary entries and ${counts.rulebookSections} rulebook sections.`,
  );

  // Card-loading warnings (text drift, orphan tokens) belong in the same report:
  // an author running one command should see everything about their content.
  const loaderWarnings = loaded.warnings;
  if (loaderWarnings.length > 0) {
    console.log(`\nCard data warnings (${loaderWarnings.length}):`);
    loaderWarnings.forEach(print);
  }

  if (report.warnings.length > 0) {
    console.log(`\nContent warnings (${report.warnings.length}):`);
    report.warnings.forEach(print);
  }

  const templateErrors = validateTemplates();

  if (report.errors.length > 0) {
    console.log(`\nContent errors (${report.errors.length}):`);
    report.errors.forEach(print);
  }

  if (report.errors.length + templateErrors.length > 0) {
    console.log('\nContent validation failed.');
    process.exitCode = 1;
    return;
  }

  console.log('\nContent validation passed.');
}

main();
