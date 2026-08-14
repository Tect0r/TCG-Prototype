import { useEffect, useMemo, useState } from 'react';
import { preconsForFormat } from '@tcg/card-data';
import {
  AVAILABLE_DIFFICULTIES,
  BOT_CONFIG_SCHEMA_VERSION,
  BOT_STYLES,
  DEFAULT_BOT_DIFFICULTY,
  DIFFICULTY_REGISTRY_VERSION,
  IMMEDIATE_BOT_PACING,
  botStyleDefinition,
  difficultyDefinition,
  type BotDifficulty,
  type BotStyle,
} from '@tcg/bot-config';
import type { BotLobbySeatView, BotSetup, LobbyView, ProtocolError } from '@tcg/protocol';
import { useCardDatabase, useDeckFormat } from '../../state/AppContext.js';
import { useMatchClient } from '../../state/MatchContext.js';
import { botSeatLabels } from '../../lib/bot-seat-labels.js';

/**
 * The host's bot controls (M09.5) — the first playable checkpoint's whole UI.
 *
 * **Only what this build can honour is on screen.** The deck control is a precon
 * picker because `exact_precon` is the only supported deck mode; the difficulty
 * control is built from `AVAILABLE_DIFFICULTIES` so Easy and Hard are absent
 * rather than present-and-refused; and there is no timing control at all,
 * because pacing is not live yet. The alternative — showing every eventual
 * option disabled — would be decoration that the server would answer with a
 * named refusal, and the milestone rules it out.
 *
 * Each of those three follows from data rather than from a list written here, so
 * M09.6, M09.9, M09.11 and M09.13 turn their own control on by flipping the
 * entry they already own.
 *
 * **One bot.** M09.5 is one human against one precon bot; the Add control is
 * absent once a seat holds a bot, and M09.7 is what opens the table to more.
 *
 * The panel never decides whether a configuration is legal. It sends what the
 * host chose and prints what the server said back, because the server is the
 * authority on deck legality, seat allocation and supported modes (CLAUDE.md §11).
 */

/** The three things a host chooses in this build. Not a `BotSetup`: that is derived. */
interface BotDraft {
  readonly preconId: string;
  readonly difficulty: BotDifficulty;
  readonly style: BotStyle;
}

/**
 * The four refusals that can only ever be about a bot seat.
 *
 * `protocol/lobby_full`, `protocol/not_host` and `protocol/already_started` are
 * deliberately not here: M09.2 reused them precisely because they say the same
 * thing about the sender or the lobby whatever caused them, so routing them to
 * this panel would sometimes attribute a lobby-wide refusal to the bot form. The
 * screen's own alert keeps those.
 */
const BOT_ERROR_CODES = [
  'protocol/unknown_bot_seat',
  'protocol/bot_config_invalid',
  'protocol/bot_deck_illegal',
  'protocol/bot_mode_unsupported',
] as const;

export function isBotSeatError(error: { code: string } | null): error is ProtocolError {
  return error !== null && (BOT_ERROR_CODES as readonly string[]).includes(error.code);
}

/** Everything on the wire except the identity the server owns. */
function setupFrom(draft: BotDraft): BotSetup {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    // The server names the seat. A host who wants to name it is M09.16's.
    displayName: null,
    difficulty: draft.difficulty,
    style: draft.style,
    deck: { mode: 'exact_precon', preconId: draft.preconId },
    // Instant, and the only pacing this build honours. M09.11 adds the dial.
    pacing: IMMEDIATE_BOT_PACING,
  };
}

function sameDraft(a: BotDraft, b: BotDraft): boolean {
  return a.preconId === b.preconId && a.difficulty === b.difficulty && a.style === b.style;
}

export interface BotSeatPanelProps {
  readonly lobby: LobbyView;
  /** The bot refusal to print, or null. Chosen by `isBotSeatError`. */
  readonly error: ProtocolError | null;
}

