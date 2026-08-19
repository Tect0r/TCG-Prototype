import type { CardDefinitionInput } from '@tcg/card-data';
import type { PilotSpec } from '@tcg/bot-interface';
import {
  resolveEnvironment,
  type Environment,
  type EnvironmentConfigInput,
} from './environment.js';
import { makeDeck, type SimDeck } from '@tcg/deck-generator';

/**
 * Fixtures for the Phase 4 acceptance tests.
 *
 * Two deliberate choices:
 *
 * - **Small decks.** The test environment uses a twelve-card format, so a match
 *   reaches its conclusion in a handful of turns. The suite plays hundreds of
 *   real matches; at thirty cards it would take minutes rather than seconds, and
 *   nothing being tested depends on the deck size.
 * - **Synthetic cards.** Several tests need a card that is *known* to be
 *   stronger, or a synergy that is *known* to exist, so that "the analyser found
 *   it" is a real check rather than a plausible-looking number. Those cards are
 *   defined here, layered on through `cardOverrides`, and never shipped in the
 *   bundled set.
 */

const NEUTRAL_POOL = [
  'prototype_drone',
  'prototype_scout',
  'prototype_guard',
  'trench_guard',
  'unstable_construct',
  'surveyors_lens',
  'energy_font',
  'field_survey',
] as const;

/** A plain 2-cost 2/2. The control every synthetic card is measured against. */
export const FIXTURE_BASELINE_UNIT: CardDefinitionInput = {
  schemaVersion: 2,
  id: 'fixture_baseline_unit',
  name: 'Fixture Baseline Unit',
  type: 'unit',
  colorIdentity: [],
  cost: 2,
  attack: 2,
  health: 2,
  role: 'attacker',
  powerClass: 'standard',
  tags: ['fixture'],
  displayText: 'A deliberately ordinary body.',
};

/** Statistically identical to the baseline. Must *not* be flagged. */
export const FIXTURE_EQUIVALENT_UNIT: CardDefinitionInput = {
  ...FIXTURE_BASELINE_UNIT,
  id: 'fixture_equivalent_unit',
  name: 'Fixture Equivalent Unit',
  displayText: 'The same body under a different name.',
};

/** Same cost, wildly better statline. A replacement test must detect this. */
export const FIXTURE_STRONG_UNIT: CardDefinitionInput = {
  ...FIXTURE_BASELINE_UNIT,
  id: 'fixture_strong_unit',
  name: 'Fixture Strong Unit',
  attack: 9,
  health: 9,
  keywords: ['rush'],
  powerClass: 'centerpiece',
  displayText: 'Deliberately over the top, so a test can prove the analyser notices.',
};

/**
 * Unarguably the best card in the format: a one-cost 9/9 that attacks at once.
 *
 * Separate from `FIXTURE_STRONG_UNIT` because the two fixtures answer different
 * questions. The replacement analyser compares cards of *equal cost*, so its
 * subject has to stay at two energy; the search needs a card so far ahead of the
 * rest of the pool that "the search found it" cannot be a coincidence, and in a
 * format full of cheap guardians a two-cost 9/9 is not that card.
 */
export const FIXTURE_DOMINANT_UNIT: CardDefinitionInput = {
  schemaVersion: 2,
  id: 'fixture_dominant_unit',
  name: 'Fixture Dominant Unit',
  type: 'unit',
  colorIdentity: [],
  cost: 1,
  attack: 9,
  health: 9,
  keywords: ['rush'],
  role: 'finisher',
  powerClass: 'centerpiece',
  tags: ['fixture'],
  displayText: 'Priced far below what it does, on purpose.',
};

/** Half of a synthetic synergy: cheap, and it makes the payoff enormous. */
export const FIXTURE_COMBO_ENABLER: CardDefinitionInput = {
  schemaVersion: 2,
  id: 'fixture_combo_enabler',
  name: 'Fixture Combo Enabler',
  type: 'unit',
  colorIdentity: [],
  cost: 1,
  attack: 1,
  health: 3,
  role: 'enabler',
  powerClass: 'minor',
  tags: ['fixture', 'combo'],
  displayText: 'Your other combo units get +4/+4.',
  staticAbilities: [
    {
      id: 'combo_lord',
      activeZone: 'battlefield',
      affects: {
        zone: 'battlefield',
        controller: 'self',
        filter: { tags: ['combo'] },
        excludeSource: true,
      },
      effect: { type: 'modify_stats', attack: 4, health: 4 },
    },
  ],
};

