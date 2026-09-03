import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * M08.23D's public/client authorization proof: the wire protocol sent to a
 * player or spectator (`ServerMessage`, `PlayerView`, `LobbyView`, and every
 * other type this package exports) must never be able to carry a hidden
 * artifact — most sensitively `LiveMatchPreActionCapture`
 * (`@tcg/match-telemetry`'s full, unredacted engine-state snapshot,
 * `packages/match-telemetry/src/pre-action-capture.ts`). This package has no
 * dependency on `@tcg/match-telemetry` at all, so no message type it defines
 * can structurally embed one — the same "read the manifest and the sources
 * rather than assert a sentence" idiom `apps/multiplayer-server/src/boundary.test.ts`
 * already uses for its own workspace boundary.
 *
 * This is a structural proof about what the protocol *can* express, not a
 * runtime trace of one match: `@tcg/multiplayer-server` holds
 * `LiveMatchPreActionCapture` only as internal server-side lobby state
 * (`apps/multiplayer-server/src/lobby.ts`'s `lastPreActionCapture`) and never
 * serializes it into any outbound message — this test is what makes that
 * true by construction rather than by review.
 */

const SOURCE_ROOT = import.meta.dirname;
const PACKAGE_ROOT = join(SOURCE_ROOT, '..');

interface Manifest {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

function manifestOf(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

const MANIFEST = manifestOf(join(PACKAGE_ROOT, 'package.json'));

/** Every non-test `.ts` source in this workspace, with comments stripped. */
function sourceFiles(): { readonly name: string; readonly text: string }[] {
  const files: { name: string; text: string }[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const text = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      files.push({ name: entry.name, text });
    }
  };
  walk(SOURCE_ROOT);
  return files;
}

describe('no hidden-artifact telemetry reachable through the wire protocol (M08.23D)', () => {
  it('declares no dependency on @tcg/match-telemetry', () => {
    expect(MANIFEST.name).toBe('@tcg/protocol');
    for (const set of [MANIFEST.dependencies, MANIFEST.devDependencies]) {
      expect(Object.keys(set ?? {})).not.toContain('@tcg/match-telemetry');
    }
  });

  it('imports it from no source file', () => {
    for (const file of sourceFiles()) {
      expect(file.text, file.name).not.toMatch(/from ['"]@tcg\/match-telemetry['"]/);
    }
  });
});