export function BotSeatPanel({ lobby, error }: BotSeatPanelProps) {
  const client = useMatchClient();
  const database = useCardDatabase();
  const deckFormat = useDeckFormat();

  // The same format-scoped list the human deck picker and the server offer, so
  // the three cannot disagree about which decks exist (M03.2).
  const precons = useMemo(() => preconsForFormat(deckFormat.formatId), [deckFormat.formatId]);

  const botSeat = lobby.seats.find((seat): seat is BotLobbySeatView => seat.controller === 'bot');
  const seated = botSeat?.bot ?? null;
  const seatedDraft: BotDraft | null =
    seated && seated.deck.mode === 'exact_precon'
      ? { preconId: seated.deck.preconId, difficulty: seated.difficulty, style: seated.style }
      : null;

  const [edited, setEdited] = useState<BotDraft | null>(null);
  /** Which request is in flight, so a double press cannot seat two bots. */
  const [pending, setPending] = useState<'add' | 'update' | 'remove' | null>(null);

  // The server's answer — a new lobby view, or a refusal — is what ends the
  // wait. There is no per-request acknowledgement on this wire, and inventing
  // one would put a second idea of "the current configuration" on the client.
  const answered = JSON.stringify(lobby.seats);
  useEffect(() => {
    setPending(null);
  }, [answered, error]);

  const fallback: BotDraft = {
    preconId: precons[0]?.id ?? '',
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style: BOT_STYLES[0],
  };
  const draft = edited ?? seatedDraft ?? fallback;

  const locked = lobby.status === 'in_match' || lobby.status === 'finished';
  const tableFull = lobby.seats.length >= lobby.maxSeats;
  const canEdit = !locked && pending === null;
  const changed = seatedDraft !== null && !sameDraft(draft, seatedDraft);

  if (precons.length === 0) {
    return (
      <section className="lobby__bots" aria-label="Bot opponent">
        <h3>Bot opponent</h3>
        <p className="lobby__hint">
          No built-in decks are published for this format, so there is nothing for a bot to play.
        </p>
      </section>
    );
  }

  if (locked) {
    return (
      <section className="lobby__bots" aria-label="Bot opponent">
        <h3>Bot opponent</h3>
        <p className="lobby__hint">
          {seated
            ? 'The match has started; this bot’s settings are locked for the rest of it.'
            : 'The match has started. Bots can only be added before it does.'}
        </p>
      </section>
    );
  }

  const update = (change: Partial<BotDraft>): void => setEdited({ ...draft, ...change });

  return (
    <section className="lobby__bots" aria-label="Bot opponent">
      <h3>Bot opponent</h3>

      {seated ? (
        <p className="lobby__hint">
          <strong>{seated.displayName}</strong> is in {botSeat?.seatId.replace('seat_', 'seat ')},
          playing {botSeatLabels(seated, database).deckName ?? 'a deck of its own'}. This build
          seats one bot.
        </p>
      ) : (
        <p className="lobby__hint">
          Play against the software: pick a built-in deck and how it should play. Bots answer
          immediately — how long they take is not configurable yet.
        </p>
      )}

      <label className="field">
        <span>Bot deck</span>
        <select
          value={draft.preconId}
          disabled={!canEdit}
          onChange={(event) => update({ preconId: event.target.value })}
        >
          {precons.map((precon) => (
            <option key={precon.id} value={precon.id}>
              {precon.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Bot difficulty</span>
        <select
          value={draft.difficulty}
          disabled={!canEdit}
          onChange={(event) => {
            // Looked up rather than cast: the value that comes back is a string,
            // and the only difficulties this control may produce are the ones it
            // offered.
            const difficulty = AVAILABLE_DIFFICULTIES.find((id) => id === event.target.value);
            if (difficulty) update({ difficulty });
          }}
        >
          {/* Available ones only. A difficulty with no decision procedure behind
              it is refused by the server, so offering it would be a control
              whose only outcome is an error message. */}
          {AVAILABLE_DIFFICULTIES.map((difficulty) => (
            <option key={difficulty} value={difficulty}>
              {difficultyDefinition(difficulty).label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>Bot style</span>
        <select
          value={draft.style}
          disabled={!canEdit}
          onChange={(event) => {
            const style = BOT_STYLES.find((id) => id === event.target.value);
            if (style) update({ style });
          }}
        >
          {BOT_STYLES.map((style) => (
            <option key={style} value={style}>
              {botStyleDefinition(style).label}
            </option>
          ))}
        </select>
      </label>

      <p className="lobby__hint">{botStyleDefinition(draft.style).summary}</p>

      {error && (
        <p className="lobby__error" role="alert">
          {error.message}
          {error.details ? ` ${error.details.join(' ')}` : ''}
        </p>
      )}

      <div className="lobby__actions">
        {seated && botSeat ? (
          <>
            <button
              type="button"
              onClick={() => {
                setPending('update');
                client.updateBot(botSeat.seatId, setupFrom(draft));
              }}
              disabled={!canEdit || !changed}
            >
              {pending === 'update' ? 'Applying…' : 'Apply bot changes'}
            </button>
            <button
              type="button"
              className="button--quiet"
              onClick={() => {
                setPending('remove');
                setEdited(null);
                client.removeBot(botSeat.seatId);
              }}
              disabled={!canEdit}
            >
              {pending === 'remove' ? 'Removing…' : 'Remove bot'}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              setPending('add');
              client.addBot(setupFrom(draft));
            }}
            disabled={!canEdit || tableFull}
          >
            {pending === 'add' ? 'Adding…' : 'Add a bot'}
          </button>
        )}
      </div>

      {!seated && tableFull && (
        <p className="lobby__hint">
          Every seat at this table is taken. Make the table bigger, or wait for a seat to open.
        </p>
      )}
    </section>
  );
}
