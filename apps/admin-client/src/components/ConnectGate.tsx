import { useId, useState } from 'react';

import { Busy, Failure } from './Feedback.js';
import { useAdminSession, useAdminState } from '../state/AdminContext.js';

/**
 * What the application is before it has an answer: asking, asking for a token,
 * or unable to reach the lab at all.
 *
 * It replaces the whole shell rather than sitting inside it, and that is the
 * tranche's rule applied to itself — *a usable, protected, responsive admin
 * surface that does not pretend unfinished pages work*. A navigation rail beside
 * an empty page would be offering destinations that cannot be reached, and the
 * one honest thing to show while there is no connection is the reason there
 * isn't one.
 *
 * ## The token is asked for only when the service asks for it
 *
 * There is no "do you need a token?" setting here. The first request goes out
 * without one; a loopback lab with no token configured answers it, and an
 * operator running the ordinary local process never sees this form at all. A
 * service that requires one refuses with `admin/unauthorized`, and *that* is
 * what puts the field on the screen. The client never predicts the access
 * policy — `access.authenticationRequired` is a report the service makes about
 * itself, and asking is the only way to obtain it.
 *
 * ## What the field does not do
 *
 * It does not remember. There is no "keep me signed in", because ADR 0023 §4
 * puts the token in no place the browser persists, and a checkbox offering
 * otherwise would be offering to break that. It does not validate the token's
 * shape either: the length rule is the service's, and a second copy of it here
 * would be a client that can refuse a token the service would have accepted.
 * What it will not do is send an empty field, which is not a policy but the
 * absence of anything to send.
 */
export function ConnectGate() {
  const session = useAdminSession();
  const state = useAdminState();
  const [token, setToken] = useState('');
  const fieldId = useId();

  const connection = state.connection;

  return (
    <div className="gate">
      <header className="gate__banner">
        <p className="admin__product">AI Lab</p>
        <p className="admin__scope">Administrator surface · local orchestration process</p>
      </header>

      <main className="gate__body" id="admin-main">
        {(connection.status === 'idle' || connection.status === 'connecting') && (
          <Busy label="Asking the orchestration process what it is…" />
        )}

        {connection.status === 'unavailable' && (
          <>
            <h1>The lab did not answer</h1>
            <Failure
              title="No connection to the orchestration process"
              failure={connection.failure}
              {...(connection.failure.kind === 'version'
                ? {}
                : {
                    onRetry: () => {
                      void session.connect();
                    },
                    retryLabel: 'Try again',
                  })}
            />
            {connection.failure.kind === 'version' && (
              <p className="gate__hint">
                Asking again cannot help: the two builds do not speak the same admin contract
                version. Run the client and the orchestration process from the same revision.
              </p>
            )}
          </>
        )}

        {connection.status === 'needs_token' && (
          <>
            <h1>This lab requires an administrator token</h1>
            <p className="gate__hint">
              The token is configured on the orchestration process, out of band. It is sent as a
              request header, is held in this tab only, and is not stored anywhere the browser keeps
              — so it has to be entered again after a reload.
            </p>
            {connection.failure !== null && (
              <Failure title="That token was refused" failure={connection.failure} />
            )}
            <form
              className="gate__form"
              onSubmit={(event) => {
                event.preventDefault();
                if (token.trim() === '') return;
                void session.connect(token);
                setToken('');
              }}
            >
              <label htmlFor={fieldId}>Administrator token</label>
              <input
                id={fieldId}
                type="password"
                value={token}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setToken(event.target.value)}
              />
              <button type="submit" className="primary" disabled={token.trim() === ''}>
                Connect
              </button>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
