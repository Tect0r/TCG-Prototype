import { useEffect } from 'react';
import { useMatchClient, useMatchState } from '../../state/MatchContext.js';
import { LobbyScreen } from './LobbyScreen.js';
import { MatchBoard } from './MatchBoard.js';

/**
 * Chooses between the lobby and the board, and opens the connection on first
 * mount so a refresh mid-match reconnects automatically with the stored token.
 */
export function MatchScreen() {
  const client = useMatchClient();
  const { view, connection } = useMatchState();

  useEffect(() => {
    if (connection === 'idle') client.connect();
  }, [client, connection]);

  if (connection === 'closed' && !view) {
    return (
      <section className="lobby">
        <h2>Not connected</h2>
        <p>
          The match server is unreachable. Start it with <code>npm run dev:server</code>, then
          retry.
        </p>
        <button type="button" onClick={() => client.connect()}>
          Retry
        </button>
      </section>
    );
  }

  return view ? <MatchBoard /> : <LobbyScreen />;
}
