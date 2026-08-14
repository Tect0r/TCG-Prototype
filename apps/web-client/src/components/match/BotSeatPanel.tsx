import { useEffect, useMemo, useState } from 'react';
import { preconsForFormat } from '@tcg/card-data';
import {
  AVAILABLE_DIFFICULTIES,
  BOT_CONFIG_SCHEMA_VERSION,
  BOT_DECK_MODES,
  BOT_STYLES,
  DECK_MODE_SUPPORT,
  DEFAULT_BOT_DIFFICULTY,
  DIFFICULTY_REGISTRY_VERSION,
  IMMEDIATE_BOT_PACING,
  botStyleDefinition,
  difficultyDefinition,
  type BotDeckMode,
  type BotDeckSource,
  type BotDifficulty,
  type BotStyle,
} from '@tcg/bot-config';
import type { BotLobbySeatView, BotSetup, LobbyView, ProtocolError } from '@tcg/protocol';
import { useAppState, useCardDatabase, useDeckFormat } from '../../state/AppContext.js';
import { useMatchClient, useMatchState } from '../../state/MatchContext.js';
import { botSeatLabels } from '../../lib/bot-seat-labels.js';
import { reviewSavedDeckForBot, snapshotIsStale } from '../../lib/bot-deck-snapshot.js';

/**
 * The host's bot controls (M09.5, extended by M09.6).
 *
 * **Only what this build can honour is on screen.** The deck-source control is
 * built from `DECK_MODE_SUPPORT` and the labels below, so a mode with no
 * resolver behind it is absent rather than present-and-refused; the difficulty
 * control is built from `AVAILABLE_DIFFICULTIES`, so Easy and Hard are absent
 * for the same reason; and there is no timing control at all, because pacing is
 * not live yet. The alternative — showing every eventual option disabled — would
 * be decoration that the server would answer with a named refusal, and the
 * milestone rules it out.
 *
 * Each of those follows from data rather than from a list written here, so
 * M09.9, M09.11 and M09.13 turn their own control on by flipping the entry they
 * already own — which is exactly how M09.6 turned its own on.
 *
 * **One bot.** M09.5 is one human against one bot; the Add control is absent
 * once a seat holds a bot, and M09.7 is what opens the table to more.
 *
 * **A saved deck is frozen, not referenced** (M09.6). What travels is an
 * immutable copy of the list as it was when the host chose it, so a later edit
 * in the Deck Builder cannot reach a configured or a live bot. The panel says so
 * when the source deck has since changed, and offers to send the new list rather
 * than doing it silently.
 *
 * The panel never decides whether a configuration is legal. The local preview
 * for a saved deck exists so the host is not told about a problem they could
 * have seen before pressing a button; the server re-derives the fingerprint and
 * re-runs `validateDeck` against its own pool, and its verdict is the one that
 * counts (CLAUDE.md §11).
 */

/**
 * What each deck mode is called in the picker, and `null` for the modes this
 * screen cannot build a configuration for yet.
 *
 * A total map rather than a list of the finished ones: a mode that becomes
 * supported without a control is then a visible `null` here instead of an option
 * that quietly never appears.
 */
const DECK_MODE_LABELS: Readonly<Record<BotDeckMode, string | null>> = {
  exact_precon: 'A built-in deck',
  exact_saved_deck: 'One of your saved decks',
  /** M09.9 chooses the Commander and owns this control. */
  commander_generated: null,
  /** M09.10 lets the bot choose both and owns this one. */
  autonomous_generated: null,
};

const OFFERED_DECK_MODES = BOT_DECK_MODES.filter(
  (mode) => DECK_MODE_SUPPORT[mode].supported && DECK_MODE_LABELS[mode] !== null,
);

/** What a host chooses. Not a `BotSetup`: that is derived, and carries contents. */
type BotDeckDraft =
  | { readonly mode: 'exact_precon'; readonly preconId: string }
  | { readonly mode: 'exact_saved_deck'; readonly savedDeckId: string };

