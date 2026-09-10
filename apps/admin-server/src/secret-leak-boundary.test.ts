import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * M08.28C's own acceptance evidence: "prove private snapshots, tokens and
 * secrets stay out of logs, player bundles, unauthenticated endpoints and
 * aggregate-only exports" (`docs/milestones/M08-ai-lab-and-player-meta.md`).
 *
 * ADR 0023 §4 already claims the token appears in no log line; §5 already
 * claims a resolved location never leaves the process; M08.24D's own doc
 * comments already claim the surrender-exposure view never carries a
 * board/Health figure or a bare `playerId`. Each was a narrative claim
 * before this file, checked here the same way `boundary.test.ts` and
 * `retention-boundary.test.ts` check their own absence properties: against
 * the sources, not against prose that can go stale silently.
 *
 * `apps/admin-server/src/boundary.test.ts` already scans `main.ts` alone for
 * a token or a configured root in a `console` argument. What is new here is
 * the workspace-wide claim that no *other* file logs at all, and the claim
 * that no exception message crossing from the simulator or from a re-parse
 * into a client-facing `AdminError` skips the one scrub function ADR 0023 §5
 * exists to guarantee.
 */

const SOURCE_ROOT = import.meta.dirname;

interface SourceFile {
  readonly name: string;
  readonly path: string;
  readonly text: string;
}

/** A source file's code, with comments removed — same convention as the sibling boundary suites. */
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
      files.push({ name: entry.name, path, text: codeOf(readFileSync(path, 'utf8')) });
    }
  };
  walk(SOURCE_ROOT);
  return files;
}

/** The one module ADR 0023 §4 allows to print anything at all. */
const ENTRY = 'main.ts';

describe('nothing but the entry point logs, anywhere in this workspace (M08.28C)', () => {
  it('has enough sources for the scans below to mean something', () => {
    expect(sourceFiles().length).toBeGreaterThan(4);
  });

  it('calls no console method outside main.ts', () => {
    // `boundary.test.ts` already proves main.ts's own banner never
    // interpolates a token or a configured root. This is the wider claim ADR
    // 0023 §4 actually makes — "no log line", full stop — checked against
    // every other source file rather than assumed of them.
    for (const file of sourceFiles()) {
      const allowed = file.name === ENTRY;
      expect(
        `${file.name}: ${String(/console\.(?:log|warn|error|info|debug)\(/.test(file.text))}`,
      ).toBe(`${file.name}: ${String(allowed)}`);
    }
  });

  it('writes to no other output stream either', () => {
    for (const file of sourceFiles()) {
      for (const forbidden of ['process.stdout.write', 'process.stderr.write']) {
        expect(`${file.name}: ${forbidden}: ${String(file.text.includes(forbidden))}`).toBe(
          `${file.name}: ${forbidden}: false`,
        );
      }
    }
  });
});

/**
 * Every site that catches an exception thrown by another layer — the
 * simulator's `parseExperimentConfig`, most often — and folds its `.message`
 * into a string this process can go on to expose to an administrator.
 *
 * Each is named by exact target rather than found by a generic scan, the
 * same discipline `retention-boundary.test.ts` uses for its two `rm(`
 * exceptions: a scan that could not enumerate its own exceptions would have
 * to be disabled the day a new one appears legitimately.
 */
const FORWARDS_ANOTHER_LAYERS_MESSAGE: readonly string[] = [
  'expand.ts',
  'adaptive-choice.ts',
  'job-runner.ts',
  'handlers.ts',
  'duplicate.ts',
];

