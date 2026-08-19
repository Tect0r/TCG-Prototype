import { useEffect, useMemo, useState } from 'react';
import { preconsForFormat, type CardDatabase, type PreconDefinition } from '@tcg/card-data';
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
  type BotDeckSnapshot,
  type BotDeckSource,
  type BotDifficulty,
  type BotSeatPublic,
  type BotStyle,
} from '@tcg/bot-config';
import {
  MAX_BOT_SEATS,
  type BotLobbySeatView,
  type BotSetup,
  type LobbyView,
  type ProtocolError,
  type SeatId,
} from '@tcg/protocol';
import type { DeckFormatConfig, SavedDeck } from '@tcg/deck';
import { useAppState, useCardDatabase, useDeckFormat } from '../../state/AppContext.js';
import { useMatchClient, useMatchState } from '../../state/MatchContext.js';
import { botSeatLabels } from '../../lib/bot-seat-labels.js';
import { reviewSavedDeckForBot, snapshotIsStale } from '../../lib/bot-deck-snapshot.js';

/**
 * The host's bot controls (M09.5, extended by M09.6 and M09.7).
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
 * **Up to three bots, and never a table without a person** (M09.7). One form per
 * seated bot, each with its own labels, plus one form for the next one.
 * `MAX_BOT_SEATS` is the protocol's number rather than this screen's, and the
 * server allocates the seat: nothing here chooses where a bot lands, so nothing
 * here can race a joining human for a seat.
 *
 * **One mutation at a time.** Every control in this panel is disabled while a
 * request is in flight, whichever seat it was about. That is a deliberate answer
 * to the question M09.5 and M09.6 both left open: there is no per-request
 * acknowledgement on this wire, so `MatchClient` binds what was sent to a seat
 * by looking at the next lobby view — which is exact for one outstanding request
 * and ambiguous for two. Serialising them keeps it exact for three bots as
 * cheaply as it did for one, and the alternative (a second idea of "the current
 * configuration" on the client) is the thing ADR 0024 §3 exists to avoid.
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

/** "seat_3" reads as "seat 3" everywhere a person sees it. */
function seatNumber(seatId: SeatId): string {
  return seatId.replace('seat_', '');
}

/**
 * The accessible name of every control in one form.
 *
 * Seat-scoped for a seated bot, because a table can hold three of them and
 * "Bot style" three times over is ambiguous to anyone reading the page rather
 * than looking at it. The form for the *next* bot keeps the unscoped names: it
 * belongs to no seat yet, and the server is what decides which one it lands in.
 */
interface FieldLabels {
  readonly source: string;
  readonly precon: string;
  readonly saved: string;
  readonly difficulty: string;
  readonly style: string;
}

const NEW_BOT_LABELS: FieldLabels = {
  source: 'Bot deck source',
  precon: 'Bot deck',
  saved: 'Your deck',
  difficulty: 'Bot difficulty',
  style: 'Bot style',
};

function seatFieldLabels(seatId: SeatId): FieldLabels {
  const seat = `Seat ${seatNumber(seatId)}`;
  return {
    source: `${seat} deck source`,
    precon: `${seat} deck`,
    saved: `${seat} saved deck`,
    difficulty: `${seat} difficulty`,
    style: `${seat} style`,
  };
}

/** Which request is outstanding. At most one, panel-wide. */
type PendingRequest =
  { readonly kind: 'add' } | { readonly kind: 'update' | 'remove'; readonly seatId: SeatId };

interface DraftReview {
  /** What would be sent, or `null` when the draft cannot be turned into one. */
  readonly deckSource: BotDeckSource | null;
  /** One actionable sentence about the chosen saved deck, or `null`. */
  readonly problem: string | null;
  /** Set when the draft names a saved deck this browser can still freeze. */
  readonly snapshot: BotDeckSnapshot | null;
}

function reviewDraft(
  draft: BotDraft,
  decks: readonly SavedDeck[],
  database: CardDatabase,
  deckFormat: DeckFormatConfig,
): DraftReview {
  if (draft.deck.mode === 'exact_precon') {
    return {
      deckSource: draft.deck.preconId
        ? { mode: 'exact_precon', preconId: draft.deck.preconId }
        : null,
      problem: null,
      snapshot: null,
    };
  }
  const review = reviewSavedDeckForBot(draft.deck.savedDeckId, decks, database, deckFormat);
  return {
    deckSource: review.snapshot ? { mode: 'exact_saved_deck', deck: review.snapshot } : null,
    problem: review.problem,
    snapshot: review.snapshot,
  };
}

