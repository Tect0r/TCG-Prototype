import type { CardDatabase } from '@tcg/card-data';
import { collectDeckCards } from '@tcg/deck';
import type { RevealedBotDeck } from '@tcg/protocol';
import { useCardDatabase } from '../../state/AppContext.js';
import { useMatchState } from '../../state/MatchContext.js';
import { downloadTextFile } from '../../lib/download.js';

/**
 * Every bot's list, once the match is over (M09.9).
 *
 * This is the second half of "public at the Commander, private at the list"
 * ([ADR 0024](../../../../../docs/architecture/0024-live-bot-seats.md) §3). The
 * promise the privacy rule makes is to the *opponents*, and it is only kept if
 * they are the ones who eventually get to read the list — so this renders for
 * every seat, not only the host's, from a `bot_decks_revealed` broadcast the
 * server sends once, at the moment the match completes.
 *
 * Nothing here decides when that is. The message arriving *is* the completion:
 * a client that tried to work out for itself when a list stopped being secret
 * would be a second authority on hidden information, which is exactly what the
 * observation boundary exists to prevent.
 *
 * The export is the same list in the same shape the server sent, plus the
 * generator provenance where there was a generator. It is deliberately not a
 * `SavedDeck`: this is a record of what an opponent played, and writing it as
 * something the Deck Builder would import would quietly turn a match record into
 * a deck of the reader's own.
 */

/** One line per distinct card, in the order the server listed them. */
function countedLines(cardIds: readonly string[], database: CardDatabase): readonly string[] {
  return collectDeckCards(cardIds).map((entry) => {
    const name = database.get(entry.cardId)?.name ?? entry.cardId;
    return entry.quantity === 1 ? name : `${entry.quantity}× ${name}`;
  });
}

/** The filename a reader gets. Seat-scoped, because one match can reveal three. */
function exportFilename(decks: readonly RevealedBotDeck[]): string {
  return decks.length === 1 ? `${decks[0]?.seatId}-bot-deck.json` : 'bot-decks.json';
}

export function RevealedBotDecks() {
  const { revealedBotDecks } = useMatchState();
  const database = useCardDatabase();

  if (revealedBotDecks.length === 0) return null;

  return (
    <section className="board__reveal" aria-label="Bot decks">
      <h3>
        {revealedBotDecks.length === 1 ? 'The bot’s deck' : 'The bots’ decks'}, now the match is
        over
      </h3>

      {revealedBotDecks.map((deck) => {
        const commanderName = database.get(deck.commanderId)?.name ?? deck.commanderId;
        return (
          <article key={deck.seatId} aria-label={`${deck.displayName} deck`}>
            <p className="board__reveal-head">
              <strong>{deck.displayName}</strong> played {deck.cardIds.length} cards under{' '}
              {commanderName}
              {deck.generated
                ? ` — built by generator v${deck.generated.generatorVersion} from seed ${deck.generated.seed}, deck ${deck.generated.deckHash}.`
                : '.'}
            </p>
            <ul className="board__reveal-list">
              {countedLines(deck.cardIds, database).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </article>
        );
      })}

      <button
        type="button"
        className="button--quiet"
        onClick={() =>
          downloadTextFile(
            exportFilename(revealedBotDecks),
            `${JSON.stringify(revealedBotDecks, null, 2)}\n`,
          )
        }
      >
        Export {revealedBotDecks.length === 1 ? 'this deck' : 'these decks'}
      </button>
    </section>
  );
}
