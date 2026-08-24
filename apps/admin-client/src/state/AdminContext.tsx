import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { AdminSession, type AdminSessionState } from '../net/session.js';
import { browserTransport, type AdminTransport } from '../net/transport.js';

/**
 * Wires the React-free `AdminSession` into React.
 *
 * One instance, subscribed to with `useSyncExternalStore`, so every component
 * sees the same snapshot for the same answer — the pattern `MatchProvider`
 * already uses in the player client, for the same reason: the rules of a network
 * boundary should be testable without a DOM, and the components should be pure
 * renderers of authoritative data.
 *
 * The first `connect()` happens here rather than in a screen, because "ask the
 * service what it is" is what this application *does* before it can honestly
 * render anything at all.
 */
const AdminContext = createContext<AdminSession | null>(null);

interface AdminProviderProps {
  readonly children: ReactNode;
  /** Injected in tests; defaults to a real session over this page's own origin. */
  readonly session?: AdminSession;
  readonly transport?: AdminTransport;
}

export function AdminProvider({ children, session, transport }: AdminProviderProps) {
  const instance = useMemo(
    () => session ?? new AdminSession({ transport: transport ?? browserTransport() }),
    [session, transport],
  );

  useEffect(() => {
    void instance.connect();
  }, [instance]);

  return <AdminContext.Provider value={instance}>{children}</AdminContext.Provider>;
}

export function useAdminSession(): AdminSession {
  const session = useContext(AdminContext);
  if (!session) throw new Error('useAdminSession must be used inside <AdminProvider>');
  return session;
}

export function useAdminState(): AdminSessionState {
  const session = useAdminSession();
  return useSyncExternalStore(
    (listener) => session.subscribe(listener),
    () => session.state,
    () => session.state,
  );
}