interface BotDraft {
  readonly deck: BotDeckDraft;
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
function setupFrom(draft: BotDraft, deck: BotDeckSource): BotSetup {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    // The server names the seat. A host who wants to name it is M09.16's.
    displayName: null,
    difficulty: draft.difficulty,
    style: draft.style,
    deck,
    // Instant, and the only pacing this build honours. M09.11 adds the dial.
    pacing: IMMEDIATE_BOT_PACING,
  };
}

function sameDeckDraft(a: BotDeckDraft, b: BotDeckDraft): boolean {
  if (a.mode === 'exact_precon') return b.mode === 'exact_precon' && a.preconId === b.preconId;
  return b.mode === 'exact_saved_deck' && a.savedDeckId === b.savedDeckId;
}

function sameDraft(a: BotDraft, b: BotDraft): boolean {
  return a.difficulty === b.difficulty && a.style === b.style && sameDeckDraft(a.deck, b.deck);
}

export interface BotSeatPanelProps {
  readonly lobby: LobbyView;
  /** The bot refusal to print, or null. Chosen by `isBotSeatError`. */
  readonly error: ProtocolError | null;
}

export function BotSeatPanel({ lobby, error }: BotSeatPanelProps) {
  const client = useMatchClient();
  const { botDeckSources } = useMatchState();
  const database = useCardDatabase();
  const deckFormat = useDeckFormat();
  const { decks } = useAppState();

  // The same format-scoped list the human deck picker and the server offer, so
  // the three cannot disagree about which decks exist (M03.2).
  const precons = useMemo(() => preconsForFormat(deckFormat.formatId), [deckFormat.formatId]);

  const botSeat = lobby.seats.find((seat): seat is BotLobbySeatView => seat.controller === 'bot');
  const seated = botSeat?.bot ?? null;

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

  /**
   * The private half of the seated bot's configuration, from the client rather
   * than from this component: the wire does not publish it, and the host edits
   * the deck it names on a different screen, which unmounts this one.
   */
  const applied = botSeat ? (botDeckSources[botSeat.seatId] ?? null) : null;
  const appliedSnapshot = applied?.mode === 'exact_saved_deck' ? applied.deck : null;

  const seatedDraft: BotDraft | null = seated
    ? seated.deck.mode === 'exact_precon'
      ? {
          deck: { mode: 'exact_precon', preconId: seated.deck.preconId },
          difficulty: seated.difficulty,
          style: seated.style,
        }
      : seated.deck.mode === 'exact_saved_deck' && appliedSnapshot
        ? {
            deck: { mode: 'exact_saved_deck', savedDeckId: appliedSnapshot.sourceDeckId },
            difficulty: seated.difficulty,
            style: seated.style,
          }
        : null
    : null;

  // Whichever offered mode this build actually has something to put in it. A
  // format publishing no precons is not a reason to default to an empty picker.
  const fallback: BotDraft = {
    deck:
      precons.length > 0
        ? { mode: 'exact_precon', preconId: precons[0]?.id ?? '' }
        : { mode: 'exact_saved_deck', savedDeckId: decks[0]?.id ?? '' },
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style: BOT_STYLES[0],
  };
  const draft = edited ?? seatedDraft ?? fallback;

  const savedReview =
    draft.deck.mode === 'exact_saved_deck'
      ? reviewSavedDeckForBot(draft.deck.savedDeckId, decks, database, deckFormat)
      : null;
  const deckSource: BotDeckSource | null =
    draft.deck.mode === 'exact_precon'
      ? draft.deck.preconId
        ? { mode: 'exact_precon', preconId: draft.deck.preconId }
        : null
      : savedReview?.snapshot
        ? { mode: 'exact_saved_deck', deck: savedReview.snapshot }
        : null;

  /** The frozen list no longer matches the deck it was taken from. */
  const frozenIsStale = appliedSnapshot !== null && snapshotIsStale(appliedSnapshot, decks);

  const locked = lobby.status === 'in_match' || lobby.status === 'finished';
  const tableFull = lobby.seats.length >= lobby.maxSeats;
  const canEdit = !locked && pending === null;
  // A saved deck that has since been edited is "changed" even when the host
  // picked the same deck: applying re-freezes it, which is the only way to move
  // a configured bot onto the new list.
  const changed =
    seatedDraft === null ||
    !sameDraft(draft, seatedDraft) ||
    (frozenIsStale && deckSource !== null);

  if (precons.length === 0 && decks.length === 0) {
    return (
      <section className="lobby__bots" aria-label="Bot opponent">
        <h3>Bot opponent</h3>
        <p className="lobby__hint">
          No built-in decks are published for this format and you have saved none, so there is
          nothing for a bot to play.
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

  const chooseMode = (mode: BotDeckMode): void => {
    if (mode === draft.deck.mode) return;
    if (mode === 'exact_precon') {
      update({ deck: { mode, preconId: precons[0]?.id ?? '' } });
    } else if (mode === 'exact_saved_deck') {
      update({ deck: { mode, savedDeckId: decks[0]?.id ?? '' } });
    }
  };

  const send = (kind: 'add' | 'update'): void => {
    if (!deckSource) return;
    setPending(kind);
    if (kind === 'add') client.addBot(setupFrom(draft, deckSource));
    else if (botSeat) client.updateBot(botSeat.seatId, setupFrom(draft, deckSource));
  };

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
          Play against the software: pick a deck and how it should play. Bots answer immediately —
          how long they take is not configurable yet.
        </p>
      )}

      {/* What the host froze, said only to the host: a saved deck's name and
          fingerprint are not on the wire, because they are a handle onto a list
          opponents may not see (ADR 0024 §3). */}
      {seated && seated.deck.mode === 'exact_saved_deck' && (
        <p className="lobby__hint">
          {appliedSnapshot ? (
            <>
              Frozen from your deck <strong>{appliedSnapshot.name}</strong> —{' '}
              {appliedSnapshot.cardIds.length} cards, fingerprint{' '}
              <code>{appliedSnapshot.deckHash}</code>. Opponents see the Commander and not the list.
            </>
          ) : (
            <>
              This bot plays a saved deck. Its name and list are not published, so this browser
              cannot say which one — choose a deck below and apply it to be sure.
            </>
          )}
        </p>
      )}

      {frozenIsStale && (
        <p className="lobby__hint lobby__hint--warn">
          That saved deck has changed since you seated this bot. It still plays the list you froze;
          apply the change to send the current one.
        </p>
      )}

      {/* Absent rather than decorative: one supported mode means no choice to
          make, and the picker would be a control with a single option. */}
      {OFFERED_DECK_MODES.length > 1 && (
        <label className="field">
          <span>Bot deck source</span>
          <select
            value={draft.deck.mode}
            disabled={!canEdit}
            onChange={(event) => {
              const mode = OFFERED_DECK_MODES.find((id) => id === event.target.value);
              if (mode) chooseMode(mode);
            }}
          >
            {OFFERED_DECK_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {DECK_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
      )}

      {draft.deck.mode === 'exact_precon' ? (
        <label className="field">
          <span>Bot deck</span>
          <select
            value={draft.deck.preconId}
            disabled={!canEdit}
            onChange={(event) =>
              update({ deck: { mode: 'exact_precon', preconId: event.target.value } })
            }
          >
            {precons.map((precon) => (
              <option key={precon.id} value={precon.id}>
                {precon.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="field">
          <span>Your deck</span>
          <select
            value={draft.deck.savedDeckId}
            disabled={!canEdit || decks.length === 0}
            onChange={(event) =>
              update({ deck: { mode: 'exact_saved_deck', savedDeckId: event.target.value } })
            }
          >
            {decks.length === 0 && <option value="">No saved decks</option>}
            {decks.map((deck) => (
              <option key={deck.id} value={deck.id}>
                {deck.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {savedReview?.problem && <p className="lobby__error">{savedReview.problem}</p>}
      {savedReview?.snapshot && (
        <p className="lobby__hint">
          A copy of this deck is sent as it is now. Editing it afterwards does not change the bot.
        </p>
      )}

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
              onClick={() => send('update')}
              disabled={!canEdit || !changed || deckSource === null}
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
            onClick={() => send('add')}
            disabled={!canEdit || tableFull || deckSource === null}
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
