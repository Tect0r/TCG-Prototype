import {
  DECK_MODE_SUPPORT,
  deckModeIsSupported,
  difficultyDefinition,
  difficultyIsAvailable,
  readBotSeatConfig,
  type BotDeckMode,
  type BotDeckSnapshot,
  type BotSeatConfig,
} from '@tcg/bot-config';
import { bundledPrecon, preconsForFormat, type CardDatabase } from '@tcg/card-data';
import {
  DECK_SCHEMA_VERSION,
  collectDeckCards,
  deckFingerprint,
  preconToDeck,
  reviewPrecon,
  validateDeck,
  type DeckFormatConfig,
  type SavedDeck,
} from '@tcg/deck';
import { botLobbyError, type BotSetup, type ProtocolError, type SeatId } from '@tcg/protocol';
import { err, errorsOf, isErr, ok, type Result } from '@tcg/shared';

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
 * how M09.9, M09.10 and M09.13 turn their own option on, and it is how M09.6
 * turned `exact_saved_deck` on: it wrote the resolver below, then said so in the
 * table.
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

  switch (config.deck.mode) {
    case 'exact_precon': {
      const deck = resolvePreconDeck(config.deck.preconId, context);
      return isErr(deck) ? deck : ok({ config, deck: deck.value });
    }
    case 'exact_saved_deck': {
      const deck = resolveSnapshotDeck(config.deck.deck, context);
      return isErr(deck) ? deck : ok({ config, deck: deck.value });
    }
    case 'commander_generated':
    case 'autonomous_generated':
      // Unreachable: `DECK_MODE_SUPPORT` refuses both above. Kept as a refusal
      // rather than a `never` so that flipping a support flag without writing
      // the resolver behind it refuses a configuration instead of crashing a
      // lobby — which is exactly the state M09.6 walked through for its own mode.
      return refusal('mode_unsupported', [
        `This build has no resolver for deck mode "${config.deck.mode}".`,
      ]);
    default: {
      const never: never = config.deck;
      return refusal('mode_unsupported', [`Unknown deck mode ${JSON.stringify(never)}.`]);
    }
  }
}

/** A shipped precon, resolved from the server's own bundle and reviewed. */
function resolvePreconDeck(
  preconId: string,
  context: BotSeatContext,
): Result<SavedDeck, ProtocolError> {
  const precon = bundledPrecon(preconId);
  if (!precon) {
    const published = preconsForFormat(context.deckFormat.formatId).map((entry) => entry.id);
    return refusal('deck_illegal', [
      `No built-in precon has the ID "${preconId}".`,
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

  return ok(preconToDeck(precon, { id: precon.id, now: new Date(context.now()).toISOString() }));
}

/**
 * One of the host's own saved decks, frozen at the moment they chose it (M09.6).
 *
 * Two checks, in this order, and the order is the point.
 *
 * **Does the snapshot describe itself?** The hash is recomputed from the list
 * that arrived rather than believed, and a disagreement is refused as a
 * configuration this server cannot read — because it is one. A host who edited
 * the deck between choosing it and pressing the button, or a client that built
 * the record out of two different reads, is told to pick the deck again instead
 * of quietly seating whichever half won. Nothing here trusts the value on its
 * own: the list is validated below whatever the hash says, so the check catches
 * an accident rather than defending against an attack.
 *
 * **Is the list legal here?** Through `validateDeck`, against this server's own
 * database and format — the identical call `submit_deck` makes for a person's
 * deck. A bot gets no allowance a player would not get: size, singleton, colour
 * identity, unimplemented cards and a missing or wrong-typed Commander are all
 * refused with the validator's own wording, so the host reads the same sentence
 * the deck builder would have shown them.
 *
 * The deck is materialised here rather than carried: a snapshot is contents, and
 * `SavedDeck` is what a match seat holds. `sourceDeckId` becomes the deck's ID
 * because that is where the contents came from, and the timestamps are the
 * server's own — the snapshot deliberately carries no clock for a client to
 * disagree with.
 */
function resolveSnapshotDeck(
  snapshot: BotDeckSnapshot,
  context: BotSeatContext,
): Result<SavedDeck, ProtocolError> {
  const cards = collectDeckCards(snapshot.cardIds);
  const fingerprint = deckFingerprint({ commanderId: snapshot.commanderId, cards });
  if (fingerprint !== snapshot.deckHash) {
    return refusal('config_invalid', [
      `"${snapshot.name}" arrived with hash ${snapshot.deckHash}, but its ${snapshot.cardIds.length}-card list hashes to ${fingerprint}.`,
      'The deck was probably edited after it was chosen. Select it again to send the current list.',
    ]);
  }

  const now = new Date(context.now()).toISOString();
  const deck: SavedDeck = {
    schemaVersion: DECK_SCHEMA_VERSION,
    id: snapshot.sourceDeckId,
    name: snapshot.name,
    commanderId: snapshot.commanderId,
    cards,
    createdAt: now,
    updatedAt: now,
  };

  const report = validateDeck(deck, context.database, context.deckFormat);
  if (!report.legal) {
    return refusal('deck_illegal', [
      `"${snapshot.name}" is not legal in this format.`,
      ...errorsOf(report.issues).map((issue) => issue.message),
    ]);
  }

  return ok(deck);
}