/** The draft a seated bot's public configuration and this client's memory imply. */
function draftFromSeat(bot: BotSeatPublic, snapshot: BotDeckSnapshot | null): BotDraft | null {
  if (bot.deck.mode === 'exact_precon') {
    return {
      deck: { mode: 'exact_precon', preconId: bot.deck.preconId },
      difficulty: bot.difficulty,
      style: bot.style,
    };
  }
  if (bot.deck.mode === 'exact_saved_deck' && snapshot) {
    return {
      deck: { mode: 'exact_saved_deck', savedDeckId: snapshot.sourceDeckId },
      difficulty: bot.difficulty,
      style: bot.style,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ fields */

interface BotConfigFieldsProps {
  readonly labels: FieldLabels;
  readonly draft: BotDraft;
  readonly onChange: (change: Partial<BotDraft>) => void;
  readonly disabled: boolean;
  readonly precons: readonly PreconDefinition[];
  readonly decks: readonly SavedDeck[];
}

/** The four controls a bot configuration is made of, wherever it is being edited. */
function BotConfigFields({
  labels,
  draft,
  onChange,
  disabled,
  precons,
  decks,
}: BotConfigFieldsProps) {
  const chooseMode = (mode: BotDeckMode): void => {
    if (mode === draft.deck.mode) return;
    if (mode === 'exact_precon') {
      onChange({ deck: { mode, preconId: precons[0]?.id ?? '' } });
    } else if (mode === 'exact_saved_deck') {
      onChange({ deck: { mode, savedDeckId: decks[0]?.id ?? '' } });
    }
  };

  return (
    <>
      {/* Absent rather than decorative: one supported mode means no choice to
          make, and the picker would be a control with a single option. */}
      {OFFERED_DECK_MODES.length > 1 && (
        <label className="field">
          <span>{labels.source}</span>
          <select
            value={draft.deck.mode}
            disabled={disabled}
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
          <span>{labels.precon}</span>
          <select
            value={draft.deck.preconId}
            disabled={disabled}
            onChange={(event) =>
              onChange({ deck: { mode: 'exact_precon', preconId: event.target.value } })
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
          <span>{labels.saved}</span>
          <select
            value={draft.deck.savedDeckId}
            disabled={disabled || decks.length === 0}
            onChange={(event) =>
              onChange({ deck: { mode: 'exact_saved_deck', savedDeckId: event.target.value } })
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

      <label className="field">
        <span>{labels.difficulty}</span>
        <select
          value={draft.difficulty}
          disabled={disabled}
          onChange={(event) => {
            // Looked up rather than cast: the value that comes back is a string,
            // and the only difficulties this control may produce are the ones it
            // offered.
            const difficulty = AVAILABLE_DIFFICULTIES.find((id) => id === event.target.value);
            if (difficulty) onChange({ difficulty });
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
        <span>{labels.style}</span>
        <select
          value={draft.style}
          disabled={disabled}
          onChange={(event) => {
            const style = BOT_STYLES.find((id) => id === event.target.value);
            if (style) onChange({ style });
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
    </>
  );
}

/* ------------------------------------------------------------- seated bots */

interface SeatedBotFormProps {
  readonly seat: BotLobbySeatView;
  /** The private half of this seat's configuration, as this client sent it. */
  readonly applied: BotDeckSource | null;
  readonly pending: PendingRequest | null;
  readonly setPending: (request: PendingRequest | null) => void;
  readonly precons: readonly PreconDefinition[];
  readonly fallback: BotDraft;
}

function SeatedBotForm({
  seat,
  applied,
  pending,
  setPending,
  precons,
  fallback,
}: SeatedBotFormProps) {
  const client = useMatchClient();
  const database = useCardDatabase();
  const deckFormat = useDeckFormat();
  const { decks } = useAppState();

  const [edited, setEdited] = useState<BotDraft | null>(null);

  const bot = seat.bot;
  const appliedSnapshot = applied?.mode === 'exact_saved_deck' ? applied.deck : null;
  const seatedDraft = draftFromSeat(bot, appliedSnapshot);
  const draft = edited ?? seatedDraft ?? fallback;
  const review = reviewDraft(draft, decks, database, deckFormat);

  /** The frozen list no longer matches the deck it was taken from. */
  const frozenIsStale = appliedSnapshot !== null && snapshotIsStale(appliedSnapshot, decks);
  // A saved deck that has since been edited is "changed" even when the host
  // picked the same deck: applying re-freezes it, which is the only way to move
  // a configured bot onto the new list.
  const changed =
    seatedDraft === null ||
    !sameDraft(draft, seatedDraft) ||
    (frozenIsStale && review.deckSource !== null);

  const canEdit = pending === null;
  const mine = pending && pending.kind !== 'add' && pending.seatId === seat.seatId;
  const labels = seatFieldLabels(seat.seatId);

  return (
    <section className="lobby__bot" aria-label={`Bot in seat ${seatNumber(seat.seatId)}`}>
      <p className="lobby__hint">
        <strong>{bot.displayName}</strong> is in seat {seatNumber(seat.seatId)}, playing{' '}
        {botSeatLabels(bot, database).deckName ?? 'a deck of its own'}.
      </p>

      {/* What the host froze, said only to the host: a saved deck's name and
          fingerprint are not on the wire, because they are a handle onto a list
          opponents may not see (ADR 0024 §3). */}
      {bot.deck.mode === 'exact_saved_deck' && (
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

      <BotConfigFields
        labels={labels}
        draft={draft}
        onChange={(change) => setEdited({ ...draft, ...change })}
        disabled={!canEdit}
        precons={precons}
        decks={decks}
      />

      {review.problem && <p className="lobby__error">{review.problem}</p>}
      {review.snapshot && (
        <p className="lobby__hint">
          A copy of this deck is sent as it is now. Editing it afterwards does not change the bot.
        </p>
      )}

      <div className="lobby__actions">
        <button
          type="button"
          onClick={() => {
            if (!review.deckSource) return;
            setPending({ kind: 'update', seatId: seat.seatId });
            client.updateBot(seat.seatId, setupFrom(draft, review.deckSource));
          }}
          disabled={!canEdit || !changed || review.deckSource === null}
        >
          {mine && pending.kind === 'update'
            ? 'Applying…'
            : `Apply seat ${seatNumber(seat.seatId)} changes`}
        </button>
        <button
          type="button"
          className="button--quiet"
          onClick={() => {
            setPending({ kind: 'remove', seatId: seat.seatId });
            setEdited(null);
            client.removeBot(seat.seatId);
          }}
          disabled={!canEdit}
        >
          {mine && pending.kind === 'remove'
            ? 'Removing…'
            : `Remove seat ${seatNumber(seat.seatId)}`}
        </button>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- adding one */

interface AddBotFormProps {
  readonly pending: PendingRequest | null;
  readonly setPending: (request: PendingRequest | null) => void;
  readonly precons: readonly PreconDefinition[];
  readonly fallback: BotDraft;
  /** Why another bot cannot be seated right now, or `null`. */
  readonly blocked: string | null;
}

function AddBotForm({ pending, setPending, precons, fallback, blocked }: AddBotFormProps) {
  const client = useMatchClient();
  const database = useCardDatabase();
  const deckFormat = useDeckFormat();
  const { decks } = useAppState();

  const [edited, setEdited] = useState<BotDraft | null>(null);
  const draft = edited ?? fallback;
  const review = reviewDraft(draft, decks, database, deckFormat);
  const canEdit = pending === null;

  return (
    <section className="lobby__bot" aria-label="Add a bot">
      <BotConfigFields
        labels={NEW_BOT_LABELS}
        draft={draft}
        onChange={(change) => setEdited({ ...draft, ...change })}
        disabled={!canEdit}
        precons={precons}
        decks={decks}
      />

      {review.problem && <p className="lobby__error">{review.problem}</p>}
      {review.snapshot && (
        <p className="lobby__hint">
          A copy of this deck is sent as it is now. Editing it afterwards does not change the bot.
        </p>
      )}

      <div className="lobby__actions">
        <button
          type="button"
          onClick={() => {
            if (!review.deckSource) return;
            setPending({ kind: 'add' });
            client.addBot(setupFrom(draft, review.deckSource));
          }}
          disabled={!canEdit || blocked !== null || review.deckSource === null}
        >
          {pending?.kind === 'add' ? 'Adding…' : 'Add a bot'}
        </button>
      </div>

      {blocked && <p className="lobby__hint">{blocked}</p>}
    </section>
  );
}

/* ---------------------------------------------------------------- the panel */

export interface BotSeatPanelProps {
  readonly lobby: LobbyView;
  /** The bot refusal to print, or null. Chosen by `isBotSeatError`. */
  readonly error: ProtocolError | null;
}

export function BotSeatPanel({ lobby, error }: BotSeatPanelProps) {
  const { botDeckSources } = useMatchState();
  const deckFormat = useDeckFormat();
  const { decks } = useAppState();

  // The same format-scoped list the human deck picker and the server offer, so
  // the three cannot disagree about which decks exist (M03.2).
  const precons = useMemo(() => preconsForFormat(deckFormat.formatId), [deckFormat.formatId]);

  const botSeats = lobby.seats.filter(
    (seat): seat is BotLobbySeatView => seat.controller === 'bot',
  );

  const [pending, setPending] = useState<PendingRequest | null>(null);

  // The server's answer — a new lobby view, or a refusal — is what ends the
  // wait. There is no per-request acknowledgement on this wire, and inventing
  // one would put a second idea of "the current configuration" on the client.
  const answered = JSON.stringify(lobby.seats);
  useEffect(() => {
    setPending(null);
  }, [answered, error]);

  const locked = lobby.status === 'in_match' || lobby.status === 'finished';

  if (precons.length === 0 && decks.length === 0) {
    return (
      <section className="lobby__bots" aria-label="Bot opponents">
        <h3>Bot opponents</h3>
        <p className="lobby__hint">
          No built-in decks are published for this format and you have saved none, so there is
          nothing for a bot to play.
        </p>
      </section>
    );
  }

  if (locked) {
    return (
      <section className="lobby__bots" aria-label="Bot opponents">
        <h3>Bot opponents</h3>
        <p className="lobby__hint">
          {botSeats.length > 0
            ? `The match has started; the settings of ${botSeats.length === 1 ? 'this bot are' : 'these bots are'} locked for the rest of it.`
            : 'The match has started. Bots can only be added before it does.'}
        </p>
      </section>
    );
  }

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

  // Two separate reasons, said separately, because the host fixes them
  // differently: a full table can be made bigger, and the bot ceiling cannot.
  const blocked =
    botSeats.length >= MAX_BOT_SEATS
      ? `A table seats at most ${MAX_BOT_SEATS} bots, so that at least one seat always belongs to a person.`
      : lobby.seats.length >= lobby.maxSeats
        ? 'Every seat at this table is taken. Make the table bigger, or wait for a seat to open.'
        : null;

  return (
    <section className="lobby__bots" aria-label="Bot opponents">
      <h3>Bot opponents</h3>

      <p className="lobby__hint">
        {botSeats.length === 0
          ? 'Play against the software: pick a deck and how it should play. Bots answer immediately — how long they take is not configurable yet.'
          : `${botSeats.length} of this table’s ${lobby.maxSeats} seats ${botSeats.length === 1 ? 'holds a bot' : 'hold bots'}. You can seat up to ${MAX_BOT_SEATS}; the rest of the table is people.`}
      </p>

      {botSeats.map((seat) => (
        <SeatedBotForm
          key={seat.seatId}
          seat={seat}
          applied={botDeckSources[seat.seatId] ?? null}
          pending={pending}
          setPending={setPending}
          precons={precons}
          fallback={fallback}
        />
      ))}

      <AddBotForm
        pending={pending}
        setPending={setPending}
        precons={precons}
        fallback={fallback}
        blocked={blocked}
      />

      {error && (
        <p className="lobby__error" role="alert">
          {error.message}
          {error.details ? ` ${error.details.join(' ')}` : ''}
        </p>
      )}
    </section>
  );
}
