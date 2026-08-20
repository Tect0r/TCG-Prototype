import { useEffect, useMemo, useState } from 'react';
import {
  preconsForFormat,
  type CardDatabase,
  type CardDefinition,
  type PreconDefinition,
} from '@tcg/card-data';
import {
  AVAILABLE_DIFFICULTIES,
  BOT_CONFIG_SCHEMA_VERSION,
  BOT_DECK_MODES,
  BOT_STYLES,
  DECK_MODE_SUPPORT,
  DEFAULT_BOT_DIFFICULTY,
  DIFFICULTY_REGISTRY_VERSION,
  IMMEDIATE_BOT_PACING,
  MAX_BUDGET_SECONDS,
  MAX_PACING_PERCENT,
  MIN_BUDGET_SECONDS,
  MIN_PACING_PERCENT,
  PACING_CONFIG_VERSION,
  botStyleDefinition,
  deckModeGenerates,
  difficultyDefinition,
  type BotDeckMode,
  type BotDeckSnapshot,
  type BotDeckSource,
  type BotDifficulty,
  type BotPacing,
  type BotPacingBudgets,
  type BotSeatPublic,
  type BotStyle,
  type GeneratedDeckProvenance,
} from '@tcg/bot-config';
import {
  MAX_BOT_SEATS,
  type BotLobbySeatView,
  type BotSetup,
  type LobbyView,
  type ProtocolError,
  type SeatId,
} from '@tcg/protocol';
import { playableCommanders, type DeckFormatConfig, type SavedDeck } from '@tcg/deck';
import { generateId } from '@tcg/shared';
import { useAppState, useCardDatabase, useDeckFormat } from '../../state/AppContext.js';
import { useMatchClient, useMatchState } from '../../state/MatchContext.js';
import { botSeatLabels } from '../../lib/bot-seat-labels.js';
import { reviewSavedDeckForBot, snapshotIsStale } from '../../lib/bot-deck-snapshot.js';
import {
  PACING_IS_NOT_A_HUMAN_TIMER,
  PACING_SAFETY_MARGIN_NOTE,
  ordinaryPacingLabel,
  reactionPacingLabel,
} from '../../lib/bot-pacing-labels.js';

/**
 * The host's bot controls (M09.5, extended by M09.6, M09.7, M09.9, M09.10 and
 * M09.11).
 *
 * **Only what this build can honour is on screen.** The deck-source control is
 * built from `DECK_MODE_SUPPORT` and the labels below, so a mode with no
 * resolver behind it is absent rather than present-and-refused, and the
 * difficulty control is built from `AVAILABLE_DIFFICULTIES`, so Hard is absent
 * for the same reason. The alternative — showing every eventual option disabled
 * — would be decoration that the server would answer with a named refusal, and
 * the milestone rules it out.
 *
 * Each of those follows from data rather than from a list written here, which is
 * how M09.13 turned Easy on without touching this file: it flipped the registry
 * entry it already owned and the option appeared, exactly as M09.6, M09.9 and
 * M09.10 each turned on a deck mode. All four deck modes and two of the three
 * difficulties are now offered; Hard is M09.15's.
 *
 * **Timing is configured here and spent by the server** (M09.11, M09.12). The
 * budgets belong to the table and the percentage to the bot, so they are two
 * controls and not one, and every percentage prints the seconds it implies from
 * `botDelayMs` — the same arithmetic the scheduler calls, rather than a second
 * copy of it in a screen. Since M09.12 those seconds are a real wait, so the
 * panel states the behaviour instead of warning that the control is inert. They
 * are still **bot pacing references, not human timers**: nothing here times a
 * person out of anything, and open-questions.md Q8 stays open (ADR 0024 §4).
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
  commander_generated: 'A deck built for a Commander you pick',
  autonomous_generated: 'A Commander and deck the bot picks',
};

const OFFERED_DECK_MODES = BOT_DECK_MODES.filter(
  (mode) => DECK_MODE_SUPPORT[mode].supported && DECK_MODE_LABELS[mode] !== null,
);

/** What a host chooses. Not a `BotSetup`: that is derived, and carries contents. */
type BotDeckDraft =
  | { readonly mode: 'exact_precon'; readonly preconId: string }
  | { readonly mode: 'exact_saved_deck'; readonly savedDeckId: string }
  /**
   * The Commander, and the seed that names the generation stream (M09.9).
   *
   * The seed is drafted here rather than left to the server because it is an
   * *instruction*: the same seed and the same Commander name the same deck, so a
   * host who writes one down can ask for it back. What the server owns is the
   * step along that stream — the reroll count — which is why `reroll_bot`
   * carries no seed at all.
   */
  | { readonly mode: 'commander_generated'; readonly commanderId: string; readonly seed: string }
  /**
   * The seed alone (M09.10). There is no Commander to draft because the bot
   * picks one, from the same format-scoped list this screen would have offered
   * and from the seed below — so the seed names the whole choice, and a host who
   * writes one down gets that Commander and that deck back.
   */
  | { readonly mode: 'autonomous_generated'; readonly seed: string };

