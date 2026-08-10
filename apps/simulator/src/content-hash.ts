import { z } from 'zod';
import type { CardDatabase, CardDefinition, CardId } from '@tcg/card-data';
import type { RulesConfig } from '@tcg/rules-engine';
import type { DeckFormatConfig } from '@tcg/deck';
import { digestOf } from './hash.js';

/**
 * Hashes separated by meaning (readiness §9 G3).
 *
 * The simulator used to hash whole card definitions, which made a typo fix in a
 * card's flavour text invalidate every experiment that had ever used it — while
 * saying nothing more about replay equivalence than the old hash already did.
 * One hash cannot answer three different questions, so there are four, each
 * defined by the projection it is taken over:
 *
 * | Hash                | Answers                                              |
 * | ------------------- | ---------------------------------------------------- |
 * | `mechanicsHash`     | Will the engine replay this identically?             |
 * | `pilotInputHash`    | Will the same pilot make the same decisions?         |
 * | `presentationHash`  | Has any player-facing text changed?                  |
 * | `fullContentHash`   | Is this byte-for-byte the same content?              |
 *
 * The split is only trustworthy if the boundary is drawn where the code actually
 * reads things, so two easily-missed cases are called out at their definitions:
 * `tags` are mechanical (card filters match on them), and `unique`/`collectible`
 * are mechanical (deck legality reads them).
 */

export const environmentHashesSchema = z.strictObject({
  /** Executable rules only: card mechanics, the pool, rules config, deck format. */
  mechanicsHash: z.string(),
  /** Mechanics plus the authored metadata pilots and deck generation read. */
  pilotInputHash: z.string(),
  /** Names, printed text and curated help. Cannot change a match. */
  presentationHash: z.string(),
  /** The complete resolved content. The artefact's content address. */
  fullContentHash: z.string(),
});
export type EnvironmentHashes = z.infer<typeof environmentHashesSchema>;

/** Design metadata a card may carry. Read by pilots and analysis, never by the engine. */
interface DesignBearing {
  readonly design?: {
    readonly roles?: readonly string[];
    readonly archetypes?: readonly string[];
    readonly complexity?: string;
    readonly status?: string;
    readonly setId?: string;
  };
}

/** The executable projection of a card: everything the engine reads. */
export function cardMechanics(card: CardDefinition): unknown {
  return {
    id: card.id,
    type: card.type,
    colorIdentity: card.colorIdentity,
    cost: card.cost,
    attack: card.attack ?? null,
    health: card.health ?? null,
    // Deck legality reads both of these, so they change what can be played.
    unique: card.unique,
    collectible: card.collectible,
    // Tags are mechanical, not decoration: `CardFilter` matches on them, so a tag
    // edit can change which units a lord buffs or which cards a spell may target.
    tags: [...card.tags].sort(),
    keywords: [...card.keywords].sort(),
    effects: card.effects,
    abilities: card.abilities,
    activatedAbilities: card.activatedAbilities,
    staticAbilities: card.staticAbilities,
  };
}

/** Authored metadata pilots and deck generation read but the engine does not. */
export function cardPilotMetadata(card: CardDefinition): unknown {
  const design = (card as CardDefinition & DesignBearing).design;
  return {
    id: card.id,
    role: card.role ?? null,
    powerClass: card.powerClass ?? null,
    roles: design?.roles ? [...design.roles].sort() : null,
    archetypes: design?.archetypes ? [...design.archetypes].sort() : null,
    complexity: design?.complexity ?? null,
  };
}

/** Player-facing content. Changing it can never change a match. */
export function cardPresentation(card: CardDefinition): unknown {
  return {
    id: card.id,
    name: card.name,
    displayText: card.displayText ?? null,
    text: card.text ?? null,
  };
}

/**
 * Every definition a match in this environment can reach.
 *
 * The playable pool and the Commanders, plus the tokens (and the tokens' tokens)
 * those cards can create. Nothing else: this list is both what gets hashed and
 * what gets written into every replay bundle, so an unreachable card would
 * inflate every artefact without buying any reproducibility.
 *
 * Lives here rather than beside `freezeEnvironment` so that `resolveEnvironment`
 * can hash exactly the set that will later be frozen, without the two modules
 * importing each other.
 */
export function snapshotCards(
  pool: readonly CardDefinition[],
  commanders: readonly CardDefinition[],
  database: CardDatabase,
): CardDefinition[] {
  const found = new Map<CardId, CardDefinition>();
  const queue: CardDefinition[] = [];

  for (const card of [...pool, ...commanders]) {
    if (found.has(card.id)) continue;
    found.set(card.id, card);
    queue.push(card);
  }

  while (queue.length > 0) {
    const card = queue.shift() as CardDefinition;
    const effects = [
      ...card.effects,
      ...card.abilities.flatMap((ability) => ability.effects),
      ...card.activatedAbilities.flatMap((ability) => ability.effects),
    ];
    for (const effect of effects) {
      if (effect.type !== 'create_token') continue;
      if (found.has(effect.tokenCardId)) continue;
      const token = database.get(effect.tokenCardId);
      if (!token) continue;
      found.set(token.id, token);
      queue.push(token);
    }
  }

  return [...found.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function computeEnvironmentHashes(inputs: {
  readonly cards: readonly CardDefinition[];
  readonly rulesConfig: RulesConfig;
  readonly deckFormat: DeckFormatConfig;
  readonly poolCardIds: readonly CardId[];
  readonly commanderCardIds: readonly CardId[];
}): EnvironmentHashes {
  const sorted = [...inputs.cards].sort((left, right) => left.id.localeCompare(right.id));

  // The pool and Commander lists belong to the mechanical projection: banning a
  // card changes what can legally be played without touching any definition.
  const mechanics = {
    cards: sorted.map(cardMechanics),
    pool: [...inputs.poolCardIds].sort(),
    commanders: [...inputs.commanderCardIds].sort(),
    rulesConfig: inputs.rulesConfig,
    deckFormat: inputs.deckFormat,
  };
  const presentation = sorted.map(cardPresentation);
  const mechanicsHash = digestOf(mechanics);

  return {
    mechanicsHash,
    pilotInputHash: digestOf({ mechanicsHash, metadata: sorted.map(cardPilotMetadata) }),
    presentationHash: digestOf(presentation),
    fullContentHash: digestOf({ mechanics, presentation }),
  };
}