/** The other half: unremarkable alone, huge with the enabler on the board. */
export const FIXTURE_COMBO_PAYOFF: CardDefinitionInput = {
  schemaVersion: 2,
  id: 'fixture_combo_payoff',
  name: 'Fixture Combo Payoff',
  type: 'unit',
  colorIdentity: [],
  cost: 2,
  attack: 1,
  health: 1,
  role: 'payoff',
  powerClass: 'standard',
  tags: ['fixture', 'combo'],
  displayText: 'A 1/1 that only matters alongside the enabler.',
};

/**
 * A singleton. Exists so an insertion test can prove the builder respects the
 * *unique* copy limit rather than the ordinary one.
 *
 * Deliberately **not** in `FIXTURE_CARDS`: that list is the default pool of
 * every tiny environment, and adding a card to it changes what deck generation
 * can roll and therefore every seeded population in the suite. A fixture that
 * only one test needs is layered on by that test.
 */
export const FIXTURE_UNIQUE_UNIT: CardDefinitionInput = {
  ...FIXTURE_BASELINE_UNIT,
  id: 'fixture_unique_unit',
  name: 'Fixture Unique Unit',
  unique: true,
  displayText: 'One copy per deck, whatever the ordinary copy limit says.',
};

export const FIXTURE_CARDS: readonly CardDefinitionInput[] = [
  FIXTURE_BASELINE_UNIT,
  FIXTURE_EQUIVALENT_UNIT,
  FIXTURE_STRONG_UNIT,
  FIXTURE_DOMINANT_UNIT,
  FIXTURE_COMBO_ENABLER,
  FIXTURE_COMBO_PAYOFF,
];

export interface TinyEnvironmentOptions {
  readonly id?: string;
  readonly deckSize?: number;
  readonly copyLimit?: number;
  readonly extraCardIds?: readonly string[];
  readonly cardOverrides?: readonly CardDefinitionInput[];
  readonly rulesConfig?: EnvironmentConfigInput['rulesConfig'];
}

/** A small, fast, fully deterministic environment. */
export function tinyEnvironment(options: TinyEnvironmentOptions = {}): Environment {
  const overrides = [...FIXTURE_CARDS, ...(options.cardOverrides ?? [])];
  return resolveEnvironment({
    id: options.id ?? 'tiny',
    label: 'Twelve-card neutral test format',
    cardOverrides: overrides as EnvironmentConfigInput['cardOverrides'],
    allowCardIds: [
      ...NEUTRAL_POOL,
      ...overrides.map((card) => card.id),
      ...(options.extraCardIds ?? []),
      // Commanders have to be in the allow list too.
      'prototype_commander_blue',
      'prototype_commander_red',
      'prototype_commander_green',
    ],
    deckFormat: {
      deckSize: options.deckSize ?? 12,
      copyLimit: options.copyLimit ?? 2,
      uniqueCopyLimit: 1,
    },
    ...(options.rulesConfig ? { rulesConfig: options.rulesConfig } : {}),
  });
}

/** Builds a deck from `[cardId, quantity]` pairs. */
export function fixtureDeck(
  id: string,
  commanderId: string,
  entries: readonly (readonly [string, number])[],
): SimDeck {
  return makeDeck({
    id,
    label: id,
    commanderId,
    cards: entries.map(([cardId, quantity]) => ({ cardId, quantity })),
  });
}

/** A twelve-card neutral deck padded with filler up to the format size. */
export function paddedDeck(
  id: string,
  commanderId: string,
  entries: readonly (readonly [string, number])[],
  size = 12,
): SimDeck {
  const cards = entries.map(([cardId, quantity]) => ({ cardId, quantity }));
  let total = cards.reduce((sum, entry) => sum + entry.quantity, 0);
  for (const filler of NEUTRAL_POOL) {
    if (total >= size) break;
    const existing = cards.find((entry) => entry.cardId === filler);
    const room = 2 - (existing?.quantity ?? 0);
    if (room <= 0) continue;
    const add = Math.min(room, size - total);
    if (existing) existing.quantity += add;
    else cards.push({ cardId: filler, quantity: add });
    total += add;
  }
  return makeDeck({ id, label: id, commanderId, cards });
}

export const VALUE_PILOT: PilotSpec = { id: 'value', weights: {}, randomConfig: {} };
export const AGGRESSIVE_PILOT: PilotSpec = { id: 'aggressive', weights: {}, randomConfig: {} };
export const RANDOM_PILOT: PilotSpec = { id: 'random_legal', weights: {}, randomConfig: {} };

export const FAST_LIMITS = {
  maxTurns: 80,
  maxActions: 2000,
  maxDecisionsPerSeat: 1500,
  noProgressWindow: 40,
} as const;

export const NO_RETENTION = {
  replaySampleRate: 0,
  keepLogs: false,
  keepDecisions: false,
} as const;
