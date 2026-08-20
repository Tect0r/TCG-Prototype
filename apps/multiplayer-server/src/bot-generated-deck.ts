import type { GeneratedDeckProvenance } from '@tcg/bot-config';
import { loadBundledCardData, type CardDatabase, type CardDefinition } from '@tcg/card-data';
import {
  DECK_SCHEMA_VERSION,
  commanderIssues,
  playableCommanders,
  type DeckFormatConfig,
  type SavedDeck,
} from '@tcg/deck';
import {
  DECK_GENERATOR_VERSION,
  generateDeck,
  type GenerationEnvironment,
} from '@tcg/deck-generator';
import { botLobbyError, type ProtocolError } from '@tcg/protocol';
import { err, errorsOf, ok, type Result } from '@tcg/shared';

/**
 * Building a bot a deck under a Commander the host chose (M09.9).
 *
 * The whole of this file answers one question: *which* deck does this seat play,
 * given a Commander and a seed? Three properties make that answer worth
 * trusting.
 *
 * **The pool is the server's own.** The environment below is built from the
 * database and format the server already validates every human deck against,
 * not from a second lookup — so a generated deck cannot be legal to the
 * generator and illegal to the lobby that seats it. That database is
 * format-scoped by construction (`loadFormatCardData` in `main.ts`), which is
 * the rule `generationEnvironmentForFormat` exists to enforce for callers with
 * no database of their own; this one has one, and using it is what keeps the two
 * verdicts identical (`CLAUDE.md`, "Any playable pool must be obtained through a
 * format-scoped database").
 *
 * **A Commander is never substituted.** `generateDeck` falls back to a random
 * legal Commander when the one it was asked for is unavailable, and for a search
 * that is the right behaviour. For a host who chose one it is not: the choice is
 * refused **by name** instead, using `validateDeck`'s own issue codes, and the
 * generator is additionally restricted to the single requested Commander so that
 * a substitution is unreachable rather than merely unwanted.
 *
 * **The result is frozen and self-describing.** What comes back is a `SavedDeck`
 * the seat plays plus the provenance that identifies it — generator version,
 * construction mode, format, seed, reroll count, Commander, content hash, and
 * the legal-pool size with the forced-inclusion floor it implies. Nothing here
 * repairs a deck: an impossible generation is a refusal carrying the generator's
 * own problem codes.
 */

/**
 * The generation environment for one server's pool.
 *
 * Deliberately assembled here rather than obtained from
 * `generationEnvironmentForFormat`: that function resolves a format by ID and
 * would produce a *second* database, which is one more thing that can disagree
 * with the one the server validates against. `GenerationEnvironment` is
 * structural, so the server's own pieces satisfy it directly.
 */
export function generationEnvironmentOf(
  database: CardDatabase,
  deckFormat: DeckFormatConfig,
): GenerationEnvironment {
  return {
    id: deckFormat.formatId,
    database,
    deckFormat,
    pool: database.deckable(),
    commanders: database.commanders(),
  };
}

/**
 * The seed a given generation actually used.
 *
 * `base` is the host's instruction, carried on the wire since M09.2; the reroll
 * count is the server's, because `reroll_bot` deliberately carries no seed — a
 * client-supplied one would make the recorded transition something a client
 * could invent. Reroll 0 *is* the base seed, so a host who records a seed and
 * asks for it again gets the deck they recorded; every later reroll adds one
 * more suffix, which makes the transition n → n+1 reproducible from the two
 * values the provenance already carries.
 *
 * String concatenation rather than a hash, exactly as `botSeedFor` does for a
 * bot's decision stream: `createRngState` hashes and warms up whatever string it
 * is given, so two adjacent suffixes do not produce two adjacent streams, and
 * `SEED_DERIVATION_VERSION` does not move because no existing derivation
 * changed.
 */
export function generationSeedFor(base: string, rerollCount: number): string {
  return rerollCount === 0 ? base : `${base}:reroll:${rerollCount}`;
}

/**
 * The Commanders a host may choose for a generated deck, in stable name order.
 *
 * `playableCommanders` owns the rule — collectible, implemented, and within the
 * format's colour limit — and the lobby screen reads the same function against
 * its own format-scoped database, so an option a host can see is never one this
 * server would refuse.
 */