describe('no forwarded exception message reaches an administrator unscrubbed (ADR 0023 §5)', () => {
  it('finds the pattern in every file named above, so the list is not stale', () => {
    const files = sourceFiles();
    for (const name of FORWARDS_ANOTHER_LAYERS_MESSAGE) {
      const file = files.find((candidate) => candidate.name === name);
      expect(file).toBeDefined();
      expect(
        `${name}: ${String(/instanceof Error \? (?:cause|error)\.message/.test(file!.text))}`,
      ).toBe(`${name}: true`);
    }
  });

  it('finds no sixth file matching the pattern that the list above does not already name', () => {
    // A new call site with this exact shape is exactly the kind of thing that
    // needs the same review `duplicate.ts` got in M08.28C — this fails loudly
    // rather than silently missing it.
    for (const file of sourceFiles()) {
      if (FORWARDS_ANOTHER_LAYERS_MESSAGE.includes(file.name)) continue;
      // `priority.ts` reads an OS error's own message (`os.setPriority`
      // refusing) — never a value another layer computed from admin input,
      // and never turned into an `AdminError`; see the check below that
      // confirms it stays that way.
      if (file.name === 'priority.ts') continue;
      expect(
        `${file.name}: ${String(/instanceof Error \? (?:cause|error)\.message/.test(file.text))}`,
      ).toBe(`${file.name}: false`);
    }
  });

  it('wraps every one of those messages in scrubRefusal within the same handful of lines', () => {
    // A textual check rather than a full parser: `scrubRefusal(` must appear
    // close to each occurrence of the ternary — either wrapping it directly
    // (`expand.ts`, `adaptive-choice.ts`, `duplicate.ts`, `handlers.ts`) or
    // one statement later, wrapping a `const message = …` it just built
    // (`job-runner.ts`). 200 characters either side comfortably covers both
    // shapes without reaching into an unrelated, later catch block; every
    // file above has just the one occurrence per catch site, so a wider
    // window cannot accidentally borrow a *different* site's wrap.
    const files = sourceFiles();
    for (const name of FORWARDS_ANOTHER_LAYERS_MESSAGE) {
      const file = files.find((candidate) => candidate.name === name);
      const text = file!.text;
      const pattern = /instanceof Error \? (?:cause|error)\.message/g;
      for (const match of text.matchAll(pattern)) {
        const index = match.index ?? 0;
        const window = text.slice(Math.max(0, index - 200), index + 200);
        expect(`${name} @ ${String(index)}: ${window.includes('scrubRefusal(')}`).toBe(
          `${name} @ ${String(index)}: true`,
        );
      }
    }
  });

  it('never turns priority.ts’s OS-error reason into a client-facing AdminError', () => {
    // The one file excluded above. Its `reason` is read by `main.ts` for a
    // start-up `console.warn` only (M08.28A) — never by anything that builds
    // an `AdminError`, so there is nothing here for `scrubRefusal` to guard.
    const priority = sourceFiles().find((file) => file.name === 'priority.ts')!.text;
    expect(priority).not.toContain('adminError');
    const entry = sourceFiles().find((file) => file.name === ENTRY)!.text;
    expect(entry).toContain('lowerSimulatorProcessPriority');
    expect(entry).not.toContain('adminError(');
  });
});

describe('the surrender-exposure view stays aggregate, never per-player (M08.24D / M08.28C)', () => {
  const PLAYER_META_FILES = [
    'player-meta-results.ts',
    'comparison-deltas.ts',
    'coverage.ts',
    'data-health.ts',
  ];

  it('names no bare playerId field in any of the aggregate-only views', () => {
    // `match-explorer.ts` and `match-representatives.ts` legitimately carry
    // `playerId` — they are per-match drill-down, authenticated the same as
    // everything else, and naming the seat a capture belongs to is the point
    // of a match view. The tables below are different: M08.24D's own doc
    // comment on `LiveMatchSurrenderAggregate` promises a population-level
    // view with "no field here is named 'cause' or 'reason'", and the same
    // restraint extends to never naming which player produced a row.
    const service = join(SOURCE_ROOT, 'service');
    for (const name of PLAYER_META_FILES) {
      const text = codeOf(readFileSync(join(service, name), 'utf8'));
      expect(`${name}: ${String(text.includes('playerId'))}`).toBe(`${name}: false`);
    }
  });

  it('reads only the surrender aggregates, never the unmatched-capture diagnostics', () => {
    // `aggregateLiveMatchSurrenders` also returns `unmatched`, which carries a
    // raw `matchId` and `playerId` for a capture that could not be attributed
    // (see `apps/simulator/src/analysis/live-match-surrender.ts`). That value
    // is diagnostic and per-player by nature; the property this workspace
    // depends on is that nothing here ever reads it.
    const text = codeOf(
      readFileSync(join(SOURCE_ROOT, 'service', 'player-meta-results.ts'), 'utf8'),
    );
    expect(text).toContain('aggregateLiveMatchSurrenders(captures, matches).aggregates');
    expect(text).not.toMatch(/\.unmatched\b/);
  });
});

describe('every route is authenticated by the same gate, before it is dispatched (ADR 0023 §4)', () => {
  it('calls `authorized(` exactly once in the transport, ahead of every handler dispatch', () => {
    // `http.ts` routes, then authenticates, then reads the body and only then
    // calls `service.handle`. One call site rather than a per-route branch is
    // what makes "every endpoint requires the token when one is configured" a
    // structural fact: a second call site could disagree with the first about
    // which routes it covers, and a route-name conditional around either one
    // would be exactly that disagreement waiting to be written.
    const http = codeOf(readFileSync(join(SOURCE_ROOT, 'service', 'http.ts'), 'utf8'));
    const calls = [...http.matchAll(/authorized\(/g)];
    // One call in `serve()`, one in the exported function's own declaration —
    // `export function authorized(` — and no third site.
    expect(calls.length).toBe(2);
    expect(http).toContain('export function authorized(');
    expect(http).not.toMatch(/route\.name\s*===\s*['"][a-zA-Z]+['"][^\n]*\n[^\n]*authorized/);
    // Authentication happens after routing (so an unknown address answers the
    // same either way) and before the body is read (so an unauthenticated
    // caller cannot make this process allocate a body's worth of memory).
    const authIndex = http.indexOf('if (!authorized(config, request))');
    const routeIndex = http.indexOf('const route = resolveRoute(');
    const bodyIndex = http.indexOf('const body = await readBody(');
    expect(authIndex).toBeGreaterThan(routeIndex);
    expect(authIndex).toBeLessThan(bodyIndex);
  });
});
