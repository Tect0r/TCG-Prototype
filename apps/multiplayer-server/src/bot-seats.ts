import {
  DECK_MODE_SUPPORT,
  deckModeGenerates,
  deckModeIsSupported,
  difficultyDefinition,
  difficultyIsAvailable,
  readBotSeatConfig,
  type BotDeckMode,
  type BotDeckSnapshot,
  type BotDeckSource,
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
import { generateAutonomousBotDeck, generateBotDeck } from './bot-generated-deck.js';

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
 * how M09.6, M09.9 and M09.10 each turned their own deck mode on and how M09.13
 * will turn a difficulty on: write the resolver below, then say so in the table.
 * As of M09.10 every deck mode has one, so the mode refusal is what a *fifth*
 * mode would meet rather than something a shipped configuration can reach.
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
 * Rerolling builds a *new* deck, which only a generated mode does. A seat
 * playing an exact list — a precon, or one of the host's saved decks — has
 * nothing to reroll, so the refusal names the seat's actual mode.
 *
 * The first branch is for a generated mode this build cannot honour. Since
 * M09.10 there is none, and it is kept rather than deleted for the same reason
 * `DECK_MODE_SUPPORT` is: a fifth mode arriving without a resolver should meet a
 * refusal that names the tranche owning it, read from the table, instead of a
 * sentence somebody has to remember to write.
 */
export function rerollUnsupportedDetails(seatId: SeatId, mode: BotDeckMode): string[] {
  if (deckModeGenerates(mode)) {
    return [
      `Deck mode "${mode}" is planned for ${DECK_MODE_SUPPORT[mode].plannedIn ?? 'a later tranche'}, ` +
        'so this build cannot build it a new deck.',
    ];
  }
  return [
    `Rerolling builds a new deck, which only a generated mode does; ${seatId} plays "${mode}".`,
    'Switch the seat to a generated deck — under a Commander you choose, or one the bot picks — ' +
      'and it will have a deck you can reroll.',
  ];
}

/**
 * How many rerolls a reconfigured seat carries over.
 *
 * `update_bot` replaces a configuration wholesale, and a reroll count is not
 * part of a configuration — it is how far the seat has got along one *generation
 * stream*. The stream is named by what the host controls: the base seed, and —
 * when the host is the one choosing it — the Commander. Change either and the
 * stream is a different one, so the count restarts at 0 and the host gets that
 * stream's first deck. Change neither — a different style, a different
 * difficulty, a different name — and the seat keeps the deck it is on, because
 * otherwise renaming a bot would silently undo three rerolls.
 *
 * Switching *between* the two generated modes always restarts, even at the same
 * seed: who chooses the Commander is what the mode says, so the two are
 * different streams by definition.
 */
export function carriedRerollCount(previous: BotSeatConfig | null, next: BotDeckSource): number {
  const before = previous?.deck;
  if (!before || !deckModeGenerates(before.mode) || before.mode !== next.mode) return 0;
  if (!('seed' in before) || !('seed' in next) || before.seed !== next.seed) return 0;
  // The Commander only names the stream when the *host* names the Commander.
  // A bot that picks its own derives that pick from the seed, so the seed is the
  // whole name of an `autonomous_generated` stream (M09.10).
  if (before.mode === 'commander_generated' && next.mode === 'commander_generated') {
    if (before.commanderId !== next.commanderId) return 0;
  }
  return before.generated?.rerollCount ?? 0;
}

/**
 * The setup a seat's own configuration implies.
 *
 * Used by `reroll_bot`, which carries no configuration: rerolling is "the same
 * seat, one step further along its stream", so the setup is rebuilt from what
 * the seat already holds rather than from anything a client sent. `generated` is
 * cleared on the way out because it is a *result*, and `resolveBotSeat` refuses
 * a setup that claims one.
 */
export function setupOf(config: BotSeatConfig): BotSetup {
  const { controller, ...rest } = config;
  return {
    ...rest,
    displayName: controller.displayName,
    deck:
      config.deck.mode === 'commander_generated' || config.deck.mode === 'autonomous_generated'
        ? { ...config.deck, generated: null }
        : config.deck,
  };
}

/** Which step of a generated seat's stream to build. Server-owned (M09.9). */
export interface BotGenerationRequest {
  readonly rerollCount: number;
}

/**
 * Resolves one bot seat's setup, or says exactly why it cannot be seated.
 *
 * `botId` is supplied rather than derived here: identity belongs to the lobby
 * that allocates it, and reconfiguring a seat keeps the identity it already had
 * — which is the separation `botControllerSchema` exists to express.
 *
 * `generation` is the server's, never the sender's. A generated mode carries a
 * base seed on the wire — the host's instruction — but how many rerolls have
 * happened is a fact about this seat's history, and a client able to state it
 * could invent a seed transition that never occurred. It defaults to the first
 * generation, which is what `add_bot` always wants.
 */
export function resolveBotSeat(
  setup: BotSetup,
  identity: { readonly botId: string; readonly seatId: SeatId },
  context: BotSeatContext,
  generation: BotGenerationRequest = { rerollCount: 0 },
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

  // A *result* a sender claimed, rather than one this server produced. Refused
  // rather than ignored: a seed and a Commander are instructions and are
  // honoured, but a generator version, a deck hash and a pool report describe a
  // deck only the server can have built, and accepting a sender's version of
  // them would let a lobby publish provenance for a deck nobody generated
  // ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §3).
  if (deckModeGenerates(config.deck.mode) && 'generated' in config.deck && config.deck.generated) {
    return refusal('config_invalid', [
      'A bot setup may ask for a generated deck, but may not describe one: the server records the ' +
        'generator version, seed, hash and pool report of the deck it actually built.',
    ]);
  }

  switch (config.deck.mode) {
    case 'exact_precon': {
      const deck = resolvePreconDeck(config.deck.preconId, context);
      return isErr(deck) ? deck : ok({ config, deck: deck.value });
    }
    case 'exact_saved_deck': {
      const deck = resolveSnapshotDeck(config.deck.deck, context);
      return isErr(deck) ? deck : ok({ config, deck: deck.value });
    }
    case 'commander_generated': {
      const built = generateBotDeck({
        commanderId: config.deck.commanderId,
        baseSeed: config.deck.seed,
        rerollCount: generation.rerollCount,
        database: context.database,
        deckFormat: context.deckFormat,
        now: context.now,
      });
      if (isErr(built)) return built;
      // The provenance goes into the stored configuration rather than beside it:
      // a generated seat's `generated` field is the record of what it actually
      // plays, and a configuration still saying `null` after a deck was built
      // would be a seat nobody could describe.
      return ok({
        config: { ...config, deck: { ...config.deck, generated: built.value.provenance } },
        deck: built.value.deck,
      });
    }
    case 'autonomous_generated': {
      // The bot picks its own Commander first, from its own stream and from the
      // same list a host is offered, and the deck follows exactly as it does for
      // a Commander a host chose (M09.10).
      const built = generateAutonomousBotDeck({
        baseSeed: config.deck.seed,
        rerollCount: generation.rerollCount,
        database: context.database,
        deckFormat: context.deckFormat,
        now: context.now,
      });
      if (isErr(built)) return built;
      return ok({
        config: { ...config, deck: { ...config.deck, generated: built.value.provenance } },
        deck: built.value.deck,
      });
    }
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
