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
import { createRngState, nextInt } from '@tcg/rules-engine';
import { err, errorsOf, ok, type Result } from '@tcg/shared';

/**
 * Building a bot a deck: under a Commander the host chose (M09.9), or under one
 * the bot chose for itself (M09.10).
 *
 * The whole of this file answers one question: *which* deck does this seat play,
 * given a seed and either a Commander or permission to pick one? Four properties
 * make that answer worth trusting.
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
 *
 * **A bot that picks its own Commander is told nothing about the table.**
 * `selectBotCommander` takes a list of candidates and a seed, and there is no
 * third parameter: a lobby, a seat, an opponent's deck and an opponent's hand
 * are not merely unread, they are unreachable from the function that chooses
 * (ADR 0024 §3, "never counterpicks"). The candidates come from the same
 * format-scoped `playableCommanders` a host is offered, so a bot cannot choose
 * something a host could not.
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
 * The stream a bot's own Commander choice is drawn from (M09.10).
 *
 * Its own stream, and deliberately not the deck draw's. The alternative — asking
 * `generateDeck` for a deck with no Commander and letting it pick one out of the
 * draw's cursor — would choose from `environment.commanders` filtered only by
 * colour count, which is a *weaker* rule than `playableCommanders`: a Commander
 * that is not collectible, or whose behaviour is not structured yet, could come
 * back. Choosing first, from the same list a host is offered, is what keeps "a
 * bot cannot choose something a host could not" true by construction.
 *
 * It is derived from the generation seed rather than from the base seed, so a
 * reroll moves the Commander as well as the cards — which is what a host who
 * asked for a different deck meant. The suffix makes it a different string, and
 * `createRngState` hashes and warms up whatever it is given, so the two streams
 * do not run in step.
 */
export function commanderSelectionSeedFor(base: string, rerollCount: number): string {
  return `${generationSeedFor(base, rerollCount)}:commander`;
}

/**
 * The Commander a bot chooses for itself, or `null` when there is none to choose.
 *
 * **Two parameters, and that is the guarantee.** Candidates and a seed. Nothing
 * about the lobby, the opponents, their decks or their hands is in scope here,
 * so "a bot never prefers a Commander because the server happens to know another
 * seat's exact deck" is a fact about the signature rather than a promise about
 * the body (ADR 0024 §3).
 *
 * Candidates are sorted by ID with a plain code-point comparison rather than by
 * `localeCompare`: the caller's display order is locale-sensitive, and a draw
 * whose result depended on the server's ICU build would be a different deck on a
 * different machine from the same recorded seed.
 */
export function selectBotCommander(
  candidates: readonly CardDefinition[],
  seed: string,
): CardDefinition | null {
  if (candidates.length === 0) return null;
  const ordered = [...candidates].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const { value } = nextInt(createRngState(seed), ordered.length);
  return ordered[value] ?? null;
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

/** What every generation needs, whoever picked the Commander. */
export interface BotDeckGenerationContext {
  /** The host's instruction. The seed actually used is derived from it. */
  readonly baseSeed: string;
  readonly rerollCount: number;
  readonly database: CardDatabase;
  readonly deckFormat: DeckFormatConfig;
  /** The server's clock, for the deck record's timestamps. */
  readonly now: () => number;
}

export interface GenerateBotDeckRequest extends BotDeckGenerationContext {
  readonly commanderId: string;
}

/**
 * Builds one bot a legal deck under the Commander a host chose (M09.9).
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
  return buildGeneratedDeck(request, 'commander_generated');
}

/**
 * Lets the bot choose its own Commander, then builds its deck (M09.10).
 *
 * Two steps, in this order and never merged. The choice is made by
 * `selectBotCommander` from the format's playable Commanders and this seat's own
 * selection stream, and it is made **before** anything about the deck exists —
 * so it cannot be influenced by what the draw found, let alone by anything about
 * another seat.
 *
 * What happens next is exactly what happens for a Commander a host chose: the
 * same builder, the same pool, the same refusals, the same provenance shape. The
 * only difference recorded is `mode`, which is the honest one — it says who
 * picked, and everything else about the deck follows from the seed either way.
 * A seed and a Commander therefore name one deck whoever chose the Commander,
 * which is the property that makes a recorded seed worth writing down.
 *
 * A Commander whose pool cannot fill a deck is refused rather than swapped for
 * the next candidate. Retrying down the list would be a repair policy — a quiet
 * one, invisible in the provenance — and this file exists to keep a bot from
 * playing a deck nobody chose.
 */
export function generateAutonomousBotDeck(
  request: BotDeckGenerationContext,
): Result<GeneratedBotDeck, ProtocolError> {
  const { baseSeed, rerollCount, database, deckFormat } = request;
  const commander = selectBotCommander(
    generatableCommanders(database, deckFormat),
    commanderSelectionSeedFor(baseSeed, rerollCount),
  );
  if (!commander) {
    // `deck_illegal` rather than `config_invalid`: the host's configuration is
    // fine — they asked the bot to choose — and it is the format that has left
    // nothing choosable.
    return err(
      botLobbyError('deck_illegal', [
        `No Commander in ${deckFormat.formatId} can lead a generated deck, so a bot cannot build itself one.`,
      ]),
    );
  }
  return buildGeneratedDeck({ ...request, commanderId: commander.id }, 'autonomous_generated');
}

/**
 * The one builder both modes go through.
 *
 * `mode` reaches only the provenance: the pool, the draw, the refusals and the
 * legality check are identical, because "who chose the Commander" is a fact
 * about the lobby and not about the deck.
 */
function buildGeneratedDeck(
  request: GenerateBotDeckRequest,
  mode: GeneratedDeckProvenance['mode'],
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
      mode,
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
