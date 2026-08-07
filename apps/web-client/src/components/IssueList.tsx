import type { Issue } from '@tcg/shared';

interface IssueListProps {
  readonly issues: readonly Issue[];
  readonly emptyMessage?: string;
}

/** Renders structured diagnostics. Never re-derives meaning from the message. */
export function IssueList({ issues, emptyMessage }: IssueListProps) {
  if (issues.length === 0) {
    return emptyMessage ? <p className="issues__ok">{emptyMessage}</p> : null;
  }

  return (
    <ul className="issues">
      {issues.map((issue, index) => (
        <li key={`${issue.code}:${issue.path ?? index}`} className={`issue issue--${issue.severity}`}>
          <span className="issue__severity">{issue.severity === 'error' ? 'Error' : 'Warning'}</span>
          <span className="issue__message">{issue.message}</span>
          <code className="issue__code">{issue.code}</code>
        </li>
      ))}
    </ul>
  );
}
