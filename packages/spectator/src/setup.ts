import {
  BUNDLED_PRECONS,
  bundledPrecon,
  cardPoolMechanicsJson,
  formatDatabase,
  type CardDatabase,
  type CardId,
  type PreconDefinition,
} from '@tcg/card-data';
import { PILOT_IDS, type PilotId } from '@tcg/bot-interface';
import { DEFAULT_DECK_FORMAT, preconFormat, preconToDeck, validateDeck } from '@tcg/deck';
import type { Issue } from '@tcg/shared';
import { VALID_PROVENANCE, type SpectatorProvenance } from './schema.js';
import { hashString } from './seed.js';
import type { SpectatorSeatConfig } from './run.js';

/**
 * Turning a spectator setup screen into a runnable match configuration.
 *
 * Precons are the intended source: they are validated content, addressable by
 * permanent ID, and the same lists the deck builder and the server use
 * (ruleset update §3). Duplicates are allowed — four seats may all play the
 * same precon during testing, which is a legitimate and useful thing to watch.
 */

export interface SpectatorSetupSeat {
  readonly preconId: string;
  readonly pilotId: PilotId;
  /** Overrides the precon's own name in the spectator UI. */
  readonly name?: string;
}

export interface SpectatorSetup {
  readonly seed: string;
  readonly seats: readonly SpectatorSetupSeat[];
  /**
   * Developer override: run a precon that still contains cards whose printed
   * behaviour is not structured yet (M01.2).
   *
   * Deliberately long and unambiguous, because everything it produces is
   * invalid: those cards execute as their structured data says, which is not
   * what they are printed to do, so the match is not evidence about the game.
   * Every surface that offers it has to say so, and every replay it produces
   * carries `resultsValid: false` for as long as the replay exists.
   *
   * It never relaxes anything else. A precon that is illegal for any other
   * reason — wrong size, an off-colour card, a Commander that is not a
   * Commander — is still refused.
   */
  readonly developerAllowIncompleteCards?: boolean;
}

/** Precons a spectator match may be built from, in catalog order. */
export function spectatorPrecons(): readonly PreconDefinition[] {
  return BUNDLED_PRECONS;
}

export const SPECTATOR_PILOT_IDS: readonly PilotId[] = PILOT_IDS;

/** The card pool a spectator match is played with. */
export function spectatorDatabase(formatId = DEFAULT_DECK_FORMAT.formatId): CardDatabase {
  return formatDatabase(formatId);
}

/**
 * A digest of the card pool, recorded in every replay.
 *
 * Taken over `cardPoolMechanicsJson` — the shared, compile-time-exhaustive
 * mechanics projection in `@tcg/card-data` — rather than a field list kept here
 * (M01.3). The list this replaced omitted `additionalCosts`, `colorIdentity`,
 * `tags`, `unique`, `collectible` and `implemented`, so a replay stayed
 * "compatible" after a card's interactive sacrifice cost changed and was played
 * back against a card that no longer matched its own recorded behaviour.
 *
 * `hashString` rather than SHA-256 because this runs in the browser too; the
 * projection is shared with the simulator, the digest deliberately is not.
 */
export function cardPoolHash(database: CardDatabase): string {
  return hashString(cardPoolMechanicsJson(database.all()));
}

/** Why a seat cannot be played as configured. */
export type SetupProblemKind = 'unknown_precon' | 'illegal_deck' | 'incomplete_cards';

export interface SetupProblem {
  readonly seatIndex: number;
  readonly kind: SetupProblemKind;
  readonly message: string;
  /** Every blocking card, named individually rather than counted. */
  readonly cardIds: readonly CardId[];
}

/** Cards a seat is knowingly running with under the developer override. */
export interface SeatIncompleteCards {
  readonly seatIndex: number;
  readonly playerId: string;
  readonly preconId: string;
  readonly cardIds: readonly CardId[];
}

export interface ResolvedSetup {
  readonly seats: readonly SpectatorSeatConfig[];
  readonly problems: readonly SetupProblem[];
  /**
   * Non-empty only under the developer override. Anything that runs a match
   * from this setup has to carry it into the replay's provenance.
   */
  readonly incompleteCards: readonly SeatIncompleteCards[];
}

/**
 * Errors that mean "this card cannot be played faithfully yet" rather than
 * "this deck breaks a construction rule". Only these are overridable.
 */
const INCOMPLETE_CARD_CODES: ReadonlySet<string> = new Set([
  'deck/card_not_implemented',
  'deck/commander_not_implemented',
]);

/** Fixed, because a precon copy made for validation is not a saved deck. */
const VALIDATION_TIMESTAMP = '2026-01-01T00:00:00.000Z';

