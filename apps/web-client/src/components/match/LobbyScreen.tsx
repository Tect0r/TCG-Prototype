import { useMemo, useState } from 'react';
import { useAppState, useCardDatabase, useDeckFormat } from '../../state/AppContext.js';
import { useMatchClient, useMatchState } from '../../state/MatchContext.js';
import { preconsForFormat } from '@tcg/card-data';
import { reviewPrecon, validateDeck } from '@tcg/deck';
import { RulebookPanel } from '../help/RulebookPanel.js';
import { BotSeatPanel, isBotSeatError } from './BotSeatPanel.js';
import { botSeatLabels } from '../../lib/bot-seat-labels.js';
import { compactPacingLabel } from '../../lib/bot-pacing-labels.js';

/**
 * What the deck picker is currently pointing at.
 *
 * A precon is chosen by permanent ID rather than by a copy of its list: the
 * server resolves the ID against its own content, so what it validates is the
 * shipped definition this screen previewed (M03.2). A player who has edited a
 * precon is choosing their saved deck instead, which travels by contents.
 */
const PRECON_PREFIX = 'precon:';
const DECK_PREFIX = 'deck:';

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
  // The same format the builder validated against. Defaulting here instead
  // would let the preview pass a deck the server then rejects.
  const deckFormat = useDeckFormat();

  const [displayName, setDisplayName] = useState('Player');
  const [inviteCode, setInviteCode] = useState('');
  /** Prefixed, because a precon ID and a saved-deck ID are different things. */
  const [selection, setSelection] = useState<string>('');
  const [tableSize, setTableSize] = useState(2);
  const [rulebookOpen, setRulebookOpen] = useState(false);
  /** Remembered for this lobby session, so reopening lands where you left off. */
  const [rulebookSection, setRulebookSection] = useState<string | null>(null);

  const mySeat = lobby?.seats.find((seat) => seat.seatId === seatId);
  const isHost = mySeat?.isHost ?? false;
  const emptySeats = lobby ? lobby.maxSeats - lobby.seats.length : 0;

  // Scoped to the active format exactly like the builder's precon browser and
  // the server's own list, so the three cannot offer different decks (M03.2).
  const precons = useMemo(() => preconsForFormat(deckFormat.formatId), [deckFormat.formatId]);

  const selectedDeck = selection.startsWith(DECK_PREFIX)
    ? decks.find((deck) => deck.id === selection.slice(DECK_PREFIX.length))
    : undefined;
  const selectedPrecon = selection.startsWith(PRECON_PREFIX)
    ? precons.find((precon) => precon.id === selection.slice(PRECON_PREFIX.length))
    : undefined;

  // The same preview in both cases, from the same shared functions the server
  // runs. It is still only a preview: the server's verdict is the one that
  // counts, and it re-runs these against its own pool.
  const localReport = selectedDeck
    ? validateDeck(selectedDeck, database, deckFormat)
    : selectedPrecon
      ? reviewPrecon(selectedPrecon, database, deckFormat)
      : null;

  const submit = (): void => {
    if (selectedDeck) client.submitDeck(selectedDeck);
    else if (selectedPrecon) client.submitPrecon(selectedPrecon.id);
  };

  // A refusal about a bot seat belongs beside the bot form, not in the banner at
  // the top of a screen that is mostly about the player's own deck. Only the
  // four codes that can *only* mean a bot move there; the three M09.2
  // deliberately reused stay here, because they say the same thing about the
  // lobby whatever caused them.
  const botError = isBotSeatError(lastError) ? lastError : null;
  const screenError = botError ? null : lastError;

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

      {screenError && (
        <p className="lobby__error" role="alert">
          {screenError.message}
          {'details' in screenError && screenError.details
            ? ` (${screenError.details.join('; ')})`
            : ''}
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

          <ul className="lobby__seats" aria-label="Seats">
            {lobby.seats.map((seat) => {
              // Read from the seat's public projection, which carries no card
              // list, seed or hash to leak (ADR 0024 §3).
              const bot = seat.controller === 'bot' ? botSeatLabels(seat.bot, database) : null;
              // Public, like the difficulty and the style beside it: how long a
              // bot takes is observable from the other side of the table, and
              // the seconds travel with the percentage so it is a number
              // somebody can read (M09.11).
              const botTiming =
                seat.controller === 'bot'
                  ? compactPacingLabel(seat.bot.pacing, lobby.botPacing)
                  : null;
              return (
                <li key={seat.seatId} className="lobby__seat">
                  <span className="lobby__seat-name">
                    {seat.displayName}
                    {seat.seatId === seatId ? ' (you)' : ''}
                    {seat.isHost ? ' · host' : ''}
                  </span>
                  {/* What is in the seat, said rather than inferred from the
                      absence of a disconnect tag. */}
                  {bot ? (
                    <span className="tag tag--bot">bot</span>
                  ) : (
                    <span className={seat.connected ? 'tag tag--ok' : 'tag tag--warn'}>
                      {seat.connected ? 'connected' : 'disconnected'}
                    </span>
                  )}
                  {bot ? (
                    <>
                      <span className="tag">{bot.deckName ?? 'deck hidden'}</span>
                      {bot.commanderName && <span className="tag">{bot.commanderName}</span>}
                      <span className="tag">{bot.difficulty}</span>
                      <span className="tag">{bot.style}</span>
                      {botTiming && <span className="tag">{botTiming}</span>}
                    </>
                  ) : (
                    <span className="tag">{seat.deckName ?? 'no deck'}</span>
                  )}
                  {/* A bot seat always has a verdict: the server resolved and
                      validated its deck before seating it, whether or not the
                      mode publishes a name. A human seat may simply not have
                      submitted anything yet. */}
                  {(bot !== null || seat.deckName !== null) && (
                    <span className={seat.deckLegal ? 'tag tag--ok' : 'tag tag--error'}>
                      {seat.deckLegal ? 'legal' : 'illegal'}
                    </span>
                  )}
                  <span className={seat.ready ? 'tag tag--ok' : 'tag'}>
                    {seat.ready ? 'ready' : 'not ready'}
                  </span>
                </li>
              );
            })}
            {Array.from({ length: Math.max(0, emptySeats) }, (_, index) => (
              <li key={`empty_${index}`} className="lobby__seat lobby__seat--empty">
                Waiting for a player…
              </li>
            ))}
          </ul>

          {/* Host-only, because every bot message is host-only on the wire and
              the server refuses the rest by name (M09.2). A guest sees the bot
              seat in the list above, and no controls for it. */}
          {isHost && <BotSeatPanel lobby={lobby} error={botError} />}

          <div className="lobby__deck">
            <label className="field">
              <span>Deck</span>
              <select value={selection} onChange={(event) => setSelection(event.target.value)}>
                <option value="">Choose a deck…</option>
                {precons.length > 0 && (
                  <optgroup label="Precons">
                    {precons.map((precon) => (
                      <option key={precon.id} value={`${PRECON_PREFIX}${precon.id}`}>
                        {precon.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {decks.length > 0 && (
                  <optgroup label="Your decks">
                    {decks.map((deck) => (
                      <option key={deck.id} value={`${DECK_PREFIX}${deck.id}`}>
                        {deck.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>

            {selectedPrecon && (
              <p className="lobby__hint">
                Playing the built-in <code>{selectedPrecon.id}</code> as printed. Copy it in the
                Deck Builder first if you want to change it.
              </p>
            )}

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
              <button type="button" onClick={submit} disabled={!selectedDeck && !selectedPrecon}>
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
                  being ready is a legal state the host may still be filling.

                  A two-seat table starts itself when the *human* readies up,
                  which is the last thing that happens in the ordinary flow. It
                  is not the last thing when the host readies first and then
                  seats a bot, so the button also appears whenever the server
                  says the host could start right now — never disabled, because
                  in that case it is the only way out. */}
              {isHost && (lobby.maxSeats > 2 || lobby.canStart) && (
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
          You have no saved decks yet. Play a built-in precon as it comes, or build your own in the
          Deck Builder tab.
        </p>
      )}
    </section>
  );
}
