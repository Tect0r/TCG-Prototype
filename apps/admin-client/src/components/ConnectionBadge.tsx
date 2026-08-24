import type { Capabilities } from '@tcg/admin-contracts';

import { useAdminSession } from '../state/AdminContext.js';

/**
 * The banner's statement of where this page stands with the lab, and the two
 * controls that change it.
 *
 * It lives in the shell rather than on the Overview because it is true of every
 * screen: an operator reading a queue or a result needs the same answer to *am I
 * connected, to what, and how old is this*. Putting it here also keeps one copy
 * of the two verbs — ask again, and stop holding the token — instead of one per
 * page.
 *
 * The time is printed as UTC rather than in the reader's locale, and the whole
 * timestamp is on the Overview beside it. A lab's other timestamps — a job's
 * `createdAt`, a run's manifest — are ISO instants, and a banner that localised
 * this one would be the only clock on the surface reading differently from the
 * records underneath it.
 */

interface ConnectionBadgeProps {
  readonly capabilities: Capabilities;
  readonly checkedAt: string;
  readonly authenticated: boolean;
  readonly busy: boolean;
}

export function ConnectionBadge({
  capabilities,
  checkedAt,
  authenticated,
  busy,
}: ConnectionBadgeProps) {
  const session = useAdminSession();
  const access = capabilities.access.loopback ? 'loopback' : `bound off loopback`;
  const auth = capabilities.access.authenticationRequired ? 'token required' : 'no token required';

  return (
    <div className="badge">
      <p className="badge__state">
        <span className="badge__dot" aria-hidden="true" />
        Connected · {access} · {auth}
      </p>
      <p className="badge__checked">Checked {timeOf(checkedAt)} UTC</p>
      <div className="badge__actions">
        <button
          type="button"
          onClick={() => {
            void session.refresh();
          }}
          disabled={busy}
        >
          Check again
        </button>
        {authenticated && (
          <button
            type="button"
            onClick={() => {
              session.forget();
            }}
          >
            Forget token
          </button>
        )}
      </div>
    </div>
  );
}

/** The `HH:MM:SS` of an ISO instant, or the whole string when it is not one. */
function timeOf(instant: string): string {
  const time = /T(\d{2}:\d{2}:\d{2})/.exec(instant);
  return time?.[1] ?? instant;
}
