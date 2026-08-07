import { err, error, ok, type Issue, type Result } from '@tcg/shared';
import { zodIssuesToIssues } from '@tcg/card-data';
import { DECK_SCHEMA_VERSION, savedDeckSchema, type SavedDeck } from './schema.js';

/** One step in the upgrade chain, from `from` to `from + 1`. */
export interface DeckMigration {
  readonly from: number;
  readonly describe: string;
  migrate(deck: Record<string, unknown>): Record<string, unknown>;
}

/**
 * Registered migrations, ordered by `from`. Empty because v1 is the first
 * released format; the chain runner below is what the next bump plugs into.
 */
export const DECK_MIGRATIONS: readonly DeckMigration[] = [];

function readVersion(raw: unknown): Result<number, Issue[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err([error('deck/malformed', 'A deck file must be a JSON object.')]);
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return err([
      error(
        'deck/missing_schema_version',
        'This file does not declare a deck schemaVersion, so it cannot be read as a deck.',
        { path: 'schemaVersion' },
      ),
    ]);
  }
  return ok(version);
}

/**
 * Upgrades a persisted deck to the current schema and validates it.
 * Never mutates the input, so a failed import cannot corrupt existing data.
 */
export function migrateSavedDeck(
  raw: unknown,
  migrations: readonly DeckMigration[] = DECK_MIGRATIONS,
): Result<SavedDeck, Issue[]> {
  const versionResult = readVersion(raw);
  if (!versionResult.ok) return versionResult;

  let version = versionResult.value;
  if (version > DECK_SCHEMA_VERSION) {
    return err([
      error(
        'deck/unsupported_schema_version',
        `This deck was saved by a newer version of the app (schema ${version}; this build reads up to ${DECK_SCHEMA_VERSION}). Update the app to open it.`,
        { path: 'schemaVersion', context: { found: version, supported: DECK_SCHEMA_VERSION } },
      ),
    ]);
  }

  let working = structuredClone(raw) as Record<string, unknown>;
  const byFrom = new Map(migrations.map((m) => [m.from, m]));

  while (version < DECK_SCHEMA_VERSION) {
    const step = byFrom.get(version);
    if (!step) {
      return err([
        error(
          'deck/no_migration_path',
          `No migration exists from deck schema ${version} to ${DECK_SCHEMA_VERSION}. This deck cannot be opened.`,
          { path: 'schemaVersion', context: { found: version } },
        ),
      ]);
    }
    working = step.migrate(working);
    version += 1;
    working.schemaVersion = version;
  }

  const parsed = savedDeckSchema.safeParse(working);
  if (!parsed.success) return err(zodIssuesToIssues(parsed.error));
  return ok(parsed.data);
}
