/**
 * Minimal Result type. Domain code returns structured failures instead of
 * throwing, so every external boundary (card JSON, deck imports, saved data)
 * can be validated without exception plumbing.
 */
export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(
  result: Result<T, E>,
): result is { readonly ok: true; readonly value: T } {
  return result.ok;
}

export function isErr<T, E>(
  result: Result<T, E>,
): result is { readonly ok: false; readonly error: E } {
  return !result.ok;
}

/** Unwraps a result, throwing on failure. Intended for tests and startup paths. */
export function unwrap<T, E>(result: Result<T, E>, message = 'Unwrapped a failed Result'): T {
  if (result.ok) return result.value;
  throw new Error(`${message}: ${JSON.stringify(result.error)}`);
}
