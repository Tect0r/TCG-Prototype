import { err, error, hasErrors, ok, warning, type Issue, type Result } from '@tcg/shared';
import type { z } from 'zod';
import { cardSetSchema, type CardDefinition, type CardSet } from './schema/card.js';
import { CARD_SCHEMA_VERSION } from './schema/primitives.js';
import { lintDisplayText } from './display-text.js';
import { CardDatabase } from './database.js';

/** Converts Zod problems into the shared structured Issue shape. */
export function zodIssuesToIssues(zodError: z.ZodError, pathPrefix = ''): Issue[] {
  return zodError.issues.map((problem) => {
    const path = [pathPrefix, problem.path.join('.')].filter(Boolean).join('.');
    return error('card_data/schema', problem.message, {
      ...(path ? { path } : {}),
      context: { zodCode: problem.code },
    });
  });
}

/**
 * Applies migrations to a raw set payload so older data files keep loading.
 * No migrations exist yet; the seam is here so the first schema bump is cheap.
 */
function migrateRawSet(raw: unknown, index: number): Result<unknown, Issue[]> {
  if (typeof raw !== 'object' || raw === null) {
    return err([
      error('card_data/malformed', 'A card set must be a JSON object.', { path: `sets[${index}]` }),
    ]);
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (typeof version !== 'number') {
    return err([
      error('card_data/missing_schema_version', 'A card set must declare a numeric schemaVersion.', {
        path: `sets[${index}].schemaVersion`,
      }),
    ]);
  }
  if (version > CARD_SCHEMA_VERSION) {
    return err([
      error(
        'card_data/unsupported_schema_version',
        `Card set uses schemaVersion ${version}, but this build understands at most ${CARD_SCHEMA_VERSION}. Update the application.`,
        { path: `sets[${index}].schemaVersion`, context: { found: version, supported: CARD_SCHEMA_VERSION } },
      ),
    ]);
  }
  return ok(raw);
}

export interface LoadedCardData {
  readonly database: CardDatabase;
  readonly sets: readonly CardSet[];
  /** Non-blocking authoring problems (text drift, unused tokens, ...). */
  readonly warnings: readonly Issue[];
}

/**
 * Validates raw card set payloads and builds the shared card database.
 * Invalid data fails loudly with actionable, structured errors.
 */
export function loadCardSets(rawSets: readonly unknown[]): Result<LoadedCardData, Issue[]> {
  const issues: Issue[] = [];
  const sets: CardSet[] = [];

  if (rawSets.length === 0) {
    return err([error('card_data/empty', 'No card sets were supplied.')]);
  }

  rawSets.forEach((raw, index) => {
    const migrated = migrateRawSet(raw, index);
    if (!migrated.ok) {
      issues.push(...migrated.error);
      return;
    }
    const parsed = cardSetSchema.safeParse(migrated.value);
    if (!parsed.success) {
      issues.push(...zodIssuesToIssues(parsed.error, `sets[${index}]`));
      return;
    }
    sets.push(parsed.data);
  });

  if (hasErrors(issues)) return err(issues);

  const setIds = new Set<string>();
  for (const set of sets) {
    if (setIds.has(set.setId)) {
      issues.push(
        error('card_data/duplicate_set_id', `Duplicate set ID "${set.setId}".`, {
          context: { setId: set.setId },
        }),
      );
    }
    setIds.add(set.setId);
  }

  const byId = new Map<string, CardDefinition>();
  for (const set of sets) {
    for (const card of set.cards) {
      const existing = byId.get(card.id);
      if (existing) {
        issues.push(
          error(
            'card_data/duplicate_card_id',
            `Card ID "${card.id}" is defined more than once ("${existing.name}" and "${card.name}"). IDs are permanent and must be unique.`,
            { context: { cardId: card.id } },
          ),
        );
        continue;
      }
      byId.set(card.id, card);
    }
  }

  // Structured references must resolve, or the rules engine will fail at runtime.
  for (const card of byId.values()) {
    const effects = [...card.effects, ...card.abilities.flatMap((a) => a.effects)];
    for (const effect of effects) {
      if (effect.type !== 'create_token') continue;
      const token = byId.get(effect.tokenCardId);
      if (!token) {
        issues.push(
          error(
            'card_data/unknown_token',
            `"${card.name}" creates token "${effect.tokenCardId}", which is not defined in any loaded set.`,
            { path: `${card.id}.effects`, context: { cardId: card.id, tokenCardId: effect.tokenCardId } },
          ),
        );
      } else if (token.type !== 'token') {
        issues.push(
          error(
            'card_data/invalid_token_reference',
            `"${card.name}" creates "${effect.tokenCardId}", which is a ${token.type}, not a token.`,
            { path: `${card.id}.effects`, context: { cardId: card.id, tokenCardId: effect.tokenCardId } },
          ),
        );
      }
    }
  }

  if (hasErrors(issues)) return err(issues);

  const warnings: Issue[] = issues.filter((i) => i.severity === 'warning');
  for (const card of byId.values()) {
    warnings.push(...lintDisplayText(card));
  }

  const referencedTokens = new Set<string>();
  for (const card of byId.values()) {
    for (const effect of [...card.effects, ...card.abilities.flatMap((a) => a.effects)]) {
      if (effect.type !== 'create_token') continue;
      referencedTokens.add(effect.tokenCardId);

      // A card that makes a coloured token effectively carries that colour.
      // Provisional convention, see docs/rules/open-decisions.md.
      const token = byId.get(effect.tokenCardId);
      const leaked = token?.colorIdentity.filter((c) => !card.colorIdentity.includes(c)) ?? [];
      if (leaked.length > 0) {
        warnings.push(
          warning(
            'card_data/token_color_leak',
            `"${card.name}" creates "${token?.name}", whose colour identity (${leaked.join(', ')}) is not part of the creating card's colour identity.`,
            { context: { cardId: card.id, tokenCardId: effect.tokenCardId, colors: leaked } },
          ),
        );
      }
    }
  }
  for (const card of byId.values()) {
    if (card.type === 'token' && !referencedTokens.has(card.id)) {
      warnings.push(
        warning('card_data/orphan_token', `Token "${card.name}" is never created by any card.`, {
          context: { cardId: card.id },
        }),
      );
    }
  }

  return ok({ database: new CardDatabase([...byId.values()]), sets, warnings });
}
