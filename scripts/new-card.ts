/**
 * Card scaffolder — `npm run cards:new -- --set <setId> --type <type> --id <cardId>`.
 *
 * Writes one placeholder card file into `content/sets/<setId>/`. This file is
 * only the CLI shell: argument handling, exit codes and the two messages a user
 * sees. The scaffolding itself is `scripts/lib/card-scaffold.ts`, which is
 * importable and therefore testable for every card type.
 */
import { ScaffoldError, scaffoldCard, usage } from './lib/card-scaffold.js';

function main(argv: readonly string[]): number {
  if (
    argv.length === 0 ||
    argv.some((token) => token === '--help' || token.startsWith('--help='))
  ) {
    process.stdout.write(usage());
    return 0;
  }

  try {
    const result = scaffoldCard(argv);
    process.stdout.write(
      `cards:new: wrote ${result.relativePath} from ${result.templateName}.\n` +
        `  Edit it, then validate with:  npm run content:check\n`,
    );
    return 0;
  } catch (caught) {
    if (caught instanceof ScaffoldError) {
      process.stderr.write(`cards:new: ${caught.message}\n`);
      return 1;
    }
    throw caught;
  }
}

process.exitCode = main(process.argv.slice(2));