/** A fresh generation stream. Opaque, and never parsed back apart. */
function newGenerationSeed(): string {
  return generateId('gen');
}

interface BotDraft {
  readonly deck: BotDeckDraft;
  readonly difficulty: BotDifficulty;
  readonly style: BotStyle;
  /**
   * How long this bot waits, as a percentage of the table's budgets (M09.11).
   *
   * Part of the draft rather than of the deck draft: timing is its own axis, and
   * a bot that changes deck keeps the timing the host set for it.
   */
  readonly pacing: BotPacing;
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
    pacing: draft.pacing,
  };
}

function sameDeckDraft(a: BotDeckDraft, b: BotDeckDraft): boolean {
  if (a.mode === 'exact_precon') return b.mode === 'exact_precon' && a.preconId === b.preconId;
  if (a.mode === 'exact_saved_deck') {
    return b.mode === 'exact_saved_deck' && a.savedDeckId === b.savedDeckId;
  }
  // The seed is part of the identity of a generated draft: two drafts naming the
  // same Commander from different seeds are two different decks. For a draft the
  // bot chooses under, the seed is the whole identity.
  if (a.mode === 'autonomous_generated') {
    return b.mode === 'autonomous_generated' && a.seed === b.seed;
  }
  return b.mode === 'commander_generated' && a.commanderId === b.commanderId && a.seed === b.seed;
}

function samePacing(a: BotPacing, b: BotPacing): boolean {
  return a.percent === b.percent && a.reactionPercent === b.reactionPercent;
}

function sameDraft(a: BotDraft, b: BotDraft): boolean {
  return (
    a.difficulty === b.difficulty &&
    a.style === b.style &&
    samePacing(a.pacing, b.pacing) &&
    sameDeckDraft(a.deck, b.deck)
  );
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
  readonly commander: string;
  readonly seed: string;
  readonly difficulty: string;
  readonly style: string;
  readonly timing: string;
  readonly reactionOverride: string;
  readonly reaction: string;
}

const NEW_BOT_LABELS: FieldLabels = {
  source: 'Bot deck source',
  precon: 'Bot deck',
  saved: 'Your deck',
  commander: 'Bot Commander',
  seed: 'Bot deck seed',
  difficulty: 'Bot difficulty',
  style: 'Bot style',
  timing: 'Bot timing',
  reactionOverride: 'Bot Reaction override',
  reaction: 'Bot Reaction timing',
};

function seatFieldLabels(seatId: SeatId): FieldLabels {
  const seat = `Seat ${seatNumber(seatId)}`;
  return {
    source: `${seat} deck source`,
    precon: `${seat} deck`,
    saved: `${seat} saved deck`,
    commander: `${seat} Commander`,
    seed: `${seat} deck seed`,
    difficulty: `${seat} difficulty`,
    style: `${seat} style`,
    timing: `${seat} timing`,
    reactionOverride: `${seat} Reaction override`,
    reaction: `${seat} Reaction timing`,
  };
}

