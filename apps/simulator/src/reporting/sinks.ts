import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { z } from 'zod';

/**
 * Output sinks (CLAUDE.md §13.7).
 *
 * JSON/JSONL is the canonical, lossless format; CSV is an export for eyeballing.
 * A large run streams every record to disk as it completes rather than holding
 * the whole experiment in memory, which is also what makes resume possible: the
 * file on disk *is* the progress.
 */

export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function readJson<T>(path: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/** Appends one record per line. Each line is independently parseable. */
export class JsonlWriter {
  readonly path: string;
  #buffer: string[] = [];
  #flushEvery: number;

  constructor(path: string, flushEvery = 16) {
    this.path = path;
    this.#flushEvery = flushEvery;
    ensureDir(dirname(path));
    if (!existsSync(path)) writeFileSync(path, '', 'utf8');
  }

  append(value: unknown): void {
    this.#buffer.push(JSON.stringify(value));
    if (this.#buffer.length >= this.#flushEvery) this.flush();
  }

  flush(): void {
    if (this.#buffer.length === 0) return;
    appendFileSync(this.path, `${this.#buffer.join('\n')}\n`, 'utf8');
    this.#buffer = [];
  }
}

export interface JsonlReadResult<T> {
  readonly records: readonly T[];
  /** Lines that could not be parsed or validated, with the reason. */
  readonly skipped: readonly { readonly line: number; readonly reason: string }[];
}

/**
 * Reads a JSONL file, tolerating a damaged tail.
 *
 * A run killed mid-write leaves a half-written final line. That must not make
 * the whole experiment unresumable, and it must not silently become a corrupt
 * record either — so the line is dropped and reported (CLAUDE.md §13.15 item 11).
 */
export function readJsonl<T>(path: string, schema: z.ZodType<T>): JsonlReadResult<T> {
  if (!existsSync(path)) return { records: [], skipped: [] };

  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const records: T[] = [];
  const skipped: { line: number; reason: string }[] = [];

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped.push({ line: index + 1, reason: 'unparseable JSON (likely a truncated tail)' });
      return;
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      skipped.push({
        line: index + 1,
        reason: validated.error.issues.map((issue) => issue.message).join('; '),
      });
      return;
    }
    records.push(validated.data);
  });

  return { records, skipped };
}

/* ------------------------------------------------------------------- CSV */

export interface CsvColumn<T> {
  readonly header: string;
  readonly value: (row: T) => string | number | boolean | null;
}

function escapeCsv(value: string | number | boolean | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const header = columns.map((column) => escapeCsv(column.header)).join(',');
  const body = rows.map((row) => columns.map((column) => escapeCsv(column.value(row))).join(','));
  return [header, ...body].join('\n') + '\n';
}

export function writeCsv<T>(
  path: string,
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
): void {
  ensureDir(dirname(path));
  writeFileSync(path, toCsv(rows, columns), 'utf8');
}

/** The standard layout of an experiment directory (CLAUDE.md §13.13). */
export interface ExperimentPaths {
  readonly root: string;
  readonly manifest: string;
  readonly config: string;
  readonly matches: string;
  readonly decks: string;
  readonly cardUsage: string;
  readonly cardPairs: string;
  readonly summary: string;
  readonly report: string;
  readonly replays: string;
  readonly checkpoints: string;
  readonly errors: string;
}

export function experimentPaths(root: string): ExperimentPaths {
  return {
    root,
    manifest: join(root, 'manifest.json'),
    config: join(root, 'config.json'),
    matches: join(root, 'matches.jsonl'),
    decks: join(root, 'decks.json'),
    cardUsage: join(root, 'card-usage.csv'),
    cardPairs: join(root, 'card-pairs.csv'),
    summary: join(root, 'summary.json'),
    report: join(root, 'report.md'),
    replays: join(root, 'replays'),
    checkpoints: join(root, 'checkpoints'),
    errors: join(root, 'errors.csv'),
  };
}