export function generatableCommanders(
  database: CardDatabase,
  deckFormat: DeckFormatConfig,
): readonly CardDefinition[] {
  return [...playableCommanders(database, deckFormat)].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

/**
 * The bundled universe, resolved once and only ever read for a refusal message.
 *
 * Not a playable pool and never used as one: its single job is to tell a host
 * whose Commander this format does not publish whether the card exists at all,
 * which is the difference between "you have a typo" and "that Commander belongs
 * to another format". `preconsForFormat` already draws exactly this distinction
 * for precons, for exactly this reason.
 */
let universeCardIds: ReadonlySet<string> | null = null;
function existsOutsideThisFormat(cardId: string): boolean {
  universeCardIds ??= new Set(
    loadBundledCardData()
      .database.all()
      .map((card) => card.id),
  );
  return universeCardIds.has(cardId);
}

export interface GeneratedBotDeck {
  readonly deck: SavedDeck;
  readonly provenance: GeneratedDeckProvenance;
}

export interface GenerateBotDeckRequest {
  readonly commanderId: string;
  /** The host's instruction. The seed actually used is derived from it. */
  readonly baseSeed: string;
  readonly rerollCount: number;
  readonly database: CardDatabase;
  readonly deckFormat: DeckFormatConfig;
  /** The server's clock, for the deck record's timestamps. */
  readonly now: () => number;
}

/**
 * Builds one bot a legal deck, or says exactly why it could not.
 *
 * Four refusals, in the order a host can act on them: the Commander is not in
 * this format at all, it is in this format but cannot lead a deck here, the
 * format cannot fill a deck under it, or the draw produced something
 * `validateDeck` refuses. The first two are `config_invalid`, because the host
 * chose a Commander this build cannot honour; the last two are `deck_illegal`,
 * because the choice was fine and the deck is not.
 */
export function generateBotDeck(
  request: GenerateBotDeckRequest,
): Result<GeneratedBotDeck, ProtocolError> {
  const { commanderId, baseSeed, rerollCount, database, deckFormat } = request;

  const commander = database.get(commanderId);
  if (!commander) {
    return err(
      botLobbyError('config_invalid', [
        existsOutsideThisFormat(commanderId)
          ? `"${commanderId}" is a card, but it is not published for ${deckFormat.formatId}, so no deck can be generated under it.`
          : `No card in ${deckFormat.formatId} has the ID "${commanderId}".`,
        `Choose one of: ${generatableCommanders(database, deckFormat)
          .map((card) => card.id)
          .join(', ')}.`,
      ]),
    );
  }

  // The same issues `validateDeck` would raise about this Commander, raised
  // before a deck is built rather than after: a Commander whose behaviour is not
  // structured yet, a card that is not a Commander at all, and one with more
  // colours than the format allows are each refused under their own name.
  const issues = errorsOf(commanderIssues(commanderId, database, deckFormat));
  if (issues.length > 0) {
    return err(
      botLobbyError('config_invalid', [
        `"${commander.name}" cannot lead a generated deck in ${deckFormat.formatId}.`,
        ...issues.map((issue) => issue.message),
      ]),
    );
  }

  const environment = generationEnvironmentOf(database, deckFormat);
  const seed = generationSeedFor(baseSeed, rerollCount);
  const result = generateDeck(
    environment,
    seed,
    // Restricted to the one Commander, so the generator's own fallback to a
    // random legal one is unreachable: with a single allowed Commander,
    // "unavailable" becomes `sim/no_legal_commander` and a refusal rather than a
    // quiet substitution.
    { commanderIds: [commanderId] },
    { commanderId, label: `${commander.name} — generated` },
  );

  if (!result.deck || !result.pool) {
    return err(
      botLobbyError('deck_illegal', [
        `No legal deck could be generated for "${commander.name}" in ${deckFormat.formatId}.`,
        ...result.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
      ]),
    );
  }

  // Belt and braces, and cheap. `generateDeck` already refuses a deck its own
  // `checkDeck` rejects, and a Commander it was not asked for is unreachable
  // above; both are asserted rather than assumed, because the single failure
  // this file exists to prevent is a bot quietly playing a deck nobody chose.
  if (result.deck.commanderId !== commanderId) {
    return err(
      botLobbyError('deck_illegal', [
        `The generator returned a deck led by "${result.deck.commanderId}" rather than "${commanderId}".`,
      ]),
    );
  }

  const timestamp = new Date(request.now()).toISOString();
  const deck: SavedDeck = {
    schemaVersion: DECK_SCHEMA_VERSION,
    id: result.deck.id,
    name: result.deck.label,
    commanderId,
    cards: result.deck.cards.map((entry) => ({ ...entry })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return ok({
    deck,
    provenance: {
      generatorVersion: DECK_GENERATOR_VERSION,
      mode: 'commander_generated',
      formatId: deckFormat.formatId,
      seed,
      rerollCount,
      commanderId,
      deckHash: result.deck.hash,
      legalPoolSize: result.pool.legalPoolSize,
      forcedInclusionFloor: result.pool.forcedInclusionFloor,
    },
  });
}
