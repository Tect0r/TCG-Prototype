import type { Issue } from '@tcg/shared';
import { IssueList } from './IssueList.js';

/** Shown instead of the builder when the card database fails validation. */
export function CardDataError({ issues }: { readonly issues: readonly Issue[] }) {
  return (
    <div className="fatal">
      <h1>Card data failed validation</h1>
      <p>
        The deck builder did not start because the card database is invalid. Fix the reported
        problems in <code>packages/card-data/src/data/</code> and reload.
      </p>
      <IssueList issues={issues} />
    </div>
  );
}
