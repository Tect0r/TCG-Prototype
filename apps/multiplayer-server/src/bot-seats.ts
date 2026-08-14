import {
  DECK_MODE_SUPPORT,
  deckModeIsSupported,
  difficultyDefinition,
  difficultyIsAvailable,
  readBotSeatConfig,
  type BotDeckMode,
  type BotSeatConfig,
} from '@tcg/bot-config';
import { bundledPrecon, preconsForFormat, type CardDatabase } from '@tcg/card-data';
import { preconToDeck, reviewPrecon, type DeckFormatConfig, type SavedDeck } from '@tcg/deck';
import { botLobbyError, type BotSetup, type ProtocolError, type SeatId } from '@tcg/protocol';
import { err, errorsOf, ok, type Result } from '@tcg/shared';

/**
 * Turning a host's bot setup into something the authoritative lobby can seat
 * (M09.3).
 *
 * Everything here is a decision made **before** a seat is written, and the
 * refusals it produces are the vocabulary M09.2 named rather than wordings
 * invented per call site: `botLobbyError` is the only place a bot refusal is
 * built, and this file is the only place the server decides which of the seven
 * conditions applies.
 *
 * Two properties are worth stating because they are easy to lose later.
 *
 * **Nothing is accepted that this build cannot honour.** A deck mode is refused
 * by name from `DECK_MODE_SUPPORT`, and a difficulty from the difficulty
 * registry's own `status` — from data that names the tranche that owns it, not
 * from a hard-coded list of what happens to be finished. Flipping one entry is
 * how M09.6, M09.9, M09.10 and M09.13 turn their own option on.
 *
 * **Validation is not partial.** A setup either resolves to a complete
 * configuration and the deck it implies, or it is refused and the lobby is not
 * touched. There is no half-configured seat for a later tranche to discover.
 */

export interface BotSeatContext {
  readonly database: CardDatabase;
  readonly deckFormat: DeckFormatConfig;
  readonly now: () => number;
}

export interface ResolvedBotSeat {
  readonly config: BotSeatConfig;
  /**
   * The deck this bot will play, resolved by the server from its own content.
   * `null` is reserved for a mode whose list is not built yet — no supported
   * mode reaches that state in M09.3, and `createBotSeat` makes such a seat
   * visibly unready rather than silently startable.
   */
  readonly deck: SavedDeck | null;
}

/** Stable for the life of the seat, server-generated, and never off the wire. */
export function botIdFor(sequence: number): string {
  return `bot_${sequence}`;
}

/**
 * What a bot is called when the host does not say.
 *
 * Named after the seat rather than after a counter, so the name a player reads
 * beside seat 3 says "seat 3" and keeps saying it after another bot is removed.
 */
export function defaultBotDisplayName(seatId: SeatId): string {
  return `Bot ${seatId.replace('seat_', '')}`;
}

function refusal(
  condition: Parameters<typeof botLobbyError>[0],
  details: readonly string[],
): Result<never, ProtocolError> {
  return err(botLobbyError(condition, details));
}

/**
 * Why a reroll is refused, in the tranches' own words.
 *
 * Rerolling builds a *new* deck, which only a generated mode does, and this
 * build supports neither — so the refusal names the seat's actual mode and the
 * tranche each generated mode is waiting for, read from `DECK_MODE_SUPPORT`
 * rather than written out here.
 */
export function rerollUnsupportedDetails(seatId: SeatId, mode: BotDeckMode): string[] {
  return [
    `Rerolling builds a new deck, which only a generated mode does; ${seatId} plays "${mode}".`,
    `"commander_generated" arrives in ${DECK_MODE_SUPPORT.commander_generated.plannedIn}, ` +
      `"autonomous_generated" in ${DECK_MODE_SUPPORT.autonomous_generated.plannedIn}.`,
  ];
}

/**
 * Resolves one bot seat's setup, or says exactly why it cannot be seated.
 *
 * `botId` is supplied rather than derived here: identity belongs to the lobby
 * that allocates it, and reconfiguring a seat keeps the identity it already had
 * — which is the separation `botControllerSchema` exists to express.
 */
export function resolveBotSeat(
  setup: BotSetup,
  identity: { readonly botId: string; readonly seatId: SeatId },
  context: BotSeatContext,
): Result<ResolvedBotSeat, ProtocolError> {
  const mode = setup.deck.mode;
  if (!deckModeIsSupported(mode)) {
    const plannedIn = DECK_MODE_SUPPORT[mode].plannedIn;
    return refusal('mode_unsupported', [
      `Deck mode "${mode}" is planned for ${plannedIn ?? 'a later tranche'} and cannot be configured in this build.`,
    ]);
  }

  if (!difficultyIsAvailable(setup.difficulty)) {
    const definition = difficultyDefinition(setup.difficulty);
    return refusal('config_invalid', [
      `Difficulty "${definition.label}" is planned for ${definition.plannedIn ?? 'a later tranche'} and has no behaviour behind it yet.`,
    ]);
  }

  const { displayName, ...configured } = setup;
  const parsed = readBotSeatConfig({
    ...configured,
    controller: {
      botId: identity.botId,
      displayName: displayName ?? defaultBotDisplayName(identity.seatId),
    },
  });
  if (!parsed.ok) {
    return refusal(
      'config_invalid',
      errorsOf(parsed.error).map((issue) => issue.message),
    );
  }
  const config = parsed.value;

  if (config.deck.mode !== 'exact_precon') {
    // Unreachable while `exact_precon` is the only supported mode. Kept as a
    // refusal rather than a `never` so that flipping a support flag without
    // writing the resolver behind it refuses a configuration instead of
    // crashing a lobby.
    return refusal('mode_unsupported', [
      `This build has no resolver for deck mode "${config.deck.mode}".`,
    ]);
  }

  const precon = bundledPrecon(config.deck.preconId);
  if (!precon) {
    const published = preconsForFormat(context.deckFormat.formatId).map((entry) => entry.id);
    return refusal('deck_illegal', [
      `No built-in precon has the ID "${config.deck.preconId}".`,
      `Published for ${context.deckFormat.formatId}: ${published.join(', ') || 'none'}.`,
    ]);
  }

  // The same review the human `submit_precon` path runs, over the same server
  // pool: a bot's deck is judged by `validateDeck` exactly as a person's is, and
  // a precon built for another format is resolved and then refused rather than
  // played (CLAUDE.md §11).
  const review = reviewPrecon(precon, context.database, context.deckFormat);
  if (!review.legal) {
    return refusal('deck_illegal', [
      `"${precon.name}" cannot be played in this format.`,
      ...errorsOf(review.issues).map((issue) => issue.message),
    ]);
  }

  return ok({
    config,
    deck: preconToDeck(precon, {
      id: precon.id,
      now: new Date(context.now()).toISOString(),
    }),
  });
}