function blockingCardIds(issues: readonly Issue[]): CardId[] {
  const ids: CardId[] = [];
  for (const issue of issues) {
    const cardId = issue.context?.['cardId'];
    if (typeof cardId === 'string' && !ids.includes(cardId)) ids.push(cardId);
  }
  return ids;
}

/**
 * Resolves a setup into seat configurations, reporting rather than repairing.
 *
 * A seat naming a precon that does not exist is a problem the user has to see:
 * silently substituting another deck would make the match a different
 * experiment from the one they asked to watch.
 *
 * Every seat is validated through the *same* format database the match will be
 * played on and the *same* `validateDeck` the deck builder and the match server
 * run (M01.2). A spectator match therefore cannot contain a card a real match
 * would refuse — which is what stopped an unimplemented card being played as a
 * blank one and counted as evidence.
 */
export function resolveSpectatorSetup(
  setup: SpectatorSetup,
  options: { readonly database?: CardDatabase } = {},
): ResolvedSetup {
  const database = options.database ?? spectatorDatabase();
  const seats: SpectatorSeatConfig[] = [];
  const problems: SetupProblem[] = [];
  const incompleteCards: SeatIncompleteCards[] = [];

  setup.seats.forEach((seat, index) => {
    const precon = bundledPrecon(seat.preconId);
    if (!precon) {
      problems.push({
        seatIndex: index,
        kind: 'unknown_precon',
        message: `No precon with ID "${seat.preconId}".`,
        cardIds: [],
      });
      return;
    }

    const deck = preconToDeck(precon, {
      id: `spectator_${precon.id}`,
      now: VALIDATION_TIMESTAMP,
    });
    const errors = validateDeck(deck, database, preconFormat(precon)).issues.filter(
      (issue) => issue.severity === 'error',
    );
    const incomplete = errors.filter((issue) => INCOMPLETE_CARD_CODES.has(issue.code));
    const illegal = errors.filter((issue) => !INCOMPLETE_CARD_CODES.has(issue.code));

    // Construction legality is never overridable: a deck that breaks the format
    // is a different deck, not an unfinished one.
    if (illegal.length > 0) {
      problems.push({
        seatIndex: index,
        kind: 'illegal_deck',
        message:
          `"${precon.name}" is not legal in this pool: ` +
          illegal.map((issue) => issue.message).join(' '),
        cardIds: blockingCardIds(illegal),
      });
      return;
    }

    const blocking = blockingCardIds(incomplete);
    if (incomplete.length > 0 && setup.developerAllowIncompleteCards !== true) {
      problems.push({
        seatIndex: index,
        kind: 'incomplete_cards',
        message:
          `"${precon.name}" contains ${incomplete.length} card(s) that cannot be played yet: ` +
          `${blocking.join(', ')}.`,
        cardIds: blocking,
      });
      return;
    }
    const playerId = `player_${index + 1}`;
    if (blocking.length > 0) {
      incompleteCards.push({ seatIndex: index, playerId, preconId: precon.id, cardIds: blocking });
    }

    seats.push({
      playerId,
      name: seat.name ?? `${precon.name} (${seat.pilotId})`,
      preconId: precon.id,
      commanderId: precon.commanderId,
      cardIds: [...precon.cardIds],
      pilotId: seat.pilotId,
    });
  });

  return { seats, problems, incompleteCards };
}

/**
 * The provenance a match built from this setup must be recorded with.
 *
 * The one place the "results invalid" verdict is derived, so a caller cannot
 * run an overridden setup and record it as a clean one by forgetting to.
 */
export function setupProvenance(resolved: ResolvedSetup): SpectatorProvenance {
  if (resolved.incompleteCards.length === 0) return VALID_PROVENANCE;
  return {
    resultsValid: false,
    incompleteCards: resolved.incompleteCards.map((seat) => ({
      playerId: seat.playerId,
      preconId: seat.preconId,
      cardIds: [...seat.cardIds],
    })),
  };
}

/** A sensible starting configuration: four seats, one per precon, all pilots. */
export function defaultSpectatorSetup(seed: string, playerCount = 4): SpectatorSetup {
  const precons = spectatorPrecons();
  const pilots = SPECTATOR_PILOT_IDS;
  return {
    seed,
    seats: Array.from({ length: playerCount }, (_, index) => ({
      // Wraps rather than failing when there are fewer precons than seats:
      // duplicates are explicitly allowed during initial testing.
      preconId: precons[index % Math.max(1, precons.length)]?.id ?? '',
      pilotId: pilots[index % pilots.length] ?? 'value',
    })),
  };
}
