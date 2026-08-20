import { bundledPrecon, type CardDatabase } from '@tcg/card-data';
import { difficultyDefinition, type BotSeatPublic } from '@tcg/bot-config';
import { seatStyleLabel } from './bot-style-labels.js';

/**
 * What a lobby prints beside a bot seat (M09.5).
 *
 * Everything here is resolved from the **public** projection a seat view
 * carries — `BotSeatPublic` — and from shipped content the client already has.
 * Nothing reads a card list, a generator seed or a deck hash, because the
 * projection has none of those to read
 * ([ADR 0024](../../../../docs/architecture/0024-live-bot-seats.md) §3).
 *
 * The function is total over the four deck modes even though this build only
 * configures `exact_precon`: the union already has four members, and answering
 * "what does this seat publish about its deck" per mode here is what keeps
 * M09.6 and M09.9 from having to invent a label under time pressure. The answer
 * for every non-precon mode is the honest one — a Commander, and no deck name,
 * because the list is private.
 */

export interface BotSeatLabels {
  /**
   * The deck's name, or `null` when the mode keeps it private. Only a shipped
   * precon has a public name: every client has that list already, so naming it
   * reveals nothing an opponent could not read off the ID.
   */
  readonly deckName: string | null;
  /** The Commander this seat brings, resolved for display. Public in every mode. */
  readonly commanderName: string | null;
  readonly difficulty: string;
  /**
   * The style it flies, and whether anybody picked it (M09.16). An automatic
   * seat is named as such: "Value (automatic)" is a different fact about the
   * table from "Value", and the projection carries both members so the lobby
   * does not have to flatten them.
   */
  readonly style: string;
}

function commanderNameOf(database: CardDatabase, commanderId: string | null): string | null {
  if (commanderId === null) return null;
  return database.get(commanderId)?.name ?? commanderId;
}

export function botSeatLabels(bot: BotSeatPublic, database: CardDatabase): BotSeatLabels {
  const shared = {
    difficulty: difficultyDefinition(bot.difficulty).label,
    style: seatStyleLabel(bot),
  };

  switch (bot.deck.mode) {
    case 'exact_precon': {
      const precon = bundledPrecon(bot.deck.preconId);
      return {
        ...shared,
        // The ID rather than nothing when the client does not have the precon:
        // a build that cannot name a deck it is playing against should say
        // which deck it cannot name.
        deckName: precon?.name ?? bot.deck.preconId,
        commanderName: commanderNameOf(database, precon?.commanderId ?? null),
      };
    }
    case 'exact_saved_deck':
    case 'commander_generated':
    case 'autonomous_generated':
      return {
        ...shared,
        deckName: null,
        commanderName: commanderNameOf(database, bot.deck.commanderId),
      };
    default: {
      const never: never = bot.deck;
      throw new Error(`Unknown bot deck mode "${JSON.stringify(never)}".`);
    }
  }
}
