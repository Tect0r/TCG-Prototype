/**
 * Structured, serializable diagnostics shared by card loading, deck validation
 * and (later) the rules engine and network layer.
 *
 * `code` is stable and machine-readable; `message` is the human-facing string.
 * Never pattern-match on `message`.
 */
export type IssueSeverity = 'error' | 'warning';

export interface Issue {
  readonly severity: IssueSeverity;
  readonly code: string;
  readonly message: string;
  /** Data path the issue relates to, e.g. `cards[3].cost` or `commanderId`. */
  readonly path?: string;
  /** Extra machine-readable context, e.g. `{ cardId, limit, quantity }`. */
  readonly context?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}

export function issue(
  severity: IssueSeverity,
  code: string,
  message: string,
  extra?: Pick<Issue, 'path' | 'context'>,
): Issue {
  return {
    severity,
    code,
    message,
    ...(extra?.path === undefined ? {} : { path: extra.path }),
    ...(extra?.context === undefined ? {} : { context: extra.context }),
  };
}

export const error = (code: string, message: string, extra?: Pick<Issue, 'path' | 'context'>): Issue =>
  issue('error', code, message, extra);

export const warning = (code: string, message: string, extra?: Pick<Issue, 'path' | 'context'>): Issue =>
  issue('warning', code, message, extra);

export const errorsOf = (issues: readonly Issue[]): Issue[] =>
  issues.filter((i) => i.severity === 'error');

export const warningsOf = (issues: readonly Issue[]): Issue[] =>
  issues.filter((i) => i.severity === 'warning');

export const hasErrors = (issues: readonly Issue[]): boolean =>
  issues.some((i) => i.severity === 'error');
