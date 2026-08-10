import {
  BUNDLED_PRECONS,
  bundledPrecon,
  formatDatabase,
  type CardDatabase,
  type PreconDefinition,
} from '@tcg/card-data';
import { PILOT_IDS, type PilotId } from '@tcg/bot-interface';
import { DEFAULT_DECK_FORMAT } from '@tcg/deck';
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
 * Built from card IDs *and* the fields that change how a card behaves or what
 * it costs, so a rebalanced card produces a different hash and an old replay is
 * refused rather than played back against a card that no longer matches its
 * own recorded behaviour.
 */
export function cardPoolHash(database: CardDatabase): string {
  const parts = database
    .all()
    .map((card) =>
      [
        card.id,
        card.type,
        card.cost ?? 'x',
        card.attack ?? 'x',
        card.health ?? 'x',
        card.keywords.join('+'),
        JSON.stringify(card.effects),
        JSON.stringify(card.abilities),
        JSON.stringify(card.activatedAbilities),
        JSON.stringify(card.staticAbilities),
        JSON.stringify(card.reaction ?? null),
      ].join('|'),
    )
    .sort();
  return hashString(parts.join('\n'));
}

export interface SetupProblem {
  readonly seatIndex: number;
  readonly message: string;
}

export interface ResolvedSetup {
  readonly seats: readonly SpectatorSeatConfig[];
  readonly problems: readonly SetupProblem[];
}

/**
 * Resolves a setup into seat configurations, reporting rather than repairing.
 *
 * A seat naming a precon that does not exist is a problem the user has to see:
 * silently substituting another deck would make the match a different
 * experiment from the one they asked to watch.
 */
export function resolveSpectatorSetup(setup: SpectatorSetup): ResolvedSetup {
  const seats: SpectatorSeatConfig[] = [];
  const problems: SetupProblem[] = [];

  setup.seats.forEach((seat, index) => {
    const precon = bundledPrecon(seat.preconId);
    if (!precon) {
      problems.push({ seatIndex: index, message: `No precon with ID "${seat.preconId}".` });
      return;
    }
    seats.push({
      playerId: `player_${index + 1}`,
      name: seat.name ?? `${precon.name} (${seat.pilotId})`,
      preconId: precon.id,
      commanderId: precon.commanderId,
      cardIds: [...precon.cardIds],
      pilotId: seat.pilotId,
    });
  });

  return { seats, problems };
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
