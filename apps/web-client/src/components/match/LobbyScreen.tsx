import { useState } from 'react';
import { useAppState, useCardDatabase } from '../../state/AppContext.js';
import { useMatchClient, useMatchState } from '../../state/MatchContext.js';
import { validateDeck } from '@tcg/deck';
import { RulebookPanel } from '../help/RulebookPanel.js';

/**
 * Create or join a private invite-code lobby, submit a deck, and ready up.
 *
 * Deck legality shown here is a convenience preview; the server validates
 * independently and its verdict is the one that counts (CLAUDE.md §11).
 *
 * The rulebook opens over the top of this screen rather than replacing it: a
 * player reading about blocking while three seats fill up must not lose their
 * lobby, their chosen deck or their place in it.
 */
export function LobbyScreen() {
  const client = useMatchClient();
  const { connection, lobby, seatId, lastError, deckError } = useMatchState();
  const { decks } = useAppState();
  const database = useCardDatabase();

  const [displayName, setDisplayName] = useState('Player');
  const [inviteCode, setInviteCode] = useState('');
  const [selectedDeckId, setSelectedDeckId] = useState<string>('');
  const [tableSize, setTableSize] = useState(2);
  const [rulebookOpen, setRulebookOpen] = useState(false);
  /** Remembered for this lobby session, so reopening lands where you left off. */
  const [rulebookSection, setRulebookSection] = useState<string | null>(null);

  const mySeat = lobby?.seats.find((seat) => seat.seatId === seatId);
  const isHost = mySeat?.isHost ?? false;
  const emptySeats = lobby ? lobby.maxSeats - lobby.seats.length : 0;
  const selectedDeck = decks.find((deck) => deck.id === selectedDeckId);
  const localReport = selectedDeck ? validateDeck(selectedDeck, database) : null;

  return (
    <section className="lobby" aria-label="Match lobby">
      <header className="lobby__header">
        <h2>Play a match</h2>
        <p className="lobby__status">
          Server: <strong>{connection}</strong>
        </p>
        <button type="button" className="lobby__rulebook" onClick={() => setRulebookOpen(true)}>
          Rulebook
        </button>
      </header>

      <RulebookPanel
        open={rulebookOpen}
        onClose={() => setRulebookOpen(false)}
        initialSectionId={rulebookSection}
        onSectionChange={setRulebookSection}
      />

      {lastError && (
        <p className="lobby__error" role="alert">
          {lastError.message}
          {'details' in lastError && lastError.details ? ` (${lastError.details.join('; ')})` : ''}
        </p>
      )}

      {!lobby ? (
        <div className="lobby__entry">
          <label className="field">
            <span>Display name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={24}
            />
          </label>

          <label className="field">
            <span>Players</span>
            <select
              value={tableSize}
              onChange={(event) => setTableSize(Number(event.target.value))}
            >
              <option value={2}>2 — one on one</option>
              <option value={3}>3 — free-for-all</option>
              <option value={4}>4 — free-for-all</option>
            </select>
          </label>

          <div className="lobby__actions">
            <button
              type="button"
              onClick={() => client.createLobby(displayName.trim() || 'Player', tableSize)}
              disabled={displayName.trim().length === 0}
            >
              Create a lobby
            </button>

            <div className="lobby__join">
              <label className="field">
                <span>Invite code</span>
                <input
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
                  maxLength={6}
                  placeholder="ABC123"
                />
              </label>
              <button
                type="button"
                onClick={() => client.joinLobby(inviteCode, displayName.trim() || 'Player')}
                disabled={inviteCode.trim().length !== 6}
              >
                Join
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="lobby__room">
          <p className="lobby__code">
            Invite code: <strong>{lobby.inviteCode}</strong> — share it with the other{' '}
            {lobby.maxSeats - 1 === 1 ? 'player' : `${lobby.maxSeats - 1} players`}.
          </p>

          {isHost && lobby.status !== 'in_match' && (
            <label className="field">
              <span>Table size</span>
              <select
                value={lobby.maxSeats}
                onChange={(event) => client.setMaxSeats(Number(event.target.value))}
              >
                {[2, 3, 4]
                  .filter((size) => size >= lobby.seats.length)
                  .map((size) => (
                    <option key={size} value={size}>
                      {size} players
                    </option>
                  ))}
              </select>
            </label>
          )}

          <ul className="lobby__seats">
            {lobby.seats.map((seat) => (
              <li key={seat.seatId} className="lobby__seat">
                <span className="lobby__seat-name">
                  {seat.displayName}
                  {seat.seatId === seatId ? ' (you)' : ''}
                  {seat.isHost ? ' · host' : ''}
                </span>
                <span className={seat.connected ? 'tag tag--ok' : 'tag tag--warn'}>
                  {seat.connected ? 'connected' : 'disconnected'}
                </span>
                <span className="tag">{seat.deckName ?? 'no deck'}</span>
                {seat.deckName && (
                  <span className={seat.deckLegal ? 'tag tag--ok' : 'tag tag--error'}>
                    {seat.deckLegal ? 'legal' : 'illegal'}
                  </span>
                )}
                <span className={seat.ready ? 'tag tag--ok' : 'tag'}>
                  {seat.ready ? 'ready' : 'not ready'}
                </span>
              </li>
            ))}
            {Array.from({ length: Math.max(0, emptySeats) }, (_, index) => (
              <li key={`empty_${index}`} className="lobby__seat lobby__seat--empty">
                Waiting for a player…
              </li>
            ))}
          </ul>

          <div className="lobby__deck">
            <label className="field">
              <span>Deck</span>
              <select
                value={selectedDeckId}
                onChange={(event) => setSelectedDeckId(event.target.value)}
              >
                <option value="">Choose a deck…</option>
                {decks.map((deck) => (
                  <option key={deck.id} value={deck.id}>
                    {deck.name}
                  </option>
                ))}
              </select>
            </label>

            {localReport && !localReport.legal && (
              <p className="lobby__error">
                This deck is not legal yet: {localReport.issues[0]?.message}
              </p>
            )}
            {deckError && (
              <p className="lobby__error" role="alert">
                {deckError.message}
                {deckError.details ? ` ${deckError.details.join(' ')}` : ''}
              </p>
            )}

            <div className="lobby__actions">
              <button
                type="button"
                onClick={() => selectedDeck && client.submitDeck(selectedDeck)}
                disabled={!selectedDeck}
              >
                Submit deck
              </button>
              <button
                type="button"
                onClick={() => client.setReady(!mySeat?.ready)}
                disabled={!mySeat?.deckLegal}
              >
                {mySeat?.ready ? 'Not ready' : 'Ready'}
              </button>
              {/* A larger table does not start by itself: two of four seats
                  being ready is a legal state the host may still be filling. */}
              {isHost && lobby.maxSeats > 2 && (
                <button
                  type="button"
                  onClick={() => client.startMatch()}
                  disabled={!lobby.canStart}
                >
                  Start match ({lobby.seats.length} players)
                </button>
              )}
              <button type="button" className="button--quiet" onClick={() => client.leave()}>
                Leave lobby
              </button>
            </div>
          </div>
        </div>
      )}

      {decks.length === 0 && (
        <p className="lobby__hint">
          You have no saved decks yet. Build one in the Deck Builder tab first.
        </p>
      )}
    </section>
  );
}
