import type { ReactNode } from 'react';

import { failureMessages, type AdminFailure } from '../net/transport.js';

/**
 * The three things a screen says when it has no data: it is asking, it failed to
 * ask, or there is nothing to show.
 *
 * One module rather than three spellings per screen, because these are the
 * states a shell is judged on and they are the ones most often left to a bare
 * spinner or an empty div. Each is a live region with a role, so a screen reader
 * hears the change rather than finding it later.
 *
 * The distinction that matters most is the third: **an empty answer and a failed
 * one are different facts**, and a screen that renders "none" for both is a
 * screen that quietly turns a broken connection into a truthful-looking zero.
 * That is the same rule the milestone's result rules state for measurements —
 * *zero observations are not a zero win rate* — applied one layer up, where a
 * table has no rows.
 */

interface BusyProps {
  /** What is being waited for, in words. Announced, so it must name the thing. */
  readonly label: string;
}

export function Busy({ label }: BusyProps) {
  return (
    <p className="feedback feedback--busy" role="status" aria-live="polite">
      {label}
    </p>
  );
}

interface EmptyProps {
  readonly children: ReactNode;
}

export function Empty({ children }: EmptyProps) {
  return <p className="feedback feedback--empty">{children}</p>;
}

interface FailureProps {
  readonly title: string;
  readonly failure: AdminFailure;
  /** Offered when asking again could plausibly help. Omitted when it could not. */
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}

/**
 * A refusal, printed with what the service actually said.
 *
 * The service's own message is shown rather than a friendlier rewrite of it: the
 * codes are closed and the wording is the contract's, and a client that
 * paraphrased would be a second author of a refusal it does not decide. The code
 * is printed beside the sentence for the same reason — it is the part an
 * operator can search for and the part that does not change with the prose.
 *
 * A `version` failure carries the repository's readable newer- or older-build
 * sentence, and it is the one failure where retrying cannot help, so the caller
 * withholds the button rather than this component pretending it might.
 */
export function Failure({ title, failure, onRetry, retryLabel }: FailureProps) {
  const codes = failure.kind === 'refused' ? failure.errors.map((problem) => problem.code) : [];
  return (
    <div className="feedback feedback--failure" role="alert">
      <h3 className="feedback__title">{title}</h3>
      <ul className="feedback__messages">
        {failureMessages(failure).map((message, index) => (
          <li key={`${String(index)}:${message}`}>
            {codes[index] !== undefined && <code>{codes[index]}</code>} {message}
          </li>
        ))}
      </ul>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          {retryLabel ?? 'Try again'}
        </button>
      )}
    </div>
  );
}
