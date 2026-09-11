import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CURSOR_PATH = resolve(REPO_ROOT, '.claude', 'current-task.json');
const MAX_CURSOR_BYTES = 1_024;
const MAX_SECTION_CHARACTERS = 12_000;
const CURSOR_KEYS = [
  'blocker',
  'heading',
  'mode',
  'next',
  'schemaVersion',
  'source',
  'unit',
] as const;
const MODES = ['implementation', 'tranche-close', 'blocked', 'done'] as const;

type Mode = (typeof MODES)[number];

interface CurrentTask {
  readonly schemaVersion: 1;
  readonly unit: string;
  readonly mode: Mode;
  readonly source: string;
  readonly heading: string;
  readonly blocker: string | null;
  readonly next: string | null;
}

function fail(message: string): never {
  throw new Error(`Invalid .claude/current-task.json: ${message}`);
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    return fail(`${field} must be a non-empty, trimmed string`);
  }
  if (value.length > maximum) return fail(`${field} exceeds ${maximum} characters`);
  if (/\r|\n/.test(value)) return fail(`${field} must fit on one line`);
  return value;
}

function nullableBoundedString(value: unknown, field: string, maximum: number): string | null {
  return value === null ? null : boundedString(value, field, maximum);
}

function parseCurrentTask(raw: string): CurrentTask {
  if (Buffer.byteLength(raw, 'utf8') > MAX_CURSOR_BYTES) {
    return fail(
      `cursor exceeds ${MAX_CURSOR_BYTES} bytes; replace it instead of appending history`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('file is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('root must be an object');
  }

  const record = parsed as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...CURSOR_KEYS].sort();
  if (actualKeys.join('\0') !== expectedKeys.join('\0')) {
    return fail(`expected exactly these fields: ${expectedKeys.join(', ')}`);
  }
  if (record.schemaVersion !== 1) return fail('schemaVersion must be 1');
  if (!MODES.includes(record.mode as Mode)) {
    return fail(`mode must be one of: ${MODES.join(', ')}`);
  }

  const source = boundedString(record.source, 'source', 160);
  if (!/^docs\/milestones\/[A-Za-z0-9._-]+\.md$/.test(source)) {
    return fail('source must name one Markdown file directly under docs/milestones/');
  }

  const blocker = nullableBoundedString(record.blocker, 'blocker', 500);
  if (record.mode === 'blocked' && blocker === null) {
    return fail('blocked mode requires a blocker');
  }
  if (record.mode !== 'blocked' && blocker !== null) {
    return fail('blocker must be null unless mode is blocked');
  }

  return {
    schemaVersion: 1,
    unit: boundedString(record.unit, 'unit', 40),
    mode: record.mode as Mode,
    source,
    heading: boundedString(record.heading, 'heading', 180),
    blocker,
    next: nullableBoundedString(record.next, 'next', 40),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const headingPattern = new RegExp(`^(#{1,6}) ${escapeRegExp(heading)}\\s*$`);
  const start = lines.findIndex((line) => headingPattern.test(line));
  if (start < 0) return fail(`heading not found in source: ${heading}`);

  const headingLine = lines[start];
  if (headingLine === undefined) return fail(`heading not found in source: ${heading}`);
  const matched = headingPattern.exec(headingLine);
  const level = matched?.[1]?.length;
  if (level === undefined) return fail(`could not parse heading: ${heading}`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const nextHeading = /^(#{1,6})\s+/.exec(line);
    if (nextHeading?.[1] !== undefined && nextHeading[1].length <= level) {
      end = index;
      break;
    }
  }

  const section = lines.slice(start, end).join('\n').trim();
  if (section.length > MAX_SECTION_CHARACTERS) {
    return fail(
      `active section exceeds ${MAX_SECTION_CHARACTERS} characters; split it into smaller work units`,
    );
  }
  return section;
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    process.stderr.write('Usage: npm run work:current [-- --check]\n');
    return 2;
  }

  try {
    const task = parseCurrentTask(readFileSync(CURSOR_PATH, 'utf8'));
    const sourcePath = resolve(REPO_ROOT, task.source);
    const section = extractSection(readFileSync(sourcePath, 'utf8'), task.heading);

    if (args[0] === '--check') {
      process.stdout.write(`Current-task cursor valid: ${task.unit} (${task.mode}).\n`);
      return 0;
    }

    const lines = [
      '# Current task',
      '',
      `- Unit: ${task.unit}`,
      `- Mode: ${task.mode}`,
      `- Source: ${task.source}`,
      `- Next: ${task.next ?? 'none'}`,
    ];
    if (task.blocker !== null) lines.push(`- Blocker: ${task.blocker}`);
    lines.push('', section, '');
    process.stdout.write(lines.join('\n'));
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

process.exitCode = main();
