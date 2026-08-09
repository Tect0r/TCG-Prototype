/* eslint-disable no-console */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseExperimentConfig } from './config.js';
import { runExperiment, detectSoftwareCommit } from './experiment.js';
import { experimentPaths } from './reporting/sinks.js';

/**
 * The simulator command line (CLAUDE.md §13.13).
 *
 * ```bash
 * npm run simulate -- --config experiments/smoke.json
 * npm run simulate -- --config experiments/batch.json --workers 8
 * npm run simulate -- --config experiments/abuse-search.json
 * npm run simulate -- --config experiments/replacement.json
 * npm run simulate -- --config experiments/candidate-vs-baseline.json
 * npm run simulate -- --config experiments/pilot-robustness.json
 * npm run simulate -- --config experiments/batch.json --resume
 * ```
 *
 * Every experiment kind streams its raw records to one `matches.jsonl`, so
 * `--resume` means the same thing for a search or a comparison as it does for a
 * batch: skip what is already committed, re-run nothing (PHASE4_HARDENING §7).
 *
 * Every input is a validated configuration file. There are no flags that change
 * what an experiment *is* — only where it runs and how loudly it reports — so a
 * result directory is always reproducible from its own `config.json`.
 */

interface CliArgs {
  readonly config: string;
  readonly workers: number | null;
  readonly output: string | null;
  readonly resume: boolean;
  readonly quiet: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let config = '';
  let workers: number | null = null;
  let output: string | null = null;
  let resume = false;
  let quiet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--config':
      case '-c':
        config = argv[++index] ?? '';
        break;
      case '--workers':
      case '-w':
        workers = Number.parseInt(argv[++index] ?? '1', 10);
        break;
      case '--output':
      case '-o':
        output = argv[++index] ?? null;
        break;
      case '--resume':
        resume = true;
        break;
      case '--quiet':
        quiet = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        if (arg && arg.startsWith('-')) {
          throw new Error(`Unknown option "${arg}". Run with --help.`);
        }
    }
  }

  if (!config) {
    printUsage();
    throw new Error('An experiment needs --config <path>.');
  }
  if (workers !== null && (!Number.isFinite(workers) || workers < 1)) {
    throw new Error('--workers must be a positive integer.');
  }

  return { config, workers, output, resume, quiet };
}

function printUsage(): void {
  console.log(
    [
      'Usage: npm run simulate -- --config <path> [options]',
      '',
      'Options:',
      '  -c, --config <path>   Experiment configuration file (required).',
      '  -w, --workers <n>     Worker threads. Results are identical at any count.',
      '  -o, --output <dir>    Override the output directory.',
      '      --resume          Skip matches already present in matches.jsonl.',
      '      --quiet           Suppress progress output.',
      '  -h, --help            Show this message.',
    ].join('\n'),
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const configPath = resolve(args.config);
  const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  const config = parseExperimentConfig(raw);

  const commit = detectSoftwareCommit();
  console.log(`experiment:  ${config.id} (${config.kind})`);
  console.log(`config:      ${configPath}`);
  console.log(`seed:        ${config.seed}`);
  console.log(`commit:      ${commit ?? 'not a git checkout'}`);
  console.log(`workers:     ${args.workers ?? config.workers}`);
  console.log('');

  let lastLine = 0;
  const outcome = await runExperiment(config, {
    configPath,
    ...(args.output ? { outputDir: args.output } : {}),
    ...(args.workers === null ? {} : { workers: args.workers }),
    resume: args.resume,
    softwareCommit: commit,
    ...(args.quiet
      ? {}
      : {
          onProgress: (progress) => {
            // Progress is wall-clock derived and therefore deliberately kept out
            // of every recorded artefact; it exists only for the terminal.
            if (progress.completed === lastLine) return;
            lastLine = progress.completed;
            const remaining =
              progress.estimatedRemainingMs > 0
                ? `, ~${formatDuration(progress.estimatedRemainingMs)} left`
                : '';
            console.log(
              `  ${progress.completed}/${progress.total} matches ` +
                `(${progress.matchesPerSecond.toFixed(1)}/s, ${progress.abnormal} abnormal, ` +
                `${progress.failed} failed${remaining})`,
            );
          },
          onGeneration: (report) => {
            console.log(
              `  generation ${report.generation}: ${report.evaluated} decks, ${report.matches} matches, ` +
                `best score ${report.best?.score ?? '—'}, card entropy ${report.cardEntropy}`,
            );
          },
        }),
  });

  const paths = experimentPaths(outcome.outputDir);
  console.log('');
  console.log(`matches:     ${outcome.records.length}`);
  console.log(`abnormal:    ${outcome.aggregate.run.abnormalMatches}`);
  console.log(
    `flags:       ${outcome.flags.filter((flag) => flag.level === 'review_recommended').length} review_recommended, ${outcome.flags.filter((flag) => flag.level === 'possible_interaction').length} possible_interaction`,
  );
  console.log(`elapsed:     ${formatDuration(outcome.elapsedMs)}`);
  console.log('');
  console.log(`report:      ${paths.report}`);
  console.log(`raw records: ${paths.matches}`);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
