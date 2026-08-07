import { err, ok, type Result } from '@tcg/shared';
import { engineError, type EngineError } from './errors.js';
import { matchStateSchema, type MatchState } from './schema/state.js';

/**
 * Match state is plain JSON by construction — no closures, no class instances,
 * no `Date`. These helpers exist so the round trip is *tested* rather than
 * assumed, and so a persisted or transmitted state is re-validated on the way
 * back in (CLAUDE.md §9, §14).
 */
export function serializeMatchState(state: MatchState): string {
  return JSON.stringify(state);
}

export function parseMatchState(input: unknown): Result<MatchState, EngineError> {
  const parsed = matchStateSchema.safeParse(input);
  if (!parsed.success) {
    return err(
      engineError('engine/invalid_action', 'Match state failed schema validation.', {
        detail: parsed.error.issues
          .slice(0, 5)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
      }),
    );
  }
  return ok(parsed.data);
}

export function deserializeMatchState(json: string): Result<MatchState, EngineError> {
  try {
    return parseMatchState(JSON.parse(json));
  } catch (error) {
    return err(
      engineError('engine/invalid_action', 'Match state is not valid JSON.', {
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