/** Which request is outstanding. At most one, panel-wide. */
type PendingRequest =
  | { readonly kind: 'add' }
  | { readonly kind: 'update' | 'remove' | 'reroll'; readonly seatId: SeatId };

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
  if (draft.deck.mode === 'commander_generated') {
    // Nothing is previewed and nothing is built here: generation happens on the
    // authoritative server, against its own pool, and `@tcg/deck-generator`
    // declares itself server-only anyway. All this decides is whether a complete
    // instruction can be sent.
    const { commanderId, seed } = draft.deck;
    return {
      deckSource: commanderId
        ? { mode: 'commander_generated', commanderId, seed, generated: null }
        : null,
      problem: commanderId
        ? null
        : 'No Commander in this format can lead a generated deck yet, so there is nothing to build.',
      snapshot: null,
    };
  }
  if (draft.deck.mode === 'autonomous_generated') {
    // The same emptiness check, asked of the format rather than of the draft:
    // there is no Commander in the instruction because the bot picks one, so
    // what can make this mode impossible is the format having none to pick from.
    const none = playableCommanders(database, deckFormat).length === 0;
    return {
      deckSource: none
        ? null
        : { mode: 'autonomous_generated', seed: draft.deck.seed, generated: null },
      problem: none
        ? 'No Commander in this format can lead a generated deck yet, so a bot has nothing to pick from.'
        : null,
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
function draftFromSeat(bot: BotSeatPublic, applied: BotDeckSource | null): BotDraft | null {
  if (bot.deck.mode === 'exact_precon') {
    return {
      deck: { mode: 'exact_precon', preconId: bot.deck.preconId },
      difficulty: bot.difficulty,
      style: bot.style,
      pacing: bot.pacing,
    };
  }
  if (bot.deck.mode === 'exact_saved_deck' && applied?.mode === 'exact_saved_deck') {
    return {
      deck: { mode: 'exact_saved_deck', savedDeckId: applied.deck.sourceDeckId },
      difficulty: bot.difficulty,
      style: bot.style,
      pacing: bot.pacing,
    };
  }
  // The Commander is public, and the seed is not: it is the instruction this
  // browser sent, so a client that never sent it cannot reconstruct the draft
  // and says so rather than guessing one (ADR 0024 §3).
  if (bot.deck.mode === 'commander_generated' && applied?.mode === 'commander_generated') {
    return {
      deck: {
        mode: 'commander_generated',
        commanderId: bot.deck.commanderId,
        seed: applied.seed,
      },
      difficulty: bot.difficulty,
      style: bot.style,
      pacing: bot.pacing,
    };
  }
  // The bot's own Commander is public, but it is a *result* here rather than
  // part of the draft: what the host chose was the seed, and only the client
  // that sent it knows it.
  if (bot.deck.mode === 'autonomous_generated' && applied?.mode === 'autonomous_generated') {
    return {
      deck: { mode: 'autonomous_generated', seed: applied.seed },
      difficulty: bot.difficulty,
      style: bot.style,
      pacing: bot.pacing,
    };
  }
  return null;
}

/**
 * What the host is told about a deck the server built for them (M09.9).
 *
 * Read entirely from the provenance the server sent down the host's own
 * connection. The last sentence is the milestone's forced-inclusion warning, and
 * it is arithmetic from `legalPoolSize` and `forcedInclusionFloor` rather than a
 * sentence written here — Wave 1 leaves 41–42 legal cards for a 40-card deck, so
 * two generated decks are near-identical by the format rather than by any
 * failure of the draw, and a screen that did not say so would be implying
 * variety the content cannot supply.
 */
function GeneratedDeckSummary({
  provenance,
  commanderName,
}: {
  readonly provenance: GeneratedDeckProvenance;
  readonly commanderName: string | null;
}) {
  const choice = provenance.legalPoolSize - provenance.forcedInclusionFloor;
  // Who picked the Commander is read off the provenance rather than passed in:
  // the record of the deck is what knows, and a screen that was told separately
  // could disagree with it (M09.10).
  const chosenByBot = provenance.mode === 'autonomous_generated';
  return (
    <>
      <p className="lobby__hint">
        {chosenByBot ? 'The bot chose ' : 'Built for '}
        <strong>{commanderName ?? provenance.commanderId}</strong>
        {chosenByBot ? ' and built its deck from seed ' : ' from seed '}
        <code>{provenance.seed}</code>
        {provenance.rerollCount > 0 ? ` (reroll ${provenance.rerollCount})` : ''} by generator v
        {provenance.generatorVersion} — deck <code>{provenance.deckHash}</code>. Opponents see the
        Commander and not the list until the match is over.
      </p>
      <p className="lobby__hint lobby__hint--warn">
        This format leaves {provenance.legalPoolSize} cards legal under that Commander, so any legal
        deck must include at least {provenance.forcedInclusionFloor} of them.{' '}
        {chosenByBot
          ? `Under this Commander only ${choice} ${choice === 1 ? 'card is' : 'cards are'} left to chance; a reroll picks the Commander again as well, so it can change more.`
          : `Rerolling changes at most ${choice} ${choice === 1 ? 'card' : 'cards'}.`}
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ fields */

interface BotConfigFieldsProps {
  readonly labels: FieldLabels;
  readonly draft: BotDraft;
  readonly onChange: (change: Partial<BotDraft>) => void;
  readonly disabled: boolean;
  readonly precons: readonly PreconDefinition[];
  readonly decks: readonly SavedDeck[];
  /** The Commanders a generated deck may be built under, in this format. */
  readonly commanders: readonly CardDefinition[];
  /** The table's budgets, so every percentage can print its seconds (M09.11). */
  readonly budgets: BotPacingBudgets;
}

/** The controls a bot configuration is made of, wherever it is being edited. */
function BotConfigFields({
  labels,
  draft,
  onChange,
  disabled,
  precons,
  decks,
  commanders,
  budgets,
}: BotConfigFieldsProps) {
  const chooseMode = (mode: BotDeckMode): void => {
    if (mode === draft.deck.mode) return;
    if (mode === 'exact_precon') {
      onChange({ deck: { mode, preconId: precons[0]?.id ?? '' } });
    } else if (mode === 'exact_saved_deck') {
      onChange({ deck: { mode, savedDeckId: decks[0]?.id ?? '' } });
    } else if (mode === 'commander_generated') {
      // A fresh stream, because switching into this mode is not resuming one:
      // the seed the host last used named a different configuration, and
      // silently reusing it would hand back a deck they had moved away from.
      onChange({ deck: { mode, commanderId: commanders[0]?.id ?? '', seed: newGenerationSeed() } });
    } else if (mode === 'autonomous_generated') {
      onChange({ deck: { mode, seed: newGenerationSeed() } });
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

      {draft.deck.mode === 'exact_precon' && (
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
      )}

      {draft.deck.mode === 'exact_saved_deck' && (
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

      {/* Exactly the Commanders `playableCommanders` leaves usable here, which
          is the same rule the authoritative server refuses by — so an option
          this control offers is never one the server would reject (M09.9). */}
      {draft.deck.mode === 'commander_generated' && (
        <label className="field">
          <span>{labels.commander}</span>
          <select
            value={draft.deck.commanderId}
            disabled={disabled || commanders.length === 0}
            onChange={(event) =>
              onChange({
                deck: {
                  mode: 'commander_generated',
                  commanderId: event.target.value,
                  // The Commander names the stream along with the seed, so
                  // choosing a different one starts that stream at its first
                  // deck rather than at somebody else's reroll count.
                  seed: draft.deck.mode === 'commander_generated' ? draft.deck.seed : '',
                },
              })
            }
          >
            {commanders.length === 0 && <option value="">No Commanders available</option>}
            {commanders.map((commander) => (
              <option key={commander.id} value={commander.id}>
                {commander.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* One control for both generated modes. Editable because the seed is an
          instruction, not a result: the same seed names the same deck on this
          build — and, when the bot is the one choosing, the same Commander too —
          so a host who writes one down can ask for that deck back. What the
          server owns is the step along the stream, which is why a reroll carries
          no seed. */}
      {(draft.deck.mode === 'commander_generated' ||
        draft.deck.mode === 'autonomous_generated') && (
        <label className="field">
          <span>{labels.seed}</span>
          <input
            type="text"
            value={draft.deck.seed}
            disabled={disabled}
            onChange={(event) => {
              const seed = event.target.value;
              onChange({
                deck:
                  draft.deck.mode === 'commander_generated'
                    ? { mode: 'commander_generated', commanderId: draft.deck.commanderId, seed }
                    : { mode: 'autonomous_generated', seed },
              });
            }}
          />
        </label>
      )}

      {draft.deck.mode === 'autonomous_generated' && (
        <p className="lobby__hint">
          The bot picks one of this format’s {commanders.length} playable Commanders from this seed
          alone, and builds its deck under it. It cannot see anyone’s hand, deck or saved decks when
          it chooses.
        </p>
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

      <BotTimingFields
        labels={labels}
        pacing={draft.pacing}
        budgets={budgets}
        disabled={disabled}
        onChange={(pacing) => onChange({ pacing })}
      />
    </>
  );
}

/** Every whole ten percent. A dial with a hundred stops is not a finer answer. */
const PACING_PERCENT_STEPS = Array.from(
  { length: (MAX_PACING_PERCENT - MIN_PACING_PERCENT) / 10 + 1 },
  (_, index) => MIN_PACING_PERCENT + index * 10,
);

interface BotTimingFieldsProps {
  readonly labels: FieldLabels;
  readonly pacing: BotPacing;
  readonly budgets: BotPacingBudgets;
  readonly disabled: boolean;
  readonly onChange: (pacing: BotPacing) => void;
}

/**
 * One bot's timing: a percentage, and the advanced Reaction override (M09.11).
 *
 * The override is a checkbox rather than a "-1 means inherit" number, because
 * `reactionPercent` is `null` for inherit and `0` for "answer a Reaction
 * instantly", and those are different configurations that a single control
 * would have to collapse. Ticking it starts from the ordinary percentage, so
 * turning the override on changes nothing until the host moves it.
 *
 * Every percentage prints the delay it implies beside it, from `botDelayMs`
 * rather than from arithmetic written here.
 */
function BotTimingFields({ labels, pacing, budgets, disabled, onChange }: BotTimingFieldsProps) {
  const overridden = pacing.reactionPercent !== null;

  return (
    <>
      <label className="field">
        <span>{labels.timing}</span>
        <select
          value={pacing.percent}
          disabled={disabled}
          onChange={(event) => onChange({ ...pacing, percent: Number(event.target.value) })}
        >
          {PACING_PERCENT_STEPS.map((percent) => (
            <option key={percent} value={percent}>
              {percent}%
            </option>
          ))}
        </select>
      </label>

      <p className="lobby__hint">{ordinaryPacingLabel(pacing, budgets)}</p>

      <label className="field field--check">
        <input
          type="checkbox"
          checked={overridden}
          disabled={disabled}
          aria-label={labels.reactionOverride}
          onChange={(event) =>
            onChange({
              ...pacing,
              // Starting from the ordinary percentage: turning the override on
              // is asking to change the Reaction timing, not to have changed it.
              reactionPercent: event.target.checked ? pacing.percent : null,
            })
          }
        />
        <span>Time Reactions differently</span>
      </label>

      {overridden && (
        <label className="field">
          <span>{labels.reaction}</span>
          <select
            value={pacing.reactionPercent ?? pacing.percent}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...pacing, reactionPercent: Number(event.target.value) })
            }
          >
            {PACING_PERCENT_STEPS.map((percent) => (
              <option key={percent} value={percent}>
                {percent}%
              </option>
            ))}
          </select>
        </label>
      )}

      <p className="lobby__hint">{reactionPacingLabel(pacing, budgets)}</p>
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
  readonly commanders: readonly CardDefinition[];
  /** What the server built for this seat, when it built one. Host-only. */
  readonly provenance: GeneratedDeckProvenance | null;
  readonly fallback: BotDraft;
  /** The table's budgets, so this seat's percentages can print their seconds. */
  readonly budgets: BotPacingBudgets;
}

function SeatedBotForm({
  seat,
  applied,
  pending,
  setPending,
  precons,
  commanders,
  provenance,
  fallback,
  budgets,
}: SeatedBotFormProps) {
  const client = useMatchClient();
  const database = useCardDatabase();
  const deckFormat = useDeckFormat();
  const { decks } = useAppState();

  const [edited, setEdited] = useState<BotDraft | null>(null);

  const bot = seat.bot;
  const appliedSnapshot = applied?.mode === 'exact_saved_deck' ? applied.deck : null;
  const seatedDraft = draftFromSeat(bot, applied);
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

      {/* What the server actually built, said only to the host, because the
          seed it carries would let anybody holding it and the public Commander
          rebuild the list card for card (ADR 0024 §3). */}
      {deckModeGenerates(bot.deck.mode) &&
        (provenance ? (
          <GeneratedDeckSummary
            provenance={provenance}
            // From the provenance rather than from the seat view: an
            // `autonomous_generated` seat publishes `null` until the bot has
            // chosen, and the record of what was built always knows.
            commanderName={database.get(provenance.commanderId)?.name ?? null}
          />
        ) : (
          <p className="lobby__hint">
            This bot plays a deck the server built for it. Its list is not published, and this
            browser has not been told which one — reroll or apply a change to be sure.
          </p>
        ))}

      <BotConfigFields
        labels={labels}
        draft={draft}
        onChange={(change) => setEdited({ ...draft, ...change })}
        disabled={!canEdit}
        precons={precons}
        decks={decks}
        commanders={commanders}
        budgets={budgets}
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
        {/* Only for a seat that has a generator behind it. Rerolling an exact
            list is refused by name on the server, and a control whose only
            outcome is that refusal is one this panel does not offer. Pressing it
            sends no seed: the server takes the next step along this seat's own
            stream, which is what makes the recorded transition its own. */}
        {deckModeGenerates(bot.deck.mode) && (
          <button
            type="button"
            onClick={() => {
              setPending({ kind: 'reroll', seatId: seat.seatId });
              // Any half-finished edit is dropped: what comes back describes the
              // seat's configuration, and keeping a draft over it would show a
              // Commander the new deck was not built under.
              setEdited(null);
              client.rerollBot(seat.seatId);
            }}
            disabled={!canEdit}
          >
            {mine && pending.kind === 'reroll'
              ? 'Rerolling…'
              : `Reroll seat ${seatNumber(seat.seatId)} deck`}
          </button>
        )}
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
  readonly commanders: readonly CardDefinition[];
  readonly fallback: BotDraft;
  /** Why another bot cannot be seated right now, or `null`. */
  readonly blocked: string | null;
  /** The table's budgets, so this form's percentages can print their seconds. */
  readonly budgets: BotPacingBudgets;
}

function AddBotForm({
  pending,
  setPending,
  precons,
  commanders,
  fallback,
  blocked,
  budgets,
}: AddBotFormProps) {
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
        commanders={commanders}
        budgets={budgets}
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

/* ------------------------------------------------------------ table budgets */

interface PacingBudgetsFormProps {
  readonly budgets: BotPacingBudgets;
}

/**
 * The table's two pacing budgets (M09.11).
 *
 * One record for the whole lobby rather than a copy per bot: a percentage is a
 * percentage *of* something, and three seats each carrying their own idea of
 * what would be three chances for them to disagree. The host sets the seconds;
 * each bot sets the fraction of them it waits.
 *
 * Edited locally and sent as soon as the value is one the server would accept,
 * because the authoritative copy arrives back on the next lobby view and a
 * control bound directly to it would fight every keystroke on the way. A partial
 * or out-of-range entry is simply not sent — the field keeps what was typed, and
 * the last accepted value is still what the table is set to.
 */
function PacingBudgetsForm({ budgets }: PacingBudgetsFormProps) {
  const client = useMatchClient();
  const [ordinary, setOrdinary] = useState(String(budgets.ordinarySeconds));
  const [reaction, setReaction] = useState(String(budgets.reactionSeconds));

  useEffect(() => setOrdinary(String(budgets.ordinarySeconds)), [budgets.ordinarySeconds]);
  useEffect(() => setReaction(String(budgets.reactionSeconds)), [budgets.reactionSeconds]);

  const inRange = (value: number): boolean =>
    Number.isInteger(value) && value >= MIN_BUDGET_SECONDS && value <= MAX_BUDGET_SECONDS;

  const send = (next: { ordinarySeconds: number; reactionSeconds: number }): void => {
    if (!inRange(next.ordinarySeconds) || !inRange(next.reactionSeconds)) return;
    client.setBotPacing({ pacingVersion: PACING_CONFIG_VERSION, ...next });
  };

  return (
    <section className="lobby__pacing" aria-label="Bot pacing budgets">
      <p className="lobby__hint">{PACING_IS_NOT_A_HUMAN_TIMER}</p>

      <label className="field">
        <span>Bot decision budget (seconds)</span>
        <input
          type="number"
          min={MIN_BUDGET_SECONDS}
          max={MAX_BUDGET_SECONDS}
          step={1}
          value={ordinary}
          onChange={(event) => {
            setOrdinary(event.target.value);
            send({
              ordinarySeconds: Number(event.target.value),
              reactionSeconds: budgets.reactionSeconds,
            });
          }}
        />
      </label>

      <label className="field">
        <span>Bot Reaction budget (seconds)</span>
        <input
          type="number"
          min={MIN_BUDGET_SECONDS}
          max={MAX_BUDGET_SECONDS}
          step={1}
          value={reaction}
          onChange={(event) => {
            setReaction(event.target.value);
            send({
              ordinarySeconds: budgets.ordinarySeconds,
              reactionSeconds: Number(event.target.value),
            });
          }}
        />
      </label>

      <p className="lobby__hint">{PACING_SAFETY_MARGIN_NOTE}</p>
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
  const { botDeckSources, botProvenance } = useMatchState();
  const database = useCardDatabase();
  const deckFormat = useDeckFormat();
  const { decks } = useAppState();

  // The same format-scoped list the human deck picker and the server offer, so
  // the three cannot disagree about which decks exist (M03.2).
  const precons = useMemo(() => preconsForFormat(deckFormat.formatId), [deckFormat.formatId]);

  // `playableCommanders` is the same function the server's own refusal is
  // derived from, run here against the same format-scoped database — so a
  // Commander this panel offers is never one the lobby would reject (M09.9).
  const commanders = useMemo(
    () =>
      [...playableCommanders(database, deckFormat)].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    [database, deckFormat],
  );

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

  // Nothing to seat a bot on at all: no built-in deck, none of the host's own,
  // and no Commander the server could build one under.
  if (precons.length === 0 && decks.length === 0 && commanders.length === 0) {
    return (
      <section className="lobby__bots" aria-label="Bot opponents">
        <h3>Bot opponents</h3>
        <p className="lobby__hint">
          No built-in decks are published for this format, you have saved none, and no Commander
          here can lead a generated one, so there is nothing for a bot to play.
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
        {/* What the match locked, read from the view rather than remembered:
            the server freezes the budgets at start and publishes the frozen
            ones, so this is provenance and not a copy of the last thing the
            host typed (M09.11). */}
        {botSeats.length > 0 && (
          <>
            <p className="lobby__hint">
              Locked bot pacing: {lobby.botPacing.ordinarySeconds} s for a decision or a choice,{' '}
              {lobby.botPacing.reactionSeconds} s for a Reaction window.
            </p>
            <ul className="lobby__pacing-list">
              {botSeats.map((seat) => (
                <li key={seat.seatId}>
                  {seat.bot.displayName}: {ordinaryPacingLabel(seat.bot.pacing, lobby.botPacing)};{' '}
                  {reactionPacingLabel(seat.bot.pacing, lobby.botPacing)}.
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    );
  }

  // Whichever offered mode this build actually has something to put in it. A
  // format publishing no precons is not a reason to default to an empty picker.
  const fallback: BotDraft = {
    deck:
      precons.length > 0
        ? { mode: 'exact_precon', preconId: precons[0]?.id ?? '' }
        : decks.length > 0
          ? { mode: 'exact_saved_deck', savedDeckId: decks[0]?.id ?? '' }
          : {
              mode: 'commander_generated',
              commanderId: commanders[0]?.id ?? '',
              seed: newGenerationSeed(),
            },
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style: BOT_STYLES[0],
    // Instant until the host says otherwise. A default that waited would make
    // the first match somebody plays slower than they asked for.
    pacing: IMMEDIATE_BOT_PACING,
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
          ? 'Play against the software: pick a deck, how it should play, and how long it should take.'
          : `${botSeats.length} of this table’s ${lobby.maxSeats} seats ${botSeats.length === 1 ? 'holds a bot' : 'hold bots'}. You can seat up to ${MAX_BOT_SEATS}; the rest of the table is people.`}
      </p>

      {/* Says what the numbers below now do. Until M09.12 this was a warning
          that they did nothing; it is a statement of behaviour now, and the
          "0% is instant" half is here because that is still the default. */}
      <p className="lobby__hint">
        Bots wait for the seconds shown against each seat before deciding. Timings are locked when
        the match starts, and a seat left at 0% answers immediately.
      </p>

      <PacingBudgetsForm budgets={lobby.botPacing} />

      {botSeats.map((seat) => (
        <SeatedBotForm
          key={seat.seatId}
          seat={seat}
          applied={botDeckSources[seat.seatId] ?? null}
          provenance={botProvenance[seat.seatId] ?? null}
          pending={pending}
          setPending={setPending}
          precons={precons}
          commanders={commanders}
          fallback={fallback}
          budgets={lobby.botPacing}
        />
      ))}

      <AddBotForm
        pending={pending}
        setPending={setPending}
        precons={precons}
        commanders={commanders}
        fallback={fallback}
        blocked={blocked}
        budgets={lobby.botPacing}
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
