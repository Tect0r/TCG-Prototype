import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import {
  DEFAULT_SERVER_URL,
  MatchClient,
  webSocketTransport,
  type MatchClientState,
  type TransportFactory,
} from '../net/match-client.js';

/**
 * Wires the transport-agnostic `MatchClient` into React. The client is created
 * once and subscribed to with `useSyncExternalStore`, so every component sees
 * exactly one authoritative snapshot per server message.
 */
const MatchContext = createContext<MatchClient | null>(null);

interface MatchProviderProps {
  readonly children: ReactNode;
  /** Injected in tests; defaults to a real WebSocket against the dev server. */
  readonly client?: MatchClient;
  readonly serverUrl?: string;
  readonly createTransport?: TransportFactory;
}

function sessionStorageOrNull(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function MatchProvider({
  children,
  client,
  serverUrl,
  createTransport,
}: MatchProviderProps) {
  const instance = useMemo(() => {
    if (client) return client;
    const storage = sessionStorageOrNull();
    return new MatchClient({
      createTransport: createTransport ?? webSocketTransport(serverUrl ?? DEFAULT_SERVER_URL),
      ...(storage ? { storage } : {}),
    });
  }, [client, createTransport, serverUrl]);

  useEffect(() => () => instance.disconnect(), [instance]);

  return <MatchContext.Provider value={instance}>{children}</MatchContext.Provider>;
}

export function useMatchClient(): MatchClient {
  const client = useContext(MatchContext);
  if (!client) throw new Error('useMatchClient must be used inside <MatchProvider>');
  return client;
}

export function useMatchState(): MatchClientState {
  const client = useMatchClient();
  return useSyncExternalStore(
    (listener) => client.subscribe(listener),
    () => client.state,
    () => client.state,
  );
}
